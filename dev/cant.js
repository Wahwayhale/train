/* 一次性诊断：超高沿里程的变化率，用真实舒适度标准量。
   横向未平衡加速度 a = v²·k − g·sin(cant)，司机和乘客感到"抽搐"的不是 a 本身，
   而是它的**时间变化率** da/dt = v · da/ds。铁路/地铁的舒适上限通常取 0.4~0.6 m/s³
   （换算成超高不足的速率就是每秒 55 mm 那一档）。
   现在 at() 里的超高是"带符号曲率在 ±45 m 上九点平均"，等效一条约 90 m 的缓和段。
   够不够，跑一遍就知道。 */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, {
  CAR_GAP: 0.35, MODES: {}, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
});
const LR = eval('(' + grab('LineRuntime') + ')');
const G = 9.81;

/* 按**该里程曲线自己允许的连续速度**量，而不是全线最高速度，也不是 limitAt：
   limitAt 里含"进站 78 m 内 40"这种**台阶**，拿它当 v(s) 量出来的"变化率"
   其实是限速阶跃的导数，与线形无关（实测所有红点都落在车站附近，就是这个原因）。
   曲线限速 V=sqrt(a·g/|k|) 本身是连续的，曲率爬升的地方它也在同步爬升。 */
function rate(al, line, step) {
  const a = s => {
    const st = al.at(s);
    const v = Math.min(line.runKmh, al.curveLimitKmh(s)) / 3.6;
    return { v, a: v * v * st.k - G * Math.sin(st.cant) };
  };
  let m = 0, at = 0;
  for (let s = step; s < al.total - step; s += step) {
    const p = a(s - step), q = a(s + step), c = a(s);
    const d = Math.abs(q.a - p.a) / (2 * step) * c.v;
    if (d > m) { m = d; at = s; }
  }
  return { m, at };
}

console.log('线路      运营速度  最大|da/dt| m/s³ @里程      最大 cant 斜率 °/m   曲线数');
for (const id of Object.keys(SH.LINES)) {
  const line = new LR(SH.LINES[id]); const al = line.al;
  const r = rate(al, line, 2);
  /* cant 斜率：相邻 2 m 的侧倾角差 */
  let mc = 0;
  for (let s = 2; s < al.total - 2; s += 2) {
    const d = Math.abs(al.at(s + 2).cant - al.at(s - 2).cant) / 4 * 180 / Math.PI;
    if (d > mc) mc = d;
  }
  let nc = 0; for (let s = 2; s < al.total - 2; s += 5) if (Math.abs(al.at(s).k) > 1e-5) nc++;
  console.log(line.name.padEnd(7) + String(line.runKmh).padStart(4) + ' km/h  '
    + r.m.toFixed(3).padStart(7) + ' @' + String(Math.round(r.at)).padStart(6)
    + '   ' + mc.toFixed(4).padStart(7) + '   ' + String(nc * 5).padStart(5) + ' m'
    + (r.m > 0.45 ? '   ← 超舒适上限' : ''));
}
