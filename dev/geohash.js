/* 烘焙几何指纹（重构安全网）。
 *
 * 为什么要有它：岛式站台这类重构要动 `station()` 里几十处横向摆位，而"这一步
 * 不应该改变任何现有画面"这种话，靠 18 个判据是证不了的 —— 判据只断言它关心的
 * 那些不变量，剩下的自由度（比如一块板往左 2 cm）它本来就不看。大改之前先存一份
 * 指纹，改完再存一份，**逐材质哈希相同才算"没动到别的"**。
 *
 * 用法：
 *   node dev/geohash.js                 # 默认三条代表线（地下/高架/支线各有）
 *   node dev/geohash.js l1 l2 ml        # 指定线路
 *   node dev/geohash.js --save 基线名   # 写 dev/geohash-<基线名>.json
 *   node dev/geohash.js --diff 基线名   # 与基线逐材质对比，不同就报红并退出 1
 */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark', 'traffic', 'street']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;
const fs = require('fs');
const gsrc = fs.readFileSync(__dirname + '/../src/game.js', 'utf8');
const grab = name => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const argv = process.argv.slice(2);
const saveAt = argv.indexOf('--save'), diffAt = argv.indexOf('--diff');
const tag = saveAt >= 0 ? argv[saveAt + 1] : (diffAt >= 0 ? argv[diffAt + 1] : null);
const ids = argv.filter((a, i) => !a.startsWith('--') && !(diffAt >= 0 && i === diffAt + 1) && !(saveAt >= 0 && i === saveAt + 1));
if (tag && !/^[A-Za-z0-9_-]+$/.test(tag)) { console.log('✗ 基线名只许字母数字下划线'); process.exit(1); }
const LIST = ids.length ? ids : ['l1', 'l2', 'l9'];

/** FNV-1a 32 位，逐 1e-4 量化：浮点位序不该进指纹，几何该。 */
function fnv(seed, v) {
  let h = seed >>> 0;
  const x = (Math.round(v * 1e4) + 2147483647) | 0;
  for (let b = 0; b < 4; b++) { h ^= (x >> (b * 8)) & 255; h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function hashMesh(m) {
  let hp = 2166136261, hc = 2166136261, hn = 2166136261;
  for (let i = 0; i < m.pos.length; i++) hp = fnv(hp, m.pos[i]);
  if (m.col) for (let i = 0; i < m.col.length; i++) hc = fnv(hc, m.col[i]);
  if (m.nor) for (let i = 0; i < m.nor.length; i++) hn = fnv(hn, m.nor[i]);
  return { pos: hp, col: hc, nor: hn };
}
function bake(line, def) {
  const sign = new SH.textures.SignAtlas(2048);
  const w = new SH.WorldBuilder({ al: line.al, color: def.color, stations: def.stations, sign, night: 0.62, profile: line.profile });
  w.ambient = [0.26, 0.29, 0.36]; w.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; w._installLight();
  SH.WorldBuilder.buildRuns(w, line, 0, line.al.total, null);
  const acc = {};
  for (const m of w.b.finish()) {
    const a = acc[m.mat] || (acc[m.mat] = { n: 0, verts: 0, p: 2166136261, c: 2166136261, q: 2166136261 });
    const h = hashMesh(m);
    a.n++; a.verts += m.pos.length / 3;
    a.p = (a.p * 31 + h.pos) >>> 0; a.c = (a.c * 31 + h.col) >>> 0; a.q = (a.q * 31 + h.nor) >>> 0;
  }
  return acc;
}
const out = {};
for (const id of LIST) {
  const def = SH.LINES[id];
  if (!def) { console.log(`✗ 没有线路 ${id}`); process.exit(1); }
  const line = new LineRuntime(def);
  const t0 = Date.now();
  const acc = bake(line, def);
  out[id] = acc;
  const mats = Object.keys(acc).sort();
  const verts = mats.reduce((a, k) => a + acc[k].verts, 0);
  console.log(`${id} ${def.name}：${mats.length} 个材质、${verts} 个顶点、${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const k of mats) console.log(`   ${k.padEnd(11)} n=${String(acc[k].n).padStart(5)} v=${String(acc[k].verts).padStart(8)} pos=${acc[k].p.toString(16)} col=${acc[k].c.toString(16)} nor=${acc[k].q.toString(16)}`);
}
const file = __dirname + '/geohash-' + (tag || '') + '.json';
if (saveAt >= 0) { fs.writeFileSync(file, JSON.stringify(out, null, 1)); console.log(`✓ 指纹已存 ${file}`); }
if (diffAt >= 0) {
  if (!fs.existsSync(file)) { console.log(`✗ 基线不存在：${file}`); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  let dif = 0;
  for (const id of Object.keys(out)) {
    const b = base[id];
    if (!b) { console.log(`? ${id} 不在基线里`); continue; }
    for (const k of Object.keys(out[id])) {
      const o = out[id][k], x = b[k];
      if (!x) { dif++; console.log(`✗ ${id}/${k}：新出现的材质`); continue; }
      if (o.p !== x.p || o.c !== x.c || o.q !== x.q || o.verts !== x.verts) {
        dif++;
        console.log(`✗ ${id}/${k}：几何或颜色变了（顶点 ${x.verts} → ${o.verts}，pos ${x.p.toString(16)} → ${o.p.toString(16)}，col ${x.c.toString(16)} → ${o.c.toString(16)}）`);
      }
    }
    for (const k of Object.keys(b)) if (!out[id][k]) { dif++; console.log(`✗ ${id}/${k}：基线里有、现在没了`); }
  }
  console.log(dif ? `\n✗ 与基线 ${tag} 有 ${dif} 处不同 —— 这次改动动了它声称不该动的几何` : `\n✓ 与基线 ${tag} 逐材质指纹完全一致（这一步没改变任何既有几何）`);
  process.exit(dif ? 1 : 0);
}
