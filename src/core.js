/* ============================================================================
 * 上海地铁驾驶模拟器 · SHMETRO
 * core.js — 命名空间、线性代数、确定性随机、颜色与几何小工具
 * 零依赖。所有模块通过 window.SH 挂载。
 * ==========================================================================*/
(function (global) {
'use strict';

const SH = global.SH = { VERSION: '1.0.0' };
const TAU = Math.PI * 2, DEG = Math.PI / 180;

/* ---------------------------------------------------------------- 标量工具 */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / rate));
const sign = Math.sign || (v => v < 0 ? -1 : v > 0 ? 1 : 0);
/** 最短角差，结果落在 (-π, π] */
function angDelta(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

/* ------------------------------------------------------- 确定性随机 (mulberry32) */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 由字符串派生 32 位种子（FNV-1a） */
function hash32(str, seed) {
  let h = ((seed || 0) ^ 2166136261) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** 稳定地由 (key, i) 取 [0,1) 伪随机，用于场景布置 */
function rand01(key, i) {
  const r = rng(hash32(String(key), (i | 0) + 17));
  r(); return r();
}

/* ------------------------------------------------------------------ 颜色 */
const _hexCache = new Map();
/** '#rgb' | '#rrggbb' -> [r,g,b] 浮点 0..1 */
function rgbOf(hexStr) {
  if (_hexCache.has(hexStr)) return _hexCache.get(hexStr);
  let s = String(hexStr || '#ffffff').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  const v = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  _hexCache.set(hexStr, v);
  return v;
}
/** 线性空间插值到 0..255 的 CSS 颜色 */
function mixHex(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b);
  const f = x => Math.round(clamp(x, 0, 1) * 255);
  return `rgb(${f(lerp(A[0], B[0], t))},${f(lerp(A[1], B[1], t))},${f(lerp(A[2], B[2], t))})`;
}
function shade(hexStr, k) {
  const A = rgbOf(hexStr), f = x => Math.round(clamp(x * k, 0, 1) * 255);
  return `rgb(${f(A[0])},${f(A[1])},${f(A[2])})`;
}
/** 把 [0,1] 颜色乘亮度后写进 RGBA 字节 */
function putColor(target, off, hexArr, brightness, alpha) {
  target[off] = clamp(hexArr[0] * brightness, 0, 1) * 255;
  target[off + 1] = clamp(hexArr[1] * brightness, 0, 1) * 255;
  target[off + 2] = clamp(hexArr[2] * brightness, 0, 1) * 255;
  target[off + 3] = alpha == null ? 255 : alpha;
}
/** sRGB 近似伽马校正（用于让暗部不死黑） */
function gamma(v) { return Math.pow(clamp(v, 0, 1), 0.86); }

/* ---------------------------------------------------------------- 向量 */
const V3 = {
  create: (x, y, z) => [x || 0, y || 0, z || 0],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: function (a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

/* --------------------------------------------------------- 4x4 矩阵（列主序）
 * 与 gl-matrix / WebGL 约定一致：m[col*4+row]。
 * ------------------------------------------------------------------------*/
function mat4() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }

function m4mul(a, b, out) {
  out = out || new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4]     = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

function m4perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), o = mat4();
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf; o[15] = 0;
  return o;
}

function m4lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  let xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const o = mat4();
  o[0] = xx; o[1] = yx; o[2] = zx; o[4] = xy; o[5] = yy; o[6] = zy; o[8] = xz; o[9] = yz; o[10] = zz;
  o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  return o;
}

/** 刚体变换求逆（旋转 + 平移、无缩放）：R⁻¹ = Rᵀ，t⁻¹ = −Rᵀ·t。
 *  列主序存储（m[c*4+r]）。视图矩阵与车体矩阵都是刚体，用不上通用求逆。 */
function m4invertRigid(m) {
  const o = mat4();
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
  /* t' = −Rᵀ·t：Rᵀ 的第 r 行 = R 的第 r 列 = (m[r], m[r+4], m[r+8]) ——
     第一版写成 −R·t（m[0]m[12]+m[4]m[13]+m[8]m[14]），补偿残差爆出 8.9×10⁶ mm，
     是判据的空转自检（resF 必须 <0.1 mm）当场抓住的。 */
  o[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
  o[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
  o[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
  return o;
}

/** 司机室补偿矩阵（唯一实现）：S = V(抖动相机)⁻¹ · V(基准相机)。
 *  绘制司机室批次时预乘它 —— 骑行运动（平移/旋转/加速度俯仰）只摇"外面的世界"，
 *  台面、TCMS 屏、两只圆表与视线刚性绑定（玩家反馈：仪表屏别抖、车晃正常）。
 *  基准相机保留用户环视，所以 S 里只剩骑行 delta：转头时台面照常在画面里摆。 */
function cabFixMatrix(camStill, camShake) {
  const V0 = m4lookAt(camStill.eye, camStill.target, camStill.up || [0, 1, 0]);
  const V1 = m4lookAt(camShake.eye, camShake.target, (camShake && camShake.up) || [0, 1, 0]);
  return m4mul(m4invertRigid(V1), V0);
}

/** 由基向量构造刚体变换（列即局部坐标轴的世界方向） */
function m4basis(right, up, fwd, pos) {
  const o = mat4();
  o[0] = right[0]; o[1] = right[1]; o[2] = right[2];
  o[4] = up[0]; o[5] = up[1]; o[6] = up[2];
  o[8] = fwd[0]; o[9] = fwd[1]; o[10] = fwd[2];
  o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2];
  return o;
}

function m4trs(pos, scale, ry, rx, rz) {
  const cy = Math.cos(ry || 0), sy = Math.sin(ry || 0);
  const cx = Math.cos(rx || 0), sx = Math.sin(rx || 0);
  const cz = Math.cos(rz || 0), sz = Math.sin(rz || 0);
  // R = Ry * Rx * Rz
  const r00 = cy * cz + sy * sx * sz, r01 = -cy * sz + sy * sx * cz, r02 = sy * cx;
  const r10 = cx * sz,                r11 = cx * cz,                 r12 = -sx;
  const r20 = -sy * cz + cy * sx * sz, r21 = sy * sz + cy * sx * cz,  r22 = cy * cx;
  const sxv = scale[0], syv = scale[1], szv = scale[2], o = mat4();
  o[0] = r00 * sxv; o[1] = r10 * sxv; o[2] = r20 * sxv;
  o[4] = r01 * syv; o[5] = r11 * syv; o[6] = r21 * syv;
  o[8] = r02 * szv; o[9] = r12 * szv; o[10] = r22 * szv;
  o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2];
  return o;
}

/** 取矩阵的 3x3 逆转置（做法向变换用；此处假定均匀/非均匀缩放均可） */
function m3normalFromM4(m, out) {
  out = out || new Float32Array(9);
  const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
  const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) { out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0; out[8] = 1; return out; }
  det = 1.0 / det;
  /* 这是 gl-matrix 的 mat3.normalFromMat4：mat4/mat3 都是**列主序**，
   * 所以 out[0..2] 是结果矩阵的第 0 列（b01/b11/b21），out[3..5] 是第 1 列。
   * 这里以前抄成了"每列的三个元素分散写到 out[0]、out[3]、out[6]"，
   * 等于把逆转置又转了一次，得到的是**逆矩阵**而不是逆转置：
   * 对纯旋转来说就是 Rᵗ 而不是 R。后果分两处——
   *   · 运行时：任何带旋转的模型矩阵（列车各节车厢随曲线转向）法向被反向旋转，
   *     车身的日照与高光跟着曲线走形；
   *   · 烘焙：Builder.merge 用它变换地标法向，于是整批地标的法向与绕序对不上，
   *     test-wind.js 里表现为每个地标材质的三角形大面积"反向"。
   */
  out[0] = b01 * det; out[1] = b11 * det; out[2] = b21 * det;
  out[3] = (-a22 * a01 + a02 * a21) * det; out[4] = (a22 * a00 - a02 * a20) * det; out[5] = (-a21 * a00 + a01 * a20) * det;
  out[6] = (a12 * a01 - a02 * a11) * det; out[7] = (-a12 * a00 + a02 * a10) * det; out[8] = (a11 * a00 - a01 * a10) * det;
  return out;
}

/* --------------------------------------------------------------- 数值/曲线 */
/** 由点列做向心 Catmull-Rom 插值，返回 [x,y] 数组（步长 step 米） */
function catmullRom(pts, step) {
  step = step || 4;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const seg = Math.max(2, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < seg; k++) {
      const t = k / seg, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

/** 简易 1D 值噪声（用于建筑轮廓、云层、人群密度） */
function valueNoise1D(seed) {
  const table = new Float32Array(256);
  const r = rng(seed);
  for (let i = 0; i < 256; i++) table[i] = r();
  return function (x) {
    const i0 = Math.floor(x), f = x - i0;
    const a = table[((i0 % 256) + 256) % 256], b = table[(((i0 + 1) % 256) + 256) % 256];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

/** 分形叠加噪声 */
function fbm1(noise, x, oct) {
  let v = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < (oct || 4); i++) { v += noise(x * fr) * amp; fr *= 2; amp *= 0.5; }
  return v;
}

SH.TAU = TAU; SH.DEG = DEG;
SH.clamp = clamp; SH.lerp = lerp; SH.smoothstep = smoothstep; SH.approach = approach; SH.sign = sign; SH.angDelta = angDelta;
SH.rng = rng; SH.hash32 = hash32; SH.rand01 = rand01;
SH.rgbOf = rgbOf; SH.mixHex = mixHex; SH.shade = shade; SH.putColor = putColor; SH.gamma = gamma;
SH.V3 = V3;
/* 全线统一运营限速（km/h）。放在 core 是因为 game.js 的 limitAt、
   HUD 文案、选线卡片、司机说明都要引用同一个数，写死在两处就会不一致
   —— 本项目已经吃过三次"同一个量在两个文件里各有自己的常数"的亏。 */
SH.RUN_LIMIT_KMH = 70;
/* 街面高程基准（相对"平滑轨面"al.groundY 的 dy，米）。
   以前它是以字面量 −10.9 散在 world.js 的街面、出入口、桥墩与 game.js 的行人机位里，
   而跟随相机的远景地面与全部楼群用的是 `al.groundY(s) − 11`：一个是**局部轨面**、
   一个是**平滑轨面**，实测最多差到 3.5 m（3 号线 @1350 m）。差过 0.4 m，
   那张远景平面就把刚铺好的整条街连标线一起盖掉 —— street 机位里的"一片平地"。
   现在街面、出入口、墩底、行人机位统一读这一个数（配 Alignment.streetDy 用）。 */
SH.STREET_Y = -10.9;
/* ------------------------------------------------------------------ 道路断面
 * 街面烘焙（world.js）、车流车道中心（street.js）、公交停靠位三处必须读同一张表。
 * 立这条目的原因很具体：world.js 把车道虚线烘在 |横向| = 25 / 34.5 / 44，
 * 而 street.js 让车也跑在这三个数上 —— **每一辆车都正正地跨着一条虚线**，
 * 从高架驾驶室看下去，整条街的虚线是"从车身中间穿过去"的。
 * 虚线是分界，不是车道中心。所以这里只写**边界**，车道中心由相邻边界取中点算出来：
 * 挪任何一条边界，车道自动回到"两条线中间"，结构上不可能再对不上。 */
SH.ROAD = {
  half: 55,                 // 车行道沥青半宽
  median: 15.6,             // 中央绿化带的内缘（两侧对称）
  lines: [25, 34.5, 44],    // 车道虚线（烘焙位置）
  edge: 53,                 // 外缘白实线 = 机动车道与非机动车道的边线
  curb: 57,                 // 路缘石内缘
  /* 公交车站：候车亭在人行道（shelterLat）、站牌在路缘（signLat），
     相位与间隔必须与 street.js 的公交停靠点同源，否则"车停在了站外"。 */
  bus: { phase: 210, pitch: 380, signLat: 55.8, shelterLat: 60.4 },
};
/* 人行道的四条纵向参照（街面行人的可行带、街具的横向位置都靠它们框）：
   tree = 行道树所在（与 world.js 的 TREE_LAT 同一个数，现在只有这一份），
   lotLine = 沿街地块红线（CITY_BAND.min），围墙立在这条线的外侧一点点，
   lamp = 灯杆中心线（人行道内侧、铺装机理带里，不与树抢位），
   wall = 地块界围墙/护栏中心线 —— **人行道的内边界就是它**。
   判据要问"人行道的带有没有伸到车行道里/穿进楼里"，必须拿这些独立参照问，
   不能拿 streetBand 自己给的上下限验自己。 */
SH.STREET_WALK = { tree: 57.9, lotLine: 69.5, lamp: 63.2, wall: 65.0 };
SH.ROAD.bounds = [SH.ROAD.median].concat(SH.ROAD.lines, [SH.ROAD.edge]);
/** 车道中心 = 相邻边界的中点：15.6|25|34.5|44|53 → 20.3 / 29.75 / 39.25 / 48.5 */
SH.ROAD.lanes = SH.ROAD.bounds.slice(0, -1).map((b, i) => (b + SH.ROAD.bounds[i + 1]) / 2);
/** 公交靠最外侧车道 —— 与站亭同侧，并入外道即靠站 */
SH.ROAD.busLane = SH.ROAD.lanes[SH.ROAD.lanes.length - 1];
/* ------------------------------------------------------------------ 街区类型学
 * 「景色：根据上海每站真实场景特色」要的是**每一站**都有说得出的场景，
 * 而不是 491 站里 33 站有名地标。名地标那一层在 SH.STATION_FEATURES；
 * 这一层管剩下所有站的**街区性格**：楼多高、地块多密、行道树什么树种多远一棵。
 *
 * 分区靠站名里的真实地名学（toponymy）判：上海站名绝大多数是"路名/地名直取"，
 * 因此"衡山路/武康路/乌鲁木齐路"就是原法租界梧桐街区，"××新村/××公寓"是
 * 1950-90 年代的里弄与工人新村，"××渡/××浜/外滩"是滨水，"××开发区/钢厂/港区"
 * 是工业带，"松江新城/临港/顾村"是郊区新城高层，"佘山/滴水湖/野生动物园"是郊野。
 * 规则表**公开可查**，判据会数"落到兜底档"的站数 —— 兜底不是分类，
 * 它必须可见，否则"每站有特色"就又是一句文案。
 *
 * 参数含义（全部被 world.js 消费，不许在别处再抄一份数）：
 *   hLo/hHi  临街第一排与内侧塔楼的楼高区间（米）
 *   gap      沿街楼槽位间距（米）—— 越小越密（梧桐街区最密）
 *   crown    树冠半径 / pitch 行道树间距 / species 0 悬铃木(梧桐) 1 银杏 2 香樟 3 水杉
 *   roof     屋顶形式：flat 平屋顶 / pitch 坡顶(古镇) / step 阶梯退台(新区)
 *   pad      人行道铺装色（街面断面读它）
 *   lamp     路灯型式：st 0 弯臂(老租界/老城厢) 1 直杆挑臂 2 高杆多头(枢纽/工业)
 *            3 庭园矮杆(郊野)；h 杆高、arm 挑臂长、gap 间距（米）
 *   wall     地块界街具：garden 矮墙+铁栅 / brick 砖墙+门柱+弄口 / hedge 绿篱+矮柱 /
 *            rail 金属护栏 / fence 铁丝围栏 / none 敞开（郊野本来就没有围墙）
 *   shop     底商店招比例：临街第一排楼里有百分之多少长出店招+雨棚
 *            （淮海路/豫园一带几乎每间都铺，工业带几乎没有）
 */
SH.SCENE_ZONES = {
  wutong:     { label: '原租界梧桐街区', hLo: [7, 15],  hHi: [16, 30],  gap: 13, crown: 3.6, pitch: 10, species: 0, roof: 'flat',  pad: '#8e8378', lamp: { st: 0, h: 8.0, arm: 1.5, gap: 30 }, wall: 'garden', shop: 0.55, elev: 1 },
  lilong:     { label: '里弄与工人新村', hLo: [5, 10],  hHi: [10, 20],  gap: 12, crown: 2.6, pitch: 16, species: 2, roof: 'pitch', pad: '#9a9186', lamp: { st: 0, h: 6.8, arm: 1.1, gap: 32 }, wall: 'brick',  shop: 0.35, elev: 1 },
  blvd:       { label: '林荫大道与单位大院', hLo: [12, 24], hHi: [28, 54], gap: 18, crown: 4.2, pitch: 12, species: 2, roof: 'flat', pad: '#9fa6a3', lamp: { st: 1, h: 10.0, arm: 2.0, gap: 34 }, wall: 'hedge',  shop: 0.20, elev: 1 },
  waterfront: { label: '滨水岸线', hLo: [10, 22], hHi: [46, 88], gap: 21, crown: 4.6, pitch: 9,  species: 3, roof: 'step',  pad: '#a7a49c', lamp: { st: 1, h: 11.0, arm: 1.8, gap: 26 }, wall: 'rail',   shop: 0.30, elev: 0 },
  hub:        { label: '交通枢纽地区', hLo: [16, 30], hHi: [40, 72], gap: 20, crown: 3.0, pitch: 14, species: 2, roof: 'step', pad: '#a3a8ad', lamp: { st: 2, h: 14.0, arm: 2.6, gap: 40 }, wall: 'rail',   shop: 0.65, elev: 1 },
  campus:     { label: '大学园区', hLo: [10, 20], hHi: [20, 38], gap: 22, crown: 4.8, pitch: 11, species: 1, roof: 'flat',  pad: '#a09a90', lamp: { st: 1, h: 9.0, arm: 1.4, gap: 36 }, wall: 'hedge',  shop: 0.15, elev: 0 },
  industrial: { label: '工业带改造', hLo: [6, 12],  hHi: [12, 26],  gap: 26, crown: 3.2, pitch: 20, species: 2, roof: 'saw',   pad: '#8b8f92', lamp: { st: 2, h: 12.0, arm: 2.4, gap: 45 }, wall: 'fence',  shop: 0.05, elev: 1 },
  oldtown:    { label: '老城厢与古镇', hLo: [4, 9],   hHi: [7, 14],   gap: 11, crown: 2.4, pitch: 15, species: 0, roof: 'pitch', pad: '#8f8578', lamp: { st: 0, h: 6.2, arm: 0.9, gap: 24 }, wall: 'brick',  shop: 0.80, elev: 0 },
  suburb:     { label: '郊区新城高层', hLo: [24, 44], hHi: [44, 80],  gap: 19, crown: 3.8, pitch: 13, species: 1, roof: 'step',  pad: '#a8adb2', lamp: { st: 2, h: 13.0, arm: 2.2, gap: 38 }, wall: 'rail',   shop: 0.45, elev: 1 },
  farm:       { label: '郊野与林带', hLo: [4, 7],    hHi: [6, 13],    gap: 34, crown: 5.4, pitch: 26, species: 3, roof: 'pitch', pad: '#98937f', lamp: { st: 3, h: 6.0, arm: 0.0, gap: 55 }, wall: 'none',   shop: 0.00, elev: 0 },
  other:      { label: '（未分类·兜底）', hLo: [12, 22], hHi: [26, 48], gap: 17, crown: 3.6, pitch: 14, species: 2, roof: 'flat', pad: '#9fa6a3', lamp: { st: 1, h: 10.0, arm: 1.6, gap: 32 }, wall: 'rail', shop: 0.30, elev: 1 },
};
/** 街具型式表：`st` → 灯具数量与灯头形状。判据按这张表核对烘焙结果，
 *  不然"高杆灯"和"弯臂灯"只是两个名字。 */
SH.LAMP_FORMS = {
  0: { name: '弯臂灯', heads: 1, deck: 0.22 },
  1: { name: '直杆挑臂灯', heads: 1, deck: 0.20 },
  2: { name: '高杆双挑灯', heads: 3, deck: 0.26 },
  3: { name: '庭园矮杆灯', heads: 1, deck: 0.30 },
};
/** 地块界街具型式表：`h` = 墙体完成面高（米）、`gate` = 真挖开门洞的间距
 *  （里弄口，0=连续）、`unit` = 竖杆/矮柱间距（米）、
 *  `see` = 透空（true 时能从人行道看进院子）。world.js 按这张表建几何，
 *  test-scene.js 按同一张表核对烘焙顶点 —— 型式的"高度"必须是量得出来的。
 *  `top` = 这一档型式里最高那个构件的顶（门柱/过梁/矮柱），判据拿它核对。 */
SH.WALL_FORMS = {
  garden: { name: '矮墙+铁栅', h: 1.38, top: 1.38, gate: 0, unit: 2.4, see: true },
  brick:  { name: '砖墙+门柱弄口', h: 2.10, top: 2.71, gate: 30, unit: 0, see: false },
  hedge:  { name: '绿篱+矮柱', h: 1.00, top: 1.36, gate: 0, unit: 12, see: false },
  rail:   { name: '金属护栏', h: 1.08, top: 1.08, gate: 0, unit: 3.2, see: true },
  fence:  { name: '铁丝围栏', h: 2.20, top: 2.20, gate: 0, unit: 5, see: true },
  none:   { name: '敞开（无围墙）', h: 0, top: 0, gate: 0, unit: 0, see: true },
};

/* 规则表按顺序匹配，先具体后一般。每条都写清凭什么，方便逐条纠错。 */
const ZONE_RULES = [
  ['waterfront', /(外滩|陆家嘴|滨江|沿江|江路|江畔|浦江|北外滩|南浦|大桥|渡口|××渡|浜|汇角|滩)/],
  ['hub',        /(火车站|虹桥|浦东1号|航站楼|机场|汽车客运|南站|西站|北站|东站|松江北|上海站)/],
  ['campus',     /(大学|学院|复旦|同济|华政|师大|理工|科大|财大|外经贸|海事|海洋大学|学区)/],
  ['industrial', /(工业|开发园区|开发区|机电|钢铁|造船|重型|港区|外高桥|保税区|电厂|仓库|仓储|物流|码头)/],
  ['oldtown',    /(豫园|城隍|老街|古镇|七宝|朱家角|枫泾|新场|召稼楼|泗泾|罗店|安亭|松江站|醉白池|方塔)/],
  ['wutong',     /(衡山|武康|乌鲁木齐|长乐|巨鹿|永嘉|湖南路|高安|江苏路|四川北|山阴|多伦|甜爱|淮海中|淮海中路|陕西南|复兴|瑞金|绍兴|蒙自|思南|衡山路|常熟|新华路|愚园路|静安寺|南京西|淮海路)/],
  ['lilong',     /(新村|公寓|家园|苑$|住区|居住|彭浦|曹杨|天山|曲阳|鞍山|控工|上钢|太铁|彭五|宜川)/],
  ['farm',       /(佘山|东佘山|秀道户|滴水湖|野生动物|植物园|森林|湿地|湖|荡|泾|农林|村|塘|海塘|林)/],
  ['suburb',     /(松江|青浦|嘉定|宝山|闵行|川沙|南汇|奉贤|柘林|朱泾|临港|顾村|安亭|罗店|大场|三林|康桥|周浦|新场|南翔|菊园|徐泾|泗泾|九亭|七宝|美兰湖|共富|共康|呼兰|富锦|友谊|宝杨|水产|张华浜|淞滨|淞发)/],
];
/* 少数站名规则判不对，用显式覆写纠（比"再放宽一条正则"便宜，也不会误伤别的站）。 */
const ZONE_FIX = {
  人民广场: 'blvd', 世纪大道: 'blvd', 徐家汇: 'blvd', 中山公园: 'blvd',
  龙阳路: 'hub', 真如: 'hub', 上海马戏城: 'blvd', 大柏树: 'blvd',
  张江高科: 'campus', 虹桥2号航站楼: 'hub', 小南门: 'oldtown', 老西门: 'oldtown',
  大世界: 'oldtown', 南京东路: 'waterfront', 豫园: 'oldtown', 陆家嘴: 'waterfront',
  天文馆: 'blvd', 动物园: 'farm', 上海动物园: 'farm', 顾村公园: 'suburb',
};
/** 该站的街区类型（返回 SH.SCENE_ZONES 的键）。
 *  两级判据：① 站名里读得出的具体地名学（上表）；② 读不出时用**径向位置**兜底 ——
 *  该站沿线路距"内环核心站"的站数。站序本身就是地理顺序（线路表按真实走向排），
 *  所以"离市中心几站"是可计算的实测量，比给 350 个普通路名硬编一条正则诚实。
 *  分级门限按上海的空间结构给：内环内 0~3 站、中环里外 4~9 站、
 *  外环一带 10~16 站、再往外是新城与郊野。 */
const CORE_STATIONS = ['人民广场', '南京东路', '淮海中路', '一大会址·黄陂南路', '静安寺', '南京西路',
  '徐家汇', '陆家嘴', '世纪大道', '陕西南路', '常熟路', '打浦桥', '小南门', '四川北路', '提篮桥'];
/** 内环内 / 中环 / 外环 / 新城 / 郊野 的径向兜底档。 */
const RADIAL_ZONES = ['blvd', 'lilong', 'suburb', 'suburb', 'farm'];
SH.zoneOf = function (name) {
  if (ZONE_FIX[name]) return ZONE_FIX[name];
  for (const [z, re] of ZONE_RULES) if (re.test(name)) return z;
  return null;      // 交给径向兜底（见 zoneAtLine）
};
/** 沿线路的径向兜底：d = 距最近核心站的站数。线路不含核心站时，
 *  按"距线路中点的站数占半条线的比例"分档（中点最接近市中心）。 */
SH.zoneAtLine = function (name, idx, stationCount, hasCore, coreIdxs) {
  const named = SH.zoneOf(name);
  if (named) return { zone: named, basis: 'name' };
  let band;
  if (hasCore && coreIdxs && coreIdxs.length) {
    let d = 1e9;
    for (const ci of coreIdxs) d = Math.min(d, Math.abs(idx - ci));
    band = d <= 3 ? 0 : d <= 9 ? 1 : d <= 16 ? 2 : d <= 24 ? 3 : 4;
  } else {
    const mid = (stationCount - 1) / 2;
    const t = Math.abs(idx - mid) / Math.max(1, mid);
    band = t < 0.25 ? 1 : t < 0.55 ? 2 : t < 0.82 ? 3 : 4;
  }
  return { zone: RADIAL_ZONES[band], basis: 'radial' };
};
SH.RADIAL_ZONES = RADIAL_ZONES;
SH.CORE_STATIONS = CORE_STATIONS;

/* ------------------------------------------------------------------ 地面路口
 * 目标里"汽车、公交车和公交车站也要拉满"缺的最后一环：路上的车会开、会进站，
 * 但**路上没有任何东西能让它停下** —— 斑马线画在出入口外，却没有灯，
 * 于是行人（铺到街上的那一批）过的是一条永远直行的马路。
 *
 * 参数只写在这一处：world.js 拿它立灯杆与停车线，street.js 拿它让车停走，
 * test-street.js 拿它核对"红灯期间没有车越过停车线"。
 * 周期按上海次干路常见的 56 s 配：机动车绿 27、黄 3、红 26 ——
 * 红的这 26 s 就是给行人过街用的（真实地铁站出入口外正是这么配的）。 */
/* 站台出入口的纵向偏移（相对站心）。定义放在 core：地面路口信号（下方 SH.JUNCTION）
 * 与站厅、楼梯、下车人流必须读同一份，而 core 是所有模块的第一个依赖。 */
SH.PLATFORM_EXITS = [-70, 35];
/* 站台机位"虚拟观察者站在哪"的**单点**（诚实清单 §7.10 量出来的）。
   以前这个数只写在 `game.js: SH.platformShot` 里，而人群分布写在自己的式子里，
   两边谁都不知道对方在哪 —— 实测 8 处机位里 6 处**有人长在镜头上**：
   最近的人离相机眼 0.82 m（1 号线 上海南站），横向 3.05~3.67 正好压在相机横向
   3.5 上，Δs ±0.4 m。十字人形的两片在 1 m 内摊开，画面上就是"一只打开的纸箱"
   —— 这一条也曾被记成"最近一块屏 lat 4.70"，那是猜的，量出来不是屏。
   `r` 是净空半径：人群照数发射（人数是停站时长的依据，删一个就是谎报一个），
   只把落在泡里的人**沿站台推出去**。相机与净空必须读同一个数，
   各写一份就会出现"挪了相机忘了挪净空"。 */
SH.PLAT_CAM = { dz: -26, lat: 3.5, eye: 2.10, r: 1.3 };
SH.JUNCTION = {
  pitch: 420,          // 除出入口外，每隔这么多米一条横向路口（钉绝对里程）
  phase: 130,          // 上面那个网格的绝对相位
  cycle: 90,           // 周期（秒）
  green: 27, amber: 3, // 机动车相位（每方向）；两方向错开 green+amber，
                       // 剩下的 cycle − 2×(green+amber) = 30 s 是**全红窗口** = 行人过街
  crossLat: 43,        // 斑马线中心（与 world.js 的 crossing() 同一个数）
  crossLen: 25,        // 斑马线横向长度（米）：条纹盒的长边，也就是"过一次街走多远"
  stopBack: 2.2,       // 停车线在斑马线上游多少米
  mastLat: 45.6,       // 灯杆立在人行道外侧（斑马线以外、临街地块以内）
  lensY: 6.0,          // 灯头底高（相对街面）
  pedY: 2.9,           // 行人灯箱挂在同一根杆上的底高（§7.9）
  hold: 1.2,           // 红灯期间车停在停车线上游 0~hold 米内算合格
};
/** 本线的路口里程表：出入口那两处（与 `crossing()` 同一判据：露天站）+ 绝对网格。
 *  编号 `i` 决定该路口在周期里的偏移 —— 不给偏移，全线所有路口永远同色，
 *  看起来像停电而不是信号。 */
SH.junctions = function (line) {
  const al = line.al, out = [];
  for (let i = 0; i < al.stationS.length; i++) {
    if (!line.isElevated(al.stationS[i])) continue;         // 地下站没有街面，也不立灯
    for (const ex of SH.PLATFORM_EXITS) out.push({ s: al.stationS[i] + ex, exit: true, si: i, side: line.stationSide(i) });   // exit 那些就是斑马线：站号与站台侧一起记下，烘条纹与摆过街行人读同一份
  }
  for (let s = SH.JUNCTION.phase; s < al.total; s += SH.JUNCTION.pitch) {
    if (out.some(o => Math.abs(o.s - s) < SH.JUNCTION.pitch * 0.45)) continue;   // 不与出入口叠
    out.push({ s, exit: false });
  }
  out.sort((a, b) => a.s - b.s);
  out.forEach((o, i) => { o.i = i; });
  return out;
};
/** 某个路口、某一股方向的信号灯几何：灯杆、悬臂、灯箱、三枚镜片中心、停车线里程。
 *  world.js（烘焙灯杆与灯箱）与 street.js（每帧画亮着的那枚镜片、并让车停在
 *  停车线前）**共用这一个函数** —— 两边各算一遍坐标，就会出现"红灯亮在灯箱背面"
 *  和"车停在停车线后面三米"这类对不上账的画面。 */
SH.signalHead = function (al, j, sgn) {
  const J = SH.JUNCTION, q = al.level(al.frame(j.s)), y0 = al.streetDy(j.s) + 0.16;
  const mast = al.world(q, sgn * J.mastLat, y0 + 3.6);
  const foot = al.world(q, sgn * J.mastLat, y0);
  const headLat = sgn * (J.crossLat + 2.4);
  const head = al.world(q, headLat, y0 + J.lensY);
  /* 镜片朝向来车方向：+side 的车沿 +s 走，所以它的灯面朝 −f。 */
  const face = sgn > 0 ? -1 : 1;
  const lens = [0, 1, 2].map(k => [
    head[0] + q.f[0] * face * 0.19,
    y0 + J.lensY + 0.34 - k * 0.34,
    head[2] + q.f[2] * face * 0.19,
  ]);
  return { mast, foot, head, lens, yaw: Math.atan2(q.f[0], q.f[2]), y0, side: sgn,
    stopS: SH.junctionStop(j, sgn),
    /* 行人灯箱（§7.9）：与机动车灯**共杆**（真实路口的挂法），镜片竖排两枚
       （上红下绿），箱面朝斑马线对面 —— 行人过街前看的是对面那台。 */
    pedBox: al.world(q, sgn * J.mastLat, y0 + J.pedY + 0.28),
    pedLens: [0, 1].map(k => al.world(q, sgn * (J.mastLat - 0.16), y0 + J.pedY + 0.39 - k * 0.22)),
  };
};
/** 某方向在某路口的停车线里程（`SH.signalHead` 与车流共用这一个式子）。 */
SH.junctionStop = (j, side) => j.s - side * (9 + SH.JUNCTION.stopBack);
/** 某时刻、某路口、某方向的机动车灯色。两股反向车流错开 green+amber 秒
 *  （真实双相位：一股绿的时候另一股红 —— 且本模型里两股反向车共用同一个
 *  路面，同时绿灯会在路口正中相撞，test-street 有判据钉住"两反向不得同时绿"）。
 *  周期表：A 方向 [0,30) 通行；B 方向 [30,60) 通行；**[60,90) 全红 = 行人过街**。 */
SH.roadLamp = function (clock, j, side) {
  const J = SH.JUNCTION;
  const t = (((clock + j * 7 + (side > 0 ? 0 : J.green + J.amber)) % J.cycle) + J.cycle) % J.cycle;
  if (t < J.green) return 'green';
  if (t < J.green + J.amber) return 'amber';
  return 'red';
};
/** 行人过街相位（§7.9）：**两方向机动车全红**的窗口才放行 —— 单点定义，
 *  street.js 每帧点的行人灯与判据读同一个式子。
 *  相位表：A 方向 [0,30) 通行、B 方向 [30,60) 通行（红灯各 60 s），
 *  全红窗口 = [30,60)：[30,56) 通行（26 s ≥ 斑马线 25 m ÷ 1.2 m/s 的过街时长）、
 *  [56,60) 闪烁（清空已在斑马线上的行人）。
 *  联动是**安全属性**：walk 与任一方向的 green/amber 重叠就是人车冲突，
 *  判据（test-street）逐秒对账。 */
SH.walkLamp = function (clock, j) {
  const J = SH.JUNCTION;
  const t = (((clock + j * 7) % J.cycle) + J.cycle) % J.cycle;
  const p0 = J.green + J.amber;
  if (t < p0 || t >= 2 * p0) return 'dont';
  if (t < 2 * p0 - 4) return 'walk';
  return 'flash';
};
/** 行人**还能安全地走完斑马线**的秒数（不在通行窗口内就是 0）。
 *  过街的人必须在红灯亮起之前离开车道，所以"要不要踏上斑马线"不能只看现在
 *  是不是绿灯，还要看剩下的时间够不够走完 —— 与机动车控制器"前瞻到线灯色"
 *  是同一条纪律（§7.9 / 第 116 条那一族）。剩下的窗口含闪烁段：闪烁的语义是
 *  "不许再上桥、已在桥上的快走"，所以带上的人在这段时间继续走完是对的。 */
SH.walkLeft = function (clock, j) {
  const J = SH.JUNCTION;
  const t = (((clock + j * 7) % J.cycle) + J.cycle) % J.cycle;
  const end = 2 * (J.green + J.amber) - 4;              // 'dont' 从这一刻开始
  const p0 = J.green + J.amber;
  if (t < p0 || t >= end) return 0;
  return end - t;
};

/** 该站是否允许旁边有**高架快速路**（`elev` 列）：内环/中环沿线的梧桐街区、
 *  里弄、林荫大道、枢纽、工业带、新城都有；滨水岸线、古镇、大学园区、郊野没有。 */
SH.ELEV_WAY = {
  lat: 210,       // 分幅高架的对称中心（两幅各在其左右 6.5 m）
  cw: 11.0,       // 单幅桥面宽（两车道）
  gap: 2.0,       // 分幅间距（中央分隔）
  h: 9.0,         // 桥面相对**街面**的高度（净空 7.4 + 梁高 1.6）
  thick: 1.6,     // 箱梁高
  pier: 30,       // 墩距（钉绝对里程）
  /* 落地段：纵坡是唯一口径，坡长由它派生。以前 `ramp: 60` 是个独立的数，
     与 `h: 9` 合起来 = **15% 的纵坡** —— 画面上是一条滑滑梯，不是城市快速路的匝道。
     城市快速路匝道纵坡取 5.5% 档（≈9 m 落 164 m），h 与 grade 谁改另一个都跟着变。 */
  grade: 0.055,   // 落地段纵坡（m/m）
  lanes: [-2.75, 2.75],   // 单车道内两条车道的横向偏移（相对该幅中心）
  merge: 400,     // 相邻允许段之间小于这个缺口的合并（高架不会因为一站就断一次）
  /* 桥下地面道路：两幅各两条车道，落在**两排桥墩的外侧**。
     `off` 是相对该幅桥面中心的横向距离（不是相对线路中心）——
     落地匝道就顺着这条横向偏移把桥面接到地面幅上（见 `elevFor().foot`），
     所以"车开下匝道进了地面道路"这件事在几何与车流两边是同一个数算出来的。 */
  gp: { w: 7.0, lanes: [-1.75, 1.75], off: 7.5 },
};
/** 坡长由坡度高与纵坡派生：这两个数必须是**一个**说了算
   （test-street 按这条 lint 卡：写回常量就是"坡道与坡长各自为政"那一族）。 */
SH.ELEV_WAY.ramp = Math.round(SH.ELEV_WAY.h / SH.ELEV_WAY.grade);
/** 高架快速路在**哪一侧**：由站表定，全线一致、重烘不翻边。
 *  几何（world.js）与车流（street.js）都读这一个函数 —— 两侧算不一致，
 *  车就会跑在空气里。 */
SH.elevSide = names => ((SH.hash32((names || ['x']).join('|'), 11) & 1) ? 1 : -1);
/** 该幅走哪个方向：与地面道路**同一条口径** —— 相对这条路自己的中心，
 *  `lat` 更大的那一幅走 +s（右侧通行；地面街的 `side=+1 往 +s` 就是它）。
 *  `off` 传"该幅相对线路中心的偏移"（`CW[ci]`，未乘 elevSide）。
 *  高架以前写的是 `ci === 0 ? 1 : -1`，与这条规则**正好相反** ——
 *  两幅各自单向所以不会对撞，画面上读不出来，但它与地面街用的是两套规则，
 *  而"一辆车从地面幅开上匝道"要求两侧是同一条。 */
SH.elevDir = (eSide, off) => (eSide * off > 0 ? 1 : -1);
/** 高架快速路的"在哪、多高"：由站表 + 分区判出允许段，合并近邻、丢弃过短，
 *  端头按 `ramp` 线性落地。world.js（几何）与 street.js（车流）**共用这一份**，
 *  否则会出现"车跑在没有桥的高架高度上"或"桥上没有车"。
 *  结果缓存在 al 上（站表身份不变就不重算）。 */
SH.elevFor = function (al, names, blocks) {
  const c = al._elevCache;
  if (c && c.names === names) return c;
  const E = SH.ELEV_WAY, S = (al && al.stationS) || [], N = (names || []).length;
  const core = [];
  (names || []).forEach((n, i) => { if (SH.CORE_STATIONS.indexOf(n) >= 0) core.push(i); });
  const raw = [];
  for (let i = 0; i < S.length; i++) {
    const z = SH.zoneAtLine(names[i], i, N, core.length > 0, core).zone;
    if (!SH.SCENE_ZONES[z].elev) continue;
    const a = i === 0 ? 0 : (S[i - 1] + S[i]) / 2;
    const b = i === S.length - 1 ? al.total : (S[i] + S[i + 1]) / 2;
    raw.push([a, b]);
  }
  const merged = [];
  for (const g of raw) {
    const last = merged[merged.length - 1];
    if (last && g[0] - last[1] < E.merge) last[1] = Math.max(last[1], g[1]);
    else merged.push([g[0], g[1]]);
  }
  /** 观景机位通视带要"挖掉"的里程（`blocks = [[s0,s1],…]`）：桥带横在视线近端
   *  会把 skyline 机位糊住（实测 l16 边缘遮挡 12.0% > 判据线 11%）。
   *  这件事必须让**几何与车流看同一份**：只让几何侧跳过而车流照跑，就会出现
   *  "车跑在没有桥的高架高度上"（test-street 的轮下桥面对账当场抓到）。
   *  所以这里既给出 `blocked(s)`（world.js 用它切段不建桥），也让 `h(s)` 在其中
   *  归零（street.js 的桥面车因此不会画在不存在的高架上）。 */
  const bs = (blocks || []).map(b => [Math.min(b[0], b[1]), Math.max(b[0], b[1])]).sort((a, b) => a[0] - b[0]);
  const blocked = s => bs.some(b => s >= b[0] && s <= b[1]);
  const segs = merged.filter(g => g[1] - g[0] > 2 * E.ramp + 40);
  const out = { names, segs, blocked,
    /** 该里程的桥面相对街面高度（0 = 这里没有高架：不在段内、或被视廊挖掉、或在落地段） */
  h(s) {
      if (blocked(s)) return 0;
      for (const g of segs) {
        if (s < g[0] || s > g[1]) continue;
        const t = Math.min(s - g[0], g[1] - s);
        return E.h * Math.max(0, Math.min(1, t / E.ramp));
      }
      return 0;
    },
    /** 沿程纵坡 dh/ds（按 +s 方向，m/m）。车流俯仰与坡道判据都读这一个差分 ——
     *  自己再算一遍 (h2-h1)/dk 就是第二个真值。窗口 k 取 ramp/8：
     *  坡段中部读到的是真坡度，坡顶/坡脚那一档读到的是**竖曲线**（半个坡度），
     *  而真实匝道在变坡点本来就有竖曲线，尖角反而是假的。 */
    grade(s, k) { const d = k || Math.round(E.ramp / 8); return (out.h(s + d) - out.h(s - d)) / (2 * d); },
    /** 落地横向偏移：桥面在坡道上要**顺着地面幅的方向挪出去**，
     *  否则"匝道落地"落的是空气，地面幅在 7.5 m 开外。
     *  `base` = 该幅在桥面高度上的横向（带符号），返回该里程应当加上的横向偏移：
     *  在桥上（h=E.h）为 0，在地面（h=0，含段外）为 `±gp.off`（远离线路中心那一侧）。
     *  几何（world.js 的桥面扫掠）与车流（street.js 的实例位置）**必须读这一个函数**，
     *  否则坡上的车会跑出桥面 —— 与"车跑在没有桥的高度上"同族。 */
    foot(s, base) {
      const u = Math.max(0, Math.min(1, out.h(s) / E.h));
      return out.away(base) * E.gp.off * (1 - u);
    },
    /** 该幅**落地之后**的横向位置（地面幅中心）：foot 在 u=0 那一端的取值。
     *  几何用它摆桥下地面道路，判据用它问"匝道落到了哪条路上"。 */
    groundLat(base) { return base + out.away(base) * E.gp.off; },
    away(base) { return base - SH.elevSide(names) * E.lat > 0 ? 1 : -1; },
    seg(s) { for (const g of segs) if (s >= g[0] && s <= g[1]) return g; return null; },
  };
  al._elevCache = out;
  return out;
};
/** 共线同站台（type 'shared'）换乘站：对面那条轨道停的是**另一条线**。
 *  虹桥路 / 延安西路 / 宝山路 三处是 3、4 号线的同台对面换乘（walkSec = 0）。
 *  站体那一侧必须把对向站台挂成**对方线路**的身份（色带 + 站名标），
 *  否则"过对面站台就是另一条线"在画面上不成立 —— 看到的还是本线。 */
SH.peerAtShared = function (lineId, name) {
  const M = SH.INTER_META && SH.INTER_META[name];
  if (!M || M.type !== 'shared') return null;
  const list = M.lines || [];
  return list.find(l => l.id !== lineId) || null;
};
SH.zoneFixTable = ZONE_FIX;
SH.zoneRuleCount = ZONE_RULES.length;

/* ------------------------------------------------------------------ 换乘走行
 * `SH.INTER_META[name].walkSec` 是"这站换乘要走多少秒"，客流系数、报站措辞、
 * 站台屏都读它。而 3D 里那条通道以前**固定 6.8 m** —— 于是"走 70 秒"的站和
 * "走 210 秒"的站长得一模一样：文案在涨，几何一动不动（第 69 条
 * "文案 ↔ 几何 ↔ 实测三者互相对账"那一族的又一例）。
 * 这里把"走行秒数 → 通道米数"收成单点，几何与判据都读它。
 * 多线换乘分腿：1 条主干 + 每条换乘线一支。**支线的转角按线路名哈希定长，
 * 不许以烘焙窗口为起点**（第 67 条），否则车开一段重烘一次，整条通道会自己
 * 拐到别处去。 */
/* 站厅层 / 街面 / 站台之间怎么分人（视觉层唯一出处）。
   真实车站里"等着进站/刚出站"的人本来就有一大半在站厅，不在站台；而出了站
   还有人在街面人行道上 —— 以前三层全都画在站台上，于是第二层（第 116 条补
   出来的那块板）与街面出入口永远空无一人。
   0.42 与 0.18 不是拍的：按可行面积比 —— 站厅板宽 `mezzIn..箱涵壁` ≈ 4.4 m、
   站台走廊带 ≈ 6 m、街面人行道 `树线..楼线` ≈ 10 m 但只覆盖站前一段（约三成
   的人流在街上），合起来 4.4 : 10×0.3 : 6 ≈ 0.42 : 0.18 : 0.40。
   判据守的是**守恒**：站台 + 站厅 + 街面 = 视觉总量，一个人不多、一个人不少。 */
SH.PAX_SPLIT = { hall: 0.42, street: 0.18 };
/* 人群的两条同源常数（`world.js` 的烘焙人群与 `street.js` 的过街行人共用）：
   · `PAX_STEP` = 一步 0.66 m。步态相位一律由**走过的米数 ÷ 步长**给 ——
     位置与腿同源才不会"滑行的人偶"（第 101 条的教训）；过街行人、下车步行者、
     上下车的走客必须是同一个式子，各写一份就会出现两种步频。
   · `PAX_HUES` = 站台/街面人群的衣着色表。车内乘客是 `train.js` 里另一份
     （量级与用途不同，不硬并）。 */
SH.PAX_STEP = 0.66;
/* 步行速度 1.2 m/s：**行人过街窗口就是按它定的** —— 斑马线长 25 m，
   25 ÷ 1.2 ≈ 21 s，而 `SH.JUNCTION` 的全红（= 行人通行）窗口 26 s，
   留 5 s 给闪烁清空。改这个数等于改配时，两边必须一起核。 */
SH.PAX_WALK_V = 1.2;
SH.PAX_HUES = ['#2b3a4a', '#4a2b35', '#2f4038', '#3d3550', '#573a2a', '#26333d', '#5a4a2e', '#444a52',
  '#6b3a3a', '#2d4a5e', '#4d4557', '#3a4a3d'];

SH.TRANSFER_WALK = { vms: 1.15, hallM: 22, gateM: 6 };
/** 该换乘点的通道总长（米）与分腿表；walkSec=0（共线同站台）返回 legs:[]。 */
SH.transferPlan = function (name, meta) {
  if (!meta || !meta.walkSec) return { total: 0, legs: [] };
  const W = SH.TRANSFER_WALK;
  const n = Math.max(1, (meta.lines || []).length - 1);
  const body = Math.max(0, meta.walkSec * W.vms - W.hallM - n * W.gateM);
  const trunk = body * 0.45, per = (body - trunk) / n;
  const legs = [{ kind: 'trunk', len: trunk, turn: 0 }];
  for (let i = 0; i < n; i++) {
    const h = SH.rand01('turn' + name + i, 7);
    legs.push({ kind: 'branch', len: per, turn: (i % 2 ? -1 : 1) * (28 + 34 * h) });
  }
  return { total: body, legs };
};
/* 关门蜂鸣的节拍（秒/响）。B3 的"关门蜂鸣节奏"只有**一个**真值：
   audio.doorClose() 的 7 声"嘀"、车门提示灯的闪烁（train.doorLampK）、
   以及屏蔽门侧的提示音共用这一条时间轴 —— 各写各的周期，就是两套假设备。 */
SH.DOOR_BEEP = 0.26;
/** 司机台圆表的指针角度（度，0 = 正上方，负 = 逆时针）。
 *  HUD 的电子表和 3D 驾驶室里的机械表必须读同一个映射：同一车速指不同方向，
 *  车迷一眼就看出"表是假的"。量程留 15% 余量（f = 速度/满量程，可到 1.15）。 */
SH.dialDeg = f => -120 + clamp(f, 0, 1.15) * 240;
/** 表盘面量程（圆表最右刻度）。真实车上的表不是按限速刻的，是按车辆设计速度
 *  往上进到整数刻度：80 km/h 车 → 0~100，60 km/h APM → 0~80，
 *  磁浮 300 km/h → 0~500。用 70 的运营限速刻表会立刻露馅。 */
SH.dialFull = maxKmh => maxKmh <= 60 ? 80 : maxKmh <= 80 ? 100 : maxKmh <= 100 ? 120 : 500;
/** 曲线信息给司机看的那一句话。
 *  `curveLimitKmh` 是"欠超高允许速度"，直线上返回 Infinity、大半径曲线上能算出
 *  269 km/h —— 拿它直接上屏就是在 80 km/h 的线上印一个比设计速度高 3 倍的数，
 *  车迷一眼识破。规则：直线就说直线；有曲线报半径；只有真的构成限制才报限速。 */
SH.curveNote = (k, limitKmh, maxKmh) => !k ? '直线'
  : '曲线 R=' + Math.round(1 / Math.abs(k)) + ' m'
  + (isFinite(limitKmh) && limitKmh < maxKmh ? ' 限速 ' + Math.round(limitKmh) : '');
/** 连续驾驶：把"用户选的段数"换算成"本次实际能跑的段数"。
 *  刻意做成**纯函数、不回写**：以前这条规则内联在 `App.begin()` 里并写成
 *  `app.legs = C(app.legs, …)`，于是"全程"(99) 只要有一次从靠近终点的起始站出发，
 *  就被永久钳成 1 站，而 起始站 与 段数 都是跨局记住的（还要写进 localStorage）。
 *  玩家看到的就是"我明明选了全程，怎么只跑一站"，而且再也点不回全程。
 *  返回里的 `intent` 原样带出，调用方只能读、不能改。放在 core 是为了让
 *  `test-drive.js` 能直接断言这张表（game.js 依赖 DOM，测试里只 eval 类定义）。 */
SH.legsPlan = (intent, startIdx, nStations) => {
  const max = Math.max(1, nStations - 1 - startIdx);
  return { intent, max, run: Math.max(1, Math.min(intent | 0 || 1, max)) };
};
/* 速度层递感：把 kmh 映射成一条**不在 80 封顶**的压缩曲线。
   原来相机抖动用 C(spd/80,0,1)、滚动噪声用 C((kmh-8)/26,0,1) 与 C(kmh/45,0,1)，
   三个通道分别在 80 / 34 / 45 km/h 就变成常数，所以"到了 80 以上再快也感觉不出来"。
   这里用 1-(1/(1+x)) 的压缩形状：0 km/h 给 0，70 km/h 给 ~0.7，
   到 120 km/h 仍接近 1 但**始终还在涨**，各通道都改用它就能一路有层次。 */
SH.speedFeel = function (kmh) { const x = Math.max(0, kmh) / 95; return 1 - 1 / (1 + 2.35 * x); };
SH.mat4 = mat4; SH.m4mul = m4mul; SH.m4perspective = m4perspective; SH.m4lookAt = m4lookAt; SH.m4invertRigid = m4invertRigid; SH.cabFixMatrix = cabFixMatrix;
SH.m4basis = m4basis; SH.m4trs = m4trs; SH.m3normalFromM4 = m3normalFromM4;
/** 把基向量的 (u, f) 绕 r 转过 θ = atan(g)：g 是**沿 +s** 的坡度（dh/ds，正 = 往 +s 上坡），
 *  返回 `[up, fwd]` —— 车头（+f）在坡上抬起来，up 同时往后倒。
 *  桥面扫掠（world.js）与车流俯仰（street.js）**共用这一个函数**：
 *  只要两边各写一遍差分，就会出现"桥面斜着、车平着"（= 车在坡上埋进防撞墙）。
 *  车的朝向再单独乘 `dir`（right 与 fwd 同时取反，手性不变，车头自然指向下坡方向）。 */
SH.pitchBasis = function (r, u, f, g) {
  if (!g) return [u, f];
  const th = Math.atan(g), c = Math.cos(th), s = Math.sin(th);
  return [[u[0] * c - f[0] * s, u[1] * c - f[1] * s, u[2] * c - f[2] * s],
          [f[0] * c + u[0] * s, f[1] * c + u[1] * s, f[2] * c + u[2] * s]];
};
SH.catmullRom = catmullRom; SH.valueNoise1D = valueNoise1D; SH.fbm1 = fbm1;

})(typeof window !== 'undefined' ? window : globalThis);
