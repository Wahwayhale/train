/* ============================================================================
 * game.js — 世界装配、相机、行车状态机、渲染循环
 * ==========================================================================*/
(function (global) {
'use strict';
/* 构建号：每次影响玩家可见行为的修改都要更新（index.html 首页 .build-stamp 同步）。
   玩家报"画面异常"时，这个角标第一眼确认他跑的是不是这份代码。 */
const BUILD_STAMP = '23:59';
const SH = global.SH;
const { clamp: C, lerp, rgbOf, rng, hash32, m4basis, m4trs, m4mul, mat4, m3normalFromM4, smoothstep } = SH;
const { Builder, Geo } = SH;
const { cross, norm3 } = Geo;
const IDENT_M = mat4();   // 149 条 perf/GC：帧循环里的单位阵从每帧 mat4() 提为模块级

/* 三分量就地插值（149 条 perf/GC）：envFor 原来每帧 5 个 .map() 各产一个
   新数组 —— 写进持久缓冲，零分配。 */
const mix3 = (dst, a, b, t) => {
  dst[0] = a[0] + (b[0] - a[0]) * t;
  dst[1] = a[1] + (b[1] - a[1]) * t;
  dst[2] = a[2] + (b[2] - a[2]) * t;
  return dst;
};

/* ---- Perf：子系统帧耗时归因（149 条）------------------------------------
   URL 加 ?perf=1 开启；HUD 地勤行追加最贵的几个子系统（0.5 s 窗口的
   均值/最大 ms）。"cpu 延迟大 / 帧率波动"这类问题先量后动刀 —— 以后谁
   再把大件塞进帧循环，打开这个开关一眼就能看见它叫什么。
   关闭时 mark() 是一次属性读 + 早退，帧内 ~9 次调用的成本 < 0.01 ms
   （判据 test-perf ⑦）。 */
const PERF = SH.FRAME_PERF = {
  on: false,
  names: ['top', 'sim', 'crowd', 'screens', 'cam', 'begin', 'world', 'post'],
  acc: null, max: null, n: 0, _p: '', _t: 0,
};
PERF.mark = function (name) {
  if (!this.on) return;
  const t = performance.now(), d = t - this._t;
  if (this._p && this.acc) {
    const i = this.names.indexOf(this._p);
    if (i >= 0) { this.acc[i] += d; if (d > this.max[i]) this.max[i] = d; }
  }
  this._p = name; this._t = t;
};
PERF.frameStart = function () { if (!this.on) return; this.n++; this._p = 'top'; this._t = performance.now(); };
PERF.close = function () { if (this.on && this._p) this.mark(''); };
PERF.window = function () { this.acc = new Array(this.names.length).fill(0); this.max = new Array(this.names.length).fill(0); this.n = 0; };
PERF.top = function (k) {
  if (!this.acc) return '';
  const r = [];
  for (let i = 0; i < this.names.length; i++) if (this.acc[i] > 1e-4) r.push([this.names[i], this.acc[i] / Math.max(1, this.n), this.max[i]]);
  r.sort((a, b) => b[1] - a[1]);
  return r.slice(0, k || 3).map(x => x[0] + ' ' + x[1].toFixed(2) + '/' + x[2].toFixed(1) + 'ms').join(' · ');
};

const CAR_GAP = 0.35;
/* 连续驾驶的"意图 → 实际段数"是 `SH.legsPlan`（core.js，纯函数、可被离线断言）。 */

/* ================================================================== 线路实例 */
class LineRuntime {
  constructor(def, svc) {
    this.def = def;
    /* 交路（service）。5/10/11 号线有支线，以前支线只活在 `_note` 的一句话里：
       车头目的地屏、站牌、走字屏、报站永远报主线终点站，玩家看不见"这条线有分支"。
       支线站表 = 主线切到分岔站 + 支线站序；站间距仍按"站名对"哈希生成，
       所以**分岔站之前每一站的里程都与主线相同**（同一 seed、同一站名对、同一跨江点），
       这条不变量由 test-core 钉住 —— 支线因此是"同一条隧道换了个尾巴"，不是另一条线。 */
    this.svc = svc === 'branch' && def.branch ? 'branch' : 'main';
    this.baseId = def.id;
    this.id = this.svc === 'branch' ? def.id + '#branch' : def.id;
    this.name = def.name + (this.svc === 'branch' ? ' 支线' : '');
    this.color = def.color; this.color2 = def.color2 || def.color;
    this.stations = this.svc === 'branch' ? this._branchStations() : def.stations;
    this.stock = SH.STOCK[def.stock];
    this.perf = SH.PERF[def.perf];
    this.maxKmh = def.maxKmh;
    this.gaps = this._gaps();
    /* 跨水点：地理事实，来自数据文件（crossings 站名对），**不是相机表**。
       线形生成时就要知道哪里有江 —— 大桥必须落在直线与水平段上，
       而"到了那里怎么拍"（VIEWSPOTS）属于表现层，不能被生成器依赖。
       10 号线那处曾因为观景点按"由北往南"书写、站表在那段是反排而静默漏掉，
       所以这里按站序取绝对值相邻，并在名字对不上时直接抛。 */
    this.crossings = (def.crossings || []).map(p => {
      const a = this.stations.indexOf(p[0]), b = this.stations.indexOf(p[1]);
      if (a < 0 && b < 0) {
        /* 换到支线的交路：整对都不在本站表里 = 这个交路不过这条江，合法跳过。
           只缺一边的"半对"是数据写错，无论哪个交路都必须抛。 */
        if (this.svc === 'branch') return null;
        throw new Error(def.name + ' crossings：没有车站「' + p[0] + '」');
      }
      if (a < 0 || b < 0) throw new Error(def.name + ' crossings：' + (a < 0 ? p[0] : p[1]) + ' 不在本交路站表里');
      if (Math.abs(a - b) !== 1) throw new Error(def.name + ' crossings：' + p[0] + ' / ' + p[1] + ' 不是相邻两站');
      return { i: Math.min(a, b), wide: p[2] !== 'creek' };
    }).filter(Boolean);
    this.al = SH.buildLineAlignment(this.stations, this.gaps, SH.lineSeed(this.baseId),
      { vMax: this.maxKmh, cross: this.crossings.map(c => c.i) });
    /* 这几个标志必须在 `_profile()` 之前赋值：profile 里要读 `this.maglev` 决定
       涂装与断面。顺序写反的后果是**静默**的 —— 磁浮一直在用地铁的灰色腰带和
       方箱断面，没有任何判据报红（profile 里读到的是 undefined）。 */
    this.screen = def.screen || this.stock.screen || 'full';
    this.uto = !!(def.uto || this.stock.uto);
    this.maglev = !!def.maglev;
    this.loop = !!def.loop;
    this.profile = this._profile();
    /* 高架区间必须按"本交路的站表"解析：数据加载时把站名换算成序号，那是**主线**的序号，
       换到支线就会整体错位（这正是当年"裸序号"埋的坑，只是这次换交路来踩）。 */
    this.elevatedRanges = this._elevatedRanges();
    /* 运营限速。"限速标准统一 70"这条只适用于地铁线：磁浮的设计速度就是 300，
       压到 70 就成了全世界最快的一根轨道跑不过公交车；浦江线设计 60，写 70 是虚标。
       所以默认 min(设计速度, 70)，个别线路用 runKmh 显式覆盖。 */
    this.runKmh = def.runKmh || Math.min(this.maxKmh, SH.RUN_LIMIT_KMH);
  }
  /** 支线站表 = 主线切到分岔站 + 支线站序。分岔站本身属于两条交路，必须在站表里。 */
  _branchStations() {
    const b = this.def.branch, at = this.def.stations.indexOf(b.at);
    if (at < 1) throw new Error(this.def.name + ' branch.at「' + b.at + '」不在主线站表里');
    const dup = b.stations.filter(s => this.def.stations.indexOf(s) >= 0);
    if (dup.length) throw new Error(this.def.name + ' 支线站与主线重名：' + dup.join('、'));
    return this.def.stations.slice(0, at + 1).concat(b.stations);
  }
  /** 本交路的终点站 —— 车头目的地屏、站牌、走字屏、报站都读它，不许各自再算一遍 */
  get terminus() { return this.stations[this.stations.length - 1]; }
  get origin() { return this.stations[0]; }
  /** 本交路的高架/地面区间（序号，相对**本交路**站表）。
   *  主线直接用数据加载时算好的序号；支线按站名重新解析 —— 站名不在本交路里，
   *  说明它在分岔之后的另一条尾巴上，这时**截到分岔站而不是整段丢掉**：
   *  5 号线主线的高架区间是 春申路→望园路，支线交路只到 东川路，
   *  但 春申路→东川路 这一段照样在高架上，整段丢掉会让它悄悄变回隧道。
   *  两端都不在本交路里才丢（那段与本交路完全无关）。 */
  _elevatedRanges() {
    const d = this.def;
    if (this.svc === 'main') return d.elevated || [];
    const fork = this.stations.indexOf(d.branch.at);
    const out = [];
    const add = (rs, tag) => (rs || []).forEach(r => {
      const ai = this.stations.indexOf(r[0]), bi = this.stations.indexOf(r[1]);
      if (ai < 0 && bi < 0) return;
      const a = ai < 0 ? fork : ai, b = bi < 0 ? fork : bi;
      if (a === b) throw new Error(d.name + ' ' + tag + '：区间「' + r.join('~') + '」在本交路里退化成一点');
      out.push(a <= b ? [a, b] : [b, a]);
    });
    add(d.elevatedNames, 'elevated');
    add(d.branch.elevated, 'branch.elevated');
    return out;
  }
  /** 站名 → 站序；[站名A, 站名B] → 两站正中间。
   *  地标/跨江点以前一律按序号钉（`i: 7.5`），站表一增删就悄悄挪位——
   *  写错站名这里直接抛，不让地标悄悄消失在水泥里。 */
  sti(x) {
    if (typeof x === 'number') return x;
    if (Array.isArray(x)) return (this.sti(x[0]) + this.sti(x[1])) / 2;
    const i = this.stations.indexOf(x);
    if (i < 0) throw new Error(this.name + '：没有车站「' + x + '」');
    return i;
  }
  _gaps() {
    return SH.lineGaps(this.def, this.stations);
  }
  _profile() {
    const s = this.stock;
    return Object.assign({}, SH.train.DEFAULTS, {
      width: s.width, floorY: s.floorY, roofY: s.roofY, headLen: s.headLen, midLen: s.motorLen,
      gap: s.gap, doors: s.doors, doorPitch: s.doorPitch, doorW: s.doorW, doorH: s.doorH,
      cars: s.cars, wheelR: s.wheelR, bogieCenters: s.bogieCenters, supply: s.supply,
      rubber: s.rubber, noseShape: s.noseShape,
      maglev: this.maglev,
      livery: this.color, accent: SH.mixHex(this.color, '#ffffff', 0.55),
      band: this.maglev ? '#eef2f4' : '#c9ced1', nose: this.maglev ? '#f2f5f7' : '#e6eaec',
      maxSpeed: this.maxKmh, massT: s.massT, type: s.type, formation: s.formation,
    });
  }
  /** 该里程是高架/地面吗 */
  isElevated(s) {
    if (!isFinite(s)) return false;
    /* 磁浮全线在高架桥上，包括两端进出停车线的引入段 —— 上海磁浮没有地下段，
       而长定子轨道梁也进不了隧道。以前按 `elevated` 站名区间判，端外那几百米
       被判成"隧道"，于是这条全世界最快的线路两头长出钢轨和枕木。 */
    if (this.maglev) return true;
    const S = this.al ? this.al.stationS : this.stationS;
    for (const r of this.elevatedRanges) {
      const a = S[r[0]] == null ? this.al.total : S[r[0]];
      const b = S[r[1]] == null ? this.al.total : S[r[1]];
      if (s >= a - 40 && s <= b + 40) return true;
    }
    return false;
  }
  /**
   * 高架程度 0..1 —— 用于渲染而不是用于线路事实。
   * 硬切换会让列车刚出高架口、或者相机稍微离开高架段时，
   * 突然套上浓雾，把 1 km 外的陆家嘴整个吃掉。这里给 900 m 的过渡带。
   */
  openness(s) {
    if (!isFinite(s)) return 0;
    s = C(s, 0, this.al.total);
    /* 停车基地是**露天**的。它按线路构造既不是高架也不是地面段，
       openness 一返回 0，envFor 就把隧道那套（雾密度 0.0112、环境光 0.085）
       盖上来 —— 实测司机台开进库就是一片黑，只有高杆灯亮着，
       停车线、车挡、库房全部看不见。 */
    if (this.depotAtS(s)) return 1;
    if (this.isElevated(s)) return 1;
    const S = this.al.stationS;
    let best = 0;
    for (const r of this.elevatedRanges) {
      const a = S[r[0]] == null ? this.al.total : S[r[0]];
      const b = S[r[1]] == null ? this.al.total : S[r[1]];
      if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
      const d = s < a ? a - s : (s > b ? s - b : 0);
      best = Math.max(best, 1 - Math.min(1, d / 900));
    }
    return best;
  }
  /** 两端停车基地的里程区间。
   *  真实地铁的正线两端都以出入段线接地面运用库，本项目的线形本来就在
   *  首尾各留了一段引入直线（站前 PRE+300、站后 POST+320），基地就落在那里。
   *  `end` 是这处基地对应"哪一端的终点站"，用来判断本次运行是否终到这里。 */
  depotZones() { return SH.depotZones(this.al); }
  /** 终到站序对应的基地（没有则 null）：只有线路两端的站才有 */
  depotAt(endIdx) { return SH.depotAt(this.al, endIdx); }
  /** 里程是否落在基地内 */
  depotAtS(s) { return SH.depotAtS(this.al, s); }
  /** 跨江水道在里程轴上占的区间。
   *  这些位置要把街面/绿化/楼整个挖断，否则 11 m 高的地面会把江面盖住，
   *  从车窗看出去就是"列车在田里开"而不是"列车过河"。
   *  第三个分量是**横向**（垂直线路）的禁建半径：水面横穿线路时沿程只有
   *  ±340 m，横向却铺到 ±1500 m，远景楼群（world.farCity）必须按矩形挖，
   *  只按里程挖就会在江面上方摆一排楼。`inAny`/`subtractRanges` 只看 [0][1]，
   *  多出来的这一项对它们无害。 */
  waterRanges() {
    const out = [];
    for (const c of (this.crossings || [])) {
      const ss = (this.al.stationS[c.i] + this.al.stationS[c.i + 1]) / 2;
      if (!isFinite(ss)) continue;
      /* 窗口必须**盖住整条江的实际宽度**，不能只盖"平均"宽度。
         waterBand 的半宽是 width×(0.36+0.21·fbm)，620 的江就是 223~447 m，
         而这里以前写 340 —— 于是 340~447 那一段仍然按"陆地"处理：
         高架桥墩照打、街面照铺，墩子站在江水里、防汛墙被楼群压住。
         取 460（>最宽 447，且正好落在桥台 ±450 外侧）。 */
      const half = c.wide ? 460 : 72;
      out.push([ss - half, ss + half, c.wide ? 1560 : 800]);
    }
    return out;
  }
  /** 最近站序对应的里程，支持小数：7.5 = 7→8 区间中点。
   *  地标必须钉在真实位置（跨江点是两站之间，不是站本身），所以站序要能连续取值。*/
  stationSAt(i) {
    i = this.sti(i);
    const S = this.al.stationS, a = Math.floor(i), t = i - a;
    const s0 = S[a], s1 = S[Math.min(a + 1, S.length - 1)];
    if (s0 == null || !isFinite(s0)) return null;
    if (s1 == null || !isFinite(s1)) return s0;
    return s0 + (s1 - s0) * t;
  }
  /** 最近的站序号与距离 */
  nearStation(s) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.al.stationS.length; i++) { const d = Math.abs(this.al.stationS[i] - s); if (d < bd) { bd = d; best = i; } }
    return { i: best, d: bd, s: this.al.stationS[best] };
  }
  stationSide(i) {
    /* 站台侧由**线**决定，不逐站掷骰子（第 108 条 双线断面）：上海地铁
       右侧行车，一条线的站台恒在同一侧 —— 这是地理事实，不是逐站的装饰。
       根本原因：对向股道必须沿全线保持**同一个横向位置**
       （−side × SH.TRACK_OFFSET），连续的物理股道不许在站间"换轨"；
       逐站哈希会让有的站的对向轨压到站台底下。
       站台几何（world.js station/crowdStation）、开门侧 HUD、进/到站播报、
       追逐相机、对向轨烘焙（buildRuns）与对向车渲染读的都是这一个值。 */
    const h = hash32(this.id, 31);
    return (h % 3 === 2) ? -1 : 1;
  }
  /** 对向股道横向位置（第 108 条 双线断面 / 第 122 条 岛式）：
      单点在 `SH.oppLatAt` —— 烘焙（buildRuns 的 oppLat）与这里读同一个函数，
      常数探针（test-xsect 把 SH.TRACK_OFFSET +1）钉住"两处必须一起搬家"。
      岛式站区里线间距要加宽到夹得下一座站台，所以它是**逐里程**的而不是一个数。 */
  oppLatAt(s) { return SH.oppLatAt(this, s); }
  /**
   * 对向车在里程 s 是否该出现（第 108 条）—— 与 buildRuns 的烘焙判据
   * **同一个语义**：车辆基地（库内没有对向正线）与隧道区间（双洞各自
   * 独立，本洞里看不见对向轨）不出现；站区与高架段出现。世界烘焙读
   * runsOf，运行时渲染读这里 —— 两处不同源，就会出现"烘了轨没画车 /
   * 画了车底下没有轨"。
   */
  oppVisible(s) {
    if (this.depotAtS(s)) return false;
    const ns = this.nearStation(s);
    if (ns.d < SH.STATION_HALF) return true;
    return this.isElevated(s);
  }
  /**
   * 镜像交路（第 108 条 对向车队）：同一个调度器类、同一份时刻模型
   * （HEADWAY / 配车 / 间隔公式全在 traffic.js）跑在**镜像里程**上 ——
   * 代理只反转站表（u = total − s），blocks / at / limitAt / terminus
   * 全部从正向代理解析，调度器一行都不用改。对向出站信号在真实里程上
   * 自然落在"站中心 − 96"（它们的进站方向与正向相反），每个方向各有
   * 自己的闭塞分区表 —— 这才是双线各自独立防护的本义。
   * 禁止第二份时刻公式：改头时/配车只许改 traffic.js 一处。
   */
  mirror() {
    const al = this.al, total = al.total, self = this;
    const proxyAl = {
      /* 代理站表必须是**代理里程**（u = total − s）且**升序**：blocks()
         （`len = b − a > 0` 才建分区）与 `_nextMark`（`S[t.next] < t.s`
         升序走表）都按升序站表消费 —— 降序实里程会让对向车队的分区表
         塌成空表、停站判定失效（对向车永远不停站开门）。 */
      stationS: al.stationS.slice().reverse().map(s => total - s),
      total,
      at(u) {
        const r = al.at(total - u);
        return { s: r.s, x: r.x, y: r.y, z: r.z, th: r.th, k: r.k, grade: -r.grade, cant: r.cant };
      },
    };
    return {
      al: proxyAl,
      stations: this.stations,
      perf: this.perf, stock: this.stock, profile: this.profile,
      maxKmh: this.maxKmh, runKmh: this.runKmh,
      id: this.id,
      /* loadJit 的种子用 seedTag 区分两队（否则两队的乘客偏置逐列完全相同）；
         HEADWAY 查表仍用 id —— 头时必须同源。 */
      seedTag: this.id + '-opp',
      gaps: this.gaps,
      terminus: this.terminus,
      limitAt(u) { return self.limitAt(total - u); },
    };
  }
  limitAt(s, mode) {
    /* 运营限速统一 70 km/h（按需求）。注意这里只改**运营约束**：
       `maxKmh` 仍然保留为线路/车辆设计速度，因为它参与线形生成
       （超高平衡速度 vEq、曲线限速表），改它会动几何与全部离线判据。
       文案侧一律显示这个 70，不再显示设计速度。 */
    const base = this.runKmh;
    const cl = Math.min(this.al.curveLimitKmh(s), this.runKmh);
    const ns = this.nearStation(s);
    let lim = Math.min(base, cl);
    if (ns.d < 78) lim = Math.min(lim, 40);            // 进站限速
    if (this.depotAtS(s)) lim = Math.min(lim, 25);     // 库内道岔与地沟，25 km/h 顶
    /* UTO 线的功能标准对标：无人驾驶线上司机一旦接管，就是**限制人工模式 RM**
       —— 车载 ATO 不再监督运行曲线，只保留 ATP 防护，速度被压到 25 km/h 左右，
       直到交接回自动。以前"人工驾驶"在 UTO 线上和有司机的线跑得一样快，
       等于把最高等级自动化线当普通线用，标准没落进机制里。 */
    if (this.uto && mode === 'manual') lim = Math.min(lim, 25);
    return Math.max(20, Math.round(lim / 5) * 5);
  }
}

/* ================================================================== 观景点
 * 地标只在"该线该区间确实是高架/地面"时放置——地下段凭空冒出天际线是穿帮。
 * 距离做了艺术化压缩（真实视距 6–10 km 超出远裁剪面），高度与相互距离保真。
 * i = 站序号（可为小数，7.5 = 两站正中间）；side = 地标在轨道哪一侧；
 * dist = 压缩后的视距。**跨江/跨河类必须 dist = 0**：这类地标的桥塔、水面
 * 是以"横穿线路"为正解的，锚点偏移会把桥塔甩到线路侧面 300 m 处，
 * 于是列车过河时看不见桥，观景相机也永远框不进塔。
 * 取 dist 的时候两个方向都会出错：太近就插进沿街楼群（楼群外缘 88.8 m，
 * 地标最近点要求 ≥100 m），太远就成了"画面里一粒米"。现在两头都有判据——
 * **test-shot.js 会把每个观景点的地标横向净距、水面占比、主体占比直接量出来**，
 * 下面这些数是被它逼出来的，不是拍脑袋：0.5 节里那批 1150/850/620/900
 * 全部是因为"主体只占画面 0.5%~2.7%"往下挪的。
 * 注意 **dist = 0 是有效值**，读它的地方一律写 `== null` 判缺省，
 * 写 `sp.dist || 900` 会把 0 变成 900，跨江的江面就此被搬到线路外侧 1.8 km。
 * ------------------------------------------------------------------------*/
/* 锚点一律写**站名**（`'虹口足球场'`）或**两站名数组**（`['西渡','萧塘']` = 正中间），
 * 不写序号：序号在站表增删时会整体错位，而错位后的地标看起来"仍然在那里"，
 * 只是挪到了错误的里程上——这种错最难发现。写错站名 LineRuntime.sti 会直接抛。
 * ------------------------------------------------------------------------*/
let _viewspots = null;
/** VIEWSPOTS 惰性派生：本文件在 data/shanghai.js **之前**装载（传统 script 顺序
 *  与全部测试共用），不能在顶层读 SH.STATION_FEATURES；首次访问时数据已就位。 */
function viewspots() {
  if (_viewspots) return _viewspots;
  _viewspots = {};
  /* 「一站一特色」的唯一数据源在 data/shanghai.js 的 SH.STATION_FEATURES：
   * VIEWSPOTS 只是它投到"本线可呈现视角"上的子集 —— exit（地下站出站即景）
   * 与 via（特色经由另一条线呈现）的条目不落几何，地下段冒出天际线是穿帮。
   * 数据、生成与判据三层的关系由 test-facade 的 E 节钉住（单一来源对账）。 */
  for (const f of (SH.STATION_FEATURES || [])) {
    if (f.exit || f.via) continue;
    (_viewspots[f.line] || (_viewspots[f.line] = [])).push({ i: f.at, kind: f.kind, side: f.side, dist: f.dist });
  }
  return _viewspots;
}

const LANDMARK_NAMES = {
  lujiazui: '陆家嘴天际线', bund: '外滩万国建筑群', disney: '迪士尼城堡', lake: '淀山湖/滴水湖',
  airport: '机场航站楼', stadium: '虹口足球场', expo: '中华艺术宫', river: '黄浦江',
  bridge: '斜拉桥', crossing: '跨江大桥', creek: '苏州河/蕰藻浜', skyline: '城市天际线',
  zoo: '野生动物园', circuit: 'F1 赛道', port: '外高桥港区',
};

/* ------------------------------------------------------------------ 观景构图
 * 每种地标一套机位。必须按类型分开，因为地标尺度差三个数量级：苏州河只有
 * 80 m 宽、淀山湖半径 900 m、陆家嘴整片天际线压在 1150 m 外。之前所有类型
 * 共用一套公式，结果两头都错——小河拍成"一片天空加一条缝"，大地标被沿街
 * 24~76 m 的楼群整个挡死，画面里只有别人的立面。
 *
 * 侧景机位的硬约束（由 test-facade.js 逐条验证）：眼睛收在空廊里
 * （`|横向| < SH.CITY_BAND.corridor`），低于屋脊时由 `SH.sightCorridors`
 * 挖出的视廊兜住（第 87 条）。world.city 的屋脊（含塔冠机房）最高 72.1 m
 * （轨面上方）——贴左贴右都会被对面那一排立面糊满画面，实测就是整屏
 * 窗格墙、地标完全看不见。构图差异交给 ahead / ty / tmix / fov 做。
 * 跨江类不受这条约束：waterRanges 内楼群和街面都被整段挖掉了，可以贴水面。
 *
 * 字段（轨道坐标系：side = 地标所在侧，ahead 为负 = 列车后方）：
 *   ahead 相机沿线偏移（相对地标里程，不是列车里程——构图跟着地标走）
 *   lat   相机横向偏移；h 相机高度（轨面上方）
 *   ty    目标点高度（相对地标基座，地标基座 = 轨面下 12 m）
 *   tmix  目标点里列车的权重：0 = 纯地标明信片，1 = 只拍车
 *   td/tlat（cross 类）目标点在前方 td 米、对岸 tlat 米处
 */
const SHOT = {
  _default: { mode: 'side', ahead: -190, lat: 8, h: 56, ty: 45, tmix: 0.40, fov: 50 },
  /* 高度 2026-10-02 全线下调（74~128 m 的"航拍感"是历史包袱，不是构图需要）。
     方法：SHOT_TUNE 逐类扫 40/56/64/72/80，取**仍能过 test-shot 像素判据的最低值**：
     水面类被"水面占比下限"托住（port 72 / lake 80 / river 56），陆家嘴被"天空 ≤62%"
     托住（降到 72 必须同时把 ty 从 215 收到 150，否则仰角过大整屏是云），
     迪士尼/赛道/外滩/动物园/机场落到 40~64。全 15 条观景线复跑零红字。
     约束没变：lat ≤ 10 是把相机收在空廊里，不是把相机抬到楼群上面。 */
  sheshan:  { mode: 'side', ahead: -240, lat: 8, h: 62, ty: 46, tmix: 0.22, fov: 52 },
  lujiazui: { mode: 'side', ahead: -230, lat: 6, h: 72, ty: 150, tmix: 0.18, fov: 50 },
  skyline:  { mode: 'side', ahead: -250, lat: 8, h: 56, ty: 80, tmix: 0.20, fov: 56 },
  bund:     { mode: 'side', ahead: -200, lat: 8, h: 40, ty: 30, tmix: 0.30, fov: 52 },
  river:    { mode: 'side', ahead:  150, lat: 10, h: 56, ty: 4, tmix: 0.35, fov: 58 },
  port:     { mode: 'side', ahead:  170, lat: 10, h: 72, ty: 58, tmix: 0.30, fov: 52 },
  airport:  { mode: 'side', ahead: -320, lat: 10, h: 40, ty: 32, tmix: 0.25, fov: 50 },
  stadium:  { mode: 'side', ahead:  190, lat: 10, h: 56, ty: 20, tmix: 0.35, fov: 50 },
  lake:     { mode: 'side', ahead: -240, lat: 8, h: 80, ty: 2, tmix: 0.20, fov: 60 },
  disney:   { mode: 'side', ahead:  160, lat: 10, h: 64, ty: 40, tmix: 0.40, fov: 48 },
  circuit:  { mode: 'side', ahead:  220, lat: 10, h: 40, ty: 4, tmix: 0.30, fov: 54 },
  zoo:      { mode: 'side', ahead:  150, lat: 10, h: 40, ty: 12, tmix: 0.40, fov: 50 },
  expo:     { mode: 'side', ahead:  140, lat: 10, h: 56, ty: 34, tmix: 0.40, fov: 48 },
  /* 跨江/跨河：试过"站到江面上侧看大桥"（lat 560 / h 30），构图反而更空——
     眼离水面 40 m、视线接近水平，江面只占画面最下面一条，前景整片是空的。
     现在这套是实测留下的：眼在桥后 150 m、轨道上方 13 m，目标点投到前下 520 m
     × 侧向 200 m，斜拉桥塔、列车、江面与对岸天际线同框。
     水面占比由 test-shot.js 钉住（跨江/跨河 ≥16%，实测 29.2%）。
     **但 ahead 不能落在边塔的主跨索面里。** 塔在里程 ±300 m，主跨侧的索一直
     铺到 ∓90 m（inMax=210），相机若在 −150 m 就等于站在索面中：离它最近的那
     几根索只有几十米，0.34 m 见方在屏幕上就是 20 px 粗的黑杠，实测两张斜拉
     桥截图的上半屏都被它们切开。两塔之间只有 |x| < 90 m 这一段没有索（索铺到
     锚固点就停），机位就放进这段无索区，并把横向抬到 24 m 离开索面平面（索在
     横向 ±8 m）。 */
  bridge:   { mode: 'cross', ahead: -70, lat: 24, h: 22, td: 470, tlat: 150, ty: 34, fov: 52 },
  crossing: { mode: 'cross', ahead: -70, lat: 24, h: 22, td: 470, tlat: 150, ty: 34, fov: 52 },
  /* 苏州河/蕰藻浜只有 80 m 宽，水面窗口（waterRanges）也只挖 ±72 m。
     机位与目标点必须整体待在这个窗口里，否则视线的后半段会穿过窗口外
     依然存在的沿街楼群——test-facade.js 把这条量出来了。
     试过改成"沿河看"（td 40 / tlat 520）想要那条城市水道的透视，
     实测反而更差：水面从 23.8% 掉到 16.0%、主体从 3.0% 掉到 1.4%、
     天空涨到 53% —— 苏州河只有 84 m 宽，顺着河道看过去透视收敛得太快，
     两岸楼又排在横向（沿轨道方向）而不是河道两侧。回退到顺线路看。 */
  creek:    { mode: 'cross', ahead:  -55, lat: 8, h: 9, td: 70, tlat: 26, ty: 12, fov: 54 },
};

/* ------------------------------------------------------------------------
 * 观景机位求解。**唯一的一份实现**：camera() 与 test-shot.js / test-facade.js
 * 都调它。以前测试自己抄了一份，于是游戏改了构图判据看不见、测试全绿画面很糟；
 * 而"主体只有一栋楼高，相机却飞在 100 m 屋顶正上方"这类问题，正是抄的那份
 * 永远测不出来的（它照抄表里的 h，不看地标到底多高）。
 *
 * 侧景机位的高度**按地标类型手工给**，不按主体高度自动推。试过自动规则
 * "眼高 ≈ 0.45 × 主体高度"：外滩 50 m 的楼群从 96 m 降到 28 m，画面确实从
 * "一地漂浮屋顶"变成"一排立面"（主体占比 8%→15%）；但同一个规则把体育场、
 * 动物园、湖这三类**又扁又宽**的主体压到 21~37 m，平铺的水面与看台几乎侧着
 * 看，占比从 8~19% 掉到 1~8%。扁平要看俯角、高瘦要看俯角小的立面，两者不可能
 * 一条公式同时满足，所以高度回到逐类手工值，由 test-shot.js 的占比判据兜住。
 * 横向始终只有 6~10 m（在楼群走廊之内），所以降低高度不会撞进沿街立面。
 * @param bd 列车到地标的里程差，用于 tmix（车越近越把车留在画面里）
 */
/** 街面机位：行人站在第一个梯段前 20 m 的人行道上，朝出入口与高架站看过去。
 *  单独成函数是为了让 test-shot.js 能按像素量这张构图（自己再抄一份相机
 *  就是第五个"第二真相"了）。
 *
 *  站位与朝向是两版试错换来的，都不是几何问题：
 *  ① 相机在 ns.s−70 横向 52、朝 ns.s−24 横向 14 看 —— 背对出入口；
 *  ② 退到 ns.s+30 横向 56、目标 ns.s−70 横向 33 —— 目标对准了，但那是
 *     100 m 外一个 3.5 m 高的盒子，55° 视场下只占画面 4%，
 *     截图上就是"一片平地，什么都没有"，于是被记成了几何缺陷。
 *  出入口的站厅在横向 32.75、两个梯段在 ns.s−70 与 ns.s+35，
 *  所以人站在梯段前 20 m、横向 60.5，朝前内侧 32 m 看：
 *  梯段、站厅、雨棚、桥墩、站台底面一次全进画。
 *  横向 60.5 这个数曾经和行道树那一排**完全相同**（人站在树坑里，
 *  一团树冠糊在镜头上）；树挪到靠路缘的 57.9 之后让出 2.6 m，
 *  剩下的那团树冠在画面左上角，当前景留着 —— 中心区由判据钉住。 */
function streetShot(line, s) {
  const al = line.al;
  const ns = line.nearStation(s);
  const side = line.stationSide(ns.i);
  const dz = ns.s - 70, standS = dz - 20;
  /* 人行道面 = al.streetDy（与街面、站厅、桥墩同一个基准）+ 0.16 m 路缘抬高 + 1.65 m 眼高 */
  const e = al.world(al.frame(standS), side * 60.5, al.streetDy(standS) + 0.16 + 1.65);
  const t = al.world(al.frame(dz + 8), side * 30, al.streetDy(dz + 8) + 5.4);
  return { eye: e, target: t, fov: 55, near: 0.2, far: 2600 };
}

/** 驾驶室第一视角机位。提出来只有一份实现：`camera()` 用它，
 *  `test-shot.js` 也用它 —— 以前测试里没有 cab 机位，于是"手柄不转"
 *  "玻璃与台面之间空 0.55 m""车尾是个洞"三件事全在这个盲区里，
 *  12 个判据一个都不红（README 第 70、71 条）。
 *  @param sHead 车头停车里程
 *  @param look  {yaw, pitch, feel, acc, shake} —— 环视/速度场角/纵向加速度俯仰/震动 */
function cabShot(line, sHead, look) {
  const p = line.profile, al = line.al, lk = look || {};
  const f = al.frame(sHead - p.headLen / 2);
  const HN = p.headLen / 2;
  const ex = line.uto ? 0 : -0.34;
  const ey = p.floorY + 1.28;
  /* UTO 线以前把眼睛挪到 HN−1.15（"站在观景窗前"）。这是**乘客**的位置，不是司机：
     司机台在 front−0.805~−1.755、TCMS 屏在 front−1.58，眼睛在 HN−1.15 时它们全在
     眼睛**后方或 0.4 m 以内**，被近平面裁掉 —— 新加的 cab 判据实测
     浦江线「台面 0.0% / TCMS 屏 0.0%」，也就是 10/14/15/18 号线 + 浦江线 这 5 条线上，
     玩家操作的手柄、盯的屏、看的两只圆表统统看不见。
     无人驾驶的标准已经落在机制里了（RM 25 km/h、走字屏标签、开局说明），不需要
     靠把相机搬到仪表台前面去表达。观景窗就在司机**前方**，本来就看得到。 */
  const ez = HN - 2.90;
  const base = [f.p[0] + f.r[0] * ex + f.u[0] * ey + f.f[0] * ez,
                f.p[1] + f.r[1] * ex + f.u[1] * ey + f.f[1] * ez,
                f.p[2] + f.r[2] * ex + f.u[2] * ey + f.f[2] * ez];
  /* 南京式两分量平移：sway 沿车体横向、heave 沿垂向，各自独立
     （南京版 eye = [0.30+sway, 2.62+heave, …]；旧公式把两者耦合成
       对角位移，横移里混着等量垂跳 —— 量纲全乱）。 */
  const sh = lk.shake || 0, hv = lk.heave || 0;
  base[0] += f.r[0] * sh; base[2] += f.r[2] * sh;
  base[0] += f.u[0] * hv; base[1] += f.u[1] * hv; base[2] += f.u[2] * hv;
  /* 环视与旋转分量共用同一个 yaw/pit 通道（camera() 的乘坐感已是南京式
     纯平移，shakeYaw/shakePit 恒 0 —— 参数保留给判据与离线测试用）。
     纵向加速度俯仰吃平滑过的 acc，系数 0.003 = 南京版 target.y −= acc·0.12
     在 40 m 视距上的等效角（0.12/40 rad per m/s²）。 */
  const yaw = (lk.yaw || 0) + (lk.shakeYaw || 0);
  const pit = (lk.pitch || 0) - (lk.acc || 0) * 0.003 + (lk.shakePit || 0);
  const dL = [Math.sin(yaw) * Math.cos(pit), Math.sin(pit), Math.cos(yaw) * Math.cos(pit)];
  const dir = [f.r[0] * dL[0] + f.u[0] * dL[1] + f.f[0] * dL[2],
               f.r[1] * dL[0] + f.u[1] * dL[1] + f.f[1] * dL[2],
               f.r[2] * dL[0] + f.u[2] * dL[2] + f.f[2] * dL[2]];
  const far = line.openness(sHead) > 0.15 ? 4600 : 900;
  /* FOV 固定（南京版同样不拉 FOV）：随速拉伸会让整幅画面呼吸缩放，
     边缘元素位移读作"移动/重影"（111d/111e 两轮实测）；速度感交给
     平移晃动与音效。 */
  return { eye: base, target: [base[0] + dir[0] * 40, base[1] + dir[1] * 40, base[2] + dir[2] * 40],
    up: [f.u[0], f.u[1], f.u[2]], fov: 74, near: 0.10, far };
}

/** 司机台指示灯反映的状态。只此一份：`App.frame` 与离线判据都调它 ——
 *  测试自己再推一遍"哪盏灯该亮"就是第二个真值（这个项目已经为此付过六次学费）。 */
function cabLampState(s) {
  const tr = s && s.tr;
  return {
    doors: !!(tr && tr.doors),
    trac: !!(tr && tr.notch > 0 && tr.trac > 0.05),
    brk: !!(tr && tr.notch < 0 && tr.brk > 0.05),
    ato: !!(s && s.mode !== 'manual'),
    eb: !!(tr && (tr.eb || tr.atp >= 2)),
  };
}

function scenicShot(line, lm, s, bd) {
  const al = line.al;
  const sh = SHOT[lm.kind] || SHOT._default;
  const sgn = lm.side;
  const d = bd == null ? Math.abs(lm.s - s) : bd;
  const mix = (sh.tmix || 0) * Math.max(0, 1 - d / 700);
  const h = sh.h;
  let eye, look;
  if (sh.mode === 'cross') {
    /* 跨江：机位放在列车**后方**靠江的一侧，视线越过列车看向对岸。
       放在列车前方朝回看的话，画面里 90% 是水面——因为水面本身就横在
       相机与目标之间；从列车背后顺着桥轴看过去，桥、车、塔、对岸才会在
       同一条视线上排好。 */
    const fe = al.frame(C(s + sh.ahead, 0, al.total));
    eye = al.world(fe, sgn * sh.lat, sh.h);
    const ft = al.frame(C(lm.s + sh.td, 0, al.total));
    look = al.world(ft, -sgn * sh.tlat, sh.ty);
  } else {
    const fe = al.frame(C(lm.s + sh.ahead, 0, al.total));
    eye = al.world(fe, sgn * sh.lat, h);
    const head = al.world(al.frame(C(s + 20, 0, al.total)), 0, 2.4);
    const bg = [lm.origin[0], lm.origin[1] + sh.ty, lm.origin[2]];
    look = [head[0] * mix + bg[0] * (1 - mix),
      head[1] * mix + bg[1] * (1 - mix),
      head[2] * mix + bg[2] * (1 - mix)];
  }
  return { eye, look, fov: sh.fov, sh, h };
}

/* ------------------------------------------------------------------ 景观视廊
 * 侧景机位降到 40~80 m（第 87 条）之后，视线会在横向 55~115 m 处穿过沿街楼群带
 * （车道 71/96、屋脊 57~72 m）。解法不是把相机抬回 96 m，而是**把视线穿过楼群带
 * 的那一小段清空** —— 真实城市里这叫景观视廊/路口空地，城市本来就有。
 * 这里按几何算：视线从机位（lm.s + ahead, side·lat）投向地标（lm.s, side·dist），
 * 求它穿过楼群带（|横向| 50~115 m）的那段里程区间，加 14 m 余量。
 * city() 在该区间该侧不放楼；test-facade 的通视判据按同一张表豁免。
 * **一处都不许各写一份**：机位、判据、生成器读的都是这一个函数。 */
SH.sightCorridors = (line) => {
  /* 这是 `line` 的纯函数，却被**每次烘焙**调用（下面 WorldBuilder 的 cfg.sightClear）。
     一次调用要先把粗查表铺满全线（63 km / 25 m ≈ 2540 次 al.frame），再为每个侧景
     机位做 161 次全表线性扫描 —— CPU 剖析里占烘焙 6.8 %，而全线 20 条线里每次发车
     都要重付一遍。缓存挂在 line 上：换线才重算，结果与首算逐位相同。 */
  if (line._corridors) return line._corridors;
  const out = [];
  const al = line.al;
  /* 粗查表：每 25 m 一帧。视线在世界坐标里是直线，而轨道会弯 ——
     "横向"只能按帧反查，不能按线性插值算（l3 river / ml airport 的视线
     在弯道上会漂出线性估计的里程区间十几米）。 */
  const FS = [];
  for (let s = 0; s <= al.total; s += 25) FS.push(al.frame(s));
  const lookup = (p) => {
    let best = null, bd = Infinity;
    for (const f of FS) {
      const dx = f.p[0] - p[0], dz = f.p[2] - p[2], dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; best = f; }
    }
    return { s: best.s, lat: (p[0] - best.p[0]) * best.r[0] + (p[2] - best.p[2]) * best.r[2] };
  };
  for (const sp of (viewspots()[line.id] || [])) {
    const sh = SHOT[sp.kind] || SHOT._default;
    if (sh.mode !== 'side') continue;                       // 跨江类楼群已被 waterRanges 挖掉
    const ss = line.stationSAt(sp.i);
    if (ss == null) continue;
    const side = sp.side == null ? 1 : sp.side;
    const dist = sp.dist == null ? 900 : sp.dist;
    /* 射线必须走**产品自己那份实现**（scenicShot，含 ty/tmix 的构图），
       不能在这里另造一条"看向地标原点"的直线 —— 两条射线差 1~2 m 的里程，
       视廊就会差半个楼位，test-facade 按前者量、这里按后者挖，对不上。 */
    const fr0 = al.frame(ss);
    const lm = { kind: sp.kind, s: ss, side, dist, origin: al.ground(fr0, side * dist, -12) };
    const q = scenicShot({ al }, lm, ss, 0);
    const eye = q.eye, tgt = q.look;
    /* 沿视线采样，收集"横向落在楼群带（该侧 50~125 m）"的里程，首尾加 14 m 余量 */
    let sA = Infinity, sB = -Infinity;
    for (let i = 0; i <= 160; i++) {
      const t = i / 160;
      const r = lookup([eye[0] + (tgt[0] - eye[0]) * t, 0, eye[2] + (tgt[2] - eye[2]) * t]);
      if (Math.sign(r.lat) !== side) continue;
      const a = Math.abs(r.lat);
      if (a >= 50 && a <= 125) { sA = Math.min(sA, r.s); sB = Math.max(sB, r.s); }
    }
    if (sA > sB) continue;
    out.push({ s0: sA - 14, s1: sB + 14, side });
  }
  line._corridors = out;
  return out;
};


class World {
  constructor(renderer) {
    this.r = renderer;
    this.tag = 0;
    this.districts = new Map();      // key -> {batches, psd, stations}
    /* 站牌图集**只能有一张**，就是 App 上传给 GPU 的那一张。
       以前 bake() 每次自起 `new SignAtlas(2048)`，牌子画进这张临时图集、
       rect 坐标也按它算，而 GPU 拿到的永远是 app.sign —— 于是世界里的每一块
       站牌都按"临时图集里的坐标"去读"全局图集"，读到的正好是图集左上角那块
       （TCMS 屏 + 车头目的地屏），全线所有车站的站牌因此都写着终点站名。 */
    this.sign = null;
    this.ground = this._makeGround();
  }
  /**
   * 远景地面：一个跟随相机的巨大平面。
   * 烘焙出来的地面条带只能覆盖线路两侧有限宽度，地平线处会露出天空，
   * 城市就像浮在半空。这块平面跟着相机走，用雾把它自己的边缘藏掉。
   */
  _makeGround() {
    const b = new Builder();
    /* 半径 3000 m：这块平面的**边缘**是一条直线，只有靠雾把它藏掉。
       高架的雾密度 0.00042 下，1400 m 处只雾化了 29%，边缘清清楚楚，
       地平线就是一条"世界到此为止"的直线；3000 m 处雾化到 79%，
       边缘自然融进雾色，地平线才是软的。plate 会自动把超过 200 m 的
       边再切片并接好贴图位置，所以格子数不用迁就这个上限。 */
    const S = 3000, TQ = 400;
    /* 黄昏的城市地面不是黑的——被万家灯火和天空反光照着。
       之前这里太暗，导致两侧楼看起来悬在半空。
       而且**必须分格**：整块 6000 m 见方的地面只用一个四边形的话，
       雾、光照、贴图全靠在三个角之间线性插值，从低处看就是一片
       斜切过天空的半透明"膜"（这正是最初那张怪图的来源）。 */
    const N = 20, cell = (S * 2) / N;
    /* 材质用 aerial（一张 400 m 见方的航拍街区图），不用沥青微差：
       观景机位在 90~130 m 高空侧看地标时，画面下 2/3 全是这块地面，
       沥青那种"均匀灰板"在黄昏阳光下直接变成一片沙漠。
       自发光从 0.42 降到 0.16 —— 地面靠天光与万家灯火反光，不靠自己发光；
       0.42 会把街区肌理整个洗平。
       uv0 把每格的贴图位置接回世界坐标，否则 20×20 格各自从 (0,0) 开始铺，
       整块地面就是 400 份一模一样的补丁拼出来的条纹。
       还有第三个坑：plate 的绕序原来跟给定法向无关，法向朝上而
       cross(ax,ay) 朝下，于是**这块地面从来没被画出来过**（背面剔除），
       所有"城市浮在半空"的画面都是这么来的。见 mesh.js plate 与 test-wind.js。 */
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = -S + cell * (i + 0.5), z = -S + cell * (j + 0.5);
      b.plate([x, 0, z], [cell, 0, 0], [0, 0, cell], [0, 1, 0], rgbOf('#b9c3cc'),
        { mat: 'aerial', uv: 1 / TQ, uv0: [x / TQ, z / TQ], emi: 0.16 });
    }
    const up = b.finish();
    return this.r.upload(up, 'ground');
  }
  clear() {
    this.r.dropTag('world'); this.r.dropTag('psd'); this.r.dropTag('ptd'); this.r.dropTag('crowd');
    this.r.dropTag('psdlampG'); this.r.dropTag('psdlampA');
    this.districts.clear();
  }

  /**
   * 烘焙 [s0,s1] 的一段世界。
   * 返回 {key, batches, psdBatches, stationInfo}
   */
  /** @param pax 当前值乘的客流状态机；用来把站台人群画成与候乘人数一致的样子 */
  bake(line, s0, s1, key, pax) {
    const al = line.al;
    s0 = Math.max(0, s0); s1 = Math.min(al.total, s1);
    const sign = this.sign;
    if (!sign) throw new Error('World.sign 未设置：站牌会全部画进一张永不上传的临时图集（全线站牌显示同一个站名）');
    const wb = new SH.WorldBuilder({
      al, color: line.color, color2: line.color2, stations: line.stations,
      sign, night: 0.62, profile: line.profile, waterRanges: line.waterRanges(),
      sightClear: SH.sightCorridors(line),
    });
    // 只烘人工光；太阳与半球环境光交给运行时着色器（见 WorldBuilder._installLight）
    wb.sun = null;
    wb._installLight();

    const b = wb.b;
    /* 站台人群单独成批（第 101 条）：开门期间它要按客流人数重建，所以不能待在
       一次性的世界网格里。`buildRuns` 会把 `crowd()` 的产物导到这个构建器上；
       离线判据不设 `wb.crowdB`，因此它们看到的三角形集合与改动前逐字节一致。 */
    const cb = new Builder();
    wb.crowdB = cb;
    /* 分段与几何序列在 SH.WorldBuilder.buildRuns（与离线判据共用同一份实现） */
    const stationInfo = SH.WorldBuilder.buildRuns(wb, line, s0, s1, pax);
    /* 洞口：隧道↔高架过渡 */
    this._portals(line, b, s0, s1);
    /* 地标与远景：只在该区间确实是高架时才放 */
    const spots = viewspots()[line.id] || [];
    const placed = [];
    for (const sp of spots) {
      const ss = line.stationSAt(sp.i);
      if (ss == null) continue;
      // 只由"里程落在本区间内"的那个区间负责放置：留容差会让同一座地标
      // 被相邻两个区间各烘焙一次，叠加的半透明水面/桥塔会亮到发白。
      if (ss < s0 || ss > s1) continue;
      if (!line.isElevated(ss)) continue;
      try {
        /* dist 必须用 `== null` 判缺省，不能用 `||`：**跨江/跨河类的 dist 就是 0**
           （见 VIEWSPOTS 上方注释），而 `0 || 900` 会把它变成 900 —— 于是整条江
           被摆到线路侧面 900 m 处，`crossing()` 内部再按 dist 往远离线路的方向
           平移 900 m，江面最后在线路外侧 1.8 km。这就是"改了四排水色、加了堤岸、
           把河道做成弯曲的，截图里仍然看不见江"的真正原因：江根本不在那儿。
           而 waterRanges 是按里程挖的，所以街面照旧断成 680 m 的缺口 ——
           桥上往下看是一个空洞，两侧 1.8 km 外才有一条江。 */
        const r = SH.landmarks.place(b, line.al, ss, sp.side == null ? 1 : sp.side, sp.dist == null ? 900 : sp.dist, sp.kind);
        if (r) placed.push(Object.assign({}, r, { name: LANDMARK_NAMES[sp.kind] || sp.kind }));
      }
      catch (e) { console.warn('landmark failed', line.id, sp.kind, e.message); }
    }
    /* 远景盒体城市**放在地标之后**：它得按已经摆出来的地标占位（黄浦江面、
       淀山湖、港区水域）把自己挖掉，否则 95 m 一格的城市网格会直接长在水上。
       这些水面不在 waterRanges 里 —— 那一列只登记"横穿线路、要把街面挖断"
       的点，拦不住侧景类的江与湖。 */
    for (const lm of placed) if (lm.bbox) wb.noBuild.push({
      x0: lm.bbox.min[0], x1: lm.bbox.max[0], z0: lm.bbox.min[2], z1: lm.bbox.max[2] });
    wb.farCity(s0, s1);
    const psdB = new Builder();
    /* 屏蔽门状态灯（B3）：绿灯与琥珀灯**分开两批、按站上传** ——
       r.draw 的 {emi:} 是按批次的标量，混在一批里就只能同时亮同时灭；
       而且每站的状态不同（玩家这站门开着，隔壁站 AI 车正关门），
       所以批必须带着站序号走。状态：门关死 → 绿灯常亮（关闭到位）；
       门在开/在关 → 琥珀灯亮（门在动，等门的人退后）。 */
    const psdLampG = [], psdLampA = [];
    for (const st of stationInfo) {
      const gb = new Builder(), ab = new Builder();
      this._psd(line, psdB, gb, ab, st);
      psdLampG.push({ i: st.i, b: this.r.upload(gb.finish(), 'psdlampG') });
      psdLampA.push({ i: st.i, b: this.r.upload(ab.finish(), 'psdlampA') });
    }

    const meshes = b.finish();
    const batches = this.r.upload(meshes, 'world');
    const psd = this.r.upload(psdB.finish(), 'psd');
    /* 人群批次：与 psd / ptd 同一族做法 —— 几何一次烘焙、运行时按需重建。
       它不带 `_sig`、也不特殊定位，所以绘制循环的通用分支直接用 IDENT 画它。 */
    const crowdB = this.r.upload(cb.finish(), 'crowd');
    /* 信号机透镜：**每片透镜一个批次**，挂 `_sig` 让绘制循环按闭塞显示给 emi 覆盖。
       三片不能合成一批 —— `r.draw` 的 `{emi:}` 是按批次的标量，一批里点不亮单独一盏。
       tag 仍用 'world'：它的生命周期与这一段世界完全一致（clear() 一起丢）。 */
    /* 累积数组（信号透镜、站台屏）在**新 WorldBuilder 构造时**本来就是空的 ——
       每次 bake 都 `new SH.WorldBuilder({...})`，所以根本不需要"重置"。
       上一版偏偏在读之前写了一行 `wb.sigLamps = []; wb.ptdBatches = [];`，
       于是下面两个循环**永远遍历空数组**：信号透镜一盏都没上传过（绿灯
       一直靠顶点色画死），站台屏一批都没有。
       症状特别隐蔽：几何照建、顶点数照涨、没有任何判据报红，
       只有把批次读数打出来才看得见（dev/shot.js 的 `[屏] 批次 0`）。
       ——**"重置累积数组"这种防御性代码要先问：这份累积是跨调用存在的吗。**
       这里的答案是"不存在"，因为对象每次都是新的。 */
    const sigs = [];
    for (const o of (wb.sigLamps || [])) {
      const bs = this.r.upload(o.mesh, 'world');
      /* kind/grp/road/lo/hi（第 109 条，E3）：主线信号机只有 block/aspect；
         库区的入库信号机（depotIn）按 **库内占用**（lo..hi 引道段）显示，
         矮柱调车信号机（shunt）按 **指定股道**（road）显示 —— 这几个量
         都透传进 _sig，signalLighting 才能按 kind 分派到正确的真值。 */
      for (const bb of bs) bb._sig = { block: o.block, aspect: o.aspect,
        kind: o.kind, grp: o.grp, road: o.road, lo: o.lo, hi: o.hi };
      sigs.push({ s: o.s, block: o.block, aspect: o.aspect,
        kind: o.kind, grp: o.grp, road: o.road, n: bs.length });
    }
    /* 新画进去的牌子必须当场重传。App.begin() 里那次上传发生在烘焙**之前**，
       而列车往前开会不断生成新站牌 —— 不补这一次，新站的 rect 指向的是 GPU 里
       那张旧图集，读出来就是别处的内容（正是"每站站牌都写着同一个站名"的成因）。
       只在真的新增过时重传：4096² 一次是 64 MB。 */
    if (sign.dirty) { this.r.texFromCanvas('sign', sign.canvas, false); sign.dirty = false; }
    /* 站台信息屏：按 tag 'ptd' 单独上传，运行时只画"玩家所在站"的那一块。
       与信号透镜同一族做法 —— 几何一次烘焙，动的只是它读的实时纹理。 */
    const ptd = [];
    for (const o of (wb.ptdBatches || [])) {
      const bs = this.r.upload(o.mesh, 'ptd');
      /* 把屏的世界坐标一并留下来：诊断与判据要能回答"这块屏在哪儿、有多大"，
         而 GPU 批次只有 pb/nb/ub/cb，读不回顶点位置。 */
      ptd.push({ idx: o.idx, b: bs, s: o.s, lat: o.lat, dy: o.dy, w: o.w, h: o.h });
    }
    const d = { key, batches, psd, psdLampG, psdLampA, sigs, ptd, stationInfo, landmarks: placed,
      /* 人群批次的运行时重建需要三样东西：批次句柄、烘焙那份 LightGrid
         （重建的人必须被**同一份**站台灯照亮），以及窗口内有哪些站 ——
         一次重建要把窗口里每一站都重算，只重建当前站会把邻站的人整批丢掉。 */
      crowd: { batches: crowdB, lg: wb.lg, stations: stationInfo.map(st => st.i), sig: null } };
    this.districts.set(key, d);
    return d;
  }

  _portals(line, b, s0, s1) {
    const al = line.al, step = 4;
    let prev = null;
    for (let s = Math.max(0, s0 - 20); s <= Math.min(al.total, s1 + 20); s += step) {
      const ns = line.nearStation(s);
      if (ns.d < SH.STATION_HALF) { prev = null; continue; }
      const e = line.isElevated(s);
      if (prev != null && prev !== e) {
        // 找到边界（二分）
        let a = s - step, z = s;
        for (let i = 0; i < 6; i++) { const m = (a + z) / 2; if (line.isElevated(m) === prev) a = m; else z = m; }
        this._portal(b, line, (a + z) / 2, e);
      }
      prev = e;
    }
  }
  /** 洞口：隧道口环梁 + 边墙外扩 */
  _portal(b, line, s, toElevated) {
    const al = line.al, fr = al.frame(s);
    const prof = Geo.circleProfile(3.25, 22, 2.30).map(q => ({ x: q.x, y: q.y - 2.30, nx: q.nx, ny: q.ny }));
    const f0 = { p: al.world(fr, 0, 0), r: fr.r, u: fr.u, f: fr.f, s: 0 };
    const f1 = { p: al.world(al.frame(s + (toElevated ? 3 : -3)), 0, 0), r: fr.r, u: fr.u, f: fr.f, s: 1 };
    b.sweep([f0, f1], prof, { mat: 'concrete', color: rgbOf('#b0b7bb'), closed: true, uvAlong: 1, vSpan: 1 });
    const lp = al.world(fr, 0, 4.4);
    b.lg && b.lg.add && b.lg.add(lp[0], lp[1], lp[2], [1, 0.85, 0.6], 12, 0.5);
  }

  /** 屏蔽门活动页：沿站台直线布置，运行时整组沿平台轴向平移。
   *  @param lampB 绿灯批（门关死时亮）、lampA 琥珀批（门在开/在关时亮）——
   *         固定门楣上的指示灯**不随门页平移**，所以不进 psdB（psdB 整批
   *         会被门页位移矩阵推动）。 */
  _psd(line, b, lampB, lampA, st) {
    const al = line.al, fr = al.frame(st.s), side = st.side;
    const p = line.profile;
    const half = p.doorW / 2 - 0.02;
    const zs = SH.train.view.DoorZs(st.s + SH.STOP_MARK, p);
    const x = side * 2.12;
    const tangent = fr.f;
    const apm = !!p.rubber;
    for (const dz of zs) {
      for (const dir of [-1, 1]) {
        const z0 = dir < 0 ? dz - half / 2 : dz + half / 2;
        const fz = al.frame(z0);
        /* 门页的宽边必须沿**轨道切向**，法向必须沿**轨道横向**。
           原来写成世界轴：`ax = [0, 0, half]`、`normal = [side, 0, 0]` ——
           只有当站台恰好沿世界 Z 轴时才碰巧对，其余 bearing 下整扇门是
           **侧着/躺着**的，从站台上看到的就是"只有立柱和一道粉色横梁，玻璃不见了"。
           现在两个向量都从该里程的 frame 取，与站台的真实走向一致。 */
        const nrm = [fz.r[0] * side, fz.r[1] * side, fz.r[2] * side];
        const along = [fz.f[0] * half, fz.f[1] * half, fz.f[2] * half];
        /* 玻璃本体原来给 [0.62,0.80,0.86] —— 几乎是不染色的透明，
           贴在同样浅色的车体侧墙前面**完全看不出来**，站台上只见到一排立柱。
           真实屏蔽门玻璃在黄昏里读得出，靠的不是透明度而是那圈不锈钢框
           与上下两道实体：所以压暗玻璃，并补顶梁与下槛。
           APM（胶轮线）是**半高安全门**：玻璃 1.14 m、顶槛 0.58、下槛 −0.52，
           比全高门矮一半多 —— 与 world.js 的固定框同一个分支。 */
        const gh = apm ? 1.14 : 2.5, topR = apm ? 0.58 : 1.30, botR = apm ? -0.52 : -1.18, bandY = apm ? 0.50 : 1.16;
        const cy0 = apm ? 0.44 + 0.60 : 0.44 + 1.26;
        const cc2 = al.world(fz, x, cy0);
        /* 屏蔽门玻璃的染色从 [0.26,0.40,0.45] 提到 [0.46,0.56,0.60]。
           原来那档是照车厢车窗的量级抄的，但屏蔽门后面贴着的**不是亮客室**，
           真实站台机位里你透过屏蔽门看车厢，两层带色玻璃叠在一起把整节车
           压成一条黑带 —— 而"从站台上看见车厢"恰恰是这一层唯一的功能。
           真实的上海屏蔽门玻璃在室内照度下几乎无色，只在边缘与掠射角才反光，
           所以染色必须浅，让车漆色与客室灯带透过来。 */
        b.plate([cc2[0], cc2[1], cc2[2]], along, [0, gh, 0], nrm, [0.46, 0.56, 0.60],
          { mat: 'screenDoor', uv: 1 });
        b.plate([cc2[0] + nrm[0] * 0.010, cc2[1] + topR, cc2[2] + nrm[2] * 0.010], along, [0, 0.14, 0], nrm,
          rgbOf('#9aa4aa'), { mat: 'metal', uv: 1 });
        b.plate([cc2[0] + nrm[0] * 0.010, cc2[1] + botR, cc2[2] + nrm[2] * 0.010], along, [0, 0.16, 0], nrm,
          rgbOf('#7f888e'), { mat: 'metal', uv: 1 });
        b.plate([cc2[0] + nrm[0] * 0.012, cc2[1] + bandY, cc2[2] + nrm[2] * 0.012],
          [along[0] * 0.92, 0, along[2] * 0.92], [0, 0.05, 0], nrm, rgbOf(line.color), { mat: 'paint', uv: 1, emi: 0.3 });
        /* ---- 门头状态灯（B3）：固定门楣正中一块双联指示 ----
           绿 = 关闭到位（真车口径：门头灯亮绿表示这扇门锁闭良好），
           琥珀 = 门在动（开门/关门过程中亮，提示等门的人退后）。
           两块板各自成批（psdGB / psdAB），绘制时按状态给 emi ——
           灭档不是 0：全灭会变成"这里什么都没有"，看不出本来有灯。
           高 0.16 m、宽 0.30 m，贴在门楣外侧（不随门页平移）。 */
        {
          /* 灯面必须贴在**门头梁的站台侧正面**上：梁占横向 2.11~2.33、
             标高 2.62~2.96（world.js 的 hdr sweep）。灯板放在 2.37（梁面外 4 cm）
             与 dy 2.79（梁的半高）—— psdlamp-door 实拍：放进梁体里就一个都看不见。
             APM 半高门没有门头梁：挂在扶手梁（dy 1.92）外沿的立板上。 */
          const ly = apm ? 2.05 : 2.79;
          const lx = apm ? x + side * 0.09 : x + side * 0.25;
          const ln = [nrm[0], nrm[1], nrm[2]];
          const lax = [fz.f[0] * 0.15, fz.f[1] * 0.15, fz.f[2] * 0.15];
          /* 绿/琥珀**沿轨道并排**两块（同位共面会 z-fighting，谁赢看概率），
             外框只给绿灯批补一份（框是静态的，两批都补会画两遍）。 */
          const lpG = al.world(fz, lx, ly);
          lpG[0] -= fz.f[0] * 0.085; lpG[1] -= fz.f[1] * 0.085; lpG[2] -= fz.f[2] * 0.085;
          const lpA = al.world(fz, lx, ly);
          lpA[0] += fz.f[0] * 0.085; lpA[1] += fz.f[1] * 0.085; lpA[2] += fz.f[2] * 0.085;
          lampB.plate(lpG, lax, [0, 0.080, 0], ln,
            rgbOf('#0d3019'), { mat: 'light', emi: 1 });
          lampA.plate(lpA, lax, [0, 0.080, 0], ln,
            rgbOf('#302609'), { mat: 'light', emi: 1 });
          const lpF = al.world(fz, lx - side * 0.012, ly);   // 框在灯面后 1.2 cm，共面会 z-fighting
          lampB.plate(lpF, [fz.f[0] * 0.26, fz.f[1] * 0.26, fz.f[2] * 0.26], [0, 0.105, 0], ln,
            rgbOf('#9aa4aa'), { mat: 'metal', emi: 0 });
        }
      }
    }
    st.psdAxis = [tangent[0], tangent[1], tangent[2]];
    st.psdSide = side;
  }
}

/* ============================================================ 动态列车视图 */
class TrainView {
  constructor(renderer) { this.r = renderer; this.tag = 'train'; }
  setLine(line, sign, tcmsRect) {
    this.line = line;
    const p = line.profile;
    /* 车型档案留一份在外层：门叶滑动量（`SH.train.doorSlide`）在 `draw()`/`_drawCar`
       里要读它，而外层 TrainView 没有 `p` 字段（内层那份在 `this.tv.p`）。 */
    this.profile = p;
    const destRect = sign && sign.add('dest:' + line.id, 420, 96, (c, w, h) =>
      SH.textures.signDestination(c, w, h, { text: line.terminus, color: line.color }));
    /* 客室门上方走字屏复用同一张目的地屏格子：同一交路上全部列车同向同终点，
       所以这一格对任何一列车都是对的，不需要刷新。玩家自己的"下一站"另有一份
       实时纹理（updateCarLed），AI 车读不到是诚实的——隔着几百米也看不清字。 */
    this.tv = new SH.train.TrainView(p, { sign: { rect: destRect }, dest: destRect, tcms: tcmsRect, gauges: !!tcmsRect });
    this.r.dropTag('train');
    this.bodyB = []; this.doorAB = []; this.doorBB = []; this.glassB = []; this.innerB = []; this.paxB = [];
    this.doorLampB = [];
    this.doorALB = []; this.doorBLB = []; this.doorARB = []; this.doorBRB = [];
    this.doorLampLB = []; this.doorLampRB = [];
    /* 几何按**车型**只上传一次（头车/中间车），逐车数组共享同一批 GPU 批次 ——
       以前每节车把自己的 this.tv.head/mid 重新 upload 一遍：8 节编组把中间车
       几何传 6 遍（显存 ×6、setLine 时长 ×6），画的时候反正逐车给矩阵。
       下面的 _drawTrainInstanced 进一步把绘制也按车型归并。 */
    const carB = m => ({
      body: this.r.upload(m.body, 'train'),
      doorsA: this.r.upload(m.doorsA, 'train'), doorsB: this.r.upload(m.doorsB, 'train'),
      doorsAL: this.r.upload(m.doorsAL, 'train'), doorsBL: this.r.upload(m.doorsBL, 'train'),
      doorsAR: this.r.upload(m.doorsAR, 'train'), doorsBR: this.r.upload(m.doorsBR, 'train'),
      glass: this.r.upload(m.glass, 'train'), inner: this.r.upload(m.inner, 'train'),
      pax: m.pax.map(mesh => this.r.upload(mesh, 'train')),
      doorLamps: this.r.upload(m.doorLamps, 'train'),
      doorLampsL: this.r.upload(m.doorLamps.L || m.doorLamps, 'train'),
      doorLampsR: this.r.upload(m.doorLamps.R || m.doorLamps, 'train'),
    });
    const headB = carB(this.tv.head), midB = carB(this.tv.mid);
    for (let i = 0; i < p.cars; i++) {
      const isHead = (i === 0 || i === p.cars - 1);
      const m = isHead ? headB : midB;
      this.bodyB.push(m.body);
      /* 门叶两批（A 组向 −z、B 组向 +z）：一个批次只能拿一个矩阵，
         两片叶要往相反方向滑就必须分两批 —— 见 train.js buildMiddleCar。
         单侧开门（左 L / 右 R）细分四批。 */
      this.doorAB.push(m.doorsA);
      this.doorBB.push(m.doorsB);
      this.doorALB.push(m.doorsAL);
      this.doorBLB.push(m.doorsBL);
      this.doorARB.push(m.doorsAR);
      this.doorBRB.push(m.doorsBR);
      this.glassB.push(m.glass);
      this.innerB.push(m.inner);
      this.paxB.push(m.pax);
      this.doorLampB.push(m.doorLamps);
      this.doorLampLB.push(m.doorLampsL);
      this.doorLampRB.push(m.doorLampsR);
    }
    this.midCarB = midB;
    this.cabB = this.r.upload(this.tv.cab, 'train');
    /* 两只手柄单独成批：它们要按级位转，而 cab 批次是一次烘焙的静态几何。 */
    this.levB = this.tv.levers.map(o => ({ which: o.which, pivot: o.pivot, b: this.r.upload(o.mesh, 'train') }));
    /* 雨刮单独成批：雨天按相位摆，与手柄同一套"烘焙一次、矩阵动"。 */
    this.wiperB = this.tv.wipers.map(o => ({ side: o.side, pivot: o.pivot, b: this.r.upload(o.mesh, 'train') }));
    /* 指示灯每盏单独成批：几何仍是一次烘焙，动的只是绘制时的 `{emi:}` 覆盖。 */
    this.lampB = this.tv.lamps.map(o => ({ key: o.key, b: this.r.upload(o.mesh, 'train') }));
    this.beamB = this.r.upload(SH.train.buildBeam(p), 'train');
  }
  /**
   * 绘制一台列车的全部车体批次。
   *
   * 顺序是这一轮最要紧的一处改动。以前是 `玻璃 → 车体 → 门页`：玻璃挂在外侧
   * 8 mm 处，靠深度测试压住后面的车体带板，所以"看起来有窗"。车壳开窗之后这个
   * 技巧不成立了 —— 玻璃后面现在是**真有一间客室**，它不透明、写深度，必须先画；
   * 否则透过车窗看到的是"客室被车体带板盖住、再叠一层玻璃"的糊画面。
   * 所以统一按材质层排：0 不透明（车体 + 客室 + 门叶），1 半透（车窗、车门玻璃）。
   * 门叶要在开关时位移，先按开度算好矩阵再进同一个列表。
   */
  _drawCar(ci, M, open, load, lampK, paxSeed, doorSide) {
    const r = this.r, out = [];
    if (doorSide == null) doorSide = this.line ? SH.boardSideAt(this.line, 0) : 1;
    for (const b of this.bodyB[ci]) out.push({ b, M, l: 0 });
    for (const b of this.innerB[ci]) out.push({ b, M, l: 0 });
    /* 车内乘客：必须画在客室之后、门叶之前 —— 它不透明、写深度，
       放在客室前会被座椅/灯带盖住，放在门叶后又会从开门处透出来。
       档位逐节车厢给（C5）：同一列车各节从来不是同一档，
       seed 用列车自己的编号，同一列车永远同一分布。 */
    const lv = SH.train.paxLevels(load, this.bodyB.length, paxSeed)[ci];
    for (let k = 0; k < lv; k++) for (const b of (this.paxB[ci][k] || [])) out.push({ b, M, l: 0 });
    if (open > 0.001) {
      /* 单侧开门：仅站台侧门页（doorSide < 0 为左，doorSide > 0 为右）沿 ±z 滑开；
         非站台侧门页保持静止闭合（变换为原矩阵 M）。 */
      const off = open * SH.train.doorSlide(this.profile);
      const Ma = m4mul(M, m4trs([0, 0, -off], [1, 1, 1]));
      const Mb = m4mul(M, m4trs([0, 0, off], [1, 1, 1]));
      const MLA = doorSide < 0 ? Ma : M, MLB = doorSide < 0 ? Mb : M;
      const MRA = doorSide > 0 ? Ma : M, MRB = doorSide > 0 ? Mb : M;
      for (const b of this.doorALB[ci]) out.push({ b, M: MLA, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorBLB[ci]) out.push({ b, M: MLB, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorARB[ci]) out.push({ b, M: MRA, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorBRB[ci]) out.push({ b, M: MRB, l: SH.train.layerOf(b.mat) });
    } else {
      for (const b of this.doorALB[ci]) out.push({ b, M: M, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorBLB[ci]) out.push({ b, M: M, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorARB[ci]) out.push({ b, M: M, l: SH.train.layerOf(b.mat) });
      for (const b of this.doorBRB[ci]) out.push({ b, M: M, l: SH.train.layerOf(b.mat) });
    }
    for (const b of this.glassB[ci]) out.push({ b, M, l: SH.train.layerOf(b.mat) });
    for (const o of out) r.draw(o.b, o.M);
    /* 车门提示灯（B3）：仅站台开门侧提示灯按 doorLampK 亮 / 随蜂鸣闪 / 灭 */
    if (lampK != null) {
      const lamps = doorSide < 0 ? this.doorLampLB[ci] : this.doorLampRB[ci];
      if (lamps) for (const b of lamps) r.draw(b, M, { emi: lampK });
    }
  }
  /** AI 车队专用：中间车按**阶段**归并实例化 —— 一节车的每种材质批次一次
   *  draw call 服务全部中间车（8 节编组 6 辆中间车 × ~10 批 = 60 次 draw → 10 次）。
   *  头尾车仍走 `_drawCar`（它们各自带驾驶室/车灯差异，而且只有两节，省不到什么）；
   *  中段部分与玩家列车共用 `_drawMidInstanced`。
   *
   *  阶段顺序逐条对齐 `_drawCar`：车体 → 客室 → 乘客 → 门页 → 车窗 → 提示灯。
   *  差别是"逐节画完整节再画下一节"变成"一个阶段画完全部中间车"，于是**半透的
   *  叠序变了**（以前第 i 节的玻璃画完后才轮到第 i+1 节的车体，车体会盖掉它；
   *  现在全部不透明画完才画玻璃，混合叠在车体之上 —— 这本来才是正确次序）。
   *  改这里必须重新看图：node dev/inst-check.js RUN=1 SHOT=1（几何用隐藏半透的
   *  A/B 逐像素对账，观感用 inst-full-A/B 两张图对比）。
   *
   *  实例矩阵是 `m4basis` 的列主序 mat4，renderer 里做 `right*x + up*y + fwd*z + t`；
   *  门页的滑移量所有车一致，所以并进每实例矩阵（`m4mul(M, 平移)`），不必额外通道。
   */
  _drawTrainInstanced(ms, endsIdx, open, load, lampK, seed, doorSide) {
    const mid = [];
    for (let i = 0; i < ms.length; i++) if (endsIdx.indexOf(i) < 0) mid.push(i);
    for (const ci of endsIdx) this._drawCar(ci, ms[ci], open, load, lampK, seed, doorSide);
    if (mid.length) this._drawMidInstanced(mid, mid.map(i => ms[i]), open, load, lampK, seed, doorSide, false);
  }
  /** 中段车按**阶段**归并实例化的共用核心：AI 车（_drawTrainInstanced）与玩家列车
   *  （draw）都从这里走。`midIdx` 是车序号 —— 乘客档位按整列车序号取（lv[i]），
   *  传矩阵列时不能错位；`doorEmi` 只给玩家路径：开门时车门玻璃批次按 `emi:1`
   *  提亮（AI 车从来没有这个行为，保持历史样子）。 */
  _drawMidInstanced(midIdx, midMs, open, load, lampK, seed, doorSide, doorEmi) {
    const r = this.r, B = this.midCarB;
    for (const b of B.body) r.drawInstanced(b, midMs);
    for (const b of B.inner) r.drawInstanced(b, midMs);
    /* 乘客：几何各档同一份（setLine 已共享），只有"画几档"逐车不同（C5）——
       所以对第 j 档把"档位数 > j"的车收成一列实例，一次实例化。 */
    const lv = SH.train.paxLevels(load, this.bodyB.length, seed);
    for (let j = 0; j < B.pax.length; j++) {
      const mats = [];
      for (let k = 0; k < midIdx.length; k++) if (lv[midIdx[k]] > j) mats.push(midMs[k]);
      if (!mats.length) break;
      for (const b of (B.pax[j] || [])) r.drawInstanced(b, mats);
    }
    if (open > 0.001) {
      const off = open * SH.train.doorSlide(this.profile);
      const OSa = m4trs([0, 0, -off], [1, 1, 1]), OSb = m4trs([0, 0, off], [1, 1, 1]);
      const Ma = midMs.map(M => m4mul(M, OSa)), Mb = midMs.map(M => m4mul(M, OSb));
      const emiD = b => doorEmi && b.mat === 'window' ? { emi: 1 } : undefined;
      const mAL = doorSide < 0 ? Ma : midMs, mBL = doorSide < 0 ? Mb : midMs;
      const mAR = doorSide > 0 ? Ma : midMs, mBR = doorSide > 0 ? Mb : midMs;
      for (const b of B.doorsAL) r.drawInstanced(b, mAL, emiD(b));
      for (const b of B.doorsBL) r.drawInstanced(b, mBL, emiD(b));
      for (const b of B.doorsAR) r.drawInstanced(b, mAR, emiD(b));
      for (const b of B.doorsBR) r.drawInstanced(b, mBR, emiD(b));
    } else {
      for (const b of B.doorsAL) r.drawInstanced(b, midMs);
      for (const b of B.doorsBL) r.drawInstanced(b, midMs);
      for (const b of B.doorsAR) r.drawInstanced(b, midMs);
      for (const b of B.doorsBR) r.drawInstanced(b, midMs);
    }
    for (const b of B.glass) r.drawInstanced(b, midMs);
    if (lampK != null) {
      const lamps = doorSide < 0 ? B.doorLampsL : B.doorLampsR;
      if (lamps) for (const b of lamps) r.drawInstanced(b, midMs, { emi: lampK });
    }
  }
  /** 每节车的中心里程 */
  carPositions(sHead) {    const p = this.line.profile, out = [];
    let cur = sHead;
    for (let i = 0; i < p.cars; i++) {
      const len = (i === 0 || i === p.cars - 1) ? p.headLen : p.midLen;
      out.push({ i, s: cur - len / 2, len, head: i === 0 || i === p.cars - 1, front: i === 0 });
      cur -= len + CAR_GAP;
    }
    return out;
  }
  /** AI 列车专用：只画车体/玻璃/门，不画司机室内饰与车灯光锥，
   *  也**不碰 this.cars / this.M0** —— 那两个是玩家列车与驾驶室内饰共用的，
   *  被 AI 车覆写一次，司机台就会看到自己车内摆着别人的手柄。 */
  drawExternal(sHead, open, load, closing, seed) {
    const al = this.line.al, cars = this.carPositions(sHead);
    const lampK = SH.train.doorLampK(open, !!closing, this.now || 0);
    const doorSide = this.line ? SH.boardSideAt(this.line, sHead) : 1;
    /* 编组推进（carPositions）与矩阵（m4basis）一行都没改，只是从"边算边画"
       改成"先算齐再画"—— 实例化要的是**一列**矩阵而不是一个。 */
    const ms = [];
    for (let ci = 0; ci < cars.length; ci++) {
      const fr = al.frame(cars[ci].s);
      ms.push(m4basis([fr.r[0], fr.r[1], fr.r[2]], [fr.u[0], fr.u[1], fr.u[2]], [fr.f[0], fr.f[1], fr.f[2]], fr.p));
    }
    if (this.r.drawInstanced && this.midCarB) {
      this._drawTrainInstanced(ms, [0, cars.length - 1], open, load, lampK, seed || 0, doorSide);
    } else {
      for (let ci = 0; ci < cars.length; ci++) this._drawCar(ci, ms[ci], open, load, lampK, seed || 0, doorSide);
    }
  }
  /** 对向列车专用（第 108 条 双线断面）：镜像里程 u → 真实里程 total − u，
   *  车队从**车头向前**排 —— 对向行车方向是 −s，车头在整列车的最小 s 端
   *  （drawExternal 是从车头向后排，直接套用会让对向车拖着"车头"倒着开）。
   *  基架取 (−r, u, −f)：两次取负仍是旋转（det +1），车头（模型局部 +z）
   *  正对对向行车方向；整车横向平移到 −side × SH.TRACK_OFFSET 的对向股道上，
   *  与 buildRuns 烘的对向轨同一个 lat（单点定义）。 */
  drawExternalOpp(uHead, open, load, closing, seed) {
    const al = this.line.al, total = al.total, p = this.line.profile;
    const lampK = SH.train.doorLampK(open, !!closing, this.now || 0);
    const doorSide = this.line ? SH.boardSideAt(this.line, total - uHead) : 1;
    let cur = total - uHead;
    const ms = [];
    for (let ci = 0; ci < p.cars; ci++) {
      const len = (ci === 0 || ci === p.cars - 1) ? p.headLen : p.midLen;
      const carS = cur + len / 2;
      const fr = al.frame(carS);
      /* 横向逐节问 `oppLatAt`：岛式站区里对向股道是**斜着搬家**的，
         一列车（≈186 m）横跨过渡段时各节的横向本来就不同 —— 用一个常数
         会把整列车画成偏离自己股道半米，车头在轨上、车尾在道床外。 */
      ms.push(m4basis([-fr.r[0], -fr.r[1], -fr.r[2]], [fr.u[0], fr.u[1], fr.u[2]], [-fr.f[0], -fr.f[1], -fr.f[2]], al.world(fr, this.line.oppLatAt(carS), 0)));
      cur += len + CAR_GAP;
    }
    if (this.r.drawInstanced && this.midCarB) {
      this._drawTrainInstanced(ms, [0, p.cars - 1], open, load, lampK, seed || 0, doorSide);
    } else {
      for (let ci = 0; ci < p.cars; ci++) this._drawCar(ci, ms[ci], open, load, lampK, seed || 0, doorSide);
    }
  }
  /**
   * @param sHead 车头停车位置（里程）
   * @param open  车门开度 0..1
   * @param cab   司机台状态 {notch, lamps}（只影响驾驶室那几件可动/可亮的东西）
   */
  draw(sHead, open, cab) {
    const p = this.line.profile, al = this.line.al, r = this.r;
    /* 司机室补偿矩阵（第 111 条补记）：cab 视角下相机带着骑行运动，而台面/TCMS/
       圆表/手柄/雨刮/门玻璃必须与视线刚性绑定 —— 它们绘制时预乘
       S = V(抖)⁻¹·V(不抖)（App.camera 算好经 cab.fix 传入，非 cab 视角为 null）。 */
    const FIX = (cab && cab.fix) || null;
    const cars = this.carPositions(sHead);
    this.cars = cars;
    /* 中段车实例化（与 AI 车共用 _drawMidInstanced）：头尾车和驾驶室视角的 0 号车
       留在逐节循环里 —— 0 号车带司机室补偿（FIX）与 skipBody，换不起；中间车从
       循环里摘出来，循环结束按阶段一次提交。玩家路径与 AI 路径的差异由参数带过去：
       开门时车门玻璃 emi:1（doorEmi）、提示灯 closing 读 cab.doorsOpen、
       乘客 load 读 cab.fill 且 seed 固定 0。没有 drawInstanced（回退）或编组
       ≤ 2 节时一切照旧。 */
    const doorSideAll = this.line ? SH.boardSideAt(this.line, sHead) : 1;
    const lampKAll = SH.train.doorLampK(open, cab && cab.doorsOpen === false, this.now || 0);
    const useInst = !!(r.drawInstanced && this.midCarB && cars.length > 2);
    const midIdx = [], midMs = [];
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci];
      const fr = al.frame(c.s);
      // 局部 +z 朝列车前方；车 0 朝前，其余车头朝向相同（整列同向）
      const M = m4basis([fr.r[0], fr.r[1], fr.r[2]], [fr.u[0], fr.u[1], fr.u[2]], [fr.f[0], fr.f[1], fr.f[2]], fr.p);
      const flip = 0;
      const list = this.bodyB[ci], gl = this.glassB[ci], dr = this.doorAB[ci];
      if (useInst && ci > 0 && ci < cars.length - 1) {
        midIdx.push(ci); midMs.push(M);
        this['M' + ci] = M;
        continue;
      }
      // 驾驶室视角下车体是"从内向外看"，而车体网格是单面的，
      // 背面被剔除后会直接看见自己的前照灯和车内穿帮。跳过 0 号车车体。
      const skipBody = this.r.cabView && ci === 0;
      if (!skipBody) {
        // 车体 → 客室 → 车内乘客 → 门页 → 车窗（见 _drawCar 的注释：顺序决定成败）
        for (const b of list) r.draw(b, M);
        for (const b of this.innerB[ci]) r.draw(b, M);
        {
          /* 乘客档位逐节车厢给（C5）：paxLevels 的均值 = 整车档位（判据钉住），
             seed 取玩家车（0），同一列车永远同一分布。 */
          const lv = SH.train.paxLevels(cab && cab.fill, cars.length, 0)[ci];
          for (let k = 0; k < lv; k++) for (const b of (this.paxB[ci][k] || [])) r.draw(b, M);
        }
        const doorSide = this.line ? SH.boardSideAt(this.line, sHead) : 1;
        if (open > 0.001) {
          const off = open * SH.train.doorSlide(this.profile);
          const Ma = m4mul(M, m4trs([0, 0, -off], [1, 1, 1]));
          const Mb = m4mul(M, m4trs([0, 0, off], [1, 1, 1]));
          const MLA = doorSide < 0 ? Ma : M, MLB = doorSide < 0 ? Mb : M;
          const MRA = doorSide > 0 ? Ma : M, MRB = doorSide > 0 ? Mb : M;
          for (const b of this.doorALB[ci]) r.draw(b, MLA, { emi: b.mat === 'window' ? 1 : undefined });
          for (const b of this.doorBLB[ci]) r.draw(b, MLB, { emi: b.mat === 'window' ? 1 : undefined });
          for (const b of this.doorARB[ci]) r.draw(b, MRA, { emi: b.mat === 'window' ? 1 : undefined });
          for (const b of this.doorBRB[ci]) r.draw(b, MRB, { emi: b.mat === 'window' ? 1 : undefined });
        } else {
          for (const b of this.doorALB[ci]) r.draw(b, M);
          for (const b of this.doorBLB[ci]) r.draw(b, M);
          for (const b of this.doorARB[ci]) r.draw(b, M);
          for (const b of this.doorBRB[ci]) r.draw(b, M);
        }
        for (const b of gl) r.draw(b, M);
        /* 车门提示灯（B3）：与 AI 车同一条 doorLampK 时间轴，仅开门侧点亮 */
        const lamps = doorSide < 0 ? this.doorLampLB[ci] : this.doorLampRB[ci];
        if (lamps) {
          const lampK = SH.train.doorLampK(open, cab && cab.doorsOpen === false, this.now || 0);
          for (const b of lamps) r.draw(b, M, { emi: lampK });
        }
      } else {
        // 驾驶室视角：0 号车的门窗仍然要画（门开着能从司机位看到门外的站台边）
        const M0f = FIX ? m4mul(FIX, M) : M;   // 门窗也是车体的一部分：与台面同一份补偿
        const doorSide = this.line ? SH.boardSideAt(this.line, sHead) : 1;
        if (open > 0.001) {
          const off = open * SH.train.doorSlide(this.profile);
          const Ma = m4mul(M0f, m4trs([0, 0, -off], [1, 1, 1]));
          const Mb = m4mul(M0f, m4trs([0, 0, off], [1, 1, 1]));
          const MLA = doorSide < 0 ? Ma : M0f, MLB = doorSide < 0 ? Mb : M0f;
          const MRA = doorSide > 0 ? Ma : M0f, MRB = doorSide > 0 ? Mb : M0f;
          for (const b of this.doorALB[ci]) r.draw(b, MLA);
          for (const b of this.doorBLB[ci]) r.draw(b, MLB);
          for (const b of this.doorARB[ci]) r.draw(b, MRA);
          for (const b of this.doorBRB[ci]) r.draw(b, MRB);
        } else {
          for (const b of this.doorALB[ci]) r.draw(b, M0f);
          for (const b of this.doorBLB[ci]) r.draw(b, M0f);
          for (const b of this.doorARB[ci]) r.draw(b, M0f);
          for (const b of this.doorBRB[ci]) r.draw(b, M0f);
        }
        for (const b of gl) r.draw(b, M0f);
      }
      this['M' + ci] = M;
    }
    /* 摘出来的中段车一次提交。放在头尾车之后画 —— 与 AI 车同一种叠序变化
       （先全部不透明再全部玻璃，见 _drawTrainInstanced 的注释），改过必须重新看图。 */
    if (midIdx.length) {
      this._drawMidInstanced(midIdx, midMs, open, (cab && cab.fill) || 0, lampKAll, 0, doorSideAll, true);
    }
    // 司机室内饰只画 0 号车
    const MB = FIX ? m4mul(FIX, this.M0) : this.M0;   // 内饰/手柄/雨刮/指示灯/头灯共用同一份补偿
    if (this.cabB.length) { for (const b of this.cabB) r.draw(b, MB); }
    /* 两只手柄按级位转：主控走牵引侧（推向前）、制动手柄走制动侧（拉向司机）。
       以前手柄被烘焙进 cab 批次里，一次成型 —— HUD 那只电子手柄随级位动，
       第一视角看出去的 3D 手柄永远钉在中间，而司机的手就搭在上面。 */
    if (this.levB && this.levB.length) {
      const nz = (cab && cab.notch) || 0;
      for (const o of this.levB) {
        const ML = m4mul(MB, m4trs(o.pivot, [1, 1, 1], 0, SH.leverAngle(o.which, nz), 0));
        for (const b of o.b) r.draw(b, ML);          // 一批手柄 = 一组分片批次，逐个画
      }
    }
    /* 雨刮（第 106 条）：cab.wiper 是当前扫掠角（0 = 收在玻璃下沿）。
       绕局部 z 轴在玻璃平面里摆动，两侧取 −side·θ 保证刷尖**同向**升起
       （平行雨刮）。静止位 0：θ=0 就是收着 —— 不下雨时雨刮必须收着。 */
    if (this.wiperB && this.wiperB.length) {
      const wA = (cab && cab.wiper) || 0;
      for (const o of this.wiperB) {
        const MW = m4mul(MB, m4trs(o.pivot, [1, 1, 1], 0, 0, -o.side * wA));
        for (const b of o.b) r.draw(b, MW);
      }
    }
    /* 指示灯按系统状态给亮度：`r.draw(b, M, {emi})` 这条按批次覆盖的通道
       本来就存在（车灯体积光在用），所以几何仍是一次烘焙，动的只是 uniform。 */
    if (this.lampB && this.lampB.length) {
      const on = (cab && cab.lamps) || {};
      for (const o of this.lampB) {
        const k = on[o.key] ? SH.train.LAMP_ON : SH.train.LAMP_OFF;
        for (const b of o.b) r.draw(b, MB, { emi: k });
      }
    }
    // 车头灯体积光：只在地下/夜里画，白天高架会被天空洗成一片白
    if (this.beamB && this.beamB.length && r.beamOn) {
      const k = r.beamOn;
      for (const b of this.beamB) r.draw(b, MB, { alpha: 0.13 * k, emi: 1 });
    }
    this.carFrames = cars.map(c => al.frame(c.s));
  }
}
SH.train.view = {
  /** 全列车门的里程位置（世界 s） */
  DoorZs(sHead, p) {
    const zs = [];
    let cur = sHead;
    for (let car = 0; car < p.cars; car++) {
      const len = (car === 0 || car === p.cars - 1) ? p.headLen : p.midLen;
      const cz = cur - len / 2;
      const n = p.doors, pitch = p.doorPitch, span = (n - 1) * pitch;
      const base = car === 0 ? cz + len / 2 - 2.2 - p.headLen * 0 : cz;
      for (let k = 0; k < n; k++) {
        const off = (car === 0) ? (-len / 2 + 3.4 + k * pitch) : (k - (n - 1) / 2) * pitch;
        zs.push(cz + off);
      }
      cur -= len + CAR_GAP;
    }
    return zs;
  },
};

/* ================================================================== 会话 */
const MODES = {
  manual: { name: '人工驾驶', desc: '牵引、惰行、分级制动、车门全部手动' },
  semi: { name: '半自动', desc: 'ATO 区间运行，距停车标 60 m 交回司机手动停车' },
  auto: { name: '全自动', desc: 'ATO 完成牵引巡航停车与开关门（对标 ±0.3 m 设计指标）' },
};

class Session {
  constructor(app) { this.app = app; this.tr = new SH.physics.Train({ perf: null, stock: null, maxKmh: 80 }); }
  start(line, mode, i0, legs) {
    /* 站序与段数必须自夹：磁浮只有 2 站，传 startIdx=2 会让
       stationS[2] = undefined、legs = -1，列车里程变成 NaN，
       整局永远停在 running（实测跑 890 s 一步没动）。
       App.begin() 里也夹过一次，但 Session 是公共入口，不能依赖调用方。 */
    const nSt = line.stations.length;
    this.line = line; this.mode = mode;
    this.i0 = Math.max(0, Math.min(nSt - 2, i0 | 0));
    this.legs = Math.max(1, Math.min(legs | 0, nSt - 1 - this.i0));
    this.leg = 0; this.tr.setSpec({ perf: line.perf, stock: line.stock, maxKmh: line.maxKmh });
    this.tr.reset(); this.tr.notch = -3;
    /* 客流状态机：定员/超员线来自车型，时段决定发送量。
       起点站先放一批人上车，这样第一段就有真实的载荷，
       而不是一列永远空跑的火车。 */
    this.hour = this.app.hour == null ? 8 : this.app.hour;
    this.pax = new SH.pax.Flow(line, line.stock, this.hour, this.app.rain);   // 雨天客流联动（D4）
    this.pax.primeTo(this.i0);
    this.tr.load = this.pax.loadFactor();
    this.s = line.al.stationS[this.i0] + SH.STOP_MARK;   // 出生位 = 停车标（与屏蔽门对齐）
    this.tr.s = this.s;
    this.phase = 'ready'; this.doors = false; this.dwell = 0; this.open = 0;
    this.results = []; this.comfort = 0; this.over = 0; this.judge = null;
    /* 下车人流过程（第 112 条）：开门时登记一条、**独立于车门**推进 ——
       门关之后人还在站台上往出入口走，不是瞬间撤下。见 _startEgress。 */
    this.egress = [];
    this.spad = 0; this._spadSeen = 0;   // 冒进信号：全程累计 + 已计入结算单的部分
    /* 图定时刻表：由线形与车辆性能反推（`SH.timetable`，与配车数同一个逐段模型）。
       以"本站发车 t=0"为基准，所以起点那 30 s 停站不计入 —— 否则司机会发现自己
       永远早点 30 秒，而这个数什么都不测量。 */
    this.sched = SH.timetable(line);
    this.sched0 = this.sched[this.i0] - SH.SCHED_DWELL;
    this.late = 0;
    this.atp = 0; this.handed = false; this.t = 0; this.tLeg = 0;   // tLeg：本段运行时长，平稳分按它归一
    this._prepare();
    this.app.pa.welcome(line);
    return this;
  }
  get targetS() { return this.depot ? this.depot.mark : this.line.al.stationS[this.i0 + this.leg + 1] + SH.STOP_MARK; }
  /** 每一段运行开始前的复位 */
  _prepare() {
    this._approached = false; this._arrived = false; this._committed = false;
    this._failT = 0; this._atpShown = false; this._repo = 0;
    this._autoDoor = 0; this._earlyShown = 0; this._departReq = false;
    this.tr.s = this.s;
    this.app.ato.reset(this.mode);
    this.app.syncLever();
    this.app.bakeAhead();
  }
  get fromName() { return this.line.stations[this.i0 + this.leg]; }
  get toName() { return this.depot ? '停车基地' : this.line.stations[this.i0 + this.leg + 1]; }
  get d() { return this.targetS - this.s; }
  get limit() { return this.line.limitAt(this.s, this.mode); }
  get grade() { return this.line.al.at(this.s).grade * 1000; }
  get curveK() { return this.line.al.at(this.s).k; }
  canManual() { return this.mode === 'manual' || (this.mode === 'semi' && this.handed); }
  setNotch(v) {
    if (!this.canManual()) { this.app.toast(this.mode === 'auto' ? '全自动模式由 ATO 接管' : '尚未交回人工'); return false; }
    if (this.doors && v > 0) { this.app.toast('车门开启，牵引封锁'); return false; }
    const ok = this.tr.setNotch(v);
    if (ok) { this.app.audio.click(); this.app.syncLever(); }
    return ok;
  }
  depart() {
    /* 丝滑发车（玩家第 111-3 条）：门开着也能按发车 —— 请求排队，最小乘降
       时间一到自动关门，门关严直接转 running，不再有"关门→ready→再按一次
       发车"的两段顿挫。停车（phase ready/stopped）照旧一次按键发车。 */
    if (this.phase === 'doorOpen') {
      if (this._departReq) return;
      this._departReq = true;
      this.app.toast(this.dwell < 2.4 ? '已排队发车 · 乘客上下车后自动关门' : '关门后将立即发车');
      if (this.dwell >= 2.4) this.closeDoors();
      return;
    }
    if (this.phase !== 'ready' || this.doors || this.tr.kmh > 0.5) return;
    this._departReq = false;
    this.phase = 'running'; this.handed = this.mode === 'manual';
    this.app.pa.departing(this.toName, this.line);
    this.app.toast(this.canManual() ? '发车确认，请给出牵引' : 'ATO 发车');
    this.app.bakeAhead();
  }
  emergency() { this.tr.setNotch(-9); this.tr.eb = true; this.handed = true; this.app.audio.alarm(); this.app.toast('紧急制动 EB 已施加'); this.app.syncLever(); }
  releaseEB() { if (this.tr.releaseEB()) { this.app.syncLever(); this.app.toast('EB 已缓解，手柄回到 B3'); } else this.app.toast('列车未停稳，无法缓解 EB'); }
  openDoors() {
    if (this.doors || this.tr.kmh > 0.5) { if (this.tr.kmh > 0.5) this.app.toast('列车未停稳，禁止开门'); return; }
    if (this.phase !== 'stopped') { this.app.toast('请先停靠在停车标附近'); return; }
    const e = Math.abs(this.s - this.targetS);
    /* 用户第 7 项的后半段："玩家过站就过站了，不用管"。
       以前 e > 5.5 直接 return —— 那是把"没停准"升级成"停不了"，一次失误被
       罚两次（停车分已经扣过了）。现在只提示不拦，代价由停车分承担。 */
    if (e > 5.5) this.app.toast('车门与屏蔽门错位 ' + e.toFixed(1) + ' m · 已开门，注意对位');
    this.doors = true; this.phase = 'doorOpen'; this.dwell = 0;
    if (this.pax) this.pax.beginStation(this.i0 + this.leg + 1, this.toName);
    this._startEgress();
    this.tr.doors = true; this.tr.setNotch(0);
    this.app.audio.doorOpen();
    this.app.pa.doorOpen(this.line);
    if (!this._committed) { this._commit(); this._committed = true; }
  }
  /**
   * 登记一条下车人流过程（第 112 条）。
   *
   * 为什么需要它：下车人流原先只挂在"门开着"这个条件上（`s.doors`），
   * 门一关 `alight` 就变 null，站台上正在往出入口走的那几十个人**瞬间消失**。
   * 真实的站台不是这样：列车开走了，下车的人还在往楼梯口走。
   *
   * 所以把这件事从"门的开闭"里拿出来，做成一条独立推进的过程：
   *   ① 开门那一刻把视觉层要的全部模型量**定死**（need/rate/dwellNeed/wait0）——
   *      关门之后 `pax` 的逐站状态会翻页（`closeStation` 把候乘清零），
   *      再读就拿到下一站的值了；
   *   ② `update` 里按真实时间推进，与门无关；
   *   ③ 走完（或列车把它甩出可视范围）才结束 —— 见 `_egressDone`。
   * 一个站只留一条：司机重复按开门不重复登记。
   */
  _startEgress() {
    if (!this.pax) return;
    const at = this.i0 + this.leg + 1, name = this.toName;
    const v = this.pax.visual(at, name);
    /* 一个（站 × 侧）只留一条：司机重复按开门不重复登记。
       对向车的下车过程（opp=true）与本侧的互不顶替 —— 同一站可能两边同时在下车。 */
    const old = this.egress.findIndex(e => e.at === at && !e.opp);
    if (old >= 0) this.egress.splice(old, 1);
    this.egress.push({ at, name, need: v.need, rate: v.rate, dwellNeed: v.dwellNeed, wait0: v.wait0, t: 0 });
  }
  /** 一条下车人流过程是否结束：① 该站已离玩家太远（画面里读不出来）；
   *  ② 时长超过"最后一个人走到出入口"的上界（`SH.egressSec`，与视觉层同源）。 */
  _egressDone(e) {
    const ss = this.line.al.stationS[e.at];
    if (ss != null && Math.abs(this.s - ss) > SH.EGRESS_KEEP) return true;
    return e.t > SH.egressSec(e.need, e.rate);
  }
  /** 本站乘降还需要多少秒（下客 + 上客按门的通过能力折算） */
  dwellNeed() {
    /* 一份公式：停站时长由客流模型给（`Flow.dwellNeed`），开局预跑走的也是它。
       以前这里自己按拥挤度折算了一遍 —— 两处公式各改各的，就会出现
       "预跑时停 12 s、玩家接手后说该停 30 s" 这种对不上的断面。 */
    if (!this.pax) return 6;
    return this.pax.dwellNeed(this.i0 + this.leg + 1, this.toName);
  }
  closeDoors() {
    if (!this.doors) return;
    if (this.dwell < 2.4) { this.app.toast('乘客上下车未完成'); return; }
    if (this.pax) {
      const left = this.pax.stranded(this.i0 + this.leg + 1, this.toName);
      if (left > 24) this.app.toast('仍有 ' + left + ' 人未上车，关门抢客');
      this.pax.endStation();
      this._settlePax();
    }
    this.doors = false; this.tr.doors = false; this.phase = 'doorClosing';
    this.app.audio.doorClose(); this.app.pa.doorClose(this.line);
  }
  _commit() {
    const j = this._judge();
    this._jP = j.p;
    /* 平稳分按**每段时长归一**（参考 100 s，短段不加分）。
       comfort 是逐秒累计的，不归一的话"同一种开法"在 110 s 的市区段得 94、
       在 250 s 的磁浮段直接触底 38 —— 磁浮那两条红字就是这么来的，
       问题在指标不在车。长段被惩罚的不是"开得糙"，而是"段长"。 */
    const cn = 100 / Math.max(100, this.tLeg);
    const smooth = C(100 - (this.comfort * 1.9 + this.over * 2.4) * cn, 38, 100);
    /* 三个轴：停车 0.55 / 平稳 0.15 / 客运 0.30。
       南京版只有前两个；把"乘降组织"算进总分，才是开一趟车的完整职责。
       注意时序：_commit 是在**刚开门**时调用的，此刻乘降还没发生，
       所以客运分只能先占位，由 closeDoors() 在关门后回填重算。 */
    const idx = this.i0 + this.leg + 1;
    const px = this.pax ? this.pax.log[this.pax.log.length - 1] : null;
    const rec = { station: this.toName, err: this.s - this.targetS, grade: j.grade, title: j.title, color: j.color, smooth, pax: 100, paxRec: px || null, off: 0, on: 0, want: px ? px.wantOff + px.wantOn : 0, load: this.pax ? this.pax.pct() : 0, dwell: 0 };
    /* 冒进信号按"这一段里发生了几次"记在本段的单子上，扣分而不是掉权重：
       铁路口径里这是**事故**，不是"开得糙一点"，所以直接从总分里减、不并进三轴。 */
    rec.jP = j.p;    // 停车分原值：判据要能验"冒进信号的 −25 真的扣在这条单子上"
    rec.spad = this.spad - (this._spadSeen || 0);
    this._spadSeen = this.spad;
    /* 图定兑现：到站时刻与反推的运行图比，早点晚点都记（口径见 SH.timetable）。 */
    rec.late = this.late = this.t - (this.sched[idx] - this.sched0);
    rec.score = Math.max(0, Math.round(j.p * 0.55 + smooth * 0.15 + 100 * 0.30)
      - rec.spad * 25 - SH.latePenalty(rec.late));
    this.results.push(rec);
  }
  /** 关门后回填客运分并重算该站总分 */
  _settlePax() {
    const rec = this.results[this.results.length - 1];
    if (!rec || !rec.paxRec || !this.pax) return;
    const pr = rec.paxRec;
    rec.pax = Math.round(C(100 * (pr.service == null ? 1 : pr.service), 0, 100));
    rec.off = pr.off; rec.on = pr.on;
    rec.load = this.pax.pct(); rec.dwell = Math.round(this.dwell * 10) / 10;
    rec.score = Math.max(0, Math.round((this._jP || 100) * 0.55 + rec.smooth * 0.15 + rec.pax * 0.30)
      - (rec.spad || 0) * 25 - SH.latePenalty(rec.late || 0));
    delete rec.paxRec;
  }
  _judge() { const e = this.s - this.targetS; const j = SH.physics.judge(e); this.judge = Object.assign({ err: e }, j); return this.judge; }
  _advance() {
    if (this.leg + 1 >= this.legs) {
      /* 用户第 8 项：终到站正好是线路端头时不立刻结算 —— 真实司机跑完最后一趟
         是"入库"。中途终到（没跑到端头）没有基地可入，直接结算。 */
      const dz = this.depot ? null : this.line.depotAt(this.i0 + this.leg + 1);
      if (!dz) { this.finish(); return; }
      this.depot = dz;
      this.app.toast('终到 · 请驶入停车基地');
    }
    this.leg++;
    // 段落切换**不回吸位置**：停车标在站台端（SH.STOP_MARK）之后，列车停下时
    // 物理位置就是"上一站停车标"——正常路径保持不动（就是 s+39），越标路径
    // 保持越标后的真实位置（此前这行把车吸回站台中心：停车标挪位后成 39 m
    // 的发车闪现，玩家实测抓到；越标时也一直存在一次向后的瞬移）。
    // targetS 的语义自动接管：leg 自增后它就是"下下站停车标"。
    this.phase = 'ready'; this.comfort = 0; this.over = 0; this.handed = false;
    this.tLeg = 0;
    this.tr.reset(); this.tr.notch = -3; this.tr.s = this.s;
    if (this.pax) {
      this.pax.closeStation(this.i0 + this.leg, this.line.stations[this.i0 + this.leg]);
      this.tr.load = this.pax.loadFactor();
    }
    /* 丝滑发车：关门前排过队的发车请求在这里兑现 —— _prepare 会复位
       逐段状态（含 _departReq），所以先取值再复位，_advance 一落地就
       直接转 running，玩家从"按发车"到列车动起来中间没有第二段等待。 */
    const dq = this._departReq;
    this._prepare();
    this.app.toast(this.mode === 'manual' ? '下一站准备完成，请发车确认' : 'ATO 已就绪');
    if (dq) this.depart();
  }
  /** 入库：把车停在基地停车标上即结束本次运行并结算（用户第 8 项）。
   *  偏差直接进结算，不再另起一套分数 —— 入库本来就是"这一趟的最后一次停车"。 */
  parkDepot(err) {
    this.depotErr = err;
    this.depotOk = Math.abs(err) <= 2;
    this.app.toast(Math.abs(err) <= 2 ? '入库到位 · 本次运行结束' : '已入库（对位偏差 ' + err.toFixed(1) + ' m）');
    this.finish();
  }
  finish() { this.phase = 'finished'; this.app.finishRun(this.summary()); }
  summary() {
    const n = this.results.length;
    const total = n ? Math.round(this.results.reduce((a, b) => a + b.score, 0) / n) : 0;
    const g = total >= 97 ? 'SSS' : total >= 93 ? 'SS' : total >= 87 ? 'S' : total >= 78 ? 'A' : total >= 66 ? 'B' : total >= 52 ? 'C' : 'D';
    const pax = this.pax;
    return { line: this.line, mode: this.mode, results: this.results, total, grade: g,
      /* 入库结果：终到站是线路端头才有。没入库（中途终到/直接退出）为 null。 */
      depot: this.depot ? { end: this.line.stations[this.depot.end], err: this.depotErr || 0,
        ok: !!this.depotOk } : null,
      pax: pax ? { boarded: pax.boarded, alighted: pax.alighted, leftBehind: pax.leftBehind,
        onboard: pax.onboard, pct: pax.pct(), aw2: pax.cap.aw2, hour: this.hour } : null };
  }
  update(dt) {
    this.t += dt; this.tLeg += dt;
    /* 下车人流过程与车门**解耦**：关门之后继续推进（人还在往出入口走），
       走完 / 列车把它甩远才结束。放在最前面 —— 它与本帧处于哪个 phase 无关。 */
    if (this.egress.length) {
      for (const e of this.egress) e.t += dt;
      this.egress = this.egress.filter(e => !this._egressDone(e));
    }
    /* 客流闭环补员（第 117 条）：非停站期间站台候乘人数按图定间隔与发送量持续补充 */
    if (this.pax && this.pax.waiting) {
      this._paxReplenishT = (this._paxReplenishT || 0) + dt;
      if (this._paxReplenishT >= 1.0) {
        const dtRep = this._paxReplenishT;
        this._paxReplenishT = 0;
        const hwSec = (this.app && this.app.traffic ? this.app.traffic.headwayMin : 4) * 60;
        for (const [stName, count] of this.pax.waiting) {
          const sIdx = this.line.stations.indexOf(stName);
          if (sIdx < 0) continue;
          const d = SH.pax.demand(this.line.id, stName, sIdx, this.line.stations.length, this.hour, this.rain);
          if (count < d.board) {
            const add = d.board * dtRep / Math.max(60, hwSec);
            this.pax.waiting.set(stName, Math.min(d.board, count + add));
          }
        }
      }
    }
    /* 入库判定：停进基地的停车标就结束本次运行并结算；
       越过库尾（挤到车挡）也结束，但记的是越标偏差。 */
    if (this.depot && this.phase === 'running') {
      if (this.tr.kmh < 0.5 && Math.abs(this.s - this.depot.mark) < 3) { this.parkDepot(this.s - this.depot.mark); return; }
      if (this.s > this.depot.to - 3) { this.parkDepot(this.s - this.depot.mark); return; }
    }
    if (this.tr.kmh > 3) this.moved = true;
    /* 车门开闭动画 */
    const tgt = this.doors ? 1 : 0;
    this.open += (tgt - this.open) * (1 - Math.exp(-dt / (tgt > this.open ? 0.62 : 0.50)));
    /* 低速对位：停稳后按住前进/退行，以 0.55 m/s 挪车 */
    if (this._repo && this.phase === 'stopped' && !this.doors) {
      this.s += this._repo * 0.55 * dt;
      this.tr.s = this.s; this.tr.v = 0.055; this.tr.kmhCache = 0.2;
      return;
    }
    if (this.phase === 'doorOpen') {
      this.dwell += dt;
      /* 乘降是按"每秒多少人是物理事实"推进的，不是一段动画。
         下客优先、上客受门的通过能力与车厢拥挤度限制。 */
      if (this.pax) {
        const r = this.pax.flow(this.i0 + this.leg + 1, this.toName, dt);
        const cur = this.pax.log[this.pax.log.length - 1];
        if (cur) { cur.off += r.off; cur.on += r.on; cur.dwell = this.dwell; }
      }
      if (this.tr) this.tr.load = this.pax ? this.pax.loadFactor() : 1.0;
      /* 丝滑发车：门开时排过队的发车请求，最小乘降时间一到自动关门
         （关门完成由 _advance → depart 直接连上牵引，免二次确认）。 */
      if (this._departReq && this.dwell >= 2.4) this.closeDoors();
      if (this.mode === 'auto' && this.dwell > this.dwellNeed() + 1.2) this.closeDoors();
      return;
    }
    if (this.phase === 'doorClosing') { if (this.open < 0.04) this._advance(); return; }
    if (this.phase === 'ready') { if (this.mode !== 'manual' && this.t > 1.4) this.depart(); return; }
    if (this.phase === 'stopped') {
      // 全自动：到点自己开门，用帧计时而不是 setTimeout（后者在切后台/快进时不可靠）
      if (this.mode === 'auto' && this._autoDoor > 0) {
        this._autoDoor -= dt;
        if (this._autoDoor <= 0 && Math.abs(this.d) < 5.5) { this._autoDoor = 0; this.openDoors(); }
      }
      // 停稳后仍允许司机重新给牵引继续对位（提前停车或越标后退行）
      if (this.tr.notch > 0 && this.canManual()) { this.phase = 'running'; if (Math.abs(this.d) > 11) this._arrived = false; }
    }
    if (this.phase !== 'running') return;

    const d = this.d;
    if (!this._approached && d < 700) { this._approached = true; this.app.pa.approaching(this.toName, this.line, SH.boardSideAt(this.line, this.line.al.stationS[this.i0 + this.leg + 1]), SH.INTER[this.toName]); }
    /* 到站真实音频在**到站前 250 m** 就播（玩家指示）：真实地铁进站前就把
       「X 到了，开 X 边门」播出来，停稳再播就晚了。置 _arrived 标记：
       停稳/越标判定不再重复触发 arriving。 */
    if (!this._arrived && d < 250) { this._arrived = true; this.app.pa.arriving(this.toName, SH.boardSideAt(this.line, this.line.al.stationS[this.i0 + this.leg + 1]), this.line); }
    if (this.mode === 'semi' && !this.handed && d < 60) { this.handed = true; this.tr.setNotch(0); this.app.syncLever(); this.app.hint('人工接管<br><small>距停车标 60 m，请手动停车</small>', 3000); }

    const env = { limitKmh: this.limit, grade: this.grade, curveK: this.curveK, doorsOpen: this.doors,
      /* 雨天（D4）：湿轨把 Weber 黏着从 0.28 压到 0.19 —— 同一挡位的牵引被
         削、制动距离变长、大牵引容易空转。物理侧这条参数一直都在，
         缺的是"天气"这个入口（README 99 那句骗人的文案已经删了，现在补真的）。
         黏着是全线的：隧道里的钢轨同样是湿的，所以这个标志不随 openness 变。 */
      wet: !!(this.app.settings && this.app.settings.rain) || !!this.app.rain,
      /* 用可选读取而不是直接 `this.app.settings.atp`：离线自测（test-drive.js）
         构造的是最小 app 桩，没有 settings 字段，写成前者会让整个测试直接抛错。 */
      atpOn: !!(this.app.settings && this.app.settings.atp) };
    /* 行车凭证：自动/半自动的停车目标取「站停标 / 前车车尾 − 防护 / 红灯信号机外方」
       三者最近的那个。第三项必须是**分区入口**而不是"车尾 − guard"：固定闭塞里司机的
       凭证就是那架信号机，越过红灯进入占用分区 = 冒进信号（行车事故里最严重的一类）。
       手动模式不代劳 —— 与"ATP 默认关、超速只警告"是同一条设计决定，但会被记录。 */
    const disp = this.app.traffic;
    const live = disp && disp.trains && disp.trains.length;
    const sigStop = live && this.mode !== 'manual' ? disp.signalAhead(this.s, 'player') : null;
    const dSig = sigStop && sigStop.aspect.key === 'stop' ? Math.max(0, sigStop.dist - 5) : Infinity;
    const occ = this.mode === 'manual' ? null : (live ? disp.aheadOfPlayer() : null);
    const dStop = Math.min(d, occ ? Math.max(0, occ.dist - disp.guard) : Infinity, dSig);
    const n = this.app.ato.notch(dt, { distanceToStop: dStop, speedKmh: this.tr.kmh, limitKmh: this.limit, grade: this.grade, curveK: this.curveK, curveLimit: this.limit, predictStop: this.tr.predictStop(this.grade), perf: this.tr.spec.perf, load: this.tr.load });
    if (n !== null && !this.tr.eb) this.tr.setNotch(n);

    const prevAir = this.tr.air;
    const ds = this.tr.update(dt, env);
    this.tr.airBuild = (this.tr.air - prevAir) / dt;
    /* 冒进信号检测：越过一道**显示为红灯**的分区入口边界。显示用 `self='player'`
       算，玩家自己不算占用者 —— 否则越过去之后再问，那一格永远被自己占着，
       任何一次进格都会被判成冒进。三种模式都记：自动模式真冒进了就是我的实现有 bug，
       不该被藏起来。 */
    this.s += ds;
    if (live && ds > 0) {
      const B = disp.blocks;
      for (let i = 0; i < B.length; i++) {
        if (B[i][0] <= this.s - ds || B[i][0] > this.s) continue;
        const a = disp.aspectAt(i, 'player');
        if (a.key === 'stop') {
          this.spad++; this.spadAt = B[i][0];
          /* 可选调用：离线判据（test-drive.js）构造的是最小 app 桩，没有 hint。 */
          if (this.app.hint) this.app.hint('冒进信号！越过 ' + (B[i][0] / 1000).toFixed(2) + ' km 处红灯<small>占用分区入口 · 行车事故</small>', 5000);
        }
        break;
      }
    }

    /* 平稳惩罚。第一项以前写成 |jerk| − 0.85，而限幅器天花板是 0.75/1.05 ——
       牵引侧永远够不着阈值，这一项等于不存在（自我一致的空指标：分数照给 100，
       但它没有测量任何东西）。有了硬限幅，|jerk| 永远不超过上限，
       真正能区分"开得细"和"开得糙"的是**它有多少时间顶在天花板上**。 */
    const jCap = this.tr.jerk > 0 ? SH.JERK.up : SH.JERK.dn;
    this.comfort += (Math.abs(this.tr.jerk) > jCap * 0.9 ? dt * 2.6 : 0)
                  + Math.max(0, Math.abs(this.tr.a) - 1.05) * dt * 3.4;
    if (this.tr.kmh > this.limit + 1) this.over += dt;
    /* 超速提示。ATP 关闭时**不干预、只警告**，而且文案必须说清楚是哪一种：
       原来无论 ATP 开没开都播"ATP 超速防护动作"，玩家会以为被系统刹了。
       现在关着的时候播"超速 +N km/h（限速 M）— 仅警告"，并每 6 秒可重复一次，
       因为一次性提示在持续超速时等于没有提示。 */
    if (this.tr.atp) {
      const atpOn = !!(this.app.settings && this.app.settings.atp);
      if (!this._atpShown && this.t - (this._atpToastT || -99) > 6) {
        this._atpShown = true; this._atpToastT = this.t;
        if (atpOn) this.app.toast('ATP 超速防护动作');
        else this.app.toast('超速 +' + this.tr.over.toFixed(0) + ' km/h（限速 ' + this.tr.limKmh + '）— 仅警告，不干预');
        this.app.audio.alarm();
      }
    } else this._atpShown = false;

    /* 停稳判定。
       注意：这里绝不能给 tr.v 赋值 —— 曾经写过一句"刚发车不判停车就把速度清零"，
       结果每帧把速度压回 0，列车永远起不来（v 上限 = 每帧增量 0.024 m/s）。
       速度归零是物理模型自己的事。 */
    if (this.tr.v < 0.075 && Math.abs(d) < 11) {
      this.phase = 'stopped';
      const impact = Math.min(1, Math.abs(this.tr.a) * 0.9 + Math.abs(this.tr.jerk) * 0.07);
      this.app.audio.stopSettle(0.35 + impact * 0.7);
      const j = this._judge();
      /* _arrived 已在进站前 250 m 置位并播过到站音频 —— 停稳/越标判定不再重复播报。 */
      this.app.showJudge(j);
      this._autoDoor = 0.9;
    } else if (this.tr.v < 0.075 && d >= 11 && d < 60 && this.moved && this.tr.notch <= -1) {
      /* 停在停车标之前：也必须进入 stopped，否则"按住前进/退行"的低速对位
         永远出不来，玩家会以为游戏卡死。 */
      this.phase = 'stopped';
      const j = this._judge();
      this.app.showJudge(j);
      if (!this._earlyShown) { this._earlyShown = 1; this.app.hint('提前停车 ' + d.toFixed(0) + ' m<br><small>按住"前进"低速对位，或重新给牵引</small>', 3000); }
    } else this._earlyShown = 0;

    /* 冲过停车标 11 m 以上：判对位失败，按越标处理 */
    if (d < -11) {
      /* _arrived 已在进站前 250 m 置位并播过到站音频 —— 停稳/越标判定不再重复播报。 */
      if (!this._committed) {
        const j = this._judge();
        this.results.push({ station: this.toName, err: j.err, grade: 'E', title: '对位失败·越标', color: '#ff565f',
          smooth: C(100 - this.comfort * 1.9 * (100 / Math.max(100, this.tLeg)), 38, 100), score: 22 });
        this._committed = true;
        this.app.showJudge(Object.assign({ err: j.err, grade: 'E', title: '对位失败·越标', color: '#ff565f' }));
      }
      if (this.tr.notch > 0 && this.tr.a > 0.02) { this._arrived = false; this._advance(); }
      else if (this.tr.v < 0.05) {
        if (!this._failT) { this._failT = this.t; this.app.toast('停车对位失败，列车越过停车标'); }
        if (this.t - this._failT > 2.6) { this._failT = 0; this._arrived = false; this._advance(); }
      }
    } else this._failT = 0;
  }
}

/* ==================================================================== 应用 */
class App {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.r = new SH.Renderer(this.canvas);
    SH.textures.buildAll(this.r);
    /* 1 号线列车贴图（用户给的 BVE 模型，assets/l1train/*.png）：程序化贴图
       全是同步生成的，这五张是**外部图片**，异步解码 —— 见 Renderer.texFromImage。
       图片没到位之前材质绑的是 1×1 占位色，不会画出别的东西。 */
    for (const [n, f] of [['l1_side', 'l1_side.png'], ['l1_front', 'l1_front.png'], ['l1_roof', 'l1_roof.png'],
      ['l1_bogie', 'l1_bogie.png'], ['l1_wheel', 'l1_wheel.png'], ['l1_ac', 'l1_ac.png']])
      this.r.texFromImage(n, 'assets/l1train/' + f, false);
    this.world = new World(this.r);
    /* 1 号线列车的 **BVE 模型本体**（用户给的模型，README 第 146 条）：
       6 节车的 CSV 拉下来解析 → 注册材质 → 拉贴图 → 重建列车视图。
       全部是异步的，没到位之前列车走程序化车体（不会画出一列空车）。 */
    this.loadL1Model();
    this.audio = new SH.audio.AudioEngine();
    this.pa = new SH.audio.PA(this.audio);
    this.ato = new SH.physics.ATO('manual');
    this.view = 'cab';
    this.yaw = 0; this.pitch = 0;
    this.time = 0; this.paused = false; this.running = false;
    this.district = null;
    this.settings = this.loadSettings();
    this.lines = {};
    for (const k in SH.LINES) {
      try {
        this.lines[k] = new LineRuntime(SH.LINES[k]);
        if (SH.LINES[k].branch) this.lines[k + '#branch'] = new LineRuntime(SH.LINES[k], 'branch');
      } catch (e) { console.warn('line build fail', k, e); }
    }
    /* 首页那句"18 条线路"是写死的，而选线页有 20 张卡（18 条地铁 + 浦江线 + 磁浮）。
       文案自己数一遍，加一条线就不会再撒谎。 */
    const sl = document.getElementById('spec-lines');
    if (sl) sl.textContent = String(Object.keys(SH.LINES).length);
    this.lineId = this.settings.lineId && this.lines[this.settings.lineId] ? this.settings.lineId : 'l2';
    this.line = this.lines[this.lineId];
    this.service = this.settings.service === 'branch' ? 'branch' : 'main';
    this.mode = this.settings.mode || 'manual';
    this.startIdx = this.settings.startIndex || 0;
    this.legs = this.settings.legs || 3;
    /* 时段（0..23）：客流模型的 `hour`。它同时是**调度器 AI 车载**的输入
       （`Dispatcher` 读同一个 `rushFactor`），所以选了"夜间"之后站台上的
       候乘人数、开进来那几列车、以及车窗里的人数是同一件事的三种表现。
       以前这个值写死 8（早高峰）且无处可改 —— 一个既没得选、也看不出
       它在做什么的死配置。 */
    this.hour = this.settings.hour == null ? 13 : (this.settings.hour | 0);
    /* 当日秒数：从所选钟点出发，**随一局运行前进**（1 实秒 = 1 模拟秒）。
       以前只有一个静态的 `hour` 整数，于是"时间是死的"——天光不变、站台屏
       永远停在 00:0x、玩家跑完一趟看不出外面黑没黑。它是天光（envFor）、
       HUD 钟点、站台屏钟点的唯一来源。 */
    this.clock = this.hour * 3600;
    /* 天气（D4）：雨天同时是四件事的输入 —— 天光（envFor 调 SH.envRainy）、
       物理（env.wet → Weber 黏着压低 → 制动距离变长、湿轨易空转）、
       雨声（audio.setRain）、雨刮与雨丝（渲染器的 uRain / 雨刮批次按角度转）。
       默认晴；设置页"天气"一行切换，跨局记住。 */
    this.rain = !!this.settings.rain;
    /* 画质与输出分辨率：这两个值**以前只写不读** —— 选了"流畅"，重启又回到高清，
       设置等于一次性的。现在开机就应用。
       默认一律"全特效 + 1080p 预算"，不按老存档的 quality 反推分辨率：那个字段
       历史上从未生效过，所有玩家一直以来实际跑的都是高清+原生，"迁移保号"反而
       会把刚拆开的两个旋钮重新焊回去。想要原生清晰度的，设置里点一下就有。 */
    const sq = ['low', 'medium', 'high'].indexOf(this.settings.quality) >= 0 ? this.settings.quality : 'high';
    const sr = SH.RES_ORDER.indexOf(this.settings.res) >= 0 ? this.settings.res : 'q1080';
    this.r.setQuality(sq); this.r.setRes(sr);
    /* 自动档：老存档没有这个字段 → 开（默认档可以讲道理：上限仍是玩家选的 sr，
       自动只会在"连 sr 都锁不住"时动手，锁得住时一次都不改）。 */
    this.r.setResAuto(this.settings.resAuto !== false);
    this.resetDrs();
    this.wiperT = 0;          // 雨刮相位：只在雨天推进
    this.trainView = new TrainView(this.r);
    this.sign = new SH.textures.SignAtlas(SH.textures.SignAtlas.bestSize(this.r.maxTexSize()));
    this.world.sign = this.sign;
    this._globalSigns();
    this._makeCab();
    this.trainView.setLine(this.lines[this.lineId], this.sign, this.tcmsRect);
    this.r.texFromCanvas('sign', this.sign.canvas, false);
    this.ui = new UI(this);
    this.bind();
    this.setLine(this.lineId, false);
    this.show('home');
    this.last = performance.now();
    /* Perf 归因开关（149 条）：?perf=1 —— 子系统帧耗时进 HUD 地勤行。 */
    if (typeof location !== 'undefined' && /[?&]perf=1\b/.test(location.search || '')) { PERF.on = true; PERF.window(); }
    requestAnimationFrame(t => this.frame(t));
  }
  /** 当前钟点（0..24，带小数）。天光、HUD 钟点、站台屏钟点都读它 ——
   *  写第二份"现在几点"就是第二个真值（`SH.timetable` 那条教训）。 */
  get hourNow() { return ((this.clock / 3600) % 24 + 24) % 24; }
  /** 钟点的 hh:mm 文本（HUD 与站台屏共用同一份格式化） */
  clockText() {
    const c = ((this.clock % 86400) + 86400) % 86400;
    const hh = Math.floor(c / 3600), mm = Math.floor(c / 60) % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }
  /* ------------------------------------------------ 站台信息屏（下一班倒计时）
   * 真实上海站台那块屏每 2 秒跳一次，��完一班车就进站。它是这个项目里
   * "这条线真的在运行"的唯一**连续**证据 —— 此前 AI 车队在跑，但玩家
   * 从站台上除了看见车，看不出"多久来一班"。
   * 三条实现上的规矩：
   *   1. 内容全部来自 `SH.nextTrain`（traffic.js 的唯一实现），屏与 HUD 同源；
   *   2. 只在"显示内容真的变了"时重传纹理 —— 屏幕尺寸与倒计时粒度决定
   *      每分钟最多 30 次上传，而不是每帧；
   *   3. 画布与 TCMS / 圆表分开：三者任一刷新都不牵连另两个的纹理。 */
  _makePtd() {
    const cv = document.createElement('canvas');
    /* 画布必须是 **2 的幂**（512×256）：texFromCanvas 只给 pow2 纹理生成
       mipmap + 各向异性过滤，站台屏在画面里是缩小的，非 pow2（旧 512×192）
       的缩小采样在细文字上会闪烁/重影（第 111 条补记 111d）。
       绘制坐标仍是 512×192 —— drawPtd 入口统一按比例缩放，布局零改动。 */
    cv.width = 512; cv.height = 256;
    this.ptdCv = cv; this.ptdCtx = cv.getContext('2d'); this.ptdSig = null;
    this.drawPtd(true);
  }
  /** 画屏。`info` 由调用方给（SH.nextTrain 的返回值），不给就画"未接运行图"。 */
  drawPtd(force, info) {
    if (!this.ptdCtx) return;
    const app = this, c = app.ptdCtx, L = app.line;
    /* 签名：只有"会改变屏上文字"的量，且倒计时按**分钟**取整 —— 真实屏也是
       按分钟跳的，逐秒跳反而更像国内某些机场航班屏而不是地铁。 */
    const sig = [L ? L.id : '-', info ? info.line1 : '-', info ? info.line2 : '-', info ? info.state : '-', info ? info.crowd : '-'].join('|');
    if (!force && sig === app.ptdSig) return;
    app.ptdSig = sig;
    /* pow2 画布 + 旧坐标布局：y 向 256/192 缩放（见 _makePtd 的注释） */
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, 512, 256);
    c.scale(1, 256 / 192);
    const W = 512, H = 192, F = SH.textures.CN_FONT;
    c.fillStyle = '#0a0f14'; c.fillRect(0, 0, W, H);
    if (!info) {
      c.fillStyle = '#2a4a5a'; c.font = '700 26px ' + F; c.textAlign = 'center';
      c.fillText('未接运行图', W / 2, H / 2 + 9); c.textAlign = 'left';
      app.r.texFromCanvas('ptd', app.ptdCv, false, false);
      return;
    }
    /* 屏底：真实站台屏是深灰底 + 顶部线路色带 + 分区高亮。
       布局照真实的两行式：上行"往终点站"，下行倒计时（字号大得多，地铁屏就是这样）。 */
    c.fillStyle = L.color; c.fillRect(0, 0, W, 26);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, 0, W, 26);
    c.fillStyle = L.color; c.fillRect(0, 0, 10, 26);
    c.fillStyle = '#e8f2f7'; c.font = '900 19px ' + F;
    c.fillText(L.name, 20, 20);
    c.textAlign = 'right'; c.font = '800 16px ' + F; c.fillStyle = '#9dc0d0';
    c.fillText('NEXT  下一班', W - 14, 20); c.textAlign = 'left';

    c.fillStyle = '#cfe2ec'; c.font = '800 30px ' + F;
    c.fillText(info.line1, 18, 70);
    const stateCol = info.state === 'closed' ? '#ff6b6b' : info.state === 'boarding' ? '#5fe0b0'
      : info.state === 'soon' ? '#ffc451' : '#e8f2f7';
    c.fillStyle = stateCol; c.font = '900 78px ' + F;
    const big = info.state === 'run' || info.state === 'soon' ? String(info.mins) : '';
    c.fillText(big, 16, 152);
    if (big) { const w = c.measureText(big).width; c.font = '800 30px ' + F; c.fillStyle = stateCol; c.fillText('分', 24 + w, 152); }
    c.textAlign = 'right'; c.font = '800 26px ' + F; c.fillStyle = stateCol;
    c.fillText(info.line2, W - 16, 152);
    c.textAlign = 'left';
    /* 底栏：头时与更新时间 —— 真实屏右下角有这两样，调度台看的就是它 */
    c.fillStyle = '#1a2a33'; c.fillRect(0, H - 22, W, 22);
    c.fillStyle = '#6f97a6'; c.font = '700 15px ' + F;
    c.fillText('行车间隔 ' + info.headwayMin + ' 分', 12, H - 7);
    /* 拥挤度：真实站台屏把它放在"下一班"那一行旁边。颜色跟着档位走
       （很拥挤是暖红、有座位是青绿），站台上的人一眼就能决定等不等这一班。 */
    if (info.crowd) {
      const cc = info.load >= 0.95 ? '#ff8a7a' : info.load >= 0.7 ? '#ffc451' : info.load >= 0.4 ? '#9dc0d0' : '#5fe0b0';
      const w0 = c.measureText('行车间隔 ' + info.headwayMin + ' 分').width;
      c.fillStyle = cc; c.fillText('· 下一班 ' + info.crowd, 12 + w0 + 10, H - 7);
    }
    c.textAlign = 'right'; c.fillStyle = '#4f7385';
    c.fillText(app._ptdClock(), W - 12, H - 7); c.textAlign = 'left';
    app.r.texFromCanvas('ptd', app.ptdCv, false, false);
  }
  /** 从调度器时钟推"图定钟点"（首站发车为 0 点），屏上右下角显示。 */
  updatePtd() {
    const disp = this.traffic;
    if (!disp || !disp.trains || !disp.trains.length) { this.drawPtd(false, null); return; }
    /* 只给**玩家所在的那一站**做屏：烘焙窗口通常只含 1~2 站，
       而一块屏贴错站的倒计时比没有屏更糟。 */
    const s = this.running && this.session ? this.session.s : (this.showcase ? this.showcase.s : 0);
    const ns = this.line.nearStation(s);
    const info = SH.nextTrain(disp, this.line, ns.i, { self: null });
    this.ptdInfo = info; this.ptdIdx = ns.i;
    this.drawPtd(false, info);
  }

  /** 站台钟：显示**真实钟点**（当日秒数），与天光、HUD 同源。
   *  以前这里拿调度器的 `clock`（首站发车 = 0 点）当钟点，于是站台屏永远
   *  从 00:00 开始走，而画面是天光——两个"现在几点"互相打脸。 */
  _ptdClock() {
    if (!this.traffic) return '--:--';
    return this.clockText();
  }
  _globalSigns() {
    /* TCMS 屏以前画在站牌图集里（320×200 一格，返回值还要一路传进 TrainView）。
       图集是 4096² 且只在每次烘焙后重传一次，而这块屏要按列车状态刷新 ——
       两者共用一张纹理的话，要么屏永远不变，要么每帧重传 64 MB。
       现在屏有自己的 512×320 画布（pow2，带 mipmap；绘制坐标 480×300 入口缩放）与独立纹理 'cab'，rect 恒为整张贴图。 */
    this.tcmsRect = [0, 0, 1, 1];
  }
  _makeCab() {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 320;
    this.cabCv = cv; this.cabCtx = cv.getContext('2d');
    this.cabSig = null;
    /* 两只机械圆表共用一张画布（左半速度、右半制动缸压力），一次上传。 */
    const gv = document.createElement('canvas');
    gv.width = 512; gv.height = 256;
    this.gaugeCv = gv; this.gaugeCtx = gv.getContext('2d');
    this.gaugeSig = null;
    this.drawCab(true);
    this.drawGauges(true);
    this._makePtd();
    /* 'ptd' 纹理必须**真的传过一次**，否则渲染器走"找不到贴图"的分支：
       mode 掉到 0、基色取顶点色，屏面就是一块死白板。
       与 cab/gauge 同理，靠 `texFromCanvas` 在 make 里先建一次。 */
    this.r.texFromCanvas('ptd', this.ptdCv, false);
  }
  /* 司机台圆表：以前表针是一块焊死在 12 点方向的红塑料片，车速 80 也指着 0。
     驾驶室是玩家盯得最久的一块画面，针不动就等于整块台面变成布景。
     针角走 SH.dialDeg —— 和 HUD 那只电子表同一个映射，两个表不可能各指一边；
     量程走 SH.dialFull（按车辆设计速度上进到整数刻度），磁浮因此是 0~500 而不是 0~100。 */
  drawGauges(force) {
    if (!this.gaugeCtx) return;
    const now = performance.now();
    if (!force && this._lastGaugeTime && now - this._lastGaugeTime < 33) return;
    const app = this, s = app.session, tr = s ? s.tr : null;
    const full = SH.dialFull(app.line ? app.line.maxKmh : 80);
    const v = tr ? tr.kmh : 0, p = tr ? tr.bc : 0;
    /* 取整粒度：0.2 km/h / 2 kPa。按整数取整在 0.15 m 的表盘上针会一跳一跳，
       完全不取整则每帧重传 512 KB —— 肉眼分不出来的那部分才是可省的。 */
    const sig = [Math.round(v * 5), Math.round(p / 2), full].join('|');
    if (!force && sig === app.gaugeSig) return;
    app.gaugeSig = sig;
    const c = app.gaugeCtx, F = SH.textures.CN_FONT;
    const dial = (cx, val, fullK, title, unit, over) => {
      const R = 108, A = f => SH.dialDeg(f) * Math.PI / 180;
      c.fillStyle = '#070c10'; c.fillRect(cx - 128, 0, 256, 256);
      c.beginPath(); c.arc(cx, 128, R + 8, 0, Math.PI * 2);
      c.fillStyle = '#2f383f'; c.fill();                       // 金属表圈
      c.beginPath(); c.arc(cx, 128, R, 0, Math.PI * 2);
      c.fillStyle = '#121a20'; c.fill();                       // 深色表盘（印刷白底在黄昏里会抢过 TCMS 屏）
      const major = fullK / 5, minor = fullK / 10;
      for (let t = 0; t <= fullK + 1e-6; t += minor) {
        const isM = Math.abs(t / major - Math.round(t / major)) < 1e-6, a = A(t / fullK);
        const r0 = R - (isM ? 22 : 12), r1 = R - 4;
        c.strokeStyle = isM ? '#e8f2f6' : '#8fa3ad'; c.lineWidth = isM ? 4 : 2;
        c.beginPath(); c.moveTo(cx + Math.sin(a) * r0, 128 - Math.cos(a) * r0);
        c.lineTo(cx + Math.sin(a) * r1, 128 - Math.cos(a) * r1); c.stroke();
        if (isM) {
          c.fillStyle = '#e8f2f6'; c.font = '900 22px ' + F; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(String(Math.round(t)), cx + Math.sin(a) * (R - 40), 128 - Math.cos(a) * (R - 40));
        }
      }
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      c.fillStyle = over ? '#ff5566' : '#6f97a6'; c.font = '800 17px ' + F;
      c.fillText(title + ' ' + unit, cx, 210);
      const a = A(val / fullK);                               // 红针
      c.strokeStyle = '#c0392b'; c.lineWidth = 5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(cx - Math.sin(a) * 20, 128 + Math.cos(a) * 20);
      c.lineTo(cx + Math.sin(a) * (R - 16), 128 - Math.cos(a) * (R - 16)); c.stroke();
      c.beginPath(); c.arc(cx, 128, 11, 0, Math.PI * 2); c.fillStyle = '#c0392b'; c.fill();
      c.beginPath(); c.arc(cx, 128, 4, 0, Math.PI * 2); c.fillStyle = '#121a20'; c.fill();
    };
    c.clearRect(0, 0, 512, 256);
    dial(128, v, full, '速度', 'km/h', tr && s && tr.kmh > s.limit + 1);
    dial(384, p, 400, '制动缸', 'kPa', tr && tr.bc > 300);
    app._lastGaugeTime = now;
    app.r.texFromCanvas('gauge', app.gaugeCv, false, false);
  }
  /* 司机台 TCMS = 列车状态的镜像。
     原来它是一张写死的 "READY / 全部 OK"：开门它不变、紧急制动它不变、超速它不变。
     玩家盯得最久的就是这块屏，屏上说"正常"而车正在溜逸，等于驾驶室里有一个人造假象。 */
  drawCab(force) {
    if (!this.cabCtx) return;
    const now = performance.now();
    if (!force && this._lastCabTime && now - this._lastCabTime < 33) return;
    const app = this, s = app.session, L = app.line, tr = s ? s.tr : null;
    const mode = !s ? '待机 STANDBY'
      : s.mode === 'manual' ? (L.uto ? 'RM 限制人工' : '人工驾驶')
      : s.mode === 'semi' ? (s.handed ? '人工接管停车' : 'ATO 半自动') : 'ATO 全自动';
    const kmh = tr ? Math.round(tr.kmh) : 0;
    const lim = s ? Math.round(s.limit) : 0;
    const dM = s ? Math.abs(s.d) : 0;
    const ahead = app.traffic && s ? app.traffic.aheadOfPlayer() : null;
    const sg = app.traffic && s ? app.traffic.cabAt(s.s, 'player') : null;
    const doorPct = s ? Math.round((s.open || 0) * 10) * 10 : 0;
    const load = s && s.pax ? Math.round(s.pax.pct() / 5) * 5 : 0;
    /* 签名里只放"会改变画面文字"的量，并且全部取整：
       不取整就等于每帧重传纹理，取太粗又会漏掉真正需要上屏的变化。 */
    const sig = [mode, kmh, lim, s ? s.phase : '-', Math.round(dM / 20), tr ? tr.info.label : '',
      tr ? Math.round(tr.bc) : 0, doorPct, tr ? Math.round(tr.trac * 20) : 0,
      ahead ? Math.round(ahead.dist / 50) : -1, load, tr ? tr.atp : 0,
      /* 信号显示与"距离取整到 20 m"一起进签名：显示本身是离散值（红/黄/绿），
         而距离不取整的话每帧都在重传 480×300 的纹理。 */
      sg ? sg.cab.code + Math.round(sg.dist / 20) : '-',
      s ? (s.depot ? 1 : 0) : 0, s ? s.toName : '', s ? s.spad : 0,
      s ? Math.round((s.late || 0) / 5) : 0, app.settings.atp ? 1 : 0].join('|');
    if (!force && sig === app.cabSig) return;
    app.cabSig = sig;

    /* pow2 画布（512×320）+ 旧坐标布局：等比缩放 480×300。
       注意：这块屏的上屏走 `texFromCanvas('cab', …, false, false)` —— 第 118 条
       为了省掉每帧 generateMipmap 把动态纹理的 mipmap 全压了，所以**它没有
       mipmap**，MIN_FILTER 是 LINEAR。111d 那句"pow2 因此带 mipmap、细文字不再
       重影"已经不成立；但实测玩家看到的"字叠字"跟采样无关（原生分辨率下字是
       锐的），真凶是下面这四处排版越界。 */
    const c = app.cabCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, 512, 320);
    c.scale(512 / 480, 320 / 300);
    const W = 480, H = 300, F = SH.textures.CN_FONT;
    const ok = '#3ad29a', dim = '#1d4a5f', cyan = '#7fd3ea', amber = '#ffc451', red = '#ff5566';
    /* 屏宽只有 480 px，而这里的字几乎都是**拼出来的句子**（坡度+曲线+限速、
       站名、报警句、图定），以前没有任何一道工序保证它们不出格。实测四处撞：
       坡度行最宽 298 px 从 x=18 画到 316，直接压在 x=244 的信号灯与 x=258 的
       "机车信号"上（玩家看到的"字互相叠"就是这一处）；待机那句"线路尽头无通过
       信号机"画到 526，屏只有 480 → 半句被切；八字站名画到 489 → 最后一个字
       切一半；底栏最坏情况报警句到 386 而图定从 372 起笔 → 两句话叠在一起。
       统一走 fit()：按该栏的可用宽度裁，超了打省略号 —— 宁可少一个字，
       也不要压在别的字上。 */
    const tw = (txt, font) => { c.font = font; return c.measureText(txt).width; };
    /* 先缩字号、缩不动了才打省略号：站名少一个字就不是那个站了（"一大会址·黄陂…"），
       而 30 px 缩到 25 px 在这块 0.86 m 的屏上肉眼根本看不出来。最多让出 20 %。 */
    const fit = (txt, maxW, font) => {
      c.font = font;
      if (c.measureText(txt).width <= maxW) return txt;
      const m = /^(\S+)\s+([\d.]+)px\s+([\s\S]*)$/.exec(font);
      let f = font;
      if (m) {
        const px = +m[2], floor = Math.max(9, Math.round(px * 0.8));
        for (let n = px - 1; n >= floor; n--) {
          f = m[1] + ' ' + n + 'px ' + m[3];
          c.font = f;
          if (c.measureText(txt).width <= maxW) return txt;
        }
      }
      let s = txt;
      while (s.length > 1 && (c.font = f, c.measureText(s + '…').width > maxW)) s = s.slice(0, -1);
      return s + '…';
    };
    c.fillStyle = '#050d12'; c.fillRect(0, 0, W, H);
    /* 表头：线路色块 + 线路/编组 + 运行模式。
       车型名与线路名同名时只印一次 —— 磁浮的线路名与车型都叫"磁浮"，
       原来表头写成"磁浮 磁浮 6M"。 */
    c.fillStyle = L.color; c.fillRect(0, 0, W, 30);
    c.fillStyle = 'rgba(0,0,0,.42)'; c.fillRect(0, 0, W, 30);
    c.fillStyle = L.color; c.fillRect(0, 0, 8, 30);
    c.fillStyle = '#eaf6fb'; c.font = '900 21px ' + F;
    c.fillText([L.name, L.stock.type === L.name ? '' : L.stock.type, L.stock.formation].filter(Boolean).join(' '), 18, 24);
    c.textAlign = 'right'; c.fillStyle = mode.indexOf('RM') >= 0 ? amber : '#eaf6fb';
    c.font = '900 18px ' + F; c.fillText(mode, W - 14, 23); c.textAlign = 'left';

    /* 左：速度大字 + 限速；右：下一站与距离 */
    const over = tr && tr.kmh > lim + 1;
    c.fillStyle = over ? red : '#eaf6fb'; c.font = '900 68px ' + F;
    c.fillText(String(kmh), 18, 108);
    /* 单位跟着数字的实际宽度走：原来按位数硬写偏移，换个字体/换个字号就叠字。 */
    const sw = c.measureText(String(kmh)).width;
    c.fillStyle = '#8fb6c6'; c.font = '700 17px ' + F;
    c.fillText('km/h', 18 + sw + 8, 108);
    c.fillStyle = over ? red : ok; c.font = '900 20px ' + F;
    c.fillText('限速 ' + lim + (over ? '  超速 +' + Math.round(tr.kmh - lim) : ''), 18, 136);
    /* 纵断面/平面信息：司机控速真正要看的两项，空着的那条带子正好放它。
       s 在开局/展示模式下是 null，整段要守住 —— 这块屏在还没开车时也要能画出来。 */
    if (s) {
      c.fillStyle = '#6f97a6';
      /* 左列的天花板是右列起笔 236（再往前就是信号灯） */
      c.fillText(fit('坡度 ' + (s.grade >= 0 ? '+' : '') + s.grade.toFixed(0) + '‰ · '
        + SH.curveNote(L.al.at(s.s).k, L.al.curveLimitKmh(s.s), L.maxKmh), 236 - 18 - 6, '700 16px ' + F), 18, 162);
    }

    c.fillStyle = cyan; c.font = '800 15px ' + F; c.fillText(s && s.depot ? '入库停车标 DEPOT' : '下一站 NEXT', 236, 62);
    c.fillStyle = '#eaf6fb';
    /* 站名不再按字数硬切（原来 slice(0,8) 恰好让"一大会址·黄陂南路"画出 489 px，
       最后一个字切一半在屏外）—— 按这一列的像素宽裁 */
    c.fillText(fit(s ? s.toName : '—', W - 14 - 236, '900 30px ' + F), 236, 94);
    c.fillStyle = '#8fb6c6'; c.font = '800 19px ' + F;
    c.fillText(dM >= 1000 ? (dM / 1000).toFixed(2) + ' km' : Math.round(dM) + ' m', 236, 118);
    c.fillStyle = dim; c.fillRect(236, 126, W - 250, 1);
    c.fillStyle = ahead ? amber : ok; c.font = '700 16px ' + F;
    c.fillText(ahead ? '前方占用 ' + (ahead.dist >= 1000 ? (ahead.dist / 1000).toFixed(1) + ' km' : Math.round(ahead.dist) + ' m') : '前方区间通畅', 236, 144);
    /* 机车信号：显示的是**前方那架信号机**的显示。自动闭塞向列车传送的是"前方分区
       条件"，不是本分区 —— 本分区永远被自己占着，照它出码则司机台上的灯常年是红的。
       与地面上那架同源（都走 `Dispatcher.aspectAt`），但取"地面显示"与"防护净空"里
       更 restrictive 的一个：两列车挤在同一分区里时地面可以是绿，司机台给绿就是说谎。
       灯位自上而下 绿·红·黄，与 `WorldBuilder.signage` 的排列一致。
       `sg` 在签名之前算好（见上），这里只画。 */
    if (sg) {
      const lampY = ['proceed', 'stop', 'caution'];
      const lampC = { proceed: '#2ee56f', stop: '#ff3b3b', caution: '#ffc451' };
      for (let i = 0; i < 3; i++) {
        const k = lampY[i], on = k === sg.cab.key;
        c.fillStyle = on ? lampC[k] : '#22303a';
        c.beginPath(); c.arc(244, 152 + i * 11, 4.4, 0, 6.3); c.fill();
      }
      c.fillStyle = sg.cab.key === 'stop' ? red : sg.cab.key === 'caution' ? amber : ok;
      c.fillText(fit('机车信号 ' + sg.cab.cn + '·' + sg.cab.code + ' ' + (Math.round(sg.dist / 20) * 20) + ' m',
        W - 14 - 258, '700 16px ' + F), 258, 166);
    } else {
      c.fillStyle = dim;
      c.fillText(fit('机车信号 —— 线路尽头无通过信号机', W - 14 - 258, '700 16px ' + F), 258, 166);
    }

    /* 子系统状态表。真实司机台屏就四到六项、字很大 —— 第一版排了六行 14 px，
       在这块 0.86 m 的屏上按 1.2 m 眼距看下去只有 6 px，等于写给自己看的。
       现在留四项、两列两行，字号抬到 20 px。 */
    const rows = [
      ['车门', s && s.doors ? (doorPct >= 100 ? '全开' : '开启 ' + doorPct + '%') : '关闭',
        s && s.doors ? (tr && tr.kmh > 3 ? red : amber) : ok],
      ['手柄', tr ? tr.info.label : 'N', tr && tr.notch <= -8 ? red : tr && tr.notch < 0 ? cyan : ok],
      ['ATP', app.settings.atp ? (tr && tr.atp ? '防护动作' : '防护开') : (tr && tr.atp ? '仅警告' : '关闭'),
        tr && tr.atp ? red : app.settings.atp ? ok : dim],
      ['缸压 / 载荷', (tr ? Math.round(tr.bc) : 0) + ' kPa · ' + load + '%',
        tr && tr.bc > 300 ? amber : load > 100 ? red : cyan]
    ];
    for (let i = 0; i < rows.length; i++) {
      const col = i % 2, r = i < 2 ? 0 : 1;
      const x = 14 + col * 234, y = 206 + r * 34;
      c.fillStyle = '#0b1a22'; c.fillRect(x, y - 22, 226, 28);
      c.fillStyle = '#6f97a6';
      const lw = tw(rows[i][0], '700 15px ' + F);
      c.fillText(rows[i][0], x + 8, y);
      c.fillStyle = rows[i][2]; c.textAlign = 'right';
      /* 标签左对齐、值右对齐，两边都是拼出来的：'缸压 / 载荷' + '355 kPa · 140%'
         实测在 226 px 的格子里叠字。值按标签之后的剩余宽度裁。 */
      c.fillText(fit(rows[i][1], 218 - 8 - lw - 10, '900 20px ' + F), x + 218, y + 1);
      c.textAlign = 'left';
    }
    /* 底栏：报警条。有报警时整条变红，没报警时给一句"无故障条目" */
    const warn = s && s.spad ? '冒进信号 ' + s.spad + ' 次 —— 越过红灯进入占用分区'
      : tr && tr.eb ? '紧急制动 EB 已施加 —— 停稳后方可缓解'
      : over ? '超速：ATP 未开，系统不介入，请自行控速'
      : s && s.doors && tr && tr.kmh > 3 ? '车门开启中且列车移动 —— 立即停车'
      : s && s.phase === 'doorOpen' ? '停站中 · 开门计时' : '';
    c.fillStyle = warn ? 'rgba(120,18,30,.85)' : 'rgba(10,40,32,.85)';
    c.fillRect(0, H - 32, W, 32);
    /* 图定兑现：右端给"晚点/早点多少秒"。真实司机台上这是与速度同级的第一信息 ——
       按图行车是运营的核心约束，不是"到站停准"就够了。
       顺序必须是**先算右边再裁左边**：两边都是整句，最坏情况（长报警 +
       "早点 995 s"）实测报警画到 386 而图定从 372 起笔，两句话直接叠在一起。 */
    const la = s ? (s.late || 0) : 0;
    const lateTxt = s ? (Math.abs(la) <= 15 ? '图点运行'
      : (la > 0 ? '晚点 ' : '早点 ') + (Math.round(Math.abs(la) / 5) * 5) + ' s') : '';
    const bfw = '900 19px ' + F;
    c.fillStyle = warn ? '#ffe3e8' : ok;
    c.fillText(fit(warn || '系统正常 · 无故障条目', W - 26 - (lateTxt ? tw(lateTxt, bfw) : 0), bfw), 14, H - 10);
    if (s) {
      c.textAlign = 'right';
      c.fillStyle = Math.abs(la) <= 30 ? ok : Math.abs(la) <= 90 ? amber : red;
      c.font = bfw;
      c.fillText(lateTxt, W - 14, H - 10);
      c.textAlign = 'left';
    }
    app.r.texFromCanvas('cab', app.cabCv, false, false);
  }
  loadSettings() { try { return JSON.parse(localStorage.getItem('shmetro-v1') || '{}') || {}; } catch (e) { return {}; } }
  saveSettings() {
    const a = document.getElementById('set-sound'), v = document.getElementById('set-voice'),
      atpEl = document.getElementById('set-atp'),
      vol = document.getElementById('set-volume'), q = document.getElementById('set-quality');
    this.settings = { lineId: this.lineId, service: this.service, mode: this.mode, startIndex: this.startIdx, legs: this.legs,
      hour: this.hour == null ? 13 : this.hour,
      rain: !!this.rain,
      sound: a ? a.checked : true, voice: v ? v.checked : true, volume: vol ? +vol.value : 70, quality: this.r.quality, res: this.r.resTier,
      resAuto: !!this.r.resAuto,
      /* ATP 默认**关**。以前物理里的超速防护无条件生效，玩家永远有兜底，
         于是"控速"这件事根本不成立——冲线了 ATP 会替你刹停。关掉之后
         限速只是一条要自己遵守的约束，冲过停车标就是自己的责任。 */
      atp: atpEl ? atpEl.checked : false };
    try { localStorage.setItem('shmetro-v1', JSON.stringify(this.settings)); } catch (e) {}
  }
  /** 本交路对应的 lines 表键名。支线是同一条线的另一个 service，不是另一条线。 */
  lineKey(id) {
    return this.service === 'branch' && SH.LINES[id] && SH.LINES[id].branch ? id + '#branch' : id;
  }
  setService(v, save) {
    this.service = v === 'branch' && SH.LINES[this.lineId] && SH.LINES[this.lineId].branch ? 'branch' : 'main';
    this.setLine(this.lineId, save);
  }
  /**
   * 拉取并解析 1 号线列车的 **BVE 模型本体**（6 节车的 CSV + 26 张贴图）。
   *
   * 为什么是异步的、以及为什么没到位时要能退：`SH.textures.buildAll` 的程序化贴图
   * 全是同步画出来的，而模型的 CSV 与 PNG 要走 HTTP。所以流程是
   * 拉 CSV → 解析 → 注册 `bve:*` 材质 → 拉贴图 → 重建列车视图。
   * 没到位之前列车走程序化车体（`TrainView.rebuild` 里的分支），
   * 到位之后重建一次 —— 画面从"程序化车"变成"模型车"，不会先画出一列空车。
   * Node（离线判据）没有 `fetch`，直接返回；判据要量模型就自己从磁盘读 CSV
   * 并调 `SH.bve.parse`（见 test-train 的「BVE 列车模型」一节）。
   */
  loadL1Model() {
    if (typeof fetch !== 'function' || !SH.bve) return;
    const files = ['01.csv', '02.csv', '03.csv', '04.csv', '05.csv', '06.csv'];
    /* `bveReady`：模型就绪的 Promise。取证脚本（dev/shot.js）在烘焙之前 await 它，
       否则截出来的还是"程序化车体"那一帧 —— 异步资源与截图之间必须有这道闸。 */
    this.bveReady = Promise.all(files.map(f => fetch('assets/l1train/csv/' + f).then(r => r.text())))
      .then(texts => {
        const cars = texts.map(t => SH.bve.parse(t));
        const names = [];
        for (const c of cars) for (const n of SH.bve.texNames(c)) if (names.indexOf(n) < 0) names.push(n);
        SH.registerBveMats(names);
        for (const n of names) { const ti = SH.bve.texInfo(n); this.r.texFromImage(ti.key, ti.url, false); }
        SH.bve.cars = cars;
        /* 车档没变、但车体换了 → 整条线重建一遍（在跑的会话也跟着换过来） */
        if (this.lineId) this.setLine(this.lineId, false);
      })
      .catch(() => { /* 缺文件就留程序化车体，不报错刷屏 */ });
  }

  setLine(id, save) {
    if (!this.lines[id]) id = 'l2';
    this.lineId = id; this.line = this.lines[this.lineKey(id)];
    this.startIdx = C(this.startIdx, 0, this.line.stations.length - 2);
    document.documentElement.style.setProperty('--line', this.line.color);
    this.sign = new SH.textures.SignAtlas(SH.textures.SignAtlas.bestSize(this.r.maxTexSize()));
    this.world.sign = this.sign; this._globalSigns();
    if (SH.WorldBuilder.prewarmSigns) SH.WorldBuilder.prewarmSigns(this.sign, this.line);
    this.drawCab(true);
    this.trainView.setLine(this.line, this.sign, this.tcmsRect);
    this.r.texFromCanvas('sign', this.sign.canvas, false);
    this.sign.dirty = false;
    /* 道路车流（走廊街面的社会车与公交车）：随线重建 —— 车道/停靠点
       都钉在本线 alignment 的绝对里程上。 */
    if (this.street) this.street.detach(this.r);
    this.street = (typeof SH.street === 'object' && SH.street.StreetTraffic) ? new SH.street.StreetTraffic(this.line) : null;
    if (this.street) this.street.attach(this.r);
    if (save !== false) this.saveSettings();
    this.ui && this.ui.syncSelect();
    this.showcase = { s: this.line.al.stationS[Math.min(2, this.line.al.stationS.length - 1)] + 60, t: 0 };
    this.bakeShowcase();
  }
  bakeShowcase() {
    if (!this.ui) return;
    this.world.clear();
    // 站序号可能超出当前线的长度（换线后残留的索引），必须钳住：
    // NaN 的 s 会让 openness 失效，整段场景被套上隧道浓雾。
    const S = this.line.al.stationS;
    let s = this.showcase.s;
    if (!isFinite(s)) s = S[Math.min(2, S.length - 1)];
    s = C(s, 260, this.line.al.total - 300);
    this.showcase.s = s;
    this.district = this.world.bake(this.line, s - 320, s + 620, 'show');
  }
  bakeAhead() {
    if (!this.session) return;
    const s = this.session.s;
    /* 窗口必须始终包住列车当前位置。原来写成 z = targetS + 420，一旦
       列车里程超过目标停车标（冲标后低速对位、或外部把车挪到下一站之前），
       区间就变成反向，bake 出来是空的——整座城市直接消失，只剩列车飘在天上。
       稳帧错峰（111-6）：重烘焙一次 ~80 ms，砸在一帧里就是 P99 顿挫。
       同一里程窗口内绝不重复烘；列车还没驶出上次的烘焙窗口就不动 —
       出发/换站时的提前烘（_prepare 调它）已经够覆盖正常行车。 */
    if (this._bakeA != null && s >= this._bakeA + 340 && s <= this._bakeZ - 340) return;
    const a = s - 420, z = Math.max(s + 420, this.session.targetS + 420);
    this._bakeA = a; this._bakeZ = z;
    this.world.clear();
    const t0 = performance.now();
    this.district = this.world.bake(this.line, a, z, 'run', this.session ? this.session.pax : null);
    this.bakeMs = performance.now() - t0;
  }
  /**
   * 站台乘降可视化（第 101/112 条）：站台上的人随乘降减少，车门一开就有人
   * 走下车、走向出入口并上楼/下楼离场。
   *
   * 人群原先烘在世界网格里、一帧不变 —— 玩家看到的是"车来了，站台上的人
   * 纹丝不动，也不上车"。现在人群单独成批（tag `'crowd'`），这里按客流模型的
   * `waitingAt` 重建它，所以**站台上还剩几个人，就是模型里还剩几个人**。
   *
   * 节流是必须的：一次重建要建几百人并重传 GPU 缓冲。
   * 规则是"窗口内候乘人数之和变化 ≥3 人、**或下车人流的时钟走了 0.5 s 的桶**、
   * 且距上次重建 ≥0.2 s"。
   *
   * 下车人流（第 112 条）读的是 `session.egress` 而不是"门开着没有"：
   * 门关之后人还在站台上往出入口走（几十个人不会在关门那一瞬集体消失）。
   * 每条过程带自己的时钟 `t`，所以它必须进重建签名 —— 否则关门之后
   * `waitingAt` 不再变，一次重建都不会发生，人流就"冻"在门线上。
   * 重建范围是**窗口内所有站**：只重建当前站会把邻站的人整批丢掉。
   * 下车人流只发生在玩家停靠过的站 —— AI 车没有逐站客流（诚实局限，README 110）。
   */
  syncCrowd(dt) {
    const d = this.district;
    if (!d || !d.crowd || !this.session || !this.running) return;
    const pax = this.session.pax, line = this.line, cs = d.crowd, s = this.session;
    const eg = s.egress || [];
    /* 近/对向两条乘降线各查各的：同一站可能同时有本侧与对向的下车过程。 */
    const egOf = (i, opp) => { for (const e of eg) if (e.at === i && !!e.opp === !!opp) return e; return null; };
    let sig = 0;
    for (const i of cs.stations) sig += pax ? pax.waitingAt(line.stations[i], i) : 0;
    /* 下车人流的时钟进签名（0.5 s 桶）：它是"关门之后还在动"的唯一信号。
       桶比开门期间的 0.4 s 略粗 —— 门关之后步行者已在远处，0.5 s 的步进读不出来。
       对向过程单独标记：它的重建走对向站台（crowdStationFar），时钟不标记的话
       对向人流的步进不会触发重建，人冻在对面门线上。 */
    const egSig = eg.map(e => (e.opp ? 'o' : 'n') + e.at + ':' + Math.floor(e.t / 0.5)).join('|');
    this._crowdT = (this._crowdT || 0) + (dt || 0);
    if (cs.sig != null && Math.abs(sig - cs.sig) < 3 && egSig === cs.egSig) return;
    if (cs.sig != null && this._crowdT < 0.2) return;
    this._crowdT = 0;
    this.r.dropTag('crowd');
    const b = new Builder();
    for (const i of cs.stations) {
      const e = egOf(i, false);
      /* 视觉层只认这一个入口：need/rate/dwellNeed/wait0 在开门那一刻就定死了，
         dwell 是**这条过程自己的时钟**（关门后继续走）。 */
      const al = e ? { need: e.need, rate: e.rate, dwellNeed: e.dwellNeed, wait0: e.wait0, dwell: e.t } : null;
      SH.WorldBuilder.crowdStation(b, line, cs.lg, i, pax ? pax.waitingAt(line.stations[i], i) : null, null, al);
      /* 对向车的下车人流画到对向站台（诚实清单 §7.2）：没有过程时不重建 ——
         对向候乘烘在静态世界批次里，这里只补"正在下车的人"。 */
      const eo = egOf(i, true);
      if (eo) SH.WorldBuilder.crowdStationFar(b, line, cs.lg, i,
        { need: eo.need, rate: eo.rate, dwellNeed: eo.dwellNeed, wait0: eo.wait0, dwell: eo.t });
    }
    cs.batches = this.r.upload(b.finish(), 'crowd');
    cs.sig = sig; cs.egSig = egSig;
  }
  begin() {
    this.audio.init(); this.audio.resume();
    this.audio.setRain(this.rain ? 1 : 0);      // 雨声随本局的天气（D4）
    /* 每次开始都从所选钟点重新起算：上一局的运行时间不该带到这一局。 */
    this.clock = this.hour * 3600;
    if (SH.WorldBuilder.prewarmSigns) SH.WorldBuilder.prewarmSigns(this.sign, this.line);
    this.r.texFromCanvas('sign', this.sign.canvas, false);
    this.sign.dirty = false;
    // 起始站必须留得出至少一段运行，否则列车停在终点站无处可去
    this.startIdx = C(this.startIdx, 0, Math.max(0, this.line.stations.length - 2));
    /* 只读不写 this.legs：意图与实际段数分开，见 SH.legsPlan。 */
    this.runLegs = SH.legsPlan(this.legs, this.startIdx, this.line.stations.length).run;
    this.session = new Session(this).start(this.line, this.mode, this.startIdx, this.runLegs);
    /* 全线 AI 列车与调度：以玩家当前里程为参照铺一张运行图。
       放在 session 之后，因为 Dispatcher 要用玩家的里程把车队"错开"摆放。 */
    /* dayT0 把调度器的"当日零点"对齐到玩家选的钟点：屏上的钟点、天光、
       收车时刻于是落在同一条时间轴上（以前调度器的 clock 从 0 起，屏永远 00:0x）。 */
    const makeOnEgress = (isOpp) => (e) => {
      if (!this.session) return;
      const at = isOpp ? (this.line.stations.length - 1 - e.at) : e.at;
      if (at < 0 || at >= this.line.stations.length) return;
      /* 对向车的下车过程带 `opp` 标记：syncCrowd 按它把人画到**对向站台**
          （crowdStationFar）—— 不标的话对向车在对面开门、人却从本侧车门走出来。 */
      const key = (x) => (x.at === at && !!x.opp === !!isOpp);
      const old = this.session.egress.findIndex(key);
      if (old >= 0) this.session.egress.splice(old, 1);
      this.session.egress.push({ ...e, at, opp: isOpp });
    };
    this.traffic = new SH.traffic.Dispatcher(this.line, {
      hour: this.session.hour, dayT0: this.hour * 3600, rain: this.rain,
      pax: this.session.pax, onEgress: makeOnEgress(false)
    });
    this.traffic.reset(this.session.s);
    /* 对向车队（第 108 条 双线断面）：同一个调度器类、同一份时刻模型跑在
       镜像里程上 —— 配车数、头时、间隔公式与正向是同一个（禁止第二份公式）。
       配车按 line 的 maglev/apm 与对向轨烘焙（buildRuns 的 oppOn）同判：
       单线专列（磁浮/胶轮）没有对向轨，也就不放对向车。 */
    /* 对向车队（第 108 条 双线断面）：同一个调度器类、同一份时刻模型跑在
       镜像里程上 —— 配车数、头时、间隔公式与正向是同一个（禁止第二份公式）。
       配车按 line 的 maglev/apm 与对向轨烘焙（buildRuns 的 oppOn）同判：
       单线专列（磁浮/胶轮）没有对向轨，也就不放对向车。
       客流走**对向桶**（诚实清单 §7.2）：对向车服务的是对面站台上等反方向
       的人 —— Flow.waitingAt 的 '#opp' 桶。代理只换桶不改公式：
       waitingAt/waiting.set 转给同一个 Flow 实例，rate（门的通过能力）同源。 */
    const paxFwd = this.session.pax;
    const paxOpp = paxFwd ? {
      waitingAt: (n, i) => paxFwd.waitingAt(n, i, -1),
      waiting: { set: (n, v) => paxFwd.waitingSet(n, v, -1) },
      rate: () => paxFwd.rate(),
    } : null;
    this.opp = (this.line.maglev || this.line.profile.rubber) ? null
      : new SH.traffic.Dispatcher(this.line.mirror(), {
          hour: this.session.hour, dayT0: this.hour * 3600, rain: this.rain,
          pax: paxOpp, onEgress: makeOnEgress(true)
        });
    /* reset(镜像位置) 把车队按镜像里程铺开；铺完后把 playerS 归 null ——
       reset 会把它当"玩家障碍"存进占用表，而玩家在另一条股道上。 */
    if (this.opp) { this.opp.reset(this.line.al.total - this.session.s); this.opp.playerS = null; }
    /* ------------------------------------------------ 套跑的另一头交路（第 121 条）
       Y 型线（5/10/11 含支线）以前只有玩家所选交路有车，另一交路的车在分岔口
       被脱网 —— 于是"2:1 混跑"从来没有真的发生过。现在两个交路各建一个调度器，
       **同一支车队按 SH.interlineMeta.ratio 切开**（不是各配一队，否则共用干线
       的头时凭空减半，既有头时判据会被这次的新功能自己打穿）。
       两边互为 peer：分岔站之前是同一段轨道电路，占用必须互相看得见。 */
    this.alt = null;
    {
      const im = SH.interlineMeta ? SH.interlineMeta(this.line) : null;
      const otherKey = im && im.forkIdx >= 0
        ? (this.line.svc === 'main' ? this.line.baseId + '#branch' : this.line.baseId) : null;
      const other = otherKey ? this.lines[otherKey] : null;
      if (other) this.alt = SH.traffic.linkInterline(this.traffic, other, {
        hour: this.session.hour, dayT0: this.hour * 3600, rain: this.rain,
        pax: this.session.pax, onEgress: makeOnEgress(false), atS: this.session.s,
      });
    }
    this.ato.reset(this.mode);
    this.running = true; this.paused = false;
    /* UTO 线上人工接管是运行等级降级，不换个说法会让人以为限速 25 是 bug。 */
    if (this.line.uto && this.mode === 'manual')
      this.hint('UTO 线人工接管 = <b>RM 限制人工</b><br><small>车载不再给运行曲线，限速 25 km/h；想按图跑请用半自动或全自动</small>', 4200);
    this.show('game');
    this.bakeAhead();
    this.last = performance.now();
  }
  show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('is-active', s.id === 'screen-' + name));
    document.getElementById('cab-overlay').classList.toggle('is-on', false);
  }
  toast(t, ms) { const e = document.getElementById('toast'); if (!e) return; e.textContent = t; e.classList.add('is-on'); clearTimeout(this._tt); this._tt = setTimeout(() => e.classList.remove('is-on'), ms || 1900); }
  /** DRS 状态清零的唯一入口：玩家改上限、开关自动档、开机恢复设置都走这里。
   *  上限变了却不重建状态 = 旧的 `fail` 名单还按上一个上限拦着（玩家切到"原生"
   *  结果自动档再也不肯试回 2.5K）。 */
  resetDrs() { this._drs = SH.drsNew(Math.max(0, SH.RES_ORDER.indexOf(this.r.resTier))); }
  hint(html, ms) { const e = document.getElementById('hint'); if (!e) return; e.innerHTML = html; e.classList.add('is-on'); clearTimeout(this._ht); this._ht = setTimeout(() => e.classList.remove('is-on'), ms || 1800); }
  showJudge(j) { this.hint('<b style="color:' + j.color + ';font-size:22px">' + j.grade + '</b> ' + j.title + '<br><small>停车误差 ' + (j.err >= 0 ? '+' : '') + j.err.toFixed(2) + ' m</small>', 2800); const rp = document.getElementById('reposition'); if (rp) rp.classList.toggle('is-on', Math.abs(j.err) > 0.4); }
  syncLever() { this.ui && this.ui.syncLever(); }
  finishRun(sum) { this.running = false; this.lastSummary = sum; this.ui && this.ui.renderResult(sum); setTimeout(() => this.show('result'), 620); }

  /* ------------------------------------------------------------- 相机 */
  camera() {
    const al = this.line.al;
    const s = this.running && this.session ? this.session.s : (this.showcase ? this.showcase.s : 200);
    const open = this.running && this.session ? this.session.open : 0;
    const cars = this.trainView.carPositions(s);
    const p = this.line.profile;
    const fr0 = al.frame(s);
    const spd = this.running && this.session ? this.session.tr.kmh : 0;
    const acc = this.running && this.session ? this.session.tr.a : 0;
    /* 乘坐感最终版 —— **照南京版抄**（玩家指示"去看南京地铁的驾驶室运行逻辑"，
       njmetro/南京地铁驾驶模拟器-深度拆解.md 5.3 节）。四轮迭代踩出来的结论：
       旋转摇动把远处位移放大（天际线在几百米外，0.001 rad 就是半米）、
       FOV 随速拉伸让整幅画面呼吸缩放 —— 都是"抖动/移动/重影"的来源；
       南京版跑了很久没这些问题，因为它**只有低频平移**：
         sway  = sin(t·2.3)·sp·0.020   （2 cm 横移，0.37 Hz）
         heave = sin(t·4.9)·sp·0.008   （8 mm 浮沉，0.78 Hz）
       平移的角位移随距离**衰减**（近处站台轻晃、远方天际线纹丝不动），
       与司机室补偿（cabFixMatrix，台面钉死）正好互补成"驾驶室稳、近景微晃、
       远方不动"。连续正弦不搞间歇 —— 2 cm 的 0.4~0.8 Hz 读作"车在动"，
       配音效就是速度感本身；高频蜂鸣与旋转全部去掉，FOV 固定。
       纵向加速度 → 视野俯仰吃平滑过的 _accSm（换挡阶跃不砸视野）。 */
    const sp = Math.min(1, Math.max(0, spd / 80));
    const shake = Math.sin(this.time * 2.3) * sp * 0.020;      // sway：横移 2 cm
    const heave = Math.sin(this.time * 4.9) * sp * 0.008;      // heave：浮沉 8 mm
    const shakeYaw = 0;
    const shakePit = 0;

    if (this.view === 'cab') {
      /* 机位本身在 cabShot() 里，与 test-shot.js 共用同一份。
         以前这段是内联的，测试里没有 cab 机位 —— 驾驶室是玩家默认视角，
         却是唯一一个没有任何像素判据的机位。 */
      const look = { yaw: this.yaw, pitch: this.pitch,
        acc: this._accSm || 0, shake, heave, shakeYaw, shakePit };
      const cam = cabShot(this.line, s, look);
      /* 仪表屏别抖（玩家反馈，第 111 条补记）：相机照吃全部骑行运动，
         但司机室批次绘制时预乘 S = V(抖)⁻¹·V(不抖) —— 台面/TCMS/圆表在
         屏幕上纹丝不动，只有站台、隧道、天空随速度晃（"车快了晃正常"）。
         基准相机保留用户环视（yaw/pitch 两份相同，S 里只剩骑行 delta），
         所以转头时台面照常在画面里摆 —— 补偿的只是"车"的运动，不是"头"的。 */
      const still = cabShot(this.line, s, { yaw: this.yaw, pitch: this.pitch,
        acc: 0, shake: 0, heave: 0, shakeYaw: 0, shakePit: 0 });
      this._cabFix = SH.cabFixMatrix(still, cam);
      return cam;
    }
    this._cabFix = null;
    if (this.view === 'chase') {
      // 机位要高出声屏障、退到路基之外，否则整条高架被自己那道玻璃墙挡住
      const back = cars[cars.length - 1].s - 40;
      const f = al.frame(back);
      const side = this.line.stationSide(0);
      const e = al.world(f, side * (21 + this.yaw * 7), 11.5 + this.pitch * 6);
      const t = al.world(al.frame(s - 10), 0, 3.4);
      return { eye: e, target: t, fov: 50, near: 0.3, far: 4600 };
    }
    if (this.view === 'headon') {
      const f = al.frame(s + 46);
      const e = al.world(f, 4.6 + this.yaw * 4, 2.4 + this.pitch * 3);
      const t = al.world(al.frame(s), 0, 2.2);
      return { eye: e, target: t, fov: 46, near: 0.3, far: 900 };
    }
    if (this.view === 'platform') {
      /* 机位单独提成 SH.platformShot：test-shot.js 要按像素量这张构图
         （相机有没有埋进站厅设施里、站体占不占画面），抄一份相机就是第二个真值。 */
      return SH.platformShot(this.line, s,
        this.running && this.session ? this.session.s : null);
    }
    if (this.view === 'scenic') {
      // 观景机位：自动挑一个离列车最近的地标，把相机摆在轨道旁朝向它。
      // 没有地标（或地标还很远）时退回追尾构图，避免出现"对着空地平线"的废镜头。
      const list = (this.district && this.district.landmarks) || [];
      let best = null, bd = 1e9;
      for (const lm of list) {
        if (!lm.origin) continue;
        const d = Math.abs(lm.s - s);
        if (d < bd) { bd = d; best = lm; }
      }
      if (!best || bd > 1500) {
        const f2 = al.frame(s - 150);
        const e2 = al.world(f2, 20, 12);
        const t2 = al.world(al.frame(s + 260), 0, 6);
        return { eye: e2, target: t2, fov: 46, near: 0.3, far: 4600 };
      }
      const q = scenicShot(this.line, best, s, bd);
      this.scenicName = best.name;
      return { eye: q.eye, target: q.look, fov: q.fov, near: 0.3, far: 6000 };
    }
    if (this.view === 'street') {
      /* 街面机位：站在人行道上看这座高架站的出入口。
         这是**唯一能检验"房子感"的高度** —— 前五轮里每一个真 bug（桥墩打到江心、
         sweep 位置归一化、全线牌子上下颠倒、站台相机蹲着、栏板埋在地坪下）
         都是"去看不曾截过的机位"看出来的，而街面是这座模拟器唯一还没被看过的高度。
         眼高 = 人行道面（轨面下 10.74）+ 1.65 m 行人视线。 */
      /* 机位单独提成 SH.streetShot：test-shot.js 要按像素量这张构图，
         而自己抄一份相机就等于又造一个"第二真相"（这一族已经栽过四次）。 */
      return SH.streetShot(this.line, s);
    }
    if (this.view === 'top') {
      const f = al.frame(s - 60);
      return { eye: al.world(f, 0, 62), target: [f.p[0], f.p[1], f.p[2]], up: [0, 0, -1], fov: 44, near: 1, far: 900 };
    }
    return { eye: [0, 3, 0], target: [0, 3, 1], fov: 60 };
  }

  envFor(s) {
    const open = this.line.openness(s);          // 0 全地下 → 1 全高架
    const el = open > 0.5;
    const ns = this.line.nearStation(s);
    /* 天光取**当前钟点**（连续时钟），不再恒为黄昏。地下没有天光，仍走 tunnel。
       这一行是"时间是死的"的根治点：以前写死 `SH.ENVS.dusk`，`ENVS.dawn/day/night`
       三个预设从来没被调用过，选"夜间"画面照旧是黄昏。
       （149 条 perf/GC：envAt+envRainy 一次产 ~30 个短命数组，原来每帧都算
       —— 144fps 下每秒四千个，是 minor GC 周期性尖刺的来源之一。天光随
       钟点的变化以分钟计，按 0.25 s 分桶缓存：桶键 = clock×4 + 雨天位，
       桶内复用同一份插值结果。SH.envAt/envRainy 本身保持纯函数 —— 判据
       test-env 直接调它们，走的不是这条路。） */
    const kb = (Math.floor((this.clock || 0) * 4) << 1) | (this.rain ? 1 : 0);
    if (!this._envT || this._envT.k !== kb) {
      let T = SH.envAt(this.hourNow);
      if (this.rain) T = SH.envRainy(T);
      this._envT = { k: kb, T };
    }
    const T = this._envT.T;
    const base = el ? T : SH.ENVS.tunnel;
    /* 返回对象同样复用（每帧 5 个 .map() + Object.assign + post 字面量 → 0 分配）。
       唯二持有者是渲染器当帧读掉与 this.r.env（end() 读 post）—— 跨帧覆盖安全；
       需要独立快照的调用方自己拷（目前没有）。 */
    const e = this._env || (this._env = { post: {}, _b: { fogCol: [0, 0, 0], skyCol: [0, 0, 0], gndCol: [0, 0, 0], skyHor: [0, 0, 0] } });
    const B = e._b;
    // 直接引用基准字段（桶内稳定，不拷贝）
    e.sunDir = base.sunDir; e.sunCol = base.sunCol; e.skyZenith = base.skyZenith;
    e.fog2 = base.fog2; e.haze = base.haze; e.night = base.night;
    e.fogHeightFalloff = base.fogHeightFalloff;
    // 雾密度按 open 连续插值：出洞口时远景不会突然被吞掉
    const fogT = C(open, 0, 1);
    /* 雾密度**保持标定值不动**：0.00042 是"高架段看得见陆家嘴"的取舍结果
       （见 README 第 19 条那一族），它属于可见性而不是时刻，换天色不该动它。
       雨天例外：雨雾是"天气"不是"天色"，按 fogT 缩放——隧道里（fogT=0）
       完全不乘，高架段全额 ×1.85，洞口过渡带平滑衔接。 */
    e.fogDensity = lerp(0.0112, 0.00042, Math.pow(fogT, 0.7))
      * (this.rain ? lerp(1.0, SH.RAIN.fogMul, fogT) : 1.0);
    e.fogCol = mix3(B.fogCol, SH.ENVS.tunnel.fogCol, T.fogCol, fogT);
    e.skyCol = mix3(B.skyCol, SH.ENVS.tunnel.skyCol, T.skyCol, fogT);
    e.gndCol = mix3(B.gndCol, SH.ENVS.tunnel.gndCol, T.gndCol, fogT);
    /* 地平线暖色也要跟着插值：着色器现在拿它做垂直立面的环境光
       （见 renderer.js 的 band 项），出洞口一半明一半暗地跳变会直接体现在楼色上。 */
    e.skyHorizon = mix3(B.skyHor, SH.ENVS.tunnel.skyHorizon, T.skyHorizon, fogT);
    /* 人工光的加算倍率：夜里灯光本来就该更"亮出来"（night 1.0 时 +0.55）——
       这是"晚上城市灯亮起来"在数值上的落点，也是夜里楼群不发灰的原因。 */
    e.emiBoost = lerp(1.9, T.emiBoost, fogT);
    /* 站场浮尘：只该出现在**地下/封闭车站**。原来无条件取 max(雾, 0.0055)，
       而 0.0055 在 300 m 处就已经雾化 93% —— 于是每一座高架车站、以及所有
       停在站点的观景机位，整屏被埋进乳白雾里（外滩、陆家嘴、黄浦江三张截图
       全部糊成淡紫色，一开始被误判成"环境光太冷"）。按 open 插值：
       露天站回到正常户外雾，封闭站才保留浮尘。 */
    if (ns.d < 100) e.fogDensity = Math.max(e.fogDensity, lerp(0.0055, 0.00042, fogT));
    /* 湿度按"相机所在地有多露天"给（0..1）：隧道里不湿，出洞口渐湿。
       渲染器拿它乘材质的 wet 标志——只有沥青/砖石/地面这些会被雨淋的表面变暗变亮。 */
    e.wet = this.rain ? fogT : 0;
    /* 雨天的人工光：灰天里灯"亮出来"更多（envRainy 已给 emiBoost ×1.18），
       湿地面的反射也让 bloom 稍涨。（post 也写进持久对象。） */
    e.post.bloom = lerp(0.95, 0.62 + 0.55 * T.night, fogT) + (this.rain ? 0.12 * fogT : 0);
    e.post.exposure = 1.04 - (this.rain ? 0.04 * fogT : 0);
    e.post.vignette = 0.36; e.post.grain = 0.028; e.post.aberr = 0.005;
    return e;
  }

  /* ------------------------------------------------------------- 主循环 */
  frame(t) {
    requestAnimationFrame(tt => this.frame(tt));
    /* 刷屏周期必须在**限帧判据之前**量：被跳掉的那一拍根本走不到下面，在这里
       量到的最小间隔是限帧自己的节奏（13.9 ms）而不是刷屏的（6.9 ms）。
       取中位数不是最小值：GPU 吃紧时回调会被成批推迟，最小值仍是那一拍的
       1/144 但只出现一两次，读数就成了"屏 156 Hz"这种不存在的东西。
       拍 Hz 的两种读法都有意义：≈刷屏 = 派发正常；≈刷屏的一半 = GPU 已经
       赶不上每一拍了，这本身就是瓶颈在 GPU 的证据。 */
    const rg = t - (this._fpsRaf == null ? t : this._fpsRaf);
    this._fpsRaf = t;
    if (rg >= 3 && rg <= 40) {
      const ra = this._rafArr || (this._rafArr = []);
      ra.push(rg);
      if (ra.length > 96) ra.shift();
      /* 刷屏周期独立测量的滑窗（9b①）比中位池长一个量级：下限是显示器的物理
         常数，窗口越长越可能在负荷起来**之前**量到过它 —— 中位池 96 个样本
         在重负荷下两秒就全糊了。 */
      const rh = this._rafHist || (this._rafHist = []);
      rh.push(rg);
      if (rh.length > 600) rh.shift();
    }
    /* 稳帧限制器（111g：玩家实录 fps 91→69 不规则下滑，双影帧是录屏混帧）。
       呈现节奏的**方差**比帧率本身更决定体感。只在**超高刷屏**（rAF 间隔
       <9.2 ms，即 >110 Hz）时对半限频：144Hz→72fps、120Hz→60fps，节奏
       整齐；60/75Hz 屏永不跳帧（阈值必须低于其 rAF 间隔，否则与垂直同步
       打拍频，反而抖 —— 第一版 1/62 阈值就踩了这个坑，48fps 忽快忽慢）。
       中低刷屏的体感零变化。
       111h 试过"量出刷屏周期、按整拍限帧"，在同机同帧内容的定格对照下
       输了（2560×1452：抖动 0.1→0.4 ms；3840×2160：61fps/1.6ms → 48fps/
       2.0 ms）—— 因为 Chrome 在 GPU 吃紧时**不按整拍派发 rAF**（实测出画
       间隔有 15/17 ms 这种半拍值），整拍锁相在这种派发下不可能成立，白付
       一档帧率。所以这里保持时间阈值。 */
    const rawDt = (t - this.last) / 1000;
    if (rawDt > 0 && rawDt < SH.DRS.skipMs / 1000) return;
    /* 出画间隔（ms）进统计池：DRS 与 HUD 都要的是**中位**而不是平均 —— 一次
       重烘焙那种 300 ms 的大坑不该把整局的画质判掉。池子按窗口长度就够。 */
    (this._cadArr = this._cadArr || []).push(rawDt * 1000);
    if (this._cadArr.length > 64) this._cadArr.shift();
    let dt = Math.min(0.05, Math.max(0.001, rawDt));
    this.last = t;
    if (this.paused) dt = 0;
    this.time += dt;
    /* 地勤仪表（0.5 s 一更）：fps + 帧 CPU 耗时中位/最大 + 构建号。
       GPU 不弱还掉帧的真相 = **CPU 把 GPU 饿着了**：渲染调用本身每帧只有 ~0.3 ms
       （cam+draw+post 实测），掉帧来自 CPU 侧的大件（重烘焙/DOM/后台计时器）把
       一帧的 CPU 时间顶到 30+ ms，GPU 干等。把这个数摆出来，玩家一眼分清
       "GPU 慢"（cpuMs 低而 fps 低 → 真的 GPU 瓶颈）与"CPU 饿 GPU"（cpuMs 飙高）。 */
    this._fpsN = (this._fpsN || 0) + 1;
    /* 秒数按**真实墙钟**累计，不是按 dt：dt 夹在 0.05，重烘焙那种 300 ms 的大坑
       只记 50 ms（读数虚高）；暂停期间帧照计而 dt=0 → 时间不涨，恢复后第一眼就是
       几百 fps。这块仪表是给"画面异常"看的，它自己先抖就成了误导。 */
    this._fpsT = (this._fpsT || 0) + Math.min(0.25, rawDt);
    /* 节奏（111i）：**平均 fps 看不出"来回跳"**，能看出来的是出画间隔的跨度。
       把本窗内间隔的最小/最大摆出来：锁在刷屏上时两者几乎相等（144 Hz 屏限帧后
       实测 13.7~14.1）；一旦在两种节奏之间来回翻就写成一片（GPU 吃紧时实测
       8~36 —— 那才是玩家说的"帧率来回跳"，哪怕中位帧率看着挺好看）。 */
    this._gMin = this._gMin == null || rawDt * 1000 < this._gMin ? rawDt * 1000 : this._gMin;
    this._gMax = this._gMax == null || rawDt * 1000 > this._gMax ? rawDt * 1000 : this._gMax;
    if (this._fpsT >= 0.5) {
      const win = this._fpsT;                              // 本窗口的**真实**秒数（DRS 的积分步长）
      const cad = (this._cadArr || []).slice().sort((a, b) => a - b);
      const cadMed = cad.length ? cad[Math.floor(cad.length / 2)] : 0;
      const ra = (this._rafArr || []).slice().sort((a, b) => a - b);
      const raf = ra.length ? ra[Math.floor(ra.length / 2)] : 0;
      const e = document.getElementById('hud-perf');
      /* 刷屏周期独立测量（9b①）：最小支撑箱只往低棘轮（显示器不会越用越慢，
         只会一直没机会量到）—— 一旦在菜单/轻负荷时量到过 16.5 ms，之后重负荷
         就不能再把它"测"回 33 ms，否则 DRS 又会自欺。 */
      const rf = SH.refreshFloor(this._rafHist);
      if (rf > 0) this.refreshMs = this.refreshMs > 0 ? Math.min(this.refreshMs, rf) : rf;
      if (e) {
        const arr = (this._cpuArr || []).sort((a, b) => a - b);
        const med = arr.length ? arr[Math.floor(arr.length / 2)] : 0;
        const mx = arr.length ? arr[arr.length - 1] : 0;
        e.textContent = Math.round(this._fpsN / this._fpsT) + 'fps · cpu ' + med.toFixed(1) + '/' + mx.toFixed(0)
          + 'ms · 帧' + (this._gMin || 0).toFixed(1) + '~' + (this._gMax || 0).toFixed(1)
          + ' · 拍' + (raf ? (1000 / raf).toFixed(0) : '--') + 'Hz'
          + (this.refreshMs > 0 ? '·屏' + (1000 / this.refreshMs).toFixed(0) : '')
          + ' · '
          + (this.r.resAuto ? '自动·' : '') + (SH.RES_NAME[this.r._effTier] || this.r.resTier)
          + (this.r.gpuMs > 0 ? ' GPU ' + this.r.gpuMs.toFixed(1) + 'ms'
            + (this.r.gpuPostMs > 0 ? '+后期 ' + this.r.gpuPostMs.toFixed(1) : '')
            + (this._drs && this._drs.cpu >= SH.DRS.lowS ? '·瓶颈不在分辨率' : '') : '')
          + ' · '
          + (this.r.api || '?') + (this.r.msaa > 0 ? '·MSAA' + this.r.msaa : '')
          + (PERF.on ? ' · perf ' + PERF.top(3) : '')
          + ' · ' + BUILD_STAMP;
      }
      /* 自适应分辨率：就吃上面这两个中位，**不另起计时器**（HUD 与 DRS 必须看同一份
         帧历史，否则会出现"HUD 说 60fps 而 DRS 在降档"这种谁也说不清的场面）。
         刷屏周期取 rAF 派发间隔的中位 —— 它在限帧判据**之前**量，所以量到的是刷屏
         本身而不是被限帧器调出来的节奏（那段注释就在上面）。 */
      if (this.r.resAuto && this._drs && raf > 0) {
        const before = this._drs.tier;
        /* 刷屏周期有独立读数就喂它（9b①）：中位在重负荷下被拉长，拿它当"刷屏"
           会把 30fps 误判成锁拍。没量到（refreshMs=0）就回退中位 —— 与旧版逐字一致。 */
        SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);
        if (this._drs.tier !== before) {
          const nt = SH.RES_ORDER[this._drs.tier];
          if (this.r.setResEff(nt)) {
            /* 换挡留痕：HUD 的 toast 只给玩家看 1.9 s，而取证要的正是"它到底换没换、
               什么时候换的"（dev/shot.js 的 DRSWATCH= 读这一块）。 */
            (this._drsLog = this._drsLog || []).push([+this.time.toFixed(1), SH.RES_ORDER[before], nt]);
            this.toast('自适应分辨率：' + (SH.RES_NAME[SH.RES_ORDER[before]] || before)
              + ' → ' + (SH.RES_NAME[nt] || nt) + (this._drs.tier < before ? '（这台机器锁不住上一档）' : '（跑得住，爬回去了）'));
          }
        }
      }
      this._fpsN = 0; this._fpsT = 0; this._cpuArr = [];
      this._cadArr = [];
      this._gMin = null; this._gMax = null;
      PERF.window();   // perf 归因与地勤仪表同一个 0.5 s 窗口
    }
    const _frameStart = performance.now();
    PERF.frameStart();
    /* 雨（D4）：雨丝雨量往渲染器送的通道，1.4 s 时间常数淡入淡出 ——
       设置里切天气时雨是"落下来"的，不是瞬间贴上去的。雨刮相位只在雨天推进。 */
    const rainTgt = this.rain ? 1 : 0;
    /* rainSnap 是 dev/shot.js 的取证钩子（与 showcaseDoor 同族）：无头截图
       只跑 5 帧，1.4 s 的淡入曲线还没爬起来画面就拍了 —— 取证时把雨量钉住。 */
    this.rainAmt = this.rainSnap != null ? this.rainSnap
      : (this.rainAmt || 0) + (rainTgt - (this.rainAmt || 0)) * (1 - Math.exp(-(dt || 0) / 1.4));
    this.r.rainAmt = this.rainAmt;
    if (this.rain && dt > 0) this.wiperT += dt;
    /* 雨刮角：0.44 rad 摆幅、0.6 Hz（≈36 次/分，真实快速档量级）。
       θ(t) = 0.22·(1 − cos) —— 0 起摆、0 收尾，静止位就是"收在玻璃下沿"。
       （实拍校准：0.55 rad 的摆幅在第一视角里刷片尖会扫到 TCMS 屏上方，
       视觉上"杆子插进仪表台"，收到 0.44 才读得出是雨刮。） */
    this.wiperAngle = this.rain ? 0.22 * (1 - Math.cos(2 * Math.PI * 0.6 * this.wiperT)) : 0;
    /* 天光随一局运行前进（1 实秒 = 1 模拟秒）。菜单/观景不动 ——
       只有真在跑一局，"外面"才会从黄昏走到夜。 */
    if (this.running && dt > 0) this.clock += dt;
    if (this.showcase && !this.running) this.showcase.t += dt;

    const s = this.running && this.session ? this.session.s : (this.showcase ? this.showcase.s : 200);
    PERF.mark('sim');
    if (this.running && this.session && dt > 0) {
      this.session.update(dt);
      /* AI 车队跟着跑。玩家是这条链上的一列普通车：
         被玩家占住的区间，后车必须在信号外扣住（见 Dispatcher.authority）。 */
      if (this.traffic) { this.traffic.playerS = this.session.s; this.traffic.update(Math.min(dt, 0.1)); }
      /* 对向车队同样按 dt 推进。playerS 保持 null：调度器把 playerS 当
         **本线障碍**（authority 的 'player' 占用），而玩家在另一条股道上，
         镜像位置一旦进占用表，对向车会齐刷刷停在"玩家的镜像点"后面。 */
      if (this.opp) this.opp.update(Math.min(dt, 0.1));
      /* 套跑对侧车队（第 121 条）：玩家在干线上时它是一列真实障碍（两个交路共用
         同一段轨道电路），玩家拐进自己那条尾巴之后就**不是**了 —— 把玩家里程
         原样喂给对侧，等于在干线上凭空钉一个占用，把对侧车队扣在玩家根本
         不在的地方。 */
      if (this.alt) {
        this.alt.playerS = this.session.s <= this.alt.forkS ? this.session.s : null;
        this.alt.update(Math.min(dt, 0.1));
      }
      /* 站台人群跟着客流走（第 101 条）。放在 session.update 之后：
         这一帧的乘降已经推进过，读到的候乘人数才是最新的。 */
      PERF.mark('crowd');
      this.syncCrowd(dt);
      /* HUD 更新限频到 15 Hz（111-6 稳帧）：每帧一次 updateHUD 走几十个 DOM
         读写（getElementById ×N + textContent 比对），重排成本集中砸在帧里；
         候乘/追踪/ATP 这类量 15 Hz 的变化肉眼已经追不上。画面/手柄/时钟照旧。 */
      this._hudT = (this._hudT || 0) + dt;
      if (this._hudT >= 1 / 15) { this._hudT = 0; this.ui.updateHUD(); }
    }
    /* 司机台屏：每帧调，但内部按"文字真的变了"才重传纹理。
       放在 begin() 之前 —— 同一帧就要看到新画面，否则永远慢一帧。 */
    PERF.mark('screens');
    this.drawCab();
    this.drawGauges();
    this.updatePtd();
    if (this.showcase && !this.running) { this.showcase.s += Math.sin(this.time * 0.11) * 0.06; }

    /* 纵向加速度 → 视野俯仰的平滑 + 环视目标的一阶跟随。
       拖拽/键盘改的是目标值（yawT/pitchT），视线以 τ≈70 ms 的一阶滞后跟上：
       手部微抖不会变成画面微抖，松开拖拽或按 Home 回中也是顺滑回位。
       acc 同理：级位换挡的加速阶跃不再直接砸在视野俯仰上。 */
    if (dt > 0) {
      const accRaw = this.running && this.session ? (this.session.tr.a || 0) : 0;
      this._accSm = (this._accSm || 0) + (accRaw - (this._accSm || 0)) * Math.min(1, dt * 2.2);
      const lk = this._lookKey;
      if (lk && (lk.yaw || lk.pitch)) {
        this.yawT = C((this.yawT == null ? this.yaw : this.yawT) + lk.yaw * dt * 1.9, -1.5, 1.5);
        this.pitchT = C((this.pitchT == null ? this.pitch : this.pitchT) + lk.pitch * dt * 1.4, -0.65, 0.75);
      }
      if (this.yawT == null) { this.yawT = this.yaw; this.pitchT = this.pitch; }
      const kLook = Math.min(1, dt * 15);
      this.yaw += (this.yawT - this.yaw) * kLook;
      this.pitch += (this.pitchT - this.pitch) * kLook;
    }

    PERF.mark('cam');
    const cam = this.camera();
    const env = this.envFor(s);
    PERF.mark('begin');
    this.r.begin(cam, env, dt);
    PERF.mark('world');
    const IDENT = IDENT_M;
    // 远景地面：贴着相机脚下的 XZ 位置平移，高度取线路基准面。
    // 基准是 `al.groundY(s) + SH.STREET_Y − 0.4`，与烘焙街面（al.streetDy）**同源**：
    // 差 0.4 m 是为了永远在街面之下 —— 以前这里用平滑轨面、街面用局部轨面，
    // 最多差到 3.5 m，那张平面就把整条街连标线一起盖掉了（行人机位里的"一片平地"）。
    // 水面（landmark 的 WATER_Y）比它高约 0.8 m，所以过河时水面盖在地面之上，
    // 不需要在地面上挖洞。
    const gf = this.line.al.frame(s);
    /* 跟随地面的高度：轨面下 **12.2 m**。
       这块平面是"走廊以外的地形"，它必须同时满足两件事：
         · 不能高于街面（−10.9）与楼脚基座底（−12.1），否则会把
           烘焙出来的街道、楼群、以及地标的**水面**整个盖住；
         · 不能低于街面太多，否则横向 55 m 外会出现一道悬崖，
           楼看起来又悬空了。
       以前取 −11.0，与水面（轨面下 10.2 m）只差 0.8 m。而这块平面是**平的**、
       轨面沿线有坡度，两者在几百米外就能错开一两米 —— 淀山湖、黄浦江
       就是这样被埋到地面底下，观景机位拍出来是一片街区、没有水。
       现在留 2.0 m 余量，同时 −12.2 仍然低于楼脚暗带的底（−12.1），
       基座照样落地。 */
    /* 跟随地面的高度：**平滑地面基准下 11.3 m**。
       两个数都是量出来的：
       · 为什么用 groundY 而不是相机脚下的真实轨面 —— 这块平面是"地形"，
         地形不该跟着高架的纵断面起伏；按真实轨面取高时，900 m 外两者能差
         十几米，远景楼群整排飘在半空（17 号线追拍实测）。
       · 为什么是 11.3 而不是原来的 12.2 —— 烘焙街面在轨面下 10.9，
         差 1.3 m 就是一条看得见的悬崖：深色沥青走廊的边缘把整片地面切掉，
         楼群脚下再干净也白搭。留 0.4 m 高差足够避免 z-fighting，
         又在雾和黄昏光线下看不出来。楼群基座取 −11，正好被这块面压住
         0.3 m，所以既不会飘也不会露缝。 */
    const GQ = 400;   // 平移量按贴图周期 400 m 取整：否则这块无缝地面会跟着车"爬行"
    const GM = m4trs([Math.round(gf.p[0] / GQ) * GQ, this.line.al.groundY(s) + SH.STREET_Y - 0.4, Math.round(gf.p[2] / GQ) * GQ], [1, 1, 1]);
    for (const b of this.world.ground) this.r.draw(b, GM);
    /* 信号显示是**算出来的**：与调度器的防护距离读同一张占用表（`Dispatcher.aspectAt`），
       所以"一架绿灯正对着被占用的分区"这种说谎画面在结构上不可能出现。 */
    const sigEmi = signalLighting(this.traffic);
    /* 站台信息屏：只画玩家所在站的那一块（贴错站的倒计时比没有屏更糟） */
    if (this.district && this.district.ptd) {
      const show = this.ptdIdx;
      for (const g of this.district.ptd) {
        if (g.idx != null && show != null && g.idx !== show) continue;
        for (const b of g.b) this.r.draw(b, IDENT);
      }
    }
    /* 屏蔽门状态灯（B3）：按站给状态 —— 玩家所在站跟玩家自己的门，
       AI 车停靠的站跟 AI 车（dwelling 的 t.next−1 是它的停站站序）。
       绿灯亮 = 关闭到位；琥珀亮 = 门在动。绿/琥珀互斥，灭档不是 0。 */
    {
      const aiOpen = new Set();
      if (this.running && this.traffic) for (const t of this.traffic.trains) if (t.open > 0.03) aiOpen.add(t.next - 1);
      /* 玩家所在站：行车中是 session 的目标站；展示/取证模式（dev/shot.js 的
         DOORS=）没有 session，退到 ptdIdx（最近的站）+ showcaseDoor ——
         否则取证永远只能拍到"绿灯"那一种状态。 */
      /* ptdIdx 在 showcase（无调度器）下不更新 —— 取证状态直接由 showcase.s 算 */
      const stIdx = this.running && this.session ? this.session.i0 + this.session.leg + 1
        : (this.showcase ? this.line.nearStation(this.showcase.s).i : null);
      const playerOpen = this.session ? this.session.open > 0.03 : (this.showcaseDoor || 0) > 0.03;
      const isOpen = i => (i === stIdx ? playerOpen : aiOpen.has(i));
      if (this.district) {
        for (const g of (this.district.psdLampG || [])) { const k = isOpen(g.i) ? 0.05 : 2.6; for (const b of g.b) this.r.draw(b, IDENT, { emi: k }); }
        for (const g of (this.district.psdLampA || [])) { const k = isOpen(g.i) ? 2.4 : 0.05; for (const b of g.b) this.r.draw(b, IDENT, { emi: k }); }
      }
    }
    for (const b of this.r.batches) {
      /* 'street' 必须排除：街面车流的网格是**以车为中心、+z 车头**的局部坐标，
         只有 street.draw() 逐实例矩阵那条路径能把它摆到路上。留在这个通用循环里，
         等于把 10 个变体全部按单位阵画在世界原点 —— 一摞穿模的车叠在 (0,0,0)，
         而批次统计与 draw call 数看起来完全正常（与 `Builder.finish()` 返回数组
         被整个传进 r.draw 是同一族错）。 */
      if (b.tag === 'train' || b.tag === 'ground' || b.tag === 'ptd' || b.tag === 'psdlampG' || b.tag === 'psdlampA' || b.tag === 'street') continue;
      if (b.bbox && !this.r.boxInFrustum(b.bbox.min, b.bbox.max, 20)) continue;
      if (b._sig) { this.r.draw(b, IDENT, { emi: sigEmi(b._sig) }); continue; }
      if (b.tag === 'psd') {
        // 屏蔽门活动页：沿站台切线平移
        const st = this.district && this.district.stationInfo && this.district.stationInfo[0];
        const open = this.running && this.session ? this.session.open : 0;
        let M = IDENT;
        if (st && st.psdAxis && open > 0.001) {
          const a = open * 0.70, ax = st.psdAxis, sg = st.psdSide;
          M = m4trs([-ax[0] * a * sg, -ax[1] * a, -ax[2] * a * sg], [1, 1, 1]);
        }
        this.r.draw(b, M);
        continue;
      }
      this.r.draw(b, IDENT);
    }
    this.r.cabView = this.view === 'cab';
    // 光束强度随"有多露天"衰减：全地下 1.0，全高架 0
    this.r.beamOn = 1 - this.line.openness(s);
    /* showcaseDoor 是 dev/shot.js 的取证开关（展示模式里把车门开到指定开度）。
       没有它，站台机位永远拍到的是关门的车，而"客室"这件事只在门开或从窗外
       斜看时才成立 —— 也就是说没有这个开关就永远验不了门与客室的对位。 */
    const doorOpen = this.running && this.session ? this.session.open : (this.showcaseDoor || 0);
    /* 车内乘客的人数由**满载率**决定：玩家车读客流模型，AI 车读调度器自己的车载
       （`Railcar.load`，与时段同源）。两端都空着的时候，站台上看过去
       一列一列全是空车，而 HUD 上写着 118% —— 两件事对不上。 */
    const myFill = (this.session && this.session.pax) ? this.session.pax.fill() : 0;
    this.trainView.now = this.time;
    this.trainView.draw(s, doorOpen,
      this.session ? { notch: this.session.tr.notch, lamps: cabLampState(this.session), fill: myFill,
        doorsOpen: this.session.doors, wiper: this.wiperAngle || 0, fix: this._cabFix }
        : { fill: this.showcaseFill || 0, doorsOpen: false, wiper: this.wiperAngle || 0, fix: this._cabFix });
    /* 邻线列车：只画看得见的。一列 8A 是 24 批 × 3 组，把 26 列全画会吃掉整帧预算，
       而地下段的远裁剪面只有 900 m —— 2 km 外的车根本不会出现在画面里。 */
    if (this.traffic && this.running) {
      const maxDist = this.line.isElevated(s) ? 2200 : 900;
      for (const t of this.traffic.visible(s, maxDist))
        this.trainView.drawExternal(t.s, t.open, t.load, t.state === 'hold', t.idx);
      /* 套跑对侧车队：只画**还在干线上**的那些。对侧拐进自己的尾巴之后，
         本线烘焙窗口里根本没有那段轨道 —— 硬画会让一列车凭空横穿画面，
         而"在分岔口消失"正是站台上看一列支线车离开的真实样子。 */
      if (this.alt) {
        for (const t of this.alt.visible(s, maxDist)) {
          if (t.s > this.alt.forkS) continue;
          this.trainView.drawExternal(t.s, t.open, t.load, t.state === 'hold', t.idx + 500);
        }
      }
      /* 对向列车（第 108 条 双线断面）：镜像里程 total − t.s → 真实里程，
         画在 −side × SH.TRACK_OFFSET 的对向股道上。双洞隧道与基地里没有
         对向轨，按 oppVisible（与 buildRuns 的烘焙判据同语义）跳过 ——
         对向车在洞口出现/消失，正好被洞口几何接住。 */
      if (this.opp) {
        const total = this.line.al.total;
        for (const t of this.opp.visible(total - s, maxDist)) {
          const sr = total - t.s;
          if (!this.line.oppVisible(sr)) continue;
          this.trainView.drawExternalOpp(t.s, t.open, t.load, t.state === 'hold', t.idx);
        }
      }
    }
    /* 道路车流：露天段的街面上有车在跑 —— 与 AI 列车同一套"预烘网格 +
       逐实例矩阵"机制，只画相机 480 m 内**且在视锥里**的车、单变体 cap 16 辆。
       天黑档与时段密度都从**已经在用的那一份真值**取：
       `env.night`（天光插值）与 `SH.pax.rushFactor`（客流用的同一个系数）。
       密度映射：夜间 0.35→抽 51%、平峰 ~1.0→80%、晚高峰 1.75→全给。
       街上的车与车里的人是同一座城市的同一件事，不该各写一张表。 */
    if (this.street) {
      /* 传玩家里程：街面车流按"近档全量 / 远档每 4 帧并一次"分级推进
         （`street.js` 的 NEAR_S = 1500 m，是画程 480 m 的三倍，画面上任何一辆车
         都在近档里）。离线判据不传这个参数 ⇒ 一律全量，分级不许影响任何一条判据。 */
      this.street.update(dt, this.session ? this.session.s : null);
      const camInfo = this.camera();
      const rush = SH.pax && SH.pax.rushFactor ? SH.pax.rushFactor(this.hourNow, this.rain) : 1;
      this.street.draw(this.r, camInfo.eye, env.night == null ? 0 : env.night,
        Math.min(1, 0.35 + 0.45 * rush));
      /* 路口信号灯的亮着那一枚：灯箱是烘焙体（不会变色），镜片按 `SH.roadLamp`
         每帧实例化贴上去 —— 与铁路信号机同一套"暗体烘死、灯头运行时画"的做法。 */
      this.street.drawSignals(this.r, camInfo.eye, env.night == null ? 0 : env.night);
      /* 实例对账：`_expect`（分组后按 cap 应当提交的实例数，由**截断前**的原始
         组大小独立算出）必须等于 `_drawn`（真正提交给 GL 的数量）。
         这条抓的是"分组/截断路径悄悄丢了一组车"，不是重复 cap 的规则本身。 */
      if (this.street._expect !== this.street._drawn && !this._streetWarned) {
        this._streetWarned = 1;
        console.warn('街面车流实例对账不平：应提交 ' + this.street._expect + ' 实提交 ' + this.street._drawn);
      }
    }
    PERF.mark('post');
    this.r.end();
    /* 帧 CPU 耗时采样（地勤仪表用，见 frame() 顶部）。 */
    (this._cpuArr = this._cpuArr || []).push(performance.now() - _frameStart);
    if (this.running && this.session && dt > 0) {
      const tr = this.session.tr;
      this.audio.update({ kmh: tr.kmh, a: tr.a, jerk: tr.jerk, trac: tr.trac, regen: tr.regen, air: tr.air, slip: tr.slip, airBuild: tr.airBuild, s: this.session.s },
        { tunnel: this.line.isElevated(this.session.s) ? 0.05 : 1, curveK: this.session.curveK, doors: this.session.doors }, dt);
    }
    PERF.close();
  }
  bind() {
    const activate = () => { this.audio.init(); this.audio.setEnabled(this.settings.sound !== false); this.audio.setVolume((this.settings.volume == null ? 70 : this.settings.volume) / 100); window.removeEventListener('pointerdown', activate); };
    window.addEventListener('pointerdown', activate, { passive: true });
    global.addEventListener('resize', () => this.r.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.running && !this.paused) this.pause(); });
    const c = this.canvas;
    let drag = false, lx = 0, ly = 0;
    c.addEventListener('pointerdown', e => { drag = true; lx = e.clientX; ly = e.clientY; c.setPointerCapture && c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => { if (!drag) return;
      /* 写目标值，frame() 以一阶滞后跟上（见主循环）：视线顺滑、不接手抖。
         范围放宽到 yaw ±1.5 rad（≈86°，能回头看到侧窗/客室通道门）、
         pitch [−0.65, +0.75]（低头看台面按钮排、抬头看顶棚与瞭望牌）。 */
      this.yawT = C((this.yawT == null ? this.yaw : this.yawT) - (e.clientX - lx) * 0.0035, -1.5, 1.5);
      this.pitchT = C((this.pitchT == null ? this.pitch : this.pitchT) - (e.clientY - ly) * 0.0028, -0.65, 0.75);
      lx = e.clientX; ly = e.clientY; });
    c.addEventListener('pointerup', () => drag = false);
    c.addEventListener('pointercancel', () => drag = false);
  }
  pause() { if (!this.running) return; this.paused = true; this.pa.stop(); document.getElementById('modal-pause').classList.add('is-on'); }
  resume() { document.querySelectorAll('.modal').forEach(m => m.classList.remove('is-on')); this.paused = false; this.last = performance.now(); this.audio.resume(); }
  /** 退出本次运行回菜单。
      原来这里只有 `running=false; session=null; show('select')` 三句，
      **既没清 `paused`，也没关弹层** —— 于是暂停弹窗里点"退出本次运行"之后，
      全局还留着 `paused=true` 与一个 `is-on` 的模态：菜单页的展示相机是同一个
      `frame()` 驱动的，dt 被 `if (this.paused) dt = 0` 钉成 0，
      看起来就是"退了菜单游戏还在跑/弹窗还压在上面"。 */
  quitToMenu() {
    this.paused = false; this.running = false; this.session = null;
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('is-on'));
    this.pa.stop(); this.audio.suspend && this.audio.suspend();
    this.show('select');
  }
  cycleView() {
    const order = ['cab', 'chase', 'scenic', 'headon', 'platform', 'street', 'top'];
    this.view = order[(order.indexOf(this.view) + 1) % order.length];
    this.audio.click();
    const names = { cab: '驾驶室', chase: '追尾', scenic: '观景', headon: '正面', platform: '站台', top: '俯瞰' };
    const el = document.getElementById('view-name'); if (el) el.textContent = names[this.view];
  }
}

/* ==================================================================== UI */
class UI {
  constructor(app) { this.app = app; this.build(); this.bind(); this.syncSelect(); }
  build() {
    const app = this.app;
    const ll = document.getElementById('line-list');
    ll.innerHTML = '';
    for (const k in app.lines) {
      if (k.indexOf('#') >= 0) continue;      // 支线是同一张卡片的另一个交路，不重复列
      const L = app.lines[k];
      const b = document.createElement('button');
      b.className = 'line-card'; b.dataset.line = k; b.style.setProperty('--c', L.color);
      b.innerHTML = '<b>' + L.name + '</b><small>' + L.stock.type + ' · 限速 ' + L.runKmh + 'km/h<br>' + L.stations.length + ' 站</small>';
      ll.appendChild(b);
    }
    const ml = document.getElementById('mode-list'); ml.innerHTML = '';
    for (const k in MODES) {
      const b = document.createElement('button'); b.className = 'mode-card'; b.dataset.mode = k;
      b.innerHTML = '<b>' + MODES[k].name + '</b><p>' + MODES[k].desc + '</p>'; ml.appendChild(b);
    }
    const lt = document.getElementById('lever-ticks'); lt.innerHTML = '';
    SH.physics.NOTCHES.forEach((n, i) => {
      const e = document.createElement('span'); e.className = 'lever-tick' + (n.kind === 'power' ? ' pwr' : n.kind === 'brake' ? ' brk' : '');
      e.dataset.notch = n.v; e.style.top = (i / (SH.physics.NOTCHES.length - 1) * 92 + 4) + '%'; e.textContent = n.label; lt.appendChild(e);
    });
  }
  bind() {
    const app = this.app;
    const act = a => {
      switch (a) {
        case 'go-select': app.show('select'); this.syncSelect(); break;
        case 'back-home': app.running = false; app.session = null; app.show('home'); app.bakeShowcase(); break;
        case 'back-select': app.show('select'); this.syncSelect(); break;
        case 'help': this.modal('help', true); break;
        case 'settings': this.modal('settings', true); break;
        case 'close-modal': this.modal(null); break;
        case 'begin': app.begin(); break;
        case 'pause': app.pause(); break;
        case 'resume': app.resume(); break;
        case 'quit': app.quitToMenu(); break;
        case 'again': app.begin(); break;
        case 'notch-up': app.session && app.session.setNotch(app.session.tr.notch + 1); break;
        case 'notch-down': app.session && app.session.setNotch(app.session.tr.notch - 1); break;
        case 'open-door': app.session && app.session.openDoors(); break;
        case 'close-door': app.session && app.session.closeDoors(); break;
        case 'depart': app.session && app.session.depart(); break;
        case 'emergency': app.session && app.session.emergency(); break;
        case 'release-eb': app.session && app.session.releaseEB(); break;
        case 'horn': app.audio.init(); app.audio.horn(); break;
        case 'view': app.cycleView(); break;
        case 'hud-zen': this.setZen(); break;
        case 'sta-prev': this.shift(-1); break;
        case 'sta-next': this.shift(1); break;
        case 'save-card': this.saveCard(); break;
        case 'share': this.share(); break;
      }
    };
    const route = e => {
      const a = e.target.closest('[data-act]'); if (a) { act(a.dataset.act); return; }
      const l = e.target.closest('[data-line]'); if (l) { app.setLine(l.dataset.line); return; }
      const m = e.target.closest('[data-mode]'); if (m) { app.mode = m.dataset.mode; app.saveSettings(); this.syncSelect(); return; }
      const g = e.target.closest('[data-legs]'); if (g) { app.legs = +g.dataset.legs; app.saveSettings(); this.syncSelect(); return; }
      const hrg = e.target.closest('[data-hour]'); if (hrg) { app.hour = +hrg.dataset.hour; app.saveSettings(); this.syncSelect(); return; }
      const v = e.target.closest('[data-svc]'); if (v) { app.setService(v.dataset.svc); return; }
      const q = e.target.closest('[data-q]'); if (q) { app.r.setQuality(q.dataset.q); app.saveSettings(); this.syncSelect(); return; }
      /* 分辨率与画质分开响应：这里只动**上限**那一档，特效链一格都不碰。
         改完必须重开 DRS —— 上限换了，旧的"这档跑不动"名单就不再成立。 */
      const rz = e.target.closest('[data-r]'); if (rz) { app.r.setRes(rz.dataset.r); app.resetDrs(); app.saveSettings(); this.syncSelect(); return; }
      const ra2 = e.target.closest('[data-resauto]');
      if (ra2) {
        app.r.setResAuto(ra2.dataset.resauto === '1'); app.resetDrs(); app.saveSettings(); this.syncSelect();
        app.toast(app.r.resAuto ? '自适应分辨率：跑不动自动降一档，跑得动再爬回来' : '自适应分辨率已关闭，锁定在所选档位');
        return;
      }
      const w = e.target.closest('[data-w]');
      if (w) {
        app.rain = w.dataset.w === 'rain';
        app.audio.init(); app.audio.setRain(app.rain ? 1 : 0);
        app.saveSettings(); this.syncSelect();
        app.toast(app.rain ? '雨天：湿轨黏着下降，制动距离变长' : '天气已切换为晴天');
        return;
      }
    };
    document.addEventListener('pointerup', route);
    /* 键盘激活按钮（Enter/Space）只派发 click、不派发 pointerup，所以按键盘
       完全点不动——无障碍上是硬伤，脚本化自测也点不进去。真实鼠标/触摸的
       click 一定跟在 pointerup 后面，再跑一遍就会把 起始站/档位 这类步进
       动作走两格，因此只认 detail===0 的 click（规范里键盘合成的 click 就是 0）。 */
    document.addEventListener('click', e => { if (e.detail === 0) route(e); });
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) this.modal(null); }));
    /* 手柄拖拽 */
    const tr = document.getElementById('lever-track');
    let dragging = false;
    const apply = ev => {
      const r = tr.getBoundingClientRect();
      const y = C(ev.clientY - r.top, 0, r.height);
      const i = Math.round(y / r.height * (SH.physics.NOTCHES.length - 1));
      app.session && app.session.setNotch(SH.physics.NOTCHES[i].v);
    };
    tr.addEventListener('pointerdown', e => { dragging = true; tr.setPointerCapture && tr.setPointerCapture(e.pointerId); apply(e); });
    tr.addEventListener('pointermove', e => { if (dragging) apply(e); });
    tr.addEventListener('pointerup', () => dragging = false);
    /* 低速对位 */
    ['back', 'fwd'].forEach(k => {
      const el = document.querySelector('[data-repo="' + k + '"]');
      if (!el) return;
      const dir = k === 'back' ? -1 : 1;
      el.addEventListener('pointerdown', e => { e.preventDefault(); const s = this.app.session; if (s && s.phase === 'stopped' && !s.doors) { s._repo = dir; } });
      const stop = () => { const s = this.app.session; if (s && s._repo) { s._repo = 0; s._judge && s.app.showJudge(s._judge()); } };
      el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
    });
    /* 设置 */
    const bindInput = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('input', () => fn(e)); e && (e.onchange = () => fn(e)); };
    bindInput('set-sound', e => { app.audio.init(); app.audio.setEnabled(e.checked); app.saveSettings(); });
    bindInput('set-voice', e => { app.pa.setEnabled(e.checked); app.saveSettings(); });
    bindInput('set-atp', () => { app.saveSettings(); });
    bindInput('set-volume', e => { app.audio.init(); app.audio.setVolume(+e.value / 100); document.getElementById('vol-num').textContent = e.value; app.saveSettings(); });
    /* 闲置淡出 + 专注模式（纯界面行为，不碰行车）：
       开车时几秒不碰屏幕，HUD 自动淡下去把视野还给司机，任何指针/键盘动作立即唤回；
       专注模式只留速度/级位/车门，状态跨局记住。 */
    const gameEl = document.getElementById('screen-game');
    if (gameEl) {
      let dimT = null;
      const wake = () => {
        gameEl.classList.remove('hud-dim');
        clearTimeout(dimT);
        dimT = setTimeout(() => { if (app.running && !app.paused) gameEl.classList.add('hud-dim'); }, 5000);
      };
      ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(ev => window.addEventListener(ev, wake, { passive: true }));
      wake();
      try { if (localStorage.getItem('shmetro-hudzen')) this.setZen(true); } catch (e) {}
    }
    /* 键盘 */
    if (!matchMedia || matchMedia('(pointer:fine)').matches) {
      const down = {};
      window.addEventListener('keydown', e => {
        if (!app.running) return;
        const k = e.key;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' '].indexOf(k) >= 0) e.preventDefault();
        if (down[k]) return; down[k] = 1;
        const s = app.session; if (!s) return;
        if (k === 'ArrowUp') s.setNotch(s.tr.notch + 1);
        else if (k === 'ArrowDown') s.setNotch(s.tr.notch - 1);
        /* 键盘环视：按住转动（frame() 积分），Home 回中。
           方向与拖拽一致：拖向左/按 ← 都是"视线往左走"。 */
        else if (k === 'ArrowLeft') app._lookKey = Object.assign(app._lookKey || {}, { yaw: 1 });
        else if (k === 'ArrowRight') app._lookKey = Object.assign(app._lookKey || {}, { yaw: -1 });
        else if (k === 'PageUp') app._lookKey = Object.assign(app._lookKey || {}, { pitch: 1 });
        else if (k === 'PageDown') app._lookKey = Object.assign(app._lookKey || {}, { pitch: -1 });
        else if (k === 'Home') { app.yawT = 0; app.pitchT = 0; }
        else if (k === 'd' || k === 'D') s.depart();
        else if (k === 'o' || k === 'O') s.openDoors();
        else if (k === 'c' || k === 'C') s.closeDoors();
        else if (k === 'e' || k === 'E') s.emergency();
        else if (k === 'r' || k === 'R') s.releaseEB();
        else if (k === 'h' || k === 'H' || k === 'Enter') { app.audio.init(); app.audio.horn(); }
        else if (k === 'v' || k === 'V') app.cycleView();
        else if (k === ' ') app.paused ? app.resume() : app.pause();
        /* Esc 以前没有任何绑定：暂停弹窗只能用鼠标点"继续驾驶"，
           而驾驶时双手都在键盘上，退出暂停反而要去摸鼠标。 */
        else if (k === 'escape') { if (app.running) app.paused ? app.resume() : app.pause(); }
      });
      window.addEventListener('keyup', e => {
        down[e.key] = 0;
        /* 键盘环视的松开：哪个方向键松了就停哪个分量 */
        if (app._lookKey) {
          if (e.key === 'ArrowLeft' && app._lookKey.yaw > 0) app._lookKey.yaw = 0;
          if (e.key === 'ArrowRight' && app._lookKey.yaw < 0) app._lookKey.yaw = 0;
          if (e.key === 'PageUp' && app._lookKey.pitch > 0) app._lookKey.pitch = 0;
          if (e.key === 'PageDown' && app._lookKey.pitch < 0) app._lookKey.pitch = 0;
        }
      });
    }
  }
  modal(name) { document.querySelectorAll('.modal').forEach(m => m.classList.remove('is-on')); if (name) document.getElementById('modal-' + name).classList.add('is-on'); }
  /* 专注模式：把控制台收成"速度 / 级位 / 车门"一条，视野最大化。状态跨局记住。 */
  setZen(v) {
    const g = document.getElementById('screen-game'); if (!g) return;
    const on = v == null ? !g.classList.contains('hud-zen') : !!v;
    g.classList.toggle('hud-zen', on);
    try { localStorage.setItem('shmetro-hudzen', on ? '1' : ''); } catch (e) {}
  }
  shift(d) {
    const app = this.app;
    app.startIdx = (app.startIdx + d + app.line.stations.length - 1) % (app.line.stations.length - 1);
    app.saveSettings(); this.syncSelect();
  }
  syncSelect() {
    const app = this.app, L = app.line;
    document.querySelectorAll('.line-card').forEach(b => b.classList.toggle('is-on', b.dataset.line === app.lineId));
    /* 交路（主线 / 支线）。以前支线的站名只活在 _note 的一句话里，于是车头目的地屏、
       站牌、走字屏、报站永远报主线终点站。选支线之后这些全部跟着换终点站。 */
    const sf = document.getElementById('svc-field'), sl = document.getElementById('svc-list');
    const dd = SH.LINES[app.lineId];
    if (sf && sl) {
      if (!dd || !dd.branch) sf.style.display = 'none';
      else {
        sf.style.display = '';
        const bs = dd.branch.stations[dd.branch.stations.length - 1];
        sl.innerHTML = [['main', '主线 ' + dd.stations[0] + ' ↔ ' + dd.stations[dd.stations.length - 1]],
          ['branch', '支线 ' + dd.stations[0] + ' ↔ ' + bs]]
          .map(p => '<button data-svc="' + p[0] + '"' + (app.service === p[0] ? ' class="is-on"' : '') + '>' + p[1] + '</button>').join('');
      }
    }
    document.querySelectorAll('.mode-card').forEach(b => b.classList.toggle('is-on', b.dataset.mode === app.mode));
    /* 连续驾驶：选中态比的是**意图**（app.legs，全程永远是 99），不是本次实际段数；
       同时把"全程"实时写成"全程 · N 站"，让人在点之前就知道从当前这个站出发
       全程到底是几站——靠近终点时它确实只有一两站，但那是明说的，不是偷偷降级。 */
    const maxLegs = SH.legsPlan(app.legs, app.startIdx, L.stations.length).max;
    document.querySelectorAll('#leg-seg button').forEach(b => {
      const n = +b.dataset.legs;
      b.classList.toggle('is-on', n >= 99 ? app.legs >= 99 : n === app.legs);
      if (n >= 99) b.textContent = '全程 · ' + maxLegs + ' 站';
    });
    document.querySelectorAll('#quality-seg button').forEach(b => b.classList.toggle('is-on', b.dataset.q === app.r.quality));
    document.querySelectorAll('#res-seg button').forEach(b => b.classList.toggle('is-on', b.dataset.r === app.r.resTier));
    document.querySelectorAll('#auto-seg button').forEach(b => b.classList.toggle('is-on', (b.dataset.resauto === '1') === !!app.r.resAuto));
    document.querySelectorAll('#weather-seg button').forEach(b => b.classList.toggle('is-on', (b.dataset.w === 'rain') === !!app.rain));
    /* 时段：选中态比的是**落在哪一档**（夜间 0~6、平峰 7~16、晚高峰 17~19、
       早高峰 6~8），而不是那个整数本身 —— 否则"早高峰"按钮在 hour=7 时
       不亮、hour=8 时亮，而两者在客流模型里是同一档。 */
    const band = h => (h >= 22 || h < 5) ? 2 : h >= 7 && h <= 9 ? 7 : h >= 17 && h <= 19 ? 18 : 13;
    document.querySelectorAll('#hour-seg button').forEach(b => b.classList.toggle('is-on', +b.dataset.hour === band(app.hour)));
    const hd = document.getElementById('hour-desc');
    if (hd) {
      const rf = SH.pax.rushFactor(app.hour);
      hd.textContent = '客流与 AI 车载同源 · 当前系数 ×' + rf.toFixed(2)
        + ' · 定员 ' + (SH.pax.capacity(L.stock).aw2) + ' 人';
    }
    const nm = document.getElementById('sta-name'), en = document.getElementById('sta-en');
    if (nm) { const i = app.startIdx; nm.textContent = L.stations[i]; en.textContent = (SH.EN[L.stations[i]] || '') + '  →  ' + L.stations[i + 1]; }
    const t = document.getElementById('train-title');
    if (t) t.textContent = L.name + ' · ' + L.stock.type + ' ' + L.stock.formation
      + (L.uto ? (app.mode === 'manual' ? ' · UTO 线，人工接管即 RM 限速 25' : ' · UTO 全自动运行') : '');
    const d = document.getElementById('train-desc');
    if (d) d.textContent = '车宽 ' + L.stock.width.toFixed(2) + ' m · ' + L.stock.doors + ' 对车门/侧 · 限速 ' + L.runKmh + ' km/h · ' + (L.screen === 'full' ? '全高屏蔽门' : L.screen === 'half' ? '半高安全门' : '无');
    const sw = document.getElementById('train-swatch'); if (sw) sw.style.setProperty('--line', L.color);
    const vm = document.getElementById('vehicle-meta'); if (vm) vm.textContent = L.stock.type + ' · ' + L.stock.cars + '节 · 限速 ' + L.runKmh + ' km/h';
  }
  syncLever() {
    const app = this.app; if (!app.session) return;
    const v = app.session.tr.notch, i = SH.physics.NOTCHES.findIndex(n => n.v === v);
    const k = document.getElementById('lever-knob'); if (k) k.style.top = (C(i, 0, 13) / 13 * 92 + 4) + '%';
    const hs = document.getElementById('handle-state'); if (hs) hs.textContent = SH.physics.NOTCHES[Math.max(0, i)].label;
    document.querySelectorAll('.lever-tick').forEach(e => e.classList.toggle('is-on', +e.dataset.notch === v));
  }
  updateHUD() {
    const app = this.app, s = app.session; if (!s) return;
    const tr = s.tr;
    /* 元素引用按"找得到就缓存"——每帧几十次 getElementById 本身就是成本
       （111-6 稳帧：配合调用点的 15 Hz 限频）。 */
    if (!this._hudE) this._hudE = {};
    const $ = id => this._hudE[id] || (this._hudE[id] = document.getElementById(id));
    const set = (id, v) => { const e = $(id); if (e && e.textContent !== String(v)) e.textContent = v; };
    /* HUD 只保留 **TCMS 屏上没有的**量（限速/加速度/满载/候乘/追踪/ATP）：
       速度、缸压、距停车标、级位、车门、ATO 工况都在司机中控屏与两只机械圆表上，
       界面再做一份就是"两块表各说各话"的第二次机会。 */
    set('hud-limit', s.limit);
    set('hud-accel', tr.a.toFixed(2));
    if (s.pax) {
      set('hud-load', s.pax.pct());
      const lf = $('hud-load-fill');
      if (lf) { const f = C(s.pax.fill() / 1.32, 0, 1); lf.style.width = (f * 100).toFixed(0) + '%'; lf.style.background = f > 0.78 ? '#ff6b6b' : f > 0.58 ? '#ffc451' : '#5fe0b0'; }
      const wi = s.i0 + s.leg + 1, wn = s.line.stations[wi];
      set('hud-wait', wn ? s.pax.waitingAt(wn, wi) : '—');
    }
    /* 追踪列车：司机该知道的"前方占用"，也是行车调度在界面上看得见的输出。 */
    if (app.traffic) {
      const a = app.traffic.aheadOfPlayer(), b = app.traffic.behindPlayer();
      const fmt = v => v >= 1000 ? (v / 1000).toFixed(1) + ' km' : Math.round(v) + ' m';
      set('hud-follow', (a ? '前 ' + fmt(a.dist) : '前方通畅') + ' · ' + (b ? '后 ' + fmt(b.dist) : '后方无车'));
    }
    /* HUD 的 ATP 格子必须区分"防护动作"和"只是超速"：
       ATP 关着的时候显示"制动/紧急"是假信息——没有任何东西在制动。 */
    const atpOn = !!(app.settings && app.settings.atp);
    set('hud-atp', !tr.atp ? (atpOn ? '监控' : '正常')
      : atpOn ? (tr.atp === 2 ? '紧急' : '制动')
      : (tr.atp === 2 ? '严重超速' : '超速'));
    const atp = $('hud-atp'); if (atp) atp.style.color = tr.atp ? '#ff6b6b' : '#7fe7ff';
    this.syncLever();
    /* 走字屏 */
    const idx = s.i0 + s.leg;
    set('led-line', app.line.name);
    /* 钟点：与天光、站台屏同源（`App.clock`）。玩家看一眼就知道现在几点，
       也就知道"天该黑了没有"——这是"时间是活的"在界面上的直接证据。
       后面挂上**正点偏差**（第 103 条）：图定时刻表以前只进结算单，
       司机在车上根本看不见自己早了还是晚了；而"跑图"恰恰是司机最主要的日常。 */
    const lateS = Math.round(s.late || 0);
    set('led-clock', app.clockText() + (Math.abs(lateS) > 15 ? (lateS > 0 ? ' 晚点 +' + lateS + 's' : ' 早点 ' + lateS + 's') : ''));
    /* 运行等级上屏：UTO 线在自动/半自动下是全自动运行，玩家一旦接管就是 RM 限制人工。
       非 UTO 线不显示——给有司机的线挂个等级标签是假信息。 */
    const lm = $('led-mode');
    if (lm) {
      const rm = app.line.uto && s.mode === 'manual';
      const lv = app.line.uto ? (rm ? 'RM 限制人工' : 'UTO 全自动') : '';
      if (lm.textContent !== lv) lm.textContent = lv;
      lm.classList.toggle('is-rm', rm);
    }
    set('led-next-label', s.phase === 'running' ? '下一站 NEXT' : '本站 THIS');
    set('led-next-station', s.phase === 'running' ? s.toName : s.fromName);
    set('led-door-text', SH.boardSideAt(s.line, s.line.al.stationS[idx + 1]) > 0 ? '本侧开门' : '对侧开门');
    this.route(idx);
    const ns = $('next-station'); if (ns) ns.textContent = s.toName;
    const en = $('next-en'); if (en) en.textContent = SH.EN[s.toName] || '';
    const tv = $('tv-dist'); if (tv) { tv.textContent = (s.d >= 0 ? '+' : '−') + Math.abs(s.d).toFixed(2) + ' m'; tv.style.color = Math.abs(s.d) <= 0.5 ? '#00e08a' : Math.abs(s.d) <= 2.5 ? '#ffc93c' : '#ff4d5e'; }
    /* 对位俯视图只在"用得上"的时候出现：进站 700 m 内（含停站对位）滑进来，
       巡航在区间里、或刚从始发站开出（距下一站上公里）时收走 —— 以前它常驻
       右上角，离站 2.6 km 也占着一块画面。 */
    const tvp = $('topview'); if (tvp) tvp.classList.toggle('is-live', Math.abs(s.d) < 700);
    const am = $('approach-marker'); if (am) { am.classList.toggle('is-on', s.d < 170 && s.d > -25 && s.phase === 'running'); const md = $('marker-distance'); if (md) md.textContent = (s.d >= 0 ? '' : '+') + Math.abs(s.d).toFixed(0); }
  }
  route(idx) {
    const app = this.app, host = document.getElementById('led-route');
    if (!host) return;
    const W = host.clientWidth || 700, H = host.clientHeight || 40;
    const from = Math.max(0, idx - 2), to = Math.min(app.line.stations.length - 1, idx + 6);
    const n = to - from + 1, pad = 26, gap = (W - pad * 2) / Math.max(1, n - 1);
    const key = [W, H, n, app.lineId, idx, app.session.phase].join('|');
    if (this._rk === key) return;
    this._rk = key;
    const s = app.session;
    const prog = C((s.s - app.line.al.stationS[idx]) / Math.max(1, app.line.al.stationS[idx + 1] - app.line.al.stationS[idx]), 0, 1);
    const cur = s.phase === 'running' ? (idx - from) + prog : (idx - from);
    let out = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    const y = H * 0.5, x = k => pad + k * gap;
    out += '<line x1="' + x(0) + '" y1="' + y + '" x2="' + x(n - 1) + '" y2="' + y + '" class="lr-back"/>';
    out += '<line x1="' + x(0) + '" y1="' + y + '" x2="' + x(Math.max(0, cur)) + '" y2="' + y + '" class="lr-done"/>';
    for (let k = 0; k < n; k++) {
      const nm = app.line.stations[from + k];
      /* 换乘站才画大圆点；**共线同站台不算换乘**（第 102 条）——
         3/4 号线那 8 站在官方图上也不是换乘圈，画成大点是在说谎。 */
      const M = SH.INTER_META && SH.INTER_META[nm];
      const isXfer = M ? M.type !== 'shared' : !!(SH.INTER[nm] && SH.INTER[nm].length > 1);
      const st = k < cur ? 'passed' : (Math.abs(k - cur) < 0.5 ? 'current' : '');
      out += '<circle cx="' + x(k) + '" cy="' + y + '" r="' + (isXfer ? 5.2 : 3.6) + '" class="lr-node ' + st + '"/>';
    }
    out += '</svg><div class="led-labels">';
    for (let k = 0; k < n; k++) {
      const nm = app.line.stations[from + k];
      const st = k < cur ? 'passed' : (Math.abs(k - cur) < 0.5 ? 'current' : '');
      out += '<span class="lr-label ' + st + (k % 2 ? ' lower' : ' upper') + '" style="left:' + (x(k) / W * 100) + '%">' + nm + '</span>';
    }
    out += '</div>';
    host.innerHTML = out;
  }
  renderResult(sum) {
    const $ = id => document.getElementById(id);
    $('res-score').textContent = sum.total;
    $('res-grade').textContent = sum.grade;
    $('res-sub').textContent = sum.line.name + ' · ' + MODES[sum.mode].name + ' · ' + sum.results.length + ' 站完成' +
      (sum.pax ? ' · 运送 ' + sum.pax.boarded + ' 人 / 下车 ' + sum.pax.alighted + ' 人 / 甩客 ' + sum.pax.leftBehind + ' 人' : '') +
      (sum.depot ? ' · 已入库 ' + sum.depot.end : '');
    const host = $('res-list'); host.innerHTML = '';
    sum.results.forEach((r, i) => {
      const e = document.createElement('div'); e.className = 'result-row';
      e.innerHTML = '<b>' + (i + 1) + '. ' + r.station + '</b>' +
        '<span>' + (r.err >= 0 ? '+' : '') + r.err.toFixed(2) + ' m · 平稳 ' + Math.round(r.smooth) +
        (r.pax != null ? ' · 客运 ' + r.pax + ' · 乘降 ' + (r.off + r.on) + ' 人 / 满载 ' + r.load + '%' : '') +
        '</span><em style="color:' + r.color + '">' + r.grade + '</em>';
      host.appendChild(e);
    });
    /* 入库那一行单列：它不是一次"载客停车"，但确实是这一趟的最后一次对位。 */
    if (sum.depot) {
      const e = document.createElement('div'); e.className = 'result-row';
      e.innerHTML = '<b>入库 · ' + sum.depot.end + ' 停车基地</b>' +
        '<span>对位 ' + (sum.depot.err >= 0 ? '+' : '') + sum.depot.err.toFixed(2) + ' m · ' +
        (sum.depot.ok ? '一次停准' : '偏差超 2 m，重新对位') + '</span>' +
        '<em style="color:' + (sum.depot.ok ? '#5fe0b0' : '#ffc451') + '">' + (sum.depot.ok ? 'OK' : 'RE') + '</em>';
      host.appendChild(e);
    }
  }
  saveCard() {
    const sum = this.app.lastSummary; if (!sum) return;
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1440;
    const x = c.getContext('2d'), L = sum.line;
    x.fillStyle = '#07101a'; x.fillRect(0, 0, 1080, 1440);
    const g = x.createLinearGradient(0, 0, 1080, 1440); g.addColorStop(0, L.color); g.addColorStop(1, '#07101a');
    x.globalAlpha = 0.30; x.fillStyle = g; x.fillRect(0, 0, 1080, 1440); x.globalAlpha = 1;
    x.fillStyle = '#9fb8c6'; x.font = '700 26px sans-serif'; x.fillText('SHANGHAI METRO · DRIVER SIM', 70, 96);
    x.fillStyle = '#f2f8fb'; x.font = '800 62px ' + SH.textures.CN_FONT; x.fillText('上海地铁驾驶成绩', 70, 190);
    x.fillStyle = L.color; x.font = '900 210px sans-serif'; x.fillText(String(sum.total), 70, 430);
    x.fillStyle = '#fff'; x.font = '900 66px sans-serif'; x.fillText(sum.grade, 460, 410);
    x.fillStyle = '#96aab6'; x.font = '500 30px ' + SH.textures.CN_FONT; x.fillText(L.name + ' · ' + MODES[sum.mode].name, 74, 500);
    let y = 600;
    sum.results.forEach((r, i) => {
      x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(70, y - 44, 940, 92);
      x.fillStyle = '#e8f2f6'; x.font = '700 30px ' + SH.textures.CN_FONT; x.fillText((i + 1) + '. ' + r.station, 92, y + 8);
      x.fillStyle = r.color; x.fillText(r.grade, 760, y + 8);
      x.fillStyle = '#b9cad3'; x.font = '500 25px sans-serif'; x.textAlign = 'right';
      x.fillText((r.err >= 0 ? '+' : '') + r.err.toFixed(2) + ' m', 1002, y + 8); x.textAlign = 'left';
      if (r.pax != null) {
        x.fillStyle = '#7f96a2'; x.font = '500 22px ' + SH.textures.CN_FONT;
        x.fillText('乘降 ' + (r.off + r.on) + ' 人 · 满载 ' + r.load + '% · 停站 ' + r.dwell + ' s · 客运 ' + r.pax, 420, y + 8);
      }
      y += 112;
    });
    x.fillStyle = L.color; x.fillRect(70, 1280, 940, 6);
    x.fillStyle = '#dce9ef'; x.font = '700 30px ' + SH.textures.CN_FONT; x.fillText('上海地铁驾驶模拟器', 70, 1350);
    x.fillStyle = '#7f96a2'; x.font = '500 22px ' + SH.textures.CN_FONT; x.fillText('把车门精准停到对准屏蔽门', 70, 1392);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'shmetro-score.png'; a.click();
    this.app.toast('成绩卡已导出');
  }
  share() {
    const sum = this.app.lastSummary; if (!sum) return;
    const t = '我在《上海地铁驾驶模拟器》开' + sum.line.name + '跑了' + sum.results.length + '站，平均分 ' + sum.total + '，停车评级 ' + sum.grade + '。你能停进 ±0.3 m 吗？';
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => this.app.toast('分享文案已复制'));
    else this.app.toast(t);
  }
}

/* 广播文案：上海地铁真实句式 */
/* 1 号线全程真实报站音频（玩家提供，56 个 mp3，莘庄→富锦路每站「下一站」+「到站」）。
   文件名 = `assets/pa/l1/NN_站名_类别.mp3`。有录音的走 speakClip（懒加载真实音）；
   没有的线路/站自动回退 speechSynthesis。单点定义：改站点/加线路音频只动这张表。 */
const PA_CLIP = {
  l1: (i, name, kind) => 'assets/pa/l1/' + String(i + 1).padStart(2, '0') + '_' + name + '_' + kind + '.mp3',
};

/* 1 号线报站互斥闸（玩家指示，111-5）：l1 上**只放玩家提供的真实录音**，
   之前的所有 TTS（下一站/到站/进站短句/欢迎/开关门提示）一条不许漏出。
   其余线路不受此闸影响。 */
function paMute(pa, line) { if (line && line.id === 'l1') { try { global.speechSynthesis && global.speechSynthesis.cancel(); } catch (e) {} return true; } return false; }

Object.assign(SH.audio.PA.prototype, {
  welcome(line) { if (paMute(this, line)) return; this.speak('欢迎乘坐上海地铁', 'Welcome to Shanghai Metro'); },
  departing(name, line) {
    /* 发车报下一站：1 号线**只用真实录音**（互斥闸见 paMute）——
       play() 失败就这一条沉默，不再回退系统语音，免得真假两条叠着播。 */
    const stIdx = line && line.stations ? line.stations.indexOf(name) : -1;
    if (line && line.id === 'l1' && stIdx >= 0 && typeof this.speakClip === 'function') {
      this.speakClip(PA_CLIP.l1(stIdx, name, '下一站'), '列车启动，请站稳扶好。下一站，' + name + '。', '');
      return;
    }
    /* 其余线路走系统语音（换乘类型措辞照旧）。 */
    let zh = '列车启动，请站稳扶好。下一站，' + name + '。';
    const inter = SH.INTER[name];
    if (inter && inter.length > 1) {
      const M = SH.INTER_META && SH.INTER_META[name];
      const others = inter.filter(x => x.id !== line.id).map(x => x.name).join('、');
      const tag = !M ? '站内换乘' : M.type === 'out' ? '出站换乘' : M.type === 'shared' ? '同站台' : '站内换乘';
      zh += M && M.type === 'shared'
        ? '本站与' + others + '同站台。'
        : '本站可换乘' + others + '（' + tag + '）。';
    }
    this.speak(zh, 'Please stand firm and hold the handrail. Next station, ' + (SH.EN[name] || name) + '.');
  },
  approaching(name, line, side, inter) {
    /* 进站播报：1 号线互斥（不放 TTS 短句，进站前 250 m 已由真实到站音频接管）。 */
    if (paMute(this, line)) return;
    this.speak('列车即将进站，请退到安全线以内候车。', 'Train approaching. Please stand behind the yellow line.');
  },
  arriving(name, side, line) {
    /* 到站播报：1 号线**只用真实录音**，l1 分支**独占**——没有 TTS 兜底分支。 */
    const stIdx = line && line.stations ? line.stations.indexOf(name) : -1;
    if (line && line.id === 'l1' && stIdx >= 0 && typeof this.speakClip === 'function') {
      this.speakClip(PA_CLIP.l1(stIdx, name, '到站'), '列车已到达' + name + '站。', '');
      return;
    }
    /* 没有录音的线路不播到达（宁可沉默，不让系统语音冒充真实报站）。 */
  },
  doorOpen(line) { if (paMute(this, line)) return; this.speak('请先下后上。请注意站台与列车之间的间隙。', 'Please let passengers get off first. Mind the gap between the train and the platform.'); },
  doorClose(line) { if (paMute(this, line)) return; this.speak('车门即将关闭。请勿倚靠车门。', 'The doors are closing. Do not lean against the doors.'); },
});

SH.App = App; SH.MODES = MODES;
/* 观景点表、构图表、线路实例导出：调试台、截图脚本和 test-facade.js 都要按
 * 里程找地标、要按线路烘世界。不导出的话它们只能从源码里正则抠类名，
 * 换个写法测试就悄悄瞎了。 */
/* 每帧一次的信号点亮器：按分区号缓存显示，回答"这片透镜该给多少 emi"。
   抽成函数而不是写在 draw 循环里 —— 写在循环里的那段接线从来没有离线判据看得见
   （驾驶室手柄的同一条教训：判据要量绘制时才成立的东西，就得能在循环外调用它）。
   没有调度器（关掉邻线列车）时全线给进行信号：那种情形下没有任何东西占用分区，
   画一盏红反而是说谎。 */
/**
 * 站台机位：站在最近车站的站台上，看列车进闸 —— 检验车站烘焙的机位。
 * `s` 必须是**站序里程**：里程标定之后平均站距 2~3 km，`mid=8.2` 那种插值
 * 是离站台几百米的隧道中段，在那里量"站体占多少画面"量不到任何东西。
 * 眼睛高度是**成年乘客的视线**。原来取轨面上方 1.72 m，而站台面本身就在轨面上方
 * 0.44 m —— 等于眼睛只离地面 1.28 m，是个蹲着的小孩；列车车窗带在轨面上方约
 * 1.7~2.7 m，于是这个机位永远看到的是车窗以下那片空白侧墙。现在取 2.10 m
 * （站台面 + 1.66 m 身高），横向退到 4.7 m（黄色安全线外、屏蔽门内侧），
 * 视线沿站台平行于车身看过去，才框得出"一列进站的车"。
 */
SH.platformShot = (line, s, trainS) => {
  const al = line.al;
  const ns = line.nearStation(s);
  /* B 第 2 层：机位站在**站体**那一侧 —— 岛式站上岛在 −side，机位跟到岛上去。 */
  const side = SH.boardSideAt(line, ns.s);
  const look = trainS != null ? trainS : ns.s + 30;
  /* 横向退到 **3.5 m**（站台板中段、屏蔽门内侧、黄线外）。
     原来取 4.7 m，而站台中柱在横向 5.15 m（半宽 0.36，占 4.79~5.51）——
     也就是说**人站在离柱子只有 0.09 m 的地方**，柱子立刻占掉画面左侧三分之一，
     站台信息屏、立柱上的线路色环、地面上的一切都被它挡掉。
     真实的乘客不会站在柱子旁边等车：3.5 m 正是站台板（2.05~5.55）的中间，
     也是屏蔽门前那块最宽的通道。
     ——这一条与第 29 条（眼高 1.72 像个蹲着的小孩）、第 68 条（树冠糊镜头）
     是同一个族的第三次：**"画面里看不见东西"要按投影量，不是按设计意图。**
     横向差 1.2 m，柱子与视线的夹角就从 0.09 rad 变到 0.47 rad。 */
  const fe = al.frame(ns.s + SH.PLAT_CAM.dz);
  const e = al.world(fe, side * SH.PLAT_CAM.lat, SH.PLAT_CAM.eye);
  const ft = al.frame(Math.max(0, Math.min(al.total, look)));
  return { eye: e, target: al.world(ft, side * 2.2, 1.86), fov: 62, near: 0.15, far: 900 };
};

function signalLighting(disp) {
  const live = !!(disp && disp.trains && disp.trains.length);
  const cache = Object.create(null);
  return (sg) => {
    if (!live) {
      /* 没有活调度器（标题页 / 静态截图）：主线绿灯；库区按"空闲库线"显示 ——
         入库信号机月白（允许入库，库线空着）、矮柱调车蓝（无调度指令，禁止动）。
         静态再画红灯就退回了那根"画死的红"—— E3 要杀掉的正是它。 */
      if (sg.kind === 'depotIn') return sg.aspect === 'shunt' ? SH.SIG_EMI.on : SH.SIG_EMI.off;
      if (sg.kind === 'shunt') return sg.aspect === 'shuntStop' ? SH.SIG_EMI.on : SH.SIG_EMI.off;
      return sg.aspect === 'proceed' ? SH.SIG_EMI.on : SH.SIG_EMI.off;
    }
    let a;
    if (sg.kind === 'depotIn') a = disp.blockOccupied(sg.lo, sg.hi, null) ? 'stop' : 'shunt';
    else if (sg.kind === 'shunt') a = disp.shuntRoad() === sg.road ? 'shunt' : 'shuntStop';
    else {
      a = cache[sg.block];
      if (a === undefined) { a = disp.aspectAt(sg.block).key; cache[sg.block] = a; }
    }
    return a === sg.aspect ? SH.SIG_EMI.on : SH.SIG_EMI.off;
  };
}
Object.defineProperty(SH, 'VIEWSPOTS', { get: () => viewspots() }); SH.SHOT = SHOT; SH.LineRuntime = LineRuntime; SH.TrainView = TrainView; SH.World = World; SH.scenicShot = scenicShot; SH.streetShot = streetShot; SH.cabShot = cabShot; SH.cabLampState = cabLampState; SH.signalLighting = signalLighting;
document.addEventListener('DOMContentLoaded', () => {
  try { global.__SH = new App(); }
  catch (e) { SH.fatal('启动失败', (e && e.stack) || String(e)); }
});

})(typeof window !== 'undefined' ? window : globalThis);
