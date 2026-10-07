/* 一次性诊断：街面基准（al.groundY）与局部轨面到底差多少。
   起因：street 机位里整条街被"跟随相机的远景地面"盖掉 ——
   街面按**局部轨面 −10.9** 铺，远景地面按**平滑轨面 −11.3** 铺，
   两者只要差过 0.4 m，那张平面就把刚铺好的街吞掉。 */
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
let worst = 0, wname = '';
for (const id of Object.keys(SH.LINES)) {
  const line = new LR(SH.LINES[id]); const al = line.al;
  let m = 0, at = 0, el = 0, mEl = 0, atEl = 0;
  for (let s = 0; s < al.total; s += 25) {
    const d = Math.abs(al.groundY(s) - al.frame(s).p[1]);
    if (d > m) { m = d; at = s; }
    if (line.isElevated(s)) { el++; if (d > mEl) { mEl = d; atEl = s; } }
  }
  if (m > worst) { worst = m; wname = line.name + ' @' + Math.round(at); }
  console.log(line.name.padEnd(7) + ' 高架 ' + String(el * 25).padStart(5) + ' m  |gy-rail| 最大 ' + m.toFixed(2) + ' m @' + Math.round(at) + '   仅高架段 ' + mEl.toFixed(2) + ' m @' + Math.round(atEl));
}
console.log('\n全网最差 ' + worst.toFixed(2) + ' m（' + wname + '）；街面与远景地面只差 0.4 m，超过就会被整片盖掉');
