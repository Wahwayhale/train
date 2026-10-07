/* 一次性诊断：跨江机位的 waterRanges 与高架桥墩的落位对不对得上。
   起因：线形加了缓和曲线之后里程整体位移，test-shot 的河床判据抓到
   l5 有一根混凝土墩从梁底扎到水面以下（"桥墩打到江心"这一族的老症状）。 */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic', 'landmark']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, {
  CAR_GAP: 0.35, MODES: {}, Builder: SH.Builder, Geo: SH.Geo, VIEWSPOTS: SH.VIEWSPOTS,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
});
const LR = eval('(' + grab('LineRuntime') + ')');
/* game.js 不能直接 require（顶层摸 DOM），观景点表就从源码里把字面量抠出来 */
const VS = eval('(' + (src.match(/const VIEWSPOTS = (\{[\s\S]*?\n\});/) || [, '{}'])[1] + ')');
global.VIEWSPOTS = VS;
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['l5'];
for (const id of ids) {
  const line = new LR(SH.LINES[id]);
  const wr = line.waterRanges();
  console.log('\n== ' + line.name + '  total=' + Math.round(line.al.total) + ' m');
  console.log('   waterRanges:', JSON.stringify(wr.map(r => r.map(x => Math.round(x)))));
  for (const sp of (VS[id] || [])) {
    if (!SH.landmarks.CROSS_KINDS[sp.kind]) continue;
    const ss = line.stationSAt(sp.i);
    const inR = wr.some(r => ss >= r[0] && ss <= r[1]);
    console.log('   ' + sp.kind + ' @' + (ss == null ? 'null' : Math.round(ss)) + ' 名=' + (Array.isArray(sp.i) ? sp.i.join('/') : line.stations[sp.i]) + '  落在 range 内=' + inR);
  }
  /* 桥墩落位：viaduct() 每 26 m 一根，跳过 waterRanges 内的里程 */
  const piers = [];
  for (let s = Math.ceil(0 / 26) * 26; s < line.al.total; s += 26) {
    if (line.isElevated(s)) piers.push(s);
  }
  for (const r of wr) {
    const near = piers.filter(s => Math.abs(s - (r[0] + r[1]) / 2) < 900);
    console.log('   range ' + Math.round(r[0]) + '~' + Math.round(r[1]) + ' 内外 900 m 的高架里程数=' + near.length
      + (near.length ? '  例:' + near.slice(0, 6).map(s => Math.round(s)).join(',') : ''));
    const inside = near.filter(s => s > r[0] - 3 && s < r[1] + 3).length;
    console.log('     其中落在 range 内（会被跳过）=' + inside);
  }
}
