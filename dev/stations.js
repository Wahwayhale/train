/* dev/stations.js — 打印某条线的站序 / 站名 / 停车标里程 / 站台侧。
 *
 * 为什么留着它：`dev/shot.js` 的 FREECAM 用的是**轨道里程**（`s,lat,dy,…`），
 * 而"这块屏/这根信号机在第几站"是用**站序**表达的。中间那一层换算没有第二个入口，
 * 于是每次为站台构件取证都要临时写一段 require 桩（写过一次、删过一次）。
 * 有了它，取证位可以直接写：
 *   node dev/stations.js l2          → 找出目标站的里程
 *   FREECAM='<里程>,3.5,1.9,<里程>,4.7,2.36,42' node dev/shot.js x l2 8 platform
 *
 * LineRuntime 定义在 game.js 里（它要 DOM），所以这里用源码抽取的方式拿到类 ——
 * 与 test-bake.js 的 `grab()` 同一手法，不额外造第二份 LineRuntime。 */
'use strict';
global.window = global;
global.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() { } }) }), style: { setProperty() { } } }),
  addEventListener() { }, querySelectorAll: () => [], getElementById: () => null,
};
global.localStorage = { getItem: () => null, setItem: () => { } };
global.matchMedia = () => ({ matches: false });
global.performance = require('perf_hooks').performance;
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio'])
  require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;

const fs = require('fs');
const gsrc = fs.readFileSync(__dirname + '/../src/game.js', 'utf8');
const i0 = gsrc.indexOf('class LineRuntime');
let d = 0, cls = null;
for (let k = gsrc.indexOf('{', i0); k < gsrc.length; k++) {
  if (gsrc[k] === '{') d++;
  else if (gsrc[k] === '}') { d--; if (!d) { cls = gsrc.slice(i0, k + 1); break; } }
}
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])), C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + cls + ')');

const id = process.argv[2] || 'l2';
if (!SH.LINES[id]) { console.log('没有这条线：' + id + '；可选 ' + Object.keys(SH.LINES).join(' ')); process.exit(1); }
const line = new LineRuntime(SH.LINES[id]);
const S = line.al.stationS;
/* `line.stations` 是**站名数组**（不是对象数组）—— 写 `st.name` 会静默拿到
   undefined，于是这个工具看起来"查不到站名"，而里程全对。 */
line.stations.forEach((name, i) =>
  console.log(String(i).padStart(3), String(S[i].toFixed(1)).padStart(9),
    '侧 ' + (line.stationSide(i) > 0 ? '右' : '左'), name));