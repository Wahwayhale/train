/* ============================================================================
 * landmark.js — 上海地标与远景
 *
 * 每个地标先在**局部坐标系**里建好（原点在群体中心，+z 朝向观看者），
 * 再用 Builder.merge + 由轨道 frame 拼出的矩阵并入世界。
 * 好处：地标本身不用关心线路在哪、朝哪弯，朝向由放置点决定。
 *
 * 真实尺度（米）：
 *   东方明珠      468   1994  下球 φ50@100 / 上球 φ45@263 / 太空舱 φ14@350
 *   金茂大厦    420.5   1999  88 层，等差级数分段收分的塔式轮廓
 *   环球金融中心  492   2008  101 层，顶部 46×46 m 梯形风洞
 *   上海中心      632   2015  127 层，圆润三角平面沿高度螺旋扭转
 *   相互距离：明珠↔金茂 ≈500，金茂↔环球 ≈150，环球↔上中心 ≈200
 *   外滩历史建筑群在江对岸 ≈500–900 m，海关大楼钟楼 79 m
 *
 * 观看距离做了艺术化压缩（真实从浦东高架看陆家嘴有 6–10 km，超出远裁剪面），
 * 这里放在 700–1200 m，高度与相互距离保持真值比例。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { Builder } = SH;
const { cross, norm3 } = SH.Geo;
const rgb = SH.rgbOf;
const C = SH.clamp, L = SH.lerp;

/* ------------------------------------------------------------ 通用小构件 */
/** 方截面斜撑：两点之间拉一根梁（东方明珠的三根立柱、桥梁斜撑都用它） */
function strut(b, p0, p1, hw, color, opts) {
  opts = opts || {};
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const f = [dx / len, dy / len, dz / len];
  let r = norm3(cross([0, 1, 0], f));
  if (!isFinite(r[0]) || Math.hypot(r[0], r[1], r[2]) < 1e-4) r = [1, 0, 0];
  const u = cross(f, r);
  const s = hw;
  const prof = [{ x: -s, y: -s, nx: -1, ny: -1 }, { x: s, y: -s, nx: 1, ny: -1 },
                { x: s, y: s, nx: 1, ny: 1 }, { x: -s, y: s, nx: -1, ny: 1 }];
  const path = [
    { p: p0, r, u, f, s: 0 },
    { p: p1, r, u, f, s: len },
  ];
  b.sweep(path, prof, { mat: opts.mat || 'paint', color, closed: true, uvAlong: 1 / Math.max(2, len), vSpan: 1, emi: opts.emi || 0 });
  return b;
}
/** 竖向筒体：给定高度序列的收分环 */
function tower(b, x, z, rings, color, opts) {
  opts = opts || {};
  b.ringStack(opts.mat || 'bldgWin', rings.map(r => ({ y: r.y, rx: r.r * (r.sx || 1), rz: r.r, cx: x + (r.dx || 0), cz: z + (r.dz || 0), twist: r.tw || 0 })),
    color, { seg: opts.seg || 14, uvY: opts.uvY || SH.FACADE_UV, emi: opts.emi || 0, capTop: true });
  return b;
}
/** 顶部航空障碍灯：一个红色发光体 + 一点光晕几何 */
function beacon(b, p, r) {
  b.sphere(p, [r, r, r], { mat: 'light', color: rgb('#ff3b30'), emi: 2.4, segU: 8, segV: 6 });
}

/* ==================================================== 东方明珠 468 m */
function pearlTower(b, x, z, k) {
  k = k || 1;
  const H = 468 * k;
  const body = rgb('#d9e2e8'), glow = rgb('#ffd9a0');
  // 三根斜撑立柱：从地面外撇的三点收到 47 m 高的筒身
  const legTop = 47 * k, spread = 21 * k;
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.4;
    const px = x + Math.cos(a) * spread, pz = z + Math.sin(a) * spread;
    strut(b, [px, 0, pz], [x + Math.cos(a) * 5.2 * k, legTop, z + Math.sin(a) * 5.2 * k], 2.6 * k, body, { mat: 'paint' });
    // 立柱间的下球体平台斜撑
    strut(b, [px, 0, pz], [x, 78 * k, z], 1.1 * k, rgb('#b9c4cb'), { mat: 'paint' });
  }
  // 主筒身
  const rings = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, y = t * H * 0.76;
    rings.push({ y, r: (5.6 - 2.2 * t) * k });
  }
  tower(b, x, z, rings, body, { seg: 14, emi: 0.55 });
  // 三颗球体
  b.sphere([x, 100 * k, z], [25 * k, 24 * k, 25 * k], { mat: 'glass', color: rgb('#e8b06a'), emi: 0.62, segU: 20, segV: 12 });
  b.sphere([x, 263 * k, z], [22.5 * k, 22 * k, 22.5 * k], { mat: 'glass', color: rgb('#e8b06a'), emi: 0.72, segU: 20, segV: 12 });
  b.sphere([x, 350 * k, z], [7.5 * k, 7.5 * k, 7.5 * k], { mat: 'glass', color: rgb('#f0c98a'), emi: 0.8, segU: 14, segV: 8 });
  // 球体之间的连接筒 + 天线桅杆
  tower(b, x, z, [{ y: 124 * k, r: 6 * k }, { y: 241 * k, r: 5 * k }], body, { seg: 12, emi: 0.5 });
  tower(b, x, z, [{ y: 285 * k, r: 5.5 * k }, { y: 342 * k, r: 4.4 * k }], body, { seg: 12, emi: 0.5 });
  tower(b, x, z, [{ y: 358 * k, r: 3.4 * k }, { y: H * 0.985, r: 1.0 * k }], rgb('#c3ccd2'), { seg: 10 });
  strut(b, [x, H * 0.985, z], [x, H, z], 0.55 * k, rgb('#aab4ba'), { mat: 'metal' });
  beacon(b, [x, H, z], 1.4 * k);
  // 下球体裙房
  b.cylY([x, 0, z], 30 * k, 14 * k, rgb('#cfd8de'), { mat: 'bldgWin', seg: 18, uv: SH.FACADE_UV, emi: 0.6 });
  return b;
}

/* ==================================================== 金茂大厦 420.5 m */
/** 88 层、按等差级数分段收分的塔式轮廓 */
function jinmao(b, x, z, k) {
  k = k || 1;
  const H = 420.5 * k;
  const stone = rgb('#c9c2b4');
  const n = 13;
  let r = 24 * k, y = 0;
  const rings = [{ y: 0, r }];
  for (let i = 1; i <= n; i++) {
    // 每级收分按等差递减，越往上收得越快
    const step = (n - i + 1);
    r = Math.max(3.2 * k, r - step * 1.35 * k);
    y = H * 0.86 * (i / n);
    rings.push({ y, r });
    // 每级的退台挑檐
    b.box([x, y, z], [r * 2.16, 1.6 * k, r * 2.16], rgb('#d6d0c4'), { mat: 'paint', faces: [2, 3], emi: 0.06 });
  }
  tower(b, x, z, rings, stone, { seg: 8, emi: 0.55 });
  // 顶部塔冠与尖顶
  tower(b, x, z, [{ y: H * 0.86, r: 4 * k }, { y: H * 0.95, r: 1.6 * k }], rgb('#b8b2a6'), { seg: 8 });
  strut(b, [x, H * 0.95, z], [x, H, z], 0.9 * k, rgb('#9aa4aa'), { mat: 'metal' });
  beacon(b, [x, H, z], 1.2 * k);
  // 基座裙房
  b.box([x, 9 * k, z], [rings[1].r * 2.5, 18 * k, rings[1].r * 2.5], rgb('#bdb7ab'), { mat: 'bldgWin', uv: SH.FACADE_UV });
  return b;
}

/* ================================================ 上海环球金融中心 492 m */
/** 两扇弧形柱在顶部汇合，中间留 46×46 m 的梯形风洞 */
function swfc(b, x, z, k) {
  k = k || 1;
  const H = 492 * k, ap = 46 * k;      // 风洞边长
  const glass = rgb('#8fa4b4'), edge = rgb('#cfd8de');
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const y0 = t0 * (H - ap), y1 = t1 * (H - ap);
    // 平面从 46×46 方形渐变为顶部收窄
    const w0 = L(23, 12, t0) * k, w1 = L(23, 12, t1) * k;
    for (const s of [-1, 1]) {
      // 两侧主柱（沿 x 方向排布），中间留空形成风洞的“腿”
      b.box([x + s * (w0 * 0.62), (y0 + y1) / 2, z], [w0 * 0.8, y1 - y0, w0 * 1.9], glass, { mat: 'bldgWin2', uv: SH.FACADE_UV, emi: 0.5 });
    }
    // 横向连接楼板，只在风洞以下密排
    if (t0 < 0.78) b.box([x, y1, z], [w1 * 2.0, 1.1 * k, w1 * 1.95], edge, { mat: 'paint', faces: [2], emi: 0.05 });
  }
  // 风洞以上的顶冠 + 风洞四边框架
  const capY = H - ap;
  b.box([x, capY + ap * 0.5, z], [12 * k, ap, 22 * k], glass, { mat: 'bldgWin2', uv: SH.FACADE_UV, emi: 0.55 });
  b.box([x, H, z], [13 * k, 3.4 * k, 23 * k], edge, { mat: 'paint' });
  b.box([x - 7.4 * k, capY + ap / 2, z], [1.6 * k, ap, 23 * k], edge, { mat: 'paint', faces: [0, 1] });
  b.box([x + 7.4 * k, capY + ap / 2, z], [1.6 * k, ap, 23 * k], edge, { mat: 'paint', faces: [0, 1] });
  beacon(b, [x - 5 * k, H + 1.5 * k, z], 1.1 * k);
  beacon(b, [x + 5 * k, H + 1.5 * k, z], 1.1 * k);
  return b;
}

/* ==================================================== 上海中心大厦 632 m */
/** 圆润三角平面沿高度螺旋扭转并连续收分——ringStack 的 twist 正好干这个 */
function shanghaiTower(b, x, z, k) {
  k = k || 1;
  const H = 632 * k;
  const glass = rgb('#9fb3c2');
  const rings = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // 收分：底部半径 33 m，顶部约 12 m，按 1/(1+at) 型曲线
    const r = (33 - 21 * Math.pow(t, 0.72)) * k;
    // 沿高度累计扭转 120°
    const tw = t * (120 * Math.PI / 180);
    rings.push({ y: t * H, r, sx: 1, dz: 0, dx: 0, tw });
  }
  b.ringStack('bldgWin3', rings.map(r => ({ y: r.y, rx: r.r, rz: r.r * 0.92, cx: x, cz: z, twist: r.tw })),
    glass, { seg: 16, emi: 0.62, capTop: true });
  // 玻璃幕墙的外层“第二层皮肤”：略微外扩、半透
  b.ringStack('glassSoft', rings.filter((r, i) => i % 3 === 0).map(r => ({ y: r.y, rx: r.r * 1.06, rz: r.r * 0.98, cx: x, cz: z, twist: r.tw })),
    rgb('#b8d2e2'), { seg: 12, uvY: 0.02, emi: 0.05 });
  // 顶部观光层与桅杆
  b.box([x, H - 8 * k, z], [26 * k, 16 * k, 24 * k], rgb('#d5e2ea'), { mat: 'paint', emi: 0.30 });
  strut(b, [x, H, z], [x, H + 30 * k, z], 1.1 * k, rgb('#aab6bd'), { mat: 'metal' });
  beacon(b, [x, H + 30 * k, z], 1.5 * k);
  return b;
}

/* ================================================== 外滩历史建筑群 */
/** 万国建筑博览群：一排中世纪-新古典体量 + 海关大楼钟楼 + 穹顶银行 */
function bundRow(b, x, z, len, k) {
  k = k || 1;
  const stone = [rgb('#c8bda8'), rgb('#bfb6a4'), rgb('#d0c6b2'), rgb('#b2a894')];
  const n = 9, step = len / n;
  for (let i = 0; i < n; i++) {
    const cz = z - len / 2 + step * (i + 0.5);
    const h = (26 + (i % 3) * 12) * k, w = step * 0.82 * k;
    b.box([x, h / 2, cz], [w * 1.6, h, w], stone[i % 4], { mat: 'brick', uv: 1 / 6.8, emi: 0.14 });
    b.box([x, h + 1.2 * k, cz], [w * 1.75, 2.4 * k, w * 1.15], stone[(i + 1) % 4], { mat: 'paint', emi: 0.08 });
    if (i === 3) {
      // 海关大楼：79 m 钟楼
      const th = 79 * k;
      b.box([x, th / 2 + h * 0.3, cz], [w * 0.7, th, w * 0.7], rgb('#c2b7a2'), { mat: 'brick', uv: 1 / 6.8, emi: 0.16 });
      b.box([x, th + 4 * k, cz], [w * 0.82, 6 * k, w * 0.82], rgb('#d3c9b4'), { mat: 'paint' });
      b.sphere([x, th + 10 * k, cz], [w * 0.34, w * 0.34, w * 0.34], { mat: 'paint', color: rgb('#5f6a52'), emi: 0.1, segU: 12, segV: 8 });
      strut(b, [x, th + 12 * k, cz], [x, th + 22 * k, cz], 0.7 * k, rgb('#8b8574'), { mat: 'metal' });
      // 钟面
      b.cylY([x, th - 2 * k, cz + w * 0.36], w * 0.26, 0.5 * k, rgb('#f4ecd6'), { mat: 'emissive', seg: 14, emi: 0.9 });
    }
    if (i === 6) {
      // 原汇丰银行：大穹顶
      b.cylY([x, h + 3 * k, cz], w * 0.62, 5 * k, rgb('#a8b0a2'), { mat: 'paint' });
      b.sphere([x, h + 8 * k, cz], [w * 0.6, w * 0.52, w * 0.6], { mat: 'paint', color: rgb('#7f8c7a'), emi: 0.12, segU: 16, segV: 9, top: 0, bottom: 0.55 });
    }
  }
  // 滨江步道与灯柱
  b.box([x - 26 * k, 1.2 * k, z], [8 * k, 2.4 * k, len], rgb('#8b8272'), { mat: 'granite', faces: [0, 2, 4, 5] });
  return b;
}

/* ==================================================== 迪士尼城堡 */
function disneyCastle(b, x, z, k) {
  k = k || 1;
  const H = 68 * k;
  const wall = rgb('#f0e6d8'), roof = rgb('#5b7fb8'), gold = rgb('#e8c46a');
  b.box([x, H * 0.28, z], [26 * k, H * 0.56, 22 * k], wall, { mat: 'brick', uv: 1 / 6, emi: 0.16 });
  b.sphere([x, H * 0.62, z], [13 * k, H * 0.2, 11 * k], { mat: 'paint', color: roof, emi: 0.2, segU: 14, segV: 8, top: 0, bottom: 0.55 });
  // 中央高塔 + 四角副塔
  const spires = [[0, 0, H], [-16 * k, -14 * k, H * 0.66], [16 * k, -14 * k, H * 0.66], [-16 * k, 14 * k, H * 0.62], [16 * k, 14 * k, H * 0.62], [-8 * k, 18 * k, H * 0.5], [8 * k, 18 * k, H * 0.5]];
  for (const [dx, dz, hh] of spires) {
    b.cylY([x + dx, hh * 0.5, z + dz], 3.4 * k, hh, wall, { mat: 'paint', seg: 10, emi: 0.14 });
    b.sphere([x + dx, hh + 2.2 * k, z + dz], [3.6 * k, 6.5 * k, 3.6 * k], { mat: 'paint', color: roof, emi: 0.22, segU: 10, segV: 7, top: 0, bottom: 0.6 });
    strut(b, [x + dx, hh + 6.5 * k, z + dz], [x + dx, hh + 11 * k, z + dz], 0.35 * k, gold, { mat: 'light', emi: 0.7 });
  }
  beacon(b, [x, H + 12 * k, z], 0.9 * k);
  return b;
}

/* ======================================================= 远景天际线带 */
/**
 * 一条由薄板高楼组成的城市轮廓，用来在江对岸/地平线方向撑出"这是个大城市"。
 * 高度用分形噪声，保证中间高（CBD）、两侧低。
 */
function distantSkyline(b, cx, cz, axis, span, count, maxH, seed, night) {
  const R = SH.rng(seed >>> 0);
  const n1 = SH.valueNoise1D(seed + 3), n2 = SH.valueNoise1D(seed + 91);
  const along = axis === 'z' ? [0, 0, 1] : [1, 0, 0];
  const lat = axis === 'z' ? [1, 0, 0] : [0, 0, 1];
  const mats = ['bldgWin', 'bldgWin2', 'bldgWin3'];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1) - 0.5;
    const d = t * span;
    // 中间高、两端低，叠加噪声
    const bell = Math.pow(Math.max(0, 1 - Math.abs(t) * 1.85), 1.5);
    const h = maxH * bell * (0.30 + n1(i * 0.71) * 0.85) + 12 + R() * 26;
    if (h < 16) continue;
    const w = 10 + n2(i * 0.53) * 22, dep = 10 + R() * 18;
    const off = (R() - 0.5) * 90;
    const px = cx + along[0] * d + lat[0] * off, pz = cz + along[2] * d + lat[2] * off;
    const tint = 0.30 + R() * 0.22;
    b.box([px, h / 2, pz], [axis === 'z' ? w : dep, h, axis === 'z' ? dep : w],
      [tint * 1.02, tint * 1.04, tint * 1.14],
      { mat: mats[i % 3], uv: SH.FACADE_UV, faces: [0, 1, 4, 5], emi: (0.30 + R() * 0.55) * (night == null ? 0.7 : night) });
    if (R() > 0.82) { b.box([px, h + 5, pz], [3, 10, 3], [tint, tint, tint * 1.1], { mat: 'metal' }); beacon(b, [px, h + 11, pz], 0.9); }
  }
  return b;
}

/* ============================================================== 水面 */
/**
 * 统一的垂直基准。place() 把地标群锚在**轨面下 12 m**，所以这里的局部 y
 * 换算到世界要 +12：
 *   局部 y = +12  →  世界 0    轨面
 *   局部 y = +1   →  世界 −11  街面 / 远景地面（world.city 的 STR）
 *   局部 y = +1.8 →  世界 −10.2 江面（WATER_Y）
 *   局部 y = +2.6 →  世界 −8.4  堤顶（BANK_TOP，比江面高 1.8 m）
 * 改任何一个高度之前先想清楚它在哪个坐标系里：这座城的 bug 有一半来自
 * "局部 / 世界"混用（楼脚被切掉、桥落回地面都是这么来的）。
 */
const WATER_Y = 1.8, BANK_TOP = 2.6;
/** 一块堤岸/台地：让对岸的天际线站在地上，而不是浮在雾里 */
function apron(b, cx, cz, lenX, lenZ, yTop) {
  const nx = Math.max(1, Math.round(lenX / 200)), nz = Math.max(1, Math.round(lenZ / 200));
  const sx = lenX / nx, sz = lenZ / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    b.box([cx - lenX / 2 + sx * (i + 0.5), yTop - 6, cz - lenZ / 2 + sz * (j + 0.5)],
      [sx, 12, sz], rgb('#5b6469'), { mat: 'asphalt', faces: [2], uv: 1 / 60 });
  }
  return b;
}
/**
 * 江面：沿给定方向铺一条带。axis='x' 表示水面**平行轨道**，'z' 表示**横切轨道**。
 * 必须**沿长度分段**——整条水面只用一个四边形的话，从侧面看就是一张
 * 切过天空的半透明薄膜（实测 4 km 跨度的单 quad 会在画面里形成巨大楔形），
 * 而且雾与光照在单 quad 上无法渐变。
 */
function waterBand(b, cx, cz, axis, span, width, y, mat, segs) {
  const along = axis === 'z' ? [0, 0, 1] : [1, 0, 0];
  const lat = axis === 'z' ? [1, 0, 0] : [0, 0, 1];
  const N = segs || 24, step = span / N;
  /* 河道必须有平面形状。原来是一条**完美矩形**（2400 × 620，边全是直线），
     而城市本来就是一片矩形地块 —— 一块深色矩形读起来就是"又一个街区"。
     现在按节点算半宽与中心线摆动，再逐格拼**梯形**（quadPts 四个角任意），
     所以岸线是连续曲线而不是阶梯。
     但要说清楚：这一改动**不是**"江看不见"的原因。那个是 `sp.dist || 900`
     把整条江搬到线路外侧 1.8 km（见 game.js bake() 的注释与 README 第 19 条）。
     当时水色、alpha、岸壁材质、河道弯曲连着调了四轮全部无效，
     教训就是"同一现象调参数一动不动，说明模型错了"。 */
  const nW = SH.valueNoise1D(1013 + Math.round(span)), nC = SH.valueNoise1D(7717 + Math.round(width));
  const node = i => {
    const t = i / N;
    return {
      c0: -span / 2 + step * i,
      hw: width * (0.36 + 0.21 * SH.fbm1(nW, t * 3.1)),          // 半宽 0.72~1.11 倍
      cc: width * 0.36 * (SH.fbm1(nC, t * 2.3 + 11) - 0.47),     // 中心线摆动 ±0.18 倍宽
    };
  };
  const nd = []; for (let i = 0; i <= N; i++) nd.push(node(i));
  const P = (n, d, yy) => [
    cx + along[0] * n.c0 + lat[0] * (n.cc + d), yy,
    cz + along[2] * n.c0 + lat[2] * (n.cc + d)];
  const uvR = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const qW = 18, top = y + 1.15, bot = y - 6;
  for (let i = 0; i < N; i++) {
    const A = nd[i], B = nd[i + 1];
    /* 水面 */
    b.quadPts(P(A, -A.hw, y), P(A, A.hw, y), P(B, B.hw, y), P(B, -B.hw, y),
      rgb('#122839'), { mat: mat || 'water', normal: [0, 1, 0], uv: uvR });
    for (const s of [-1, 1]) {
      const nrm = [lat[0] * -s, 0, lat[2] * -s];               // 立壁朝水一侧
      /* 防汛步道顶面 */
      b.quadPts(P(A, s * A.hw, top), P(B, s * B.hw, top), P(B, s * (B.hw + qW), top), P(A, s * (A.hw + qW), top),
        rgb('#949da2'), { mat: 'granite', normal: [0, 1, 0], uv: uvR });
      /* 朝水的混凝土立壁 */
      b.quadPts(P(A, s * A.hw, top), P(B, s * B.hw, top), P(B, s * B.hw, y - 0.4), P(A, s * A.hw, y - 0.4),
        rgb('#a8b0b5'), { mat: 'concrete', normal: nrm, uv: uvR });
      /* 外侧裙墙：挡住步道外沿与远景地面之间那道 3 m 落差 */
      b.quadPts(P(A, s * (A.hw + qW), top), P(B, s * (B.hw + qW), top), P(B, s * (B.hw + qW), bot), P(A, s * (A.hw + qW), bot),
        rgb('#5f686f'), { mat: 'concreteD', normal: [lat[0] * s, 0, lat[2] * s], uv: uvR });
    }
  }
  return b;
}
/** 圆形湖（滴水湖，真实直径 6 km，这里按可视尺度压缩） */
function lakeDisc(b, cx, cz, r, y) {
  const b2 = b;
  const seg = 46;
  /* 用**同心环 × 扇格**铺，不用"圆心 +  rim 两点"的扇形。
     扇形写法必须把第四个点压到与第三点同一个 xz（只是 y 差 0.01）才闭合，
     那是一张**自折叠**的四边形：双线性参数化把三角形走两遍，
     一旦被 200 m 规则切成 3×3 子格，子格之间互相穿插 z-fighting，
     画面上就是从湖心炸开的一把"手指"。
     环格每个都是真正的四边形，边长 ≤ 72 m，不会被再切，UV 也按世界 xz
     平面铺（一个循环 60 m），涟漪尺度均匀。 */
  const rings = 8, us = 1 / 60;
  const uvAt = (x, z) => [x * us, z * us];
  const pt = (rr, a) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
  for (let j = 0; j < rings; j++) {
    const r0 = r * j / rings, r1 = r * (j + 1) / rings;
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      const p0 = pt(r0, a0), p1 = pt(r1, a0), p2 = pt(r1, a1), p3 = pt(r0, a1);
      b2.quadPts(p0, p1, p2, p3, rgb('#16303f'), {
        mat: 'water', normal: [0, 1, 0],
        uv: [uvAt(p0[0], p0[2]), uvAt(p1[0], p1[2]), uvAt(p2[0], p2[2]), uvAt(p3[0], p3[2])],
      });
    }
  }
  // 环湖路：按弧长铺，否则 46 个 22 m 的方块在 500 m 半径上是一条虚线，不是堤岸
  const step = (2 * Math.PI * (r + 14)) / seg;
  for (let i = 0; i < seg; i++) {
    const a = (i + 0.5) / seg * Math.PI * 2;
    b2.box([cx + Math.cos(a) * (r + 14), y + 1.4, cz + Math.sin(a) * (r + 14)],
      [step + 1.5, 2.8, step + 1.5], rgb('#5d666c'), { mat: 'concrete', faces: [2] });
  }
  return b;
}

/* ======================================================== 机场与体育 */
function airportTerminal(b, x, z, k) {
  k = k || 1;
  const len = 620 * k;
  b.box([x, 22 * k, z], [82 * k, 44 * k, len], rgb('#c4ccd2'), { mat: 'bldgWin2', uv: SH.FACADE_UV });
  // 弧形大屋顶
  const rings = [];
  for (let i = 0; i <= 8; i++) { const a = -0.55 + 1.1 * i / 8; rings.push({ y: 44 * k + Math.cos(a) * 16 * k, r: 1, cx: x + Math.sin(a) * 44 * k, cz: z - len / 2 + 0.001, dx: 0, dz: 0, sx: 1 }); }
  // 弧形大屋顶：路径必须给够采样点——只给首尾两个断面的话，
  // 整个屋顶就是几个 600 m 长的三角形，插值全废（见 Builder.box 的同类注释）
  const roofPath = [];
  for (let i = 0; i <= 24; i++) {
    const z2 = z - len / 2 + len * i / 24;
    roofPath.push({ p: [x, 0, z2], r: [1, 0, 0], u: [0, 0, 1], f: [0, 1, 0], s: len * i / 24 });
  }
  b.sweep(roofPath,
    [{ x: -46 * k, y: 44 * k, nx: -1, ny: 0 }, { x: -30 * k, y: 58 * k, nx: 0, ny: 1 }, { x: 0, y: 62 * k, nx: 0, ny: 1 }, { x: 30 * k, y: 58 * k, nx: 0, ny: 1 }, { x: 46 * k, y: 44 * k, nx: 1, ny: 0 }],
    { mat: 'metal', color: rgb('#dfe6ea'), closed: false, uvAlong: 1 / 24, vSpan: 1 });
  // 塔台
  b.cylY([x + 120 * k, 40 * k, z + len * 0.42], 9 * k, 80 * k, rgb('#b9c2c8'), { mat: 'bldgWin', seg: 14, uv: SH.FACADE_UV });
  b.cylY([x + 120 * k, 84 * k, z + len * 0.42], 15 * k, 10 * k, rgb('#2b3a44'), { mat: 'glass', seg: 16, emi: 0.4 });
  beacon(b, [x + 120 * k, 92 * k, z + len * 0.42], 1.4 * k);
  // 停机坪上的飞机
  for (let i = 0; i < 5; i++) plane(b, x - 200 * k + i * 96 * k, z - 70 * k, (i % 2 ? 0.4 : -0.3) + i * 0.1, k * 0.9);
  return b;
}
function plane(b, x, z, yaw, k) {
  const c = rgb('#eef2f5'), t = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx, lz) => [x + lx * t - lz * s, 0, z + lx * s + lz * t];
  b.sphere([x, 7 * k, z], [30 * k, 6.4 * k, 6.4 * k], { mat: 'paint', color: c, segU: 14, segV: 8 });
  b.plate([x, 7 * k, z], [(P(0, 26)[0] - x), 0, (P(0, 26)[2] - z)], [(P(0, -26)[0] - x), 0, (P(0, -26)[2] - z)], [0, 1, 0], c, { mat: 'paint', uv: 1 });
  b.box(P(-22 * k, 0), [12 * k, 9 * k, 2.4 * k], c, { mat: 'paint' });
  for (const sx of [-1, 1]) b.box(P(4 * k, sx * 12 * k), [16 * k, 3.2 * k, 9 * k], c, { mat: 'paint' });
  return b;
}
function stadium(b, x, z, r, k) {
  k = k || 1;
  const seg = 30;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const ca = (a0 + a1) / 2;
    b.box([x + Math.cos(ca) * r, 16 * k, z + Math.sin(ca) * r], [r * 0.36, 32 * k, r * 0.42], rgb('#cfd6da'),
      { mat: 'bldgWin', uv: SH.FACADE_UV, faces: [0, 1, 2, 3], emi: 0.14 });
  }
  b.box([x, 34 * k, z], [r * 2.3, 3 * k, r * 2.3], rgb('#e4e9ec'), { mat: 'metal', faces: [2] });
  b.box([x, 2 * k, z], [r * 1.5, 4 * k, r * 1.5], rgb('#3f6b45'), { mat: 'foliage', faces: [2] });
  for (const s of [-1, 1]) { b.box([x + s * r * 1.15, 26 * k, z], [4 * k, 44 * k, 4 * k], rgb('#b6bec4'), { mat: 'metal' }); beacon(b, [x + s * r * 1.15, 49 * k, z], 1.1 * k); }
  return b;
}

/* ============================================================== 水上船只 */
/**
 * 水面上的船只。中心 (cx,cz)、半跨 (halfX,halfZ) 必须落在所在水道里，
 * 否则船会漂到岸上——所以范围由调用方显式给，这里不猜。
 * flow = 水道走向：船身顺流，不会横在河中间。
 */
function boats(b, n, cx, halfX, cz, halfZ, wy, flow) {
  wy = wy == null ? -2.4 : wy;
  /* 长轴沿河道方向（flow='z' 时长边在 z），船不画偏航——内河驳船本来就顺着航道走。
     以前整条船是"一个黑盒子 + 一个贴着 **窗格贴图** 的白箱"，在 400~600 m 外
     正侧看过去只剩一根黑杠，根本认不出是船（跨江截图右下那根"漂在水里的杆子"
     就是它，害得我去查接触网支柱是不是插进了江里）。
     现在按内河驳船的样子拆开：船体 + 艏楼 + 三舱货 + 艉部白色驾驶楼（深色窗带）
     + 一圈水线浅色舷带。最后这一圈负责把船"钉"在水面上：它是**侧面**的带子而不是
     贴水的平板，所以不会和水面的四边形共面打架（远深度缓冲精度不够，贴水面片必闪）。 */
  const along = flow !== 'z';
  const cargo = [rgb('#7a4a3c'), rgb('#3c5a72'), rgb('#5d6b4a')];
  /* 局部 (顺河道 lu, 横向 lv) → 世界 (x, y, z) 尺寸 / 平面位置 */
  const S3 = (lu, lv, h) => (along ? [lu, h, lv] : [lv, h, lu]);
  const P2 = (lu, lv) => (along ? [lu, lv] : [lv, lu]);
  for (let i = 0; i < n; i++) {
    const px = cx + (SH.rand01('boatX', i) * 2 - 1) * halfX;
    const pz = cz + (SH.rand01('boatZ', i) * 2 - 1) * halfZ;
    const Lh = 46 + (i % 3) * 26, hw = 5.6 + (i % 2) * 1.4;
    const top = wy + 2.0;                                 // 甲板面（船体顶）
    b.box([px, wy - 1.2, pz], S3(Lh, hw * 2, 6.4), rgb('#3b4650'), { mat: 'paint' });
    /* 水线舷带：比船体长 3%、每侧宽 0.7 m，顶面只高出水面 0.25 m */
    b.box([px, wy - 0.15, pz], S3(Lh * 1.03, hw * 2 + 1.4, 0.8), rgb('#c3d0d6'), { mat: 'paint' });
    /* 艏楼：船头起一道舷墙，侧影才不是一根等粗的条 */
    const bp = P2(-Lh * 0.42, 0);
    b.box([px + bp[0], top + 1.5, pz + bp[1]], S3(Lh * 0.17, hw * 1.72, 3.0), rgb('#46525c'), { mat: 'paint' });
    for (let k = 0; k < 3; k++) {
      const cp = P2(Lh * (-0.16 + k * 0.2), 0);
      b.box([px + cp[0], top + 1.5, pz + cp[1]], S3(Lh * 0.16, hw * 1.5, 3.0), cargo[k], { mat: 'paint' });
    }
    const wp = P2(Lh * 0.40, 0);
    b.box([px + wp[0], top + 2.2, pz + wp[1]], S3(7.2, hw * 1.6, 4.4), rgb('#e6ebee'), { mat: 'paint' });
    b.box([px + wp[0], top + 3.4, pz + wp[1]], S3(7.7, hw * 1.68, 1.1), rgb('#1d272e'), { mat: 'paint', emi: 0.18 });
    const mp = P2(Lh * 0.40, hw * 0.95);
    beacon(b, [px + mp[0], top + 5.2, pz + mp[1]], 0.7);
  }
  return b;
}

/* ============================================================== 桥梁 */
/**
 * 斜拉桥。桥轴沿局部 x（=轨道方向），塔柱的人字腿在 **z 方向**跨住桥面。
 * 之前把腿放在 x 上，等于让塔顺着桥的方向歪着，从正面看像个倒 V 门框，
 * 是错的：真实斜拉桥（南浦/杨浦/闵浦）的塔腿分居桥面两侧。
 *
 * railY = 局部坐标里的轨面高度。cross 类地标的锚点在轨面下 12 m
 * （place 里写死的 dy=-12），所以默认 12：加劲梁顶刚好托在列车脚下。
 * 世界本身的高架 U 形梁会继续往前伸，桥塔只是把"这是座桥"讲清楚。
 *
 * dyFn（D3）：局部 x → 该点轨面相对锚点的**竖向偏移**。以前桥面是一根
 * 900 m 的水平盒，而线路在桥台外带 20~27‰ 的坡——桥与轨面在桥台处错开
 * 好几米，画面上就是"轨道悬空飞过一座不相关的桥"。跨水点 ±210 m 内
 * 坡度被线形生成器钉在 0 附近，所以中段是平的；偏移发生在两侧边跨。
 * 桥面改用**逐段跟随纵断面的条带**（quadPts）：相邻段各自落到自己的
 * 轨面高上，桥台处与轨道结构正好衔接。dyFn 缺省为 0（独立成景的
 * `bridge` 与离线判据不受影响）。
 */
function cableBridge(b, cx, cz, halfSpan, towerH, railY, dyFn) {
  const ry = railY == null ? 12 : railY;
  const dy = x => (dyFn ? dyFn(x) : 0);
  /* 塔身是混凝土的浅暖灰，不是金黄。原来上成饱和金黄，观景机位离塔只有
     150 m，屏幕上就是一块柠檬色楔子压在画面上。 */
  const gold = rgb('#c4bcae');
  const steel = rgb('#b9c4cb');
  const deckLen = halfSpan * 2 + 300, deckEnd = deckLen / 2;
  /* 索的落点必须留在加劲梁上。以前主跨侧和边跨侧共用一个 fan =
     min(0.62×半跨, 210)，而边跨只有 deckEnd − halfSpan = 150 m：
     最外一对索落在塔外 186 m，比梁端还超出去 36 m，观景机位里就是
     "两根钢索插到江面上空"（实测跨江截图右下）。真实斜拉桥的索面本来
     就不对称：主跨侧铺到近跨中，边跨侧很快收到梁端。 */
  const inMax = Math.min(halfSpan * 0.72, halfSpan - 26);
  const outMax = Math.max(28, deckEnd - halfSpan - 20);
  for (const s of [-1, 1]) {
    const x = cx + s * halfSpan, tDy = dy(x);
    /* H 形塔柱：两条腿**各自竖直**，顶部不再收拢到中线。
       原来写成"塔顶两点合一"，于是横梁（沿河道方向 62 m 长）在塔顶两侧
       各悬空 17 m，屏幕上就是"两根棕色杠子飘在白塔旁边"。
       整座塔随所在里程的轨面整体升降（D3）：塔基落地、塔顶索锚
       跟桥面保持同一相对高度。 */
    for (const t of [-1, 1]) {
      strut(b, [x, ry - 14 + tDy, cz + t * 17], [x, towerH + tDy, cz + t * 8.5], 4.2, gold, { mat: 'paint', emi: 0.12 });
    }
    b.box([x, towerH - 14 + tDy, cz], [10, 8, 22], gold, { mat: 'paint' });
    b.box([x, towerH + tDy, cz], [9, 6, 20], gold, { mat: 'paint' });
    b.box([x, ry + 3 + tDy, cz], [11, 7, 30], gold, { mat: 'paint' });
    /* 扇形索面：真实斜拉桥的索在塔的两侧各自呈扇形展开，**不交叉**。
       原来写成 dx = span*(2t-1)*(i%2?1:-1)，奇偶交替让相邻两索左右互换，
       从正面看就是一团乱麻。
       索的半宽 0.6 → 0.12 m（0.24 m 见方）：观景机位就架在索面里（相机在塔与
       锚固点之间，这正是"开车穿过斜拉桥"的视角），1.2 m 粗的索在离相机 20 m 处
       张 3.4°，屏幕上就是两道横切画面的黑色板子——实测截图里整个左半屏被它们盖住。
       真实拉索直径 0.2~0.3 m；再给一点自发光，因为逆光下索的可见面法向既背向太阳
       又朝向地面，纯靠环境光会渲染成黑条，而真照片里它们是压在天际上的一道细亮线。
       索的下端锚在**加劲梁自己的高度**上（每根索的锚点 x 不同，dy 也不同）。 */
    for (let i = 1; i <= 9; i++) {
      const d = inMax * i / 9;
      for (const t of [-1, 1]) {
        strut(b, [x, towerH - 6 + tDy, cz + t * 6.2], [x - s * d, ry - 3 + dy(x - s * d), cz + t * 6.2], 0.12, steel, { mat: 'steel', emi: 0.16 });
      }
    }
    for (let i = 1; i <= 5; i++) {
      const d = outMax * i / 5;
      for (const t of [-1, 1]) {
        strut(b, [x, towerH * 0.42 + tDy, cz + t * 6.2], [x + s * d, ry - 3 + dy(x + s * d), cz + t * 6.2], 0.12, steel, { mat: 'steel', emi: 0.16 });
      }
    }
    beacon(b, [x, towerH + 5 + tDy, cz], 1.2);
  }
  /* 加劲梁（列车就在它上面过河）。沿桥轴**逐段跟随纵断面**（D3）：
     以前是一串水平盒 —— 一根 900 m 的盒子顶面就是一个 900 m 长的四边形，
     雾与光照只能靠三个角插值，远看桥面会斜着亮一道；而且桥台外线路带坡，
     桥与轨面错开好几米。现在每段两端各自落到自己的轨面高上（quadPts 条带），
     60 m 一段保证长边不超限、坡度变化也被够密地采样。
     宽 15 m = 双线 + 两侧检修走道（24 m 是公路桥断面）。
     **索的横向锚固面（±6.2）必须留在梁宽以内**：梁收窄到 13 m 时索还挂在 ±8，
     于是每一根索的下端都探出梁外 1.5 m，屏幕上变成"一排斜线插进水里"。 */
  {
    const deckLen = halfSpan * 2 + 300;
    const x0 = cx - deckLen / 2, STEP = 60, N = Math.ceil(deckLen / STEP);
    const W2 = 7.5, topDy = -2.2, botDy = -2.2 - 3.4;   // 梁顶（轨面下 2.2）与梁底
    for (let i = 0; i < N; i++) {
      const xa = x0 + STEP * i, xb = Math.min(x0 + STEP * (i + 1), x0 + deckLen);
      const ya = ry + dy(xa), yb = ry + dy(xb);
      const ta = ya + topDy, tb = yb + topDy;             // 梁顶（轨面下 2.2）
      const ba = ya + botDy, bb = yb + botDy;             // 梁底
      /* 梁顶面（列车脚下）与底面 */
      b.quadPts([xa, ta, cz - W2], [xb, tb, cz - W2], [xb, tb, cz + W2], [xa, ta, cz + W2],
        rgb('#7d868d'), { mat: 'steel', normal: [0, 1, 0] });
      b.quadPts([xa, ba, cz + W2], [xb, bb, cz + W2], [xb, bb, cz - W2], [xa, ba, cz - W2],
        rgb('#5f686f'), { mat: 'concrete', normal: [0, -1, 0] });
      /* 两侧腹板 */
      for (const t of [-1, 1]) {
        b.quadPts([xa, ba, cz + t * W2], [xb, bb, cz + t * W2], [xb, tb, cz + t * W2], [xa, ta, cz + t * W2],
          rgb('#6b747b'), { mat: 'steel', normal: [0, 0, t] });
      }
    }
  }
  return b;
}
/** 简支梁公路桥：桥轴沿局部 x（横切运河），k 为尺度系数。
 *  桥面比轨面（局部 +12）低一截——公路桥跨小河只需要高出水面几米。 */
function girderBridge(b, cx, cz, k) {
  k = k || 1;
  const L = 210 * k, W = 15 * k;
  // 公路桥只需高出水面一点：桥面顶 = 局部 +0.6（水面 −2.5，街面 +1）
  b.box([cx, 2.1, cz], [L, 2.6, W], rgb('#788188'), { mat: 'concrete', faces: [2] });
  b.box([cx, 0.0, cz], [L, 3.4, W * 0.86], rgb('#5f686f'), { mat: 'concrete' });
  // 水中墩 + 护栏
  for (const s of [-1, 0, 1]) b.box([cx + s * L * 0.34, -4, cz], [7 * k, 14, 7 * k], rgb('#565e64'), { mat: 'concrete' });
  for (const t of [-1, 1]) b.box([cx, 4.1, cz + t * W * 0.46], [L, 1.4, 1.2], rgb('#a9b2b8'), { mat: 'steel' });
  return b;
}

/* ==================================================== 地标注册与放置 */
/**
 * kind → 构建函数。签名统一为 (builder, k)。
 * 局部坐标：原点在群体中心，+x = 轨道前进方向，+z 朝向观看者（放置时由矩阵旋转）。
 */
const BUILDERS = {
  lujiazui(b, k) {
    // 真实相对位置（米）：明珠在西北，金茂/环球/上中心自西南向东北排开
    pearlTower(b, -180, 120, k);
    jinmao(b, 40, -60, k);
    swfc(b, 150, 20, k);
    shanghaiTower(b, 300, 130, k);
    distantSkyline(b, 0, -420, 'x', 2600, 46, 150, 771, 0.7);
    return b;
  },
  bund(b, k) {
    /* 外滩是**沿江一字排开**的。而在地标局部系里 +z 是"朝线路"、x 是"沿轨道"，
       bundRow 却把 9 栋楼排在 z 上 —— 等于让整排外滩楼横穿线路。dist=850 时
       看不出来（整排被推到 400~1300 m 外），一旦按 test-shot.js 的占比判据把
       主体拉近，最后几栋就直接压到线路中心线上（实测 minLat = 0，楼穿高架）。
       所以先按原样造一排，再整体绕竖轴转 90° 并入，让这排楼沿轨道展开。 */
    const sub = new SH.Builder();
    bundRow(sub, 0, 0, 900, k);
    const R = SH.m4basis([0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 0, 0]);   // det = +1，纯旋转
    b.merge(sub, R, SH.m3normalFromM4(R));
    distantSkyline(b, 260, -520, 'x', 1800, 30, 120, 913, 0.55);
    return b;
  },
  disney(b, k) { disneyCastle(b, 0, 0, k); distantSkyline(b, 0, -520, 'x', 1500, 26, 90, 1131, 0.5); return b; },
  /* 湖是"侧景"，不是"跨线"：半径必须明显小于观看距离，否则环湖路会一路
     铺到线路中心线底下（实测 3.9 m，等于马路从轨道下面穿过去）。 */
  lake(b, k, dist) {
    const r = Math.min(900 * (k || 1), Math.max(260, (dist == null ? 900 : dist) * 0.72));
    lakeDisc(b, 0, 0, r, WATER_Y);
    distantSkyline(b, 0, -(r + 620), 'x', 2200, 22, 70, 1331, 0.4);
    return b;
  },
  airport(b, k) { airportTerminal(b, 0, 0, k); return b; },
  stadium(b, k) { stadium(b, 0, 0, 190 * k, k); return b; },
  expo(b, k) {
    // 中华艺术宫：倒梯形斗冠层叠（原世博中国馆）
    for (let i = 0; i < 4; i++) {
      const w = (46 + i * 26) * k, y = (30 + i * 22) * k;
      b.box([0, y, 0], [w, 20 * k, w * 0.72], rgb('#b3282c'), { mat: 'paint', emi: 0.16 });
    }
    b.box([0, 12 * k, 0], [40 * k, 24 * k, 30 * k], rgb('#8f2b2e'), { mat: 'paint' });
    distantSkyline(b, 0, -480, 'x', 1700, 28, 110, 1531, 0.6);
    return b;
  },
  river(b, k) {
    // 江面与轨道平行挂在侧方（斜看江面）：局部 x = 江的走向，+z 朝向观看者。
    // 尺度按黄浦江市区段实测（宽 400~560 m），不能再放大——比这更宽的"江"
    // 在远裁剪面与雾的衰减下只会变成一片糊在天空里的半透明膜。
    waterBand(b, 0, 0, 'x', 2600, 620, WATER_Y);
    boats(b, 6, 0, 1000, 0, 170, WATER_Y, 'x');
    // 对岸与近岸都必须有堤岸 + 城市轮廓，否则水面像悬在虚空里
    apron(b, 0, -1600, 2700, 560, 2.6);
    apron(b, 0, 1650, 2400, 520, 2.6);
    distantSkyline(b, 0, -1700, 'x', 2500, 44, 145, 771, 0.72);
    distantSkyline(b, 0, 1760, 'x', 2200, 30, 92, 1231, 0.55);
    return b;
  },
/**
 * 正交跨江：列车从桥上过河。局部 x = 轨道方向（=桥轴），
 * 所以江的**长度**铺在 z 上（上下游），**江面宽**（620 m，黄浦江市区段实测）
 * 落在 x 上，正好横切轨道。
 *
 * y 取 +3.2：地标锚点在轨面下 12 m，而高架街面在轨面下 10.5 m
 * （见 WorldBuilder.ground）。水面若按真实高程放在街面以下，会被
 * 那条 220 m 宽的地面条带整个挡住——看起来就是"过河时地面突然吞了江"。
 * 抬到街面之上 1 m，桥墩从水里穿出来，才是从车窗看到的样子。
 */
  crossing(b, k, dist, env) {
    /* 锚点在轨道侧方 dist 米，而桥与江都必须**正穿线路**，所以整组几何
       先沿 −z 平移 dist，让桥轴与水面中心正好落在线路中心线上。
       不这么做的话，桥塔会立在轨道侧面几百米处，列车过河时看不见桥，
       观景相机也框不到塔——实测就是"一条高架凭空伸进江里"。
       env.dyAt（D3）：place() 交进来的"局部 x → 轨面竖向偏移"回调，
       桥面与塔据此跟随纵断面；env 缺省（离线判据直接调 builder）时是平桥。 */
    const o = -(dist || 0);
    const dyFn = env && env.dyAt ? x => env.dyAt(x) : null;
    /* 江面必须**铺到对岸堤脚**：原来 band 长 2400（±1200），而堤岸 apron 摆在
       ±1750，中间那 550 m 露的是跟随相机的远景地面（比水面低 2 m）——
       截图里就是江尽头一道硬台阶线。现在 3000 长的水面末端正好压在 apron 底下。 */
    waterBand(b, 0, o, 'z', 3000, 620, WATER_Y);
    boats(b, 4, 0, 190, o, 900, WATER_Y, 'z');
    cableBridge(b, 0, o, 300, 118, 12, dyFn);
    apron(b, 0, o - 1500, 700, 620, 2.6);
    apron(b, 0, o + 1500, 700, 620, 2.6);
    distantSkyline(b, 0, o - 1820, 'z', 2000, 34, 120, 947, 0.66);
    distantSkyline(b, 0, o + 1880, 'z', 2000, 30, 96, 1481, 0.55);
    return b;
  },
  /** 运河/苏州河级别的水道（宽 80 m 上下）：6 号线巨峰路跨浦东运河用这个 */
  creek(b, k, dist) {
    const o = -(dist || 0);              // 同 crossing：把水道平移到线路正下方
    waterBand(b, 0, o, 'z', 1500, 84, WATER_Y);
    boats(b, 3, 0, 26, o, 520, WATER_Y, 'z');
    girderBridge(b, 0, o + 210, 1);      // 下游 210 m 处的公路桥
    // 两岸滨河路 + 一排沿江楼房（都在轨道另一侧，避免与高架墩重叠）
    for (const s of [-1, 1]) {
      b.box([s * 62, 2.4, o], [17, 1.2, 1400], rgb('#6a7278'), { mat: 'asphalt', faces: [2], uv: 1 / 24 });
      for (let i = 0; i < 9; i++) {
        const z = o - 620 + i * 150, h = 16 + SH.rand01('crk', i + (s + 1) * 9) * 26;
        b.box([s * (118 + (i % 2) * 26), h / 2, z], [22, h, 46], rgb('#8b949b'),
          { mat: 'bldgWin', emi: 0.24, uv: SH.FACADE_UV });
      }
    }
    return b;
  },
  bridge(b, k) {
    // 只有桥塔与桥面（配合另一侧的 river/crossing 使用，或独立成景）
    cableBridge(b, 0, 0, 280, 132);
    return b;
  },
  /**
   * 远处城市轮廓。原来写死在局部 z = −300（= 离轨道 dist+300 米），
   * 而 VIEWSPOTS 给的 dist 是 1400~1600，于是这排楼在 1.7~1.9 km 外，
   * 170 m 的高度到机位只剩 6° —— test-shot.js 量到主体只占画面 0.4%，
   * 半屏天空半屏地面，"天际线"这一档构图基本是废的。
   * 现在把它钉在离轨道 560 m 处（楼群走廊外缘 88 m 之外、又近得能压住画面），
   * dist 只用来决定"从哪个方向看"，不再决定"有多远"。
   */
  skyline(b, k, dist) {
    const d = dist == null ? 900 : dist;
    distantSkyline(b, 0, d - 560, 'x', 2400, 52, 170, 171, 0.7);
    return b;
  },
  /**
   * 外高桥集装箱港区（6 号线港城路/外高桥保税区一带）。
   * 局部 +z 朝向轨道，所以"往江里走"是 −z，且**所有构件都必须放在 −z 一侧**：
   * 曾经把堆场放在 +z（朝轨道那侧），结果堆场直接压到线路中心线上，
   * 观景相机开进去就是一面贴着镜头的铁皮墙。现在的排布从轨道往外依次是
   * 堆场 → 码头平台 → 岸桥 → 泊位 → 江面，全部落在 −z 方向 500 m 以外。
   */
  /**
   * 外高桥集装箱港区（6 号线港城路 / 10 号线 double-check，见 VIEWSPOTS）。
   *
   * **横向（局部 x，沿轨道）不缩，进深（局部 z，往江里走）整体乘 Z=0.42。**
   * 原来这套布局的进深从堆场一路排到 −2600 m 之外的江心，加上 place() 的
   * dist=420，等于最近的东西也在轨道外侧 1 km、江面在 2.4 km 外——
   * test-shot.js 量出来"堆场+岸桥+江面合计只占画面 2.7%"，观景机位拍港区
   * 就是一排模糊的小色块。桥吊的真实比例本来就在百米级（轨距 ~30 m、
   * 门架高 ~90 m），把进深压到 0.42 倍后轨距 66→28 m 反而更准，
   * 而 90 m 高的桥吊从 1 km 外挪到 500 m 外，画面占比直接翻四倍。
   * 沿轨道方向（x）不能一起缩：那是 34 列箱区 + 5 台桥吊的排布，
   * 缩了就成了"一个停车场上摆了五个玩具"。
   */
  port(b, k) {
    /* Z() 只搬**位置**（往线路方向挪 200 m 并压到 0.42 倍），尺寸与相对差一律
       直接乘 0.42 —— 把 Z() 用在"腿距 26 m"这类差值上会凭空多出 200 m。 */
    const Z = v => v * 0.42 + 200, S = v => v * 0.42;
    /* 江面从堤脚一直铺到对面的岸。外高桥这一段黄浦江实测宽 1.5~2 km，
       原来只铺 756 m 宽就断在江心，截图里"港区后面是一片平地"——
       近侧边缘仍然压在码头平台底下（−514），只把远侧推到 2.3 km 外。 */
    waterBand(b, 0, Z(-2600) - 500, 'x', 2400, S(1800) + 1000, WATER_Y);
    // 码头前沿平台
    b.box([0, 2.4, Z(-1450)], [2300, 6.4, S(500)], rgb('#788087'), { mat: 'concrete', faces: [2], uv: 1 / 40 });
    /* 堆场自己的地坪。少了这块，五颜六色的箱子就是直接飘在远景地面的航拍
       纹理上——截图里看就是"彩色积木撒在地图上"。铺到箱区外沿再多 60 m，
       连同轨道沟槽的深色边带一起，堆场才像一个场地。 */
    b.box([0, 0.9, Z(-760)], [2300, 1.8, S(460)], rgb('#6d7378'), { mat: 'concreteD', faces: [2], uv: 1 / 40 });
    // 集装箱堆场：确定性的彩色矩阵，最高三层
    /* 配色要"晒旧了的集装箱"，不是新玩具。原来六个高饱和原色 + emi 0.06，
       从 126 m 高的观景机位看下去就是一块彩虹地毯铺在港区里，是这一屏
       最"程序化"的地方。换成带灰的旧色，再按垛给 0.78~1.0 的明暗抖动，
       整片堆场才有"晒了几年"的层次。 */
    const cols = ['#8e4038', '#33566e', '#9a7a3c', '#3f6b4f', '#8d949a', '#5d4a70', '#6b7066'];
    for (let i = 0; i < 34; i++) {
      const x = -1050 + i * 64;
      for (let j = 0; j < 4; j++) {
        const z = Z(-620 - j * 92);
        const n = 1 + ((i * 7 + j * 3) % 3);
        for (let h = 0; h < n; h++) {
          const c0 = rgb(cols[(i + j * 3 + h) % cols.length]);
          const k = 0.78 + 0.22 * SH.rand01('ctr', i * 5 + j * 71 + h);
          const c = [c0[0] * k, c0[1] * k, c0[2] * k];
          b.box([x, 4.0 + h * 3.1, z], [58, 2.9, 21], c, { mat: 'paint', faces: [2, 0, 1, 4, 5] });
        }
      }
    }
    /* 岸桥（STS）。第一次写的时候把尺度搞崩了：前伸臂 1040 m、拉索 1000 m，
       等于给每台桥吊装了一公里长的吊臂，从远处看就是一团扇形钢梁糊住半个天空。
       按真实桥吊量级重做：轨距 ~30 m、门架高 ~90 m、前伸臂外伸 ~65 m、后拉臂 ~20 m，
       整台机器控制在 200 m 见方以内。 */
    for (let i = 0; i < 5; i++) {
      const x = -900 + i * 450, gy = rgb('#e2e7ea');
      const zLand = Z(-1560), zSea = Z(-1626), top = 92;
      for (const s of [-1, 1]) {
        strut(b, [x + s * 15, 3, zLand], [x + s * 15, top, zLand], 3.2, gy, { mat: 'steel' });
        strut(b, [x + s * 15, 3, zSea], [x + s * 15, top, zSea], 3.2, gy, { mat: 'steel' });
        // 海侧腿做成 A 形撑到轨道外侧，这是桥吊抗倾覆的主要结构
        strut(b, [x + s * 15, 3, zSea - S(26)], [x + s * 15, top * 0.62, zSea + S(4)], 2.2, gy, { mat: 'steel' });
      }
      b.box([x, top + 2, (zLand + zSea) / 2], [40, 6, S(130)], gy, { mat: 'steel' });
      b.box([x, top + 12, zLand + S(6)], [26, 14, S(34)], rgb('#d8a12a'), { mat: 'paint', emi: 0.22 });   // 司机室
      // 前伸臂（探到船上方）与后拉臂（压在陆侧配重上）
      b.box([x, top + 1, Z(-1700)], [16, 4.2, S(170)], gy, { mat: 'steel' });
      b.box([x, top + 1, Z(-1455)], [16, 4.2, S(80)], gy, { mat: 'steel' });
      // 塔冠 + 拉索：索从塔顶分别挂到前伸臂与后拉臂上
      b.box([x, top + 34, (zLand + zSea) / 2], [14, 62, 14], gy, { mat: 'steel' });
      beacon(b, [x, top + 68, (zLand + zSea) / 2], 1.3);
      for (let c = 0; c < 4; c++) {
        const zc = Z(-1640 - c * 34);
        strut(b, [x, top + 62, (zLand + zSea) / 2], [x, top + 3, zc], 0.5, rgb('#8f9aa2'), { mat: 'steel' });
      }
      strut(b, [x, top + 62, (zLand + zSea) / 2], [x, top + 3, Z(-1470)], 0.5, rgb('#8f9aa2'), { mat: 'steel' });
      // 吊具
      b.box([x, top - 12, Z(-1690)], [14, 3, 7], rgb('#d8a12a'), { mat: 'paint' });
    }
    // 靠泊船 + 堆场照明塔
    boats(b, 3, 0, 900, Z(-2150), S(420), WATER_Y, 'x');
    for (let i = 0; i < 6; i++) {
      const x = -1100 + i * 420;
      b.box([x, 25, Z(-800)], [2.6, 44, 2.6], rgb('#9aa4ab'), { mat: 'steel' });
      b.box([x, 48, Z(-800)], [12, 2.4, 3.4], rgb('#f2f5f7'), { mat: 'light', emi: 0.95 });
    }
    distantSkyline(b, 0, Z(-3900), 'x', 1800, 22, 66, 2411, 0.5);
    return b;
  },
  zoo(b, k) {
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2, r = (150 + (i % 3) * 70) * k;
      b.sphere([Math.cos(a) * r, 26 * k, Math.sin(a) * r], [46 * k, 30 * k, 46 * k], { mat: 'foliage', color: rgb('#3d6b42'), emi: 0.05, segU: 10, segV: 6 });
    }
    return b;
  },
  circuit(b, k) {
    // 上赛场：看台环 + 主直道
    b.ringStack('concrete', [{ y: 12 * k, rx: 300 * k, rz: 190 * k }, { y: 34 * k, rx: 316 * k, rz: 206 * k }], rgb('#c8ced2'), { seg: 26, uvY: 0.01, capTop: false });
    b.box([0, 1 * k, -420 * k], [620 * k, 2 * k, 34 * k], rgb('#3a4045'), { mat: 'asphalt', faces: [2], uv: 1 / 24 });
    return b;
  },

  sheshan(b, k) {
    // 佘山：上海唯一的陆地山丘（西佘山高差约百米）—— 山体（两座球丘：西佘山 +
    // 东佘山）、山顶天文台（白色球顶 + 观测窗缝）与半山的圣母大殿红顶。
    // 全网唯一"山地"特色；9 号线佘山~泗泾实际为高架段，车窗里正对山体。
    b.sphere([0, 0, 0], [430 * k, 98 * k, 320 * k], { mat: 'foliage', color: rgb('#4a6144'), segU: 16, segV: 9 });
    b.sphere([640 * k, 0, -180 * k], [250 * k, 60 * k, 210 * k], { mat: 'foliage', color: rgb('#44593f'), segU: 12, segV: 7 });
    /* 天文台：山顶圆顶观测室。山顶取 y ≈ 峰高（球心在地面，峰在 +98）。 */
    const ty = 98 * k;
    b.box([0, ty - 2 * k + 9 * k, 0], [26 * k, 18 * k, 26 * k], rgb('#dfe5e9'), { mat: 'paint' });
    b.sphere([0, ty - 2 * k + 18 * k + 5 * k, 0], [11 * k, 9 * k, 11 * k], { mat: 'paint', color: rgb('#eef2f4'), segU: 12, segV: 8 });
    b.box([0, ty - 2 * k + 18 * k + 9 * k, 10.4 * k], [2.2 * k, 6 * k, 1.2 * k], rgb('#39424a'), { mat: 'metal' });
    /* 圣母大殿：西坡上红顶小殿（按椭圆截面取坡高：x=180, z=-120）。 */
    const by = 98 * k * Math.sqrt(Math.max(0, 1 - (180 / 430) ** 2 - (120 / 320) ** 2));
    b.box([180 * k, by + 7 * k, -120 * k], [30 * k, 14 * k, 16 * k], rgb('#b9c2c8'), { mat: 'paint' });
    b.box([180 * k, by + 15.5 * k, -120 * k], [34 * k, 3 * k, 20 * k], rgb('#8c2f2b'), { mat: 'roof' });
    return b;
  },
};

/** 这些 kind 的水面是"横切轨道"的，观景相机要沿桥轴取景，不能盯着侧面锚点 */
const CROSS_KINDS = { crossing: 1, creek: 1 };

/**
 * 把地标群并入世界 builder。
 * @param al     Alignment
 * @param s      观看点里程
 * @param side   地标在轨道的哪一侧（-1 左 / +1 右）
 * @param dist   观看距离（米，艺术化压缩）
 * @param kind   BUILDERS 键
 */
function place(b, al, s, side, dist, kind) {
  const fns = BUILDERS[kind];
  if (!fns) return false;
  const sub = new Builder();
  /* D3：跨江类把**线形**交进构建函数 —— 桥面要跟着纵断面走。
     局部 +x 在世界里的方向由 place 自己的基给出：right · 轨道前向 的符号
     决定"局部 +x 对应里程 +x 还是 −x"，逐点取 yTrack(s + x·dir) − yTrack(s)。
     不这么对齐的话，桥台处桥面与轨面能错开好几米（桥是水平的、线路带坡）。 */
  const fr0 = al.frame(s);
  {
    const toCam0 = [fr0.r[0] * -side, 0, fr0.r[2] * -side];
    const fwd0 = norm3(toCam0);
    const right0 = norm3(cross([0, 1, 0], fwd0));
    const dirX = Math.sign(right0[0] * fr0.f[0] + right0[2] * fr0.f[2]) || 1;
    const yAt = m => al.frame(Math.max(0, Math.min(al.total, m))).p[1];
    const y0 = yAt(s);
    fns(sub, 1, dist, { dyAt: x => yAt(s + x * dirX) - y0 });
  }
  if (!sub.vertexCount) return false;
  const fr = al.frame(s);
  // 局部 +z 朝向观看者 ⇒ 世界前向取轨道横向的反方向（从地标看回轨道）
  const toCam = [fr.r[0] * -side, 0, fr.r[2] * -side];
  const fwd = norm3(toCam);
  const right = norm3(cross([0, 1, 0], fwd));
  const up = cross(fwd, right);
  /* 锚点必须落在**水平地面系**里。al.world() 用的是轨道自己的右手系，
     r 带着超高（cant 最大 0.034 rad）：横向 900 m 就附带 31 m 的垂直位移，
     淀山湖因此被压到远景地面底下，观景机位拍出来是一片街区、没有水。
     地标是地面上的东西，不该跟着轨道的超高一起倾斜。 */
  const origin = al.ground(fr, side * dist, -12);
  const M = SH.m4basis(right, up, fwd, origin);
  const nm = SH.m3normalFromM4(M);
  /* 先量出这个地标在世界系里的包围盒（merge 会把 sub 清空，之后就拿不到了）。
     test-facade.js 用它判断"观景机位到底把地标框住了多少"——
     以前那条检查只验证视线不被楼群挡住，于是跨江机位拍出来江面只占画面
     最下面一条、桥小得像火柴棍，测试却全绿。构图也要有机器判据。 */
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], mlat = 1e9;
  const rp = fr.p, rv = fr.r;
  for (const bk of sub.buckets.values()) {
    for (let i = 0; i < bk.pos.length; i += 3) {
      const x = bk.pos[i], y = bk.pos[i + 1], z = bk.pos[i + 2];
      for (let c = 0; c < 3; c++) {
        const w = M[c] * x + M[4 + c] * y + M[8 + c] * z + M[12 + c];
        if (w < mn[c]) mn[c] = w;
        if (w > mx[c]) mx[c] = w;
      }
      /* 这个顶点离线路中心线的横向距离。地标现在按 dist 往线路方向搬近
         （为了让主体真能占住画面，见 test-shot.js），搬多近必须有判据：
         世界两侧的楼群占到横向 88.8 m，再往里就是互相穿插。 */
      const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
      const lat = Math.abs((wx - rp[0]) * rv[0] + (wy - rp[1]) * rv[1] + (wz - rp[2]) * rv[2]);
      if (lat < mlat) mlat = lat;
    }
  }
  const bbox = { min: mn, max: mx };
  b.merge(sub, M, nm);
  // 返回地标群的世界锚点、包围盒与最小横向距离，供观景相机朝向与构图检查使用
  return { kind, origin, s, side, dist, minLat: mlat, cross: !!CROSS_KINDS[kind], bbox };
}

SH.landmarks = { BUILDERS, place, CROSS_KINDS, WATER_Y, apron, pearlTower, jinmao, swfc, shanghaiTower, bundRow, disneyCastle, distantSkyline, waterBand, lakeDisc, airportTerminal, stadium, expo: null, strut, beacon, plane, boats, cableBridge, girderBridge };
SH.LANDMARK_KINDS = Object.keys(BUILDERS);

})(typeof window !== 'undefined' ? window : globalThis);
