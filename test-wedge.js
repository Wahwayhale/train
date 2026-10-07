/**
 * 楔形三角形探测。
 * 一个横跨几公里的三角形不会报错，只会在画面里变成一片切过天空的怪膜：
 * 超长三角形上的顶点插值（雾 / 光照 / UV）完全失真，它的边还能抬到地平线以上。
 * 所以这里不看 material 的包围盒（那只反映整段世界有多大），
 * 而是逐个三角形算最长边，把超过阈值的挑出来。
 *
 * 用法：node test-wedge.js [线路id] [阈值m]     默认 l6 / 300
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) require('./src/' + f + '.js');
require('./data/shanghai.js');
/* VIEWSPOTS 是 game.js 惰性派生的，源码抠不出来 —— 装上 game.js 用运行时对象 */
require('./src/game.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (n) => { const i = src.indexOf('class ' + n); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const grabConst = (n) => { const i = src.indexOf('const ' + n); const j = src.indexOf('{', i); let d = 0; for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const MODES = { manual: { name: 'a' }, semi: { name: 'b' }, auto: { name: 'c' } };
Object.assign(global, {
  CAR_GAP: 0.35, MODES, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
});
const VIEWSPOTS = global.SH.VIEWSPOTS;
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const lineId = process.argv[2] || 'l6';
const LIMIT = +(process.argv[3] || 300);
const WIDE = +(process.argv[4] || 25);   // 面片"宽度"下限：比这更窄的是构件，不是面
/* 可只量一个里程窗口（模拟真实的一个烘焙区间）：SPAN=12000:15000 */
const win = (process.env.SPAN || '').split(':').map(Number);
const WS0 = win.length > 0 && isFinite(win[0]) ? win[0] : 0;
const WS1 = win.length > 1 && isFinite(win[1]) ? win[1] : Infinity;
const line = new LineRuntime(SH.LINES[lineId]);
const al = line.al;

/* 复刻 World.bake 的切片逻辑（不碰 GL），把整条线路一次烘完 */
const wb = new SH.WorldBuilder({
  al, color: line.color, color2: line.color2, stations: line.stations,
  sign: new SH.textures.SignAtlas(512), night: 0.62, profile: line.profile,
});
wb.sun = null; wb._installLight();
const b = wb.b;
/* 与游戏侧 bake 同一份几何序列（SH.WorldBuilder.buildRuns），不再各自复刻 */
SH.WorldBuilder.buildRuns(wb, line, WS0, Math.min(al.total, WS1), null);
for (const sp of (VIEWSPOTS[lineId] || [])) {
  const ss = line.stationSAt(sp.i);
  if (ss == null) { console.log(`  跳过 ${sp.kind}@${sp.i}：无里程`); continue; }
  if (!line.isElevated(ss)) { console.log(`  跳过 ${sp.kind}@${sp.i}：s=${Math.round(ss)} 不在高架段`); continue; }
  const res = SH.landmarks.place(b, al, ss, sp.side == null ? 1 : sp.side, sp.dist == null ? 900 : sp.dist, sp.kind);
  console.log(`  放置 ${sp.kind}@${sp.i} s=${Math.round(ss)} side=${sp.side} dist=${sp.dist} → ${res ? 'ok' : 'FAIL'}`);
}

/* 单遍扫描：发现超长三角形立刻打印，不做任何"先记下再打印"的二次搬运。
   （之前的版本把 per-mesh 最大值和 per-triangle 记录分开存，
     两边对不上，报了半天的"24 km 三角形"其实是脚本自己的错。） */
const perMat = new Map();
let tris = 0, verts = 0, badN = 0, printed = 0;
const f3 = v => '(' + v.map(x => x.toFixed(1)).join(',') + ')';
for (const g of b.finish()) {
  const P = g.pos, IDX = g.idx;
  verts += g.verts; tris += g.count / 3;
  if (!IDX || IDX.length !== g.count) { console.log('索引长度不符', g.mat, IDX && IDX.length, g.count); continue; }
  for (let t = 0; t < g.count; t += 3) {
    const a = IDX[t], c = IDX[t + 1], d = IDX[t + 2];
    const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const B = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const C = [P[d * 3], P[d * 3 + 1], P[d * 3 + 2]];
    const e = Math.max(Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]),
      Math.hypot(B[0] - C[0], B[1] - C[1], B[2] - C[2]),
      Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]));
    /* 只追究"又大又宽"的面片。斜拉索、接触网、疏散平台这类细长构件天生
       几百米长、几十厘米宽，插值沿构件是准确的，不该报警；真正会出事的是
       既长又宽的地面/水面/墙面——雾是距离的指数函数，却只能按角点线性插值，
       画面上就是斜切亮带或一片"膜"。
       宽度必须取**对最长边的垂距**（= 2·面积 / 最长边）：
       拿任意一条边当底，一条 3 m 长的索截面配 900 m 长的斜边会算出几百米的
       "宽度"，把细长构件全部误报成大面片。 */
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const hgt = area2 / (e || 1);
    const isBad = e > LIMIT && hgt > WIDE;
    const cur = perMat.get(g.mat) || { max: 0, n: 0 };
    if (isBad && e > cur.max) cur.max = e;
    if (isBad) {
      cur.n++; badN++;
      if (printed++ < 6) console.log(`  大面片 ${g.mat} i=${a},${c},${d} 长=${Math.round(e)} 宽=${Math.round(hgt)} m  A=${f3(A)} B=${f3(B)} C=${f3(C)}`);
    }
    perMat.set(g.mat, cur);
  }
}
const rank = [...perMat.entries()].sort((x, y) => y[1].max - x[1].max);
console.log(`
${lineId}: ${line.stations.length} 站 / ${(al.total / 1000).toFixed(1)} km —— 三角 ${Math.round(tris).toLocaleString()}，顶点 ${verts.toLocaleString()}`);
console.log(`大面片（最长边 > ${LIMIT} m 且 宽 > ${WIDE} m）按材质 Top6：`);
for (const [m, v] of rank.slice(0, 6)) console.log(`  ${m.padEnd(11)} 最长 ${Math.round(v.max).toLocaleString().padStart(6)} m   大面片 ${v.n}`);
console.log(badN ? `  ✗ 大面片合计 ${badN.toLocaleString()}` : '  ✓ 无超大面片（细长构件不计）');
process.exitCode = badN ? 1 : 0;
