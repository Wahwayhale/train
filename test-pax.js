/**
 * 客流模型回归测试。
 * 断言的是"守恒 + 上限 + 单调 + 可复现"这四类性质——
 * 一个会算错的客流模型比没有客流模型更糟，因为它会让停车评分和物理载荷同时失真。
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

const line = SH.LINES.l1;
const stock = SH.STOCK ? SH.STOCK[line.stock] : null;
const st = stock || { cars: 8, doors: 5, width: 3.0 };

console.log('== 容量 ==');
const cap = SH.pax.capacity({ cars: st.cars, doors: st.doors, width: st.width, type: line.stock });
ok(cap.aw2 > 1000 && cap.aw3 > cap.aw2, `1 号线 ${st.cars} 节定员 ${cap.aw2} 人 / 超员线 ${cap.aw3} 人（${cap.cls} 型车 ${cap.perCar} 人/辆）`);

console.log('== 确定性与时段 ==');
const a1 = SH.pax.demand('l1', '人民广场', 12, 25, 8), a2 = SH.pax.demand('l1', '人民广场', 12, 25, 8);
ok(a1.board === a2.board && a1.alight === a2.alight, '同一站同一时刻两次查询完全一致');
const night = SH.pax.demand('l1', '人民广场', 12, 25, 23).board;
const rush = SH.pax.demand('l1', '人民广场', 12, 25, 8).board;
ok(rush > night * 2, `早高峰 ${rush} 人 > 夜间 ${night} 人`);
const hub = SH.pax.demand('l1', '徐家汇', 7, 25, 8).board;
const small = SH.pax.demand('l1', '外环路', 1, 25, 8).board;
ok(hub > small, `枢纽站 ${hub} > 郊区站 ${small}`);

console.log('== 守恒与上限 ==');
function runTrip(dwellSec, hour, startIdx, legs) {
  const f = new SH.pax.Flow({ id: line.id, stations: line.stations }, { cars: st.cars, doors: st.doors, width: st.width, type: line.stock }, hour);
  f.seedAt(startIdx, line.stations[startIdx]);
  const rows = [];
  for (let k = 1; k <= legs; k++) {
    const idx = startIdx + k;
    if (idx >= line.stations.length) break;
    const name = line.stations[idx];
    const wantOff = f.alightNeed(idx), wantOn = f.waitingAt(name, idx);
    f.beginStation(idx, name);
    let off = 0, on = 0;
    for (let s = 0; s < dwellSec; s += 0.5) { const r = f.flow(idx, name, 0.5); off += r.off; on += r.on; }
    f.endStation();
    const left = f.closeStation(idx, name);
    rows.push({ idx, name, wantOff, wantOn, off, on, left, onboard: f.onboard, fill: +f.fill().toFixed(3) });
    if (f.onboard < 0) return { bad: '车载人数为负 @' + idx, rows };
    if (f.onboard > f.cap.aw3) return { bad: `超超员线 @${idx} ${name}: onboard=${f.onboard} > aw3=${f.cap.aw3}（wantOn=${wantOn} off=${off} on=${on}）`, rows };
    if (!isFinite(f.loadFactor())) return { bad: 'load NaN' };
  }
  return { f, rows };
}
const t = runTrip(22, 8, 0, 12);
ok(!t.bad, t.bad || '12 站值乘全程无非法状态');
if (t.bad) { (t.rows || []).forEach(r => console.log('    ', r.idx, r.name, 'want', r.wantOff + r.wantOn, 'off', r.off, 'on', r.on, 'left', r.left, 'onboard', r.onboard, 'fill', r.fill)); process.exit(1); }
let sumIn = 0, sumOut = 0, sumLeft = 0;
t.rows.forEach(r => { sumIn += r.on; sumOut += r.off; sumLeft += r.left; });
const seed = new SH.pax.Flow({ id: line.id, stations: line.stations }, { cars: st.cars, doors: st.doors, width: st.width, type: line.stock }, 8);
const seedN = seed.seedAt(0, line.stations[0]);
ok(t.f.onboard === seedN + sumIn - sumOut, `车载 ${t.f.onboard} = 起点 ${seedN} + 上车 ${sumIn} − 下车 ${sumOut}`);
ok(t.f.boarded === sumIn && t.f.alighted === sumOut && t.f.leftBehind === sumLeft, '累计量与逐站记录一致');
/* 曾经整批人被抽到同一个目的站，跑 12 站显示"下客 0"——客流看着在动，
   实际上车厢里的人永远不下车。这条断言专门盯这个。 */
ok(sumOut > sumIn * 0.25, `12 站累计下车 ${sumOut} 人，占上车 ${sumIn} 的 ${Math.round(sumOut / Math.max(1, sumIn) * 100)}%（应当有明显量级）`);
ok(t.rows.slice(3).every(r => r.off > 0), '中段每一站都有人下车');

console.log('== 停站时长单调 ==');
const d5 = runTrip(5, 8, 0, 12), d30 = runTrip(30, 8, 0, 12);
const served5 = d5.f.boarded + d5.f.alighted, served30 = d30.f.boarded + d30.f.alighted;
ok(served30 >= served5, `停 30 s 服务 ${served30} 人 ≥ 停 5 s 的 ${served5} 人`);
ok(d5.f.leftBehind > d30.f.leftBehind, `停 5 s 甩客 ${d5.f.leftBehind} 人 > 停 30 s 的 ${d30.f.leftBehind} 人`);

console.log('== 帧率无关 ==');
/* 上面那个 floor() 的坑说明：乘降结果绝不能依赖离散步长。
   同一站、同样 12 秒，用 1/30 与 1/120 两种步长推进必须给出同样的服务人数。 */
function serveAt(dt) {
  const f = new SH.pax.Flow({ id: line.id, stations: line.stations }, { cars: 4, doors: 4, width: 2.4, type: 'C4' }, 8);
  f.seedAt(0, line.stations[0]);
  const idx = 3, name = line.stations[idx];
  f.beginStation(idx, name);
  let n = 0;
  for (let t = 0; t < 12; t += dt) { const r = f.flow(idx, name, dt); n += r.off + r.on; }
  return n;
}
const s30 = serveAt(1 / 30), s120 = serveAt(1 / 120);
ok(Math.abs(s30 - s120) <= 2, `1/30 s 帧 ${s30} 人 vs 1/120 s 帧 ${s120} 人（差 ≤ 2）`);
ok(s30 > 0, `4 节 C 型车（16 对门）也能完成乘降：12 s 服务 ${s30} 人`);

console.log('== 载荷与物理耦合 ==');
const empty = new SH.pax.Flow({ id: line.id, stations: line.stations }, { cars: st.cars, doors: st.doors, width: st.width, type: line.stock }, 23);
ok(empty.loadFactor() < 0.9, `夜间空车 load=${empty.loadFactor().toFixed(2)}（AW0 侧）`);
const f2 = runTrip(30, 8, 0, 12).f;
ok(f2.loadFactor() > empty.loadFactor(), `早高峰跑完 12 站 load=${f2.loadFactor().toFixed(2)}，满载率 ${f2.pct()}%`);
ok(f2.loadFactor() >= 0.72 && f2.loadFactor() <= 1.32, 'load 落在 physics.js 的钳位区间内');
/* 真的传进物理：同一手柄位，空车与超员的加速度必须不同 */
/* 真正走一遍物理模型：同一手柄位、同一时刻，空车与超员的加速度必须分开，
   否则"客流"就只是个数字，没有回到司机手上。 */
const spec = { perf: SH.PERF[line.perf] || SH.PERF.A8, stock: SH.STOCK[line.stock] || st, maxKmh: line.maxKmh };
const mkTr = load => {
  const tr = new SH.physics.Train(spec);
  tr.load = load; tr.setNotch(4);
  for (let i = 0; i < 90; i++) tr.update(1 / 30, 0);
  return tr;
};
const trLight = mkTr(0.84), trHeavy = mkTr(1.22);
ok(trHeavy.a < trLight.a - 1e-4, `同一 P4：空车 a=${trLight.a.toFixed(3)} m/s² > 超员 a=${trHeavy.a.toFixed(3)} m/s²`);
/* 从**同一初速**开始制动才有可比性：先加速再刹的话，超员车本来就跑不快，
   刹得近只是因为刹得晚，不能说明制动距离。 */
const brakeDist = load => {
  const t = new SH.physics.Train(spec);
  t.load = load;
  t.v = 80 / 3.6; t.kmhCache = 80;
  const s0 = t.s;
  t.setNotch(-7);
  let guard = 0;
  while (t.v > 0.05 && guard++ < 4000) t.update(1 / 30, 0);
  return t.s - s0;
};
const bLight = brakeDist(0.84), bHeavy = brakeDist(1.22);
ok(bHeavy > bLight * 1.02, `80 km/h 起 B7 制动：空车 ${bLight.toFixed(0)} m，超员 ${bHeavy.toFixed(0)} m（超员更长）`);

/* ---- 开局那一车人必须由模型算出来（`primeTo`），不是拍一个百分比 ----
 * 以前 `seedAt` 给的是 `min(发送量, 定员×0.45)` —— 不管几点、不管你在哪一站上车，
 * 车里永远 45%。整条线跑满能到 106~131% 满载、甩客几百人，可玩家一局只跑三站，
 * 永远接触不到那个断面：于是"挤不上车""停站被拖长""客运分扣得下来"全是纸面上的。
 * 现在初始车载 = 从线路起点逐站服务到上车站之后剩下的状态。 */
{
  const L2 = SH.LINES.l2, S2 = SH.STOCK[L2.stock];
  const mk = (hour) => new SH.pax.Flow(
    { id: L2.id, stations: L2.stations },
    { cars: S2.cars, doors: S2.doors, width: S2.width, type: L2.stock }, hour);
  const fillAt = (hour, i0) => {
    const f = mk(hour);
    f.primeTo(i0);
    return { fill: f.fill(), seed: f.onboard, wait: f.waitingAt(L2.stations[i0], i0),
      dirty: f.boarded + f.alighted + f.leftBehind + f.log.length };
  };
  const peak = fillAt(8, 10), mid = fillAt(13, 10), night = fillAt(23, 10);
  ok(peak.fill > mid.fill && mid.fill > night.fill,
    `同一站初始满载必须随时段单调：静安寺 高峰 ${(peak.fill * 100) | 0}% > 平峰 ${(mid.fill * 100) | 0}% > 夜间 ${(night.fill * 100) | 0}%`);
  const near = fillAt(8, 2), deep = fillAt(8, 18);
  ok(near.fill < peak.fill && peak.fill < deep.fill,
    `初始满载必须沿走廊累积：虹桥火车站 ${(near.fill * 100) | 0}% < 静安寺 ${(peak.fill * 100) | 0}% < 世纪公园 ${(deep.fill * 100) | 0}%`);
  ok(deep.fill >= 0.9, `早高峰从内段站上车必须至少 90% 满载（实得 ${(deep.fill * 100) | 0}%）—— 否则"挤不上车"在玩法里永远不出现，客运那 30% 权重就是装饰`);
  ok(peak.dirty === 0, `预跑不得把统计留给玩家（boarded/alighted/leftBehind/log 合计须为 0，实得 ${peak.dirty}）—— 否则他还没接手的那半条线会被算成他的成绩`);
  ok(peak.wait > 0, '预跑之后玩家这一站的站台必须重新有人候乘，否则开局第一站无上客');
  /* 同源：初始车载与"再往前跑一站"的结果必须连续（同一个模型，不是两套数） */
  const f1 = mk(8); f1.primeTo(10);
  const after10 = f1.onboard;
  const f2 = mk(8); f2.primeTo(11);
  ok(f2.onboard > 0 && Math.abs(f2.onboard - after10) / S2.cars < 400,
    `primeTo 必须逐站连续推进（10→11 跳变 ${(f2.onboard - after10).toFixed(0)} 人，上限 400 人/辆）`);
}

/* ---- 客流与 AI 车载必须读**同一个**时段系数（第 97 条）----
 * 站台上候乘的人数与开进来那几列车车里的人数是同一件事的两种表现。
 * 两者都乘 `SH.pax.rushFactor`，于是各时段**除以同一个系数之后必须相等**
 * —— 这比"高峰比夜间大"强得多：只要任何一边偷偷改了自己的时段表
 * （哪怕两边都还是单调的），比值立刻发散。
 * `demand()` 里除 `rush` 之外的项（站点哈希、枢纽系数、核心区系数、端点系数）
 * 都与时段无关，所以这个等式在数学上必须严格成立。 */
{
  const L2 = SH.LINES.l2, S2 = SH.STOCK[L2.stock];
  const HOURS = [2, 7, 10, 13, 15, 18, 21];
  const rs = HOURS.map(h => {
    const f = new SH.pax.Flow({ id: L2.id, stations: L2.stations },
      { cars: S2.cars, doors: S2.doors, width: L2.stock.width, type: L2.stock }, h);
    const wait = f.waitingAt(L2.stations[10], 10);
    return { h, wait, rf: SH.pax.rushFactor(h), k: wait / SH.pax.rushFactor(h) };
  });
  const lo = Math.min(...rs.map(r => r.k)), hi = Math.max(...rs.map(r => r.k));
  ok(hi / lo <= 1.02, `站台候乘人数必须与时段系数严格成正比（${rs.map(r => r.h + '时×' + r.rf.toFixed(2) + '→' + r.wait).join(' · ')}；除以系数后极差 ${(100 * (hi / lo - 1)).toFixed(1)}%）—— 客流模型里有第二份时段表`);
}

/* ---- 站台人群朝向（world.js 的 crowd()）：排队者面向屏蔽门（身体横着），
   走客顺着站台走，各带 ±0.3 rad 抖动。朝向是行为的一部分，不是配色：
   一排同一朝向的剪影从站台机位看过去就是一排纸片。
   用合成的 直-曲-直 线形测 —— 曲线段上"横着"必须跟着线路航向转，
   世界轴对齐的朝向只会在碰巧沿 Z 的直线上碰巧对。 */
console.log('== 站台人群朝向 ==');
{
  const al = new SH.Alignment();
  al.line(1200).arc(400, 600, 1).line(1200);
  const mkWb = () => new SH.WorldBuilder({ al, color: '#c00', stations: ['甲', '乙'],
    sign: { add: () => ({ r: [0, 0, 1, 1] }), dirty: false }, night: .5, profile: {}, waterRanges: [] });
  /* 直线段一处 + 曲线段一处 */
  const w1 = mkWb(); w1.crowd(600, 1, 2.05, 408, 792, 42, 120);
  const w2 = mkWb(); w2.crowd(1400, 1, 2.05, 1208, 1592, 77, 120);
  const info = [...(w1.crowdInfo || []), ...(w2.crowdInfo || [])];
  ok(info.length >= 30, `crowd() 必须把朝向记进 crowdInfo（实得 ${info.length} 条）—— 没有它，朝向又是"算了但没人验"`);
  let qPerp = 0, qn = 0, wPara = 0, wn = 0, wFwd = 0;
  for (const c of info) {
    const fr = al.frame(c.s);
    /* box 的窄轴（身体进深）= 朝向 = (sin yaw, 0, cos yaw) */
    const dotF = Math.sin(c.yaw) * fr.f[0] + Math.cos(c.yaw) * fr.f[2];
    if (c.queuing) { qn++; if (Math.abs(dotF) < 0.5) qPerp++; }
    else { wn++; if (Math.abs(dotF) > 0.7) { wPara++; if (dotF > 0) wFwd++; } }
  }
  ok(qn > 0 && qPerp / qn > 0.9, `排队者 ${qPerp}/${qn} 面向屏蔽门（朝向与行车方向垂直）—— 应 >90%`);
  ok(wn > 0 && wPara / wn > 0.9, `走客 ${wPara}/${wn} 顺着站台走（朝向与行车方向平行）—— 应 >90%`);
  ok(wFwd > 0 && wFwd < wPara, `走客必须两个方向都有（顺行 ${wFwd} / 逆行 ${wPara - wFwd}）—— 全是同一方向还是一排纸片`);
  /* 谁都不许站到护栏外：高架站的玻璃护栏在 STATION_X.rail（5.47 m），
     散布上限收在护栏内（station() 传 maxOff）。越过护栏的人会隔着玻璃
     变成半透明鬼影（dev/shot.js 的 ghost 截图抓到的实景证据）。 */
  const w3 = mkWb(); w3.crowd(600, 1, 2.05, 408, 792, 42, 120, SH.STATION_X.rail - 0.45);
  const over = (w3.crowdInfo || []).filter(c => c.off > SH.STATION_X.rail - 0.45 + 1e-9);
  ok(!over.length, `高架站没人越过玻璃护栏（上限 ${(SH.STATION_X.rail - 0.45).toFixed(2)} m，实测越界 ${over.length} 人）`);
}

/* ---- 站台机位的站位净空（诚实清单 §7.10 的"纸箱"）----
   量出来的事实：相机眼在 (站心−26, 横向 3.5)，而候乘横向带 2.90~6.20 沿站台均布，
   实测 8 处机位里 6 处**有人正好长在镜头上**（最近 0.82 m）。十字人形的两片在 1 m
   内摊开，画面上就是一只"打开的纸箱"——旧账把它猜成"最近一块屏 lat 4.70"，
   也猜成过"身旁那片是屏蔽门"，两次都没量。这一节钉三件事：
   ① 净空泡里不许有人（Euclid 距离 ≥ r）；
   ② 净空**不删人** —— 人数是停站时长的依据，推位置可以，少一个就是谎报一个；
   ③ 相机与净空同源 —— 站位只许写在 `SH.PLAT_CAM` 一处，`SH.platformShot` 读它。 */
console.log('== 站台机位站位净空（§7.10）==');
{
  const al = new SH.Alignment();
  al.line(1200).arc(400, 600, 1).line(1200);
  const mkWb = () => new SH.WorldBuilder({ al, color: '#c00', stations: ['甲', '乙'],
    sign: { add: () => ({ r: [0, 0, 1, 1] }), dirty: false }, night: .5, profile: {}, waterRanges: [] });
  const CS = 600, r = SH.PLAT_CAM.r, camS = CS + SH.PLAT_CAM.dz, camLat = SH.PLAT_CAM.lat;
  const infoCam = [], infoNo = [];
  const w = mkWb();
  w.crowd(CS, 1, 2.05, CS - 150, CS + 42, 42, 120);                       // 经 crowd()：带净空
  infoCam.push(...(w.crowdInfo || []));
  const w2 = mkWb();
  SH.WorldBuilder.crowdInto(w2.b, al, 1, 2.05, CS - 150, CS + 42, 42, 120, null, infoNo,
    null, null, null, null);                                              // 不带净空的同一批人
  const inside = infoCam.filter(c => Math.hypot(c.s - camS, c.off - camLat) < r - 1e-6);
  const nExp = Math.round(120 / 3.4);
  ok(infoCam.length === nExp && infoNo.length === nExp,
    `样本与发射人数都钉在 候乘÷3.4 = ${nExp}：带净空 ${infoCam.length}、不带 ${infoNo.length}（少一个就是谎报停站时长，多一个就是两份真值）`);
  ok(!inside.length, `站台机位站位（站心${SH.PLAT_CAM.dz}、横向 ${camLat}）半径 ${r} m 内没人挡镜头（实测 ${inside.length} 个在泡里，最近 ${infoCam.length ? Math.min(...infoCam.map(c => Math.hypot(c.s - camS, c.off - camLat))).toFixed(2) : '-'} m）`);
  const moved = infoCam.filter((c, i) => infoNo[i] && Math.abs(c.s - infoNo[i].s) > 1e-9).length;
  ok(infoCam.length === infoNo.length,
    `净空不删人：带净空 ${infoCam.length} 人 vs 不带 ${infoNo.length} 人（人数是停站时长的依据）`);
  ok(moved > 0 && moved <= Math.ceil(infoCam.length * 0.2),
    `确实推了人、且只推挡镜头那几个：${moved}/${infoCam.length} 个站位变了（一个都没变=净空没生效；变得太多=在重排整片人群）`);
  const gsrc = require('fs').readFileSync('./src/game.js', 'utf8');
  const i0 = gsrc.indexOf('SH.platformShot ='), seg = gsrc.slice(i0, gsrc.indexOf('\n};', i0));
  ok(seg.includes('SH.PLAT_CAM.dz') && seg.includes('SH.PLAT_CAM.lat') && !/side \* 3\.5|ns\.s - 26/.test(seg),
    '站台机位的站位读 SH.PLAT_CAM（源码 lint）—— 相机与净空各写一份就会"挪了相机忘了挪净空"');
}

/* ---- 站台乘降可视化（第 101 条）：人群从"烘死的布景"变成"随乘降重建的批次"。
   这一节量四件事：
     A 唯一实现 —— `crowdStation`（运行时重建）与 `crowdInto`（烘焙）对同一站
       同一人数必须给出**同一个**人数与同一批站位；
     B 人数随候乘单调、且候乘归零时站台真的空 —— 否则"人都上车了"永远差几个人；
     C 确定性 —— 同参数两次重建逐顶点一致（否则每 0.2 s 重建一次人群会闪；
       而"闪"在截图上恰好看不出来，只能靠数值）；
     D 接线 —— 人群批次真的从世界网格里拆出来了（`wb.crowdB`）、真的有重建
       （`dropTag('crowd')`）、真的每帧被调用（`syncCrowd` 在 frame 里）。
   用的是合成线形，因为这一节只关心"人数与站位"，不关心是哪条线。 */
console.log('== 站台乘降可视化 ==');
{
  const B = SH.Builder || global.Builder;
  const al = new SH.Alignment();
  al.line(1500).arc(400, 600, 1).line(1500);
  al.stationS = [600, 1300, 1900];
  const line = { al, stations: ['甲', '乙', '丙'], stationSide: () => 1, isElevated: () => false };
  const vertsOf = (i, c, lg) => {
    const b = new B();
    const n = SH.WorldBuilder.crowdStation(b, line, lg || null, i, c, null);
    let v = 0; for (const m of b.finish()) v += m.verts;
    return { n, v };
  };
  /* A 唯一实现：两条路径的人数与顶点数必须一致 */
  const infoA = [], bA = new B();
  const nA = SH.WorldBuilder.crowdStation(bA, line, null, 1, 400, infoA);
  const infoB = [], bB = new B();
  const nB = SH.WorldBuilder.crowdInto(bB, al, 1, SH.STATION_X.front, 1300 - 150, 1300 + 42,
    SH.hash32('乙', 7), 400, 9.5, infoB);
  let vA = 0, vB = 0;
  for (const m of bA.finish()) vA += m.verts;
  for (const m of bB.finish()) vB += m.verts;
  ok(nA === nB && vA === vB, `运行时重建与烘焙是同一段代码（人数 ${nA}/${nB}、顶点 ${vA}/${vB}）—— 两份"人怎么摆"就是第二个真值`);
  ok(infoA.length === nA && infoB.length === nA, `重建也能把站位/朝向记进 info（${infoA.length} 条）—— 判据要能验重建的产物`);
  /* B 人数随候乘单调 + 归零即空 */
  const seq = [0, 40, 200, 400, 800].map(c => Object.assign({ c }, vertsOf(1, c)));
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i].v < seq[i - 1].v) mono = false;
  ok(mono, `站台人数随候乘单调增加（${seq.map(x => x.c + '人→' + x.v + '顶点').join(' · ')}）`);
  ok(seq[0].n === 0 && seq[0].v === 0, `候乘归零时站台必须真的空（实得 ${seq[0].n} 人 / ${seq[0].v} 顶点）—— 留一个下限就会"人上完了台上还站着几个"`);
  ok(seq[4].v > seq[1].v * 5, `候乘 800 人（${seq[4].v} 顶点）显著多于 40 人（${seq[1].v}）—— 密度真的跟着客流走`);
  /* C 确定性：逐顶点一致 */
  const hashOf = c => { const b = new B(); SH.WorldBuilder.crowdStation(b, line, null, 2, c, null); const m = b.finish()[0]; let s = 0; for (let i = 0; i < m.pos.length; i++) s = (s * 31 + Math.round(m.pos[i] * 1000)) | 0; return s; };
  ok(hashOf(500) === hashOf(500), '同一人数两次重建逐顶点一致（否则每 0.2 s 重建一次人群会闪）');
  ok(hashOf(500) !== hashOf(120), '不同人数给出不同布局（人数变了而画面没变 = 重建没生效）');
  /* D1 人群细节：人是"有头发/手臂/背包/手机的立体人"，不是两块盒子。
     量**人均三角形数**（≥ 24：头发 12 + 两臂 24 只会多不会少）与
     手机自发光顶点（走客 45% 看手机 → 200 人规模必然有 'light' 顶点）。
     只量"有几何"不量"有细节"的话，crowdbare 那种"退回两块盒子"的变异测不到。 */
  {
    /* count=340 恰好是 100 个人（人数 = 候乘 ÷ 3.4），人均三角形才有确定的分母。
       实测带全部细节 118.4/人；退回两块盒子只有 ~70，去掉头发 106、去掉手臂 97 ——
       门槛 112 卡在"细节齐全"与"任意一件细节被抽走"之间。 */
    const bD = new B();
    const nD = SH.WorldBuilder.crowdStation(bD, line, null, 1, 340, null);
    let tris = 0, lightV = 0;
    for (const m of bD.finish()) {
      tris += m.count / 3;
      if (m.mat === 'light') lightV += m.verts;
    }
    const per = tris / nD;
    /* 第 111 条把人物升级成"颈 + 分腿 + 鞋 + 裙装/长发/手提袋变体"之后，
       人均从 118.4 涨到 181.0 —— 门槛跟着提到 170：抽走**任意一件**细节
       （头发/手臂/鞋/颈 各 12~24 个三角形）都会掉下去。 */
    ok(nD === 100 && per >= 170, `人群人均 ${per.toFixed(1)} 个三角形（100 人、应 ≥ 170）—— 头发/手臂/分腿/鞋这些细节被抽走就会掉到 170 以下`);
    ok(lightV > 0, `人群里有 ${lightV} 个手机自发光顶点（应 > 0）—— 夜里站台上那点冷光没了`);
  }
  /* D1b 体型变体（第 111 条）：同一副 person() 按配置给出**不同的**几何 ——
     裙装/长发/手提袋不是"抽了签但没人画"。 */
  {
    const frP = al.frame(1300);
    const mkP = over => { const bX = new B();
      SH.WorldBuilder.person(bX, al, frP, 3.0, 1, Object.assign(
        { h: 1.7, th: 0.42, hue: '#3a4a3d', face: '#c8a486', hair: '#191d21',
          pack: false, phone: false, lug: null, seat: false, yawJ: 0,
          skirt: false, longHair: false, tote: false }, over));
      let t = 0; for (const m of bX.finish()) t += m.count / 3; return t; };
    const t0 = mkP({}), t1 = mkP({ skirt: true, longHair: true, tote: true });
    ok(t0 >= 140, `标准体型 ${t0} 个三角形（应 ≥140：颈/分腿/鞋都在 —— 退回"圆锥人"就掉下去）`);
    ok(t1 - t0 >= 30, `裙装+长发+手提袋比标准体型多 ${t1 - t0} 个三角形（应 ≥30）—— 体型变体抽了签但没人画`);
  }
  /* E 登车次序：截断必须从"门口排队的人"开始，而且**保留的是同一批人的前缀**。
     两条缺一不可：只满足前者（按是否排队排序）会让每次重建整片人群重排，
     画面上是"人原地闪烁"；只满足后者（固定比例抽签）读起来是"人群随机少了几个人"。
     它们互相冲突，唯一的解法是让"排队者比例沿序列递增"且与人数无关。 */
  const people = c => { const b = new B(); const inf = []; SH.WorldBuilder.crowdStation(b, line, null, 1, c, inf); return inf; };
  /* 站厅层与街面的人是"另外两层"，不参与站台的排队/截断统计 —— 那两条讲的是
     "谁先从站台上消失"。层级用 record.hall / record.street 分。 */
  const rawA = people(800), rawZ = people(400);
  const A = rawA.filter(x => !x.hall && !x.street), Z = rawZ.filter(x => !x.hall && !x.street);
  let pre = true;
  for (let i = 0; i < Z.length; i++) if (Math.abs(Z[i].s - A[i].s) > 1e-9 || Math.abs(Z[i].off - A[i].off) > 1e-9) { pre = false; break; }
  ok(pre, `候乘减少时保留的是**同一批人的前缀**（${A.length} → ${Z.length} 逐人一致）—— 否则每次重建整片人群重排，画面上是人原地闪烁`);
  const qA = A.filter(x => x.queuing).length, qZ = Z.filter(x => x.queuing).length;
  const cutQ = (qA - qZ) / Math.max(1, A.length - Z.length);
  ok(cutQ > 0.78, `被截掉的人里排队者占 ${(100 * cutQ).toFixed(0)}%（总体 ${(100 * qA / A.length).toFixed(0)}%）—— 先走的是门口那批人，读起来才是"上车了"`);
  const tailQ = A.slice(-20).filter(x => x.queuing).length, headQ = A.slice(0, 20).filter(x => x.queuing).length;
  ok(tailQ > headQ + 5, `序列尾部以排队者为主（尾 20 人里 ${tailQ} 个排队 vs 头 20 人里 ${headQ} 个）—— 递增比例真的生效`);
  /* D 接线 lint：剥掉注释再查，免得注释里的字面量假命中 */
  const gsrc = require('fs').readFileSync('./src/game.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(/wb\.crowdB\s*=\s*cb\b/.test(gsrc), 'game.js 的 bake() 把人群导进了独立批次（`wb.crowdB = cb`）—— 它不再烘死在世界网格里');
  ok(/dropTag\('crowd'\)/.test(gsrc), 'game.js 在重建前释放旧的人群批次（`dropTag(\'crowd\')`）—— 不漏 GPU 缓冲');
  ok(/this\.syncCrowd\(/.test(gsrc), 'game.js 每帧同步人群（`syncCrowd`）—— 批次真的会被更新');
  const wsrc = require('fs').readFileSync('./src/world.js', 'utf8');
  ok(/static crowdStation\(/.test(wsrc) && /static crowdInto\(/.test(wsrc), 'world.js 有 crowdStation / crowdInto 单点入口（烘焙与运行时重建共用）');
}

/* ---- 乘降可视化 B4（第 110 条）：下车的人先从门里出来、上车的人随后走进门，
   密度与门的通过能力 / 开门时长挂钩。开门之前，站台上有"等着的人"已经够了；
   但车里明明载着到这站下车的人（OD 模型早算好了），画面上却从没有人走出来，
   上车也只是"门口的人原地消失" —— 车门开着的那 30 秒，站台是死的。
   这一节全部量结果，五件事：
     A 下车人流存在、位置与朝向对 —— 站在门线与走行带之间、沿站台走向端头；
     B 密度与门的通过能力挂钩 —— rate 砍半，同一 dwell 画面上的人近乎减半；
     C 有始有终 —— 开门够久全部走完；need=0、关门（不给 alight）时一个人都没有；
     D 上车带与开门时长挂钩 —— 同样候乘、dwellNeed 拉长，带里的人变少；
       带里的人确实比排队的人更靠近门线；没有 alight 时带不存在（几何不变）；
     E 模型喂几何 + 运行时接线 —— 下车人数/节奏来自真实 Flow（l1 早高峰），
       而不是视觉层自己编的数；syncCrowd 的重建签名必须吃 dwell 桶与下车需求，
       否则下车期间 waitingAt 不变、一次重建都不发生，人流永远不出现。 */
console.log('== 乘降可视化 B4 ==');
{
  const B = SH.Builder || global.Builder;
  const al = new SH.Alignment();
  al.line(1500).arc(400, 600, 1).line(1500);
  al.stationS = [600, 1300, 1900];
  const line = { al, stations: ['甲', '乙', '丙'], stationSide: () => 1, isElevated: () => false };
  const SS = 1300, S0 = SS - 150, S1 = SS + 42;
  /* 走 syncCrowd 的同一条路径（crowdStation → crowdInto），info 记下每个人的
     {s, off, queuing, yaw, band, alight, p} —— 位置与角色判据直接读它 */
  const build = (c, alight) => { const b = new B(); const inf = [];
    SH.WorldBuilder.crowdStation(b, line, null, 1, c, inf, alight);
    return inf; };
  const mkA = (dwell, need, rate, dwellNeed, wait0) => ({ dwell, need, rate, dwellNeed, wait0 });
  const walkers = inf => inf.filter(x => x.alight);
  const dotF = (c, fr) => Math.sin(c.yaw) * fr.f[0] + Math.cos(c.yaw) * fr.f[2];

  /* A 下车人流存在、位置与朝向对。
     人流分两段：**走行段**（沿站台走向最近的出入口，朝向站台方向）与
     **末段**（拐向梯段口、沿楼梯上行/下行，朝向横向）。末段是**瞬态**的 ——
     任一时刻只有少数人正走在楼梯上（真实站台就是这样），所以判据在一个
     dwell 扫掠上取并集，而不是钉死在某一时刻（钉死会耦合在随机流上，
     抽签一变就误报）。 */
  const wA = [];
  for (let dw = 2; dw <= 26; dw += 1) for (const x of walkers(build(340, mkA(dw, 340, 24, 12, 340)))) wA.push(x);
  ok(wA.length >= 15, `开门期间累计 ${wA.length} 个下车步行者（应 ≥15）—— 下车人流根本没被画出来`);
  const walking = wA.filter(x => !x.dy), turning = wA.filter(x => x.dy);
  const offBad = walking.filter(x => x.off < SH.STATION_X.front + 0.5 - 1e-6 || x.off > SH.STATION_X.front + 3.1);
  ok(!offBad.length, `走行段的步行者站在门线（${(SH.STATION_X.front + 0.5).toFixed(2)} m）与走行带（+3.1 m）之间（越界 ${offBad.length} 人）—— 站错位置就是布景`);
  const turnBad = turning.filter(x => x.off < SH.STATION_X.front + 0.5 || x.off > SH.STATION_X.front + 5.6);
  ok(!turnBad.length, `末段（拐向梯段）的人横向落在梯口一带（越界 ${turnBad.length} 人）`);
  const sBad = wA.filter(x => x.s < S0 + 6 || x.s > S1 - 5);
  ok(!sBad.length, `步行者都还在站台范围内（越界 ${sBad.length} 人）`);
  let para = 0, fwd = 0;
  for (const x of walking) { const df = Math.abs(dotF(x, al.frame(x.s))); if (df > 0.7) { para++; if (dotF(x, al.frame(x.s)) > 0) fwd++; } }
  ok(walking.length > 0 && para === walking.length && fwd > 0 && fwd < walking.length,
    `走行段 ${para}/${walking.length} 沿站台方向走、两个出入口都有人去（顺行 ${fwd}）—— 不是一排纸片`);
  /* 末段：**朝向横向**（转身对着梯段上楼/下楼），且人确实走在"最后这一段路径"上 ——
     判据按模型自己的定义量：`raw > SH.EXIT_TURN` 的人，到出入口的剩余距离
     必须 ≤ (1 − EXIT_TURN) × 出发点到出入口的距离。这样它量的是"终点就是出入口"
     这件事，而不是某个写死的米数。 */
  const EXS = SH.PLATFORM_EXITS.map(o => SS + o);
  const nearOf = x => EXS.reduce((a, e) => Math.abs(x.s - e) < Math.abs(x.s - a) ? e : a, EXS[0]);
  const fracOf = x => Math.abs(x.s - nearOf(x)) / Math.max(1e-6, Math.abs(x.from - nearOf(x)));
  const badTurn = turning.filter(x => fracOf(x) > (1 - SH.EXIT_TURN) + 1e-6);
  ok(turning.length > 0 && !badTurn.length,
    `末段 ${turning.length - badTurn.length}/${turning.length} 的人走在通往出入口的最后一段（越界 ${badTurn.length} 人）—— 人要在**楼梯上**消失，不是走到站台端头凭空不见`);
  const closest = turning.length ? Math.min(...turning.map(x => Math.abs(x.s - nearOf(x)))) : 999;
  ok(closest < 1.5, `末段最靠近出入口的人距梯口 ${closest.toFixed(2)} m（应 <1.5）—— 人得真的走到梯口`);
  const perp = turning.filter(x => Math.abs(dotF(x, al.frame(x.s))) < 0.4).length;
  ok(turning.length > 0 && perp === turning.length, `末段 ${perp}/${turning.length} 转身朝向梯段（横向）—— 侧着身子爬楼梯就是布景`);
  /* 下车人流的终点**就是**出入口（SH.PLATFORM_EXITS），不是站台端头 ——
     每一个步行者记下的 ex 都必须落在这一组值上。 */
  const exSet = [...new Set(wA.map(x => Math.round(x.ex)))].sort((a, b) => a - b);
  ok(exSet.length === 2 && exSet[0] === Math.round(EXS[0]) && exSet[1] === Math.round(EXS[1]),
    `步行者的终点集合 = ${exSet.join(' / ')}（应为出入口 ${EXS.map(v => Math.round(v)).join(' / ')}）`);

  /* B 密度与门的通过能力挂钩：rate 砍半 → 同一时刻画面上的人近乎减半。
     dwell 取 3 s：**还没有人走到出入口**（走行段刚开始），于是画面人数
     就等于"已经出门的人数"= 严格 ∝ rate —— 用大 dwell 量会被"走完的人"
     混进来，比值被走行距离的分布搅乱（那不是密度机制，是几何）。 */
  const wFast = walkers(build(340, mkA(3, 340, 24, 12, 340))).length;
  const wSlow = walkers(build(340, mkA(3, 340, 12, 12, 340))).length;
  ok(wSlow >= 5 && wFast / Math.max(1, wSlow) > 1.5 && wFast / Math.max(1, wSlow) < 2.6,
    `rate 24→12，开门 3 s 的步行者 ${wFast}→${wSlow}（比值 ${(wFast / Math.max(1, wSlow)).toFixed(2)}）—— 下车节奏不跟门的通过能力走，密度就是编的`);
  const wEarly = walkers(build(340, mkA(1.2, 340, 24, 12, 340))).length;
  ok(wEarly < wFast, `开门 1.2 s（${wEarly} 人）< 3 s（${wFast} 人）—— 人流随开门时长累积`);

  /* C 有始有终 */
  ok(walkers(build(340, mkA(400, 340, 24, 12, 340))).length === 0, '开门足够久，下车的人全部走完（一个不剩）—— 只出生不消失就是贴图');
  ok(walkers(build(340, mkA(5, 0, 24, 12, 340))).length === 0, '本站没人下车（need=0）时一个步行者都没有');
  ok(walkers(build(340, null)).length === 0, '不给 alight 时一个步行者都不建（几何与旧版一致）—— 关门后"人还在走"是 Session 的 egress 过程管的，不是视觉层自作主张');

  /* D 上车带与开门时长挂钩 */
  const bandOf = inf => inf.filter(x => x.band != null);
  const short = build(340, mkA(0.5, 0, 24, 10, 340)), long = build(340, mkA(0.5, 0, 24, 40, 340));
  const bShort = bandOf(short).length, bLong = bandOf(long).length;
  /* 阈值按**站台那一部分人**给：分层之后带天然变短（原来 100 人全在站台，
     现在只有 58 人），要守的是"带随 dwellNeed 反比收缩"这个比值，
     以及它不是零头。 */
  ok(bShort >= 8 && bShort / Math.max(1, bLong) > 1.8,
    `dwellNeed 10 s → 40 s，上车带 ${bShort}→${bLong} 人 —— 带不跟开门时长走，"挤得越狠上得越慢"在画面上就不存在`);
  const mQ = arr => arr.reduce((a, x) => a + x.off, 0) / Math.max(1, arr.length);
  const qMean = mQ(short.filter(x => x.queuing && x.band == null));
  const bandArr = bandOf(short);
  /* 带是一个"越走越近"的**序列**：队首（刚起步，band=1/bandM）可能还在原位置
     附近，所以"每个人都比排队均值近"是耦合在某一条特定随机流上的脆断言 ——
     抽签流一挪（比如人物属性变体追加抽签）就会误报。钉的是机制的本意：
     整体显著更近 + 队尾（band=1）真的走到门线。 */
  ok(mQ(bandArr) < qMean - 0.5 && bandArr[bandArr.length - 1].off < SH.STATION_X.front + 0.85,
    `上车带（均值 ${mQ(bandArr).toFixed(2)} m）显著比排队的人（均值 ${qMean.toFixed(2)} m）靠近门线，队尾走到 ${bandArr[bandArr.length - 1].off.toFixed(2)} m —— 不是原地消失`);
  ok(build(340, null).every(x => x.band == null), '没有 alight 时上车带不存在 —— 烘焙几何必须与旧版一致');

  /* E1 模型喂几何：步行者的总量与节奏来自真实 Flow（l1 早高峰） */
  const wsrc = require('fs').readFileSync('./src/world.js', 'utf8');
  const L1 = SH.LINES.l1, ST1 = SH.STOCK[L1.stock] || { cars: 8, doors: 5, width: 3.0 };
  let pick = -1, vv = null;
  /* 玩家的车次：primeTo(i-1) 预跑到上车站，车到站 i 时才有人下车（OD 的 dest
     里还留着到 i 的人）—— 所以找的是"下一站"的断面。**每个断面一条新 Flow**：
     primeTo 不清 dest/waiting（重复预跑会把上一段的甩客与没上完的人带进来，
     同一辆车被预跑七遍之后，"真实断面"就变成了判据自己状态演化的产物）。
     阈值取实测可达的档：人民广场 461 下 / 628 候乘 / dwellNeed 23.0 s、
     上海火车站 716 下 / 849 候乘（早高峰 l1，每站一条新 Flow 的值，
     与 dev/shot.js 的 DWELL 钩子同一条构造路径 —— 两个数必须对得上）。 */
  for (let i = 6; i <= 16; i++) {
    const flow = new SH.pax.Flow({ id: L1.id, stations: L1.stations }, { cars: ST1.cars, doors: ST1.doors, width: ST1.width, type: L1.stock }, 8);
    flow.primeTo(i - 1);
    const name = L1.stations[i];
    flow.beginStation(i, name);
    const v = flow.visual(i, name);
    if (v.need >= 140 && v.wait0 >= 600) { pick = i; vv = v; break; }
  }
  ok(pick > 0 && vv, `l1 早高峰找得到"下 ≥140 人且候乘 ≥600"的断面（站 ${pick > 0 ? L1.stations[pick] : '无'}）—— OD 模型没给下车需求，可视化无从谈起`);
  if (vv) {
    const real = c => build(c, Object.assign({ dwell: c }, vv));
    const nCap = Math.min(110, Math.round(vv.need / 3.4));
    const w4 = walkers(real(4)).length, w12 = walkers(real(1.2)).length;
    ok(w12 >= 1 && w4 > w12 && w4 <= nCap,
      `真实断面（下 ${vv.need} 人 / rate ${vv.rate.toFixed(0)}/s）：开门 1.2 s ${w12} 人 → 4 s ${w4} 人，不超过样本上限 ${nCap} —— 视觉层的数来自模型，不是编的`);
  }
  /* E2 运行时接线：重建签名必须吃**下车人流的时钟**（剥注释再查）。
     第 112 条把下车人流从"门开着没有"里拿出来做成了 `session.egress` 过程 ——
     门关之后人还在走，所以签名里必须有它的时钟，否则关门那一刻之后
     waitingAt 不再变，一次重建都不发生，人流就"冻"在门线上。 */
  const gsrc = require('fs').readFileSync('./src/game.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(/Math\.floor\(e\.t \/ 0\.5\)/.test(gsrc), 'syncCrowd 的重建签名吃下车人流时钟的 0.5 s 桶 —— 不然关门之后 waitingAt 不变、一次重建都不发生');
  ok(/egSig === cs\.egSig/.test(gsrc) && /s\.egress/.test(gsrc), 'syncCrowd 用 session.egress 的下车过程参与重建签名 —— 视觉层不许自己编模型量');
  ok(/const al = e \? \{[^}]*dwell: e\.t/.test(gsrc), 'crowdStation 拿到的 alight.dwell 是 egress 自己的时钟（关门后继续走），不是 s.dwell');
  ok(/static person\(/.test(wsrc), 'world.js 有 person() 单点实现 —— 候乘人群与下车步行者共用同一份"人怎么画"');

  /* G 开门侧单点（B 第 2 层，§7.1 ④）：开门侧的唯一出处是 SH.boardSideAt ——
     岛式站开门侧与侧式相反。doorSide 还有直读 stationSide 的就是漏网 consumer。 */
  ok(!/doorSide = this\.line \? this\.line\.stationSide/.test(gsrc), 'doorSide 还有直读 stationSide 的调用点 —— 开门侧必须全部走 boardSideAt（岛式站开另一侧）');
  ok(/boardSideAt/.test(gsrc) && /boardSideAt/.test(wsrc), 'boardSideAt 单点不存在或没有被 game.js/world.js 消费 —— §7.1 ④ 没接线');

  /* F 出入口单点（第 112 条）：楼梯口偏移只有一个住处 `SH.PLATFORM_EXITS`，
     下车人流的终点必须跟着它搬家 —— **常数探针**（运行时改常数，消费者必须
     一起动）。基线上"抄一份字面量"的旁路与真值恒等，静态比对看不见它。 */
  ok(/const dz = s \+ SH\.PLATFORM_EXITS\[i\];/.test(wsrc) && /const stairDz = s \+ SH\.PLATFORM_EXITS\[i\];/.test(wsrc),
    'world.js 的楼梯几何与站厅闸机线都从 SH.PLATFORM_EXITS 取里程 —— 不许再抄一份字面量');
  {
    const keep = SH.PLATFORM_EXITS;
    const probe = [-46, 58];                       // 整体挪动，仍然落在站台内
    let moved = 0, total = 0;
    try {
      SH.PLATFORM_EXITS = probe;
      for (const x of walkers(build(340, mkA(20, 340, 24, 12, 340)))) {
        total++;
        if (probe.some(o => Math.abs(x.ex - (SS + o)) < 1e-6)) moved++;
      }
    } finally { SH.PLATFORM_EXITS = keep; }
    ok(total > 0 && moved === total,
      `常数探针：把 SH.PLATFORM_EXITS 挪到 [${probe.join(', ')}] 后，${moved}/${total} 个步行者的终点跟着搬 —— 消费者没跟着搬家，单点化就是假的`);
  }
}

/* ================= 步态（乘客不是滑行的人偶） =================
 * 两件事分开量，缺一都可能是假的：
 *   记录侧：走路的人带 `gait`（相位），且它随"已经走了多远"单调增；
 *   几何侧：`person()` 真的用它 —— 两条腿一前一后、手臂与同侧腿反相，
 *           而头/躯干不跟着乱晃；不传 gait 时顶点必须与旧版逐字节一致
 *           （烘焙人群的前缀稳定性就靠这条）。 */
{
  const al = new SH.Alignment();
  al.line(2400); al.stationS = [600, 1300, 1900];
  const cline = { al, stations: ['甲', '乙', '丙'], stationSide: () => 1, isElevated: () => false };
  const buildC = (c, alight) => { const b = new SH.Builder(); const inf = [];
    SH.WorldBuilder.crowdStation(b, cline, null, 1, c, inf, alight); return inf; };
  const mk = (dwell, need, rate, dwellNeed, wait0) => ({ dwell, need, rate, dwellNeed, wait0 });

  const w8 = buildC(340, mk(8, 340, 24, 12, 340)).filter(x => x.alight);
  const w16 = buildC(340, mk(16, 340, 24, 12, 340)).filter(x => x.alight);
  ok(w8.length > 3 && w16.length > 3, `下车步行者 ${w8.length}/${w16.length} 人（dwell 8 s / 16 s）`);
  const nogait8 = w8.filter(x => !(x.gait > 0)).length;
  ok(nogait8 === 0, `${w8.length - nogait8}/${w8.length} 个步行者带步态相位（无相位的都是滑行的人偶）`);
  /* 同一个人（按出发的门位配对）走得更远时相位更大 */
  let pairs = 0, later = 0;
  for (const a of w8) {
    const bs = w16.filter(x => Math.abs(x.from - a.from) < 0.01);
    if (!bs.length) continue;
    pairs++;
    const b = bs[0];
    if (b.p > a.p && b.gait > a.gait) later++;
  }
  ok(pairs > 2 && later === pairs, `同一步行者 dwell 8→16 s：${later}/${pairs} 例位移更远、相位也更大`);
  /* 上车带：在挪的人有相位，站着等的人没有 */
  const infB = buildC(340, mk(6, 340, 24, 12, 340));
  const band = infB.filter(x => x.band != null && x.queuing);
  ok(band.length > 0 && band.every(x => x.gait > 0), `上车带 ${band.length} 人全部带相位（站着不动的不许有）`);
  const still = infB.filter(x => x.queuing && x.band == null);
  ok(still.length > 3 && still.every(x => x.gait == null), `候乘队列 ${still.length} 人原地站立、无相位`);

  /* 几何侧：把一个人分别按 gait=0 与 gait=0.25 烘出来，比较顶点。
     顶点必须换算成**以这个人自己为原点**的坐标 —— 原来减的是线路中线点，
     于是"右侧"筛出来是空的，dLeg/dArm 量到 0.000 还以为产品没摆。 */
  const fr = al.frame(1300);
  const base = { h: 1.70, th: 0.42, hue: '#2b3a4a', face: '#c8a486', hair: '#191d21', yawJ: 0 };
  const org = al.world(fr, 4.0, 0.42);   // 原点取脚底：v[1] 就是离地多高
  const bake = g => {
    const b = new SH.Builder();
    SH.WorldBuilder.person(b, al, fr, 4.0, 1, Object.assign({}, base, g == null ? {} : { gait: g }));
    const out = [];
    for (const m of b.finish()) for (let i = 0; i + 2 < m.pos.length; i += 3)
      out.push([m.pos[i] - org[0], m.pos[i + 1] - org[1], m.pos[i + 2] - org[2]]);
    return out;
  };
  const V0 = bake(0), V25 = bake(0.25), VN = bake(null);
  const band2 = (vs, lo, hi) => vs.filter(v => v[1] > lo && v[1] <= hi);
  const cx = a => a.length ? a.reduce((t, v) => t + v[2], 0) / a.length : 0;
  const fwd = vs => vs.length ? Math.max(...vs.map(v => v[2])) - Math.min(...vs.map(v => v[2])) : 0;
  /* 站着的人（不传 gait）必须两腿**左右对称**、没有前后迈步 —— 这才是"烘焙人群
     不变"的真正含义；gait=0 是相位的极端（双腿并拢、身体在最高点），与"不传
     gait"本就不是一回事，所以这里不对它的绝对跨度设阈值（跨度会随鞋/腿盒的
     进深变，写死 0.30 只是在猜尺寸），迈步量由下面那条相对断言负责。 */
  const legN = band2(VN, 0.02, 0.62);
  const asym = Math.abs(Math.max(...legN.map(v => v[2])) + Math.min(...legN.map(v => v[2])));
  const rightN = legN.filter(v => v[0] > 0.05), leftN = legN.filter(v => v[0] < -0.05);
  const sideSame = Math.abs(cx(rightN) - cx(leftN)) < 0.02;
  ok(asym < 0.02 && sideSame && rightN.length > 3,
    `不传 gait 的站姿：前后不对称 ${asym.toFixed(3)} m、左右腿前后差 ${(cx(rightN) - cx(leftN)).toFixed(3)} m（站着的人两腿必须对称）`);
  const leg0 = band2(V0, 0.02, 0.62), leg25 = band2(V25, 0.02, 0.62);
  ok(fwd(leg25) > fwd(leg0) + 0.18,
    `腿部前后跨度 gait=0 时 ${fwd(leg0).toFixed(2)} m → gait=0.25 时 ${fwd(leg25).toFixed(2)} m（应多出 ≥0.18 m 的迈步量）`);
  const head0 = band2(V0, 1.45, 1.75), head25 = band2(V25, 1.45, 1.75);
  ok(Math.abs(cx(head25) - cx(head0)) < 0.05,
    `头部前后位移 ${Math.abs(cx(head25) - cx(head0)).toFixed(3)} m —— 迈步不该把头甩出去`);
  /* 对侧步：右腿向前时右臂必须向后 */
  const right = vs => vs.filter(v => v[0] > 0.05);
  const arm0 = right(band2(V0, 0.80, 1.20)), arm25 = right(band2(V25, 0.80, 1.20));
  const dLeg = cx(right(leg25)) - cx(right(leg0)), dArm = cx(arm25) - cx(arm0);
  ok(arm0.length > 3 && dLeg * dArm < 0 && Math.abs(dLeg) > 0.03,
    `右腿前后移 ${dLeg.toFixed(3)} m、右臂 ${dArm.toFixed(3)} m（样本 ${arm0.length}）—— 必须反向（对侧步）`);
}



/* ================= 站厅层人群（第二层不再空无一人） =================
 * 守三件事：① 守恒 —— 站台 + 站厅 = 视觉总量（不许凭空多出一批人）；
 * ② 站厅的人真的**站在板上**（顶点落在站厅标高的带里，不悬在洞口、不穿进闸机柜）；
 * ③ 分层不许破坏"保留前 k 个是同一批人"。 */
{
  const al = new SH.Alignment();
  al.line(2400); al.stationS = [600, 1300, 1900];
  const SX = SH.STATION_X, hall = SH.WorldBuilder.hallBand(1300, false);
  ok(hall && hall.y === SX.mezzTop, `地下站的站厅带在板上（y=${hall && hall.y}），横向 ${hall && hall.lat0.toFixed(2)}~${hall && hall.lat1.toFixed(2)}`);
  ok(SH.WorldBuilder.hallBand(1300, true) === null, '高架站没有第二层 → 站厅带为 null（不许把高架的人也"抬"到 2.95 m）');
  const bake = (cnt, useHall) => {
    const b = new SH.Builder(); const inf = [];
    SH.WorldBuilder.crowdInto(b, al, 1, SX.front, 1150, 1342, 7, cnt, 9.5, inf, null, null, useHall ? hall : null);
    let deck = 0;
    for (const m of b.finish()) for (let i = 0; i + 2 < m.pos.length; i += 3) {
      const y = m.pos[i + 1] - 0.42;
      if (y > SX.mezzTop - 0.05 && y < SX.mezzTop + 1.95) deck++;
    }
    return { inf, deck };
  };
  const want = Math.min(240, Math.round(900 / 3.4));   // 240 是 crowdInto 的视觉上限
  const A = bake(900, true), B = bake(900, false);
  const onHall = A.inf.filter(x => x.hall);
  ok(A.inf.length === want && B.inf.length === want,
    `视觉总量守恒：分层后 ${A.inf.length} 人、不分层 ${B.inf.length} 人，都等于 round(900/3.4)=${want} —— 分层不是又造一批人`);
  const share = onHall.length / A.inf.length;
  ok(onHall.length > 10 && Math.abs(share - SH.PAX_SPLIT.hall) < 0.10,
    `站厅占 ${onHall.length}/${A.inf.length} = ${(share * 100).toFixed(0)}%（档案 ${(SH.PAX_SPLIT.hall * 100).toFixed(0)}% ±10）`);
  ok(A.deck > 400 && B.deck < 40,
    `站厅板上有几何：分层时带内顶点 ${A.deck}、不分层时 ${B.deck}（人形真的落在 ${SX.mezzTop} m 的板上）`);
  /* 可行带本身必须先被独立量一遍：拿 hallBand 的上下限去验 hallBand 自己
     是自我确认。箱涵壁（boxW − 0.35）才是外部参照。 */
  ok(hall.lat1 <= SH.STATION_X.boxW - 0.35 - 0.3 && hall.lat0 > SH.STATION_X.mezzIn,
    `站厅可行带 ${hall.lat0.toFixed(2)}~${hall.lat1.toFixed(2)} 越过箱涵壁（壁在 ${(SH.STATION_X.boxW - 0.35).toFixed(2)}）的次数为 0`);
  const bad = onHall.filter(r => r.off < hall.lat0 - 0.01 || r.off > hall.lat1 + 0.01);
  ok(bad.length === 0, `站厅人群越出可行带的 ${bad.length} 人（带 ${hall.lat0.toFixed(2)}~${hall.lat1.toFixed(2)}）`);
  /* 带（正在登车）只能落在站台的人身上 —— 这一条必须**带着下车过程**烘，
     否则根本没有带可言（第一版在这里传了 null，于是断言永远空转、
     负控 bandhall 报红报的不是它）。 */
  const bH = new SH.Builder(); const infH = [];
  SH.WorldBuilder.crowdInto(bH, al, 1, SX.front, 1150, 1342, 7, 900, 9.5, infH,
    { dwell: 1, need: 0, rate: 24, dwellNeed: 10, wait0: 900 }, null, hall);
  const hallBoard = infH.filter(x => x.hall && x.band != null);
  ok(infH.filter(x => x.band != null).length > 3 && hallBoard.length === 0,
    `站厅里 ${hallBoard.length} 人被标成"正在上车"（带共 ${infH.filter(x => x.band != null).length} 人）—— 没有人能从站厅登车`);
  const inVoid = onHall.filter(r => hall.voids.some(v => Math.abs(r.s - v) < hall.vh - 0.01));
  ok(inVoid.length === 0, `站厅人群站在楼扶梯洞口上的 ${inVoid.length} 人（洞口半宽 ${hall.vh} m）—— 那就是人悬在洞里`);
  const C = bake(300, true);
  const keyOf = x => x.map(r => `${r.hall ? 'H' : 'P'}${r.s.toFixed(2)}/${r.off.toFixed(2)}`);
  const ck = keyOf(C.inf), ak = keyOf(A.inf);
  let same = 0;
  for (let i = 0; i < Math.min(ck.length, ak.length); i++) if (ck[i] === ak[i]) same++;
  ok(ck.length > 0 && same === ck.length,
    `分层后前缀仍然稳定：300 人的 ${same}/${ck.length} 个与 900 人时的同一序号逐字一致（层级与站位都没重排）`);
}

/* ================= 街面行人（人行道 + 公交站） ================= */
{
  const al = new SH.Alignment();
  al.line(2400); al.stationS = [600, 1300, 1900];
  const SX = SH.STATION_X, hall = SH.WorldBuilder.hallBand(1300, false);
  const st = SH.WorldBuilder.streetBand(al);
  ok(st.lat0 > SH.STREET_WALK.tree && st.lat1 < SH.STREET_WALK.lotLine && st.lat0 > SH.ROAD.curb,
    `人行道带 ${st.lat0.toFixed(2)}~${st.lat1.toFixed(2)} 落在树线(${SH.STREET_WALK.tree})与楼线(${SH.STREET_WALK.lotLine})之间、路缘(${SH.ROAD.curb})以外 —— 不伸进车行道、不穿进沿街楼`);
  const bake2 = (cnt, useStreet) => {
    const b = new SH.Builder(); const inf = [];
    SH.WorldBuilder.crowdInto(b, al, 1, SX.front, 1150, 1342, 7, cnt, 9.5, inf, null, null, hall, useStreet ? st : null);
    let walk = 0;
    const dy = al.streetDy(1300);
    for (const m of b.finish()) for (let i = 0; i + 2 < m.pos.length; i += 3) {
      const y = m.pos[i + 1];
      if (y > dy - 0.15 && y < dy + 1.95) walk++;
    }
    return { inf, walk };
  };
  const W = bake2(900, true), N = bake2(900, false);
  const onSt = W.inf.filter(x => x.street), onPlat = W.inf.filter(x => !x.hall && !x.street);
  ok(W.inf.length === N.inf.length && W.inf.length === Math.min(240, Math.round(900 / 3.4)),
    `三层守恒：加街面 ${W.inf.length} 人 / 不加 ${N.inf.length} 人 = round(900/3.4)（分层不是又造一批人）`);
  const shareS = onSt.length / W.inf.length;
  ok(onSt.length > 10 && Math.abs(shareS - SH.PAX_SPLIT.street) < 0.10,
    `街面占 ${onSt.length}/${W.inf.length} = ${(shareS * 100).toFixed(0)}%（档案 ${(SH.PAX_SPLIT.street * 100).toFixed(0)}% ±10），站台剩 ${onPlat.length}`);
  ok(W.walk > 400 && N.walk < 60,
    `街面有几何：加街面时街面标高带内顶点 ${W.walk}、不加时 ${N.walk}`);
  const outBand = onSt.filter(r => r.off < st.lat0 - 0.01 || r.off > st.lat1 + 0.01);
  ok(outBand.length === 0, `街面行人越出人行道的 ${outBand.length} 人`);
  /* 等车的人必须真的在候车亭背后、同一侧 */
  const per = SH.ROAD.bus.pitch, ph = SH.ROAD.bus.phase;
  const waiters = onSt.filter(r => r.bus);
  const offShelter = waiters.filter(r => {
    const nb = ph + Math.round((r.s - ph) / per) * per;
    return Math.abs(r.s - nb) > 6 || r.off < SH.ROAD.bus.shelterLat;
  });
  ok(waiters.length >= 3 && offShelter.length === 0,
    `公交站等车 ${waiters.length} 人，离候车亭超过 6 m 或没在亭子后面的 ${offShelter.length} 人`);
  const waitGait = waiters.filter(r => r.gait != null);
  const stroll = onSt.filter(r => !r.bus);
  ok(waitGait.length === 0 && stroll.every(r => r.gait > 0),
    `等车的站着（带相位 ${waitGait.length} 人）、过路的在走（${stroll.length} 人全部有相位）`);
}

/* ================= 对向站台（诚实清单 §7.2） =================
 * 以前对面站台上一个人都没有、对向车的下车人流还错画在本侧站台上。
 * 这一节量三件事：
 *   ① 对向候乘桶 —— `Flow.waitingAt(name, i, -1)` 与正向桶同一条 demand()
 *     公式（时段系数一起涨）、不同盐值（同站两边人数由哈希错开）、各自确定；
 *   ② crowdStationFar 的下车步行者**全部落在对向站台**（side 转正后 lat < 0）、
 *     不落进本侧人群带；对向站台没有 modeled 梯段，末段 dy 恒 0（不假装
 *     那边有楼梯 —— 人沿站台走向端头离场）；
 *   ③ 接线 —— makeOnEgress 给对向过程打 opp 标记、syncCrowd 分流到
 *     crowdStationFar、farPlatform 烘对向候乘（顶点级对账在 test-bake）。 */
console.log('== 对向站台 ==');
{
  const B = SH.Builder || global.Builder;
  const al = new SH.Alignment();
  al.line(1500).arc(400, 600, 1).line(1500);
  al.stationS = [600, 1300, 1900];
  const SS = 1300;
  const line = { al, stations: ['甲', '乙', '丙'], stationSide: () => 1, isElevated: () => false };
  const L1 = SH.LINES.l1;
  const stockOf = L => { const s = SH.STOCK && SH.STOCK[L.stock]; return s ? { cars: s.cars, doors: s.doors, width: s.width, type: L.stock } : { cars: 8, doors: 5, width: 3.0, type: L.stock }; };
  /* ① 对向桶：确定性 + 与正向错开 + 时段同源 */
  const f8 = new SH.pax.Flow({ id: L1.id, stations: L1.stations }, stockOf(L1), 8);
  const f22 = new SH.pax.Flow({ id: L1.id, stations: L1.stations }, stockOf(L1), 22);
  const nm = L1.stations[5];
  const fwd8 = f8.waitingAt(nm, 5), fwd8b = f8.waitingAt(nm, 5);
  const opp8 = f8.waitingAt(nm, 5, -1), opp8b = f8.waitingAt(nm, 5, -1);
  ok(fwd8 === fwd8b && opp8 === opp8b && fwd8 > 0 && opp8 > 0,
    `对向候乘确定（本侧 ${fwd8} / 对向 ${opp8}，两次查询一致）`);
  ok(opp8 !== fwd8, `对向桶与正向桶人数错开（${fwd8} vs ${opp8}）—— 两个数全等就是没换桶`);
  const opp22 = f22.waitingAt(nm, 5, -1), fwd22 = f22.waitingAt(nm, 5);
  ok(opp8 > opp22 * 2 && fwd8 > fwd22 * 2,
    `对向桶的时段系数与正向同源（早高峰 ${opp8}/${opp22}、本侧 ${fwd8}/${fwd22}，平峰都不到高峰一半）—— 对向站台不跟时段走就是第二份公式`);
  /* waitingSet：对向车停站把候乘扣回对向桶（traffic.js 的 pax.waiting.set 代理） */
  {
    const f = new SH.pax.Flow({ id: L1.id, stations: L1.stations }, stockOf(L1), 8);
    const o0 = f.waitingAt(nm, 5, -1);
    f.waitingSet(nm, o0 - 17, -1);
    ok(f.waitingAt(nm, 5, -1) === o0 - 17 && f.waitingAt(nm, 5) === f8.waitingAt(nm, 5),
      `waitingSet 只动对向桶（对向 ${o0}→${o0 - 17}，本侧不动）—— 对向车上客扣到本侧头上就是两桶没分家`);
  }
  /* ② 对向站台的下车人流：位置全在对向侧、dy 恒 0、走向站台端头 */
  const mkA2 = (dwell, need, rate, dwellNeed, wait0) => ({ dwell, need, rate, dwellNeed, wait0 });
  const bF = new B(), infF = [];
  SH.WorldBuilder.crowdStationFar(bF, line, null, 1, mkA2(12, 340, 24, 12, 340), infF);
  const frC = al.frame(SS), cC = frC.p;
  let farP = 0, nearP = 0;
  for (const m of bF.finish()) for (let i = 0; i + 2 < m.pos.length; i += 3) {
    const d = [m.pos[i] - cC[0], m.pos[i + 1] - cC[1], m.pos[i + 2] - cC[2]];
    if (Math.abs(d[0] * frC.f[0] + d[1] * frC.f[1] + d[2] * frC.f[2]) > 160) continue;
    const lat = d[0] * frC.r[0] + d[1] * frC.r[1] + d[2] * frC.r[2];
    const up = d[0] * frC.u[0] + d[1] * frC.u[1] + d[2] * frC.u[2];
    if (up > 0.9 && up < 2.3 && Math.abs(lat) > 2.3 && Math.abs(lat) < 6.5) {
      if (lat < 0) farP++; else nearP++;
    }
  }
  ok(farP > 200, `对向站台上有下车人群（人群带顶点 ${farP}，应 ≥200）—— 对面站台空着就是 §7.2 那笔账`);
  ok(nearP === 0, `对向步行者不落在本侧站台（本侧人群带顶点 ${nearP}，应为 0）—— 对向车在对面开门、人从本侧出来就是修掉前的缺陷`);
  const wal = infF.filter(x => x.alight);
  ok(wal.length > 5, `对向下车步行者登记 ${wal.length} 人（info 照抄交给渲染器的那一份）`);
  ok(wal.every(x => x.dy === 0), '对向站台末段 dy 恒 0 —— 没有梯段的地方不许假装有楼梯');
  const exs = [...new Set(wal.map(x => Math.round(x.ex)))].sort((a, b) => a - b);
  ok(exs.length === 2 && exs[0] === Math.round(SS - 142) && exs[1] === Math.round(SS + 34),
    `对向步行者终点 = 站台端头（${exs.join(' / ')}，应为 ${SS - 142} / ${SS + 34}）—— 不是本侧的楼梯口`);
  /* ③ 接线（源码 lint，剥注释后查） */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const gsrcF = strip(require('fs').readFileSync('./src/game.js', 'utf8'));
  const psrcF = strip(require('fs').readFileSync('./src/pax.js', 'utf8'));
  const wsrcF = strip(require('fs').readFileSync('./src/world.js', 'utf8'));
  ok(/opp: isOpp/.test(gsrcF), 'makeOnEgress 给对向下车过程打 opp 标记 —— syncCrowd 才分得清侧别');
  ok(/crowdStationFar\(/.test(gsrcF), 'syncCrowd 把对向下车过程画到对向站台（crowdStationFar）');
  ok(/'#opp'/.test(psrcF), 'pax 对向候乘用 #opp 盐值分键（同一 demand 公式，没有第二份）');
  ok(/opt\.crowdOpp != null/.test(wsrcF), 'farPlatform 烘焙对向候乘人群（opt.crowdOpp，静态批次）');
  ok(/waitingAt\(name, i, -1\)/.test(wsrcF), 'buildRuns 把对向候乘从客流模型取来传给车站 —— 视觉层不许自己编人数');
}

console.log(fails ? `
✗ ${fails} 项未通过` : `
✓ 客流模型全部断言通过`);
process.exit(fails ? 1 : 0);
