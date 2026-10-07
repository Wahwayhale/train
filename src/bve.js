/* ============================================================================
 * bve.js — BVE / OpenBVE **CSV 列车模型**加载器
 *
 * 为什么要有它：用户给了 1 号线的列车模型（`assets/l1train/`，BVE 格式），
 * 要求"原封不动地搬过来"。BVE 的 `.csv` 是一种很朴素的建模脚本：
 * 一条命令一行、逗号分隔，顶点 + 面 + 贴图坐标 + 几个图元，全部坐标是
 * "以轨道中心为原点、y 向上、z 沿车长"的右手系 —— 与本项目的列车坐标系同源
 * （本项目的车也是 z 沿车长、y 从轨面算），所以**不需要换轴**。
 *
 * 支持的命令（按本项目模型实际用到的 15 条，见 README 第 146 条）：
 *   CreateMeshBuilder / AddVertex / AddFace / AddFace2 / SetTextureCoordinates /
 *   LoadTexture / SetColor / SetDecalTransparentColor / GenerateNormals /
 *   Translate / Rotate / Scale / Cylinder / Cube / TranslateAll / RotateAll
 *
 * 三条容易踩的语义（都是从模型数据里反推出来的，不是猜的）：
 *   ① `Translate` / `Rotate` / `Scale` 作用于**当前子网格已经加入的顶点**
 *      （模型里的顺序是"先 AddVertex 或 Cylinder，再 Rotate，最后 Translate"）；
 *   ② `SetColor` 作用于**当前子网格的全部面**（模型里 Cylinder 之后才 SetColor，
 *      若只影响后续面，那些圆柱就没有颜色）；
 *   ③ `Cylinder,seg,r1,r2,h` 的轴是 **Y**（模型里车轮是 `Rotate,0,0,1,90` 把 Y 转到 X
 *      才横过来的）；`Cube,x,y,z` 是**以原点为中心的尺寸**，不是两个角点。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;

const num = (s, d) => { const v = parseFloat(s); return isFinite(v) ? v : (d || 0); };
/** 角度制旋转：把 v 绕单位轴 (ax,ay,az) 转 deg 度 */
function rotAxis(v, ax, ay, az, deg) {
  const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const [x, y, z] = v;
  return [
    (t * ax * ax + c) * x + (t * ax * ay - s * az) * y + (t * ax * az + s * ay) * z,
    (t * ax * ay + s * az) * x + (t * ay * ay + c) * y + (t * ay * az - s * ax) * z,
    (t * ax * az - s * ay) * x + (t * ay * az + s * ax) * y + (t * az * az + c) * z,
  ];
}

/** 一个子网格：顶点（含可选法向）、面（顶点索引表）、逐面颜色与双面标记 */
function newMesh() { return { tex: null, v: [], nrm: [], uv: [], f: [], fc: [], fd: [], col: [1, 1, 1] }; }

/** 往当前子网格加一个四边形（自带 UV 的图元用） */
function quadRaw(m, p0, p1, p2, p3, uvs) {
  const base = m.v.length;
  for (const p of [p0, p1, p2, p3]) { m.v.push(p); m.nrm.push(null); }
  for (const q of uvs) m.uv.push(q);
  m.f.push([base, base + 1, base + 2, base + 3]); m.fc.push(m.col); m.fd.push(false);
}

/**
 * 解析一份 BVE CSV 文本 → 子网格数组。
 * @param text  文件内容
 * @param opt   { texBase: 'assets/l1train/' }（只用来给贴图名补扩展名，见 emit）
 */
function parse(text) {
  const meshes = [];
  let m = null;
  const flush = () => { if (m && m.v.length) meshes.push(m); m = null; };
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.split(',').map(s => s.trim());
    const c = (f[0] || '').toLowerCase();
    if (!c || c[0] === ';') continue;
    switch (c) {
      case 'createmeshbuilder': flush(); m = newMesh(); break;
      case 'addvertex':
        if (!m) break;
        m.v.push([num(f[1]), num(f[2]), num(f[3])]);
        m.nrm.push(f.length > 6 && f[4] !== '' ? [num(f[4]), num(f[5]), num(f[6])] : null);
        break;
      case 'addface': case 'addface2': {
        if (!m) break;
        const idx = [];
        for (let i = 1; i < f.length; i++) { if (f[i] === '') break; const k = parseInt(f[i], 10); if (isFinite(k)) idx.push(k); }
        if (idx.length >= 3) { m.f.push(idx); m.fc.push(m.col); m.fd.push(c === 'addface2'); }
        break;
      }
      case 'settexturecoordinates': {
        if (!m) break;
        const k = parseInt(f[1], 10);
        if (isFinite(k)) m.uv[k] = [num(f[2]), num(f[3])];
        break;
      }
      case 'loadtexture': if (m) m.tex = (f[1] || '').toLowerCase(); break;
      case 'setcolor':
        if (m) m.col = [num(f[1]) / 255, num(f[2]) / 255, num(f[3]) / 255];
        break;
      case 'setdecaltransparentcolor': /* 色键透明：本轮不做抠色，记着（见 README 146 的欠账） */ break;
      case 'generatenormals': /* 法向由面绕序算（emit 里做） */ break;
      case 'translate':
        if (m) { const d = [num(f[1]), num(f[2]), num(f[3])]; for (const p of m.v) { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; } }
        break;
      case 'rotate':
        if (m) { const ax = num(f[1]), ay = num(f[2]), az = num(f[3]), dg = num(f[4]); for (const p of m.v) { const q = rotAxis(p, ax, ay, az, dg); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; } }
        break;
      case 'scale':
        if (m) { const sx = num(f[1], 1), sy = num(f[2], 1), sz = num(f[3], 1); for (const p of m.v) { p[0] *= sx; p[1] *= sy; p[2] *= sz; } }
        break;
      case 'translateall': {
        const d = [num(f[1]), num(f[2]), num(f[3])];
        for (const mm of meshes) for (const p of mm.v) { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; }
        if (m) for (const p of m.v) { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; }
        break;
      }
      case 'rotateall': {
        const ax = num(f[1]), ay = num(f[2]), az = num(f[3]), dg = num(f[4]);
        for (const mm of meshes) for (const p of mm.v) { const q = rotAxis(p, ax, ay, az, dg); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; }
        if (m) for (const p of m.v) { const q = rotAxis(p, ax, ay, az, dg); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; }
        break;
      }
      case 'cube': {
        if (!m) break;
        const hx = num(f[1]) / 2, hy = num(f[2]) / 2, hz = num(f[3]) / 2;
        const V = (a, b, c2) => [a, b, c2];
        /* 六面，各自 0..1 的 UV（Cube 用的贴图是专属小图） */
        const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
        quadRaw(m, V(-hx, -hy, hz), V(hx, -hy, hz), V(hx, hy, hz), V(-hx, hy, hz), U);
        quadRaw(m, V(hx, -hy, -hz), V(-hx, -hy, -hz), V(-hx, hy, -hz), V(hx, hy, -hz), U);
        quadRaw(m, V(-hx, -hy, -hz), V(-hx, -hy, hz), V(-hx, hy, hz), V(-hx, hy, -hz), U);
        quadRaw(m, V(hx, -hy, hz), V(hx, -hy, -hz), V(hx, hy, -hz), V(hx, hy, hz), U);
        quadRaw(m, V(-hx, hy, hz), V(hx, hy, hz), V(hx, hy, -hz), V(-hx, hy, -hz), U);
        quadRaw(m, V(-hx, -hy, -hz), V(hx, -hy, -hz), V(hx, -hy, hz), V(-hx, -hy, hz), U);
        break;
      }
      case 'cylinder': {
        if (!m) break;
        const seg = Math.max(3, Math.round(num(f[1], 8)));
        const r1 = num(f[2]), r2 = num(f[3]), h = num(f[4]);
        const V = (r, a, y) => [r * Math.cos(a), y, r * Math.sin(a)];
        const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
        for (let i = 0; i < seg; i++) {
          const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
          quadRaw(m, V(r1, a0, -h / 2), V(r1, a1, -h / 2), V(r2, a1, h / 2), V(r2, a0, h / 2), U);
        }
        for (let i = 0; i < seg; i++) {                       // 两个端盖（扇形三角）
          const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
          const base = m.v.length;
          m.v.push([0, -h / 2, 0], V(r1, a0, -h / 2), V(r1, a1, -h / 2));
          for (let k = 0; k < 3; k++) { m.nrm.push(null); m.uv.push(U[k]); }
          m.f.push([base, base + 1, base + 2]); m.fc.push(m.col); m.fd.push(false);
          const b2 = m.v.length;
          m.v.push([0, h / 2, 0], V(r2, a1, h / 2), V(r2, a0, h / 2));
          for (let k = 0; k < 3; k++) { m.nrm.push(null); m.uv.push(U[k]); }
          m.f.push([b2, b2 + 1, b2 + 2]); m.fc.push(m.col); m.fd.push(false);
        }
        break;
      }
      default: break;   // 未支持的命令：忽略（不猜语义）
    }
  }
  flush();
  return meshes;
}

/**
 * 把子网格写进 Builder。
 * @param b       Builder
 * @param meshes  parse() 的结果
 * @param opt     { mirror: 1|-1  镜像 x（对向车用）, xf: [sx,sy,sz,dy,dz] 车体级变换 }
 * @return        写进去的三角形数
 */
function emit(b, meshes, opt) {
  opt = opt || {};
  const mirror = opt.mirror || 1;
  const xf = opt.xf;
  let tris = 0;
  for (const m of meshes) {
    const mat = 'bve:' + (m.tex || 'none');
    const bkt = b._bucket(mat);
    const base = bkt.n;
    const P = i => {
      let [x, y, z] = m.v[i];
      x *= mirror;
      if (xf) { x = x * xf[0] + xf[3]; y = y * xf[1] + xf[4]; z = z * xf[2] + xf[5]; }
      return [x, y, z];
    };
    for (let i = 0; i < m.v.length; i++) {
      const p = P(i), n = m.nrm[i], uv = m.uv[i] || [0, 0];
      /* 颜色取子网格的**最终** `SetColor`（`m.col`），不是"加第一张面时的颜色" ——
         模型的写法是"先 AddFace / Cylinder，最后才 SetColor"，取首面颜色会拿到
         默认的白，整列车丢掉涂装（BVE 的贴图是灰度细节图，颜色全在 SetColor 里）。 */
      b.vtx(bkt, p[0], p[1], p[2], n ? n[0] * mirror : 0, n ? n[1] : 1, n ? n[2] : 0,
        uv[0], uv[1], m.col, 0);
    }
    for (let fi = 0; fi < m.f.length; fi++) {
      const idx = m.f[fi].map(k => base + k);
      const col = m.fc[fi] || m.col;
      /* 面法向：按绕序算（`GenerateNormals` 的等价物） */
      const p0 = P(m.f[fi][0]), p1 = P(m.f[fi][1]), p2 = P(m.f[fi][2]);
      let nx = (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]);
      let ny = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
      let nz = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      /* 没给逐顶点法向的（图元）用面法向补齐 —— 否则 vtx 会收到 (0,1,0) 的假法向，
         端盖与侧壁的明暗关系全错 */
      for (const k of m.f[fi]) if (!m.nrm[k]) { const o = (base + k); bkt.nrm[o * 3] = nx; bkt.nrm[o * 3 + 1] = ny; bkt.nrm[o * 3 + 2] = nz; }
      for (let t = 1; t + 1 < idx.length; t++) {
        bkt.idx.push(idx[0], idx[t], idx[t + 1]); tris++;
        if (m.fd[fi]) { bkt.idx.push(idx[0], idx[t + 1], idx[t]); tris++; }
      }
      void col;
    }
  }
  if (b.stats) b.stats.tris += tris;
  return tris;
}

/** CSV 里的贴图名（如 `side1.bmp`）→ 本项目里的贴图 key 与 URL。
 *  key 与材质名 `bve:<贴图名>` 分开：材质名要能唯一标识"哪张图"，而 GL 纹理名
 *  用 `bve_` 前缀（`texFromImage` 建的）。 */
function texInfo(name) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  return { key: 'bve_' + base, url: 'assets/l1train/' + base + '.png' };
}
/** 一组子网格用到的全部贴图名 */
function texNames(meshes) {
  const s = new Set();
  for (const m of meshes) if (m.tex) s.add(m.tex);
  return [...s];
}
/** 把模型的车体包围盒在 z 上居中（模型的 z=0 在车尾，本项目的车以车心为 0） */
function zCenter(meshes) {
  let z0 = Infinity, z1 = -Infinity;
  for (const m of meshes) for (const v of m.v) { if (v[2] < z0) z0 = v[2]; if (v[2] > z1) z1 = v[2]; }
  return isFinite(z0) ? -(z0 + z1) / 2 : 0;
}

SH.bve = { parse, emit, texInfo, texNames, zCenter };
})(typeof window !== 'undefined' ? window : globalThis);
