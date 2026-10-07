/* 高架站横断面的实测器：把烘焙出来的三角形按材质取出来，投影到"距线路中心
   的横向距离"上，报告每类构件实际占到的横向区间。
 *
 * 为什么要它：雨棚偏出站台外 3 m 这件事，我在两张俯瞰截图里都没看出来 ——
 * 顶视图里"棚板"和"站台"都是长条带，偏了也像是两条并排的带子。
 * 只有把横向坐标量出来才能回答"棚子到底罩没罩住站台"。
 *
 * 用法：node dev/xsect.js [线路id] [站序] */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const id = process.argv[2] || 'l3', si = +(process.argv[3] || 5);
const line = new LineRuntime(SH.LINES[id]), al = line.al, s = al.stationS[si];
const wb = new SH.WorldBuilder({ al, color: line.color, stations: line.stations,
  sign: new SH.textures.SignAtlas(1024), night: 0.62, profile: line.profile });
wb.sun = null; wb._installLight();
if (process.env.DUMP) {
  for (const m of ['box', 'sweep']) {
    const raw = SH.Builder.prototype[m];
    SH.Builder.prototype[m] = function (...args) {
      const before = this.buckets.get('concrete') ? this.buckets.get('concrete').pos.length : 0;
      const r = raw.apply(this, args);
      const b2 = this.buckets.get('concrete');
      if (b2 && b2.pos.length > before) {
        let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
        for (let i = before; i < b2.pos.length; i += 3) {
          lo = Math.min(lo, b2.pos[i]); hi = Math.max(hi, b2.pos[i]);
          ylo = Math.min(ylo, b2.pos[i + 1]); yhi = Math.max(yhi, b2.pos[i + 1]);
        }
        const st = (new Error().stack.split(String.fromCharCode(10))[2] || '').trim();
        console.log('  [concrete]', m, 'x', lo.toFixed(1), '~', hi.toFixed(1), 'y', ylo.toFixed(2), '~', yhi.toFixed(2), ' at', st.slice(0, 90));
      }
      return r;
    };
  }
}
SH.WorldBuilder.buildRuns(wb, line, 0, al.total, null);

const f = al.frame(s), c = f.p;
const X = SH.STATION_X, side = line.stationSide(si);
const rows = [];
for (const [mat, b] of wb.b.buckets) {
  const band = process.env.BAND ? Number(process.env.BAND) : 0;   // 1 = 只看吊顶高度以上
  let lo = Infinity, hi = -Infinity, n = 0, ylo = Infinity, yhi = -Infinity;
  for (let i = 0; i < b.pos.length; i += 3) {
    const p = [b.pos[i], b.pos[i + 1], b.pos[i + 2]];
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const along = d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2];
    if (Math.abs(along) > 18) continue;                    // 只量站心附近一段
    const latRaw = d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2];
    if (process.env.DUMP && mat === 'concrete' && Math.abs(latRaw) < 1.6) console.log('  concrete', mat, 'along', along.toFixed(1), 'lat', latRaw.toFixed(2), 'up', (d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2]).toFixed(2));
    const lat = latRaw * side;   // 转正到站台那一侧
    const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
    if (Math.abs(lat) > 14 || up < -2 || up > 8) continue;
    if (band && up < 3.5) continue;
    if (!band && up > 3.5) continue;
    lo = Math.min(lo, lat); hi = Math.max(hi, lat); ylo = Math.min(ylo, up); yhi = Math.max(yhi, up); n++;
  }
  if (n) rows.push({ mat, lo, hi, ylo, yhi, n });
}
rows.sort((a, b) => a.lo - b.lo);
console.log(`${line.name} ${line.stations[si]}（站心 ${Math.round(s)} m，side=${side}）` +
  `  站台 ${X.front}~${X.outer} m · 棚 ${X.canopyIn.toFixed(2)}~${X.canopyOut} m · 栏 ${X.rail} m · 灯 ${X.lamps.join('/')}`);
for (const r of rows)
  console.log(`  ${r.mat.padEnd(10)} 横向 ${r.lo.toFixed(2).padStart(7)} ~ ${r.hi.toFixed(2).padStart(7)} m` +
    `   竖向 ${r.ylo.toFixed(2).padStart(6)} ~ ${r.yhi.toFixed(2).padStart(6)} m   ${r.n} 顶点`);
const ceil = rows.find(r => r.mat === 'tiles'), plat = rows.find(r => r.mat === 'granite');
if (ceil && plat) {
  const cover = Math.min(ceil.hi, plat.hi) - Math.max(ceil.lo, plat.lo);
  console.log(`  棚板与站台板的横向重叠：${cover.toFixed(2)} m（站台宽 ${X.width} m，重叠不足就是"棚子罩在空气上"）`);
}
