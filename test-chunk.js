/**
 * 分片正确性单测：同一个 bucket 在"不分片"与"分片"两种路径下，
 * 必须还原出完全相同的三角形集合（顶点位置 + 索引语义）。
 * 这里用 2 万个独立小盒（每个 24 顶点）把桶撑到 48 万顶点，
 * 触发分片，然后逐三角形比对。
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio']) require('./src/' + f + '.js');
const SH = global.SH;

function build(n, seed) {
  const b = new SH.Builder();
  const R = SH.rng(seed);
  for (let i = 0; i < n; i++) {
    const x = (R() - 0.5) * 9000, y = (R() - 0.5) * 300, z = (R() - 0.5) * 9000;
    b.box([x, y, z], [3 + R() * 9, 4 + R() * 20, 3 + R() * 9], [0.5, 0.5, 0.5], { mat: 'concrete' });
  }
  return b;
}
/* 把三角形规范化成"排序后的三顶点坐标字符串"，这样与顶点编号无关，
   只比较几何本身是否被完整、正确地重建。 */
function triSet(meshes) {
  const set = [];
  for (const g of meshes) {
    const P = g.pos, I = g.idx;
    for (let t = 0; t < g.count; t += 3) {
      const p = [I[t], I[t + 1], I[t + 2]].map(v => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]].map(x => Math.fround(x).toFixed(3)).join(','));
      set.push(p.sort().join('|'));
    }
  }
  set.sort();
  return set;
}
/** 参照集直接从 bucket 的原始数组算，不走 _pack —— 因为 _pack 会把索引塞进
 *  Uint16Array，而"不分片"的参照集本身就有 19 万顶点，索引会绕回 65536 取模，
 *  于是参照集反而是错的（这一点值得记住：Uint16 索引上限就是 65535）。 */
function triSetRaw(bs) {
  const set = [];
  for (let t = 0; t < bs.idx.length; t += 3) {
    const p = [bs.idx[t], bs.idx[t + 1], bs.idx[t + 2]].map(v =>
      [bs.pos[v * 3], bs.pos[v * 3 + 1], bs.pos[v * 3 + 2]].map(x => Math.fround(x).toFixed(3)).join(','));
    set.push(p.sort().join('|'));
  }
  set.sort();
  return set;
}
function maxEdge(meshes) {
  let mx = 0, at = null;
  for (const g of meshes) {
    const P = g.pos, I = g.idx;
    for (let t = 0; t < g.count; t += 3) {
      const v = [I[t], I[t + 1], I[t + 2]].map(i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      const e = Math.max(Math.hypot(...v[0].map((x, k) => x - v[1][k])), Math.hypot(...v[1].map((x, k) => x - v[2][k])), Math.hypot(...v[2].map((x, k) => x - v[0][k])));
      if (e > mx) { mx = e; at = { v, verts: g.verts }; }
    }
  }
  return { mx, at };
}

const N = +(process.argv[2] || 20000);
const bRef = build(N, 11), bs = bRef.buckets.get('concrete');
const ref = triSetRaw(bs);                                 // 原始几何（不经 Uint16 索引）
const got = triSet(build(N, 11).finish());                   // 实际路径（会分片）
console.log('不分片三角形', ref.length, ' 分片三角形', got.length);
let diff = 0, first = null;
for (let i = 0; i < Math.max(ref.length, got.length); i++) {
  if (ref[i] !== got[i]) { diff++; if (!first) first = i; }
}
console.log(diff ? `✗ 第 ${first} 个三角形起不一致` : '✓ 分片前后几何完全一致');
const me = maxEdge(build(N, 11).finish());
console.log('分片后最长边', Math.round(me.mx), 'm（盒子的对角线量级，应为几十米）');
process.exitCode = (diff || me.mx > 120) ? 1 : 0;
