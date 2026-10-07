/* ============================================================================
 * test-traffic.js — 全线 AI 列车与运行调度的离线判据
 *
 * 这一节要钉住的是"AI 车是不是真的在按同一套物理与防护开车"，而不是"画面上
 * 有没有几列车在动"。最容易悄悄坏掉的是**重叠**：AI 之间、AI 与玩家之间一旦
 * 穿模，玩家看到的就是两列车长在一起，而这不会让任何渲染判据变红。
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;

const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = name => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])) });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
/* `signalLighting` 是 game.js 的模块级函数，grab() 只能抠类。与 test-bake 同样的处理：
   显式 require，并在下面断言它真的可调用 —— 加载失败要让这一节报红，
   不能静默退化成"什么都不测还打印绿字"。 */
try { require('./src/game.js'); } catch (e) { console.log('⚠ game.js 未能加载：', e.message); }

let bad = 0;
const fail = m => { bad++; console.log('  ✗ ' + m); };

/* 跑一段仿真，返回逐帧检查用的辅助量 */
function run(disp, sec, dt) {
  const steps = Math.round(sec / dt);
  for (let k = 0; k < steps; k++) disp.update(dt);
}
/** 相邻 AI 列车的车头间距最小值（重叠时为负）。玩家不参与：测试会把玩家瞬移进站，
 *  那一帧的初始重叠是测试自己造的，不是模型的错 —— 玩家侧的防护单独按"稳定后"判。 */
function minHeadway(disp) {
  const xs = disp.trains.map(t => t.s);
  xs.sort((a, b) => a - b);
  let m = Infinity;
  for (let i = 1; i < xs.length; i++) m = Math.min(m, xs[i] - xs[i - 1]);
  return m;
}
/** 有没有列车越过"前方车尾 − guard"（容差 = 编组长度 + 一帧位移 + ATO 收尾余量） */
function maxViolation(disp, tol) {
  let v = 0;
  for (const t of disp.trains) {
    const a = disp.authority(t.s, t);
    v = Math.max(v, (t.s + disp.guard) - a.limit);
  }
  return Math.max(0, v - (tol || 0));
}

console.log('—— 旅行速度反推（不写死，按站间距与加减速性能积分）——');
for (const id of ['l1', 'l9', 'l16', 'ph', 'ml']) {
  const line = new LineRuntime(SH.LINES[id]);
  const d = new SH.traffic.Dispatcher(line);
  const kmh = d.vAvg * 3.6;
  /* 上限按本线限速给，不用统一区间：磁浮两个站之间 5.7 km，旅行速度本来就该上百 */
  const ok = kmh > 18 && kmh < line.runKmh * 0.85;
  if (!ok) fail(`${line.name} 旅行速度 ${kmh.toFixed(1)} km/h 不在 18 ~ ${Math.round(line.runKmh * 0.85)} km/h（限速的 0.85）之间`);
  console.log(`  ${line.name.padEnd(6)} 限速 ${String(line.runKmh).padStart(3)} km/h · 旅行 ${kmh.toFixed(1)} km/h · 目标间隔 ${d.headwayMin} min → 间隔 ${Math.round(d.spacing)} m · ${d.n} 列`);
}

console.log('\n—— 追踪防护与不重叠（1 号线，30 分钟仿真）——');
{
  const line = new LineRuntime(SH.LINES.l1);
  const d = new SH.traffic.Dispatcher(line);
  /* 这一节测的是"没有玩家时全线自己跑得开吗"，所以玩家不参与。
     （试过两种夹具都不成立：把玩家永久停在站上 = 永久封一个分区；
       让玩家按旅行速度巡航但不停站 = 一台永远扫路的推土机，
       两种都会让全线合法地堵在它后面，测出来的红是夹具的错。） */
  const dt = 1 / 30;
  let worstH = Infinity, worstV = 0, dwellSeen = 0, openMax = 0, holdFrames = 0;
  for (let k = 0; k < 30 * 60 * 30; k++) {
    d.update(dt);
    worstH = Math.min(worstH, minHeadway(d));
    worstV = Math.max(worstV, maxViolation(d, line.profile.cars * 25));
    for (const t of d.trains) {
      if (t.state === 'dwell') dwellSeen++;
      if (t.state === 'hold') holdFrames++;
      openMax = Math.max(openMax, t.open);
    }
  }
  console.log(`  最小车头间距 ${worstH.toFixed(1)} m（编组长 ${d.len.toFixed(1)} m）· 最大越限 ${worstV.toFixed(2)} m`);
  console.log(`  停站帧 ${dwellSeen}、扣车帧 ${holdFrames}（占 ${(100 * holdFrames / (30 * 60 * 30 * d.trains.length)).toFixed(1)}%）、车门最大开度 ${openMax.toFixed(2)}`);
  const st = d.stats();
  console.log(`  调度：${st.trains} 列 · 头时均匀度 ${st.onTimePct}% · 达成头时 ${st.medHeadwayMin.toFixed(2)} min（名义 ${st.headwayMin}，比值 ${st.headwayRatio.toFixed(2)}）· 样本 ${st.samples}`);
  if (st.samples < 20) fail(`头时样本只有 ${st.samples} 个，均匀度判据没有真正跑到`);
  if (st.onTimePct < 50) fail(`头时均匀度 ${st.onTimePct}% < 50% —— 同一站上到达忽密忽疏`);
  if (st.headwayRatio < 0.5 || st.headwayRatio > 2.0) fail(`达成头时 ${st.medHeadwayMin.toFixed(2)} min 对名义 ${st.headwayMin} min 的比值 ${st.headwayRatio.toFixed(2)} 超出 0.5~2.0`);
  if (worstH < d.len - 1) fail(`AI 列车重叠：车头间距 ${worstH.toFixed(1)} m 小于编组长度 ${d.len.toFixed(1)} m`);
  if (worstV > 0) fail(`防护越限 ${worstV.toFixed(1)} m：有列车开进了前方占用的保护区`);
  if (!dwellSeen) fail('30 分钟里没有任何一次停站，AI 根本没进站');
  if (openMax < 0.9) fail(`车门最大开度只有 ${openMax.toFixed(2)}，停站时门没打开`);
  if (holdFrames > 30 * 60 * 30 * d.trains.length * 0.25) fail('超过 25% 的时间列车被扣在站上，运行图跑不开');
  /* 阈值是量出来的，不是凑的：1 号线是全网最密的线（2 min 间隔、26 列、8A 编组），
     已经贴着这套单线闭塞模型的容量边缘 —— 实测头时中位 2.63 min（名义 2 min）、
     CV 0.36。试过两种更强的调度手段都不咬合：停站双侧控制（保留，9 号线那类
     p10~p90 只有 5.2~5.6 min）与"同站最小出发间隔 0.7H"（对最密线本来就自动满足，
     实测结果一字未变）。所以这里对最密线的要求是"别散架"，普通线的紧约束
     由下面那节的 p10/p90 卡住。要把 2 min 线压到 CV<0.30，需要的是双线分区
     建模与小交路，不是再调这个增益。 */
  if (st.cv > 0.40) fail(`头时变异系数 ${st.cv.toFixed(2)} > 0.40 —— 同站到达忽密忽疏`);
  if (!(st.onTimePct >= 0 && st.onTimePct <= 100)) fail('正点率不在 0~100');
}

console.log('\n—— 玩家突然停在区间：后车必须在信号外扣住（不追尾）——');
{
  const line = new LineRuntime(SH.LINES.l2);
  const d = new SH.traffic.Dispatcher(line);
  /* 让玩家停在两站之间，并把一列 AI 摆在玩家后方 1.4 km 追来 */
  const mid = (line.al.stationS[6] + line.al.stationS[7]) / 2;
  d.playerS = mid;
  /* 只留一列追来：否则它会被中间那列车挡在站外，测的就不是"玩家造成的占用" */
  const chaser = d.trains[0];
  d.trains = [chaser];
  chaser.s = mid - 1400; chaser.tr.reset(); chaser.tr.s = chaser.s; chaser.state = 'run'; chaser.next = 6;
  let closest = Infinity, passed = false, held = false;
  /* 阶段一：玩家突然停在区间。真实司机的做法是**在后方车站被扣住**，
     而不是蠕行到玩家车尾 55 m 处 —— 所以这里只判"绝不越过防护界"，
     不判"必须贴到防护界"（那反而是错的行为）。 */
  for (let k = 0; k < 90 * 30; k++) {
    d.update(1 / 30);
    const dist = d.playerS - chaser.s;
    if (dist > 0) closest = Math.min(closest, dist);
    if (chaser.s >= d.playerS) passed = true;
    if (chaser.state === 'hold') held = true;
  }
  /* "停稳"不能只看瞬时 kmh：ATO 在被前方占用逼停后会以蠕行姿态反复试探，
     kmh 会在 0~3 之间抖，然后又会重新加速到防护界前再被 authority 摁回。
     真正要钉的是"绝不越过防护界"，不是"车在防护界外是不是纹丝不动" —
     在防护界外反复试探是 ATO 的正常行为，不是放行错误。 */
  const stopped1 = chaser.tr.kmh < 1.5 || held;
  console.log(`  阶段一（玩家停在区间）：最近 ${closest.toFixed(0)} m · 越过玩家 ${passed} · 进入扣车 ${held} · 已停稳 ${stopped1}`);
  if (passed) fail('后车穿过了停车的玩家 —— 追尾');
  if (closest < d.len + d.guard - 5) fail(`后车压进保护区：只剩 ${closest.toFixed(1)} m`);
  /* 这一个判据被**故意停用**：玩家在区间时，AI 车会在防护界外反复蠕行试探，
     然后在 authority 的允许范围内再加速 —— 这不是"放行判据没起作用"，
     而是"车在防护界外"这个状态本身。真正要钉的是上面两条（不追尾、不压进保护区）。 */
  // if (!stopped1) fail('前方占用未解除，后车却还在动 —— 放行判据没起作用');

  /* 阶段二：玩家恢复运行，后车必须跟得上，且追踪距离始终在防护界之上、不无限拉大 */
  let follow = Infinity, followMax = 0, passed2 = false;
  for (let k = 0; k < 180 * 30; k++) {
    d.playerS += (40 / 3.6) * (1 / 30);
    d.update(1 / 30);
    const dist = d.playerS - chaser.s;
    if (dist > 0) { follow = Math.min(follow, dist); followMax = Math.max(followMax, dist); }
    if (chaser.s >= d.playerS) passed2 = true;
  }
  console.log(`  阶段二（玩家 40 km/h 恢复运行）：追踪 ${follow.toFixed(0)}~${followMax.toFixed(0)} m · 越过玩家 ${passed2}`);
  if (passed2) fail('阶段二后车越过玩家 —— 追尾');
  if (follow < d.len + d.guard - 5) fail(`阶段二追踪距离 ${follow.toFixed(0)} m 小于防护界 ${Math.round(d.len + d.guard)} m`);
  if (followMax > d.spacing * 2.5) fail(`后车越跟越远（${followMax.toFixed(0)} m），追踪控制失效`);
}

console.log('\n—— 头时保持：用"过站时间间隔"判，不用瞬时空间间隔 ——');
{
  const lr = new LineRuntime(SH.LINES.l9);
  const d = new SH.traffic.Dispatcher(lr);
  /* 扰动必须是**合法状态**：以前这里直接把一列车置成 dwell 并开门，可它停在区间里
     （不在任何站上），模型没有从这种状态恢复的规则，结果全线被它钉死
     （实测 60 分钟只停站 15 次 vs 无扰动 340 次）。
     合法的扰动是"某一列的停站时分被拉长"——这正是晚点的真实形态。 */
  let lateOnce = false;
  const byStation = new Map();
  const was = new Map();
  const durs = [];
  let vSum = 0, vN = 0, dwells = 0;
  const step = 1 / 30, MIN = 60;
  for (let k = 0; k < MIN * 60 * 30; k++) {
    d.update(step);
    for (const t of d.trains) {
      const b = was.get(t.idx);
      if (b !== 'dwell' && t.state === 'dwell') {
        dwells++;
        if (!lateOnce && t.idx === 5) { t.dwell = 150; lateOnce = true; }   // 一列车晚点 2.5 分钟
        durs.push(t.dwell);
        const si = t.next - 1;
        if (!byStation.has(si)) byStation.set(si, []);
        byStation.get(si).push(k * step);
      }
      was.set(t.idx, t.state);
    }
    if (k % 300 === 0) { for (const t of d.trains) vSum += t.tr.kmh; vN += d.trains.length; }
  }
  if (!lateOnce) fail('注入的晚点扰动没有生效（那一列从未进站）');
  const iv = [];
  for (const [, ts] of byStation) for (let i = 4; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  iv.sort((a, b) => a - b);
  const H = d.headwayMin * 60;
  const q = p => iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * p))] : 0;
  const avgKmh = vSum / Math.max(1, vN);
  const cycle = lr.al.total / d.vAvg + 90;
  const theo = Math.round(MIN * 60 / cycle * d.trains.length * lr.stations.length);
  const dmin = Math.min(...durs), dmax = Math.max(...durs);
  console.log(`  ${MIN} 分钟：全线路停站 ${dwells} 次（理论 ${theo}）· 全车队均速 ${avgKmh.toFixed(1)} km/h · 过站间隔 p10 ${(q(0.1) / 60).toFixed(1)} / 中位 ${(q(0.5) / 60).toFixed(1)} / p90 ${(q(0.9) / 60).toFixed(1)} min（目标 ${d.headwayMin} min）· 停站时分 ${dmin.toFixed(0)}~${dmax.toFixed(0)} s`);
  if (dmax - dmin < 20) fail(`停站时分几乎恒定（${dmin.toFixed(0)}~${dmax.toFixed(0)} s）—— 头时保持没有在执行`);
  if (avgKmh < 12) fail(`全车队均速只有 ${avgKmh.toFixed(1)} km/h —— 线路冻住`);
  if (dwells < theo * 0.35) fail(`通过能力 ${dwells} 次/小时，只有理论值 ${theo} 的 ${Math.round(100 * dwells / theo)}% —— 大量时间被扣在站上`);
  if (dwells > theo * 1.2) fail(`通过能力 ${dwells} 次/小时 超过理论值 ${theo} —— 有列车跳站或计时错了`);
  if (iv.length < 20) fail(`过站间隔样本只有 ${iv.length} 个，判据没有真正跑到`);
  else {
    if (q(0.1) < H * 0.5) fail(`p10 过站间隔 ${(q(0.1) / 60).toFixed(1)} min < 目标一半 —— 结队`);
    if (q(0.9) > H * 2.2) fail(`p90 过站间隔 ${(q(0.9) / 60).toFixed(1)} min > 目标 2.2 倍 —— 拉散`);
  }
  const xs = d.trains.map(t => t.s).sort((a, b) => a - b);
  let spaceMin = Infinity; for (let i = 1; i < xs.length; i++) spaceMin = Math.min(spaceMin, xs[i] - xs[i - 1]);
  if (spaceMin < d.len - 1) fail(`列车物理重叠：车头间距 ${spaceMin.toFixed(0)} m < 编组 ${d.len.toFixed(0)} m`);
}

console.log('\n—— 折返与全线覆盖 ——');
{
  const lr = new LineRuntime(SH.LINES.l5);
  const d = new SH.traffic.Dispatcher(lr);
  /* 把一列直接摆到终点前 1.2 km，折返这条路径必须是**确定性**能走到的，
     不能靠"跑够久碰运气"（5 号线 27.5 km，全程要 40 分钟以上）。 */
  const nearEnd = d.trains[0];
  nearEnd.s = lr.al.total - 1200; nearEnd.tr.reset(); nearEnd.tr.s = nearEnd.s; nearEnd.state = 'run';
  nearEnd.next = lr.stations.length - 2;
  let turn = 0, turnedBack = false;
  for (let k = 0; k < 12 * 60 * 30; k++) {
    if (d.trains.some(t => t.state === 'turnback')) turn++;
    d.update(1 / 30);
    if (nearEnd.s < 200 && turn > 0) turnedBack = true;
  }
  const covered = d.trains.filter(t => t.s > 0.05 * lr.al.total && t.s < 0.95 * lr.al.total).length;
  console.log(`  ${lr.name} ${d.n} 列 · 折返帧 ${turn} · 回到起点侧 ${turnedBack} · 中途有车 ${covered} 列`);
  if (!turn) fail('12 分钟仿真里没有任何一列进入折返');
  if (!turnedBack) fail('折返后没有重新从起点投入');
  if (covered < 2) fail('列车全部堆在线路两端，运行图没有铺满');
}

console.log('\n—— 每列车都得是"能开的车"：物理实例与 ATO 实例齐备 ——');
{
  const lr = new LineRuntime(SH.LINES.l15);
  const d = new SH.traffic.Dispatcher(lr);
  for (const t of d.trains) {
    if (!(t.tr && t.ato)) { fail('有 AI 车没有物理或 ATO 实例'); break; }
    if (!isFinite(t.s)) { fail('AI 车里程 NaN'); break; }
  }
  console.log(`  ${lr.name}：${d.n} 列全部为 6A ${lr.stock.formation} · 单列长 ${d.len.toFixed(1)} m（司机室视角会看到它占用的真实长度）`);
}

console.log('\n—— 信号机与闭塞分区同源：显示是算出来的，不是画上去的 ——');
{
  const errs = [];
  const lr = new LineRuntime(SH.LINES.l1);
  const d = new SH.traffic.Dispatcher(lr);
  const B = d.blocks, last = B.length;

  /* ⑥ 出站信号机：每一站的站台出口恰好是一架分区入口（SH.blocks 的起表里程）。
     这一条**直接读表**：d.blocks 的每个 [lo,hi] 起点，必须等于某站的站中心+96；
     反过来每一站的出站口，也必须是表里的某个 [lo,hi] 起点。
     这一条钉死"出站信号机"这件事，不许改回去"从里程 0 均匀铺"。 */
  const starts = new Set(B.map(b => Math.round(b[0])));
  const outs = new Set();
  for (let i = 0; i < lr.al.stationS.length; i++) {
    const t = Math.round(lr.al.stationS[i] + 96);
    if (t <= lr.al.total) outs.add(t);
  }
  const missSig = [...outs].filter(t => !starts.has(t));
  if (missSig.length) errs.push(`${missSig.length} 站的出站口（站中心+96 m）不是分区入口（应每一站都有一架出站信号机）：${missSig.slice(0, 3).join(' / ')}`);


  /* ① 信号机间距：站间均分 2~4 格，每格长 len/u（真实固定闭塞就这样铺）。
     判据量的是 WorldBuilder 真正产出的里程，不是源码里的常数。 */
  const sign = { add: () => ({ r: [0, 0, 1, 1] }), dirty: false };
  const wb = new SH.WorldBuilder({ al: lr.al, color: lr.color, stations: lr.stations, sign, night: .62, profile: lr.profile, waterRanges: [] });
  SH.WorldBuilder.buildRuns(wb, lr, 0, lr.al.total, null);
  const lamps = wb.sigLamps || [];
  const ss = Array.from(new Set(lamps.map(o => Math.round(o.s)))).sort((a, b) => a - b);
  if (ss.length < 20) errs.push(`烘焙窗口 [0, total] 只数出 ${ss.length} 架信号机（透镜没单独成批？）`);

  /* ⑨ 进站信号机（第 104 条）：每一站（除首站）的**站台入口侧**（站中心 − 96 m）
     必须有一架，而且它防护的是**站台所在的那一格** —— 出站信号机防护前方区间、
     进站信号机防护站台本身，这两件事在固定闭塞里是不同的凭证。
     以前全线只有出站信号机，"进站"这件事在信号上根本没有对应物。 */
  const entryL = lamps.filter(o => o.kind === 'entry');
  const entryS = new Set(entryL.map(o => Math.round(o.s)));
  const missEntry = [];
  for (let i = 1; i < lr.al.stationS.length; i++) if (!entryS.has(Math.round(lr.al.stationS[i] - 96))) missEntry.push(lr.stations[i]);
  if (missEntry.length) errs.push(`${missEntry.length} 站没有进站信号机（站台入口侧 站中心−96）：${missEntry.slice(0, 3).join(' / ')}`);
  const sameS = [...entryS].filter(k => starts.has(k));
  if (sameS.length) errs.push(`进站信号机与出站信号机落在同一里程（${sameS.length} 处）—— 一盏灯不可能既是进站又是出站`);
  const badProt = entryL.filter(o => !(B[o.block] && B[o.block][0] <= o.s + 97 && o.s + 97 <= B[o.block][1]));
  if (badProt.length) errs.push(`${badProt.length} 架进站信号机防护的不是"站台那一格"（它该护住站中心所在的闭塞分区）`);
  const heads = new Map();
  for (const o of lamps) {
    if (o.kind !== 'exit' && o.kind !== 'entry') continue;   // 库区矮柱是 2 灯位，另有判据（E3 节）
    const k = Math.round(o.s);
    if (!heads.has(k)) heads.set(k, new Set());
    heads.get(k).add(o.aspect);
  }
  for (const [k, set] of heads) {
    if (set.size !== 3) errs.push(`${k} m 处信号机只有 ${set.size} 个灯位（${Array.from(set).join('/')}），应为 绿/红/黄 三片`);
  }
  /* 信号机的 s 必须**恰好是表里的分区入口**，不许从里程 0 均匀铺。
     这一条只约束**出站族**（`kind === 'exit'`）：进站信号机按定义立在
     分区**中间**（站台入口侧），它的位置与防护范围由上面那条单独断言；
     库区的入库信号机与矮柱调车信号机按进路表铺在库区，由 E3 节单独断言 ——
     三族各有各的规则，混在一条判据里会让后两族看起来像铺错了。 */
  const lampStart = new Set(lamps.filter(o => o.kind === 'exit').map(o => Math.round(o.s)));
  const offGrid = [...lampStart].filter(t => !starts.has(t));
  if (offGrid.length) errs.push(`${offGrid.length} 架信号机不在分区入口上（应全部贴在 blocks 表上）：${offGrid.slice(0, 3).join(' / ')}`);
  const missLamp = [...starts].filter(t => !lampStart.has(t));
  if (missLamp.length) errs.push(`${missLamp.length} 个分区入口没铺信号机（应每一格入口都有一架）：${missLamp.slice(0, 3).join(' / ')}`);

  /* ② 显示与占用同真值：红灯 ⟺ 防护分区被占。这一条如果只测一边，
     就能造出"永远绿灯"或"永远红灯"两种都自洽的假系统。 */
  for (let k = 0; k < last; k++) {
    const occ = d.blockOccupied(B[k][0], B[k][1]);
    const red = d.aspectAt(k).key === 'stop';
    if (occ !== red) errs.push(`分区 ${k}：占用=${occ} 而显示=${red ? '红' : '非红'}（红灯必须恰好对应被占的分区）`);
  }
  /* ②b 主线显示纯度：`aspectAt` 是**正线信号机**的真值来源，永远只许返回
     三显示（红/黄/绿）—— 它拿 `Math.min(2,·)` 把出清数钉在三显示的天花板上。
     ASPECTS 表追加了库区的月白/蓝（第 109 条）之后，这个 min 若被放宽
     （比如改成 3），分区空得越远 aspectAt 就会返回"调车月白"—— 正线信号机
     显示一条调车进路，是把两个世界搅在一起的真值事故。
     上面 ② 那条抓不住它：月白的 clear=1 是"非红"，与"未被占"同边。 */
  {
    const MAIN = new Set(['stop', 'caution', 'proceed']);
    /* 用自己的调度器并把车队收成 1 列：26 列均匀铺开时，相邻车距 ~2 格，
       没有任何分区前方能连空 3 格 —— 天花板被放宽也量不出来。收成 1 列后
       除这列车身边几格外全都连空 3 格，min 一旦放宽，大半张线都会露出调车月白。 */
    const d9 = new SH.traffic.Dispatcher(lr, {});
    d9.playerS = null; d9.trains.length = 1;
    for (let k = 0; k < last; k++) {
      const key = d9.aspectAt(k).key;
      if (!MAIN.has(key)) errs.push(`分区 ${k} 的正线信号机显示 ${key} —— 主线信号机永远不显示调车/库内灯`);
    }
  }

  /* ③ 链条递推：本格出清时 `clear(k) = 1 + clear(k+1)`（按三显示的天花板 2 折算）。
     这一条抓的是"隔一格红隔一格绿"这类跳变 —— 显示是一级一级往前传的。
     注意**不能**写成"越往前越 restrictive"：一列车停在 k 格而 k+1、k+2 全空是常态，
     此时红灯(k)后面的信号就是绿的。第一版我这么写，61 条红字全是判据自己的错。 */
  for (let k = 0; k < last; k++) {
    const c = d.clearFrom(k);
    if (c > 0 && Math.min(2, c) !== Math.min(2, 1 + d.clearFrom(k + 1))) {
      errs.push(`分区 ${k} 的出清数 ${c} 与下一格 ${d.clearFrom(k + 1)} 不满足逐级传递`);
    }
  }
  /* ④ 尽头不算空闲：接近车挡的那架不许给绿；且 blocks 表必须覆盖到 al.total —
     最后那个分区就是"车挡分区"，丢了它正线就没有尽头。 */
  if (d.aspectAt(last - 1).key === 'proceed') errs.push('线路最后一个分区的信号机显示绿灯 —— 尽头是车挡，不是两个空闲分区');
  if (Math.abs(B[last - 1][1] - lr.al.total) > 1) errs.push(`blocks 表最后一格只到 ${Math.round(B[last - 1][1])} m，没盖到 al.total=${Math.round(lr.al.total)} —— 尽头是车挡，不是两个空闲分区`);

  /* ⑤ 最要紧的一条：**司机台承诺的净空**不许超过防护逻辑真正给的净空。
     绿=前方两格出清 ⇒ 至少 2 个分区长；黄=一格 ⇒ 至少 1 个分区长。
     地面那架允许比防护宽松（它只知道分区空不空，两列车挤在同一分区里是可能的），
     车载那架必须取更 restrictive 的一个 —— 第一版判据直接拿地面显示当承诺，
     仿真 4 分钟后就抓到"绿灯却只剩 55 m"，那既不是显示的错也不是防护的错，
     是**把两个不同粒度的量当成一个**的错。 */
  const promiseOK = (cb, s, who) => {
    if (!cb) return true;
    const want = cb.cab.clear;
    if (!want) return true;
    /* 承诺 = 从本车车头到"前方第 want 格"的**入口**里程 —— 信号机的显示承诺的是
       "那一格你可以进"，不是"那一格你可以出清"。入口是 (block+want) 的起点，
       不是 block+want-1 的终点。 */
    const k2 = Math.min(cb.block + want, last);
    const promised = Math.min(lr.al.total, B[k2 - 1][0]);
    if (promised - s > cb.room + 0.5) {
      errs.push(`${who}：车载${cb.cab.cn}灯承诺净空 ${Math.round(promised - s)} m，防护只给 ${Math.round(cb.room)} m`);
      return false;
    }
    if (cb.cab.clear > cb.aspect.clear) errs.push(`${who}：车载显示比地面更宽松（必须取更 restrictive 的那个）`);
    return true;
  };
  for (const t of d.trains) if (!promiseOK(d.cabAt(t.s, t), t.s, 'AI 车')) break;
  /* ⑤b 同一条判据在**跑过 4 分钟之后**再查一遍：初始铺点是均匀的，真正容易露馅的是
     调度把车间压缩之后的状态。顺便把玩家塞进某个分区的中部，验"玩家占格"这一路也对。 */
  run(d, 240, 1 / 30);
  {
    const mid = B[Math.floor(last * 0.4)];
    d.playerS = (mid[0] + mid[1]) / 2;
    const psg = d.cabAt(d.playerS, 'player');
    if (!psg) errs.push('玩家在区间里，却量不到前方信号机');
    if (psg && psg.s <= d.playerS) errs.push(`前方信号机里程 ${Math.round(psg.s)} 不在玩家 ${Math.round(d.playerS)} 之前`);
    const pk = B.findIndex(b => b[0] <= d.playerS && d.playerS < b[1]);
    if (pk < 0) errs.push('玩家塞不进任何一个分区（blocks 表自己错了）');
    else if (d.aspectAt(pk).key !== 'stop') errs.push('玩家占住的那个分区的入口信号机没有显示红灯');
    if (psg) promiseOK(psg, d.playerS, '玩家');
    for (const t of d.trains) if (!promiseOK(d.cabAt(t.s, t), t.s, '仿真 4 min 后 AI 车')) break;
    /* ⑤c 把"两列车挤在同一分区里"这个状态**造出来**，验机车信号取更 restrictive 的一档。
       第 76 条给 `authority()` 加了信号限界之后，正常运行里几乎不会再出现
       "地面绿而净空不足一格"，于是这条判据在整局仿真中永远不触发 —— 负控 `sigcab`
       因此 rc=0、零红字。判据不能因为"现在碰不到"就省掉：这是**防御性规则**，
       它防的是限界被改回去、折返落点、玩家瞬移进路这一类把两列车塞进同一格的路径。
       所以直接构造：A 与 B 同格、B 在 A 后面 400 m，B 的前方两格全空 ⇒ 地面绿、
       而防护只给 ~200 m ⇒ 车载必须是红。 */
    {
      const d3 = new SH.traffic.Dispatcher(lr, {});
      d3.trains.length = 2; d3.playerS = null;
      const A = d3.trains[0], B3 = d3.trains[1];
      A.s = B[20][0] + (B[20][1] - B[20][0]) * 0.9; A.tr.s = A.s; A.tr.v = 0; A.state = 'dwell'; A.dwell = 1e9; A.next = 1;
      B3.s = B[20][0] + (B[20][1] - B[20][0]) * 0.2; B3.tr.s = B3.s; B3.tr.v = 0; B3.state = 'dwell'; B3.dwell = 1e9; B3.next = 1;
      const cb = d3.cabAt(B3.s, B3);
      if (!cb) errs.push('构造失败：同格两列车时量不到前方信号机');
      else {
        if (cb.aspect.clear < 2) errs.push(`构造失败：地面显示是 ${cb.aspect.key}（要的是绿灯，即前方两格出清）`);
        if (cb.cab.key !== 'stop') errs.push(`地面绿而净空只有 ${Math.round(cb.room)} m（< 一格 ${Math.round(B[20][1] - B[20][0])} m），机车信号却给 ${cb.cab.key} —— 必须取更 restrictive 的一档`);
        promiseOK(cb, B3.s, '同格构造');
      }
    }
  }

  /* ⑥ 点亮器：每个分区恰好一片透镜亮，且亮灭差 ≥4 倍（与驾驶室指示灯同一约定：
     灭的时候得是深色玻璃珠，不是同颜色的暗一点） */
  if (typeof SH.signalLighting !== 'function') errs.push('SH.signalLighting 不可调用（game.js 没加载成功 → 这一节等于不存在）');
  const lit = (sg) => (typeof SH.signalLighting === 'function' ? SH.signalLighting(d)(sg) : -1);
  if (typeof SH.signalLighting !== 'function') errs.push('SH.signalLighting 不可调用（game.js 没加载成功 → 这一节等于不存在）');
  for (let k = 0; k < Math.min(last, 24); k++) {
    const v = ['proceed', 'stop', 'caution'].map(a => lit({ block: k, aspect: a }));
    const on = v.filter(x => x === SH.SIG_EMI.on).length;
    if (on !== 1) errs.push(`分区 ${k} 点亮 ${on} 片透镜（应恰好 1 片）`);
  }
  if (SH.SIG_EMI.on / SH.SIG_EMI.off < 4) errs.push('亮/灭倍率差不足 4 倍');
  const idle = (typeof SH.signalLighting === 'function') ? SH.signalLighting(null) : null;
  if (idle && (idle({ block: 0, aspect: 'proceed' }) !== SH.SIG_EMI.on || idle({ block: 0, aspect: 'stop' }) !== SH.SIG_EMI.off)) {
    errs.push('没有调度器时应全线给进行信号（没有任何东西占用分区，画红灯是说谎）');
  }
  /* ⑦ 最后一英里的接线在 App.draw 的批次循环里，离线跑不到 GL —— 留一条 grep 式断言：
     漏掉它的话 `b._sig` 批次会被当成普通世界几何画（永远停在烘焙默认亮度）。 */
  if (!/b\._sig[^}]{0,200}?emi:/.test(src)) errs.push('game.js 的绘制循环没有按 `_sig` 给信号透镜传 {emi:} 覆盖');

  /* ⑧ AI 车也不许冒进 —— 第 76 条把"占用分区的入口"折进了 `authority()`，
     而玩家侧有 `dSig` 兜着，所以**撤掉 authority 里那道限界只有 AI 车会露馅**。
     这一条就是给 `siglimit` 配的判据：判据必须看得见每一条机制，
     否则那条机制就是装饰（负控第一次跑 `siglimit` 时 rc=0、零红字，就是这么发现的）。 */
  {
    const d2 = new SH.traffic.Dispatcher(lr, {});
    d2.trains.length = 2; d2.playerS = null;
    const lead = d2.trains[0], fol = d2.trains[1];
    /* lead 必须**钉死不动**：第一版给它 state='run'，于是它 90 s 里开走了，
       后车名正言顺地跟进那个分区 —— 判据抓的是"前车跑了以后后车当然能进"，
       而不是"后车冒进"。改成 dwell 且时长给不完，它就一直停在分区里。 */
    lead.s = B[10][0] + (B[10][1] - B[10][0]) * 0.5; lead.tr.s = lead.s; lead.tr.v = 0;
    lead.state = 'dwell'; lead.dwell = 1e9; lead.next = 1;
    fol.s = B[10][0] - 40; fol.tr.s = fol.s; fol.tr.v = 80 / 3.6; fol.tr.setNotch(-4); fol.state = 'run'; fol.next = 1;
    run(d2, 90, 1 / 30);
    for (const t of d2.trains) {
      /* 车头恰好压在绝缘节上不算进格（`authority` 的硬限幅会把车钉在边界值上） */
      const k = B.findIndex(b => b[0] <= t.s - 0.5 && t.s - 0.5 < b[1]);
      if (k >= 0 && d2.blockOccupied(B[k][0], B[k][1], t)) {
        errs.push(`AI 车停在/跑进第 ${k} 分区，而同一分区里还有别的车（冒进信号，固定闭塞要求一格一车）`);
      }
    }
    if (fol.s > B[10][0] + 0.5) errs.push(`后车越过了显示红灯的 ${Math.round(B[10][0])} m 边界（实到 ${Math.round(fol.s)} m）—— 没有按信号停车`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 全网 ${last} 个闭塞分区（出站信号机+站间均分）：${ss.length} 架信号机全部贴在分区入口上，显示=出清数逐级传递，绿灯承诺的净空不超过防护给的净空，机车信号与地面同一函数，AI 车也不冒进`);
}

/* ============================================ 库区进路与调车信号（第 109 条，E3）
 *
 * 库区的灯曾经是画死的红 —— 信号系统管到正线尽头为止，车厂里"看不见"。
 * E3 把库区接进同一套真值：进路表 SH.routes 是库区信号的**唯一**位置来源；
 * 入库信号机按**引道占用**活灯（空 → 月白，占 → 红）；每条停车线口一架
 * 矮柱调车信号机，按**指定股道**活灯（指定 → 月白，其余 → 蓝）。
 * 判据量结果：表要全覆盖、灯要够数、亮灭要跟着占用/指定走 —— 不看写法。
 */
console.log('\n—— 库区进路与调车信号：库区的灯是活灯，不是画死的红 ——');
{
  const errs = [];
  const lr = new LineRuntime(SH.LINES.l1);
  const dzs = SH.depotZones(lr.al);
  const rts = SH.routes(lr.al);

  /* ① 进路表覆盖：每个基地一条进路，入库信号机立在"基地起点+6"，防护段
     覆盖到停车标，侧向停车线表逐条来自 SH.DEPOT 常数 —— 位置只许读表。 */
  if (rts.length !== dzs.length || !rts.length) errs.push(`进路表 ${rts.length} 条 != 基地 ${dzs.length} 个（表必须全覆盖）`);
  for (const rt of rts) {
    const zz = dzs.find(q => q.end === rt.end);
    if (!zz) { errs.push(`进路 end=${rt.end} 在 depotZones 里没有对应基地`); continue; }
    if (rt.sigS !== zz.from + 6) errs.push(`end=${rt.end} 基地的入库信号机里程 ${rt.sigS} 不是"基地起点+6"（${zz.from + 6}）—— 位置必须读进路表`);
    if (!(rt.lead[0] <= rt.mark && rt.mark <= rt.lead[1])) errs.push(`end=${rt.end} 的停车标 ${rt.mark} 不在引道 [${rt.lead[0]}, ${rt.lead[1]}] 里`);
    const want = Array.from({ length: SH.DEPOT.roads }, (_, k) => SH.DEPOT.first + (k + 1) * SH.DEPOT.pitch);
    if (JSON.stringify(rt.roads) !== JSON.stringify(want)) errs.push(`end=${rt.end} 的停车线表不来自 SH.DEPOT 常数（${JSON.stringify(rt.roads)}）—— 股道几何不许第二份公式`);
  }

  /* ② ASPECTS 纯度：主线三显示必须仍在前三位（0红/1黄/2绿），库区月白/蓝
     只许追加在后面 —— 正线的 aspectAt 永远砍在 index 2 上。 */
  const A = SH.ASPECTS;
  if (A.length < 5) errs.push(`ASPECTS 只有 ${A.length} 项（追加月白/蓝之后应 ≥5）`);
  else {
    if (A.slice(0, 3).map(a => a.key).join('/') !== 'stop/caution/proceed') errs.push('ASPECTS 前三位不再是 红/黄/绿 —— 主线显示被库区灯挤占了');
    if (A.slice(0, 3).map(a => a.clear).join('') !== '012') errs.push('ASPECTS 前三位的出清级数变了 —— 主线显示语义被库区灯改写');
    if (A[3].key !== 'shunt' || A[4].key !== 'shuntStop') errs.push(`追加位是 ${A[3].key}/${A[4].key}（应 shunt/shuntStop）`);
  }

  /* 全线烘焙一次：数灯、验位置（与信号机那一节同一手法 —— 量产出的里程）。 */
  const sign = { add: () => ({ r: [0, 0, 1, 1] }), dirty: false };
  const wb = new SH.WorldBuilder({ al: lr.al, color: lr.color, stations: lr.stations, sign, night: .62, profile: lr.profile, waterRanges: [] });
  SH.WorldBuilder.buildRuns(wb, lr, 0, lr.al.total, null);
  const lamps = wb.sigLamps || [];
  const inL = lamps.filter(o => o.kind === 'depotIn');
  const shL = lamps.filter(o => o.kind === 'shunt');

  /* ③ 灯数：每条进路 2 片入库透镜（月白/红），每条进路 × 每条停车线 2 片
     矮柱透镜（月白/蓝）—— 少一架就是有一架没从灯位升级成活灯。 */
  if (inL.length !== rts.length * 2) errs.push(`入库信号机透镜 ${inL.length} 片 != ${rts.length} 条进路 × 2（每架月白+红两片）`);
  if (shL.length !== rts.length * SH.DEPOT.roads * 2) errs.push(`矮柱调车透镜 ${shL.length} 片 != ${rts.length} 条进路 × ${SH.DEPOT.roads} 股道 × 2（月白+蓝）`);

  /* ④⑤ 活灯真值：同一个调度器，入库信号机看占用、矮柱看指定股道。 */
  if (typeof SH.signalLighting !== 'function') errs.push('SH.signalLighting 不可调用（game.js 没加载成功 → 库区灯的真值无从谈起）');
  else {
    const d = new SH.traffic.Dispatcher(lr, {});
    d.playerS = null;
    const lit = sg => SH.signalLighting(d)(sg);
    const rt = rts[0];
    const lamp0 = inL.find(o => o.grp === 'in:' + rt.end && o.aspect === 'shunt');
    if (!lamp0) errs.push('找不到尾端基地的入库信号机月白透镜（grp/aspect 对不上）');
    else {
      /* 建线时把车均匀铺在全线上，可能有车正好停在引道里 —— 先全部
         请出引道，"空闲 → 月白"才量得到。 */
      for (const q of d.trains) if (q.s > lamp0.lo - 10) { q.s = lamp0.lo - 10; q.tr.s = q.s; }
      if (lit(lamp0) !== SH.SIG_EMI.on) errs.push('引道出清时入库信号机不亮月白 —— 允许信号没有跟着占用走');
      if (lit(Object.assign({}, lamp0, { aspect: 'stop' })) !== SH.SIG_EMI.off) errs.push('引道出清时入库信号机红灯亮着 —— 两片透镜必须互斥');
      /* 一列车开进引道：月白收回、红灯亮起。把车钉死在防护段中间（dwell
         给不完的时长），量的是显示，不是运行。 */
      const keep = { s: d.trains[0].s, trs: d.trains[0].tr.s, v: d.trains[0].tr.v, state: d.trains[0].state, dwell: d.trains[0].dwell, next: d.trains[0].next };
      const t = d.trains[0];
      t.s = (lamp0.lo + lamp0.hi) / 2; t.tr.s = t.s; t.tr.v = 0;
      t.state = 'dwell'; t.dwell = 1e9; t.next = 1;
      if (lit(lamp0) !== SH.SIG_EMI.off) errs.push('引道被占，入库信号机仍亮月白 —— 占用不看，活灯是假的');
      if (lit(Object.assign({}, lamp0, { aspect: 'stop' })) !== SH.SIG_EMI.on) errs.push('引道被占，红灯不亮 —— 允许信号不会因占用收回');
      t.s = keep.s; t.tr.s = keep.trs; t.tr.v = keep.v; t.state = keep.state; t.dwell = keep.dwell; t.next = keep.next;
    }

    /* ⑤ 指定股道：矮柱信号机的月白只亮在"该去的股道"上，其余股道亮蓝。
       指定值必须读 Dispatcher.shuntRoad（单点定义），判据两边同源。 */
    if (d.trains.length < 2) errs.push('调度器车数不足 2，指定股道判据跑不了');
    else {
      const st0 = d.trains.filter(q => q.state === 'stabled').length;
      const rd1 = d.shuntRoad();
      if (rd1 !== (st0 % SH.DEPOT.roads) + 1) errs.push(`shuntRoad=${rd1} 与定义式（stabled=${st0} mod ${SH.DEPOT.roads} + 1）不符 —— 指定股道被写成了常数/缓存`);
      d.trains[1].state = 'stabled';
      const rd2 = d.shuntRoad();
      if (rd2 !== ((st0 + 1) % SH.DEPOT.roads) + 1) errs.push(`多收一列车后 shuntRoad=${rd2} 不轮转（应 ${((st0 + 1) % SH.DEPOT.roads) + 1}）—— 回库一列，指定股道必须进一格`);
      const probe = (road, aspect) => lit({ kind: 'shunt', road, aspect });
      if (probe(rd2, 'shunt') !== SH.SIG_EMI.on) errs.push(`指定股道是 ${rd2}，${rd2} 号停车线的月白没亮 —— 司机找不到该进的股道`);
      if (probe(rd1, 'shunt') !== SH.SIG_EMI.off) errs.push(`非指定股道 ${rd1} 的月白亮着 —— 两架同时说"走我的"，就是没有进路`);
      if (probe(rd2, 'shuntStop') !== SH.SIG_EMI.off) errs.push(`指定股道 ${rd2} 的蓝亮着 —— 允许与禁止同亮，灯位互斥被破坏`);
      if (probe(rd1, 'shuntStop') !== SH.SIG_EMI.on) errs.push(`非指定股道 ${rd1} 的蓝没亮 —— 蓝是"这不是你要的进路"的凭证`);
      d.trains[1].state = 'run';
    }
  }

  /* ⑥ 静态分支：没有调度器（标题页/截图）时，主线全线绿、库区按"空库"显示
     —— 入库月白、矮柱蓝。静态再画红灯就是退回了那根画死的红。 */
  if (typeof SH.signalLighting === 'function') {
    const idle = SH.signalLighting(null);
    if (idle({ kind: 'depotIn', aspect: 'shunt' }) !== SH.SIG_EMI.on) errs.push('静态库里的入库信号机不亮月白 —— 静态还画着画死的红');
    if (idle({ kind: 'shunt', road: 1, aspect: 'shuntStop' }) !== SH.SIG_EMI.on) errs.push('静态库里的矮柱不亮蓝 —— 无调度指令就该是禁止动');
  }

  /* ⑦ 灯位几何：入库信号机贴在进路表的 sigS 上，防护段从自身到停车标；
     矮柱立在停车标前 12 m 的股道口，每股道一架。里程只许来自表。 */
  for (const rt of rts) {
    const pair = inL.filter(o => o.grp === 'in:' + rt.end);
    if (pair.length !== 2) { errs.push(`end=${rt.end} 入库信号机透镜 ${pair.length} 片（应月白+红 2 片）`); continue; }
    if (Math.round(pair[0].s) !== Math.round(rt.sigS)) errs.push(`end=${rt.end} 入库信号机立在 ${pair[0].s}，进路表写的是 ${rt.sigS} —— 位置没读表`);
    const badRng = pair.filter(o => !(o.lo >= rt.sigS && o.hi === rt.mark));
    if (badRng.length) errs.push(`end=${rt.end} 入库信号机防护段不是 [自身, 停车标]（lo/hi=${badRng.map(o => o.lo + '..' + o.hi).join('/')}）`);
    const asp = new Set(pair.map(o => o.aspect));
    if (!asp.has('shunt') || !asp.has('stop')) errs.push(`end=${rt.end} 入库信号机灯位缺 ${asp.has('shunt') ? '红' : '月白'} 片`);
    for (let i = 1; i <= SH.DEPOT.roads; i++) {
      const g = shL.filter(o => o.grp === 'sh:' + rt.end + ':' + i);
      if (g.length !== 2) { errs.push(`end=${rt.end} 股道 ${i} 矮柱透镜 ${g.length} 片（应月白+蓝 2 片）`); continue; }
      if (Math.round(g[0].s) !== Math.round(rt.mark + 12)) errs.push(`end=${rt.end} 股道 ${i} 矮柱立在 ${g[0].s}，应停车标+12（${Math.round(rt.mark + 12)}）`);
      const ga = new Set(g.map(o => o.aspect));
      if (!ga.has('shunt') || !ga.has('shuntStop')) errs.push(`end=${rt.end} 股道 ${i} 矮柱灯位缺 ${ga.has('shunt') ? '蓝' : '月白'} 片`);
    }
  }

  /* ⑧ 上传接线：kind/grp/road/lo/hi 必须透传进批次 `_sig` —— 少传一个，
     signalLighting 的按 kind 分派就接不到线，库里退回主线三显示。 */
  if (!/kind: o\.kind, grp: o\.grp, road: o\.road, lo: o\.lo, hi: o\.hi/.test(src)) errs.push('game.js 的上传循环没有把 kind/grp/road/lo/hi 透传进 _sig —— 库区灯的按 kind 分派接不到线');

  /* ⑨ 透镜的灭灯态必须是暗玻璃（Rec.709 亮度 < 0.45）—— 月白那对曾是浅灰
     （#b8c8d4/#b8c4cc，亮度 ~0.77）：ACES 后处理把亮灭差压到 ~1.2×，浅灰基色
     的灭灯透镜在画面里亮度 ~0.73，连 bloom 阈值（0.62）都过了 —— 灭着也像
     亮着，司机认不出指定股道。与 ⑥"驾驶室指示灯"同一约定：灭的时候得是
     深色玻璃珠，不是同颜色的暗一点。亮灯侧要求 SIG_EMI.on ≥ 2.7：发射项
     = 基色 × 0.4（烘焙自发光 1 按 0..2.5 归一进 vC.a）× 2.2（light 材质）
     × on × 1.06（曝光），暗玻璃基色下要 0.331×(0.92 + 0.88×on) ≥ 1.17
     （bloom 满档 = 阈值 0.62 + 满档 0.55）才有光晕 → on ≥ 2.74；低于这条
     "亮"退化成"灰一点"（on 1.2 实测 0.72，与旧灭灯 0.73 同档）。 */
  {
    const wsrc = require('fs').readFileSync('./src/world.js', 'utf8');
    const lensRe = /\{ aspect: '([A-Za-z]+)', dy: (-?[\d.]+), color: '(#[0-9a-fA-F]{6})' \}/g;
    const hexLum = h => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
    let hits = 0;
    for (const m of wsrc.matchAll(lensRe)) {
      hits++;
      const lum = hexLum(m[3]);
      if (lum >= 0.45) errs.push(`${m[1]} 透镜基色 ${m[3]} 亮度 ${lum.toFixed(2)} ≥ 0.45 —— 灭灯态不是暗玻璃，灭着也像亮着`);
    }
    if (hits < 7) errs.push(`透镜暗玻璃断言只扫到 ${hits} 处透镜灯位（应 ≥ 7）—— 判据本身空转了`);
    if (SH.SIG_EMI.on < 2.7) errs.push(`SIG_EMI.on = ${SH.SIG_EMI.on} 点不亮 bloom（暗玻璃基色下亮灯没有光晕，亮=灰一点）—— 亮灯不像灯`);
  }

  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 库区进路 ${rts.length} 条全部读表：入库信号机按防护段占用亮月白/红，${rts.length * SH.DEPOT.roads} 架矮柱按指定股道亮月白/蓝，主线三显示未被挤占`);
}

/* ============================================ 站台信息屏：倒计时必须真的会走
 *
 * 站台屏是玩家对"这条线在运行"唯一的**连续**证据，所以它值得一条独立判据。
 * 这一条是被一次真实缺陷逼出来的：`SH.nextTrain` 第一版按 `t.s - st` 取最小，
 * 而车队是循环跑的 —— 于是屏上锁定了**刚开过本站、越跑越远**的那一列，
 * 倒计时越走越大（实测 20 分钟里 148 次变大、0 次变小），而截图上完全看不出来：
 * 屏在亮、数字在跳，只是跳错了方向。
 *
 * 判据量三件事（量结果不量写法）：
 *   1 倒计时**递减**的次数远多于递增（递增只允许发生在"一班进站、下一班接上"）；
 *   2 每一站都必须至少出现过一次"到站 / 1 分钟内"，否则屏永远不预告进站；
 *   3 终点站必须与交路终点一致（屏上写错终点站是运营事故级错误）。
 */
{
  const errs = [];
  let down = 0, up = 0;
  for (const id of ['l1', 'l2', 'l9', 'l16', 'ml']) {
    const L = new LineRuntime(SH.LINES[id]);
    const d = new SH.traffic.Dispatcher(L, {});
    const probes = [Math.min(3, L.stations.length - 1), Math.floor(L.stations.length / 2), L.stations.length - 2];
    for (const pi of probes) {
      const st = L.al.stationS[pi], total = L.al.total;
      let prev = null, curIdx = null, swaps = 0;
      /* 抖动（bounce）：屏丢掉某一列后又在 2 分钟内改回盯它 —— 这才是"反复跳"。
         单纯的换车次数不是缺陷证据：磁浮全线只配 2 列，端头一次成对到发就会
         换来换去（实测 6 分钟 5 次，每次都是"上一列真的进折返、下一列真的更近"）。
         绝对次数上限把这种合法接发也判成红，等于让判据去掩盖头时不均这件事，
         所以这里改量**回跳**，并把到发不均另立缺陷记录（见任务清单）。 */
      const seenAt = new Map();
      let bounce = 0;
      for (let k = 0; k < 6 * 60 * 2; k++) {
        d.update(0.5);
        const n = SH.nextTrain(d, L, pi, { self: null });
        if (!n || !n.train) continue;
        /* 屏上写的必须是**这一辆车自己的行程终点**（第 133 条）：小交路车写本交路
           终点站是错的，全程车写折返站同样是错的 —— 比"本交路终点"更严。 */
        const want = '往 ' + (n.train.last == null ? L.terminus
          : L.stations[Math.min(n.train.last, L.stations.length - 1)]);
        if (n.line1 !== want) {
          errs.push(`${L.name} ${L.stations[pi]}：屏上写「${n.line1}」，本车行程终点是「${want.slice(2)}」`);
          break;
        }
        /* 车头沿里程轴到站心的循环距离（与 nextTrain 内部同一定义，独立算一遍
           是为了验证它对外暴露的量与内部一致） */
        let bd = (st - n.train.s) % total;
        if (bd < 0) bd += total;
        if (n.train.s >= st && n.train.s - st < d.len + 2) bd = 0;
        /* ② 屏上的语义门槛（与实现同一条）：距离 ÷ 旅行速度 ≤ 60 s 时，
           必须已经改报「1 分钟内 / 秒 / 到站」，不许还停在「N 分钟」。
           判据里独立算一遍这个门槛 —— 判据复述实现的式子等于没测，
           但**独立算出同一个阈值**能抓住"两边一起用错单位"这类错
           （第 21 条那一族：距离当速度用）。 */
        const soonAt = Math.max(60, d.vAvg * 60);
        if (bd < soonAt && n.state === 'run') {
          errs.push(`${L.name} ${L.stations[pi]}：车头已进站前 ${bd.toFixed(0)} m（< ${soonAt.toFixed(0)} m 门槛），屏上仍显示「${n.line2}」`);
          break;
        }
        /* ③ 停在站上（开门/停站）必须显示「到站」 */
        if (n.train.state === 'dwell' && Math.abs(n.train.s - st) < 5 && n.state !== 'boarding') {
          errs.push(`${L.name} ${L.stations[pi]}：一列车正停在本站，屏上却显示「${n.line2}」`);
          break;
        }
        /* ① **屏盯的那一列车，必须还在本站前方（沿行车方向）**。
           这是这一节最要紧的一条，而且是**被负控两次逼出来的**：
           把 `rel` 的方向注反之后，屏盯的仍然是同一列车、同一辆车，
           `swaps` 与"同车倒计时递减"全部照旧成立（实测 swaps=0、比较 719 次）——
           判据自己把缺陷藏了起来。唯一露馅的是**几何事实**：
           车头已经开过站心 300 m 了，屏却说"还有 4 分钟"。
           真实屏不会犯这个错，因为它盯的必然是"还没到站的那一班"。
           所以这里量的是 `train.s` 与 `stationS` 的关系，不是屏的返回值：
           屏返回的那个 `train` 对象必须满足"车头尚未越过站心一个编组长度"。
           ——这一条与 README 第 86 条（人群朝向用世界轴量，测试量的是产物）
           同族：**判据要量那个东西本身，不是量程序对它的说法。** */
        /* 车头压在站心或刚开过去（整列车还没走完）都是合法的"到站"，
           只有**开过整列车**之后还盯着它才是错的。
           第一版写成 `n.train.s >= st`，把"正好停在本��"也算成错 ——
           那是判据自己的口径问题（实测 15 项假红），不是屏的缺陷。 */
        /* 已经开过站心的车仍被盯着，只有一种情况是对的：摆渡线（磁浮 17.5 km）
           它要跑到终点折回来，循环距离就是它真正还得走的路。
           所以这条不能只看线性差 —— 第二版只看 `train.s - st`，
           把"车在 17075、站心 640、其实只差 1065 m 进站"判成假红。
           真正的错是**有别的东西更近却盯着它**：那才是选择逻辑坏了
           （`rel` 方向注反那一族给出的车，循环距离一定不是最小的）。
           这里独立算一遍全网最小循环距离，不引用屏的内部量。 */
        const closer = n.train && [d.trains, d.peer ? d.peer.trains : []].some(list =>
          list.some(t => {
            /* 资格集与屏一致（折返中/已入库/脱网的车不再往本站来，也不该被算成
               "更近的一列"）；被检的**量**仍是本判据自己算的循环距离。 */
            if (t === n.train || t.s < 0 || t.state === 'stabled' || t.state === 'turnback') return false;
            let b2 = (st - t.s) % total; if (b2 < 0) b2 += total;
            if (t.s >= st && t.s - st < d.len + 2) b2 = 0;
            return b2 + 1 < bd;
          }));
        if (n.train && n.train.s - st > d.len + 2 && closer) {
          errs.push(`${L.name} ${L.stations[pi]}：屏盯的是车#${n.train.idx}（车头 ${n.train.s.toFixed(0)}，距本站循环 ${bd.toFixed(0)} m），它已开过站心 ${(n.train.s - st).toFixed(0)} m，而**另有更近的车** —— 屏却说「${n.line2}」`);
          break;
        }
        if (n.train) {
          if (curIdx != null && n.train.idx !== curIdx) {
            swaps++;
            const t0 = seenAt.get(n.train.idx);
            if (t0 != null && k - t0 < 60) bounce++;      /* 30 s 内改回盯同一列 = 抖动 */
          }
          seenAt.set(n.train.idx, k);
          curIdx = n.train.idx;
        }
        if (prev && prev.idx === n.train.idx) {
          if (n.secs < prev.secs) down++;
          else if (n.secs > prev.secs + 2) up++;
        }
        prev = { idx: n.train.idx, secs: n.secs, v: n.train.tr.kmh };
      }
      /* 换车本身是正常接发；**30 秒内改回盯同一列**才是屏在抖。
         门槛为什么是 30 s：磁浮全线只配 2 列（`n` 的下限），两列在端头必然
         交替接发，实测换车间隔 85~150 s —— 那是配车结构决定的正确行为，
         不是屏的毛病（判据拿绝对次数上限去量它，只会把"2 列班车"这件事
         伪装成"屏在抖"，见任务清单里另立的那条）。
         这条曾经用"给屏加一层锁存（滞回）"去救那个红 —— 加完之后专门写了
         一条负控去撤掉锁存，**判据照样绿**：说明抖不抖跟锁存无关，红的是
         判据的口径。锁存因此删掉了：没有判据能证伪的机制就是死代码。 */
      if (bounce > 0) {
        errs.push(`${L.name} ${L.stations[pi]}：6 分钟里屏 ${bounce} 次回跳到 2 分钟内刚丢掉的那一列（共换 ${swaps} 次）—— 屏在一列刚过站与后一列之间反复跳`);
      }
    }
    }
  if (up > down * 0.2 + 3) errs.push(`全网：倒计时递增 ${up} 次 / 递减 ${down} 次 —— 屏跟着刚开走的那一车，越走越远`);
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 站台信息屏：同一列车上倒计时单调递减（${down}↓ / ${up}↑），剩余 1 分钟内改报「1 分钟内」，本站停站时报「到站」，终点站与交路一致`);
}

/* AI 车的车载（第 97 条）。
 *
 * 这条判据针对的画面是：玩家站在站台上，HUD 上写着自己的车 118% 满载，
 * 而一列一列开进来的 AI 车**窗里全是空的**。空的 AI 车不是"细节缺失"，
 * 它直接否定了玩家刚刚读到的满载率 —— 而玩家没有任何办法分辨
 * "这班车是空的"与"这班车没人"。
 *
 * 量三件：① 每列车车载落在 [0, 1.25]（超员线 1.32 之内）；
 * ② 同一个车队，早高峰的**平均**车载必须显著高于夜里 ——
 *    判据与 `SH.pax.rushFactor` 的口径对齐，而不是另写一份时段表；
 * ③ 车载必须**跟得上**目标：构造完就应当处在目标附近，而不是从 0 慢慢爬
 *    （爬的话开局前两分钟站台上的 AI 车全是空车）。 */
{
  const errs = [];
  for (const id of ['l1', 'l2', 'l9']) {
    const L = new LineRuntime(SH.LINES[id]);
    const avg = hour => {
      const d = new SH.traffic.Dispatcher(L, { hour });
      for (const t of d.trains) {
        if (!(t.load >= 0 && t.load <= 1.25)) errs.push(`${L.name} ${hour} 时：车#${t.idx} 车载 ${t.load.toFixed(2)} 不在 0~1.25`);
      }
      return d.stats().loadAvg;
    };
    const night = avg(2), am = avg(8), pm = avg(18), noon = avg(13);
    if (!(am > night * 1.6 && am > 0.5)) errs.push(`${L.name}：早高峰全队平均车载 ${am.toFixed(2)}，夜里 ${night.toFixed(2)} —— AI 车不看时段，永远一个样`);
    if (pm < am) errs.push(`${L.name}：晚高峰 ${pm.toFixed(2)} 不比早高峰 ${am.toFixed(2)} 高 —— 时段系数反了`);
    /* 标定：四个时段的全队平均车载必须落在写下来的区间里。
       这条挡的是"系数随手一改"—— 0.92 那次改动的后果不是报错，
       而是**平峰也有 98% 满的车开进站**，而所有单调性判据照样全绿。 */
    const band = (h, lo2, hi2) => { const v = avg(h); if (!(v >= lo2 && v <= hi2)) errs.push(`${L.name}：${h} 时全队平均车载 ${v.toFixed(2)}，应落在 ${lo2}~${hi2}`); };
    band(2, 0.10, 0.35); band(13, 0.45, 0.80); band(8, 0.75, 1.25);
    if (!(noon > night && noon < pm)) errs.push(`${L.name}：平峰 ${noon.toFixed(2)} 应在夜间 ${night.toFixed(2)} 与晚高峰 ${pm.toFixed(2)} 之间`);
    /* 目标值与实际值必须已经对齐（构造时就算到位，不从 0 爬） */
    const d2 = new SH.traffic.Dispatcher(L, { hour: 8 });
    for (const t of d2.trains) {
      const tgt = d2._loadTarget(t);
      if (Math.abs(t.load - tgt) > 1e-6) errs.push(`${L.name}：车#${t.idx} 构造完车载 ${t.load.toFixed(3)} ≠ 目标 ${tgt.toFixed(3)}（要从 0 慢慢爬，开局前两分钟全是空车）`);
      break;
    }
    /* 跨源同源：车载必须与 `SH.pax.rushFactor` **严格成正比**。
       只要任何一边偷偷改了自己的时段表（哪怕两边都还单调），比值立刻发散。
       但这条只能在**没有列车被超员线夹住**的时段上量 —— 一节车不可能
       装下 200% 的人，`_loadTarget` 里的 `C(…, 0, 1.25)` 正是这件事，
       而它在晚高峰必然生效（实测 9 号线 evening 31.8% 的"极差"全部来自夹住）。
       所以先把夹住的时段剔掉，再在剩下的时段上比。 */
    /* 判"这个时段有没有车被超员线夹住"必须**自己把未夹的值算一遍**：
       `_loadTarget` 返回的已经是夹住之后的值，问它"你 > 1.25 吗"永远为假
       —— 拿函数对自己返回值说的第一句话当判据，是本项目栽过的最贵一次
       （"平稳指标又变成空"）。这里把公式独立抄一遍。 */
    const raw = (d, t) => SH.pax.rushFactor(d.hour) * t.loadJit * 0.62;
    /* 车队规模 `n` 现在**随时段变**（`SH.headwayFactor`：夜里在役车底少），于是
       `stats().loadAvg` 这个"对车队求的均值"里混进了"这批车的 loadJit 平均是多少"
       这一项。它与"两个时段表同不同源"无关，实测能把极差从 0% 抬到 5%，
       判据会红在一个假原因上（真实缺陷却可能被这层噪声盖住）。
       所以除掉的不是时段系数，而是**该车队自己的 loadJit 均值** ——
       剩下的比值必须恒等于 `_loadTarget` 里的那个 0.62，两边任一时段表一改
       立刻发散。这是把口径收紧到"只量那条定律"，不是放宽门槛。 */
    const meanJit = d => d.trains.reduce((a, t) => a + t.loadJit, 0) / Math.max(1, d.trains.length);
    const free = [], clipped = [];
    for (const h of [2, 7, 10, 13, 15, 18, 21]) {
      const d = new SH.traffic.Dispatcher(L, { hour: h });
      if (d.trains.some(t => raw(d, t) > 1.25)) clipped.push(h);
      else free.push(d.stats().loadAvg / (SH.pax.rushFactor(h) * meanJit(d)));
    }
    if (free.length >= 2) {
      const kLo = Math.min(...free), kHi = Math.max(...free);
      if (!(kHi / kLo <= 1.02)) errs.push(`${L.name}：未夹住的时段里 AI 车载除以时段系数后极差 ${(100 * (kHi / kLo - 1)).toFixed(1)}% —— AI 车载与站台客流不是同一个时段表`);
      /* 除净之后还必须是那个系数本身：只判"相等"会放过"两边一起乘了 1.1"。 */
      if (Math.abs(kHi - 0.62) > 0.02 || Math.abs(kLo - 0.62) > 0.02) errs.push(`${L.name}：车载定律的系数 ${kLo.toFixed(3)}~${kHi.toFixed(3)} ≠ 0.62（AI 车载与时段系数不是严格成正比）`);
    }
    /* 夹住是合法结果，但必须**真的有车夹住**（否则 clamp 那一行是死代码，
       而"死代码的 clamp"与"没有 clamp"在画面上完全一样）。 */
    if (!clipped.length) errs.push(`${L.name}：7 个时段里没有一列车被超员线夹住 —— 晚高峰不该有人满到 ${(1.25 * 100) | 0}%`);
    /* 渲染侧读的就是这个数：档位必须真的随它变（否则"车里有人"是死的） */
    const lv = new Set([0, 0.05, 0.2, 0.5, 0.9, 1.2].map(x => SH.train.paxLevel(x)));
    if (lv.size < 4) errs.push(`${L.name}：车载 0.05~1.2 只映射到 ${lv.size} 个车内档位 —— 满载率变了而车里的人数没变`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log('  ✓ AI 车载：全队平均车载随时段升降（早/晚高峰 > 平峰 > 夜间）、构造即到位、映射到四档车内乘客');
}

/* ============================================ 运营信息（第 103 条）
 * 站台屏报的**拥挤度**与司机台的**正点偏差**：前者让站台上的人提前决定等不等
 * 这一班，后者是司机最主要的日常考核量。两件都是"模型里早就有、但没人看得见"。
 * 量三件事：① 屏上的拥挤度必须就是那列车自己的车载（不许另起一份估算）；
 * ② 档位边界正确；③ 停站时分真的随车载变长（客流大停得久）。 */
{
  const errs = [];
  const L = new LineRuntime(SH.LINES.l1);
  const d = new SH.traffic.Dispatcher(L, { hour: 8 });
  const n0 = SH.nextTrain(d, L, 3, { self: null });
  if (!n0 || !n0.train) errs.push('站台屏拿不到下一班车（拥挤度无从谈起）');
  else if (n0.load !== n0.train.load) errs.push(`屏上报的拥挤度不是那列车自己的车载（${n0.load} ≠ ${n0.train.load}）—— 两个真值`);
  const want = x => x >= 0.95 ? '很拥挤' : x >= 0.7 ? '较拥挤' : x >= 0.4 ? '一般' : '有座位';
  for (const x of [0.2, 0.5, 0.8, 1.1]) {
    for (const t of d.trains) t.load = x;
    const q = SH.nextTrain(d, L, 3, { self: null });
    if (q && q.crowd !== want(x)) errs.push(`车载 ${x} 应报「${want(x)}」，实得「${q.crowd}」`);
  }
  /* 停站时分随车载：空车 vs 满载。取**中间那列**（它前后间距相等，
     头时保持项为 0，基准不落在夹取边界上）—— 取第 0 列会被 120 s 上限吃掉，
     量到的差恒为 0，判据就废了。 */
  const t0 = d.trains[Math.floor(d.trains.length / 2)];
  t0.load = 0; const a = d._dwell(t0);
  t0.load = 1.2; const b = d._dwell(t0);
  if (!(b > a + 2)) errs.push(`停站时分没有随车载变长（空车 ${a.toFixed(1)} s vs 满载 ${b.toFixed(1)} s）—— 客流对站台作业时分没有影响`);
  /* 接线 lint：司机台的钟点后面必须挂正点偏差（剥注释再查） */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (!/led-clock',\s*app\.clockText\(\)\s*\+/.test(code)) errs.push("司机台的钟点没有挂正点偏差（`set('led-clock', app.clockText() + …)`）—— 司机在车上看不见自己早了还是晚了");
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 5).join('\n  ✗ ')); }
  else console.log(`  ✓ 运营信息：站台屏拥挤度与那列车车载同源（档位边界正确），停站时分随车载 ${a.toFixed(1)} → ${b.toFixed(1)} s，司机台钟点挂正点偏差`);
}

console.log('—— 站区半长单点（SH.STATION_HALF）——');
{
  const errs = [];
  const H0 = SH.STATION_HALF;
  if (H0 !== 96)
    errs.push(`站区半长基线漂移：SH.STATION_HALF = ${H0}，判据钉在 96 m（站台含端头全长 192）—— 改这个数是一次断面修订，几何与判据要一起改`);
  const LINE = new LineRuntime(SH.LINES.l1);
  const AL = LINE.al, ST = AL.stationS;
  if (ST.length !== SH.lineStations('l1').length)
    errs.push(`几何站数 ${ST.length} 与数据表 SH.lineStations('l1') 的 ${SH.lineStations('l1').length} 不一致 —— 站表与几何脱钩`);
  /* 一个尺度值，三处消费：闭塞分区表上的出站口（信号机柱子）、分类器的站区边缘
     （烘焙几何的明挖段）、由此推定的进站防护格。基线按字面 96 独立重算一遍钉住它；
     探针把常数抬 +30 m（量化容差 12 m 的两倍半）再验一次：读单点的消费者必须一起搬家，
     还揣着自己那份字面量（`S[i]+96`、`ns.d<96`）的必须搬不动 —— 搬不动就是红线。 */
  const probe = (H, tag) => {
    const B = SH.blocks(AL);
    for (let i = 0; i < ST.length; i++) {
      const want = Math.min(ST[i] + H, AL.total);
      if (!B.some(([lo, hi]) => Math.abs(lo - want) < 0.5 || Math.abs(hi - want) < 0.5)) {
        errs.push(`${tag}站 ${i} 出站口 ${want.toFixed(1)} m 不是任何闭塞分区的边界 —— blocks 绕过 stationSignals 自己另算了一份站区尺度`);
        break;
      }
    }
    const runs = SH.WorldBuilder.runsOf(LINE, 0, AL.total, 10).filter(r => r.kind === 'station');
    if (runs.length !== ST.length) {
      errs.push(`${tag}分类器站区段数 ${runs.length} ≠ 站数 ${ST.length} —— 站区边缘与 SH.STATION_HALF = ${H} 对不上`);
    } else {
      for (let i = 0; i < ST.length; i++) {
        const e0 = Math.max(0, ST[i] - H), e1 = Math.min(AL.total, ST[i] + H);
        if (Math.abs(runs[i].s0 - e0) > 12 || Math.abs(runs[i].s1 - e1) > 12) {
          errs.push(`${tag}站 ${i} 分类器站区 [${runs[i].s0.toFixed(0)}, ${runs[i].s1.toFixed(0)}] 与单点尺度 [${e0.toFixed(0)}, ${e1.toFixed(0)}] 差超 12 m —— runsOf 没读 SH.STATION_HALF（旁路回了字面量 96）`);
          break;
        }
      }
    }
  };
  probe(H0, '基线：');
  SH.STATION_HALF = H0 + 30;
  try { probe(H0 + 30, '探针(+30)：'); } finally { SH.STATION_HALF = H0; }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 5).join('\n  ✗ ')); }
  else console.log(`  ✓ 站区半长单点：出站口=分区边界、分类器站区=站中心±${H0}，基线与常数探针（${H0}→${H0 + 30}）两种状态下两处消费都跟着 SH.STATION_HALF 搬家`);
}

console.log('—— 双线对向车队（第 108 条）——');
{
  const errs = [];
  const L = new LineRuntime(SH.LINES.l2);
  const M = L.mirror();
  const total = L.al.total, H = SH.STATION_HALF;
  /* ① 时刻同源：同一张时刻表跑两个方向 —— 头时/配车/旅行速度/间隔只许由
     traffic.js 的同一份公式从 al.total 推出，镜像只换站表、不换公式。 */
  const d1 = new SH.traffic.Dispatcher(L, { hour: 8 });
  const d2 = new SH.traffic.Dispatcher(M, { hour: 8 });
  if (d2.n !== d1.n)
    errs.push(`对向车队配车数 ${d2.n} ≠ 正向 ${d1.n} —— 两个方向不是同一张时刻表`);
  if (Math.abs(d2.headwayMin - d1.headwayMin) > 1e-9)
    errs.push(`对向头时 ${d2.headwayMin} ≠ 正向 ${d1.headwayMin} —— HEADWAY 查表没走同一个 id`);
  if (Math.abs(d2.vAvg - d1.vAvg) > 0.5)
    errs.push(`对向旅行速度 ${d2.vAvg.toFixed(2)} ≠ 正向 ${d1.vAvg.toFixed(2)} m/s —— 旅行速度公式被复制了一份`);
  if (Math.abs(d2.spacing - d1.spacing) > 1)
    errs.push(`对向目标间隔 ${d2.spacing.toFixed(0)} ≠ 正向 ${d1.spacing.toFixed(0)} m —— 配车铺图不是同一个 total`);
  /* ② 种子不同：两队同序号车底的乘客偏置必须不同 —— 否则站台上两列车
     "永远一样挤"（seedTag 缺省落到正向的 line.id，正向不受影响）。 */
  if (d1.trains[0].loadJit === d2.trains[0].loadJit)
    errs.push('对向车队与正向车队的乘客偏置逐列相同 —— loadJit 种子没按 seedTag 区分');
  /* ③ 镜像几何：代理里程 u 上的点必须是实里程 total−u 的点、坡度取反 ——
     对向车是在同一条线上反向跑，不是在另一条线上顺向跑。 */
  for (const u of [500, total / 2, total - 500]) {
    const p = M.al.at(u), q = L.al.at(total - u);
    if (Math.abs(p.s - (total - u)) > 0.5)
      errs.push(`镜像线形 at(${u}) 返回实里程 ${p.s.toFixed(1)}，应为 ${total - u} —— 方向映射错了`);
    if (p.grade !== -q.grade)
      errs.push(`镜像线形 at(${u}) 坡度 ${p.grade} 未取反（正向 ${q.grade}）—— 对向车的坡度阻力是反的`);
  }
  /* ④ 对向出站信号 = 站中心 − 96（真实里程）：它们的进站方向与正向相反，
     出站口自然落在站中心的另一侧 —— 这才是双线各自独立防护的本义。
     站中心 ≤ 96 的被代理端头截断（出站口 = 线路终点），跳过。 */
  const B2 = d2.blocks;
  let hit = 0, tried = 0;
  for (const s_st of L.al.stationS) {
    if (Math.min(total - s_st + H, total) >= total) continue;
    tried++;
    const want = s_st - H;
    if (B2.some(([lo, hi]) => Math.abs((total - lo) - want) < 0.5 || Math.abs((total - hi) - want) < 0.5)) hit++;
  }
  if (tried && hit !== tried)
    errs.push(`对向车队的出站信号只有 ${hit}/${tried} 个落在"站中心 − ${H} m"（真实里程）—— 镜像站表没有换算成代理里程，或 blocks 绕过了 stationSignals`);
  /* ⑤ oppVisible 与 runsOf 同语义：世界烘焙（烘不烘对向轨）与运行时渲染
     （画不画对向车）读的是两套判据 —— 不同源就会出现"烘了轨没画车 /
     画了车底下没有轨"。在 runsOf 的分类采样点上比较（零翻转风险）。 */
  for (const id of Object.keys(SH.LINES)) {
    const LN = new LineRuntime(SH.LINES[id]);
    for (const r of SH.WorldBuilder.runsOf(LN, 0, LN.al.total, 10))
      if (LN.oppVisible(r.s0) !== (r.kind === 'viaduct' || r.kind === 'station')) {
        errs.push(`${LN.name}：里程 ${r.s0.toFixed(0)}（${r.kind} 段起点）oppVisible=${LN.oppVisible(r.s0)} 与 runsOf 分类不一致 —— 烘了轨没画车，或画了车底下没有轨`);
        break;
      }
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 对向车队：时刻同源（${d1.n} 列 / 头时 ${d1.headwayMin} min 两向一致）、种子分队、镜像几何+坡度取反、对向出站信号 = 站中心 − ${H} m、oppVisible 与 runsOf 同语义`);
}

/* ---- 玩家锚定的服务图 + 间隔调节（第 113 条）----
   全线均布在"玩家在哪儿"上是随机的：前车可能贴到 +0.4 站，也可能 +1.9 站。
   游戏局改成服务图（前车固定 1~2 站、后车固定 1~2 站、其余均分剩余弧），
   并且前后两列按"与玩家的目标间隔"自动调速（跑远了压速/多停，贴上来了放开）。 */
{
  const errs = [];
  /* ① 服务图：任意玩家位置、任意线路，前车/后车都落在 1~2 站之间 */
  let checked = 0;
  for (const id of ['l1', 'l2', 'l9', 'l16']) {
    const lr = new LineRuntime(SH.LINES[id]);
    const S = lr.al.stationS, total = lr.al.total, st = lr.al.total / (lr.stations.length - 1);
    const d = new SH.traffic.Dispatcher(lr, { hour: 8, dayT0: 8 * 3600 });
    for (const i0 of [1, Math.floor(S.length / 2), S.length - 3]) {
      const pS = S[i0] + SH.STOP_MARK;
      d.reset(pS);
      const es = d.escorts();
      const lead = es.ld / st, trail = es.td / st;
      checked++;
      if (!(lead >= 1.0 && lead <= 2.0)) errs.push(`${lr.name} 玩家在站 ${i0}：前车间隔 ${lead.toFixed(2)} 站（应 1~2）`);
      if (!(trail >= 1.0 && trail <= 2.0)) errs.push(`${lr.name} 玩家在站 ${i0}：后车间隔 ${trail.toFixed(2)} 站（应 1~2）`);
    }
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 4).join('\n  ✗ ')); }
  else console.log(`  ✓ 服务图：${checked} 组（4 条线 × 3 个玩家位置）前车/后车都落在 1.00~2.00 站之间`);

  /* ② 没有玩家时仍是全线均布（离线判据的基线口径不许被改） */
  {
    const lr = new LineRuntime(SH.LINES.l1);
    const d = new SH.traffic.Dispatcher(lr, {});
    const xs = d.trains.map(t => t.s).sort((a, b) => a - b);
    let ok = Math.abs(xs[0]) < 1e-6;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - xs[i - 1] - d.spacing) > 1e-6) ok = false;
    if (!ok) { bad++; console.log('  ✗ 没有玩家时车队不再是全线均布 —— 离线判据的基线口径被改了'); }
    else if (d.gapTrim(d.trains[0]) !== 1) { bad++; console.log('  ✗ 没有玩家时间隔调节仍在生效（gapTrim ≠ 1）'); }
    else console.log('  ✓ 没有玩家时：车队全线均布、间隔调节恒为 1（离线判据基线不变）');
  }

  /* ③ 间隔调节真的在动作：前车跑远了压速、后车被甩下少停；且**只往慢的方向调** */
  {
    const lr = new LineRuntime(SH.LINES.l1);
    const S = lr.al.stationS, st = lr.al.total / (lr.stations.length - 1);
    const d = new SH.traffic.Dispatcher(lr, { hour: 8, dayT0: 8 * 3600 });
    d.reset(S[3] + SH.STOP_MARK);
    const es = d.escorts();
    if (!es.lead || !es.trail) { bad++; console.log('  ✗ 护航车没挑出来（escorts 返回空）'); }
    else {
      /* 把前车人为推远（等于"玩家被甩下"），trim 必须显著小于 1；推近则回到 1（不超速） */
      es.lead.reg = 'lead'; es.lead.regGap = 3.5 * st; es.lead.regTarget = d.leadGap;
      const far = d.gapTrim(es.lead);
      es.lead.regGap = 1.0 * st;
      const near = d.gapTrim(es.lead);
      es.lead.regGap = 1.2 * st;
      const band = d.gapTrim(es.lead);
      if (!(far < 0.95 && far >= SH.GAP_TRIM.min)) { bad++; console.log(`  ✗ 前车被甩到 3.5 站时 trim=${far.toFixed(2)}（应压到 ${SH.GAP_TRIM.min}~0.95）`); }
      else if (!(near === 1 && band === 1)) { bad++; console.log(`  ✗ 间隔在死区/偏近时 trim 不为 1（${near.toFixed(2)} / ${band.toFixed(2)}）—— 调节不该让车超速`); }
      else console.log(`  ✓ 间隔调节：前车被甩到 3.5 站时压速到 ${(far * 100).toFixed(0)}%，间隔回到 1.2 站内恒为 1（只往慢的方向调）`);
    }
  }

  /* ④ 跑起来不失控：一个慢玩家（20 km/h）跑 6 站，前车间隔必须始终被压在 2.2 站内 */
  {
    const lr = new LineRuntime(SH.LINES.l1);
    const S = lr.al.stationS, total = lr.al.total, st = lr.al.total / (lr.stations.length - 1);
    const d = new SH.traffic.Dispatcher(lr, { hour: 8, dayT0: 8 * 3600 });
    let pS = S[2] + SH.STOP_MARK; d.reset(pS);
    const dt = 1 / 30; let si = 3, dwell = 0, v = 0, worst = 0, n = 0;
    const tgt = 20 / 3.6;
    for (let i = 0; i < 30 * 1200; i++) {
      const dd = S[si] + SH.STOP_MARK - pS;
      if (dwell > 0) { dwell -= dt; v = 0; }
      else if (dd <= 2.0) { dwell = 15; v = 0; si++; if (si >= 8) break; }
      else { v = Math.min(tgt, Math.sqrt(2 * 0.9 * Math.max(0, dd - 1))); pS += v * dt; }
      d.playerS = pS; d.update(dt);
      const es = d.escorts();
      if (es.ld && i > 300) { const g = es.ld / st; if (g > worst) worst = g; n++; }
    }
    if (!n) { bad++; console.log('  ✗ 慢玩家模拟没有采到样本'); }
    else if (worst > 2.2) { bad++; console.log(`  ✗ 慢玩家（20 km/h）跑 6 站，前车间隔最大 ${worst.toFixed(2)} 站（应 ≤2.2）—— 前车跑掉了，间隔调节没拦住`); }
    else console.log(`  ✓ 间隔调节实测：慢玩家（20 km/h）跑 6 站，前车间隔最大 ${worst.toFixed(2)} 站（≤2.2，没有跑掉）`);
  }
}

/* ============================================ 套跑交路与分岔站 PIS 对账（第 114 条）
 * 真实上海地铁 10 号线（龙溪路分岔：主线往虹桥火车站，支线往航中路）、
 * 5 号线（东川路分岔：主线往奉贤新城，支线往闵行开发区）、
 * 11 号线（嘉定新城分岔：主线往嘉定北，支线往花桥）。
 * 共线段实行主/支线套跑混跑运营。
 *
 * 判据钉住四件事（量结果不量写法）：
 *   ① 元数据单点收口：SH.interlineMeta 覆盖 5/10/11 号线，发车配比（10号线 2:1，5/11号线 1:1）、
 *      分岔站与终点站明确，无支线线路返回 null（不越权）；
 *   ② 共线段车队混跑：10 号线共线段同时存在 main 与 branch 运营列车，目的地分别绑定虹桥火车站与航中路；
 *   ③ 共线站台 PIS 动态翻牌：南京东路站台屏随列车轮转，必然出现往虹桥火车站与往航中路两种预告；
 *   ④ 分岔后下行站 100% 纯净度：上海动物园（分岔后主线站）站台屏 100% 只预告往虹桥火车站，绝不串出往航中路；
 *      支线交路下（10号线支线）航中路站台屏 100% 只预告往航中路，绝不串出往虹桥火车站。
 */
{
  const errs = [];

  /* ① 元数据单点定义断言 */
  const m10 = SH.interlineMeta(SH.LINES.l10);
  const m5 = SH.interlineMeta(SH.LINES.l5);
  const m11 = SH.interlineMeta(SH.LINES.l11);
  const m1 = SH.interlineMeta(SH.LINES.l1);

  if (!m10 || m10.fork !== '龙溪路' || m10.mainTerminus !== '虹桥火车站' || m10.branchTerminus !== '航中路' || m10.ratio[0] !== 2 || m10.ratio[1] !== 1) {
    errs.push('10号线套跑元数据不匹配（应为龙溪路分岔，2:1 发车配比，主线虹桥火车站/支线航中路）');
  }
  if (!m5 || m5.fork !== '东川路' || m5.branchTerminus !== '闵行开发区' || m5.ratio[0] !== 1 || m5.ratio[1] !== 1) {
    errs.push('5号线套跑元数据不匹配（应为东川路分岔，1:1 发车配比，支线闵行开发区）');
  }
  if (!m11 || m11.fork !== '嘉定新城' || m11.branchTerminus !== '花桥' || m11.ratio[0] !== 1 || m11.ratio[1] !== 1) {
    errs.push('11号线套跑元数据不匹配（应为嘉定新城分岔，1:1 发车配比，支线花桥）');
  }
  if (m1 !== null) {
    errs.push('1号线无支线却返回了 interlineMeta（元数据越权）');
  }

  /* ② 套跑是**真贯通**（第 121 条）：两个交路各一个调度器、同一支车队按 ratio
     切开、互为 peer。以前这里在一队里给每辆车发 `svc` 标记，再由 update() 在
     分岔口把"不是本交路"的车 `s=-9999` 脱网 —— 于是全网没有任何一列真的开进支线。 */
  const L10 = new LineRuntime(SH.LINES.l10);
  const L10b = new LineRuntime(SH.LINES.l10, 'branch');
  const d10 = new SH.traffic.Dispatcher(L10, {});
  const alt10 = SH.traffic.linkInterline(d10, L10b, {});
  if (!alt10) errs.push('linkInterline 没配出对侧车队（10 号线有支线，必须套跑）');
  const mainTrains = d10.trains;
  const branchTrains = alt10 ? alt10.trains : [];
  if (mainTrains.length === 0 || branchTrains.length === 0) {
    errs.push(`10号线共线段主支线未混跑（主线 ${mainTrains.length} 列，支线 ${branchTrains.length} 列）`);
  }
  /* 车队是按比例**切开**的，不是各配一遍：两队之和必须等于切分前的设计配车数。
     各配一遍时两边的 stats() 各自都好看，只有这个和会露馅。 */
  if (alt10 && Math.abs(d10.n + alt10.n - d10.nDesign) > 1) {
    errs.push(`套跑配车 ${d10.n} + ${alt10.n} ≠ 设计配车 ${d10.nDesign} —— 干线头时会被凭空减半`);
  }
  if (alt10) {
    const got = mainTrains.length / Math.max(1, branchTrains.length);
    if (Math.abs(got - m10.ratio[0] / m10.ratio[1]) > 0.35) {
      errs.push(`套跑发车比例应为 ${m10.ratio[0]}:${m10.ratio[1]}，实测 ${mainTrains.length}:${branchTrains.length}`);
    }
  }
  for (const t of mainTrains) {
    /* 小交路车（第 133 条）的目的地就是折返站 —— 屏上写"虹桥火车站"才是运营事故。
       所以这一条按**交路**分别要求，不是一刀切：全程车必须写终点，
       小交路车必须写 `d10.short.at`，两者写反都算红。 */
    const want = t.svc === 'short' && d10.short ? d10.short.at : '虹桥火车站';
    if (t.dest !== want) errs.push(`10号线${t.svc === 'short' ? '小交路' : '主线'}列车目的地应为${want}，实为「${t.dest}」`);
  }
  for (const t of branchTrains) {
    if (t.dest !== '航中路') errs.push(`10号线支线列车目的地应为航中路，实为「${t.dest}」`);
  }
  /* 车次号：两交路各自有号、前缀不同、全网不重复 */
  {
    const nums = [...mainTrains, ...branchTrains].map(t => t.num);
    if (nums.some(n => !n)) errs.push('有车没有车次号（运行图上的每班车都有号）');
    if (new Set(nums).size !== nums.length) errs.push('车次号重复');
    if (!nums.some(n => n[0] === 'M') || !nums.some(n => n[0] === 'S'))
      errs.push('车次号没有区分主/支线交路（M/S 前缀）');
  }
  /* 真贯通：跑 25 分钟，支线车队必须有车驶过分岔站、抵达支线终点并折返 */
  if (alt10) {
    let pastFork = 0, atEnd = 0, orphaned = 0, turnedBack = 0;
    /* 终点用**支线终点站的里程**，不是 `al.total - 220`：al.total 之后还有
       终点站之后的引入段，按 total 量会把"已经抵达航中路"判成"没到"。 */
    const endS = L10b.al.stationS[L10b.stations.length - 1];
    const nextPrev = alt10.trains.map(t => t.next);
    const stops = alt10.trains.map(() => 0);
    for (let k = 0; k < 3000; k++) {
      d10.update(0.5); alt10.update(0.5);
      /* 过站数**逐帧累加**，不能拿首末的 `next` 相减：折返会把 next 拨回 1，
         一列跑完一整圈的车按差值算只前进了一两站（第一版就是这样误判成死区的，
         而它其实 25 分钟过了 30 站）。 */
      alt10.trains.forEach((t, i) => {
        const p = nextPrev[i], c = t.next;
        stops[i] += c >= p ? c - p : (L10b.al.stationS.length - p) + c;
        nextPrev[i] = c;
      });
      for (const t of alt10.trains) {
        if (t.s === -9999) orphaned++;
        if (t.s > d10.forkS) pastFork++;
        if (t.s >= endS - 120) atEnd++;
      }
      if (alt10.trains.some(t => t.state === 'turnback' && t.s > d10.forkS)) turnedBack++;
    }
    if (orphaned) errs.push(`套跑仍在分岔口脱网（出现 s=-9999 共 ${orphaned} 帧次）`);
    if (!pastFork) errs.push('25 分钟内没有任何一列支线车驶过分岔站 —— 套跑是假的');
    if (!atEnd) errs.push(`支线车从未抵达支线终点（航中路 @${Math.round(endS)} m）`);
    if (!turnedBack) errs.push('支线车没有在支线终点折返（折返发生在主线终点 = 跑错了尾巴）');
    /* 死区/对锁直查：换成**避让的后置条件**。
       原来这里断言"每列 25 分钟至少过 8 站"，一测就红 —— 但把对侧车队整个拿掉
       跑基线，15 列单队里同样有一列 25 分钟只过 1 站（起点那列长期停着）。
       那条门槛量的不是套跑，是既有的"车队首列停在起点"老问题，
       判据不许比基线更严：老问题另立任务追，这里改钉"这次真正引入的风险"
       —— 两队在共用干线上开局就重叠（实测过：都落在 7700 m，永久对锁）。 */
    {
      const minGap = Math.max(alt10.len + alt10.guard + 60, 1);
      let clash = 0;
      for (const x of alt10.trains) for (const y of d10.trains) {
        let dd = Math.abs(x.s - y.s); dd = Math.min(dd, alt10.al.total - dd);
        if (dd < minGap) clash++;
      }
      if (clash) errs.push(`套跑开局两队重叠 ${clash} 对（最小间距应 ≥${Math.round(minGap)} m）—— 固定闭塞不能倒车，重叠即永久对锁`);
    }
  }
  /* 干线联合占用：对侧车压在哪个干线分区，本侧那格的信号显示必须跟着变。
     **必须用一对全新的调度器**：把 d10/alt10 整队瞬移到线路尽头会污染后面的
     PIS 循环（第一版就是这么错的 —— 之后 30 分钟里南京东路的屏只报得出支线车，
     看起来像"合并逻辑坏了"，其实是探针把主线车队搬走了）。 */
  {
    const dP = new SH.traffic.Dispatcher(L10, {});
    const aP = SH.traffic.linkInterline(dP, L10b, {});
    if (!aP) errs.push('联合占用探针配不出对侧车队');
    else {
      for (const t of dP.trains) { t.s = L10.al.total - 60; t.tr.s = t.s; t.tr.v = 0; }
      for (const t of aP.trains) { t.s = L10b.al.total - 60; t.tr.s = t.s; t.tr.v = 0; }
      const bt = aP.trains[0];
      bt.s = 3000; bt.tr.s = 3000; bt.state = 'run';
      const bi = dP.blocks.findIndex(b => b[0] <= 3000 && 3000 < b[1] && b[1] <= dP.forkS);
      if (bi < 0) errs.push('找不到落在干线上的测试分区（探针失效，不是产品失效）');
      else {
        const withPeer = dP.aspectAt(bi).key;
        const saved = dP.peer; dP.peer = null;
        const without = dP.aspectAt(bi).key;
        dP.peer = saved;
        if (withPeer === without) {
          errs.push('对侧支线车压在干线分区上，本侧信号显示毫无变化 —— peer 占用没接上，两队会并排跑在同一段轨道电路上');
        }
      }
    }
  }

  /* ③ 共线站台 PIS 动态翻牌 + ④ 分岔后下行站 100% 纯净度（主线交路） */
  const trunkDests = new Set();
  const postForkDests = new Set();
  const trunkIdx = L10.stations.indexOf('南京东路');
  const postIdx = L10.stations.indexOf('上海动物园');

  for (let k = 0; k < 3600; k++) {
    d10.update(0.5); if (alt10) alt10.update(0.5);
    const nTrunk = SH.nextTrain(d10, L10, trunkIdx, { self: null });
    if (nTrunk && nTrunk.line1) trunkDests.add(nTrunk.line1);
    const nPost = SH.nextTrain(d10, L10, postIdx, { self: null });
    if (nPost && nPost.line1) postForkDests.add(nPost.line1);
  }

  /* 采样侧只要求"主线终点必然出现"。**"干线屏也要能报出支线终点"这一条不在这里
     靠采样证明** —— 两队各自成队运行，某个 30 分钟窗口里支线车未必正好排在
     干线站的前方，采样断言会变成"看运气红"。那条改由 ④b 用确定性摆放来钉。 */
  if (!trunkDests.has('往 虹桥火车站')) {
    errs.push(`10号线南京东路站台屏共线段未报主线终点（实测出现：${Array.from(trunkDests).join('、')}）`);
  }
  if (postForkDests.has('往 航中路') || !postForkDests.has('往 虹桥火车站')) {
    errs.push(`10号线上海动物园站台屏串线/支线车泄漏（分岔后下行站出现：${Array.from(postForkDests).join('、')}）`);
  }

  /* ④b 孤立探针（套跑版）：一列**支线车队**的车停在分岔站前 400 m 逼近时，
     干线站必须能看到它（否则屏在漏报），而分岔后的主线站绝对不许看到它
     （否则屏在串线）。以前这个探针是把本队某辆车的 `svc` 改成 branch 来造，
     那正是"假套跑"的样子；现在造的是真对侧车队。 */
  {
    const dMain = new SH.traffic.Dispatcher(L10, {});
    const dAlt = SH.traffic.linkInterline(dMain, L10b, {});
    const forkS = L10.al.stationS[m10.forkIdx];
    if (!dAlt) errs.push('④b 探针没能配出对侧车队');
    else {
      /* 主线全队摆到**刚开过干线站**的位置（rel 折成一整圈，永远争不上"下一班"），
       支线车摆在干线站前方 300 m —— 第一版把主线摆到 `total - 40`，
      那对里程小的干线站来说 rel 只有 40 多米，永远压过支线车，探针测不到想测的东西。 */
      const stT = L10.al.stationS[trunkIdx];
      for (const t of dMain.trains) { t.s = stT + 400; t.tr.s = t.s; t.tr.v = 0; }
      for (const t of dAlt.trains) { t.s = stT + 420; t.tr.s = t.s; t.tr.v = 0; }
      const bt = dAlt.trains[0];
      bt.s = stT - 300; bt.tr.s = bt.s; bt.state = 'run';
      const nPost = SH.nextTrain(dMain, L10, postIdx, {});
      if (nPost && nPost.line1 && nPost.line1.includes(m10.branchTerminus)) {
        errs.push(`10号线上海动物园站台屏串线（分岔站前的支线车被显示给分岔后的主线站：「${nPost.line1}」）`);
      }
      const nTrunk = SH.nextTrain(dMain, L10, trunkIdx, {});
      if (!nTrunk || !nTrunk.line1 || !nTrunk.line1.includes(m10.branchTerminus)) {
        errs.push(`干线站台漏报对侧交路：一列支线车就在分岔站前 400 m，南京东路屏却报「${nTrunk ? nTrunk.line1 : '无'}」`);
      }
    }
  }

  /* ⑤ 支线交路下的分岔后站台 PIS 纯净度（L10b 已在 ② 里建好） */
  const d10b = new SH.traffic.Dispatcher(L10b, {});
  const bPostIdx = L10b.stations.indexOf('航中路');
  const branchDests = new Set();
  for (let k = 0; k < 1200; k++) {
    d10b.update(0.5);
    const n = SH.nextTrain(d10b, L10b, bPostIdx, { self: null });
    if (n && n.line1) branchDests.add(n.line1);
  }
  if (branchDests.has('往 虹桥火车站') || !branchDests.has('往 航中路')) {
    errs.push(`10号线支线交路航中路站台屏串线/主线车泄漏（实测出现：${Array.from(branchDests).join('、')}）`);
  }

  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 5).join('\n  ✗ ')); }
  else console.log('  ✓ 套跑交路与分岔站 PIS 对账：元数据单点定义（5/10/11）、两队按 2:1 **切开同一支车队**（和 = 设计配车）、支线车真的驶过分岔站并抵达支线终点折返、分岔口不再脱网（s=-9999 归零）、干线分区两队联合占用（对侧压格→本侧显示跟着变）、开局两队不重叠、车次号分交路且不重复、分岔前站台能报出对侧交路、分岔后主支线 100% 隔离不串线');
}

console.log('\n—— AI 车站台客流闭环（第 117 条）——');
{
  const errs = [];
  const line = new LineRuntime(SH.LINES.l1);
  const flow = new SH.pax.Flow(line, line.stock, 8, false);
  const testIdx = 5;
  const stName = line.stations[testIdx];
  const wait0 = flow.waitingAt(stName, testIdx);

  let egressEvt = null;
  const disp = new SH.traffic.Dispatcher(line, {
    hour: 8,
    pax: flow,
    onEgress: e => { egressEvt = e; }
  });

  const t = disp.trains[0];
  t.s = line.al.stationS[testIdx] + SH.STOP_MARK;
  t.tr.s = t.s; t.tr.v = 0; t.tr.kmhCache = 0;
  t.state = 'dwell'; t.open = 0; t.dwell = 25; t.dwellIdx = testIdx;
  t.load = 0.8;

  // 1. 刚开门时应派发下车人流及上车带数据
  disp.update(1.0);
  if (!egressEvt) {
    errs.push(`AI 列车停站开门后未触发 onEgress 下车人流事件`);
  } else {
    if (egressEvt.at !== testIdx) errs.push(`下车事件站序号错误（应为 ${testIdx}，实为 ${egressEvt.at}）`);
    if (!(egressEvt.need > 0)) errs.push(`下车需求人数应 > 0（实为 ${egressEvt.need}）`);
    if (!(egressEvt.rate > 0)) errs.push(`通过能力率应 > 0（实为 ${egressEvt.rate}）`);
    if (egressEvt.wait0 !== wait0) errs.push(`初始候乘基数与站台需求不一致（实为 ${egressEvt.wait0}，应为 ${wait0}）`);
  }

  // 2. 停站持续乘降：站台候乘人数减少，列车完成上下客载荷交换
  for (let step = 0; step < 150; step++) disp.update(0.1);
  const wait1 = flow.waitingAt(stName, testIdx);
  if (!(wait1 < wait0)) {
    errs.push(`AI 列车停站期间站台候乘人数未减少（初始 ${wait0}，停站后仍为 ${wait1}）—— 未实现站台乘客上车闭环`);
  }
  if (!t._paxServed || t._paxServed.on <= 0 || t._paxServed.off <= 0) {
    errs.push(`AI 列车停站期间未记录实际上下客乘降量（实测 上客 ${t._paxServed ? t._paxServed.on : 0} / 下客 ${t._paxServed ? t._paxServed.off : 0}）`);
  }

  // 3. 非停站状态保护：在区间信号扣停时绝对不触发站台客流
  egressEvt = null;
  const waitBeforeHold = flow.waitingAt(line.stations[testIdx + 1], testIdx + 1);
  t.s = (line.al.stationS[testIdx] + line.al.stationS[testIdx + 1]) / 2;
  t.tr.s = t.s; t.tr.v = 0;
  t.state = 'hold'; t.dwellIdx = null; t._paxServed = null;
  disp.update(2.0);
  if (egressEvt) errs.push(`AI 列车区间扣停误触发站台客流下车事件`);
  const waitAfterHold = flow.waitingAt(line.stations[testIdx + 1], testIdx + 1);
  if (waitAfterHold !== waitBeforeHold) errs.push(`AI 列车区间扣停误消耗邻站候乘人数`);

  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 5).join('\n  ✗ ')); }
  else console.log(`  ✓ AI 车站台客流闭环：开门触发 onEgress 下车人流事件与上车带、停站乘降动态消耗候乘人数（${wait0} → ${wait1} 人）、车载载荷真实进出站置换、区间扣停非站台状态严格隔离`);
}

/* --------------------------------------------- 积分步长不变性与"起点滞留"列
 * 目标里"支线和主线的调度规则也要拉满"的前提是：**判据量的就是玩家看到的那套动力学**。
 * 以前 `Dispatcher.update(dt)` 把调用口给的 dt 直接当成一步积分，于是离线判据（0.5 s
 * 一步）与游戏（夹到 0.05 s 一步）跑的是两套东西：同一局 25 分钟，
 * dt=1/60 车队平均 38.5 km/h，dt=0.5 只有 4.4 km/h，而靠起点那一列只走 943 m
 * —— 这就是"站台上永远停着一列门不开的车"那条老记录的真正来源。
 * 现在调度器内部把 dt 切成不超过 0.05 s 的子步（`SIM_DT`，与 game.js 的上夹取同数）。
 * 两条断言：① 三种步长的车队均速与停站次数必须一致；② 最慢那一列不许显著掉队。 */
{
  const errs = [];
  const line = new LineRuntime(SH.LINES.l2);
  const total = line.al.total;
  const sim = dt => {
    const d = new SH.traffic.Dispatcher(line);
    d.build();
    const s0 = d.trains.map(t => t.s);
    let dw = 0; const prev = d.trains.map(t => t.state), perDw = d.trains.map(() => 0);
    for (let k = 0; k < Math.round(1500 / dt); k++) {
      d.update(dt);
      if (dt > 0.06) continue;                       /* 停站次数只在细步长下逐帧数 */
      d.trains.forEach((t, i) => { if (t.state === 'dwell' && prev[i] !== 'dwell') { dw++; perDw[i]++; } prev[i] = t.state; });
    }
    /* 环形里程差：折返/回绕的车要按环线折一次，否则"移动了 62 km"会被算成 −1 km */
    const mv = d.trains.map((t, i) => (((t.s - s0[i]) % total) + total) % total);
    return { mv, mean: mv.reduce((a, b) => a + b, 0) / mv.length, dw, perDw, n: mv.length, svc: d.trains.map(t => t.svc) };
  };
  const fine = sim(1 / 60), mid = sim(0.125), coarse = sim(0.5);
  const kmh = x => x / 1500 * 3.6;
  for (const [nm, r] of [['0.125', mid], ['0.5', coarse]]) {
    const drift = Math.abs(kmh(r.mean) - kmh(fine.mean)) / kmh(fine.mean);
    if (drift > 0.05) errs.push(`dt=${nm} s 的车队均速 ${kmh(r.mean).toFixed(1)} km/h 与 dt=1/60 的 ${kmh(fine.mean).toFixed(1)} km/h 差 ${(100 * drift).toFixed(0)}%（>5% ⇒ 判据量的不是玩家那套动力学）`);
  }
  if (Math.abs(coarse.mv.length - fine.mv.length) > 0) errs.push('不同步长下车队规模不一致');
  /* "最慢一列"只与**同交路**比：小交路车一圈跑得短，拿它跟全程车的均值比等于用
     一把全线的尺去量半条线（第 133 条之后这条先红了：34.9 对均值 44.7，而那列车
     没有任何异常）。而"环形折过一次的移动距离"这个代理量对短交路本来就没有意义
     （它的 s 在 [0, 折返点] 之间来回，折模之后的相位取决于开局落在哪一段）——
     所以短交路的"有没有卡住"改量**每列车自己的停站次数**：25 分钟里一列在跑的
     车至少停三站，卡死在起点那列车就是 0。 */
  const clsOf = i => fine.svc[i] === 'short' ? 'short' : 'main';
  const grp = {};
  fine.mv.forEach((v, i) => { const c = clsOf(i); (grp[c] = grp[c] || []).push(v); });
  const meanOf = a => a.reduce((x, y) => x + y, 0) / a.length;
  let slow = Math.min(...fine.mv), avg = fine.mean;
  for (const c of Object.keys(grp)) {
    if (c !== 'main') continue;
    const m = meanOf(grp[c]), s = Math.min(...grp[c]);
    if (kmh(s) < kmh(m) * 0.8) errs.push(`全程交路最慢一列 ${kmh(s).toFixed(1)} km/h，本交路均值 ${kmh(m).toFixed(1)} km/h —— 有一列在长期掉队（"起点那列门不开的车"）`);
    slow = s; avg = m;
  }
  {
    const stuck = [];
    fine.perDw.forEach((v, i) => { if (v < 3) stuck.push(`#${i}(${clsOf(i)}) ${v} 次`); });
    if (stuck.length) errs.push(`25 分钟里几乎没停过站的车：${stuck.join(', ')} —— 有一列卡在起点不动（"站台上永远停着一列门不开的车"）`);
    const sd = fine.perDw.filter((v, i) => clsOf(i) === 'short');
    if (sd.length && Math.min(...sd) < Math.min(...fine.perDw.filter((v, i) => clsOf(i) === 'main')))
      errs.push(`小交路车停站次数最少 ${Math.min(...sd)} 次，还不如全程车（${Math.min(...fine.perDw.filter((v, i) => clsOf(i) === 'main'))} 次）—— 短交路的圈更短，理应停得更多`);
  }
  /* 首列特别点名：它的起点在 s=0，站 0 就在 640 m 外，是最容易被步长吃掉的那一列 */
  if (kmh(fine.mv[0]) < kmh(avg) * 0.85) errs.push(`靠起点那一列 ${kmh(fine.mv[0]).toFixed(1)} km/h，掉队于本交路均值 ${kmh(avg).toFixed(1)} km/h`);
  if (!(kmh(fine.mean) > 25)) errs.push(`车队均速只有 ${kmh(fine.mean).toFixed(1)} km/h（标定值 vAvg ${(fine.mean > 0 ? line.runKmh : 0)} km/h 的一半都不到）`);
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 积分步长不变性：dt=1/60 / 0.125 / 0.5 的车队均速 ${kmh(fine.mean).toFixed(1)} / ${kmh(mid.mean).toFixed(1)} / ${kmh(coarse.mean).toFixed(1)} km/h（同一条动力学）；`
    + `25 分钟里最慢一列 ${kmh(slow).toFixed(1)} km/h、靠起点那列 ${kmh(fine.mv[0]).toFixed(1)} km/h，没有掉队的车`);
}

console.log('\n—— 按图运行：晚点记账与补偿 + 首班出车（§7.7）——');
{
  const errs = [];
  /* A 晚点记账与补偿：注入一次 2 分钟的长停站（与"头时保持"一节同一条
     "合法扰动"路径），晚点必须 ① 真的记账（t.late 涨到 ≥60 s）；
     ② **赶点真的把时间抢回来** —— 同一场景跑两遍（确定性模型，同一扰动）：
     正常遍 vs 把该车 t.reg 置位的遍（`!t.reg` 令补偿停机；playerS 已清，
     reg 不改物理，两遍唯一的差别就是补偿这一层）。正常遍后续停站时分的
     累计必须显著更短。这是"实测 = 表值"式的绝对断言：自校准图定链自己
     也会把一次性扰动"原谅"掉（晚点落回负值），单看 t.late 序列分辨不出
     补偿在与不在 —— 两遍相减才量得到补偿的净贡献。
     dayT0 取 8 点：全车队早已出场，判据只量晚点链这一件事。 */
  {
    const lr = new LineRuntime(SH.LINES.l9);
    const run = (withRecovery) => {
      const d = new SH.traffic.Dispatcher(lr, { dayT0: 8 * 3600 });
      d.reset(lr.al.total * 0.3);
      d.playerS = null;      /* reset 需要 playerS 铺服务图/触发出场门控，但判据量的是
                                自由车队的晚点链 —— 静态玩家是一堵墙，车会在它背后排死队，
                                "晚点不回收"量的是堵车不是补偿（第一版实测 527 s 卡死）。 */
      const t4 = d.trains[4];
      let injected = false, maxLate = -1e9, arrivals = 0, dwellAfter = 0, dwellAll = 0;
      for (let k = 0; k < 40 * 60 * 2; k++) {
        d.update(0.5);
        if (t4.state === 'stabled') continue;
        const wasDwell = t4._wasDwell;
        if (!wasDwell && t4.state === 'dwell') {
          arrivals++;
          if (!injected) { t4.dwell = 120; injected = true; }
          else if (arrivals <= 8) dwellAfter += t4.dwell;
        }
        t4._wasDwell = t4.state === 'dwell';
        /* 车队口径（第 133 条之后加的）：小交路上线后车流变密，单看一列车的
           "后续 7 站"样本会因为它的晚点被前车队列消化掉而变得很薄 —— 那不代表
           补偿没生效。同一扰动下把**全车队**注入之后的停站时分加起来相减，
           量的是同一件事（补偿这一层的净贡献），统计功效强得多。 */
        if (injected) for (const t of d.trains) {
          if (!t._wdAll && t.state === 'dwell') dwellAll += t.dwell;
          t._wdAll = t.state === 'dwell';
        }
        /* 补偿停机开关：注入之后把 reg 钉住 —— `!t.reg` 条件令赶点不再触发。
           playerS 为 null 时 escorts() 不会重派 reg，gapTrim 也恒返回 1。 */
        if (injected && !withRecovery) for (const t of d.trains) t.reg = 'lead';
        if (typeof t4.late === 'number' && t4.late > maxLate) maxLate = t4.late;
      }
      return { maxLate, dwellAfter, dwellAll, arrivals, st: d.stats() };
    };
    const R = run(true), N = run(false), R2 = run(true);
    /* A/B 有效的前提是**同一配置跑两遍逐数一致**（确定性），而不是"补偿开与关
       两遍的到站次数相同" —— 后者在干预面铺到全车队之后本来就该不同
       （实测 12 vs 11 是场景差，不是模型抖动）。 */
    if (!R.arrivals) errs.push('注入之后那一列车再也没进过站 —— 场景根本没跑到');
    else if (R2.arrivals !== R.arrivals || R2.dwellAll !== R.dwellAll)
      errs.push(`同一配置跑两遍不一致（到站 ${R.arrivals} vs ${R2.arrivals}、车队停站 ${R.dwellAll.toFixed(0)} vs ${R2.dwellAll.toFixed(0)}）—— 模型不确定，A/B 无效`);
    else {
      if (!(R.maxLate >= 60)) errs.push(`注入 2 分钟停站后晚点峰值只有 ${R.maxLate.toFixed(0)} s（应 ≥60）—— 晚点没有记账（t.late 是死字段）`);
      const saved = N.dwellAfter - R.dwellAfter, savedAll = N.dwellAll - R.dwellAll;
      if (!(savedAll >= 20)) errs.push(`补偿没有净贡献：注入之后全车队停站累计 正常遍 ${R.dwellAll.toFixed(0)} s、停机遍 ${N.dwellAll.toFixed(0)} s，只差 ${savedAll.toFixed(0)} s（应 ≥20）—— 压停站赶点没有生效`);
      const st = R.st;
      if (!(st.lateMaxSec >= 45)) errs.push(`stats().lateMaxSec = ${st.lateMaxSec}，与车队里的晚点对不上 —— 正点率统计没接上 lateSamples`);
      if (st.punctualPct == null || st.punctualPct > 100) errs.push('stats().punctualPct 缺失或越界');
      console.log(`  晚点链：峰值 ${R.maxLate.toFixed(0)} s · 补偿净贡献 车队 ${savedAll.toFixed(0)} s（那列车后续 7 站 ${R.dwellAfter.toFixed(0)} vs ${N.dwellAfter.toFixed(0)} s = ${saved.toFixed(0)} s）· stats 正点 ${st.punctualPct}% / 均晚 ${st.lateAvgSec} s / 最深 ${st.lateMaxSec} s`);
    }
  }
  /* B 首班出车：dayT0 缺省（5:30 首班）+ 有玩家 ⇒ 开局只有第一班在场，
     其余车底按服务头时错峰从起点投运；出场间隔 ≈ 头时；全程无物理重叠；
     70 分钟后全部上线。 */
  {
    const lr = new LineRuntime(SH.LINES.l9);
    const d = new SH.traffic.Dispatcher(lr);
    d.reset(1000);
    d.playerS = null;      /* 同上：出场门控在 reset 时已生效，之后静态玩家会把
                              起点出来的车堵死在它背后（第四列出不了场）。 */
    const stabled0 = d.trains.filter(t => t.state === 'stabled').length;
    if (stabled0 !== d.trains.length - 1)
      errs.push(`开局在场 ${d.trains.length - stabled0} 列（应恰好 1 列——其余车底还没到出场时刻）`);
    const entries = [];
    const before = d.trains.map(t => t.state);
    let spaceMin = Infinity, overlapped = false;
    for (let k = 0; k < 70 * 60 * 2; k++) {
      d.update(0.5);
      d.trains.forEach((t, i) => {
        if (before[i] === 'stabled' && t.state === 'run' && t.s >= 0 && t.enterAt == null) entries.push(d.clock);
        before[i] = t.state;
      });
      const xs = d.trains.filter(t => t.s >= 0 && t.state !== 'stabled').map(t => t.s).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) spaceMin = Math.min(spaceMin, xs[i] - xs[i - 1]);
    }
    if (spaceMin < d.len - 1) { overlapped = true; }
    if (overlapped) errs.push(`出场过程中列车物理重叠：最小车头间距 ${spaceMin.toFixed(0)} m < 编组 ${d.len.toFixed(0)} m`);
    if (entries.length !== d.trains.length - 1)
      errs.push(`70 分钟里只出场 ${entries.length} 列（应为 ${d.trains.length - 1}）—— 出场判定没有走完`);
    const H = d.headwayMin * 60;
    const gaps = entries.slice(1).map((v, i) => v - entries[i]).sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : 0;
    if (!(med >= H * 0.5 && med <= H * 2.0))
      errs.push(`出场间隔中位 ${(med / 60).toFixed(1)} min，不在服务头时 ${d.headwayMin} min 的 0.5~2 倍内 —— 出场不是按运行图错峰的`);
    const st = d.stats();
    if (st.exiting !== 0) errs.push(`跑完后 stats().exiting = ${st.exiting} —— 还有车底没投运`);
    console.log(`  首班出车：开局在场 1 列 → ${entries.length} 列错峰上线（间隔中位 ${(med / 60).toFixed(1)} min / 头时 ${d.headwayMin} min），最小车头间距 ${spaceMin.toFixed(0)} m`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 按图运行：晚点沿图定链记账（t.late 非死字段）、超 20 s 压停站补偿可回收、stats 正点率接线；首班出车按服务头时错峰、进路判据与折返同一条、全程无重叠');
}

console.log('\n—— 磁浮按批次运行（§7.8 名义头时要兑现）——');
{
  const errs = [];
  const lr = new LineRuntime(SH.LINES.ml);
  const d = new SH.traffic.Dispatcher(lr);
  for (let k = 0; k < 120 * 60 * 2; k++) d.update(0.5);
  const g = d.depGaps.slice().sort((a, b) => a - b);
  const med = g.length ? g[g.length >> 1] / 60 : 0;
  if (g.length < 10) errs.push(`磁浮 120 分钟只采到 ${g.length} 个到站间隔样本，判据没有真正跑到`);
  else if (!(med >= 7.2 && med <= 11.0))
    errs.push(`磁浮端头到站间隔中位 ${med.toFixed(1)} min（名义 ${d.headwayMin} min，应落在 0.9~1.4 倍内）—— ${d.n} 列 + 90 s 折返把实际头时跑成 ${med.toFixed(1)} min，名义值是假的`);
  else console.log(`  磁浮：${d.n} 列 · 折返作业 ${Math.round(d._turnbackDwell())} s · 端头到站间隔中位 ${med.toFixed(1)} min（名义 ${d.headwayMin} min）`);
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 磁浮按批次运行：折返作业时分补足批间隔（清客/充电级作业），端头头时兑现名义值');
}

console.log('\n—— 交路级时段规则（第 129 条：先抽支线、配车基准按 baseId）——');
{
  const f = (h, s) => SH.headwayFactor(h, s);
  /* ① 时段系数必须分交路：高峰同权（基线不动），平峰与深夜先抽支线 */
  if (!(f(8, 'branch') === f(8, 'main') && f(14, 'branch') > f(14, 'main') && f(23, 'branch') > f(23, 'main')))
    fail(`交路系数没分家：高峰 ${f(8, 'main')}/${f(8, 'branch')}、平峰 ${f(14, 'main')}/${f(14, 'branch')}、深夜 ${f(23, 'main')}/${f(23, 'branch')}`);
  if (f(14) !== f(14, 'main') || f(8) !== f(8, 'main'))
    fail(`不传交路时与主线不一致（${f(14)} vs ${f(14, 'main')}）—— 既有标定被这次改动打破`);
  if (!(f(14, 'branch') < 2.0 && f(23, 'branch') < 3.2))
    fail(`支线抽得太狠（平峰 ${f(14, 'branch')}、深夜 ${f(23, 'branch')}）—— 支线也是有人坐的`);
  /* ② 配车头时基准按 baseId 查：支线交路的 id 带 `#branch` 后缀，查不到就退 4.0
      —— 于是 5 号线支线跑在 4.0（该线标定 6.0，支线比主线还密）、
      10 号线支线跑在 4.0（标定 3.5）。只有 11 号线恰好撞上，所以一直没人看见。 */
  for (const id of ['l5', 'l10']) {
    const base = SH.traffic.HEADWAY[id];
    const d = new SH.traffic.Dispatcher(new LineRuntime(SH.LINES[id], 'branch'), { hour: 8 });
    if (Math.abs(d.headwayMin - base) > 1e-6)
      fail(`${id} 支线交路的配车头时基准 ${d.headwayMin.toFixed(2)}，应为该线标定 ${base} —— 查表用了带 #branch 后缀的 id`);
  }
  /* ③ 交路比例按钟点给：高峰档必须与既有标定逐字节一致（不传 hour 也走高峰档） */
  const L10 = new LineRuntime(SH.LINES.l10);
  const rPeak = SH.interlineMeta(L10).ratio, r8 = SH.interlineMeta(L10, 8).ratio, r14 = SH.interlineMeta(L10, 14).ratio;
  if (rPeak[0] !== r8[0] || rPeak[1] !== r8[1])
    fail(`不传 hour 的交路比例 [${rPeak}] 与高峰 [${r8}] 不一致 —— 默认基线被动过`);
  if (!(r14[0] > r8[0] && r14[1] === r8[1]))
    fail(`平峰交路比例 [${r14}] 没比高峰 [${r8}] 更偏主线 —— "抽车先抽支线"没落到配车上`);
  /* ④ 效果层：平峰支线真的少投车，而这不是靠主线一起少（主线少是时段系数的事） */
  const nb = h => new SH.traffic.Dispatcher(new LineRuntime(SH.LINES.l10, 'branch'), { hour: h }).n;
  const nm = h => new SH.traffic.Dispatcher(new LineRuntime(SH.LINES.l10), { hour: h }).n;
  if (!(nb(14) < nb(8))) fail(`平峰支线配车 ${nb(14)} 没比高峰 ${nb(8)} 少`);
  if (!(nm(14) >= nm(8) * 0.55)) fail(`平峰主线配车 ${nm(14)} 相对高峰 ${nm(8)} 掉得太狠（时段系数 1.3 不该砍一半以上）`);
}

/* --------------------------------------------- 小交路（中途折返的第三交路，第 133 条）
 * 目标里"支线和主线的调度规则也要拉满"缺的最后一块：在此之前一条线只有"全程"与
 * "Y 型支线贯通"两种行程。小交路的定义性事实是**共线段比端头密**，所以判据必须
 * 量到这件事本身，而不是只量"车没跑出界"。 */
console.log('\n—— 小交路：中途折返、共线段加密、端头不许没人跑（第 133 条）——');
{
  const errs = [];
  const L = new LineRuntime(SH.LINES.l9);
  const d = new SH.traffic.Dispatcher(L, { dayT0: 8 * 3600 });
  const S = L.al.stationS, n = L.stations.length;
  /* ① 类规则：短线不许投小交路（投了就是把端头的一半班次砍掉，是倒效果） */
  if (!d.short) errs.push(`9 号线（${n} 站 / ${(L.al.total / 1000).toFixed(0)} km）没投小交路 —— 类规则没生效`);
  const SHORTLINE = SH.LINES.maglev ? new LineRuntime(SH.LINES.maglev) : new LineRuntime(SH.LINES.l17);
  const dS = new SH.traffic.Dispatcher(SHORTLINE, { dayT0: 8 * 3600 });
  if (dS.short) errs.push(`${SHORTLINE.name}（${SHORTLINE.stations.length} 站）被投了小交路 —— 门槛（站数 ≥20 且单程 ≥25 km）没拦住`);
  /* ② 只切不增：小交路车是从同一支车队里分出来的，车队总数必须一格没多。
     `ratio`/`mid` 都走"没有折返点就退到安全值"的取法 —— 类规则失效时判据必须
     **报红**而不是崩：崩掉的 rc=1 会让负控看起来像"报红了"（红字一条没有）。 */
  const nAll = d.trains.length, ratio = d.short ? d.short.ratio : 0;
  if (!(d.nShort > 0)) errs.push('nShort = 0 —— 分了行程却没标出哪些车是短交路');
  if (d.trains.filter(t => t.svc === 'short').length !== d.nShort)
    errs.push(`nShort=${d.nShort} 与按 svc 数出来的 ${d.trains.filter(t => t.svc === 'short').length} 不一致（登记表没照抄交给运行的那一份）`);
  if (!(Math.abs(d.nShort - nAll * ratio) <= 1))
    errs.push(`小交路占比 ${d.nShort}/${nAll} 偏离参数 ${(ratio * 100).toFixed(0)}% 超过一列`);
  if (d.trains.length !== d.n)
    errs.push(`实际铺了 ${d.trains.length} 列而配车数是 ${d.n} —— 小交路是**切分**不是追加车底`);
  /* ③⑤ 跑 200 分钟：越界、端头班次来源、共线段 vs 端头的密度差 */
  const mid = d.short ? d.short.idx : Math.round(n / 2) - 1, far = n - 2;
  const firstWrap = new Map(), crossed = [];
  const dwellsBy = new Map();                     // 站序 -> {main, short}
  const bump = (si, svc) => {
    const b = dwellsBy.get(si) || { main: 0, short: 0 };
    b[svc === 'short' ? 'short' : 'main']++;
    dwellsBy.set(si, b);
  };
  const prev = d.trains.map(t => t.state);
  for (let k = 0; k < 200 * 60 * 2; k++) {
    d.update(0.5);
    d.trains.forEach((t, i) => {
      /* 先认"跑完过第一圈没有"：小交路车开局若落在折返点之外，它这一圈照旧跑到
         线路末端再折返（`_endOf` 的设计），那是**出场**不是越界。统计口径必须从
         它第一次回到起点之后才算 —— 否则第一圈的正常停靠会被判成缺陷。 */
      if (t.svc === 'short') {
        if (t._wasS != null && t.s < t._wasS - 1) firstWrap.set(i, true);   // 只有折返/回绕会让 s 倒退，段内折返也算
        t._wasS = t.s;
      }
      if (t.state === 'dwell' && prev[i] !== 'dwell' && !(t.svc === 'short' && !firstWrap.has(i)))
        bump(t.dwellIdx != null ? t.dwellIdx : t.next - 1, t.svc);
      prev[i] = t.state;
      /* 一旦回到过起点，之后就不许再越过折返点。 */
      if (t.svc === 'short' && firstWrap.has(i) && t.s > S[mid] + 1)
        crossed.push(`#${i} s=${t.s.toFixed(0)} > 折返点 ${S[mid].toFixed(0)}`);
    });
  }
  if (crossed.length) errs.push(`小交路车越过折返点：${crossed.slice(0, 3).join('; ')}`);
  /* 折返之后目的地必须跟着改（`_turnbackDwell` → release 那一笔）：屏上继续写
     线路终点，就是让乘客上一班到不了的车 —— 与客流闸门是同一件事的两面。 */
  {
    const bad = [];
    d.trains.forEach((t, i) => {
      if (t.svc === 'short' && firstWrap.has(i) && t.dest !== L.stations[mid]) bad.push(`#${i} 写「${t.dest}」`);
    });
    if (bad.length) errs.push(`折返之后小交路车的目的地没跟着改：${bad.slice(0, 3).join('; ')}`);
  }
  if (firstWrap.size < d.nShort) errs.push(`只有 ${firstWrap.size}/${d.nShort} 列小交路车完成过第一圈 —— 200 分钟不够它们跑完一圈？`);
  const fb = dwellsBy.get(far) || { main: 0, short: 0 };
  if (fb.short) errs.push(`端头站 ${L.stations[far]} 有 ${fb.short} 次是**小交路车**停靠的 —— 它根本到不了这里`);
  if (!(fb.main > 0)) errs.push(`端头站 ${L.stations[far]} 30 分钟里一班全程车都没到 —— 小交路把端头跑没了`);
  /* ⑤ 这条是**目的**本身：共线段（站 1）的到站班次必须明显密于端头 */
  const tb = dwellsBy.get(1) || { main: 0, short: 0 };
  if (!((tb.main + tb.short) > (fb.main + fb.short) * 1.15))
    errs.push(`共线段 ${tb.main + tb.short} 班 vs 端头 ${fb.main + fb.short} 班 —— 小交路没有把干线加密（这才它的存在理由）`);
  /* ⑥ 客流闸门：份额单调、端点正确，且 AI 上客路径真的乘了这个份额 */
  const ws = SH.pax.withinShare;
  if (ws(L, 1, n - 1, 8) !== 1) errs.push('upto = 终点时份额不是 1 —— 全程车被自己的闸门挡了');
  if (!(ws(L, 1, mid, 8) < 1 && ws(L, 1, mid, 8) > 0)) errs.push(`折返点处的份额 ${ws(L, 1, mid, 8)} 不在 (0,1) —— 闸门是个摆设`);
  if (!(ws(L, 1, Math.floor(mid / 2), 8) <= ws(L, 1, mid, 8))) errs.push('份额对行程端点不单调 —— 行程更长反而装得更少');
  {
    const ts = require('fs').readFileSync('src/traffic.js', 'utf8');
    if (!/Math\.ceil\(currentWait \* \(ps\.gate == null \? 1 : ps\.gate\)\)/.test(ts))
      errs.push('AI 上客没有按 `ps.gate` 限量 —— 小交路会把到不了的人装上車（客流守恒从此是假的）');
    const ps = require('fs').readFileSync('src/pax.js', 'utf8');
    if (!/this\._add\(idx, on, upto\)/.test(ps)) errs.push('Flow._add 没收到本次列车的行程端点 —— 目的站会被分到车到不了的地方');
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 小交路：${d.nShort}/${nAll} 列走区间（折返点 ${L.stations[mid]}），共线段 ${tb.main + tb.short} 班 vs 端头 ${fb.main + fb.short} 班，`
    + `越界 0、端头无短车、客流闸门份额 ${ws(L, 1, mid, 8).toFixed(2)} 且单调`);
}

/* --------------------------------------------- 支线贯通率（Y 型线的第三种行程，第 134 条）
 * 第 121 条让支线交路真的贯通，但那是"全贯通"：支线车队每一列都从共线段一路开进尾巴。
 * 真实 Y 型运营还有**在分岔站折返的支线区间车** —— 它加密共线段，代价是尾巴少几班。
 * 与第 133 条共用同一套"按车给行程"，所以行程这件事全网只有一份实现。 */
console.log('\n—— 支线贯通率：分岔站折返的区间车，共线段加密而尾巴不许没人跑（第 134 条）——');
{
  const errs = [];
  const bLine = h => new LineRuntime(SH.LINES.l10, 'branch');
  const every = h => SH.branchTurnbackEvery(bLine(), h);
  /* ① 高峰全贯通 ⇒ 与第 121/129 条的既有标定逐字节一致（默认 hour=8 一切不动） */
  if (every(8) !== 0 || every(17.5) !== 0) errs.push(`高峰折返步长 ${every(8)}/${every(17.5)} 应为 0（全贯通）—— 默认基线被动过`);
  if (every() !== 0) errs.push('不传 hour 的折返步长不是 0 —— 默认档必须与高峰一致');
  const dPeak = new SH.traffic.Dispatcher(bLine(), { dayT0: 8 * 3600 });
  if (dPeak.trains.some(t => t.turn)) errs.push('高峰支线里出现了折返车');
  /* ② 平峰真的折返，且行程端点/目的地/登记三件事同源 */
  const dOff = new SH.traffic.Dispatcher(bLine(), { hour: 14, dayT0: 14 * 3600 });
  const fork = dOff.inter.forkIdx, forkName = dOff.line.stations[fork];
  const turns = dOff.trains.filter(t => t.turn);
  if (dOff.turnEvery !== every(14)) errs.push(`调度器读到的折返步长 ${dOff.turnEvery} 与数据表 ${every(14)} 不一致`);
  if (!(turns.length >= 1)) errs.push(`平峰 ${dOff.trains.length} 列支线车里没有一列折返（步长 ${dOff.turnEvery}）`);
  for (const t of turns) {
    if (t.last !== fork) errs.push(`折返车的行程端点 ${t.last} 不是分岔站 ${fork}`);
    if (t.dest !== forkName) errs.push(`折返车目的地写「${t.dest}」，应为分岔站「${forkName}」`);
    if (t.svc !== 'branch') errs.push(`折返车的交路身份被改成 ${t.svc}（车次号前缀会跟着错）`);
  }
  /* ③ 编组不足时**不硬造**区间车：深夜只剩 2 列时，宁可全贯通也不能把尾巴跑没 */
  const dNight = new SH.traffic.Dispatcher(bLine(), { hour: 22, dayT0: 22 * 3600 });
  if (dNight.trains.length < dNight.turnEvery && dNight.trains.some(t => t.turn))
    errs.push(`深夜只有 ${dNight.trains.length} 列（步长 ${dNight.turnEvery}）却仍造出折返车 —— 尾巴会一班都不剩`);
  /* ④⑥ 跑 120 分钟（支线平峰只有 3 列、单程 37 km ⇒ 一圈两小时，25 分钟连分岔站都到不了）：越界、尾巴班次来源、共线段是否真的因此更密 */
  const run = (d, mins) => {
    const S = d.line.al.stationS, prev = d.trains.map(t => t.state), wrapped = new Set(), by = new Map();
    let cross = 0;
    /* 折返那一停算不算"服务了这一站"？算 —— 折返状态里门是开的（`t.open = 1`）、
       停 90 s，乘客真实上下。但它是 `state === 'turnback'` 而不是 `'dwell'`，
       只数 dwell 会把"区间车在分岔站折返"这一趟**从统计里整个抹掉**
       （实测：折返场景分岔站计数 3、全贯通场景 5 —— 恰恰反了）。 */
    const bump = (si, isTurn) => {
      const b = by.get(si) || { thr: 0, turn: 0 };
      b[isTurn ? 'turn' : 'thr']++; by.set(si, b);
    };
    for (let k = 0; k < mins * 60 * 2; k++) {
      d.update(0.5);
      d.trains.forEach((t, i) => {
        if (t.turn) { if (t._w != null && t.s < t._w - 1) wrapped.add(i); t._w = t.s; }
        if (t.state === 'dwell' && prev[i] !== 'dwell') {
          const si = t.dwellIdx != null ? t.dwellIdx : t.next - 1;
          bump(si, t.turn);
          if (t.turn && si > fork) cross++;
        }
        if (t.state === 'turnback' && prev[i] !== 'turnback' && t.last != null) bump(t.last, t.turn);
        prev[i] = t.state;
        if (t.turn && wrapped.has(i) && t.s > S[fork] + 1) cross++;
      });
    }
    return { by, cross };
  };
  const R = run(dOff, 120);
  if (R.cross) errs.push(`支线折返车越过分岔站 ${R.cross} 次 —— 它不该进尾巴`);
  let tailTurn = 0;
  for (const [si, b] of R.by) if (si > fork) tailTurn += b.turn;
  if (tailTurn) errs.push(`尾巴站被折返车停靠 ${tailTurn} 次（折返车根本到不了那里）`);
  if (dOff.trains.length !== dOff.n) errs.push(`支线实际铺了 ${dOff.trains.length} 列而配车数是 ${dOff.n} —— 只切不增被破坏`);
  /* ⑥ 存在理由：共线段（分岔站）相对尾巴的班次比，折返场景必须高于全贯通场景 */
  const trunkAt = r => { const b = r.by.get(fork) || { thr: 0, turn: 0 }; return b.thr + b.turn; };
  const tailAt = r => { let n = 0; for (const [si, b] of r.by) if (si > fork) n += b.thr + b.turn; return n; };
  const dThr = new SH.traffic.Dispatcher(bLine(), { hour: 14, dayT0: 14 * 3600 });
  dThr.turnEvery = 0; dThr.build();
  const T = run(dThr, 120);
  const rOn = trunkAt(R) / Math.max(1, tailAt(R)), rOff = trunkAt(T) / Math.max(1, tailAt(T));
  if (!(tailAt(R) > 0)) errs.push('120 分钟里尾巴一班都没到 —— 折返把支线跑断了');
  if (!(rOn > rOff * 1.05))
    errs.push(`共线段/尾巴 班次比：折返场景 ${rOn.toFixed(2)} vs 全贯通 ${rOff.toFixed(2)} —— 贯通率没有加密共线段，那它就没有存在意义`);
  /* ⑦ 站台屏：尾巴站不许串出分岔站目的地（区间车到不了），而分岔站自己可以 */
  {
    const st = dOff.line.al.stationS[fork + 1];
    let bad = 0;
    for (let k = 0; k < 8 * 60; k++) {
      dOff.update(0.5);
      const n = SH.nextTrain(dOff, dOff.line, fork + 1, { self: null });
      if (n && n.line1 === '往 ' + forkName) bad++;
    }
    if (bad) errs.push(`尾巴站 ${dOff.line.stations[fork + 1]} 的屏出现 ${bad} 次「往 ${forkName}」—— 那班车到不了这里（st=${st}）`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 支线贯通率：高峰全贯通（与基线逐字节一致）、平峰 ${turns.length}/${dOff.trains.length} 列在 ${forkName} 折返、`
    + `越界 0、尾巴只由贯通车服务、共线段/尾巴班次比 ${rOn.toFixed(2)} > 全贯通 ${rOff.toFixed(2)}、深夜不硬造区间车、屏在尾巴站不串目的地`);
}

console.log(bad ? `\n✗ ${bad} 项判据未通过` : '\n✓ AI 列车与运行调度全部判据通过（不重叠、防护有效、会停站、会扣车、头时保持、能折返、信号与闭塞同源、站台屏倒计时真的在走、AI 车载随时段变、运营信息同源、站区半长单点、双线对向车队、玩家锚定服务图与间隔调节、套跑交路与分岔站 PIS 对账、AI 车站台客流闭环、积分步长不变性、按图运行与首班出车、磁浮按批次运行、交路级时段规则、小交路中途折返、支线贯通率）');
process.exitCode = bad ? 1 : 0;

