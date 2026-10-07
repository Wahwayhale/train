/* 需求整形到底值不值？（_shape 的 A/B）
 *
 * 背景：ATO 的 `_decide` 输出粗级位，`_shape` 把级位换算成"名义加速度需求"，
 * 按 jerk 限幅平滑地追它，再带 0.09 m/s² 迟滞反选级位。代价是约 0.3 m 的响应滞后
 * （为此把停车 bias 从 −0.7 重标定到 −1.0）。
 * 负控发现：把 `_shape` 换成恒等映射，test-drive 的红线一条都不会亮 ——
 * 说明现有判据（jerk 峰值、顶格时间、平稳分）测不出它的存在。
 * 那它到底是"降低了级位抖动但不影响舒适"，还是"完全没作用"？量一遍：
 * 同一个线路、同一套随机种子，只切 `_shape`，比 停车误差 / 顶格时间 / 平稳分 /
 * 换级次数 / 级位序列方向反转次数。反转次数才是"连续顿挫"的形态学特征。 */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;

const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const MODES = { manual: { name: '人工' }, semi: { name: '半自动' }, auto: { name: '全自动' } };
Object.assign(global, { CAR_GAP: 0.35, MODES, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
const Session = eval('(' + grab('Session') + ')');

const app = { pa: new Proxy({}, { get: () => () => {} }), audio: new Proxy({}, { get: () => () => {} }),
  ato: null, toast() {}, hint() {}, showJudge() {}, syncLever() {}, bakeAhead() {}, finishRun() {} };
const ctxOf = s => ({ distanceToStop: s.d, speedKmh: s.tr.kmh, limitKmh: s.limit, grade: s.grade,
  curveK: s.curveK, curveLimit: s.limit, predictStop: s.tr.predictStop(s.grade), perf: s.tr.spec.perf });

function run(id, shaped) {
  const raw = SH.physics.ATO.prototype._shape;
  SH.physics.ATO.prototype._shape = shaped ? raw : function (dt, w) { return w; };
  const line = new LineRuntime(SH.LINES[id]);
  const s = new Session(app); app.ato = new SH.physics.ATO('auto');
  s.start(line, 'auto', 2, 3);
  const dt = 1 / 30; let chg = 0, prev = null, jHold = 0, rev = 0, dir = 0, seq = [];
  for (let i = 0; i < 30 * 900; i++) {
    if (s.phase === 'ready' && i > 60) s.depart();
    if (s.phase === 'stopped' && !s.doors && !s._committed) s.openDoors();
    if (s.doors && s.dwell > s.dwellNeed()) s.closeDoors();
    s.update(dt);
    const jl = s.tr.jerk > 0 ? SH.JERK.up : SH.JERK.dn;
    if (Math.abs(s.tr.jerk) > jl * 0.9) jHold += dt;
    const n = s.tr.notch;
    if (prev !== null && n !== prev) {
      chg++;
      const nd = n > prev ? 1 : -1;
      if (dir !== 0 && nd !== dir && Math.abs(n) <= 1 && Math.abs(prev) <= 1) rev++;   // 只看零点附近的反复横跳
      dir = nd;
    }
    if (n !== prev) { seq.push(n); prev = n; }
    if (s.phase === 'finished' || i > 30 * 890) break;
  }
  SH.physics.ATO.prototype._shape = raw;
  const errs = s.results.map(r => Math.abs(r.err));
  const sm = s.results.map(r => r.smooth);
  return { worst: errs.length ? Math.max(...errs) : NaN, mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN,
    pin: jHold / (s.t || 1) * 100, smooth: sm.reduce((a, b) => a + b, 0) / Math.max(1, sm.length),
    chg: chg, legs: s.results.length, rev: rev, tail: seq.slice(-14).join(' ') };
}

for (const id of ['l2', 'l3', 'l16', 'ph', 'ml']) {
  for (const shaped of [true, false]) {
    const r = run(id, shaped);
    console.log(`${id.padEnd(4)} ${shaped ? '整形' : '直连'}  最大误差 ${r.worst.toFixed(2)} m 平均 ${r.mean.toFixed(2)} m  顶格 ${r.pin.toFixed(1)}%  平稳 ${r.smooth.toFixed(1)}  换级 ${(r.chg / r.legs).toFixed(0)}/站  零点反转 ${(r.rev / r.legs).toFixed(1)}/站`);
  }
}
