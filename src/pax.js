/* ============================================================================
 * pax.js — 客流与乘降模型
 *
 * 南京版没有这一层：停站只是一个 dwell 计时器，车厢永远是"空"的，
 * 于是物理里的载荷系数（AW0 空车 ↔ AW3 超员）形同虚设——而它恰恰是
 * 真实司机最能体感的东西：早高峰满载时牵引上不去、制动距离变长。
 *
 * 这一模块做三件事：
 *   1. 给每个站一个**确定性的**候乘人数（站名哈希 + 时段 + 枢纽系数），
 *      所以同一站同一时刻永远给出同一个数，测试可复现；
 *   2. 用"下客优先、上客按门的通过能力"的模型推进乘降，
 *      停站时间不够就把人留在站台上（leftBehind），满载就挤不上去；
 *   3. 把车载人数换算成物理模型的 load（AW0=0.84 / 定员≈1.14 / 超员更高），
 *      直接喂给 Train.update，让加减速真的随满载变化。
 *
 * 数字依据：A 型车定员 310 人/辆、C 型车约 220 人/辆（公开技术参数），
 * 门的通过能力按实际观测取每门每秒 1.6 人下 + 1.4 人上（双向同时受限）。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { hash32, rand01, clamp } = SH;
const C = (v, a, b) => clamp(v, a, b);

/* 每辆车的定员（AW2，人）。缺省按 A 型车。 */
const PER_CAR = { A: 310, B: 245, C: 220, AP: 120, MG: 88 };
/* 车型 → 类别 */
const CLASS = { A8: 'A', A6: 'A', A6D: 'A', A6S: 'B', C6: 'C', C4: 'C', A3: 'A', RUB: 'AP', MAG: 'MG' };

/** 编组定员与超员线 */
function capacity(stock) {
  const cls = CLASS[stock.type] || (stock.width >= 2.9 ? 'A' : stock.width >= 2.5 ? 'B' : 'C');
  const per = PER_CAR[cls] || 310;
  const aw2 = Math.round(per * stock.cars);
  return { aw2, aw3: Math.round(aw2 * 1.32), perCar: per, cls };
}

/**
 * 时段客流系数（早高峰 1.55 / 晚高峰 1.75 / 夜间 0.35 / 平峰 0.95~1.30）。
 * **单独提成导出函数**：AI 列车的车载也要读同一个时段（车上有多少人），
 * 否则玩家从站台看过去会觉得"AI 车永远是空的"，而空车与满车在画面上
 * 是两件完全不同的事。写两份系数就是第二个真值。
 *
 * 雨天（D4 环境与客流联动）：公共交通客流在雨雪天**上升**——骑车与步行的人
 * 转向地铁，上海各线雨天客流普遍比平日高。幅度取 1.08（收敛、不夸张），
 * 玩家侧的 Flow 与 AI 车载读同一个入口，两边同步变挤。
 */
function rushFactor(hour, rain) {
  const h = ((hour % 24) + 24) % 24;
  const f = (h >= 7 && h <= 9) ? 1.55
    : (h >= 17 && h <= 19) ? 1.75
    : (h >= 22 || h < 5) ? 0.35
    : 0.95 + 0.35 * rand01('paxoff', h);
  return rain ? f * RAIN_PAX : f;
}
/** 雨天的客流放大系数。判据按 A/B 实测（把 rain 开关两边各算一遍），不读写法。 */
const RAIN_PAX = 1.08;

/**
 * 某站在某小时的**发送量**（上车人数）与**到达量**。
 * 形状：枢纽/市中心 >> 普通站 > 终点站；早晚高峰放大，夜间收缩。
 * 全部由哈希决定 —— 同一个站永远给出同一个数，便于回归。
 */
function demand(lineId, name, idx, n, hour, rain) {
  const h = hash32(lineId + '>' + name, 977);
  const base = 40 + (h % 150);                        // 40 ~ 190
  /* 换乘系数按**换乘类型**给（第 102 条，`SH.INTER_META`）：
     · 站内换乘 —— 线网换乘量最大的一类，1.55~1.80；
     · 出站换乘 —— 要出闸、上地面、再进闸，换乘意愿明显低一档，1.30~1.54；
     · 共线同站台 —— **不是换乘**（3/4 号线 虹桥路~宝山路 是同一条站台），
       以前这 8 站白拿了一份换乘客流，站台屏上的"换乘 4 号线"也是错的。 */
  const M = SH.INTER_META && SH.INTER_META[name];
  const inter = !M ? 1
    : M.type === 'shared' ? 1
    : M.type === 'out' ? 1.30 + 0.12 * (h % 3)
    : 1.55 + 0.25 * (h % 3);
  const core = /人民广场|南京西路|南京东路|徐家汇|世纪大道|陆家嘴|静安寺|陕西南路|虹桥|火车站|龙阳路|迪士尼|交大|复旦/.test(name) ? 1.55 : 1;
  const edge = idx < 1 || idx >= n - 1 ? 0.75 : 1;    // 终点站发车主、到达少
  const rush = rushFactor(hour, rain);
  const board = Math.round(base * inter * core * edge * rush * (0.8 + 0.4 * rand01('paxb', h % 997)));
  /* 到达量：与发送量同量级，但市中心在高峰是"净流入"，郊区是净流出 */
  const alight = Math.round(board * (0.62 + 0.75 * rand01('paxa', (h >> 3) % 991)) * (core > 1 ? 0.86 : 1.18));
  return { board, alight };
}

/** 从 `idx` 站上车的人"想去每一站"的权重（到达需求 × 距离衰减）。
 *  抽到模块级是因为**两件事必须用同一张表**：给新上车的乘客分配目的站
 *  （`Flow._add`），以及判断"这趟小交路车装得下谁"（`withinShare`）。
 *  两处各算一份权重就是两个客流真值 —— 本项目的老坑。 */
function destW(line, idx, hour, rain) {
  const st = line.stations, w = [];
  for (let j = idx + 1; j <= st.length - 1; j++) {
    const d = 1 + demand(line.id, st[j], j, st.length, hour, rain).alight;
    w.push({ j, v: d * (1 + 2.2 / (1 + j - idx)) });
  }
  return w;
}
/** 小交路的客流闸门：这一站候乘里"本次终点装得下"的份额（0..1）。
 *  目的站在行程之外的人**留在站台上等下一班全程车** —— 不删人、不改派
 *  （人数是停站时长的依据，删一个就是谎报一个）。 */
function withinShare(line, idx, upto, hour, rain) {
  const last = line.stations.length - 1;
  if (upto == null || upto >= last) return 1;
  const w = destW(line, idx, hour, rain);
  let a = 0, b = 0;
  for (const x of w) { b += x.v; if (x.j <= upto) a += x.v; }
  return b > 0 ? a / b : 1;
}

/**
 * 一次值乘的客流状态机。
 * 车上的人按"目的站"记账，所以到站下客是真实的：不是随机掉一堆人，
 * 而是这一站该下的人下完。
 */
class Flow {
  constructor(line, stock, hour, rain) {
    /* 雨天（D4）：候乘人数、乘降需求都走同一个放大系数（RAIN_PAX，
       雨天地铁客流上升）。放在 Flow 而不是全局，是为了离线判据可以
       A/B 对照同一条线的晴/雨两种状态。 */
    this.rain = !!rain;
    this.line = line; this.hour = hour == null ? 8 : hour;
    this.cap = capacity(stock);
    this.doors = Math.max(2, stock.doors) * stock.cars;   // 全车可上下门的数量
    this.dest = new Map();       // 目的站序号 → 人数
    this.onboard = 0;
    this.waiting = new Map();    // 站名 → 候乘人数
    this.log = [];               // 每站的乘降记录
    this.boarded = 0; this.alighted = 0; this.leftBehind = 0;
    this._seed = 0;
  }
  /**
   * 站台上的候乘人数（烘焙车站时用它决定人群密度）。
   *
   * `dir` 缺省 = 本线行驶方向（玩家所在站台）；`dir < 0` = **对向站台**的候乘：
   * 同一条线、同一个站、同一个时段，但人群站在对面站台上等反方向的车，
   * 所以必须是**另一桶** —— 对向车（mirror 交路的调度器）服务的是这一桶，
   * 玩家车服务的是缺省桶。两桶走同一个 demand() 公式（禁止第二份公式），
   * 只把线 id 加 '#opp' 盐值：同站两桶的人数由哈希错开，
   * 但时段系数（rushFactor）、换乘/枢纽系数完全同源 —— 早晚高峰两侧一起涨。
   */
  waitingAt(name, idx, dir) {
    const key = dir < 0 ? name + '#opp' : name;
    if (!this.waiting.has(key)) {
      const lid = dir < 0 ? this.line.id + '#opp' : this.line.id;
      const d = demand(lid, name, idx, this.line.stations.length, this.hour, this.rain);
      this.waiting.set(key, d.board);
    }
    return this.waiting.get(key);
  }
  /** 对向车停站时把候乘扣回对向桶（traffic.js 的 `pax.waiting.set` 走这里） */
  waitingSet(name, v, dir) {
    this.waiting.set(dir < 0 ? name + '#opp' : name, Math.max(0, v));
  }
  /** 起点站先放一批人上车 */
  seedAt(idx, name) {
    const d = demand(this.line.id, name, idx, this.line.stations.length, this.hour, this.rain);
    const n = Math.min(d.board, Math.round(this.cap.aw2 * 0.45));
    this.onboard += n;
    this._add(idx, n);
    this._seed = n;
    return n;
  }
  /** 到达 idx 站：先算这一站该下多少人 */
  alightNeed(idx) { return this.dest.get(idx) || 0; }
  /**
   * 本站乘降需要多少秒：需求人数按**当前拥挤度下的实际通过能力**折算，
   * 而不是理想速率 —— 车厢越满上得越慢，早高峰的停站时间因此自然拉长。
   * 游戏侧（司机该停多久）与开局预跑（那一车人怎么来的）共用这一份；
   * 两处各写一个公式，就会有一处的停站时长与另一处对不上。
   */
  dwellNeed(idx, name) {
    const r = this.log[this.log.length - 1];
    const need = (r && r.idx === idx) ? r.wantOff + r.wantOn
      : this.alightNeed(idx) + this.waitingAt(name, idx);
    const crowd = C(this.onboard / Math.max(1, this.cap.aw2), 0, 1.35);
    const slow = crowd < 0.85 ? 1 : Math.max(0.25, 1 - (crowd - 0.85) / 0.55);
    return C(need / Math.max(1, this.rate() * slow) + 3.0, 6, 45);
  }
  /**
   * 乘降可视化（B4）需要的全部模型量，一次给齐 —— 视觉层（world.crowdInto
   * 的 `alight` 参数）不许自己抄这些公式：下客节奏用 rate()（flow() 里 off 侧
   * 本来就不吃拥挤度慢化 —— 下客速度就是门的通过能力）；上车带的时钟用
   * dwellNeed()（司机停多久，门口的人就按什么节奏走光，车厢越挤走光越慢）；
   * wait0 取**开门那一刻**的候乘（beginStation 记下的 wantOn），
   * 不是"现在还剩几个" —— 候乘在停站期间一路变少，用它当基数，
   * 上车带会跟着候乘一起缩没，密度就量不出来了。
   */
  visual(idx, name) {
    const r = this.log[this.log.length - 1];
    const mine = r && r.idx === idx;
    return { need: this.alightNeed(idx), rate: this.rate(),
      dwellNeed: this.dwellNeed(idx, name),
      wait0: mine ? r.wantOn : this.waitingAt(name, idx) };
  }
  /** 走完一站（预跑用）：按 `dwellNeed` 停够时间，再把没挤上去的人留在站台上 */
  _serve(idx, name) {
    const d = this.dwellNeed(idx, name);
    this.flow(idx, name, d);
    this.closeStation(idx, name);
    return d;
  }
  /**
   * 把车厢状态推到玩家的上车站。
   *
   * 以前开局只做一件事：`seedAt(起点)` 往车上塞 `min(发送量, 定员×0.45)` 个人 ——
   * 于是**不管几点、不管你在哪一站上车，车里永远是 45%**。整条线跑满能到 106~131%
   * 满载、甩客几百人（实测 2/9 号线早高峰），但玩家一局只跑三站，看到的永远是
   * 那 45%，"挤不上车""停站被拖长""客运分扣不下来"全都不会出现。
   * 缺陷不在客流模型，在**玩家接触不到它**。
   *
   * 现在初始车载由模型自己算：从线路起点逐站服务到上车站，剩下的车载状态就是
   * 玩家上车时的那一车人。早高峰从中间站上车，一上车就是半满到挤满，
   * 因为那是这条走廊在这个小时应该有的断面。
   */
  primeTo(idx) {
    const st = this.line.stations, last = st.length - 1;
    const i0 = Math.max(0, Math.min(idx == null ? 0 : idx, last));
    this.seedAt(0, st[0]);                            // 车库拉出来是空的，起点站上客
    for (let i = 1; i <= i0; i++) this._serve(i, st[i]);
    /* 玩家还没发车，他这一站站台上的人当然要上他的车：把候乘重新按需求填回去 */
    this.waiting.set(st[i0], demand(this.line.id, st[i0], i0, st.length, this.hour, this.rain).board);
    /* 预跑只为了得到车载状态；统计与逐站日志必须归零，否则结算里的
       "上/下/甩客"会把玩家还没接手的那半条线算成他的成绩。 */
    this.boarded = 0; this.alighted = 0; this.leftBehind = 0; this.log = [];
    return this.onboard;
  }
  /**
   * 给新上车的 n 个人分配目的站。
   *
   * 只记账，不动 onboard —— 之前这里也加了一次 onboard，而调用方
   * flow() 已经加过，于是车载人数被重复计入，几站之后就越过超员线。
   *
   * 目的站按"该站的到达量需求"加权轮盘抽取：枢纽站之所以是枢纽，
   * 就是因为大家都去那里；纯随机会让徐家汇这样的站一趟没人下。
   */
  _add(idx, n, upto) {
    if (n <= 0) return;
    const last = this.line.stations.length - 1;
    if (idx >= last) return;
    const cap = upto == null || upto > last ? last : upto;
    /* 权重：该站的到达需求 × 距离衰减（人更可能坐到近的站）。
       然后按"最大余数法"把 n 个人**分配**下去——
       原来是一次抽签决定整批人的目的站，结果同一站上车的人全在同一站下车，
       跑三站显示"上 440 / 下 0"，客流模型等于没跑。
       `cap` 是本次列车的行程端点：小交路车不能把人送到自己到不了的站。 */
    const w = destW(this.line, idx, this.hour, this.rain).filter(x => x.j <= cap);
    if (!w.length) return;
    const tot = w.reduce((a, x) => a + x.v, 0);
    let assigned = 0;
    const shares = w.map(x => { const q = n * x.v / tot; x.q = Math.floor(q); x.fr = q - x.q; assigned += x.q; return x; });
    shares.sort((a, b) => b.fr - a.fr);
    for (let k = 0; assigned < n; k++, assigned++) shares[k % shares.length].q++;
    for (const x of w) if (x.q > 0) this.dest.set(x.j, (this.dest.get(x.j) || 0) + x.q);
    /* 抖动：让同一批人不要整整齐齐按同一分布下车（用与 n 无关的种子） */
  }
  /** 门的通过能力：单位时间能完成多少人（下+上共享门道，下客优先） */
  rate() { return this.doors * 1.5; }        // 人/秒，全车合计
  /**
   * 停站期间推进 dt 秒。返回本次累计的下/上。
   * 满载时上客速率按 (1 - 拥挤度) 衰减，超过超员线就完全挤不上去。
   *
   * 人数用"小数银行"累积，不能每帧 floor：
   * 4 节 C 型车只有 16 对门，rate*dt 在 1/30 s 下 = 0.8 人，
   * 直接取整永远是 0 —— 于是小编组线路整个乘降系统一动不动
   * （实测 5 号线"上 0 / 下 0 / 甩客 365"）。取整后余数必须留下，
   * 这样结果也与帧率无关。
   */
  flow(idx, name, dt, upto) {
    const out = { off: 0, on: 0 };
    if (dt <= 0) return out;
    this._bank = (this._bank || 0) + this.rate() * dt;
    const need = this.alightNeed(idx);
    const off = Math.min(need, Math.floor(this._bank));
    this._bank -= off;
    if (off > 0) {
      this.dest.set(idx, need - off);
      if (need - off <= 0) this.dest.delete(idx);
      this.onboard -= off; this.alighted += off; out.off = off;
    }
    const capLeft = Math.max(0, this.cap.aw3 - this.onboard);
    if (capLeft <= 0 || this._bank < 1) return out;
    const wait = this.waitingAt(name, idx);
    if (wait <= 0) return out;
    /* 小交路的闸门：目的站在这趟车行程之外的那部分人**不上车**，留在站台上
       等下一班全程车（`withinShare` 与 `_add` 用同一张权重表，不另算一份）。
       份额按**上限取整**：一列车门开人等人，剩最后一个人够不够挤上去本来就
       是连续量，往下取整会让短行程的车在客流少的站永远装 0 人。 */
    const gate = withinShare(this.line, idx, upto, this.hour, this.rain);
    const allow = Math.min(wait, Math.ceil(wait * gate));
    /* 车厢越挤，上得越慢：定员以内全速，到超员线降到 0 */
    const crowd = C(this.onboard / this.cap.aw2, 0, 1.4);
    const slow = crowd < 0.85 ? 1 : C(1 - (crowd - 0.85) / 0.55, 0, 1);
    const on = Math.min(allow, capLeft, Math.floor(this._bank * slow));
    if (on > 0) {
      this._bank -= on / Math.max(0.2, slow);
      this.waiting.set(name, wait - on);
      this.onboard += on; this.boarded += on; out.on = on;
      this._add(idx, on, upto);
    }
    return out;
  }
  /** 停站时间不足时留在站台上的人（关门抢客） */
  stranded(idx, name) { return this.waitingAt(name, idx); }
  /** 完成本站乘降：把剩余候乘计入 leftBehind 并清零，避免下一站重复 */
  closeStation(idx, name) {
    const left = this.waitingAt(name, idx);
    this.leftBehind += left;
    this.waiting.set(name, 0);
    return left;
  }
  /** 0 = 空车，1 = 定员 AW2，>1 = 超员 */
  fill() { return this.onboard / this.cap.aw2; }
  /**
   * 物理模型的载荷系数。AW0 空车约 0.84 倍定员工况质量，
   * 每满载一人增加的质量按 A 型车 60 kg/人、定员 1860 人折算，
   * 因此 定员 ≈ 1.14、超员线 ≈ 1.19 —— 与 physics.js 的 clamp[0.72,1.32] 相容。
   */
  loadFactor() { return C(0.84 + 0.30 * this.fill(), 0.72, 1.32); }
  /** 满载率百分比（广播与 HUD 用） */
  pct() { return Math.round(this.fill() * 100); }
  /**
   * 客运评分：0~100。
   * 下客完成度、上客完成度（相对站台需求）、以及是否把人甩在站台上。
   */
  stationScore(idx, name, dwellSec) {
    this.endStation();
    const rec = this.log[this.log.length - 1];
    if (!rec) return 100;
    const tooLong = dwellSec > 36 ? 0.06 : 0;         // 停站过久影响全线准点
    return Math.round(C(100 * rec.service - 100 * tooLong, 0, 100));
  }
  /** 到站时记录一次乘降，供 stationScore 使用 */
  beginStation(idx, name) {
    this.log.push({ idx, name, wantOff: this.alightNeed(idx), wantOn: this.waitingAt(name, idx), off: 0, on: 0, dwell: 0 });
  }
  /**
   * 结束本站乘降，算出"司机能负责的那部分"服务率。
   *
   * 关键：车厢已经挤到超员线时，站台上剩下的人**本来就上不去**，
   * 那是线网运能问题，不是司机的失职。把这部分从分母里扣掉，
   * 否则早高峰把车停得再准也只能拿 70 分，玩家会觉得评分在乱打分。
   */
  endStation() {
    const r = this.log[this.log.length - 1];
    if (!r) return;
    const left = Math.max(0, r.wantOn - r.on);
    /* 超过定员 5% 之后还留在站台上的人，算"挤不上车"而不是"司机没等够"：
       这是线网运能问题。真实早高峰就是这个状态——站台永远有人上不去。 */
    const full = this.onboard >= this.cap.aw2 * 1.05;
    r.blocked = full ? left : 0;
    const want = r.wantOff + Math.max(0, r.wantOn - r.blocked);
    r.service = want > 0 ? C((r.off + r.on) / want, 0, 1) : 1;
    r.left = left;
  }
}

SH.pax = { Flow, demand, capacity, rushFactor, PER_CAR, CLASS, destW, withinShare };

})(typeof window !== 'undefined' ? window : globalThis);
