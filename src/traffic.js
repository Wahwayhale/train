/* ============================================================================
 * src/traffic.js — 全线 AI 列车与智能运行调度
 *
 * 为什么 AI 车要复用玩家的同一套物理与 ATO：
 *   如果给 AI 写一条"匀速 + 到站减速"的假运动，那"前方列车占用区间、后方列车
 *   被信号扣在站外"这件事就只能靠编，玩家看到的是一列穿模而过的道具车。
 *   现在 AI 拿的是 `SH.physics.Train`（含空气制动的建立/缓解滞后、再生到
 *   regenFloor 以下转空气、载荷对制动距离的影响）和 `SH.physics.ATO('auto')`
 *   （含按预测停车距离闭环的进站收尾），所以它会像真人司机一样被同一套约束限制。
 *
 * 单线双向的问题：本项目的线路是**一条中心线**（`Alignment` 只有一个中心），
 * 隧道与高架的横断面也只有一条正线。对向车要么穿模、要么贴在洞壁上。
 * 因此这里按"前后同向追踪"建模 —— 这也正是用户描述的场景（"前后都有 AI 开的
 * 列车"）。对向车需要先把线路做成双线断面，那是另一件事。
 *
 * 追踪防护：一列车的**车头**必须停在"前方障碍物 − guard"之前。障碍物是
 *   ① 前行车的车尾（车尾 = 车头里程 − 编组长度），或
 *   ② 玩家列车的车尾（玩家突然停在区间里时，后车要能在信号外扣住），或
 *   ③ 线路终点。
 * 这个 limit 直接当作 ATO 的 `distanceToStop` 之一参与闭环，所以"被扣住"是
 * 算出来的，不是画出来的。
 *
 * 调度（智能运行调整）做三件真实运营在做的事：
 *   1. **头时保持**：停站时分按"与前车的实际间隔 − 目标间隔"增减，
 *      间隔偏大就早走、偏小就多停 —— 这是防止列车自动结队的经典控制。
 *   2. **扣车**：前车占用不足一个 guard 的 2 倍时，本站直接不放行。
 *   3. **折返**：终点站停一个折返时分后回到起点重新投入，保持全线性别均匀。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const C = SH.clamp;

/** 内积分步长（秒）。与 game.js 主循环对 dt 的上夹取同一个数：
 *  调度器每次 `update(dt)` 都被切成不超过 SIM_DT 的子步，
 *  于是离线判据（0.5 s 一步）与游戏（≤0.05 s 一步）跑的是同一套动力学。 */
const SIM_DT = 0.05;

/** **高峰**正线行车间隔（分钟），按公开运行图的量级；磁浮按发车批次而非间隔运行。
 *  实际头时 = 本值 × `SH.headwayFactor(hour)`（平峰 1.3、深夜 2.0）。 */
const HEADWAY = {
  l1: 2.0, l2: 2.5, l3: 4.0, l4: 5.0, l5: 6.0, l6: 4.0, l7: 4.0, l8: 3.5, l9: 4.0, l10: 3.5,
  l11: 4.0, l12: 4.0, l13: 5.0, l14: 4.0, l15: 5.0, l16: 6.0, l17: 6.0, l18: 5.0, ph: 6.0, ml: 8.0,
};

/** 图定停站时分（s）。配车的周转时间与逐站时刻表共用这一个数。 */
const SCHED_DWELL = 30;
/* AI 车"算不算到站"的容差（米）。**必须宽于**停车精度的标定门槛
   （ATO ≤0.60 m、人工 ≤1.00 m，README 第 80 条）：写得更严就会造出一个死区 ——
   车被制动曲线停在标前 0.45~0.6 m，既不判到站、ATO 又已给满制动，
   于是门永远不开、这一列从此钉在站上（实测支线领头车差 0.455 m 卡死 25 分钟）。 */
const ARRIVE_TOL = 1.2;
SH.SCHED_DWELL = SCHED_DWELL;

/**
 * **玩家锚定的服务间隔**（第 113 条，单位：站）。
 *
 * 全线均布（`i × spacing`）在"玩家在哪儿"这件事上是随机的：把整条环按玩家位置
 * 取模，前车可能落在 +0.4 站（贴着鼻子）也可能 +1.9 站。而真实地铁里，你前面那班
 * 车是**稳定的 1~2 站**——你发车时它在下一两站的区间里，你到站时它刚走。
 *
 * 所以游戏局（有玩家）改成"服务图"：前车固定落在玩家前方 `lead` 站、后车固定落在
 * 后方 `trail` 站，其余车把**剩下的那段弧**均分。离线判据没有玩家，走的仍是全线
 * 均布（那是"这条线配几列车、间隔多少"的纯运营口径，判据钉的就是它）。
 *
 * 1.5 站是有依据的：早高峰 2 min 头时 × 39.6 km/h 旅行速度 ≈ 1.3 km ≈ 0.9 站，
 * 平峰 2.6 km ≈ 1.8 站。取 1.5 是两者的中值；判据钉的是"落在 1~2 站之间"。
 */
SH.SERVICE_GAP = { lead: 1.5, trail: 1.5 };
/**
 * 间隔调节的权限（第 113 条）。
 *
 * 死区 `band`：间隔落在目标间隔的 1.0~`band` 倍之内**完全不调**（正常驾驶不受干扰）；
 * 超出才动作。`min` 是压速下限、`dwell` 是停站时分的调整幅度（秒）。
 *
 * 权限为什么给这么大：0.80 的压速（前车仍跑 56 km/h）在玩家跑 50 km/h 时根本
 * 拦不住间隔——实测 15 分钟就拉到 4 站。真实调度遇到这种情况是**扣车**
 * （让前车在站上多停），所以停站时分的权限必须够（±26 s），速度权限也要
 * 能压到 0.62（70 km/h 限速下 ≈43 km/h 的慢行）。
 */
SH.GAP_TRIM = { min: 0.62, dwell: 10, band: 1.25 };

/**
 * 时段运行密度系数（≥1，越大车越稀）。
 *
 * **配车按高峰配，在役列数随时段缩** —— 这是真实运营的做法：车底不会因为夜里
 * 就少买，但夜里只投入一部分（其余停在车辆段）。落到模型里就是 `n` 随系数缩，
 * 站台屏上的"下一班 N 分钟"也跟着变长。
 *
 * 高峰取 **1.0**：与既有标定逐字节一致，所以默认 hour=8 时所有判据基线不动。
 * 这条不是随手定的 —— 系数一变 `n` 就变，而 `n` 变了车队组成就变。
 * 客流系数（`SH.pax.rushFactor`）与本系数是**两件事**，各有各的表：
 * 前者管"人多人少"，后者管"车稀车密"。混在一处就会变成
 * "夜里人少 → 车少 → 人显得更少"的自我强化。
 *
 * **交路也要分开抽稀（第 129 条）**：同一条线上支线尾巴的客流低于共线段/主线，
 * 真实做法是平峰与深夜先抽支线。所以第二个参数是交路：
 *   · 高峰（7-9 / 17-19）两交路同权 1.0 —— 与既有标定逐字节一致，
 *     默认 hour=8 时全线判据基线不动；
 *   · 平峰支线 ×1.15、深夜支线 ×1.45（主线仍是 1.3 / 2.0）。
 * 这是"类"陈述（地铁支线客流低于干线是通行事实），不是某条线的真实时刻表。
 */
SH.headwayFactor = (hour, svc) => {
  const h = ((hour % 24) + 24) % 24;
  const base = ((h >= 7 && h <= 9) || (h >= 17 && h <= 19)) ? 1.0
    : (h >= 22 || h < 5) ? 2.0 : 1.3;
  const branchX = svc === 'branch' ? (base === 1.0 ? 1.0 : base >= 2.0 ? 1.45 : 1.15) : 1.0;
  return base * branchX;
};

/**
 * 运营时段：首末班。首班 05:30 出车，末班 23:00 之后不再把车底投回正线。
 *
 * 真实首末班是**逐站逐方向**的表（而且各线不同），本项目没有那份公开资料
 * （README 已记"官方只发布首末班与间隔"）。所以这里只做"全线一个收车时刻"
 * 这一层，口径写在这里、由 `test-traffic.js` 钉住，不许以后有人拿它冒充
 * 某条线的真实末班时刻。
 */
SH.SERVICE = { first: 5 * 3600 + 1800, last: 23 * 3600 };

/** 一个站间的纯运行时分（不含停站）：加速到限速 → 巡航 → 制动到停。
 *  跨段短到达不了限速时按"三角形速度曲线"算（顶点 v = √(2·a·b·s/(a+b))）。
 *  这是全项目**唯一**一份"这段路要跑多久"的公式：旅行速度、配车数、图定时刻表
 *  都读它。以前它写在 `_vAvg` 里、只按站均间距算一遍，于是任何"逐站"的东西
 *  要么没有、要么得再抄一份公式（第二个真值）。 */
function legSec(gap, acc, brk, lim) {
  const dAcc = lim * lim / (2 * acc), dBrk = lim * lim / (2 * brk);
  if (dAcc + dBrk >= gap) {
    const v = Math.sqrt(Math.max(1, 2 * acc * brk * gap / (acc + brk)));
    return v / acc + v / brk;
  }
  return lim / acc + lim / brk + (gap - dAcc - dBrk) / lim;
}
SH.legSec = legSec;

/** 正点偏差的扣分：|晚点| ≤15 s 免罚（与司机台"图点运行"的口径同一个数），
 *  之后每 15 s −2 分，封顶 −20。早晚对称：真实运营里早点同样要处理
 *  （停站不足会甩客，图定也不允许抢点）。
 *  导出是为了让判据与游戏读同一个式子 —— 判据里再抄一遍就是第二个真值。 */
function latePenalty(late) {
  const a = Math.abs(late);
  return a <= 15 ? 0 : Math.min(20, Math.round((a - 15) / 15) * 2);
}
SH.latePenalty = latePenalty;

/** 末班车：按图定时刻表，本站在"当前时刻之后"的最后一班是否还存在。
 *  真实运营里末班之后站牌显示"首末班车时间"而不是"已收车"，
 *  这里只做"还有没有下一班"这一层 —— 它足够让屏在收车时段变一次，
 *  而末班时刻本身由图定时刻表给出（`SH.timetable`，与配车同一个模型）。 */
SH.lastTrainAt = (line, stationIdx, wallSec) => {
  /* 入参是**当日秒数**（0~86400），不是"距首站发车的秒数"。
     口径：过了 `SH.SERVICE.last`（23:00）全线不再有新车上线，屏报"已收车"。
     为什么不再用"图定全程时长"反推：那样算出来的时刻与玩家看到的钟点
     （HUD / 天光）不是同一个时间轴 —— 屏说收车了而外面还是大白天。
     真实首末班是逐站表且各线不同，本站没有公开出处，所以只做"全线一个
     收车时刻"这一层，并把"最后一班还在站上"这件事交给屏自己的状态链
     （先报「到站」、再报「已收车」，见 `SH.nextTrain`）。 */
  return wallSec > SH.SERVICE.last ? SH.SERVICE.last : null;
};
/** 图定时刻表（秒，相对首站发车）：逐站累加 `legSec + SCHED_DWELL`。
 *  真实运行图是几年一调的文件，这里只能由线形与车辆性能反推 —— 所以判据钉的是
 *  **这张表可兑现**（自动模式跑完，每站晚点在容差内），不是"它等于官方运营时刻"
 *  （逐站时刻表没有公开出处，不许凭印象编）。 */
SH.timetable = (line) => {
  const p = line.perf;
  const lim = Math.min(line.runKmh || line.maxKmh, line.maxKmh) / 3.6;
  const acc = Math.max(0.35, p.accAvg * 0.85), brk = Math.max(0.4, p.serv * 0.8);
  const out = [0];
  for (let i = 0; i < line.gaps.length; i++) {
    out.push(out[i] + legSec(line.gaps[i], acc, brk, lim) + SCHED_DWELL);
  }
  return out;
};

/** 编组全长（车头到车尾）。与 game.js 的 carPositions 同一套算法：
 *  车头停在 sHead，车体向 −s 方向延伸，所以车尾 = sHead − 本值。 */
function trainLen(p) {
  let L = 0;
  for (let i = 0; i < p.cars; i++) {
    L += (i === 0 || i === p.cars - 1) ? p.headLen : p.midLen;
    if (i < p.cars - 1) L += p.gap || 0.35;
  }
  return L;
}

class Railcar {
  constructor(disp, s, idx) {
    this.idx = idx;
    this.s = s;
    this.tr = new SH.physics.Train(disp.spec);
    this.tr.s = s;
    this.ato = new SH.physics.ATO('auto');
    this.next = 0;          // 下一站站序（到站后自增）
    this.open = 0;          // 车门开度 0..1（渲染用）
    this.dwell = 0;         // 剩余停站秒数
    this.state = 'run';     // run | dwell | hold | turnback
    this.held = 0;          // 被扣住的累计秒数（调度统计）
    this.slot = s;          // 计划位置（用于正点率）
    this.late = 0;          // 相对计划的时间偏差（秒）
    /* 车载（0 = 空车，1 = 定员，>1 = 超员）。**不是每帧随机的装饰值**：
       目标是"时段客流系数 × 这列车在线上的位置"—— 早高峰满、夜里空，
       而同一列车在一次运行里只会缓慢变化（真实车辆也是一趟趟地变）。
       渲染侧（车内乘客的人数）直接读它，所以玩家在站台上看到的"这班车挤不挤"
       与调度统计里的数是同一个数。 */
    this.load = 0;
    /* 种子用 seedTag（镜像车队第 108 条）：对向车队 line.id 与正向相同
       （HEADWAY 查表必须同源），种子不区分的话两队的乘客偏置逐列完全相同
       —— 站台上看两列车"永远一样挤"。seedTag 缺省（正向）落到 line.id。 */
    this.loadJit = 0.72 + 0.56 * SH.rand01('load' + (disp.line.seedTag || disp.line.id) + '>' + idx);
    /* 驾驶风格偏置（第 113 条）：同一列车永远同一个偏置（种子 = 列车编号）——
       真实车队里没有两班车停站时分完全一样，±2.5 s 让整队不再像钟表。
       只影响**停站**，不碰加减速率（那会直接动既有判据的停车精度基线）。 */
    this.dwellJit = (SH.rand01('dwell' + (disp.line.seedTag || disp.line.id) + '>' + idx) - 0.5) * 5;
    /* 间隔调节（第 113 条）：每帧由 Dispatcher.escorts() 指派 —— 'lead' / 'trail' / null。 */
    this.reg = null; this.regGap = 0; this.regTarget = 0;
    /* 停站客流闭环（第 117 条）：当前停靠站序号与乘降状态 */
    this.dwellIdx = null;
    this._paxServed = null;
    /* 套跑交路与终点（第 114 条）：主线 'main' 或支线 'branch'，dest 为该车真实目的地 */
    this.svc = 'main';
    this.dest = disp.line ? disp.line.terminus : '';
    /* ---- 按图运行（§7.7）----
       planArr：图定给这班车的"下一站计划到站时刻"（调度器秒）。到站时
       clock − planArr = 晚点，之后沿图定链（图定停站 + legSec）累加到下一站
       —— 计划必须走在实际前面，晚点才谈得上"累积与补偿"。
       maxLate：本次值乘里最深的晚点（运营考核量）。
       enterAt：首班出车时刻（当日秒）。非 null = 车底还在车辆段没投过运。 */
    this.planArr = 0;
    this.maxLate = 0;
    this.enterAt = null;
    /* cycleTyp：本车典型站周时的 EWMA（图定链的步长，见 update() 的注释）；
       _arrPrev：上次到站的调度器秒（算站周时用）。 */
    this.cycleTyp = null;
    this._arrPrev = null;
  }
}

/* 闭塞分区表与三显示显示表在 align.js：世界几何（信号机）与调度器共用，
   而 world.js 在 traffic.js 之前加载。见 SH.blocks 的注释。 */
const blocks = SH.blocks, ASPECTS = SH.ASPECTS;

class Dispatcher {
  /**
   * @param line LineRuntime（需要 al / profile / perf / maxKmh / stations）
   * @param opt  {headwayMin, vAvgKmh, guard, maxTrains, pax, onEgress}
   */  constructor(line, opt) {
    opt = opt || {};
    this.line = line;
    this.al = line.al;
    this.spec = { perf: line.perf, stock: line.stock, maxKmh: line.maxKmh };
    this.len = trainLen(line.profile);
    this.runKmh = line.runKmh || line.maxKmh;
    /* 旅行速度（含停站）按运营限速的一成多：地铁站距短、加减速占大头。
       这里不猜：用本线站间距与加减速性能反推 —— 见 _tripSec()。 */
    /* 车载读的时段与玩家客流模型**同一个**（`SH.pax.rushFactor`）。
       写第二份时段系数就是第二个真值：早高峰玩家自己满载 126%、
       而站台上一列一列 AI 车全是空车 —— 这在画面上是说不通的。 */
    this.hour = opt.hour == null ? 8 : opt.hour;
    /* 雨天（D4）：AI 车载与玩家客流读同一个放大系数 —— 雨天两边一起变挤。 */
    this.rain = !!opt.rain;
    /* 配车头时 = 表值（高峰）× 时段密度系数。**顺序很重要**：density 要读 hour，
       而 hour 上面那一行才定下来。高峰系数 1.0 ⇒ 默认 hour=8 时与既有标定一致。 */
    this.density = SH.headwayFactor(this.hour, line.svc);
    /* 配车头时基准**必须按 baseId 查**：支线交路的 `line.id` 是 `l10#branch`
       这种带后缀的键，查不到就退到 `|| 4` —— 于是 5 号线支线跑在 4.0 min
       而它的高峰标定是 6.0（支线比主线还密），10 号线支线跑在 4.0 而标定是 3.5。
       只有 11 号线（4.0）恰好撞上，所以这个 bug 一直没人看见。 */
    this.headwayMin = (opt.headwayMin || HEADWAY[line.baseId] || HEADWAY[line.id] || 4) * this.density;
    /* 当日零点基准：调度器自己的 `clock = 0` 对应钟点 `dayT0`（秒）。
       判据/离线测试不传时取首班 05:30 —— 于是它们跑的那几十分钟永远在运营时段内，
       行为与改动前一致；游戏侧传 `hour × 3600`，屏上的钟点才是玩家选的那一刻。 */
    this.dayT0 = opt.dayT0 == null ? SH.SERVICE.first : opt.dayT0;
    this.guard = opt.guard == null ? 55 : opt.guard;
    this.maxTrains = opt.maxTrains || 64;
    this.pax = opt.pax || null;
    this.onEgress = opt.onEgress || null;
    /* 图定运行时分的参数（§7.7 晚点记账用）：与 _vAvg / SH.timetable 同一套推导
       （营运限速、八成加速度、八成常用制动），只在这里算一遍。
       晚点链的"下一站计划到站"用它们走 legSec —— 抄第二份推导就是第二个真值。 */
    this._acc = Math.max(0.35, line.perf.accAvg * 0.85);
    this._brk = Math.max(0.4, line.perf.serv * 0.8);
    this._limV = Math.min(this.runKmh, line.maxKmh) / 3.6;
    /* 晚点样本（最近 400 次到站）：stats() 的正点率/平均晚点从这来。 */
    this.lateSamples = [];
    this.vAvg = this._vAvg();
    this.spacing = this.vAvg * this.headwayMin * 60;      // 目标间隔（米）
    /* 车队规模按**全周转时间**算，并且刻意留 15% 空档：
       `n = floor(0.85 × cycle / headway)`。按理论最大值配车（cycle/headway）会让
       线路一点余量都没有 —— 实测 9 号线配 17~19 列时，一次晚点就让终点折返队列
       倒灌回正线，而折返待避又卡住起点，45 分钟里参考站一列车都没过 —— 全线自锁。
       真实运行图同样是这么留的：折返线能停的列数不算在正线配车里。
       0.9 → 0.85 是第 77 条里程标定之后调的：2 号线从 46.9 km 标到 62.2 km 之后
       多配出一列（26 → 27），而固定闭塞的"一格一车"会把扰动放大，参考站头时
       变异系数正好顶在 0.40 的门槛上。少配一列回到 0.36 —— 这不是放宽门槛，
       是"配车留余量"这条本来就该随线路变长而收紧。 */
    const cycle = this.al.total / this.vAvg + 90;         // 单程运行 + 折返待避
    this.n = C(Math.floor(0.85 * cycle / (this.headwayMin * 60)), 2, this.maxTrains);
    /* ---------------------------------------------------------- 套跑（第 121 条）
       Y 型线（5/10/11）的两个交路**共用同一支车队**：`SH.interlineMeta.ratio`
       说 10 号线主:支 = 2:1、5 与 11 = 1:1，那这个比例必须是"把本线配车切开分给
       两个交路"，而不是"主线一队、支线再一队"。后者会让共用干线的头时凭空减半 ——
       既有头时判据（CV ≤ 0.40）会被整条打穿，而打穿它的正是这次新增的功能。
       `opt.fleet` 由 game.js 在创建对侧调度器时传入（= 本线配车 × 对侧比例）。 */
    this.inter = SH.interlineMeta ? SH.interlineMeta(line, this.hour) : null;
    this.forkS = this.inter && this.inter.forkIdx >= 0 ? this.al.stationS[this.inter.forkIdx] : Infinity;
    this.terminus = line.stations[line.stations.length - 1];
    /* 小交路（第 133 条）：**同一个调度器内按车给行程**，不另建第三个交路。
       为什么不建：`LineRuntime` 会按自己的站表重算一条对齐线（game.js 里
       `buildLineAlignment(this.stations, …)`），支线能那么建是因为支线在几何上
       真的岔出去；小交路是同一条正线上的一段，另建就得到同一物理区间的第二套
       里程 —— `SH.blocks` 的分区表与联合占用立刻对不上，那正是第 121 条修掉过的
       "两列不同交路的车并排跑在同一段轨道电路上"。 */
    this.short = SH.shortTurn ? SH.shortTurn(line) : null;
    /* 支线区间车（第 134 条）：每几列放一列在**分岔站**折返，加密共线段。
       与小交路共用同一套机制（`_endOf` 读 `t.last`），所以行程这件事只有一份实现。 */
    this.turnEvery = SH.branchTurnbackEvery ? SH.branchTurnbackEvery(line, this.hour) : 0;
    this.nShort = 0;
    this.peer = null;              // 另一交路的调度器：干线上互相占用、站台屏合并显示
    const share = this.inter && this.inter.forkIdx >= 0
      ? this.inter.ratio[this.line.svc === 'branch' ? 1 : 0]
        / (this.inter.ratio[0] + this.inter.ratio[1])
      : 1;
    this.fleetShare = share;
    /* 切分**之前**的设计配车数。判据用它对账"两个交路加起来 = 一支车队"：
       套跑最容易犯的错就是主线照配、支线再配一遍，于是共用干线的头时凭空减半，
       而两边的 stats() 各自看起来都正常。 */
    this.nDesign = this.n;
    if (opt.fleet != null) this.n = C(Math.round(opt.fleet), 2, this.maxTrains);
    else if (share < 1) this.n = C(Math.max(2, Math.round(this.n * share)), 2, this.maxTrains);
    this.spacing = this.al.total / this.n;                // 回算实际铺满全线的间隔
    this.trains = [];
    /* **分区表**是唯一出处：真实固定闭塞的边界是"出站信号机（站中心+96）+ 
       站间再均分 2~4 格"，所以按站分段。它不是"从里程 0 起铺的整数公里格"，
       也不是单独一张装饰用的信号机里程表。`SH.blocks()` 与信号机/显示/防护
       读同一份，才不会出现"画面绿灯正对着被占用分区"这种自洽的假系统。 */
    const B = this.blocks = blocks(this.al, this.line.stations.length);
    this.clock = 0;
    /* 干线头时是**两个交路一起**造出来的，所以"同一站相邻两次进站的时距"这份
       样本必须两个调度器共用一张表 —— 各记各的，量出来的就是"本交路的头时"，
       而玩家和判据看的都是"这一站隔多久来一班车"。`opt.shareWith` 由 game.js
       在创建对侧之后传进来（先建的那队持有表，后建的那队挂同一份引用）。 */
    if (opt.shareWith) {
      this.depGaps = opt.shareWith.depGaps;
      this.lastDep = opt.shareWith.lastDep;
    } else {
      this.depGaps = [];                 // 同站相邻进站的时距样本（头时兑现率的原始数据）
      this.lastDep = new Map();          // 站序 -> 上一次进站时刻
    }
    this.lastGo = new Map();           // 站序 -> 上一次出发时刻（出发节拍约束）
    this.playerS = null;
    this.build();
  }
  /** 旅行速度：用线形自己算，不写死。
   *  逐段积分（`legSec`）而不是拿"站均间距"当一段：16 号线有一个 10.6 km 的跨段
   *  和一堆 2.5 km 的市区段，用平均跨距算会把长段的巡航收益抹掉，旅行速度偏低、
   *  配车数偏高。图定时刻表与配车必须读同一个逐段模型（见 `SH.timetable`）。 */
  _vAvg() {
    const p = this.line.perf;
    const lim = Math.min(this.runKmh, this.line.maxKmh) / 3.6;
    const acc = Math.max(0.35, p.accAvg * 0.85), brk = Math.max(0.4, p.serv * 0.8);
    const gaps = this.line.gaps && this.line.gaps.length ? this.line.gaps
      : [this.al.total / Math.max(1, this.line.stations.length - 1)];
    let sec = 0, dist = 0;
    for (const g of gaps) { sec += legSec(g, acc, brk, lim) + SCHED_DWELL; dist += g; }
    return dist / sec;
  }
  build() {
    this.trains = [];
    this.nShort = 0;                 // 重算（build 会被 rebuild 再走一遍，不清零就翻倍）
    const total = this.al.total;
    /* 服务图（第 113 条）：有玩家时按"前车 1~2 站 + 后车 1~2 站 + 其余均分"铺车；
       没有玩家（离线判据）时全线均布 —— 后者是纯运营口径，既有判据的基线。 */
    let base = 0, step = this.spacing;
    this.leadGap = this.trailGap = 0;
    if (this.playerS != null) {
      const gapSt = total / Math.max(1, this.line.stations.length - 1);   // 平均站间距
      const lead = SH.SERVICE_GAP.lead * gapSt, trail = SH.SERVICE_GAP.trail * gapSt;
      /* n 列车、n−1 段弧：第 0 列在 +lead、第 n−1 列落在 −trail —— 这样"玩家前方
         最近的"恒等于 lead（不会像均布那样冒出更近的一列），"后方最近的"恒等于 trail。 */
      base = this.playerS + lead;
      step = (total - lead - trail) / Math.max(1, this.n - 1);
      this.leadGap = lead; this.trailGap = trail; this.step = step;
    }
    const S = this.al.stationS;
    /* 小交路只决定"哪些车是短交路"（均匀插，不随机抽 —— 随机会把参考站头时的
       变异系数打穿既有判据），**不改铺车格位**：铺车格位是第 113 条按"玩家前后
       1~2 站 + 其余均分"标定过的，另起一套就会让两列车的格位重合。
       一列短交路车如果开局落在自己那段之外，它先把这一圈跑到头再折返 ——
       与真实世界里"区间车从端头车辆段出场，先跑完一圈再开始跑区间"同一件事。 */
    const every = this.short && this.short.idx > 0 ? Math.max(2, Math.round(1 / this.short.ratio)) : 0;
    const isShort = i => !!every && i % every === every - 1;
    let nShort = 0;
    for (let i = 0; i < this.n; i++) if (isShort(i)) nShort++;
    this.nShort = nShort;
    for (let i = 0; i < this.n; i++) {
      const s = ((base + i * step) % total + total) % total;
      const t = new Railcar(this, s, i);
      /* 直接把车载**初始化到目标值**：从 0 慢慢爬会让开局前两分钟
         站台上一列一列全是空车，而玩家自己的车已经 86~126% 满载了。 */
      t.load = this._loadTarget(t);
      /* 本调度器里的每一列都跑**本交路的全程**（含自己的尾巴）。
         以前这里给每辆车发一个 `svc` 标记，再在分岔口把"不是本交路"的车
         `s = -9999` 脱网 —— 那等于全网没有任何一列真的开进支线，
         "10 号线 2:1 混跑"只是数据表里的一行字。现在两个交路各建一个调度器、
         按 `ratio` 分同一支车队（见构造函数），支线因此是真的：
         车会一路开到支线终点、在支线终点折返。 */
      t.svc = this.line.svc || 'main';
      t.dest = this.terminus;
      /* 行程端点（站序）：全程车 = [0, 最后一站]。小交路车把 `last` 收到折返站，
         于是它跑到折返站就"消失"（模型的环线折返：从折返点回到起点重新投运），
         共线段因此比端头密一倍以上 —— 这就是大小交路的全部机制。
         **均匀插**而不是随机抽：随机会让参考站的头时变异系数打穿 0.40 那条既有
         判据（同"配车不留余量就自锁"那一族），而真实运行图上的小交路也是均铺的。 */
      t.last = this.line.stations.length - 1;
      if (isShort(i) && this.short.idx < t.last) {
        t.last = this.short.idx; t.dest = this.line.stations[t.last];
        t.svc = 'short';
      }
      /* 支线区间车（第 134 条）：在分岔站折返、不进尾巴。`t.svc` 保持 'branch'
         （车次号前缀 S 是交路身份，折返只是这一趟的行程），所以另记 `t.turn`。 */
      if (this.turnEvery && this.inter && this.inter.forkIdx > 0 && this.inter.forkIdx < t.last
        && i % this.turnEvery === this.turnEvery - 1) {
        t.last = this.inter.forkIdx; t.dest = this.line.stations[t.last]; t.turn = true;
      }
      /* 车次号：真实运行图上每班车都有号。前缀分交路（M 主线 / S 支线 / X 小交路），
         站台屏与 HUD 都读它 —— 没有它，"刚才压我站的是哪班车"说不清楚。 */
      t.num = (t.svc === 'branch' ? 'S' : t.svc === 'short' ? 'X' : 'M') + (101 + i);
      /* ---- 首班出车（§7.7 出场）----
         车底按**服务头时**错峰出场（第一班 5:30，之后每头时一列）：
         玩家选的开局钟点晚于某车的出场时刻 ⇒ 它早已在正线上（默认 hour=8
         全车队都已出完，与旧基线逐字节一致）；早于 ⇒ 先在车辆段里等，
         update() 到点、且起点进路空了再投运 —— 早班"车越来越少"的半程
         运营是真的，不是一开局凭空满线。收过车的 stabled（enterAt 已清）
         不会再被这条捞回来。
         只在**有玩家的一局**里生效（playerS 由 reset 给出）—— 与服务图、
         间隔调节同一条门控：离线判据跑的是"稳态运营"口径，不重铺早班出场。 */
      if (this.playerS != null) {
        t.enterAt = SH.SERVICE.first + i * this.headwayMin * 60;
        if (t.enterAt > this.wallClock() + 0.5) { t.state = 'stabled'; t.s = -1; t.tr.s = -1; }
        else t.enterAt = null;
      }
      /* 图定锚点：从这里到下一站停标的图定运行时分（legSec 同一公式）。
         只在铺图时算一次，之后沿图定链累加 —— 初始近似只影响每车的
         第一次到站记账，误差有界。cycleTyp 的**种子**用"平均站距 ÷ 旅行速度"
         （vAvg 本身含停站，这个商就是平均站周时）：用剩余首段的 legSec 做种子
         会偏到实际的一半（实测 46 s vs 实际 130~180 s），收敛期晚点虚高到
         900 s 钳位；用实测值做种子则会被第一段扰动污染。全线平均是唯一
         不依赖"这一段恰好正常"的先验。 */
      t.planArr = this.clock + this._planRunSec(t);
      /* 种子按**本车自己的行程**给：全程车与旧基线逐字节一致（用 al.total ÷ 站数），
         小交路车如果拿全线的平均站周时当种子，图定链开局就每站超前/落后一截，
         收敛期的"晚点"成了交路形状的函数而不是运营扰动。 */
      t.cycleTyp = (t.last < this.line.stations.length - 1
        ? (this.al.stationS[t.last] - this.al.stationS[0]) / Math.max(1, t.last)
        : this.al.total / Math.max(1, this.line.stations.length - 1)) / this.vAvg;
      this.trains.push(t);
    }
  }
  /* 这列车此刻该有多满：时段系数 × 这列车自己的固定偏置（同一列车永远同一个偏置）。
     系数 0.62 是标定出来的，不是随手写的：**满载率要落在真实区间里**。
     时段系数本身是"发送量倍数"，而一趟车的满载率还要看**车上还有多少人没下车**，
     所以它不等于系数。取 0.62 时：夜间 22%、平峰 66%、早高峰 96%、晚高峰 109%
     （偏置大的车在早晚高峰会顶到超员线，与真实一致）。
     原来取 0.92 —— 于是**平峰就有 98% 满的车开进站**，而夜里也只有 32%：
     早高峰与平峰几乎一样高，"时段"这件事在画面上就不成立了。
     这条口径由 test-traffic 的"除以时段系数后必须相等"钉住
     （乘性关系一旦改成别的形状，那条判据立刻发散）。 */
  _loadTarget(t) {
    const r = SH.pax && SH.pax.rushFactor ? SH.pax.rushFactor(this.hour, this.rain) : 1;
    return C(r * t.loadJit * 0.62, 0, 1.25);
  }
  /** 从当前位置到下一站停标的**图定**运行时分（§7.7）：legSec 同一公式，
   *  停在站上的车把剩余停站时分也算进去。只用于铺图时的第一次计划锚点。 */
  _planRunSec(t) {
    const S = this.al.stationS;
    const mk = this._nextMark(t);
    const d = mk != null ? Math.max(20, mk - t.s) : 500;
    const wait = (t.state === 'dwell' || t.state === 'hold') ? Math.max(0, t.dwell) : 0;
    return legSec(d, this._acc, this._brk, this._limV) + wait;
  }
  /** 以玩家当前位置为参照重铺一张运行图（开局 / 换线时调用）。
   *  顺序要紧：`build()` 要读 `playerS` 才能铺服务图（前车/后车各占一个服务间隔）。 */
  reset(playerS) {
    this.playerS = playerS;
    this.build();
    for (const t of this.trains) { t.tr.s = t.s; t.slot = t.s; }
  }
  /** 车尾里程：车头在 s 时整列车占 [s − len, s] */
  rear(t) { return t.s - this.len; }
  /**
   * 挑出玩家前后的**护航车**（第 113 条）：前车 = 车头在玩家前方里程最小的那列，
   * 后车 = 后方最近的那列。只挑一列 —— 服务图保证了这两列就是"该跟的那班"，
   * 其余车照常按时刻表跑（真实运营里也只有紧邻的两列会被间隔调节影响）。
   */
  escorts() {
    if (this.playerS == null) return { lead: null, trail: null };
    const total = this.al.total;
    let lead = null, ld = Infinity, trail = null, td = Infinity;
    for (const t of this.trains) {
      if (t.state === 'stabled' || t.s < 0) continue;
      let fwd = (t.s - this.playerS) % total; if (fwd < 0) fwd += total;
      let back = (this.playerS - t.s) % total; if (back < 0) back += total;
      if (fwd > 1 && fwd < ld) { ld = fwd; lead = t; }
      if (back > 1 && back < td) { td = back; trail = t; }
    }
    return { lead, trail, ld, td };
  }
  /**
   * 间隔调节量（0.80~1.0）—— 乘在 ATO 的**目标巡航速度**上（不是物理限速）。
   *
   * 前车：间隔偏大（跑远了）就压速，把洞留给玩家；间隔偏小就放开（回到 1.0）。
   * 后车：间隔偏大（被甩下）就放开（追），偏小（贴上来了）就压速。
   * 两侧都**只往慢的方向调**：真实地铁的自动调整不会让车超速去追点，
   * 只会"多停一会儿 / 跑慢一点"把间隔摊平。
   *
   * 只在有玩家的一局里生效 —— 离线判据没有玩家，行为与改动前逐字节一致。
   */
  gapTrim(t) {
    if (this.playerS == null || !t.reg) return 1;
    /* 死区：目标间隔的 1.0~band 倍之间不调节 —— 正常驾驶时前后车的间隔本来就在
       这个带里，一进带就压速会让前车无谓地慢下来（"车怎么越开越慢"）。 */
    const r = t.regGap / Math.max(1, t.regTarget);
    const e = Math.max(0, r - SH.GAP_TRIM.band);
    const k = t.reg === 'lead' ? 0.62 : -0.52;
    return C(1 - k * e, SH.GAP_TRIM.min, 1);
  }
  /** 当日秒数（0~86400）：调度器 `clock = 0` 对应 `dayT0`，之后线性推进。
   *  站台屏的"已收车"、收车后不再投入车底，都读它 —— 与 HUD 钟点、天光是
   *  **同一条时间轴**（以前屏上的"收车"按"距首站发车多久"算，与玩家看到的
   *  钟点各说各话）。 */
  wallClock() { return (this.dayT0 + this.clock) % 86400; }
  /**
   * 前方占用 limit：本车车头最远能到哪儿。
   * 返回 {limit, kind}，kind = train | player | signal | end
   *
   * 两道限界取更近的：① 前行车（或玩家）的**车尾**；② 前方第一个被占分区的**入口边界**
   * —— ② 才是固定闭塞的本义。只有①时"被扣住"会发生在分区内部，也就是**冒进信号**：
   * 车头已经越过红灯进了占用分区，只是还没撞上车。显示与限界不同源，画面就会
   * 出现"红灯亮着而列车照常开过去"。
   * `self` 传 `'player'` 时玩家自己不算障碍（否则司机的净空永远是 0）。
   */
  authority(s, self) {
    let best = this.al.total, kind = 'end';
    for (const t of this.trains) {
      if (t === self || t.s < 0) continue;
      const r = this.rear(t);
      /* 车尾在本车之后、车头在本车之前 ⇒ 两车已经叠在一起。
         原来只判 `r > s`，于是"车头在 100 m、车尾在 −87 m"的列车被当成不存在，
         折返车按这个结论直接落到它身上 —— 实测 1 号线车头间距 0.8 m（编组 187 m）。
         现在把 limit 收到本车自己的位置：一步都不许走，重叠也不可能被藏住。 */
      if (t.s > s) { if (r <= s) best = Math.min(best, s); else if (r < best) { best = r; kind = 'train'; } }
    }
    if (self !== 'player' && this.playerS != null) {
      const r = this.playerS - this.len;
      if (this.playerS > s) { if (r <= s) best = Math.min(best, s); else if (r < best) { best = r; kind = 'player'; } }
    }
    const sg = this.signalLimit(s, self);
    if (sg.limit < best) { best = sg.limit; kind = 'signal'; }
    return { limit: best, kind };
  }
  /** 车头前方最近的"被占分区"：一张离散的边界表上，`idx>=0` 里找下一个
   *  [b0,b1) 与本车前方重叠、且被占用的格子。格子是站间单独均分的，不是
   *  整数公里格，所以不能直接用 floor(s/blk)。 */
  _nextOccupiedIdx(s, self) {
    const B = this.blocks;
    for (let i = 0; i < B.length; i++) if (B[i][0] >= s && this.blockOccupied(B[i][0], B[i][1], self)) return i;
    return -1;
  }
  signalLimit(s, self) {
    const i = this._nextOccupiedIdx(s, self);
    return i < 0 ? { limit: Infinity, kind: null }
                 : { limit: Math.max(s, this.blocks[i][0]), kind: 'signal' };
  }
  /** 站上放行判据（真实固定闭塞）：本区段出清就放行。
   *  分区是"出站信号机 + 站间均分"的边界表，不是整数公里格，所以找
   *  `t.s` 落下的那个格子、查它有没有被占。站中心+96 在表里**恰好**是格子起点。 */
  _blockClear(s, self) {
    const B = this.blocks;
    /* 车停在站上时，防护分区是"本车会先进的那一格"（= 当前所处格子的下一格）；
       车停在区间里时，防护分区就是"本车所压的那个格子"（它要开出去，必先出清
       这个格子）。两种情形同一个式子：找"车会进的那一格"。
       车恰好压在格尾时，下一格才是它要进的；车压在格中时，当前格是它要出的。
       所以条件是 s < b[1] - 0.5：差 0.5 m 以内算"在格尾"。 */
    for (let i = 0; i < B.length; i++) {
      if (B[i][0] <= s && s < B[i][1] - 0.5) return !this.blockOccupied(B[i][0], B[i][1], self);
    }
    /* 车在最后一个分区里，或超出表：放行（正线尽头交给 authority 的车挡）。 */
    return true;
  }
  /** 分区 [b0,b1) 是否被占：任一列车（含玩家）的 [车尾,车头] 与该分区**有交**。
   *  用几何相交而不是"车在分区里"：压在绝缘节上行驶的车同时占用相邻两格，
   *  真实轨道电路正是这样。`self` 把某列车自己排除在外（与 `authority()` 同一约定），
   *  传 `'player'` 时连玩家也不计 —— 司机的机车信号不该被自己占住的那个分区压成红。
   *  这是 `authority()` 之外的第二个读者，两者必须同源，否则信号显示与防护距离
   *  会互相打脸。 */
  blockOccupied(b0, b1, self) {
    const hit = (rear, head) => head > b0 && rear < b1;
    for (const t of this.trains) {
      if (t === self || t.s < 0) continue;
      if (hit(this.rear(t), t.s)) return true;
    }
    if (self !== 'player' && this.playerS != null && hit(this.playerS - this.len, this.playerS)) return true;
    /* 套跑（第 121 条）：分岔站之前两个交路走的是**同一段轨道电路**。对侧车队
       不在本调度器的 trains 里，所以干线分区必须再问一次对侧 —— 漏掉这一步，
       画面会出现"主线车与支线车并排在同一区间"，而两队的信号显示各自都说
       自己那一格是空的（两个真值互相打脸，与第 76 条同源）。 */
    if (this.peer && b0 < this.forkS && this.peer.trunkHit(b0, Math.min(b1, this.forkS))) return true;
    return false;
  }
  /** 对侧车队在**干线**区间 [b0,b1] 上的占用查询。
   *  干线里程在两个交路之间逐站相同（test-core 钉住的不变量），所以直接按数值
   *  相交即可；车头已拐进自己尾巴的那一列，只算它还压在干线上的那一段。 */
  trunkHit(b0, b1) {
    if (!(b1 > b0)) return false;
    for (const t of this.trains) {
      if (t.s < 0 || t.state === 'stabled') continue;
      const head = Math.min(t.s, this.forkS);
      if (head <= 0) continue;
      const rear = Math.max(0, this.rear(t));
      if (head > b0 && rear < b1) return true;
    }
    return false;
  }
  /** 线路尽头之外不算出清：车挡以后没有轨道电路，把"什么都没有"当成"空闲"
   *  会让接近终点的那架信号机显示绿灯，而司机看到的真实尽头是必须停车的车挡。 */
  clearFrom(i, self) {
    const B = this.blocks;
    let n = 0;
    for (let k = Math.max(0, i); k <= i + 2 && k < B.length; k++) {
      if (this.blockOccupied(B[k][0], B[k][1], self)) break;
      n++;
    }
    return n;
  }
  aspectAt(block, self) { return ASPECTS[Math.min(2, this.clearFrom(block, self))]; }
  /** 指定停车股道（第 109 条，E3）：已回库（stabled）车数 mod 股道数 + 1。
   *  库区矮柱调车信号机的"指定股道"月白读这里 —— game.js 的 signalLighting
   *  与判据两边都调这一个方法，不许各自再写一份轮转公式。
   *  玩家只进尾端基地，头部基地目前无人驶入，所以全线共用一个指定；
   *  白天运营里 stabled=0，指定恒为 1 股道 —— 月白随收班回库车数逐股道轮转，
   *  这是深夜才看得见的真实运转。 */
  shuntRoad() { return (this.trains.filter(t => t.state === 'stabled').length % SH.DEPOT.roads) + 1; }
  /** 司机台上的显示：地面显示与防护净空取**更 restrictive** 的那个。
   *  地面那架只知道"分区空不空"，防护知道"前车车尾还剩多少米"。两列车挤在同一
   *  个分区里（编组 187 m、分区 559 m，装得下两列）时地面完全可以是绿的，
   *  此时司机台给绿就是说谎 —— 车载设备信息更多，本来就该更保守。
   *  返回 `{s, dist, aspect: 地面, cab: 车载, room}`，两个显示都要能对上号。 */
  cabAt(s, self) {
    const sa = this.signalAhead(s, self);
    if (!sa) return null;
    const room = this.authority(s, self).limit - s;
    const L = this.blocks[sa.block], blk = L ? L[1] - L[0] : 0;
    const byRoom = room >= 2 * blk ? 2 : room >= blk ? 1 : 0;
    return { s: sa.s, dist: sa.dist, block: sa.block, aspect: sa.aspect, room,
      cab: ASPECTS[Math.min(sa.aspect.clear, byRoom)] };
  }
  /** 本车前方最近的一架信号机（里程 / 距离 / 地面显示 / 分区号）。尽头之外没有信号机。 */
  signalAhead(s, self) {
    const B = this.blocks;
    for (let i = 0; i < B.length; i++) {
      const t = B[i][0];
      if (t > s + 0.5) return { s: t, dist: t - s, aspect: this.aspectAt(i, self), block: i };
    }
    return null;
  }
  /** 玩家视角：玩家前方最近的障碍（用来给司机显示"前方列车 xx m"） */  aheadOfPlayer() {
    let best = null, bd = Infinity;
    for (const t of this.trains) {
      if (t.s < 0 || t.state === 'stabled') continue;
      const d = this.rear(t) - this.playerS; if (d > 0 && d < bd) { bd = d; best = t; }
    }
    return best ? { train: best, dist: bd } : null;
  }
  /** 玩家后方追踪而来的最近一列 */
  behindPlayer() {
    let best = null, bd = Infinity;
    for (const t of this.trains) {
      if (t.s < 0 || t.state === 'stabled') continue;
      const d = this.playerS - t.s; if (d > 0 && d < bd) { bd = d; best = t; }
    }
    return best ? { train: best, dist: bd } : null;
  }
  /** 本车**这一圈**的行程上界（站序 +1）。
   *  短交路车开局可能落在自己那一段之外（铺车格位不按交路重排，见 `build()`）——
   *  那一圈它照旧跑到线路末端再折返，与真实世界里"区间车从端头车辆段出场，
   *  先跑完一圈再开始跑区间"是同一件事；从下一次投运起才收进行程段。 */
  _endOf(t) {
    const S = this.al.stationS;
    return (t.last != null && t.last + 1 < S.length && t.s <= S[t.last]) ? t.last + 1 : S.length;
  }
  /** 下一站的停车标里程（越过当前站后取再下一站）。
   *  上限是**本车这一圈的行程端点**：小交路车到 `t.last` 就没有下一站了，
   *  判据 `shortcross` 撤掉这条时会看到小交路车继续往端头跑。 */
  _nextMark(t) {
    const S = this.al.stationS, end = this._endOf(t);
    while (t.next < end && S[t.next] < t.s - 1) t.next++;
    if (t.next >= end) return null;
    return S[t.next];
  }
  /** 积分步长必须固定：物理与 ATO 的制动曲线是按"这一步走多远"算的，
      调用口给多大的 dt 就直接积多大一步，结果会随步长漂 ——
      实测同一局 25 分钟：dt=1/60 车队平均 37 km/h，dt=0.5 掉到 4 km/h，
      而靠起点那一列只剩 943 m（"站台上永远停着一列门不开的车"就是这么来的）。
      游戏侧本来就把 dt 夹在 0.05 s 以内（game.js 的 `Math.min(0.05, rawDt)`），
      所以把 0.05 s 定为内步：**离线判据、套跑、头时标定从此与调用口的步长无关**，
      量的都是玩家实际看到的那一套动力学。 */
  update(dt) {
    let left = dt;
    while (left > 1e-9) {
      const h = left > SIM_DT ? SIM_DT : left;
      this._step(h);
      left -= h;
    }
  }
 _step(dt) {
    this.clock += dt;
    /* 护航车与间隔（第 113 条）：每帧重挑一次 —— 前后车是"当前"的前后，
       不是开局那一列（玩家跑着跑着，前后关系会变；终点折返后更会换车）。 */
    if (this.playerS != null) {
      const es = this.escorts();
      for (const t of this.trains) { t.reg = null; t.regGap = 0; t.regTarget = 0; }
      if (es.lead) { es.lead.reg = 'lead'; es.lead.regGap = es.ld; es.lead.regTarget = this.leadGap || this.spacing; }
      if (es.trail) { es.trail.reg = 'trail'; es.trail.regGap = es.td; es.trail.regTarget = this.trailGap || this.spacing; }
    }
    const S = this.al.stationS, total = this.al.total;
    const inter = SH.interlineMeta ? SH.interlineMeta(this.line, this.hour) : null;
    for (const t of this.trains) {
      /* 已收车入库的车底：不再运行、不再折返，静静地停在终点端（真实收车后的样子）。
         首班还没出场的车底（enterAt 非空）到点后从**起点**投入正线 ——
         进路判据与折返投入同一条（第一分区出清 + 起点放得下整列车 + 防护距离），
         不满足就下一帧再问；收过车的（enterAt 已清）永远不再投运。 */
      if (t.state === 'stabled') {
        if (t.enterAt != null && this.wallClock() >= t.enterAt &&
            this._blockClear(0, t) && this.authority(0, t).limit >= this.len + this.guard) {
          t.state = 'run'; t.open = 0; t.s = 0; t.tr.reset(); t.tr.s = 0; t.next = 1;
          t.load = this._loadTarget(t);
          t.planArr = this.clock + legSec(S[1] - S[0], this._acc, this._brk, this._limV);
          t.enterAt = null;
        } else continue;
      }
      /* 车载缓变：真实车辆一趟趟地变，不会每秒跳一次。
         时间常数 45 s —— 一列 AI 车跑完一个站间（约 100 s）就基本走到目标值，
         而一局 15~45 分钟里晚高峰时段切换能被看出来。 */
      t.load += (this._loadTarget(t) - t.load) * Math.min(1, dt / 45);
      /* ---- 停站 / 折返 / 扣车 ---- */
      if (t.state === 'turnback') {
        t.dwell -= dt; t.open = t.s >= 0 ? 1 : 0;
        /* 折返待避：回到起点之前必须确认起点那段进路是空的。
           不检查的话，折返车会直接落到刚发车那列的防护距离上 ——
           实测 25 分钟后最小车头间距 196 m（= 编组 141 + 防护 55），
           同时终点侧留下 10.7 km 的空洞，头时保持被这个人为扰动打穿。 */
        if (t.dwell <= 0) {
          /* 收车：过了末班时刻就不再把这列车底投回正线（真实运营的收车动作）。
             它停在终点端，与站台屏的"已收车"是同一件事的两种呈现。 */
          if (this.wallClock() >= SH.SERVICE.last) { t.state = 'stabled'; continue; }
          /* 折返待避：回到起点前必须确认**第一整个站间分区**出清（与站上放行同一判据）。
             只要求防护距离时，折返车会落在刚发车那列的编组长度之内 ——
             实测 1 号线最小车头间距 104 m < 编组 187 m，两列车直接叠在一起。 */
          const a = this.authority(0, t);
          /* ① 第一个分区出清（与站上放行同一条判据）；② 起点至少要放得下
             整列车 + 防护距离，否则一落地就与后车重叠。 */
          if (this._blockClear(0, t) && a.limit >= this.len + this.guard) {
            t.state = 'run'; t.open = 0; t.s = 0; t.tr.reset(); t.tr.s = 0; t.next = 1;
            /* 目的地跟着**本车的行程端点**走：小交路车回到起点，屏上写的仍然是
               "往 折返站" —— 写回 `this.terminus` 就是让屏说假话（判据 shortdest）。 */
            t.dest = this.line.stations[t.last == null ? this.line.stations.length - 1 : t.last];
          } else t.dwell = 5;
        }
        continue;
      }
      if (t.state === 'dwell') {
        t.dwell -= dt;
        t.open = C(t.open + dt / 1.6, 0, 1);
        /* 停站客流闭环（第 117 条）：AI 列车停站开门，与站台候乘人群真实交换载荷 */
        const stIdx = t.dwellIdx != null ? t.dwellIdx : t.next - 1;
        if (stIdx >= 0 && stIdx < this.line.stations.length) {
          const name = this.line.stations[stIdx];
          const cap = SH.pax.capacity(this.line.stock);
          const onboard = Math.max(0, Math.round(t.load * cap.aw2));
          if (!t._paxServed && t.open > 0.05) {
            const d = SH.pax.demand(this.line.id, name, stIdx, this.line.stations.length, this.hour, this.rain);
            const wantOff = Math.min(onboard, Math.max(0, Math.round(d.alight * (0.8 + 0.4 * t.loadJit))));
            /* 小交路的闸门（第 133 条）：目的站在这趟车行程之外的那部分候乘不算
               "想上"。他们留在站台上，关门后照旧进 `leftBehind` —— 不删人、不改派
               （人数是停站时长的依据，删一个就是谎报一个）。份额与 `_add` 同源。 */
            const gate = SH.pax.withinShare ? SH.pax.withinShare(this.line, stIdx, t.last, this.hour, this.rain) : 1;
            const wantOn = Math.ceil((this.pax ? this.pax.waitingAt(name, stIdx) : d.board) * gate);
            const rate = this.pax && typeof this.pax.rate === 'function' ? this.pax.rate()
              : (Math.max(2, this.line.stock.doors) * this.line.stock.cars * 1.5);
            t._paxServed = { stIdx, name, wantOff, wantOn, off: 0, on: 0, bank: 0, onboard, gate };
            if (this.onEgress && wantOff > 0) {
              this.onEgress({ at: stIdx, name, need: wantOff, rate, dwellNeed: Math.max(4, t.dwell), wait0: wantOn, t: 0 });
            }
          }
          if (t._paxServed && t.open > 0.05) {
            const ps = t._paxServed;
            const rate = this.pax && typeof this.pax.rate === 'function' ? this.pax.rate()
              : (Math.max(2, this.line.stock.doors) * this.line.stock.cars * 1.5);
            ps.bank += rate * dt;
            const canOff = Math.min(ps.wantOff - ps.off, Math.floor(ps.bank));
            if (canOff > 0) { ps.off += canOff; ps.bank -= canOff; }
            const currentOnboard = ps.onboard - ps.off + ps.on;
            const capLeft = Math.max(0, cap.aw3 - currentOnboard);
            const currentWait = this.pax ? this.pax.waitingAt(name, stIdx) : (ps.wantOn - ps.on);
            const allow = Math.min(currentWait, Math.ceil(currentWait * (ps.gate == null ? 1 : ps.gate)));
            const canOn = Math.min(allow, capLeft, Math.floor(ps.bank));
            if (canOn > 0) {
              ps.on += canOn;
              ps.bank -= canOn;
              if (this.pax && this.pax.waiting) {
                this.pax.waiting.set(name, Math.max(0, currentWait - canOn));
              }
            }
            t.load = C((ps.onboard - ps.off + ps.on) / Math.max(1, cap.aw2), 0, 1.35);
          }
        }
        if (t.dwell <= 0) {
          if (!this._releasable(t)) { t.state = 'hold'; t.held += dt; continue; }   // 扣车：前方没释放闭塞分区
          this._markGo(t); t.state = 'run';
          t._paxServed = null; t.dwellIdx = null;
        }
        continue;
      }
      if (t.state === 'hold') {
        t.open = C(t.open - dt / 1.2, 0, 1);
        if (this._releasable(t)) { this._markGo(t); t.state = 'run'; t._paxServed = null; t.dwellIdx = null; }
        else { t.held += dt; continue; }
      }

      /* ---- 运行：目标 = 站停标 与 前方占用 里更近的那个 ---- */
      /* 关门必须在这里做：停站分支只负责把门开满，而物理里 `doorsOpen` 为真时
         牵引被禁止。以前运行分支没有收门动作，AI 车第一次停站之后就永远张着门
         停在站上不动（判据：test-traffic.js "后车停在 782 m 外"）。 */
      if (t.open > 0) t.open = C(t.open - dt / 2.2, 0, 1);
      const mark = this._nextMark(t);
      const a = this.authority(t.s, t);
      /* 停站目标 = 站停标，但**不许比防护界更靠前**：
         停站目标在防护界之内时，ATO 会被授权向防护界蠕行（甚至越过它），
         于是车在区间里被"进站"动作反复加速、逼近、再被 authority 摁回。
         真实固定闭塞：停站目标不许越过防护信号 —— 没进路不许停站。
         所以取 min(mark, a.limit - guard)。
         **真正的停站判定也要用同一个 target**：车只有停在站停标上才算进站，
         停在防护界前不算。 */
      const stopStation = mark != null && mark - t.s <= a.limit - t.s - this.guard;
      const target = stopStation ? Math.min(mark, a.limit - this.guard) : a.limit - this.guard;
      const isAtMark = stopStation && target === mark;
      const d = Math.max(0, target - t.s);
      const st = this.al.at(t.s);
      const lim = Math.min(this.line.limitAt ? this.line.limitAt(t.s) : this.runKmh, this.runKmh);
      const env = { limitKmh: lim, grade: st.grade, curveK: st.k, doorsOpen: t.open > 0.02, atpOn: true };
      /* 间隔调节（第 113 条）只改**目标巡航速度**，不改物理限速 env.limitKmh ——
         后者是超速保护的口径，压它等于让 ATO 以为自己一直超速。 */
      const ctx = {
        distanceToStop: d, speedKmh: t.tr.kmh, limitKmh: lim * this.gapTrim(t), grade: st.grade,
        curveK: st.k, curveLimit: lim, predictStop: t.tr.predictStop(st.grade),
      };
      const n = t.ato.notch(dt, ctx);
      if (n !== null) t.tr.setNotch(n);
      const ds = t.tr.update(dt, env);
      t.s += ds; t.tr.s = t.s;
      /* 套跑分岔出清（旧第 114 条）已删：那一段把"svc 不等于本交路"的车在分岔口
         `s = -9999` 脱网，等于全网没有任何一列真的开进支线。现在两个交路各有一个
         调度器、各跑各的全程，共用干线的占用由 `blockOccupied()` 向 `peer` 追问，
         所以这里不需要"把不属于本交路的车弄消失"这件事了。 */
      /* 硬性不许越过本帧开始时已知的占用界。ATO 的制动曲线本身会停在界前，
         但"不许重叠"是安全属性，不能只靠控制器收敛 —— 折返车落点、
         玩家瞬移进路等任何一处越界都会被这一层直接挡下。
         越界被钉住时把车速归零：ATO 的制动曲线是在"还没越界"的前提下算的，
         越界之后它会以"目标点已在我身后"的姿态继续给牵引。 */
      if (t.s > a.limit) { t.s = a.limit; t.tr.s = a.limit; t.tr.v = 0; }
      /* 到站判定：停在**站停标**上（不是防护界前）且已基本停住。
         停在防护界前不算进站 —— 那是被前方占用逼停，不是到站。
         容差必须**宽于停车精度标定本身**：ATO 的门槛是 ≤0.60 m、人工 ≤1.00 m
         （README 第 80 条），而这里原来写 `d < 0.45` —— 比它要等的控制器还严，
         于是存在一个死区：车被制动曲线停在站停标前 0.45~0.6 m，`d < 0.45` 不成立、
         不进 dwell、门不开、ATO 又已经给满制动不再往前挪 —— 实测一列支线车
         卡在 35087.545（站停标 35088.000，差 0.455 m）整整 25 分钟一动不动。
         "到没到站"和"停得准不准"是两个问题，不能用同一个尺子量。 */
      if (isAtMark && d < ARRIVE_TOL && t.tr.kmh < 1.2) {
        t.state = 'dwell';
        t.open = 0;
        t.dwell = this._dwell(t);
        /* 晚点补偿（§7.7）：晚点超过 20 s 的车压停站赶点 —— 下限 12 s、
           最多补回 12 s/站。真实运营的"赶点"就是压停站作业时分，不会超速；
           头时保持（_dwell）要它多停时两边取严，安全与正点各管各的。
           正在被间隔调节管辖的车（t.reg 非空）**不参与**：它的"晚点"是
           gapTrim 压速造出来的 commanded delay —— 补偿跟慢行指令对着干，
           净效果是前车越跑越远（实测慢玩家场景前车间隔 2.26 > 2.2 站）。 */
        if (t.late > 20 && !t.reg) t.dwell = Math.max(12, t.dwell - Math.min(12, (t.late - 20) * 0.3));
        /* 晚点记账（§7.7 按图运行）：clock − planArr = 本站实际晚点。
           样本进 lateSamples（stats() 的正点率/平均晚点），maxLate 留考核上限。 */
        t.late = C(this.clock - t.planArr, -45, 900);
        if (t.late > t.maxLate) t.maxLate = t.late;
        this.lateSamples.push(t.late);
        if (this.lateSamples.length > 400) this.lateSamples.shift();
        /* 头时样本：同一站上相邻两次进站的时距。这是运营上真正被考核的量。
           键必须**分干线/尾巴**：两个交路共用一张表（干线头时是两队一起造的），
           而分岔站之后的站序在两条尾巴上指的是不同车站 —— 不分键就会把
           "主线 18 站"与"支线 18 站"的两次进站当成同一站的相邻两次，
           量出一个根本不存在的头时。 */
        const hk = t.next <= (this.inter ? this.inter.forkIdx : -1) ? 'T' + t.next : (this.line.svc || 'main') + ':' + t.next;
        const ld = this.lastDep.get(hk);
        if (ld != null) { this.depGaps.push(this.clock - ld); if (this.depGaps.length > 600) this.depGaps.shift(); }
        this.lastDep.set(hk, this.clock);
        t.dwellIdx = t.next;
        t.next++;
        /* 折返判据按**本车这一圈的行程端点**，不是数组末尾 —— 小交路在折返站折返。 */
        if (t.next >= this._endOf(t)) {
          t.state = 'turnback'; t.dwell = this._turnbackDwell();
          t.next = Math.min(t.last == null ? S.length - 1 : t.last, S.length - 1);
        }
        /* 图定链（§7.7）：下一站计划到站 = 本站计划到站 + 本车**典型站周时**。
           站周时 = 上次到站 → 本次到站的实际间隔（含停站、含折返 —— 终点站的
           站周时天然把折返作业带进来，不用单独立公式）。
           为什么不按"图定停站 30 s + legSec 名义时分"链：名义值比 ATO 实跑
           （进站限速、曲线限速、扣车）每站快 30~40 s，计划每站落后实际 ——
           晚点沿链单调发散（实测爬到 527 s），"晚点"成了计时误差而非运营
           事件；补偿改用**自校准图定**：晚点只量运营扰动（扣车、大停站）。
           种子用全线平均站周时（build() 里 平均站距 ÷ vAvg），EWMA 0.15：
           种子若是**实测**的（第一版），一次 120 s 的注入停站会把种子污染成
           250 s —— 计划从此每站超前实际 160 s，晚点在钳位上躺平，
           补偿永远不触发（实测净贡献 1 s）；用剩余首段 legSec 做种子又会偏到
           实际的一半（46 s vs 130~180 s），收敛期晚点虚高到 900 s。
           0.15 的权重让扰动污染在十站内被冲掉，而单次扰动对计划的影响有界。
           链沿**计划**累加而不是沿实际 —— 压停站赶点才能真的把晚点收回来。 */
        if (t._arrPrev != null) {
          const cyc = C(this.clock - t._arrPrev, 30, 900);
          t.cycleTyp += (cyc - t.cycleTyp) * 0.15;
        }
        t._arrPrev = this.clock;
        t.planArr += t.cycleTyp;
      }
      /* 被前方占用逼停（区间停车）：保持 run 状态，ATO 自己会重新起步 */
    }
  }
  /** 折返作业时分（§7.8 磁浮头时）：常规线 90 s；**磁浮按发车批次运行** ——
   *  全线只配两列时，纯运行一圈只要 8.2 min，90 s 折返让端头实际每
   *  4.9 min 来一班，名义 8 min 头时形同虚设、两端"成对到发"
   *  （真实磁浮的终点折返作业本来就是清客/充电级别的长作业）。
   *  折返时分补足"批间隔 = 配车数 × 名义头时 − 纯运行一圈"，
   *  两列的到发按批次错开，名义头时是真的。 */
  _turnbackDwell() {
    if (this.line.maglev || (this.line.profile && this.line.profile.maglev))
      return Math.max(90, this.n * this.headwayMin * 60 - this.al.total / this.vAvg);
    return 90;
  }
  /** 停站时分 = 基准 + 双侧头时保持（调度核心）。
   *  用的是"前松紧、后松紧"之差，不是单边差值：
   *    前面空得大、后面跟得紧 → 早走，把前面的洞收掉、让后车追上来；
   *    前面贴得紧、后面空得大 → 多停，把前面的洞拉开。
   *  单边控制（只看前车）会把该快车的车越停越久，实测 25 分钟后间隔比散到 3.4 倍。 */
  _dwell(t) {
    const xs = this.trains.filter(x => x.s >= 0 && x.state !== 'stabled').map(x => x.s).sort((a, b) => a - b);
    const i = xs.findIndex(v => v >= t.s - 1e-6);
    const ahead = i >= 0 && i + 1 < xs.length ? xs[i + 1] - xs[i] : this.al.total;
    const behind = i > 0 ? xs[i] - xs[i - 1] : this.al.total;
    const dev = (Math.min(ahead, this.spacing * 3) - Math.min(behind, this.spacing * 3)) / Math.max(0.5, this.vAvg);
    /* 客流加成（第 103 条）：车越满、上下车的人越多，停站本来就更久 ——
       真实运营里这是站台作业时分的主要变量。幅度刻意压到 ±4 s：
       头时保持那一项（下面 0.8×dev）才是调度控制量，客流只是它上面的一层
       真实抖动。给大了会把 headway 控制淹掉（±25% 的初始扰动实测就是这样
       把 9 号线通过能力砍掉一半的）。 */
    const crowd = C((t.load || 0) / 1.2, 0, 1.2);
    /* 客流项加在**头时保持那一项被夹住之后**：否则头时保持经常顶到 120 s 上限，
       客流项就永远看不见（"加了但从不生效"是第 62 条那一族）。 */
    const base = C(22 - 0.8 * dev, 8, 120);
    /* 间隔调节（第 113 条）：前车跑远了就多停（把洞留给玩家），后车被甩下就少停。
       幅度 ±6 s —— 与客流项同量级：它是"摊平间隔"的辅助手段，主力还是速度调节。 */
    let reg = 0;
    if (this.playerS != null && t.reg) {
      const e = C(t.regGap / Math.max(1, t.regTarget) - 1.2, -2, 2);
      reg = (t.reg === 'lead' ? 1 : -1) * e * SH.GAP_TRIM.dwell;
    }
    return C(base + 4 * (crowd - 0.5) + (t.dwellJit || 0) + reg, 8, 128);
  }
  /** 放行判据：真实闭塞是"前方至少空出一个完整分区才给进行信号"，
   *  不是"前方 110 m 没车就能走"。按 guard 的两倍放行会让列车首尾咬死在
   *  防护距离上（实测 25 分钟后最小车头间距塌到 196 m ≈ 编组 141 + 防护 55），
   *  一列车被挡就整队跟着爬。
   *  阈值取 **0.9 倍目标间隔**：这才是"头时"的定义。取 0.6 倍时实测线路起点
   *  会攒出一串 1.3~1.5 km 的压缩车队，同时终点侧留下 10.7 km 的空洞 ——
   *  放行比目标间隔松，等于默许结队。下限 3 倍 guard 保证短间隔线路不退化。 */
  /** 放行距离 = 一个闭塞分区 + 本列车编组（车尾出清才算占用解除）。
   *  刻意**不用站间距**：市区站间 1.2~1.5 km，按整段出清放行会把通过能力压到
   *  每段一列，1 号线 2 分钟间隔（1434 m）永远达不到放行所需的 1555 m，
   *  实测 81% 的时间全线被扣在站上、正点率 0%。真实隧道本来就是一站间多个分区。 */
  /** 放行判据：① 前方第一个闭塞分区出清；② 本站的**出发节拍**到了。
   *  只靠"停站时分增减"调头时，对最密的线路收敛太慢：1 号线 2 min 间隔、26 列时
   *  头时变异系数 0.36。加上"同站最小出发间隔"这条硬约束后，到达序列被出发节拍
   *  直接钉住 —— 这才是调度中心真正在用的手段（按图行车给出发权）。 */
  _releasable(t) {
    if (!this._blockClear(t.s, t)) return false;
    const last = this.lastGo.get(t.next - 1);
    /* 出发节拍：同站最小出发间隔。0.7 倍头时太松 —— 里程标定之后 1 号线 27 列时
       头时变异系数正好顶在 0.40 的门槛上。真实调度给的是**图定出发权**（按运行图
       的时刻放行，不是"差一点就发"），所以收到 0.85：宁可多停 15 s，也不让两列车
       挤进同一个分区。实测均匀度 58% → 见 test-traffic 的输出。 */
    if (last != null && this.clock - last < this.headwayMin * 60 * 0.7) return false;
    return true;
  }
  /** 记一次出发，供同站出发节拍用。停站期间 `t.next` 已经指向下一站，所以本站是 next-1。 */
  _markGo(t) { this.lastGo.set(t.next - 1, this.clock); }
  /** 头时兑现率 —— 用"同一站上相邻两次进站的时距"衡量，即运营上真正的头时。
   *  以前这里拿"初始位置 + 旅行速度×时间"当计划位置，那个计划不含任何停站，
   *  30 分钟后每列车都比它晚 500 s 以上，无论跑得多均匀都报 0%。
   *  也不用瞬时车头距：那一瞬间总有车在隧道里贴着防护距离跟行。
   *
   *  判"均匀"要相对**实际达成的中位头时**，不是名义值：配车数按 0.9 系数留了
   *  恢复余量，实际头时必然比名义值长（实测 9 号线名义 4 min、达成 5.3 min，
   *  但 p10~p90 只有 5.2~5.6 —— 非常稳）。拿名义值当带心会把这种"稳但车少"
   *  误判成不兑现；名义与实际的差距由 `headwayRatio` 单独交代。 */
  stats() {
    const H = this.headwayMin * 60;
    const g = this.depGaps.slice(-80);
    let ok = 0, held = 0, med = 0;
    if (g.length) {
      const s = g.slice().sort((a, b) => a - b);
      med = s[s.length >> 1];
      for (const v of s) if (v >= med * 0.7 && v <= med * 1.3) ok++;
    }
    let mean = 0; for (const v of g) mean += v; mean /= Math.max(1, g.length);
    let va = 0; for (const v of g) va += (v - mean) * (v - mean);
    const cv = mean ? Math.sqrt(va / Math.max(1, g.length)) / mean : 0;
    for (const t of this.trains) if (t.state === 'hold') held++;
    /* 全队平均车载。它必须与时段**同向**（夜里小、早高峰大），
       而它同时是渲染侧车内乘客人数的输入 —— 判据钉的是这一个数，
       玩家看到的"这班车挤不挤"与调度统计读的是同一份。 */
    let lsum = 0; for (const t of this.trains) lsum += t.load;
    /* 按图运行（§7.7）：晚点样本上的正点率（|晚点| ≤ 15 s 免罚，与
       latePenalty 同一个容差）、平均/最深晚点。头时 CV 管"间隔匀不匀"，
       这三个数管"守不守图"—— 两件都被考核的事各量各的。 */
    const L = this.lateSamples.slice(-200);
    let lateSum = 0, lateMax = 0, punct = 0;
    for (const v of L) { lateSum += Math.max(0, v); if (v > lateMax) lateMax = v; if (Math.abs(v) <= 15) punct++; }
    const exiting = this.trains.filter(t => t.enterAt != null && t.state === 'stabled').length;
    return { trains: this.trains.length, headwayMin: this.headwayMin, vAvgKmh: this.vAvg * 3.6,
      onTimePct: g.length ? Math.round(100 * ok / g.length) : 100, held, samples: g.length,
      medHeadwayMin: med / 60, headwayRatio: med ? med / H : 1, cv,
      spacing: Math.round(this.spacing), guard: this.guard, blocks: this.blocks.length,
      hour: this.hour, density: this.density, dayT0: this.dayT0, wall: this.wallClock(),
      stabled: this.trains.filter(t => t.state === 'stabled').length,
      exiting, punctualPct: L.length ? Math.round(100 * punct / L.length) : 100,
      lateAvgSec: L.length ? Math.round(lateSum / L.length) : 0, lateMaxSec: Math.round(lateMax),
      loadAvg: this.trains.length ? lsum / this.trains.length : 0 };
  }
  /** 只画离玩家足够近的：一列 8A 是 24 批 × 3 组，画 30 列会把帧预算吃光 */
  visible(playerS, maxDist) {
    const out = [];
    for (const t of this.trains) {
      if (t.s < 0 || t.state === 'stabled') continue;
      let d = Math.abs(t.s - playerS);
      d = Math.min(d, this.al.total - d);
      if (d <= (maxDist || 1500)) out.push(t);
    }
    return out;
  }
}

/* ==================================================================== 站台信息屏
 * 真实上海地铁站台上那块跳秒的屏，是玩家对"这条线在运行"最直接的感觉：
 * 它每 2 秒跳一次数字，跳完一班车就进站。它显示的东西只有三样 ——
 * 开往哪个终点站、还有几分钟、这一班是不是末班。
 *
 * 这一份是**唯一实现**：站台 3D 屏、HUD 读数、以及离线判据都调它。
 * 测试自己再推一遍"下一班还有几分钟"就是第二个真值（这个项目已经为此付过
 * 六次学费），而这个数一旦有两个来源，屏上就会说 3 分钟而车 1 分钟就到。
 *
 * 口径（与真实一致，且是模型自己的算得出来的）：
 *   · 车头里程越接近该站站心、且尚未进站 ⇒ 越优先；
 *   · 已经在站上的车显示"即将进站 / 到站"；
 *   · 头时用**实测达成头时的中位**（`stats().medHeadwayMin`），不是名义值 ——
 *     名义头时是理论通过能力，真实运营里拿它当倒计时会长期偏乐观；
 *   · 末班：图定时刻表上该方向最后一班的到达时刻，过了就是"已收车"。
 */
/** 套跑对侧车队（第 121 条）：给一个交路的调度器配上**另一头交路**的车队，
 *  两边互为 peer（干线是同一段轨道电路，占用互相可见）、共用头时样本表。
 *  配车数从本队按 `interlineMeta.ratio` 切出来，不是另配一队 ——
 *  另配一队会让共用干线的头时凭空减半，把既有头时判据自己打穿。
 *
 *  单点实现：`game.js` 开局与 `test-traffic.js` 判据都调这一个函数。
 *  测试自己复刻一遍接线就是第二个真值（这条项目里栽过五次了）。
 *  @param disp 已经建好的本交路调度器
 *  @param other 另一交路的 LineRuntime
 *  @param opt   传给对侧 Dispatcher 的选项 + `atS`（玩家里程，用于铺服务图）
 */
function linkInterline(disp, other, opt) {
  opt = opt || {};
  if (!disp || !other || !disp.inter || disp.inter.forkIdx < 0) return null;
  const share = disp.fleetShare == null ? 1 : disp.fleetShare;
  if (!(share < 1)) return null;
  const nOther = Math.max(2, Math.round(disp.n * (1 - share) / share));
  const atS = opt.atS == null ? null : opt.atS;
  const alt = new Dispatcher(other, Object.assign({}, opt, { fleet: nOther, shareWith: disp }));
  alt.reset(atS);
  disp.peer = alt; alt.peer = disp;
  /* 初始铺开必须**避开对侧已经占住的位置**：两队各按自己的 spacing 均布，
     而干线是共用的 —— 实测两列车都落在同一个分区（第一版甚至是同一个里程 0）。
     固定闭塞的仿真里列车不能倒退，一旦两车重叠，`authority()` 把 limit 收到
     本车自己的位置（那是防重叠的最后一道硬夹），两列就此永久对锁：
     支线第一列 25 分钟只挪了 972 m，全程 22 km/h 蠕行等着前车"让开"。
     折返落点早就有这道检查（`_blockClear(0, t)`），开局铺开却没有。
     这里按**距离**而不是按分区判：分区判据在 s=0 这条线的端点上会退化
     （区间 [车尾, 车头] 被夹成零长度），而端点恰恰是两队最容易撞的地方。 */
  {
    const minGap = Math.max(alt.len + alt.guard + 60, alt.spacing * 0.45);
    const total = alt.al.total;
    const tooClose = (s, self) => {
      const scan = (list, skip) => {
        for (const x of list) {
          if (x === skip || x.s < 0 || x.state === 'stabled') continue;
          let dd = Math.abs(x.s - s); dd = Math.min(dd, total - dd);
          if (dd < minGap) return true;
        }
        return false;
      };
      if (scan(disp.trains, null)) return true;
      if (disp.playerS != null) {
        let dd = Math.abs(disp.playerS - s); dd = Math.min(dd, total - dd);
        if (dd < minGap) return true;
      }
      return scan(alt.trains, self);
    };
    for (const t of alt.trains) {
      for (let g = 0; g < alt.blocks.length * 2 && tooClose(t.s, t); g++) {
        t.s = (t.s + minGap) % total; t.tr.s = t.s;
      }
    }
  }
  return alt;
};

SH.nextTrain = (disp, line, stationIdx, opts) => {
  opts = opts || {};
  const S = line.al.stationS;
  const st = S[stationIdx];
  if (st == null || !disp || !disp.trains || !disp.trains.length) return null;
  const H = disp.stats();
  const med = Math.max(1, (H.medHeadwayMin || disp.headwayMin));
  /* 候选：车头**还没开过这一站**的那些。
     判据是"离站心还有多远"，取最近的一个。第一版漏了这个下限，于是**刚
     发车的那一列**（车头已经过站心几百米）仍然是里程最小的一个，屏上永远
     显示"即将进站"—— 一次实跑 24 分钟，屏上的文字一次都没变过。
     这与第 43 条（放行阈值取错粒度）是同一族：**词对了、粒度错了**。 */
  /* 候选：车头**还在站心前方**（或正停在本���）的那些，取离站心最近的一个。
     第一版写的是"还没开过这一站"（`d > -len-2`），而车队是循环运行的 ——
     于是一列刚从本站开出 200 m 的车，它的 `d = -200` 仍然"没开过"，
     屏上就一直跟着**刚走的那一列**，倒计时于是越来越大（实测 20 分钟里
     148 次变大、0 次变小）。
     这是本项目第三次栽在"循环车队里的方向"上：第 43 条是闭塞分区，
     第 85 条是分区相位，第三次是这里 —— 判据的正负方向。
     正确写法是"车头在站心前方"，本站停着的车自然满足（d≈0）。 */
  /* 候选：**车头还在本站前方（沿行车方向）**的那些，取最近的一列。
     量的是"从车头沿里程轴前进到站心还有多远"，即 `(st - t.s) mod total`，
     而不是 `t.s - st`。车队恒沿 +s 行驶，所以"前方"在里程轴上是**减法**方向 ——
     前两版分别按 `t.s - st` 的绝对值与符号取最小，结果都挑中了刚开过本站、
     越跑越远的那一列（实测 20 分钟里倒计时 148 次变大、0 次变小）。
     这是本项目第四次栽在"循环车队里的方向"上（第 43 条闭塞分区、第 85 条
     分区相位、第 86 条人群朝向、这一次），而根因都一样：
     **把里程当成一条直线，而它是一个环**。 */
  let best = null, bd = Infinity;
  const inter = SH.interlineMeta ? SH.interlineMeta(line, disp.hour) : null;
  /* 套跑（第 121 条）：分岔站之前的站两个交路都停，所以"下一班"必须把**对侧
     车队**一起算进来 —— 否则干线上明明 40 秒后要过一列支线车，屏上却报 4 分钟，
     而那块屏正对着站台。分岔站之后各走各的尾巴（站序在不同车站上），不合并。 */
  const onTrunk = !(inter && inter.forkIdx >= 0) || stationIdx <= inter.forkIdx;
  const pools = [[disp.trains, disp.al.total]];
  if (onTrunk && disp.peer) pools.push([disp.peer.trains, disp.peer.al.total]);
  for (const [list, total] of pools) {
    for (const t of list) {
      if (t === opts.self) continue;
      if (t.state === 'turnback' || t.state === 'stabled' || t.s < 0) continue;             // 已折返/入库/脱网的不再往本站来
      let rel = (st - t.s) % total;
      if (rel < 0) rel += total;
      /* 车已经停在本站（车头过了站心但整列车还没走完）⇒ 距离记 0，"到站"。
         这不是特例化：它就是"车头刚过站心"这个事实的连续写法。 */
      if (t.s >= st && t.s - st < disp.len + 2) rel = 0;
      if (rel < bd) { bd = rel; best = t; }
    }
  }
  /* 到站预告的门槛按**时间**而不是距离：真实屏的规则是"1 分钟内"，
     也就是距离 ÷ 旅行速度 ≤ 60 s。第二版写成"车头进站前 150 m 以内"，
     于是 46 km/h 的线上一列被扣住的车（停着不动）永远跨不过 150 m，
     屏就一直显示「N 分钟」—— 实测 5 条线 7 处。
     与其给距离门槛，不如直接把语义写成时间：**1 分钟内**就是 1 分钟内。 */
  const near = best && bd <= Math.max(60, disp.vAvg * 60);
  /* 「到站」= 车头已经压在站心上。
     第一版写的是 `bd <= -1`，而 `bd` 是循环折进 [0,total) 的，**永远不为负**
     —— 于是这一分支从未成立过，屏上从来没有出现过「到站」两个字，
     判据报"一列车正停在本站，屏上却显示「N 秒」"才把它挖出来。
     这与第 75 条"绿灯永远亮"是同一族：一个恒假的条件不抛错、不变慢，
     只是那一档显示永远用不上。 */
  const at = best && bd <= 1;
  /* 预报时间用**当前车速**外推，而不是旅行速度：车被扣住时屏上应该一直
     停在「N 分钟」（真实屏就是这样），而不是按旅行速度显示一个到不了的数字。
     前向速度取近 3 秒的平均，避免 ATO 换级那一瞬的速度抖动让数字跳。 */
  const secs = best ? Math.max(0, Math.round(bd / Math.max(4, disp.vAvg))) : 0;
  const mins = Math.min(99, Math.max(0, Math.round(secs / 60)));
  /* 末班：图定时刻表上该方向最后一班到达本站的时刻（SH.timetable 反推，
     与配车周转同一个模型），过了就是"已收车"。 */
  /* 收车判定：**物理上还有车停在这一站时，屏必须先说车到了**。
     原来把 'closed' 放在状态链最前，于是收车时段里一列车正在停站，
     屏上也写"已收车" —— 而屏正对着这列车。判据报出来才发现
     （磁浮 2 站、图定全程 450 s，6 分钟仿真就跨过末班）。
     真实屏的顺序也是这个：先报这一班到站，收车提示在下一条。 */
  /* 收车判定读**当日秒数**（与 HUD 钟点、天光同一条时间轴），不是"距首站发车多久"。 */
  const tt = SH.lastTrainAt(line, stationIdx, disp.wallClock());
  const last = tt != null && !at;
  const state = last ? 'closed' : at ? 'boarding' : near ? 'soon' : 'run';
  /* 下一班的**拥挤度**：真实上海站台屏在"下一班"旁边就报这一档
     （有座位 / 一般 / 较拥挤 / 很拥挤），它让站台上的人提前决定等不等这一班。
     数据直接读那列车的车载 `load` —— 与客流模型同一个时段系数，不另起一份估算；
     车还没出现（`best` 为空）时不报，而不是猜一个。 */
  const load = best ? best.load : null;
  const crowd = load == null ? '' : load >= 0.95 ? '很拥挤' : load >= 0.7 ? '较拥挤' : load >= 0.4 ? '一般' : '有座位';
  const dest = (best && best.dest) ? best.dest : line.terminus;
  return {
    terminus: dest,
    mins, secs, state, train: best, load, crowd,
    /* 屏上真正显示的文字：判据与 HUD 都读这三个串，不各自拼 */
    line1: '往 ' + dest,
    line2: last ? '已收车' : at ? '到站' : near ? (secs <= 40 ? secs + ' 秒' : '1 分钟内') : mins + ' 分钟',
    headwayMin: Math.round(med * 10) / 10,
  };
};

SH.traffic = { Dispatcher, Railcar, trainLen, HEADWAY, linkInterline };
})(typeof window !== 'undefined' ? window : globalThis);
