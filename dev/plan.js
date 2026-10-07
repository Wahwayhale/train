/* dev/plan.js — 把"这一站的换乘通道有多长、拐几道弯、在哪个里程"打成一表。
 * 截图机位要靠它：通道不在站台上，而在轨道坐标 (里程, 横向) 的某条腿上，
 * 照着线路图猜横向距离，截出来的一定是墙。
 * 引导方式与 test-bake.js 一致（打桩渲染器 + 从 game.js 里取 LineRuntime），
 * 这样"线路怎么生成"只有一份实现，探针不会和游戏各说各话。
 * 用法：node dev/plan.js [线路id]   （默认 l1）
 */
'use strict';
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), beginPath() {}, arc() {}, fill() {}, rect() {}, clip() {}, save() {}, restore() {}, translate() {}, fillRect() {}, clearRect() {}, drawImage() {}, fillText() {}, measureText: () => ({ width: 10 }) }), style: { setProperty() {} } }), addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({ matches: false });
global.performance = require('perf_hooks').performance;
const path = require('path');
const files = ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio'];
for (const f of files) require(path.join(__dirname, '..', 'src', f + '.js'));
require(path.join(__dirname, '..', 'data', 'shanghai.js'));
const SH = global.SH;
const fakeR = {
  textures: { sign: null }, batches: [],
  upload(m) { this.batches.push(...m); return m; },
  dropTag() {}, texFromCanvas() { return {}; }, draw() {}, begin() {}, end() {},
};
const gsrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
const grab = name => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const id = process.argv[2] || 'l1';
const def = SH.LINES[id];
if (!def) { console.error('没有线路 ' + id); process.exit(1); }
const line = new LineRuntime(def);
const al = line.al;
console.log(`${def.name}  全长 ${al.total.toFixed(0)} m  站数 ${def.stations.length}`);
let n = 0;
for (let i = 0; i < def.stations.length; i++) {
  const nm = def.stations[i], meta = SH.INTER_META && SH.INTER_META[nm];
  if (!meta) continue;
  const plan = SH.transferPlan(nm, meta);
  const s = al.stationS[i], elev = line.isElevated(s);
  const legs = plan.legs.map(l => `${l.kind} ${l.len.toFixed(0)}m 转${l.turn.toFixed(0)}°`).join(' / ');
  /* 通道是在"门口断面的平行基"里摆的（横向 x + 沿线路 y），而 FREECAM 用的是
     轨道断面 —— 车站段基本是直线，两者对得上，所以这里直接把通道口换算成
     轨道坐标打出来，截图机位不必再猜横向距离。 */
  const side = line.stationSide(i) || 1, sP = s - 45;
  const L0 = elev ? SH.STATION_X.rail + 1.98 : 10.65, FL = elev ? 0.42 : SH.STATION_X.mezzTop;
  const fc = `${sP.toFixed(0)},${(side * (L0 + 1.2)).toFixed(1)},${(FL + 1.5).toFixed(2)},${sP.toFixed(0)},${(side * (L0 + 20)).toFixed(1)},${(FL + 1.5).toFixed(2)},62`;
  console.log(`  #${i} ${nm}  里程 ${s.toFixed(0)}  ${elev ? '露天' : '地下'}  type=${meta.type}  walk=${meta.walkSec}s  本体 ${plan.total.toFixed(0)} m${legs ? '  [' + legs + ']' : ''}`);
  console.log(`      FREECAM='${fc}'`);
  n++;
}
console.log(`  合计 ${n} 座换乘站`);
