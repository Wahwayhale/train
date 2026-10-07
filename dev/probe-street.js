/** 临时探针：street.update 的每帧代价与高架跟驰表的实际重建次数。
 *  用法：node dev/probe-street.js [线路id] [帧数]
 */
require('../stub-dom.js');
const path0 = require('path');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark', 'traffic', 'street']) {
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

const id = process.argv[2] || 'l3';
const FR = +(process.argv[3] || 3600);
const line = new LineRuntime(SH.LINES[id]);
const st = new SH.street.StreetTraffic(line);
const deck = st.deckCars;
console.log(`${line.name}: 车总数 ${st.cars.length} 桥面车 ${deck.length} 线长 ${line.al.total.toFixed(0)} m`);

/* 数一下 _deckTable 实际重建了几次（包一层计数，不改产品代码） */
let builds = 0;
const orig = st._deckTable.bind(st);
st._deckTable = function () {
  const had = st._deckGroups && !st._deckDirty;
  const r = orig();
  if (!had) builds++;
  return r;
};

let t0 = process.hrtime.bigint();
for (let f = 0; f < FR; f++) st.update(1 / 60);
let ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`${FR} 帧 update(1/60)【不传相机=全量档】：${ms.toFixed(0)} ms（${(ms * 1000 / FR).toFixed(1)} µs/帧，跟驰表重建 ${builds} 次）`);

/* 分级档：给一个相机里程，量同样的帧数。近档 1500 m 之外的车不跟驰、不看灯。 */
{
  const st2 = new SH.street.StreetTraffic(line);
  const camS = line.al.stationS[(line.stations.length / 2) | 0];
  const t1 = process.hrtime.bigint();
  for (let f = 0; f < FR; f++) st2.update(1 / 60, camS);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`同帧数【传相机里程分级】：${ms2.toFixed(0)} ms（${(ms2 * 1000 / FR).toFixed(1)} µs/帧，省 ${(100 - ms2 / ms * 100).toFixed(0)}%）`);
  /* 正确的口径不是"两档结果逐车相同"（远档不跟驰，远处必然叠），
     而是**被画出来的那 480 m 里不许有重叠**：近档半径 1500 m 是它的三倍。 */
  const DRAW_R = 480;
  let worst = Infinity, at = '';
  const byLane = new Map();
  for (const c of st2.cars) {
    if (c.deck) continue;
    let d = Math.abs(c.s - camS); if (d > line.al.total / 2) d = line.al.total - d;
    if (d > DRAW_R) continue;
    const k = c.side + '|' + Math.round(c.lat * 10);
    let a = byLane.get(k); if (!a) { a = []; byLane.set(k, a); } a.push(c);
  }
  let drawn = 0;
  for (const a of byLane.values()) {
    a.sort((x, y) => (x.s - y.s) * a[0].side);
    drawn += a.length;
    for (let i = 0; i + 1 < a.length; i++) {
      const g = (a[i + 1].s - a[i].s) * a[i].side - 4.6;
      if (g < worst) { worst = g; at = `${a[i].kind}→${a[i + 1].kind}`; }
    }
  }
  console.log(`  画程 480 m 内 ${drawn} 辆车，最小同车道净距 ${worst === Infinity ? '（不足两辆）' : worst.toFixed(2) + ' m ' + at}`);
}

/* 桥面车流现状：最小同车道净距、速度分布、并线发生数 */
const byLane = new Map();
for (const c of deck) {
  const k = c.ci * 8 + c.lane;
  let a = byLane.get(k); if (!a) { a = []; byLane.set(k, a); } a.push(c);
}
let minGap = Infinity, minAt = null;
for (const a of byLane.values()) {
  a.sort((x, y) => (x.s - y.s) * a[0].dir);
  for (let i = 0; i + 1 < a.length; i++) {
    const d = (a[i + 1].s - a[i].s) * a[i].dir - 4.6;
    if (d < minGap) { minGap = d; minAt = `${a[i].ci}/${a[i].lane} @s=${a[i].s.toFixed(0)} ${a[i].kind}v${a[i].v.toFixed(1)} ← ${a[i + 1].kind}v${a[i + 1].v.toFixed(1)}`; }
  }
}
const vs = deck.map(c => c.v).sort((a, b) => a - b);
const kinds = {};
for (const c of deck) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
console.log(`  最小同车道净距 ${minGap.toFixed(2)} m  在 ${minAt}`);
console.log(`  速度 p10/p50/p90 = ${vs[(vs.length * 0.1) | 0].toFixed(1)} / ${vs[(vs.length * 0.5) | 0].toFixed(1)} / ${vs[(vs.length * 0.9) | 0].toFixed(1)} m/s`);
console.log('  车型：', JSON.stringify(kinds), ' 正在变道：', deck.filter(c => c.merging != null).length);
