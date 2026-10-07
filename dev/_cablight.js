/* 临时分析：定位司机室过曝顶点的热点（test-bake 判据的同款量测 + 位置分桶） */
require('../stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax']) require('../src/' + f + '.js');
require('../data/shanghai.js');
const SH = global.SH;
const gsrc = require('fs').readFileSync(__dirname + '/../src/game.js', 'utf8');
const grab = (name) => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
for (const id of ['l5', 'l6', 'l8', 'ph']) {
  const p = new LineRuntime(SH.LINES[id]).profile;
  const tv = new SH.train.TrainView(p, {});
  const zMin = p.headLen / 2 - 5.0;
  const hot = {};
  let cn = 0, clip = 0;
  for (const m of [].concat(tv.cab)) {
    for (let i = 0; i < m.verts; i++) {
      if (m.pos[i * 3 + 2] < zMin) continue;
      const e = m.emi[i] / 255 * 2.5;
      const lamp = m.mat === 'light' || m.mat === 'emissive';
      const base = Math.max(m.col[i * 3], m.col[i * 3 + 1], m.col[i * 3 + 2]) / 255 * 2;
      const add = base * e * 2.05;
      if (!lamp && m.pos[i * 3 + 1] < p.roofY - 0.25) {
        cn++;
        if (add > 1.0) {
          clip++;
          const key = 'y' + m.pos[i * 3 + 1].toFixed(2) + ' z' + m.pos[i * 3 + 2].toFixed(2) + ' x' + m.pos[i * 3].toFixed(2)
            + ' ' + m.mat + ' base' + base.toFixed(2) + ' e' + e.toFixed(2);
          hot[key] = (hot[key] || 0) + 1;
        }
      }
    }
  }
  console.log(id, 'clip', clip, '/', cn, '=', (100 * clip / cn).toFixed(1) + '%');
  const arr = Object.entries(hot).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [k, v] of arr) console.log('   ', String(v).padStart(3), k);
}
