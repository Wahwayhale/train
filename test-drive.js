require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;

/* game.js 里的 Session / LineRuntime 依赖 DOM，这里把类定义抠出来，
   用桩 app 复现同样的调用序列，验证状态机与 ATO 是否收敛。 */
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const MODES = { manual: { name: '人工驾驶' }, semi: { name: '半自动' }, auto: { name: '全自动' } };
Object.assign(global, {
  CAR_GAP: 0.35, MODES, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
});
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
const Session = eval('(' + grab('Session') + ')');

let bakes = 0;
const app = {
  pa: { welcome() {}, departing() {}, approaching() {}, arriving() {}, doorOpen() {}, doorClose() {} },
  audio: { click() {}, alarm() {}, stopSettle() {}, doorOpen() {}, doorClose() {} },
  ato: new SH.physics.ATO('auto'),
  toast() {}, hint() {}, showJudge() {}, syncLever() {},
  bakeAhead() { bakes++; }, finishRun() {},
};
const ctxOf = s => ({ distanceToStop: s.d, speedKmh: s.tr.kmh, limitKmh: s.limit, grade: s.grade, curveK: s.curveK, curveLimit: s.limit, predictStop: s.tr.predictStop(s.grade), perf: s.tr.spec.perf, load: s.tr.load });

let bad = 0;
/* 默认列表必须包含磁浮：它是全网唯一 vMax≥160 的线，速度兑现/夹直线/里程对账
   三条判据只有跑到它才成立。以前默认只有 l2/l3/l16，磁浮要手工带参数，
   于是那三条判据在总 sweep 里等于不存在。 */
const lineIds = process.argv.slice(2).length ? process.argv.slice(2) : ['l2', 'l3', 'l16', 'ml'];
for (const id of lineIds) {
  const def = SH.LINES[id];
  const line = new LineRuntime(def);
  console.log(`\n${'='.repeat(70)}`);
  const stk = SH.STOCK[def.stock] || {};
  console.log(`${def.name} ${def.stations[0]}→${def.stations[def.stations.length - 1]}  线形 ${line.al.total.toFixed(0)} m / ${line.al.stationS.length} 站  最小曲线半径 ${line.al.minRadius(0, line.al.total).toFixed(0)} m  ${stk.type || def.stock} ${stk.formation || ''}`);
  const ride = {};                         // 三种模式各存一份乘坐质量数据，最后互相比
  for (const mode of ['auto', 'semi', 'manual']) {
    bakes = 0;
    let jMax = 0, jHold = 0, chg = 0, prevN = null;
    const s = new Session(app); app.ato = new SH.physics.ATO(mode);
    const driver = new SH.physics.ATO('auto');      // 扮演"会开车的司机"，0.4 s 才动一次手柄
    s.start(line, mode, 2, 3);
    const dt = 1 / 30; let steps = 0;
    let vPeak = 0, tRun = 0;                // 实测能跑多快、跑了多久
    /* 预算按几何给：里程标定之后 16 号线平均站间距 5.4 km，3 段要 2000 s 才跑得完；
       写死 900 s 会让它"未跑完"报红 —— 那是判据的时钟不够长，不是车开不动。 */
    const avgGap = (line.al.stationS[line.stations.length - 1] - line.al.stationS[0]) / Math.max(1, line.stations.length - 1);
    const budget = 30 * Math.min(2400, Math.max(900, Math.round(3 * avgGap / Math.max(6, line.runKmh / 9))));
    for (let i = 0; i < budget; i++) {
      /* 模拟司机取的是 ATO 的**原始决策**（`_decide`），不是整型之后的 `notch`：
         真人推手柄本来就是阶跃，物理侧的 jerk 限幅器负责把它磨圆；
         如果这里再套一层 ATO 的需求整形，等于把同一个滞后算两遍 ——
         实测每站冲过头 11~23 m，看着像"物理改坏了"，其实是双重滤波。 */
      if (mode !== 'auto' && s.canManual() && i % 12 === 0) { const n = driver._decide(ctxOf(s)); if (n !== null) s.tr.setNotch(n); }
      if (mode === 'manual' && s.phase === 'ready' && i > 60) s.depart();
      if (s.phase === 'stopped' && !s.doors && !s._committed) s.openDoors();
      /* 模拟司机的停站策略：按乘降需求停够时间（真实司机就是看站台上还有没有人）。
         RUSH=1 时改成"只停 3 秒"，用来验证评分确实会因为甩客而掉下来。 */
      if (s.doors) {
        const need = process.env.RUSH ? 3 : s.dwellNeed();
        if (s.dwell > need) s.closeDoors();
      }
      s.update(dt); steps++;
      if (s.tr.kmh > vPeak) vPeak = s.tr.kmh;
      /* 只累计**收入段**的运行时间：终点站之后还有一段 25 km/h 的入库推进，
         它不属于"450 s 跑完 29.088 km"这个口径，算进去会虚高 86 s。 */
      if (s.phase === 'running' && s.tr.s <= line.al.stationS[line.stations.length - 1]) tRun += dt;
      /* 采样乘坐质量：|jerk| 峰值、顶在限幅器上的时间、级位切换次数 */
      const jl = s.tr.jerk > 0 ? SH.JERK.up : SH.JERK.dn;
      jMax = Math.max(jMax, Math.abs(s.tr.jerk));
      if (Math.abs(s.tr.jerk) > jl * 0.9) jHold += dt;
      if (prevN !== null && s.tr.notch !== prevN) chg++;
      prevN = s.tr.notch;
      if (process.env.TRACE && steps % 1500 === 0) console.log('        t', (steps / 30).toFixed(0), 's', Math.round(s.s), 'kmh', s.tr.kmh.toFixed(0), 'lim', s.limit, 'd', s.d.toFixed(0), s.phase, 'notch', s.tr.notch);
      if (s.phase === 'finished' || steps > budget - 300) break;
    }
    const sum = s.summary();
    const errs = s.results.map(r => r.err);
    const worst = errs.length ? Math.max(...errs.map(Math.abs)) : NaN;
    const px = sum.pax || {};
    console.log(`  [${mode.padEnd(6)}] ${(steps / 30).toFixed(0).padStart(3)}s 仿真  烘焙${bakes}次  ${s.phase.padEnd(9)} 总分 ${String(sum.total).padStart(3)} ${sum.grade.padEnd(3)} 最大误差 ${isFinite(worst) ? worst.toFixed(2) + ' m' : '—'}` +
      `  最高 ${vPeak.toFixed(0).padStart(3)}km/h 运行 ${tRun.toFixed(0)}s` +
      `  客运 ${String(px.boarded).padStart(4)}上/${String(px.alighted).padStart(4)}下 甩 ${String(px.leftBehind).padStart(4)} 终到满载 ${px.pct}%`);
    /* 硬断言：跑完一局必须真的结算、停车在指标内、客流确实在跑且不越上限 */
    const gerrs = [];
    if (s.phase !== 'finished') gerrs.push('未跑完');
    /* 停车精度是**两个不同的承诺**，不能共用一条门槛：
       ±0.3 m 是 ATO 的设计指标（01A07），这里给到 0.60 m 已经是放宽；
       而 semi/manual 两局的车由测试自己写的"模拟司机"开 —— 他每 0.4 s 才动一次手柄
       （真人的手不会更快），量出来的是这个司机模型的手艺，不是模型的物理。
       16 号线就是这一条：平均站间距 5.36 km、终到 106% 满载，ATO 停到 0.52 m，
       模拟司机 0.62 m —— 差的是那 0.4 s 的决策粒度（68 km/h 下一步走 9 m）。
       所以对人工只断言两条：绝对上界 1.00 m（本项目自己给人工定的界，不是公开口径），
       以及**相对同一条线的 ATO 不许超过 1.5 倍** —— 后者才有牙：
       把人工的制动模型弄坏，误差会立刻爆掉，而它挡不住"门槛被顺手放宽"。 */
    if (isFinite(worst) && mode === 'auto' && worst > 0.60)
      gerrs.push(`ATO 停车误差 ${worst.toFixed(2)} m 超过 0.60 m（设计指标 ±0.3 m）`);
    if (isFinite(worst) && mode !== 'auto') {
      if (worst > 1.00) gerrs.push(`模拟司机停车误差 ${worst.toFixed(2)} m 超过本项目给人工定的 1.00 m`);
      /* 比值判据是**退化探测器**，不是绝对标准：磁浮上 ATO 停到 0.00 m，
         任何有限的人工误差都会超过它的 1.5 倍 —— 那种情况下这条只会误报。
         所以只在 ATO 误差本身有量级（>0.20 m）时比，绝对上界 1.00 m 才是主力。 */
      if (ride.autoWorst != null && ride.autoWorst > 0.20 && worst > ride.autoWorst * 1.5 + 0.10)
        gerrs.push(`模拟司机误差 ${worst.toFixed(2)} m 超过同线 ATO ${ride.autoWorst.toFixed(2)} m 的 1.5 倍（人工模型退化）`);
    }
    if (mode === 'auto') ride.autoWorst = isFinite(worst) ? worst : null;
    if (px.pct > 140) gerrs.push('满载率超物理上限 ' + px.pct + '%');
    if (!px.boarded && process.env.RUSH !== '1') gerrs.push('完全没有乘降发生，客流模型没接上');
    /* ---- 速度口径必须被物理兑现 ----
       数据侧写着运营 300 km/h、物理侧跑不到，玩家看到的就是"限速 300、
       表针停在 130"。这条判据以前不存在，所以磁浮的曲线附加阻力写错单位
       （把未被平衡的**横向**加速度当**纵向**阻力扣）之后，极速被压到 128 km/h，
       而 12 个离线判据全绿 —— 全部速度类判据都只在 80 km/h 的地铁区里打转，
       高速区没人看守。 */
    if (mode === 'auto' && line.runKmh >= 160 && vPeak < 0.95 * line.runKmh)
      gerrs.push(`运营速度 ${line.runKmh} km/h 而实测最高只有 ${vPeak.toFixed(0)} —— 牵引模型兑现不了自己写的运营口径`);
    /* _note 里写死的秒数（磁浮「450 s 跑完 29.088 km」）与实测运行时间对账 */
    if (mode === 'auto') {
      const ms = /(\d{3,4})\s*s\s*跑完/.exec(def._note || '');
      if (ms && Math.abs(tRun - +ms[1]) / +ms[1] > 0.15)
        gerrs.push(`_note 写「${ms[1]} s 跑完」而实测运行 ${tRun.toFixed(0)} s（差 ${((tRun - +ms[1]) / +ms[1] * 100).toFixed(0)}%）`);
    }
    /* 站间距只允许有一个生成器。game.js 的 LineRuntime._gaps 以前自己另写了一套，
       比 SH.synthGaps 多一条"市中心 ×0.86"调制、哈希偏移还差 1，于是 test-core
       那套线形判据量的根本不是游戏里那条线。这里比对**结果**，不比代码写法。 */
    if (mode === 'auto') {
      const ref = SH.lineGaps(def, line.stations);
      if (ref.length !== line.gaps.length || ref.some((g, i) => g !== line.gaps[i]))
        gerrs.push('LineRuntime.gaps 与 SH.synthGaps 结果不一致 —— 站间距出现了第二个真值');
    }
    if (sum.results.some(r => r.load == null || !isFinite(r.score))) gerrs.push('逐站记录里有非法值');
    /* ---- 乘坐质量三条（2026-10-01 这一轮立起来的）----
     * ① 纵向冲动不许超过 SH.JERK 声明的上限：限幅器要是被删掉或调松，这里报红。
     * ② ATO 必须比"0.4 秒推一次手柄的司机"更稳。原来平稳评分的惩罚阈值
     *    写在 0.85，而限幅器天花板是 0.75/1.05 —— 那一项永远不罚分，
     *    两种开法都是 99，指标自我一致地什么都不测量。这条比较只有在
     *    指标真的能分辨大小时才可能通过。
     * ③ ATO 换级次数要有限（需求整形 + 0.09 m/s² 迟滞的效果）：
     *    无记忆的"跨阈值就换档"每站能翻几十次，听着就是连续的顿挫。 */
    if (jMax > Math.max(SH.JERK.up, SH.JERK.dn) + 1e-6)
      gerrs.push(`纵向冲动峰值 ${jMax.toFixed(2)} m/s³ 超过声明上限 ${Math.max(SH.JERK.up, SH.JERK.dn)} —— jerk 限幅器失效了`);
    /* 顶格时间占比：有硬限幅之后 |jerk| 永远不超过上限，能区分"开得细"和
       "开得糙"的只有它有多少时间钉在天花板上（实测 ATO ≈1~2.5%、
       半自动 ≈1.5~4%、人工 ≈5~7%）。
       **不钉绝对阈值**：全网量下来 0.6%~5.2%，起决定作用的是速度等级与
       段长（磁浮一趟 300 km/h 加速 + 制动，5.2% 是合理的），不是开得好不好 ——
       一个跨不了速制的常数只会制造假红字。能跨线路成立的无量纲不变量是
       **稳度排序**：全自动 < 半自动 < 人工（顶格占比），
       以及 ATO 的平稳分必须明显高于"0.4 秒推一次手柄的司机"。
       后者尤其重要：原来的平稳惩罚阈值写在 0.85、限幅器天花板 0.75/1.05，
       那一项永远不罚分，两种开法都是 99，指标自我一致地什么都不测量。 */
    const pinPct = jHold / Math.max(1, steps / 30) * 100;
    const meanSmooth = sum.results.length ? sum.results.reduce((a, r) => a + r.smooth, 0) / sum.results.length : 0;
    ride[mode] = { smooth: meanSmooth, chg: chg, legs: Math.max(1, sum.results.length), jMax: jMax, pin: pinPct };
    if (mode === 'manual' && px.boarded && process.env.RUSH !== '1') {
      if (ride.auto && ride.semi && !(ride.auto.pin < ride.semi.pin && ride.semi.pin < ride.manual.pin))
        gerrs.push(`稳度排序被打乱：顶格 自动 ${ride.auto.pin.toFixed(1)}% / 半自动 ${ride.semi.pin.toFixed(1)}% / 人工 ${ride.manual.pin.toFixed(1)}%`);
      if (ride.auto && ride.auto.smooth < ride.manual.smooth + 2)
        gerrs.push(`ATO 平稳 ${ride.auto.smooth.toFixed(1)} 不高于人工 ${ride.manual.smooth.toFixed(1)} —— 平稳指标又变成空的了`);
    }
    if (gerrs.length) { bad += gerrs.length; console.log('     ✗ ' + gerrs.join(' ; ')); }
    console.log('        ' + (s.results.map(r => `${r.station} ${r.grade}(${r.err >= 0 ? '+' : ''}${r.err.toFixed(2)}m 平稳${Math.round(r.smooth)})`).join('   ') || '无结果')
      + `   |jerk|峰值 ${jMax.toFixed(2)} m/s³ 顶限幅 ${pinPct.toFixed(1)}% 换级 ${chg} 次（${(chg / Math.max(1, sum.results.length)).toFixed(0)}/站）`);
  }
}

/* ---- jerk 限幅器的三重锁（防"空指标"复发）----
 * 这一轮最贵的一课：平稳评分的惩罚阈值写在 0.85 m/s³，而当时限幅器的天花板是
 * 0.75 / 1.05 —— 牵引侧永远够不着阈值，那一项永远不罚分，ATO 和"0.4 秒推一次
 * 手柄"拿到一样的 99 分。指标自我一致、分数照给，但它没有测量任何东西。
 * 所以这里钉三层，任何一层松掉都要报红：
 * ① 限值只许有一份：physics.js 里的字面量必须等于运行时读到的 SH.JERK，
 *    否则测试可以中途把常数改成 1e6，让"峰值不超限"永远成立；
 * ② 限值本身要站得住：地铁舒适口径就那么多，超出区间说明是"为了让测试变绿
 *    而调的数"，不是标定出来的数；
 * ③ 评分必须读同一个常数、且阈值系数 < 1：再出现写死的 0.85，就回到那个空指标。 */
{
  const gerrs = [];
  const ptxt = require('fs').readFileSync('./src/physics.js', 'utf8');
  const m = ptxt.match(/const JERK = \{([^}]*)\}/);
  /* 真实地铁 ATO 的纵向冲动舒适口径大致 0.4~1.2 m/s³（紧急制动另算） */
  const BAND = { up: [0.3, 0.9], dn: [0.5, 1.2], eb: [1.0, 2.5] };
  if (!m) gerrs.push('physics.js 里找不到 const JERK 字面量');
  else {
    const lit = {};
    for (const kv of m[1].split(',')) { const p = kv.split(':'); if (p.length === 2) lit[p[0].trim()] = parseFloat(p[1]); }
    for (const k of ['up', 'dn', 'eb']) {
      if (!(k in lit)) { gerrs.push(`const JERK 缺 ${k}`); continue; }
      if (Math.abs(lit[k] - SH.JERK[k]) > 1e-9)
        gerrs.push(`${k}：运行时 SH.JERK=${SH.JERK[k]} ≠ physics.js 字面量 ${lit[k]} —— 有人把常数改了让断言永远成立`);
      if (lit[k] < BAND[k][0] || lit[k] > BAND[k][1])
        gerrs.push(`jerk ${k}=${lit[k]} m/s³ 出界 ${BAND[k][0]}~${BAND[k][1]} —— 这是为了让测试变绿而调的数，不是地铁舒适口径`);
    }
    if (!/SH\.JERK\.(up|dn|eb)/.test(ptxt)) gerrs.push('限幅器没读 SH.JERK，改了常数也不影响物理');
  }
  const cm = src.match(/Math\.abs\(this\.tr\.jerk\) > jCap \* ([0-9.]+)/);
  if (!/const jCap = .*SH\.JERK\.up.*SH\.JERK\.dn/.test(src)) gerrs.push('平稳评分的 jerk 阈值不再由 SH.JERK 推出');
  else if (!cm) gerrs.push('平稳评分里找不到 jerk 顶格判据（comfort 项被删了？）');
  else if (!(parseFloat(cm[1]) > 0 && parseFloat(cm[1]) < 1))
    gerrs.push(`平稳评分的 jerk 阈值系数 = ${cm[1]}×限幅器：≥1 就永远够不着，又是一个空指标`);
  if (/Math\.abs\(this\.tr\.jerk\) > 0\.\d/.test(src))
    gerrs.push('game.js 里又出现了写死的 jerk 阈值（0.85 那个坑：阈值高于限幅器天花板 → 永不罚分）');
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ jerk 限幅器三重锁：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ jerk 三重锁：字面量 = 运行时 ${Object.keys(BAND).map(k => SH.JERK[k]).join('/')} m/s³ 均在舒适口径内，评分阈值 ${(cm ? parseFloat(cm[1]) * 100 : 0).toFixed(0)}% × 天花板`);
}

/* ---- ATO 需求整形的单元判据（负控翻出来的第四个坑）----
 * 把 `_shape` 换成恒等映射，test-drive 全绿：级位抖动 120→178 次/站、
 * 顶格时间 2.1%→3.9%、平稳分 88→78，全部真实退化，但**排序没变**
 * （连半自动、人工也一起变差），于是三条比较型不变量一条都不亮。
 * 只比大小的指标会被"全体一起变差"蒙过去 —— 机制本身必须直接钉：
 * ATO 对外输出的应当是"被 jerk 限幅的连续加速度需求"＋最贴近该需求的级位，
 * 而不是原始决策那个整数台阶。这里不看分数、不看排序，只看三件事：
 * ① 存在连续需求，且每帧移动量 ≤ jerk×dt；
 * ② 所选级位的标称加速度贴住需求（残差 ≤ 半个级位间距 + 迟滞）；
 * ③ 需求突变时级位是一级一级走的，不许一步从 +4 跳到 −7。 */
{
  const gerrs = [];
  const lo = 0.95, sv = 1.0;
  const accOf = n => n > 0 ? lo * (SH.PWR_FRAC[n] || 1) : n < 0 ? -sv * (SH.BRK_FRAC[-n] || 1) : 0;
  const lvl = []; for (let n = -8; n <= 4; n++) lvl.push(accOf(n));
  lvl.sort((x, y) => x - y);
  let maxGap = 0; for (let i = 1; i < lvl.length; i++) maxGap = Math.max(maxGap, lvl[i] - lvl[i - 1]);
  const a = new SH.physics.ATO('auto');
  const ctx = { perf: { accLo: lo, serv: sv } };
  const dt = 1 / 30, cap = Math.max(SH.JERK.up, SH.JERK.dn) * dt;
  let prevD = null, maxStep = 0, maxTrack = 0, maxJump = 0, prevN = null, converge = NaN;
  for (const want of [0, 1, 2, 4, 4, 3, 1, 0, -1, -4, -7, -7, -4, -1, 0]) {
    for (let i = 0; i < 30; i++) {
      const n = a._shape(dt, want, ctx);
      if (!isFinite(a.demand)) { gerrs.push('没有连续的加速度需求（demand 非有限数）—— 输出又退回整数台阶了'); break; }
      if (prevD !== null) maxStep = Math.max(maxStep, Math.abs(a.demand - prevD));
      prevD = a.demand;
      maxTrack = Math.max(maxTrack, Math.abs(accOf(n) - a.demand));
      if (prevN !== null) maxJump = Math.max(maxJump, Math.abs(n - prevN));
      prevN = n;
    }
    converge = Math.abs(a.demand - accOf(want));
  }
  if (maxStep > cap + 1e-9) gerrs.push(`需求单帧移动 ${maxStep.toFixed(4)} m/s² > jerk×dt = ${cap.toFixed(4)} —— 限幅没作用在需求上`);
  if (maxTrack > maxGap / 2 + 0.05) gerrs.push(`级位残差 ${maxTrack.toFixed(3)} m/s² 超出半个级位间距 ${(maxGap / 2).toFixed(3)} —— 反选没有跟着需求走`);
  if (maxJump > 2) gerrs.push(`需求突变时级位一步跳 ${maxJump} 档（+4 → −7 那种台阶）—— 需求整形被绕过`);
  if (!(converge < 0.02)) gerrs.push(`需求没有收敛到目标（残差 ${converge.toFixed(3)} m/s²）`);
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ ATO 需求整形：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ ATO 需求整形：连续需求每帧 ≤ ${(maxStep * 30).toFixed(2)} m/s³、级位残差 ${maxTrack.toFixed(3)} m/s²（半距 ${(maxGap / 2).toFixed(3)}）、单帧最多走 ${maxJump} 档`);
}

/* ---- 司机台圆表：针必须跟着车走 ----
 * 表针原来是一块焊死在 12 点方向的红塑料片，车速 80 也指着 0；HUD 那只电子指针
 * 又按"当前限速"当满度，两个表在同一车速下各指一边。驾驶室是玩家盯得最久的画面，
 * 这两件事车迷一眼就看穿。所以钉四条：
 * ① 表盘走独立实时纹理 'gauge'（不能塞回 4096² 站牌图集，否则针永远不动）；
 * ② 针角只许由 SH.dialDeg 算，HUD 与 3D 表同源，源码里不许再留内联的 −120+…×240；
 * ③ 量程只许由 SH.dialFull 给（磁浮 0~500、APM 0~80、80 km/h 车 0~100）；
 * ④ dialDeg 必须真的单调、能在表盘面内转出可分辨的角度差 —— 否则"接了函数"
 *    但函数写死成常数，画面同样是根死针。 */
{
  const gerrs = [];
  const gt = require('fs').readFileSync('./src/game.js', 'utf8');
  const tt = require('fs').readFileSync('./src/train.js', 'utf8');
  const rt = require('fs').readFileSync('./src/renderer.js', 'utf8');
  const ct = require('fs').readFileSync('./src/core.js', 'utf8');
  if (!/texFromCanvas\('gauge'/.test(gt)) gerrs.push("圆表没有独立纹理（找不到 texFromCanvas('gauge')）—— 针不会动");
  if (!/tex:\s*'gauge'/.test(rt)) gerrs.push("renderer 里没有 gauge 材质的纹理槽（面板会退回图集）");
  if (!/'gauge'\)/.test(tt)) gerrs.push("train.js 的表盘面板没走 gauge 材质");
  if (/-120\s*\+\s*C\([^)]*kmh[^)]*\)\s*\*\s*240/.test(gt)) gerrs.push('HUD 指针还在用内联的角度映射，和 3D 表不同源');
  /* "dialDeg 两处调用"的旧 lint 已随 HUD 速度表拆除改义 —— 见下方第 111 条块。 */
  /* ④ 行为判据：单调 + 可分辨 + 不越界 */
  const a0 = SH.dialDeg(0), a5 = SH.dialDeg(0.5), a1 = SH.dialDeg(1), aOver = SH.dialDeg(1.6);
  if (!(a0 < a5 && a5 < a1)) gerrs.push(`dialDeg 不单调：0→${a0} 0.5→${a5} 1→${a1}`);
  if (Math.abs(a1 - a0) < 180) gerrs.push(`表盘张角只有 ${(a1 - a0).toFixed(0)}°，刻度盘放不下五位读数`);
  /* 允许 15% 的过行程（真实表针在超速时会甩过最后一段刻度），但必须钳住：
     针转到表盘背面去就不是仪表而是装饰了。 */
  if (!(aOver > a1 && aOver <= 160)) gerrs.push(`超量程行为不对：满度 ${a1}°、1.6 倍 ${aOver.toFixed(0)}°（应甩过满度但不超过 160°）`);
  const fulls = Object.keys(SH.LINES).map(id => SH.dialFull(SH.LINES[id].maxKmh || 80));
  const ml = SH.dialFull(SH.LINES.ml.maxKmh || 300), ph = SH.dialFull(SH.LINES.ph.maxKmh || 60), l3 = SH.dialFull(SH.LINES.l3.maxKmh || 80);
  if (!(ml > l3 && l3 > ph)) gerrs.push(`量程排序错了：磁浮 ${ml} / 地铁 ${l3} / APM ${ph}`);
  if (fulls.some(f => f % 20)) gerrs.push('有线路的量程不是整数刻度，表盘上会出现 87 这种数字');
  if (!/dialDeg/.test(ct) || !/dialFull/.test(ct)) gerrs.push('dialDeg/dialFull 不在 core.js（单一来源破了）');
  /* HUD 那只电子速度表已拆（第 111 条：速度/缸压都在 TCMS 屏与两只机械圆表上，
     界面再做一份就是第二个真值）。表盘 lint 随之改义：不许 HUD 长出 speed-dial
     （重复信息回潮）；3D 机械表继续走 dialDeg 单源。 */
  const cs = require('fs').readFileSync('./css/ui.css', 'utf8');
  const ht = require('fs').readFileSync('./index.html', 'utf8');
  if (/content\s*:\s*"[^"]*·/.test(cs)) gerrs.push('ui.css 里还有写死的表盘量程（应改成 content:attr(data-scale)）');
  if (/id="speed-dial"/.test(ht)) gerrs.push('HUD 又长出自己的速度表 —— 与 TCMS 重复信息（第 111 条已拆）');
  if (!/SH\.dialDeg\(/.test(gt)) gerrs.push('game.js 的 gauge 绘制没接 dialDeg —— 针不会动');
  /* 首页文案与数据同源：写死的"18 条线路"和选线页的 20 张卡对不上；
     "全线接触网供电"被磁浮的 `catenary:false` 直接打脸。车迷最先读的就是这两句。 */
  if (/>\d+<\/b>条线路/.test(ht)) gerrs.push('首页线路数是写死的（应由 game.js 按 SH.LINES 数出来）');
  if (!/getElementById\('spec-lines'\)/.test(gt)) gerrs.push('game.js 没有把线路数写回首页');
  if (/全线接触网/.test(ht)) gerrs.push('首页写着"全线接触网供电"，而磁浮按长定子（catenary:false）建模 —— 文案和几何互相打脸');
  /* 屏上的抬头不许出现重复词：磁浮的线路名与车型名**本来就叫同一个名字**（"磁浮"），
     所以这是数据的事实、不是 bug；bug 是"两段文字直接相加"把它印成"磁浮 磁浮 6M"。
     判据因此是两条：① 表头那一行必须做同名去重；② 必须真的存在同名线路，
     否则第 ① 条就成了守着空房的锁。 */
  if (!/stock\.type === L\.name/.test(gt)) gerrs.push('game.js 的表头没有做同名去重（磁浮会印成"磁浮 磁浮 6M"）');
  /* 构造顺序 lint：`_profile()` 里读到的 `this.X` 必须在 `this.profile = this._profile()`
     之前就已经赋值。磁浮的涂装与断面全靠 `profile.maglev`，而 `this.maglev` 曾经
     排在 profile 之后 —— 于是 profile 里读到 undefined，磁浮一直穿着地铁的灰腰带、
     用着地铁的方箱断面，**没有任何一条判据报红**（读一个还没赋值的字段是静默的）。 */
  {
    const ci = gt.indexOf('class LineRuntime'), cb = gt.indexOf('constructor(', ci);
    const cEnd = gt.indexOf('\n  }', cb), ctor = gt.slice(cb, cEnd);
    const pi = ctor.indexOf('this.profile = this._profile()');
    if (pi < 0) gerrs.push('找不到 this.profile = this._profile()，构造顺序判据需要跟着改');
    else {
      const p0 = gt.indexOf('_profile() {'), p1 = gt.indexOf('\n  }', p0);
      const body = gt.slice(p0, p1);
      const reads = new Set((body.match(/this\.[a-zA-Z_$][\w$]*/g) || []).map(s => s.slice(5)));
      const late = [...reads].filter(k => {
        const a = ctor.indexOf('this.' + k + ' =');
        return a >= 0 && a > pi;
      });
      if (late.length) gerrs.push('LineRuntime 构造顺序错：_profile() 读了 ' + late.join('/') + '，但它们在 profile 之后才赋值（读到 undefined）');
    }
  }
  if (!Object.keys(SH.LINES).some(id => (SH.STOCK[SH.LINES[id].stock] || {}).type === SH.LINES[id].name))
    gerrs.push('去重判据守着空房：没有任何线路的车型名与线路名相同，这条断言已经不需要了');
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ 司机台圆表：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ 司机台圆表：${(SH.dialDeg(1) - SH.dialDeg(0)).toFixed(0)}° 张角单调映射、HUD 与机械表同源；量程 磁浮 ${ml} / 地铁 ${l3} / APM ${ph} km/h，独立纹理 'gauge' 一次上传两只表`);
}

/* ---- 支线交路：站名要有出处、尾巴换了但隧道是同一条 ----
 * 5/10/11 号线的支线以前只写在 `_note` 的一句话里，玩家永远看不见。
 * 现在它是可选交路，于是三件事必须钉住：
 * ① 支线站序必须与 `_note` 逐字一致 —— 站表是"照官方图抄"抄出来的，
 *    任何一处支线站名改动都要先在图上找到依据，不许顺手编；
 * ② 分岔站之前每一站里程与主线完全相同（同一 seed、同一"站名对"生成的站间距、
 *    同一批跨江点）。做不到这一点，就说明支线被当成了另一条线在重铺；
 * ③ 终点站屏/报站读的终点站必须随交路改变，而主线终点站一个字都不许变。 */
{
  const gerrs = [];
  let nsvc = 0;
  for (const id of Object.keys(SH.LINES)) {
    const d = SH.LINES[id];
    if (!d.branch) continue;
    nsvc++;
    const m = new LineRuntime(d), b = new LineRuntime(d, 'branch');
    const at = d.stations.indexOf(d.branch.at);
    if (at < 1) gerrs.push(`${d.name} branch.at「${d.branch.at}」不在主线站表里`);
    const seq = d.branch.stations.join('—');
    if ((d._note || '').indexOf(seq) < 0)
      gerrs.push(`${d.name} 支线站序「${seq}」与 _note 不一致（站名只能照 D202512 图抄，不能编）`);
    if (b.stations.length !== at + 1 + d.branch.stations.length) gerrs.push(`${d.name} 支线站表长度不对`);
    if (b.terminus !== d.branch.stations[d.branch.stations.length - 1]) gerrs.push(`${d.name} 支线终点站不是 ${b.terminus}`);
    if (m.terminus !== d.stations[d.stations.length - 1]) gerrs.push(`${d.name} 主线终点站被改动了`);
    if (b.id === m.id) gerrs.push(`${d.name} 支线与主线共用一个 id（站牌/目的地屏会互相覆盖）`);
    let drift = 0;
    for (let i = 0; i <= at; i++) drift = Math.max(drift, Math.abs(m.al.stationS[i] - b.al.stationS[i]));
    if (!(drift < 1e-6)) gerrs.push(`${d.name} 支线在分岔站之前与主线差 ${drift.toFixed(3)} m —— 同一条隧道必须逐站重合`);
    if (b.depotZones().length !== 2) gerrs.push(`${d.name} 支线两端基地数量 ${b.depotZones().length} ≠ 2`);
    /* 支线跑一局：必须真能结算，停车精度与主线同一指标 */
    const s = new Session(app); app.ato = new SH.physics.ATO('auto');
    s.start(b, 'auto', Math.max(0, at - 2), 3);
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 900 && s.phase !== 'finished'; i++) {
      if (s.phase === 'stopped' && !s.doors && !s._committed) s.openDoors();
      if (s.doors && s.dwell > s.dwellNeed()) s.closeDoors();
      s.update(dt);
    }
    if (s.phase !== 'finished') gerrs.push(`${d.name} 支线跑不完一局`);
    else {
      const w = Math.max(...s.results.map(r => Math.abs(r.err)));
      if (w > 0.60) gerrs.push(`${d.name} 支线停车误差 ${w.toFixed(2)} m 超指标`);
    }
  }
  if (nsvc !== 3) gerrs.push(`有支线的线路 ${nsvc} 条，应为 3（5/10/11 号线）`);
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ 支线交路：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ 支线交路：${nsvc} 条线的支线站序与 _note 逐字一致、分岔站前与主线逐站重合、终点屏随交路改变、支线各跑通一局`);
}

/* ---- ATO 的"级位→加速度"映射必须带载荷 ----
 * 物理侧一直知道车有多重（`loadK = 1/clamp(load)`），而 `_shape` 把级位换算成
 * 名义加速度时用的是**规格减速度**，等于假设车永远是空的。第 79 条把开局车载
 * 做实之后这个不一致就会显形：满载时同样的级位给不出规划中的制动力。
 * 断言形式：同一个 ctx、只有载荷不同，超员那一版必须选出**不更松**的级位，
 * 而且至少有一档真的更紧 —— 否则 `loadK` 这一项就是装饰。 */
{
  const perf = SH.LINES.l1.perf;
  const ctxOf2 = (load) => ({ distanceToStop: 260, speedKmh: 62, limitKmh: 70, grade: 0,
    curveK: 0, curveLimit: 70, predictStop: 200, perf, load });
  const light = new SH.physics.ATO('auto'), heavy = new SH.physics.ATO('auto');
  let sumL = 0, sumH = 0, stricter = 0, worse = 0;
  for (let i = 0; i < 80; i++) {
    const nl = light.notch(1 / 30, ctxOf2(1.0));
    const nh = heavy.notch(1 / 30, ctxOf2(1.32));
    if (nl == null || nh == null) continue;
    sumL += nl; sumH += nh;
    if (nh < nl) stricter++;
    if (nh > nl) worse++;
  }
  if (worse) { bad++; console.log(`     ✗ ATO 级位映射带载荷后反而在超员时给更松的指令（${worse} 帧）`); }
  else if (!stricter) { bad++; console.log('     ✗ 空车与超员选出的级位完全相同 —— `_shape` 里的 loadK 什么都没改变（物理知道车重，ATO 不知道）'); }
  else console.log(`✓ ATO 级位→加速度按载荷折算：超员工况 ${stricter}/80 帧给出更紧的制动手柄（平均 ${sumL / 80} → ${sumH / 80}）`);
}

/* ---- 图定时刻表：可兑现，而且真的在记分 ----
 * 一张"跑不到"的运行图比没有运行图更糟：它会让玩家永远晚点，
 * 而那个扣分看起来像惩罚，实际上什么都没测量。所以判据先验证
 * 自动模式能贴着这张表跑完，再验证晚点确实随停站时长累积。 */
{
  const terr = [];
  const line = new LineRuntime(SH.LINES.l1);
  const tb = SH.timetable(line);
  const d = new SH.traffic.Dispatcher(line, {});
  if (tb.length !== line.stations.length) terr.push(`时刻表 ${tb.length} 项，本站表 ${line.stations.length} 站`);
  let mono = true;
  for (let i = 1; i < tb.length; i++) if (!(tb[i] > tb[i - 1] + 25)) mono = false;
  if (!mono) terr.push('时刻表不是严格递增（每站至少要多于 25 s）—— 多半是某个跨段算出了 0 运行时分');
  /* 与配车数同源：`_vAvg` 用的就是同一份逐段模型，两者必须给出同一个旅行速度 */
  const dist = line.al.stationS[line.stations.length - 1] - line.al.stationS[0];
  const vFromTb = dist / tb[tb.length - 1] * 3.6;
  if (Math.abs(vFromTb - d.vAvg * 3.6) > 0.6)
    terr.push(`时刻表反推旅行速度 ${vFromTb.toFixed(1)} 与配车用的 ${(d.vAvg * 3.6).toFixed(1)} km/h 不一致 —— 运行时分有两个版本`);
  /* 可兑现：全自动贴着这张表跑，每站晚点都要在容差内 */
  const s = new Session(app); app.ato = new SH.physics.ATO('auto');
  s.start(line, 'auto', 1, 5);
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 1400 && s.phase !== 'finished'; i++) { s.update(dt); }
  if (s.results.length < 4) terr.push(`自动模式只跑了 ${s.results.length} 站，判不了晚点（预算不够或车根本没动）`);
  for (const r of s.results) {
    if (typeof r.late !== 'number' || !isFinite(r.late)) { terr.push('结算单子里的 late 不是有限数'); break; }
    if (Math.abs(r.late) > 90) { terr.push(`${r.station} 晚点 ${Math.round(r.late)} s —— 这张图定表跑不到，扣分是在乱扣`); break; }
  }
  /* 晚点必须随"多停"累积：Δlate 与 (实际停站 − 图定 30 s) 同量级 */
  for (let i = 1; i < s.results.length; i++) {
    const dl = s.results[i].late - s.results[i - 1].late;
    if (Math.abs(dl - (s.results[i - 1].dwell - SH.SCHED_DWELL)) > 60)
      terr.push(`第 ${i} 段晚点变化 ${dl.toFixed(0)} s 与停站偏差 ${(s.results[i - 1].dwell - SH.SCHED_DWELL).toFixed(0)} s 差太远（>60 s）`);
  }
  if (s.results.length && s.results.every(r => r.late === 0)) terr.push('每一站 late 都恰好是 0 —— 这个字段没在测量任何东西');
  /* 扣分本身要有表可查：不测它，`latePenalty` 退回恒等于 0 也照样全绿
     （晚点照记、分数照给，那是一条空指标） */
  const lp = [[0, 0], [14, 0], [15, 0], [30, 2], [60, 6], [165, 20], [600, 20]];
  for (const [x, want] of lp) if (SH.latePenalty(x) !== want) terr.push(`latePenalty(${x}) = ${SH.latePenalty(x)}，应为 ${want}`);
  if (terr.length) { bad += terr.length; terr.forEach(m => console.log('     ✗ 图定：' + m)); }
  else console.log(`✓ 图定运行图：${tb.length} 站、全程 ${(tb[tb.length - 1] / 60).toFixed(1)} min，自动模式贴着表跑完（最大晚点 ${Math.round(Math.max(...s.results.map(r => Math.abs(r.late))))} s），晚点随停站时长累积并进结算`);
}

/* ---- 图定 × 邻线列车：两个一起开的时候还跑得完吗 ----
 * 上面那条图定判据是在**没有邻线列车**的 app 桩上量的（`app.traffic` 为空），
 * 而游戏里两者同时开着：ATO 的停车目标会被红灯信号机收到"分区入口"，
 * 于是司机会被扣在站外，晚点开始累积。浏览器实拍里出现过 765 s ——
 * 那一次是因为探针只推进了玩家时钟、没推进车队（AI 全冻住），属于探针的错；
 * 但"两个子系统一起开"这件事确实一条判据都没覆盖过。
 * 门槛取"累计晚点不超过一个头时距 + 一站停站"：被信号扣住是常态，
 * 但扣到超过一个间隔就说明这张图与这套调度不能同时成立。 */
{
  const inter = [];
  const line = new LineRuntime(SH.LINES.l2);
  const disp = new SH.traffic.Dispatcher(line, {});
  const prevTr = app.traffic;
  app.traffic = disp;
  try {
    const s = new Session(app); app.ato = new SH.physics.ATO('auto');
    s.start(line, 'auto', 6, 3);
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 1500 && s.phase !== 'finished'; i++) {
      disp.playerS = s.s; disp.update(dt); s.update(dt);
    }
    const head = disp.headwayMin * 60;
    const worst = s.results.length ? Math.max(...s.results.map(r => r.late)) : NaN;
    if (s.results.length < 3) inter.push(`邻线列车全开的自动局只完成 ${s.results.length}/3 段（跑 ${Math.round(s.t)} s）—— 被扣死在路上`);
    if (isFinite(worst) && worst > head + SH.SCHED_DWELL)
      inter.push(`邻线列车全开时最大晚点 ${Math.round(worst)} s，超过一个头时距 + 停站（${head + SH.SCHED_DWELL} s）—— 图定与调度不能同时成立`);
    if (s.spad) inter.push(`邻线列车全开时自动模式冒进 ${s.spad} 次`);
    if (!inter.length) console.log(`✓ 图定 × 邻线列车：${disp.n} 列同时在跑，自动模式 3 段全部完成，最大晚点 ${Math.round(worst)} s（门槛 ${head + SH.SCHED_DWELL} s），0 冒进`);
  } finally {
    app.traffic = prevTr;
    app.ato = new SH.physics.ATO('auto');
  }
  if (inter.length) { bad += inter.length; inter.forEach(m => console.log('     ✗ ' + m)); }
}

/* ---- 冒进信号（SPAD）：红灯必须有约束力 ----
 * 两边都要测：只测"自动模式不冒进"，那么把检测整个删掉也照样绿；
 * 只测"人工能抓到"，那么自动模式天天冒进也没人知道。 */
{
  const serr = [];
  const line = new LineRuntime(SH.LINES.l2);
  const disp = new SH.traffic.Dispatcher(line, {});
  const prevTr = app.traffic;
  app.traffic = disp;
  let autoOK = true;
  try {
    /* A. 全自动整局不许冒进 —— 这一条测的是"ATO 有没有把红灯当停车目标"。
       半自动不测：接管之后的司机是测试自己写的模拟司机，它只看得到站停标，
       看不见信号机就会冒进 —— 那是判据的司机不合格，不是模型的错。 */
    const s = new Session(app); app.ato = new SH.physics.ATO('auto');
    s.start(line, 'auto', 2, 3);
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 700 && s.phase !== 'finished'; i++) {
      disp.playerS = s.s; disp.update(dt); s.update(dt);
    }
    if (!s.results.length) { serr.push('auto 模式整局没有结算条目 —— 这一条其实是空测'); autoOK = false; }
    if (s.spad) { serr.push(`auto 模式整局冒进 ${s.spad} 次：ATO 的停车目标没把红灯算进去`); autoOK = false; }
    /* B. 人工硬冲必须抓到：把一列车停在玩家前方第二个分区里，全速推过去 */
    const s2 = new Session(app); app.ato = new SH.physics.ATO('manual');
    s2.start(line, 'manual', 2, 1);
    s2.depart();
    disp.trains.length = 1;
    const t = disp.trains[0];
    /* 把一列车摆在玩家前方**第二格**的分区里（blocks 表是按站间均分的边界表，
       不是从里程 0 起的整数格 —— 所以要找玩家后面第 2 个分区入口）。 */
    const B = disp.blocks;
    let k0 = B.findIndex(b => b[0] > s2.s + 150);
    if (k0 < 0) k0 = B.length - 1;
    const b0 = B[Math.min(k0 + 1, B.length - 1)][0];
    t.s = b0 + (B[Math.min(k0 + 1, B.length - 1)][1] - B[Math.min(k0 + 1, B.length - 1)][0]) * 0.5;
    t.tr.s = t.s; t.tr.v = 0;
    if (disp.aspectAt(Math.min(k0 + 1, B.length - 1), 'player').key !== 'stop') serr.push('构造失败：前方分区停了一列车，那道边界却不是红灯（判据自己没搭好台）');
    let guard = 0, rec = null;
    /* 冲过红灯之后撤掉那列车，再让模拟司机把车停进站台 ——
       `_commit()` 是在 openDoors() 里调的，不到站开门就取不到结算单子。 */
    const driver = new SH.physics.ATO('auto');
    while (!rec && guard++ < 30 * 400) {
      if (!s2.spad) s2.tr.setNotch(4);
      else if (s2.canManual() && guard % 12 === 0) { const n = driver._decide(ctxOf(s2)); if (n !== null) s2.tr.setNotch(n); }
      if (s2.spad && disp.trains.length) disp.trains.length = 0;
      if (s2.phase === 'stopped' && !s2.doors) s2.openDoors();
      s2.update(1 / 30);
      rec = s2.results.find(r => r.spad !== undefined) || null;
    }
    if (!s2.spad) serr.push('人工全速冲过红灯，`spad` 仍然是 0 —— 检测根本没接上进行中的行车');
    if (!rec) serr.push(`人工硬冲跑了 ${Math.round(guard / 30)} s 也没到站（跑动里程 ${Math.round(s2.s)} m），取不到结算单子`);
    else if (!rec.spad) serr.push(`冒进发生了（spad=${s2.spad}）但没记进这一段的结算单子（rec.spad=${rec.spad}）`);
    else {
      const want = Math.max(0, Math.round(rec.jP * 0.55 + rec.smooth * 0.15 + 100 * 0.30)
        - 25 * rec.spad - SH.latePenalty(rec.late || 0));
      if (rec.score !== want) serr.push(`结算分数没扣冒进：应为 ${want}，实得 ${rec.score}`);
      else console.log(`✓ 冒进信号：人工冲过 ${Math.round(b0)} m 处红灯被抓到（本段 −25 分，实得 ${rec.score}）`);
    }
    if (autoOK && !serr.length) console.log('  自动/半自动整局 0 冒进：分区入口就是停车目标，与 AI 车同一条限界');
  } finally {
    app.traffic = prevTr;
    app.ato = new SH.physics.ATO('auto');
  }
  if (serr.length) { bad += serr.length; serr.forEach(m => console.log('     ✗ ' + m)); }
}

/* ---- 三腿短局在高峰必须真的挤（开局车载由模型算，见第 79 条）----
 * 这条测的是"玩法接触度"：客流模型跑满一条线能到 130% 满载、甩客几百人，
 * 但如果玩家从起点站只跑三站就结束，他看到的是空车 —— 那 30% 的客运权重
 * 就永远在给他发 100 分。所以断言：从内段站上车跑三站，必须出现满载或甩客。 */
{
  const line = new LineRuntime(SH.LINES.l2);
  const s = new Session(app); app.ato = new SH.physics.ATO('auto');
  s.hour = 8;
  s.start(line, 'auto', 12, 3);
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 900 && s.phase !== 'finished'; i++) s.update(dt);
  const peak = Math.max(...s.results.map(r => r.load || 0), s.pax.pct());
  const left = s.results.reduce((a, r) => a + Math.max(0, r.want - r.on - r.off), 0) + (s.pax.leftBehind || 0);
  if (s.pax.boarded <= 0) { bad++; console.log('     ✗ 三腿短局一个上客都没有 —— 开局预跑把站台清空了'); }
  else if (peak < 90 && left <= 0) { bad++; console.log(`     ✗ 早高峰从内段站跑三站：满载 ${peak}%、甩客 ${left} —— 玩家还是接触不到那个断面`); }
  else console.log(`✓ 开局车载由模型算：早高峰从 ${line.stations[12]} 上车，三腿短局里满载峰值 ${peak}%、甩客 ${left} 人，客运分真的在扣`);
}

/* ---- 过站不拦开门（用户第 7 项的后半段）----
 * 以前错位 > 5.5 m 直接 return 不给开门，等于一次失误罚两次：停车分已经扣过了，
 * 还不让你作业。谁要是把这层"保护"加回去，这一条就报红。 */
{
  const line = new LineRuntime(SH.LINES.l3);
  const s = new Session(app); app.ato = new SH.physics.ATO('manual');
  s.start(line, 'manual', 2, 3);
  s.tr.reset(); s.s = s.targetS + 18; s.tr.s = s.s; s.phase = 'stopped';
  s.openDoors();
  if (!s.doors) { bad++; console.log('     ✗ 冲标 18 m 仍被禁止开门 —— "过站就过站了"这条要求被改回去了'); }
  else console.log('✓ 冲标 18 m 照样开门（只提示不拦，代价由停车分承担）');
}

/* ---- 停车基地必须是"露天"的（看图看出来的，不是推理出来的）----
 * 基地既不在 elevated 区间、也不是车站，`openness()` 一返回 0，envFor 就把
 * 隧道那套（雾 0.0112 / 环境光 0.085 / 远裁剪 900）盖上来 —— 司机台开进库
 * 实测是一片黑，只有高杆灯亮着，停车线、车挡、库房全看不见。 */
{
  const gerrs = [];
  let zones = 0;
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    const zs = line.depotZones();
    if (zs.length !== 2) gerrs.push(`${line.name} 只有 ${zs.length} 处基地（两端各一处）`);
    for (const z of zs) {
      zones++;
      for (let s = z.from + 20; s < z.to - 20; s += 40) {
        if (line.openness(s) < 0.999) { gerrs.push(`${line.name} 基地 ${Math.round(s)} m 处 openness=${line.openness(s).toFixed(2)}`); break; }
        if (!line.isElevated(s) && line.depotAtS(s) === null) { gerrs.push(`${line.name} 基地内 ${Math.round(s)} m 处 depotAtS 失效`); break; }
      }
      if (line.limitAt(z.mark) > 25) gerrs.push(`${line.name} 库内限速 ${line.limitAt(z.mark)} > 25`);
    }
  }
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ 停车基地：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ 停车基地：20 条线 ${zones} 处全部按露天处理，库内限速 25 km/h`);
}

/* ---- UTO 全自动运行：名单要对，RM 限速要真的落进机制 ----
 * 把 driverless 改名成 uto 不是文字替换就完事：任何一处还在读旧字段的地方都会
 * 静默变成 undefined —— 相机偏移退回"有司机隔间"的站位、走字屏永远不挂标签，
 * 画面和文案同时骗人，而且没有一行代码会报错。所以这里两头都钉：
 * 行为上查限速，源码上查残留字段名。 */
{
  const gerrs = [];
  const want = ['l10', 'l14', 'l15', 'l18', 'ph'];
  const got = [];
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    if (line.uto) got.push(id);
    /* 取第二个站的站心：必在直线上，进站限速 40 稳定可比，不受曲线限速抖动影响 */
    const cs = line.al.stationS[1];
    const ai = line.limitAt(cs);                    // AI 列车与自动运行：不给第二个参数
    const rm = line.limitAt(cs, 'manual');
    if (line.uto) {
      if (rm > 25) gerrs.push(`${line.name} UTO 线人工接管 ${rm} km/h —— RM 没落地`);
      if (ai <= 25) gerrs.push(`${line.name} UTO 线自动运行被 RM 误伤：${ai} km/h`);
    } else if (rm !== ai) {
      gerrs.push(`${line.name} 非 UTO 线人工驾驶被压到 ${rm}（有人开车的线不该有 RM）`);
    }
  }
  if (got.slice().sort().join() !== want.join()) gerrs.push(`UTO 名单 = ${got.join('/') || '空'}，应为 ${want.join('/')}`);
  for (const f of ['./src/game.js', './src/world.js', './src/traffic.js', './data/shanghai.js', './index.html']) {
    const txt = require('fs').readFileSync(f, 'utf8');
    if (txt.includes('driverless')) gerrs.push(`${f} 仍在读已改名的字段 driverless`);
  }
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ UTO：' + gerrs.slice(0, 5).join(' ; ')); }
  else console.log(`✓ UTO：${want.map(i => SH.LINES[i].name).join('/')} 共 5 条，人工接管 RM ${new LineRuntime(SH.LINES.l15).limitAt(new LineRuntime(SH.LINES.l15).al.stationS[1], 'manual')} km/h、自动 ${new LineRuntime(SH.LINES.l15).limitAt(new LineRuntime(SH.LINES.l15).al.stationS[1])} km/h，其余 15 条不受限，源码无 driverless 残留`);
}

/* ---- 高架站横断面：棚罩台、灯在棚下、栏在台上 ----
 * 俯瞰机位翻出来的：雨棚的截面 x 没带 side 符号（`rectProfile` 要求 x0<x1，
 * 只能平移区间不能反向），路径又写在 `side*(PLAT_FRONT+3.2)`，于是 side=+1 的
 * 那半车站台上空无一物，檐口梁、立柱、两排灯带整体偏出站台外 3 m 悬在空气里。
 * 这类"只有一半车站错"的缺陷最难看出来，所以把横断面收成 SH.STATION_X 一处，
 * 再按关系断言（不写绝对数，改了常数也不会假红）。 */
{
  const gerrs = [];
  const X = SH.STATION_X;
  if (!X) gerrs.push('SH.STATION_X 不存在（横向尺寸又散回字面量了）');
  else {
    if (!(X.canopyIn >= X.front && X.canopyOut >= X.outer))
      gerrs.push(`雨棚没罩住站台：棚 ${X.canopyIn}~${X.canopyOut} m，站台 ${X.front}~${X.outer} m`);
    if (X.canopyIn > X.front + 1.2) gerrs.push('雨棚内缘退到 1.2 m 以外，下车那一侧的人淋雨');
    if (X.rail > X.outer) gerrs.push(`站台护栏在横向 ${X.rail} m，而站台外缘只有 ${X.outer} m —— 栏板悬在桥面上`);
    for (const o of X.lamps) if (!(o >= X.canopyIn && o <= X.canopyOut))
      gerrs.push(`灯带 ${o} m 不在棚下（${X.canopyIn}~${X.canopyOut}）—— 露天站就是两根悬浮的白刀`);
    if (!(X.psd > X.front - 0.5 && X.psd < X.canopyIn)) gerrs.push('屏蔽门框与棚内缘的相对关系不对');
  }
  const wtxt = require('fs').readFileSync('./src/world.js', 'utf8')
    .split('\n').filter(l => !/^\s*[*/]/.test(l)).join('\n');      // 注释里提这些数字不算违规
  if (!/rectProfile\(ceilLo > 0 \? 0 : -ceilW[^)]*\)/.test(wtxt))
    gerrs.push('吊顶截面的 x 又写回无符号了 —— 只有一侧车站的棚子是对的（必须按站体符号平移区间）');
  if (/PLAT_FRONT \+ (5\.[0-9]|4\.[69])/.test(wtxt))
    gerrs.push('world.js 里还有 `PLAT_FRONT + 4.6/4.9/5.x` 这类散写偏移，应走 SH.STATION_X');
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ 高架站横断面：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ 高架站横断面：站台 ${X.front}~${X.outer} m，雨棚 ${X.canopyIn.toFixed(2)}~${X.canopyOut} m 全罩，护栏 ${X.rail} m 在台上，两排灯 ${X.lamps.join('/')} m 都在棚下`);
}

/* ---- 街面基准与楼群限界：两条"常数被抄来抄去"换来的不变量 ----
 * 这一轮在 street（行人）机位翻出的两个缺陷同源：
 * ① 街面 −10.9 以字面量写在 world.js 三处，而跟随相机的远景地面与全部楼群
 *    用的是 `al.groundY(s) − 11` —— 一个是局部轨面、一个是平滑轨面，
 *    实测最多差 3.5 m，差过 0.4 m 那张平面就把整条街连标线一起盖掉；
 * ② 楼群最近一条车道在横向 28 m（占到 22~34），而车行道是 ±55 m ——
 *    **楼直接站在马路上**，从 11 m 高的驾驶室看不出来，只有行人高度看得出来。
 * 所以这里钉两件事：常数只许有一处，楼脚不许进车行道。 */
{
  const gerrs = [];
  const fs = require('fs');
  for (const f of fs.readdirSync('./src')) {
    if (!f.endsWith('.js') || f === 'core.js') continue;      // core.js 是唯一定义处
    const txt = fs.readFileSync('./src/' + f, 'utf8');
    const hits = txt.match(/-10\.9\b/g);
    if (hits) gerrs.push(`src/${f} 有 ${hits.length} 处硬写 -10.9，应改走 al.streetDy(s)`);
    if (/groundY\([^)]*\)\s*-\s*11(\.3)?\b/.test(txt))
      gerrs.push(`src/${f} 自己拿 groundY 减常数当街面用（应写成 groundY + SH.STREET_Y − 余量）`);
  }
  const B = SH.CITY_BAND;
  if (B.corridor < 55) gerrs.push(`空廊只有 ${B.corridor.toFixed(1)} m，而车行道到 ±55 m —— 楼会站到马路上`);
  /* 司机台 TCMS 必须用自己的纹理：站牌图集是 4096²，而这块屏要按列车状态刷新，
     两者共用一张纹理就等于要么屏永远不变、要么每帧重传 64 MB。 */
  if (!/texFromCanvas\('cab'/.test(src)) gerrs.push('TCMS 屏没有独立纹理（找不到 texFromCanvas cab）');
  if (/add\('tcms'/.test(src)) gerrs.push('TCMS 又被塞回站牌图集里了');
  if (!/'cab'\s*\)/.test(require('fs').readFileSync('./src/train.js', 'utf8')))
    gerrs.push('司机台屏面板没走 cab 材质（会退回图集）');
  for (const ln of B.lanes) if (ln.c - B.depth < 55) gerrs.push(`横向 ${ln.c} m 那条楼道的楼脚（${(ln.c - B.depth).toFixed(1)} m）伸进车行道`);
  if (!isFinite(SH.cityRoofAt(B.lanes[0].c))) gerrs.push('SH.cityRoofAt 读不到楼群限高，通视判据会退化成"永远通视"');
  if (gerrs.length) { bad += gerrs.length; console.log('     ✗ 街面/楼群不变量：' + gerrs.slice(0, 4).join(' ; ')); }
  else console.log(`✓ 街面基准单一来源（只有 core.js 写着 −10.9）；空廊 ${B.corridor.toFixed(1)} m ≥ 车行道 ±55 m，楼心 ${B.lanes.map(l => l.c).join('/')} m，屋脊 ${B.roof.toFixed(1)} / ${B.roofLo.toFixed(1)} m 两档`);
}

/* ---- 连续驾驶的"意图不被回写"回归 ----
 * 用户报"选了全程结果只跑一站"：根因是 App.begin() 里 `app.legs = C(app.legs, 1, 剩余)`
 * 把 99 就地钳成实际值，又被 saveSettings 写进 localStorage，于是"全程"永久丢失。
 * 现在规则搬到 SH.legsPlan，只允许读。这一节钉住三件事：全程等于"到终点"、
 * 靠近终点时确实只剩一两站但意图仍是 99、以及**重复调用不会自我衰减**。 */
{
  const p = (i, s, n) => SH.legsPlan(i, s, n);
  const chk = [];
  if (p(99, 0, 28).run !== 27) chk.push('1 号线从 莘庄 全程应为 27 段，实为 ' + p(99, 0, 28).run);
  if (p(99, 26, 28).run !== 1) chk.push('倒数第二站出发全程应为 1 段，实为 ' + p(99, 26, 28).run);
  if (p(99, 26, 28).intent !== 99) chk.push('legsPlan 改动了 intent —— 又变成回写了');
  if (p(p(99, 26, 28).intent, 0, 28).run !== 27) chk.push('跑完一局后换到起点，全程回不来了');
  if (p(3, 26, 28).run !== 1) chk.push('选 3 段但只剩 1 段时应给 1，实为 ' + p(3, 26, 28).run);
  if (p(99, 0, 2).run !== 1) chk.push('磁浮（2 站）全程应为 1 段');
  if (p(0, 0, 28).run !== 1) chk.push('段数为 0/undefined 时必须退化成 1 段，不能是 0');
  if (chk.length) { bad += chk.length; console.log('     ✗ 全程/段数：' + chk.join(' ; ')); }
  else console.log('✓ 全程 = 到终点的实际段数，且意图永不被回写（莘庄全程 27 段 / 倒数第二站 1 段）');
}

/* ---- 驾驶室相机：乘坐感 = 南京版逻辑（第 111 条补记 111f）----
   玩家四轮反馈后照南京版重写（njmetro 深度拆解 5.3）：**纯低频平移**
   （sway 2 cm / heave 8 mm，0.37/0.78 Hz）、无旋转、FOV 固定 74、
   acc 俯仰系数 0.003（= 南京 target.y −= acc·0.12 在 40 m 视距的等效角）。
   旋转对远处位移被距离放大、FOV 拉伸让整幅画面呼吸缩放 —— 都是
   "抖动/移动/重影"的来源，已全部移除。钉四件事：
   ① 平移晃动真的加在眼睛上（shake=0.01 → |Δeye| ≈ 0.0117，含 0.6 倍纵向）；
   ② FOV 恒 74（不随任何量变）；
   ③ acc 俯仰仍在（acc=2 → ≈6 mrad）；
   ④ 接线 lint：南京参数在位（0.020 / sin(t·2.3)）、acc 吃 _accSm。 */
{
  const grabFn = (name) => { const i = src.indexOf('function ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
  const cabShot = eval('(' + grabFn('cabShot') + ')');
  const line = new LineRuntime(SH.LINES.l2);
  const S2 = line.stationSAt(4) + 400;
  const mk = over => cabShot(line, S2, Object.assign({ yaw: 0, pitch: 0, acc: 0, shake: 0, shakeYaw: 0, shakePit: 0 }, over));
  const dirOf = c => { const d = [c.target[0] - c.eye[0], c.target[1] - c.eye[1], c.target[2] - c.eye[2]]; const l = Math.hypot(d[0], d[1], d[2]); return d.map(x => x / l); };
  const angOf = (a, b) => { const x = dirOf(a), y = dirOf(b); return Math.acos(Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2])); };
  const base = mk({});
  const dEye = (ov, ref) => { const c = mk(ov); return Math.hypot(c.eye[0] - ref.eye[0], c.eye[1] - ref.eye[1], c.eye[2] - ref.eye[2]); };
  const dS = dEye({ shake: 0.01 }, base), dH = dEye({ heave: 0.008 }, base);
  if (!(dS > 0.0095 && dS < 0.0105)) { bad++; console.log(`✗ 横移晃动没加在眼睛上（shake 0.01 → |Δeye| ${(dS * 1000).toFixed(1)} mm，应 ≈10）—— 南京式乘坐感失效`); }
  else console.log(`✓ 南京式横移晃动真的加在眼睛上（shake 0.01 → |Δeye| ${(dS * 1000).toFixed(1)} mm）`);
  if (!(dH > 0.0075 && dH < 0.0085)) { bad++; console.log(`✗ 垂向浮沉没加在眼睛上（heave 0.008 → |Δeye| ${(dH * 1000).toFixed(1)} mm，应 ≈8）`); }
  else console.log(`✓ 南京式垂向浮沉真的加在眼睛上（heave 0.008 → |Δeye| ${(dH * 1000).toFixed(1)} mm）`);
  if (base.fov !== 74) { bad++; console.log(`✗ FOV 不是固定的 74（实得 ${base.fov}）—— 随速拉伸的呼吸缩放回潮`); }
  else console.log('✓ FOV 固定 74（南京版同款：不拉伸，画面不呼吸缩放）');
  const aAcc = angOf(base, mk({ acc: 2 }));
  if (!(aAcc > 0.004 && aAcc < 0.008)) { bad++; console.log(`✗ 视野俯仰没按南京系数吃纵向加速度（acc 2 → ${(aAcc * 1000).toFixed(1)} mrad，应 ≈6）`); }
  else console.log('✓ 视野俯仰吃（平滑过的）纵向加速度（南京系数 0.003）');
  if (!/sin\(this\.time \* 2\.3\) \* sp \* 0\.020/.test(src) || !/Math\.sin\(this\.time \* 4\.9\) \* sp \* 0\.008/.test(src)) { bad++; console.log('✗ 南京版乘坐感参数不在位（sway 2 cm / heave 8 mm）—— 又退回自编摇动'); }
  if (!/this\._accSm/.test(src)) { bad++; console.log('✗ 没有 _accSm —— 级位换挡的加速阶跃又直接砸在视野上'); }
  /* ④ 司机室与视线刚性绑定（第 111 条补记：仪表屏别抖、车晃正常）：
     S = V(抖)⁻¹·V(不抖)，台面一点 q 经 S 后在抖动相机里的相机坐标必须
     == 不抖相机的相机坐标；同时验"没有 S 时两者确实差出可见量"（判据空转自检），
     以及接线：相机要算出 _cabFix、司机室批次绘制要预乘 FIX。 */
  {
    const V0 = SH.m4lookAt(base.eye, base.target, base.up);
    const cShake = mk({ shake: 0.01, shakeYaw: 0.01, shakePit: 0.008, acc: 1.5 });
    const V1 = SH.m4lookAt(cShake.eye, cShake.target, cShake.up);
    const S = SH.cabFixMatrix(base, cShake);
    const d0 = dirOf(base);
    const q = [base.eye[0] + d0[0] * 1.2, base.eye[1] + d0[1] * 1.2, base.eye[2] + d0[2] * 1.2];
    const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
                          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
                          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    const ref = xf(V0, q), fixed = xf(V1, xf(S, q)), bare = xf(V1, q);
    const resF = Math.hypot(fixed[0] - ref[0], fixed[1] - ref[1], fixed[2] - ref[2]);
    const resB = Math.hypot(bare[0] - ref[0], bare[1] - ref[1], bare[2] - ref[2]);
    /* float32 的矩阵在 ~10⁴ m 的世界坐标下有 ~1 mm 的存储噪声底（渲染管线
       本身也是 float32，同样的底；0.61 mm ≈ 半像素，不可见），所以钉**抵消率**，
       不钉绝对残差：补偿后必须 < 不补偿的 5%；不补偿必须大到可见（空转自检，
       这条在 m4invertRigid 的平移项写成 −R·t 时当场抓出过 8.9×10⁶ mm）。 */
    if (!(S && resF < resB * 0.05 && resB > 0.005)) { bad++; console.log(`✗ 司机室补偿矩阵不对（不补偿 ${(resB * 1000).toFixed(1)} mm → 补偿后 ${(resF * 1000).toFixed(2)} mm，应 <5%；空转自检要求不补偿 >5 mm）`); }
    else console.log(`✓ 司机室与视线刚性绑定（台面抖动 ${(resB * 1000).toFixed(1)} mm → 补偿后 ${(resF * 1000).toFixed(2)} mm，抵消 ${(100 * (1 - resF / resB)).toFixed(1)}%）—— 仪表屏别抖、车晃正常`);
    if (!/this\._cabFix = SH\.cabFixMatrix/.test(src)) { bad++; console.log('✗ 相机没算出 _cabFix —— 补偿矩阵存在但没人算它'); }
    if (!/m4mul\(FIX, this\.M0\)/.test(src)) { bad++; console.log('✗ 司机室批次绘制没预乘 FIX —— 补偿没接到绘制上'); }
  }
}

/* ---- 停车标在站台端 + 丝滑发车（玩家第 111-4 条）----
   停车标此前就是站台中心：8A 的车尾甩出站台 36 m、车头离远端 42 m ——
   "停在站台中间"。SH.STOP_MARK（align.js 单点，站台端 s+42 内缩 3 m）把
   targetS / PSD 门叶（DoorZs）/ 屏蔽门立柱三处一起搬家；判据钉行为：
   每条线的车头车尾都必须**全车落进站台**（站台 [S−150, S+42]，
   字面量见 world.js station()）。丝滑发车钉行为：门开时按一次发车 →
   排队 → 最小乘降后自动关门 → 关严直接转 running，全程无需第二次确认。 */
{
  const MARK = SH.STOP_MARK;
  let fitErrs = [];
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    const p = line.profile;
    const L = 2 * p.headLen + (p.cars - 2) * ((p.midLen || p.headLen) + CAR_GAP);
    const S = line.al.stationS[Math.min(3, line.al.stationS.length - 1)];   // 磁浮只有 2 站
    const nose = S + MARK, tail = nose - L;
    if (!(tail >= S - 150 + 2 && nose <= S + 42 - 2))
      fitErrs.push(`${SH.LINES[id].name} 车尾 ${ (tail - S).toFixed(1) } / 车头 ${(nose - S).toFixed(1)} m 落在站台外`);
  }
  if (fitErrs.length) { bad++; console.log('✗ 停车标不在站台端：' + fitErrs.slice(0, 3).join('；')); }
  else console.log(`✓ 停车标在站台端（STOP_MARK ${MARK} m）：全部 ${Object.keys(SH.LINES).length} 条线的列车全车落进站台、两端各留 ≥2 m`);
  if (!/stationS\[this\.i0 \+ this\.leg \+ 1\] \+ SH\.STOP_MARK/.test(src) || !/DoorZs\(st\.s \+ SH\.STOP_MARK/.test(src)) {
    bad++; console.log('✗ targetS / PSD 门叶没有跟 SH.STOP_MARK —— 停车标挪了、屏蔽门没挪，门叶整体错位');
  }
  /* 丝滑发车：phase 机行为判据 */
  {
    const line = new LineRuntime(SH.LINES.l2);
    const s = new Session(app); app.ato = new SH.physics.ATO('manual');
    s.start(line, 'manual', 2, 3);
    s.leg = 0; s.s = line.al.stationS[1] + SH.STOP_MARK; s.tr.v = 0; s.tr.s = s.s;
    s.phase = 'doorOpen'; s.doors = true; s.dwell = 0; s.open = 1; s._departReq = false;
    s.depart();                                            // 门开着按发车 → 只排队
    if (!s._departReq) { bad++; console.log('✗ 门开时按发车没有排队（_departReq 没置位）—— 还是要等关门再按一次'); }
    s.dwell = 2.5; s.closeDoors();                          // 最小乘降满足，关门
    if (s.phase !== 'doorClosing') { bad++; console.log('✗ 排队发车没有触发自动关门（phase ' + s.phase + '）'); }
    const sBefore = s.s;                                    // 段落切换不得回吸位置（111-4 发车闪现）
    s.open = 0.03; s.update(1 / 30);                        // 门关严 → _advance → 自动转 running
    if (s.phase !== 'running') { bad++; console.log(`✗ 发车请求被吞（关门后 phase ${s.phase}，应直接 running）—— 丝滑连接断了`); }
    else if (Math.abs(s.s - sBefore) > 1e-6) { bad++; console.log(`✗ 发车瞬间位置回吸 ${(s.s - sBefore).toFixed(1)} m —— 段落切换又把车拽回老停车位`); }
    else console.log('✓ 丝滑发车：门开按一次发车 → 关门直接转 running，位置零闪现（免二次确认）');
  }
}

/* ---- 下车人流过程（第 112 条）：**关门之后人还在站台上往出入口走** ----
   以前下车人流只挂在 `s.doors` 上：门一关 `alight` 变 null，站台上正在走
   的那几十个人瞬间消失。现在它是一条独立推进的过程（`Session.egress`）：
   开门登记、关门继续、走完或列车把它甩远才结束。 */
{
  const line = new LineRuntime(SH.LINES.l2);
  const s = new Session(app); app.ato = new SH.physics.ATO('manual');
  s.start(line, 'manual', 2, 3);
  const at = s.i0 + s.leg + 1, ss = line.al.stationS[at];
  s.s = ss + SH.STOP_MARK; s.tr.s = s.s; s.tr.v = 0; s.tr.kmhCache = 0;
  s.phase = 'stopped'; s.doors = false; s.open = 0;
  s.openDoors();
  const e = s.egress[0];
  if (!e) { bad++; console.log('✗ 开门没有登记下车人流过程（egress 为空）—— 又回到"只画上车"'); }
  else if (!(e.need > 0) || !(e.rate > 0)) { bad++; console.log(`✗ 下车人流过程没有模型量（need ${e.need} / rate ${e.rate}）`); }
  else console.log(`✓ 开门登记下车人流过程：${line.stations[at]} 下 ${e.need} 人 · rate ${e.rate.toFixed(0)}/s · 上限 ${SH.egressSec(e.need, e.rate).toFixed(0)} s`);
  /* 门关之后过程必须**还在**（这是这一条的全部意义） */
  s.dwell = 30; s.closeDoors();
  if (s.egress.length !== 1) { bad++; console.log(`✗ 关门把下车人流过程丢了（egress ${s.egress.length}）—— 站台上的人又瞬间消失`); }
  else {
    const t0 = s.egress[0].t;
    s.update(1 / 30); s.update(1 / 30);
    const t1 = s.egress[0] ? s.egress[0].t : -1;
    if (!(t1 > t0)) { bad++; console.log(`✗ 关门之后下车人流的时钟没有继续走（${t0.toFixed(2)} → ${t1.toFixed(2)}）—— 人冻在门线上`); }
    else console.log(`✓ 关门之后下车人流继续推进（t ${t0.toFixed(2)} → ${t1.toFixed(2)} s），人不会瞬间撤下`);
  }
  /* 列车把它甩远（> SH.EGRESS_KEEP）之后必须结束 —— 不然每次停站之后
     人群批次会持续重建几十秒，那是每帧 CPU 的主要开销之一。 */
  s.s = ss + SH.EGRESS_KEEP + 20; s.tr.s = s.s;
  s.update(1 / 30);
  if (s.egress.length) { bad++; console.log('✗ 列车已把该站甩出可视范围，下车人流过程还在（会一直重建人群批次）'); }
  else console.log(`✓ 列车离站 > ${SH.EGRESS_KEEP} m 之后下车人流过程结束`);
  /* 时长上界也必须真的封顶（距离之外的第二个出口） */
  const s2 = new Session(app); app.ato = new SH.physics.ATO('manual');
  s2.start(line, 'manual', 2, 3);
  s2.egress.push({ at: s2.i0 + 1, name: 'x', need: 400, rate: 60, dwellNeed: 20, wait0: 400, t: 0 });
  s2.egress[0].t = SH.egressSec(400, 60) + 1;
  s2.update(1 / 30);
  if (s2.egress.length) { bad++; console.log('✗ 下车人流过程超过 SH.egressSec 仍不结束 —— 上界没生效'); }
  else console.log('✓ 下车人流过程在 SH.egressSec 上界处结束');
  /* 接线：process 的登记点必须在开门里，且 egress 必须在 update 里推进 */
  const gsrc2 = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (!/this\.egress\.push\(\{ at, name/.test(gsrc2) || !/for \(const e of this\.egress\) e\.t \+= dt;/.test(gsrc2)) {
    bad++; console.log('✗ egress 的登记/推进接线断了（_startEgress 或 update 里那一段被改没了）');
  }
}

/* ---- 1 号线真实报站音频（玩家第 111-5 条）----
   玩家提供全程真实报站录音（每站「下一站」+「到站」，28 站 56 个 mp3），
   替换此前的系统语音合成。判据钉三件事：
   ① 映射：l1 28 站 × 2 类 = 56 个 mp3 全部存在（路径与站名一一对应）；
   ② 行为：l1 的 departing/arriving 走 speakClip（onText 带 clip 字段），
      其余线路自动回退 speechSynthesis（不带 clip）；
   ③ 接线：arriving 拿到了 line（没有 line 就查不到站序，音频接不上）。 */
{
  const fs = require('fs');
  const dir = './assets/pa/l1';
  const st = SH.LINES.l1.stations;
  let miss = [];
  if (fs.existsSync(dir)) {
    for (let i = 0; i < st.length; i++) for (const kind of ['下一站', '到站']) {
      const f = dir + '/' + String(i + 1).padStart(2, '0') + '_' + st[i] + '_' + kind + '.mp3';
      if (!fs.existsSync(f)) miss.push(f);
    }
  } else miss.push(dir + ' 目录不存在');
  if (miss.length) { bad++; console.log(`✗ 报站音频映射缺失 ${miss.length}/56（缺 ${miss[0]}）—— 真实报站会静默退回系统语音`); }
  else console.log(`✓ 报站音频映射完整（1 号线 ${st.length} 站 × 2 类 = 56 个 mp3 全部在位）`);
  /* 行为：l1 走 clip，其余线路回退 TTS。
     PA 文案挂在 game.js 里（Object.assign(SH.audio.PA.prototype, {...})）——
     test-drive 的 headless 环境没 require game.js，直接从源码抠出该块 eval 接上。 */
  const block = src.match(/const PA_CLIP = \{[\s\S]*?Object\.assign\(SH\.audio\.PA\.prototype, \{[\s\S]*?\n\}\);/);
  if (!block) { bad++; console.log('✗ game.js 里找不到 PA_CLIP 与 PA 文案块'); }
  else { eval(block[0]); }
  const events = [];
  const pa = new SH.audio.PA({ ctx: {}, ready: true });
  pa.enabled = true; pa.onText = e => events.push(e);
  const l1stub = { id: 'l1', stations: st };
  const l2stub = { id: 'l2', stations: SH.LINES.l2.stations };
  if (typeof pa.speakClip !== 'function') { bad++; console.log('✗ PA 上没有 speakClip —— 真实音频通道没接上'); }
  pa.departing('人民广场', l1stub);
  if (!events[events.length - 1] || !events[events.length - 1].clip || !/13_人民广场_下一站\.mp3/.test(events[events.length - 1].clip)) {
    bad++; console.log(`✗ l1 发车报站没走真实音频（onText.clip = ${events[events.length - 1] && events[events.length - 1].clip}）`);
  } else console.log('✓ l1 发车报站走真实音频（人民广场 下一站.mp3）');
  pa.arriving('人民广场', 1, l1stub);
  if (!events[events.length - 1] || !events[events.length - 1].clip || !/13_人民广场_到站\.mp3/.test(events[events.length - 1].clip)) {
    bad++; console.log(`✗ l1 到站报站没走真实音频（onText.clip = ${events[events.length - 1] && events[events.length - 1].clip}）`);
  } else console.log('✓ l1 到站报站走真实音频（人民广场 到站.mp3）');
  events.length = 0;
  pa.departing('陆家嘴', l2stub);
  if (events[0] && events[0].clip) { bad++; console.log(`✗ l2 发车报站却带了音频 clip（${events[0].clip}）—— 没有的线路应该回退系统语音`); }
  else console.log('✓ 没有录音的线路（2 号线）自动回退系统语音，不带 clip');
  /* 接线：1 号线**只用真实录音**（玩家指示，111-5）—— departing/arriving 的
     l1 分支必须是 speakClip 独占（l1 分支里不许再调 speak()，回了就真假叠播），
     speakClip 的 play() catch 也不许再调 speak()。 */
  if (!/line\.id === 'l1' && stIdx >= 0[\s\S]{0,320}?this\.speakClip\(PA_CLIP\.l1\(stIdx, name, '下一站'\)[\s\S]{0,120}?return;/.test(src)) {
    bad++; console.log('✗ departing 的 l1 分支没有 speakClip 独占 —— 发车报站可能真假叠播');
  }
  /* ① 到站音频在**到站前 250 m** 触发（玩家指示：停稳才播就晚了）；
     ② arriving 没有 TTS 兜底（l1 独占真实录音，宁可沉默不冒充）。 */
  if (!/this\._arrived && d < 250/.test(src)) { bad++; console.log('✗ 到站音频没在进站前 250 m 触发 —— 又退回停稳才播'); }
  if (/arriving\(name, side, line\) \{[\s\S]*?this\.speak\('列车已到达'/.test(src)) {
    bad++; console.log('✗ arriving 还有 TTS 兜底报站 —— 玩家听到的是真假两条混着播');
  }
  if (!/line\.id === 'l1' && stIdx >= 0[\s\S]{0,320}?this\.speakClip\(PA_CLIP\.l1\(stIdx, name, '到站'\)[\s\S]{0,120}?return;/.test(src)) {
    bad++; console.log('✗ arriving 的 l1 分支没有 speakClip 独占 —— 到站报站可能真假叠播');
  }
  if (/a\.play\(\)\.catch\(\(\) => \{ this\.speak\(zh, en, opts\)/.test(src)) {
    bad++; console.log('✗ speakClip 播放失败还在回退系统语音 —— 1 号线该沉默而不是叠 TTS');
  }
  /* 互斥闸（玩家指示，111-5）：l1 上之前的所有 TTS 一条不许漏出。
     行为断言：六类文案点在 l1 上都不许产生 TTS 事件。 */
  {
    const leak = [];
    const pa2 = new SH.audio.PA({ ctx: {}, ready: true });
    pa2.enabled = true; pa2.onText = e => { if (!e.clip) leak.push(e.zh || e); };
    const l1stub2 = { id: 'l1', stations: SH.LINES.l1.stations };
    pa2.welcome(l1stub2);
    pa2.approaching('人民广场', l1stub2, 1, null);
    pa2.doorOpen(l1stub2);
    pa2.doorClose(l1stub2);
    if (leak.length) { bad++; console.log(`✗ 1 号线还有系统语音漏出（${leak.length} 条：欢迎/进站/开关门 —— 玩家指示之前的音频全删）`); }
    else console.log('✓ 互斥闸生效：1 号线欢迎/进站/开关门全部静默（之前的音频全删，只剩真实录音）');
  }
  /* ① 到站音频在**到站前 250 m** 触发（玩家指示：停稳才播就晚了）；
     ② arriving 没有 TTS 兜底（l1 独占真实录音，宁可沉默不冒充）。 */
  if (!/this\._arrived && d < 250/.test(src)) { bad++; console.log('✗ 到站音频没在进站前 250 m 触发 —— 又退回停稳才播'); }
  if (/arriving\(name, side, line\) \{[\s\S]*?this\.speak\('列车已到达'/.test(src)) {
    bad++; console.log('✗ arriving 还有 TTS 兜底报站 —— 玩家听到的是真假两条混着播');
  }
}

console.log(bad ? '✗ ' + bad + ' 项断言未通过' : '✓ 全部断言通过（结算完整、停车精度、客流在跑）');
process.exit(bad ? 1 : 0);