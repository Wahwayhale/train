/** 临时探针（岛式 B 阶段的前置量测）：一座地下站的横断面上，
 *  对向站台板到底压在谁身上 —— 按材质打印 side 转正后的横向区间，
 *  并把"落在两股道之间"的顶点单独点数。
 *  用法：node dev/probe-farplat.js [线路id] [站序号]
 */
require('../stub-dom.js');
const path0 = require('path');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) {
  require(path0.join(__dirname, '..', 'src', f + '.js'));
}
require(path0.join(__dirname, '..', 'data', 'shanghai.js'));
const SH = global.SH;
const src = require('fs').readFileSync(path0.join(__dirname, '..', 'src', 'game.js'), 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const id = process.argv[2] || 'l2';
const line = new LineRuntime(SH.LINES[id]);
let si = process.argv[3] != null ? +process.argv[3] : -1;
if (process.argv[3] && isNaN(si)) {
  si = line.stations.findIndex(nm => String(nm).indexOf(process.argv[3]) === 0);
  if (si < 0) { console.log('找不到站名', process.argv[3]); process.exit(2); }
}
if (si < 0) {
  for (let i = 0; i < line.stations.length; i++) {
    const s = line.al.stationS[i];
    if (!line.isElevated(s) && !line.depotAtS(s)) { si = i; break; }
  }
}
const al = line.al, s = al.stationS[si], side = line.stationSide(si);
console.log(`${line.name} 站 ${si} ${line.stations[si]}  s=${s.toFixed(1)} side=${side} 线间距=${SH.TRACK_OFFSET} 岛式跨距=${SH.islandSpan().toFixed(2)}`);
const wb = new SH.WorldBuilder({ al, color: line.color, color2: line.color2, stations: line.stations,
  sign: new SH.textures.SignAtlas(1024), night: 0.62, profile: line.profile });
wb.sun = null; wb._installLight();
SH.WorldBuilder.buildRuns(wb, line, Math.max(0, s - 170), Math.min(al.total, s + 60), null);

const f = al.frame(s), c = f.p;
const rows = new Map();
for (const [mat, b] of wb.b.buckets) {
  for (let i = 0; i + 2 < b.pos.length; i += 3) {
    const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
    if (Math.abs(d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2]) > 16) continue;
    const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
    const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
    if (Math.abs(lat) > 20) continue;
    const band = up > 3.5 ? 'hi' : up > -0.15 && up < 0.9 ? 'lo' : 'mid';
    const key = mat + '|' + band;
    const r = rows.get(key) || { lo: Infinity, hi: -Infinity, n: 0, inGauge: 0, between: 0, bLo: Infinity, bHi: -Infinity };
    r.lo = Math.min(r.lo, lat); r.hi = Math.max(r.hi, lat); r.n++;
    if (band === 'lo' && Math.abs(lat) < 1.90) r.inGauge++;
    /* 两股道之间：转正后 (-4+0.9, -0.9)；岛式跨距下 (-12.1+0.9, -0.9) 才是"之间" */
    const gap0 = -SH.TRACK_OFFSET + 0.9, gap1 = -0.9;
    if (lat > gap0 && lat < gap1) { r.between++; r.bLo = Math.min(r.bLo, lat); r.bHi = Math.max(r.bHi, lat); }
    rows.set(key, r);
  }
}
const keys = [...rows.keys()].sort();
console.log('  材质|带   n     横向区间            限界内  两股道之间(区间)');
for (const k of keys) {
  const r = rows.get(k);
  const bt = r.between ? `${r.between} (${r.bLo.toFixed(2)}~${r.bHi.toFixed(2)})` : '-';
  console.log(`  ${k.padEnd(16)} ${String(r.n).padEnd(6)} ${r.lo.toFixed(2)}~${r.hi.toFixed(2)}      ${String(r.inGauge).padEnd(6)} ${bt}`);
}
const rl = (rows.get('rail|lo') || { lo: 0, hi: 0 });
const railLat = [];
for (const [mat, b] of wb.b.buckets) {
  if (mat !== 'rail') continue;
  for (let i = 0; i + 2 < b.pos.length; i += 3) {
    const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
    if (Math.abs(d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2]) > 16) continue;
    railLat.push(Math.round((d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side * 100) / 100);
  }
}
console.log('  钢轨横向（转正）：', [...new Set(railLat)].sort((a, b) => a - b).join(', '));
/* concrete 的 up 分布（找桥面到底落在哪一带） */
{
  /* 用 test-xsect 一模一样的带链与分侧，把 concrete 的键打出来 —— 桥面判据报"量不到"时先看两边量的到底是不是同一批顶点 */
  const keys = new Map();
  for (const [mat, b] of wb.b.buckets) {
    if (mat !== 'concrete') continue;
    for (let i = 0; i < b.pos.length; i += 3) {
      const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
      if (Math.abs(d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2]) > 16) continue;
      const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
      const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
      if (Math.abs(lat) > 14) continue;
      const band = up > 3.5 ? 'hi' : up > 0.2 && up < 0.9 ? 'lo'
        : (up > -0.25 && up < 0.25 ? 'dk' : null);
      if (!band) continue;
      const k = 'concrete|' + band + '|' + (lat > 0 ? 'near' : 'far');
      const r = keys.get(k) || { n: 0, lo: Infinity, hi: -Infinity };
      r.n++; r.lo = Math.min(r.lo, Math.abs(lat)); r.hi = Math.max(r.hi, Math.abs(lat));
      keys.set(k, r);
    }
  }
  for (const [k, r] of keys) console.log(`  xsect键 ${k.padEnd(22)} n=${String(r.n).padEnd(6)} |lat| ${r.lo.toFixed(2)}~${r.hi.toFixed(2)}`);

  const hist = new Map();
  for (const [mat, b] of wb.b.buckets) {
    if (mat !== 'concrete' && mat !== 'concreteD') continue;
    for (let i = 0; i + 2 < b.pos.length; i += 3) {
      const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
      if (Math.abs(d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2]) > 16) continue;
      const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
      if (Math.abs(lat) < 6 || Math.abs(lat) > 13) continue;
      const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
      const k = mat + ' up' + (up > 3.5 ? '>3.5' : up > 0.2 ? '0.2~0.9' : up > -0.25 ? '-0.25~0.25' : up > -1.2 ? '-1.2~-0.25' : '<-1.2');
      const h = hist.get(k) || { n: 0, lo: Infinity, hi: -Infinity, latLo: Infinity, latHi: -Infinity };
      h.n++; h.lo = Math.min(h.lo, up); h.hi = Math.max(h.hi, up);
      h.latLo = Math.min(h.latLo, lat); h.latHi = Math.max(h.latHi, lat);
      hist.set(k, h);
    }
  }
  for (const [k, h] of hist) console.log(`  ${k.padEnd(22)} n=${String(h.n).padEnd(6)} up ${h.lo.toFixed(2)}~${h.hi.toFixed(2)}  lat ${h.latLo.toFixed(2)}~${h.latHi.toFixed(2)}`);
}
/* 落在两股道之间、站台面高度的 paint/metal/granite 顶点到底在里程哪儿 */
for (const [mat, b] of wb.b.buckets) {
  if (!['paint', 'metal', 'granite', 'glassSoft'].includes(mat)) continue;
  for (let i = 0; i < b.pos.length; i += 3) {
    const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
    const dz = d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2];
    if (Math.abs(dz) > 16) continue;
    const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
    const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
    if (lat > -0.95 || lat < -3.05) continue;
    if (up < 0.2 || up > 0.9) continue;
    console.log(`  间隙顶点 ${mat.padEnd(6)} dz=${dz.toFixed(1).padStart(6)} lat=${lat.toFixed(2)} up=${up.toFixed(2)} col=${b.col ? [b.col[i], b.col[i + 1], b.col[i + 2]].map(x => x.toFixed(2)).join(',') : '-'}`);
  }
}

