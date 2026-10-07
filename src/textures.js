/* ============================================================================
 * textures.js — 程序化贴图与标识图集
 *
 * 全部贴图在运行时用 2D canvas 画出来，不下载任何图片。
 * 关键约束：**必须可无缝平铺**，所以噪声用"网格取模 + 双线性插值"生成，
 * 而不是 Math.random 逐像素（那样平铺处会有明显接缝）。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { clamp, rng, rgbOf } = SH;

function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const CN_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",sans-serif';

/* ------------------------------------------------------- 可平铺噪声场 */
/**
 * 生成一个周期性的值噪声函数（在 [0,size) 上平铺）。
 * @param cells 网格数（越大越细）
 */
function tileNoise(size, cells, seed) {
  const g = new Float32Array(cells * cells);
  const r = rng(seed);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sm = t => t * t * (3 - 2 * t);
  return function (x, y) {
    const fx = x / size * cells, fy = y / size * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = sm(fx - x0), ty = sm(fy - y0);
    const at = (a, b) => g[((b % cells) + cells) % cells * cells + ((a % cells) + cells) % cells];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}
/** 多倍频叠加 */
function tileFbm(size, cells, seed, oct) {
  const layers = [];
  for (let i = 0; i < (oct || 4); i++) layers.push({ n: tileNoise(size, Math.max(2, cells << i), seed + i * 7717), a: 1 / (1 << i) });
  const tot = layers.reduce((s, l) => s + l.a, 0);
  return (x, y) => layers.reduce((s, l) => s + l.n(x, y) * l.a, 0) / tot;
}

/** 诊断口：最后一次 `paint()` 用的逐像素函数与边长。
 *  判据（test-tex ①）用它做**精确的周期检验**：`f(0,y) === f(size,y)`。
 *  光看画出来的那一张图是判不出周期性的 —— 非周期项只要在接缝上恰好和
 *  图内某条强边一样陡，"比图内最大差"就放它过去（第一版实测：把釉面反光
 *  改成 `j/S` 的绝对坐标渐变，判据照样绿）。周期这件事只有问生成函数本身。 */
let lastPaintFn = null, lastPaintSize = 0;
/** 把逐像素函数画到 canvas */
function paint(size, fn) {
  lastPaintFn = fn; lastPaintSize = size;
  const c = cv(size, size), x = c.getContext('2d'), img = x.createImageData(size, size), d = img.data;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const o = (j * size + i) * 4, p = fn(i, j, i / size, j / size);
    d[o] = clamp(p[0], 0, 255); d[o + 1] = clamp(p[1], 0, 255); d[o + 2] = clamp(p[2], 0, 255);
    d[o + 3] = p[3] == null ? 255 : clamp(p[3], 0, 255);
  }
  x.putImageData(img, 0, 0);
  return c;
}

/**
 * 从一张贴图的**亮度**推一张法线贴图（Sobel 差分）。
 *
 * 为什么要有它：这个项目里"画面读起来平"的最大来源不是几何不够密，而是
 * **每个面都没有浮雕** —— 一块 1024² 的花岗岩贴图再细，只要光照是按"完全平整的
 * 平面"算的，近看就还是一块印了花纹的板子。法线贴图是这一步最省的解法：
 * 不动任何几何、不加任何三角形，只让法向随贴图的高度起伏。
 *
 * 高度直接取反照率的亮度 —— 对"缝/倒角/砖缝/骨料"这类贴图，亮的地方本来就高、
 * 暗的地方本来就低，所以亮度当高度是合理的近似（真实做法是另画一张高度图，
 * 但那要把每个 builder 都改一遍；这里先用通用近似把机制立起来）。
 *
 * @param strength 起伏强度（越大越"凸"）。花岗岩的板缝只有 2 px 宽，
 *                 强度给小了看不见、给大了会出一圈黑边。
 */
function normalFromCanvas(src, strength) {
  const S = src.width, H = src.height;
  const d = src.getContext('2d').getImageData(0, 0, S, H).data;
  const lum = (x, y) => {
    const o = (((y % H) + H) % H * S + (((x % S) + S) % S)) * 4;
    return (d[o] * 3 + d[o + 1] * 6 + d[o + 2]) / 10 / 255;
  };
  const k = strength == null ? 2.2 : strength;
  const out = cv(S, H), ox = out.getContext('2d'), img = ox.createImageData(S, H), p = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < S; x++) {
    const dx = (lum(x + 1, y) - lum(x - 1, y)) * k;
    const dy = (lum(x, y + 1) - lum(x, y - 1)) * k;
    let nx = -dx, ny = -dy, nz = 1;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = (y * S + x) * 4;
    p[o] = (nx * 0.5 + 0.5) * 255; p[o + 1] = (ny * 0.5 + 0.5) * 255;
    p[o + 2] = (nz * 0.5 + 0.5) * 255; p[o + 3] = 255;
  }
  ox.putImageData(img, 0, 0);
  return out;
}

/** 要生成法线贴图的材质 → 起伏强度（不给 = 不生成）。 */
const NRM_STRENGTH = {
  granite: 2.4, tiles: 2.4, concrete: 2.2, concreteD: 1.8, segment: 2.0,
  metal: 1.6, rail: 1.4, asphalt: 1.6, ballast: 3.2, brick: 2.6, roof: 1.6, noise: 1.2,
};

/* ==================================================================== 贴图 */
const BUILDERS = {
  /** 1×1 白，作为无贴图时的兜底 */
  white: () => { const c = cv(2, 2), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 2, 2); return c; },

  /** 现浇混凝土：**模板板（2.4×1.2 m）+ 模板缝 + 对拉螺栓孔 + 骨料 + 水渍**。
   *  明挖箱涵的内壁就是"模板浇出来的一面墙"，最可读的四个特征全在模板上：
   *  板缝、板面的对拉螺栓孔、骨料颗粒、渗水的水渍。旧版只有噪声 + 一片水渍，
   *  近看是一面"没浇过模板的灰墙"。一个循环 = 2×4 块模板板 = 4.8×4.8 m。 */
  concrete: () => {
    const S = 1024, PW = 512, PH = 256;                  // 一块模板 2.4×1.2 m
    const n1 = tileFbm(S, 90, 11, 3), n2 = tileNoise(S, 10, 23), n3 = tileNoise(S, 420, 31);
    const agg = tileNoise(S, 1500, 37), stain = tileNoise(S, 6, 43);
    return paint(S, (i, j) => {
      const px = i % PW, py = j % PH;
      const bev = Math.min(px, PW - 1 - px, py, PH - 1 - py);
      let v = 0.625
        + (n1(i, j) - 0.5) * 0.170                          // 大块色差
        + (n3(i, j) - 0.5) * 0.070                          // 细砂面
        + (agg(i, j) - 0.5) * 0.045;                        // 骨料颗粒
      v -= Math.max(0, n2(i, j) - 0.62) * 0.28;             // 大片水渍
      v -= Math.max(0, stain(i, j) - 0.58) * 0.16;          // 渗流的暗带
      if (bev < 2) v -= 0.17;                               // 模板缝
      else if (bev < 7) v += (7 - bev) / 5 * 0.045;         // 缝边的一点点泛浆
      /* 对拉螺栓孔：每块模板一对（横向 ±0.42），孔口一圈深、孔外一圈浅 */
      const tx = (px / PW - 0.5) * 2, ty = (py / PH - 0.5) * 2;
      const dh = Math.min(Math.hypot(tx - 0.44, ty), Math.hypot(tx + 0.44, ty));
      if (dh < 0.055) v -= 0.34 * (1 - dh / 0.055);
      else if (dh < 0.10) v += 0.05 * (1 - (dh - 0.055) / 0.045);
      const b = clamp(v, 0.2, 0.95) * 255;
      return [b * 0.985, b, b * 1.02];
    });
  },
  /** 暗色混凝土（整体道床板 / 隧道底 / 结构暗面）：更密的骨料 + 更低的基色。
   *  512²：它铺在轨道底下、被车轮与道床结构挡掉大半，不值得 1024² 的生成开销。 */
  concreteD: () => {
    const S = 512;
    const n1 = tileFbm(S, 36, 71, 4), n3 = tileNoise(S, 260, 91), agg = tileNoise(S, 900, 97);
    return paint(S, (i, j) => {
      const v = 0.34 + (n1(i, j) - 0.5) * 0.15 + (n3(i, j) - 0.5) * 0.075 + (agg(i, j) - 0.5) * 0.05;
      const b = clamp(v, 0.08, 0.7) * 255;
      return [b * 0.96, b, b * 1.05];
    });
  },

  /**
   * 盾构管片：u = 环向（一整圈），v = 轴向（6 m 一环）。
   * 这是隧道观感的主体——环缝、纵向缝、螺栓孔、注浆痕、拱腰污损全在这里。
   */
  segment: () => {
    const S = 512;
    const grain = tileFbm(S, 96, 5, 4), blot = tileNoise(S, 10, 17), dirt = tileNoise(S, 26, 44);
    return paint(S, (i, j, u, v) => {
      // 环缝（每 6 m 一道）：把 v=0 附近画成凹槽 + 下缘高光
      const ringD = Math.min(v, 1 - v);
      let b = 0.74 + (grain(i, j) - 0.5) * 0.13;
      let r = b, g = b, bl = b;
      if (ringD < 0.022) { const k = 1 - ringD / 0.022; b -= k * 0.42; }
      else if (ringD < 0.038) { b += (0.038 - ringD) / 0.016 * 0.10; }   // 缝下缘反光
      // 纵向缝：一环 6 块标准管片 + 1 块封板
      const cols = 6, cu = u * cols, cf = cu - Math.floor(cu);
      if (cf < 0.012 || cf > 0.988) b -= 0.26;
      // 螺栓孔：环缝两侧各一排
      const boltRow = (Math.abs(v - 0.055) < 0.016 || Math.abs(v - 0.945) < 0.016 || Math.abs(v - 0.5) < 0.014);
      if (boltRow) { const bp = Math.abs(((u * cols * 2) % 1) - 0.5); if (bp < 0.075) { b -= 0.30; r -= 0.02; } }
      // 拱腰污损与渗流痕（v 大 = 靠近底部）
      /* 渗流痕的坐标缩放必须取整数倍（`i*2.2` 这种非整数缩放会让平铺裂缝）。 */
      const drip = Math.max(0, dirt(i * 2, j) - 0.66) * 1.4;
      /* 沿轴向的权重必须**周期**（v 是轴向、6 m 一环，要平铺）：
         旧版写 `(0.35 + v)` —— v=0 与 v=1 差一整倍，每 6 m 一道横缝。 */
      b -= drip * 0.22 * (0.35 + 0.65 * (0.5 - 0.5 * Math.cos(v * Math.PI * 2)));
      // 整体明暗：顶部偏暗、腰侧偏亮（配合灯带位置）
      const side = Math.abs(u - 0.5) * 2;
      b *= 0.90 + side * 0.16;
      b -= Math.max(0, blot(i, j) - 0.6) * 0.14;
      const k = clamp(b, 0.12, 0.95) * 255;
      return [k * 0.97, k * 0.99, k * 1.03];
    });
  },

  /** 拉丝金属：设备箱、扶手、屏蔽门框。**沿 U（线路方向）的细长丝纹 + 零星划痕**，
   *  丝纹按行取模，平铺时接得上。 */
  metal: () => {
    const S = 512, streak = tileNoise(S, 3, 3), fine = tileNoise(S, 160, 8), scratch = tileNoise(S, 40, 9);
    return paint(S, (i, j) => {
      let b = 0.575
        + (streak(i, j) - 0.5) * 0.075            // 大块的轧制色差
        + (fine(i, j) - 0.5) * 0.075              // 拉丝（沿 U 细长，靠各向异性的 cells 造）
        + (scratch(i, j) - 0.5) * 0.045;
      /* 轧辊痕：频率必须取"整数个周期 / 一个贴图循环"，否则平铺处相位对不上，
         接缝上会出现一道明显的横纹（`Math.sin(j * 1.7)` 就是这种写法）。 */
      b += Math.sin(j * (Math.PI * 2 * 140) / S) * 0.010;
      const k = clamp(b, 0.22, 0.9) * 255;
      return [k, k * 1.008, k * 1.035];
    });
  },
  /** **钢轨**：轨头（V 0.54~0.71，见 railProfile 的截面点序）是被车轮磨亮的
   *  银白面，轨腰与轨底是氧化发暗的钢 —— 这是"这是钢轨"最直接的一条视觉证据。
   *  V 沿截面周长走（`uvAlong: 1/2, vSpan: 1`），所以纵向拉丝按 U 排。 */
  rail: () => {
    const S = 512, fine = tileNoise(S, 180, 8), band = tileNoise(S, 26, 12);
    return paint(S, (i, j, u, v) => {
      // 轨头亮带：V 0.54~0.71 全亮，两侧轨头斜面次之，轨腰/轨底发暗
      let head;
      if (v > 0.536 && v < 0.711) head = 1.0;
      else if (v > 0.408 && v <= 0.536) head = 1 - (0.536 - v) / 0.128 * 0.55;
      else if (v >= 0.711 && v < 0.840) head = 1 - (v - 0.711) / 0.129 * 0.55;
      else head = 0.45;
      const b = (0.30 + head * 0.60)
        + (fine(i, j) - 0.5) * 0.10                       // 纵向磨痕
        + (band(i, j) - 0.5) * 0.06;
      const k = clamp(b, 0.18, 1.0) * 255;
      return [k * 0.985, k, k * 1.02];
    });
  },

  /** 站台花岗岩（磨光面）：**600×600 板材 + 2 mm 缝 + 倒角高光 + 磨光斑纹**。
   *
   *  一个循环 = 4×4 块板 = 2.4 m，所以调用点的 UV 必须是"每 2.4 m 一个循环"。
   *  以前这里是 512² 上一个 `i % 128` 的细缝，而**调用点的 V 是 1 个循环摊在
   *  整条截面周长上**（站台板周长 18.8 m）—— 于是 0.3 m 的缝被拉成 4.7 m，
   *  地面读成"一条条顺着股道的长条"，不是方砖。贴图与 UV 一起改（见 station()
   *  站台板那一次 sweep 的 uvAlong / vSpan）。
   *
   *  三条细节都是有出处的：板缝 2 mm（真实磨光花岗岩留缝量级）、倒角 1~2 mm
   *  的 45° 棱（磨光面最显眼的特征，一道亮边 + 缝底一道暗）、磨光斑纹是
   *  花岗岩本身的矿物颗粒（细密高对比）叠大块色差（同一批板材的色号差）。 */
  granite: () => {
    const S = 1024, N = 4, cell = S / N;                 // 4×4 块板，一块 256 px
    const grain = tileNoise(S, 700, 13), grain2 = tileNoise(S, 260, 19);
    const slab = tileFbm(S, 6, 21, 3), sheen = tileFbm(S, 3, 29, 2);
    return paint(S, (i, j) => {
      const gx = i % cell, gy = j % cell;
      const bev = Math.min(gx, cell - 1 - gx, gy, cell - 1 - gy);   // 到最近的板边（px）
      let b = 0.615
        + (grain(i, j) - 0.5) * 0.115                              // 矿物颗粒
        + (grain2(i, j) - 0.5) * 0.055
        + (slab(i, j) - 0.5) * 0.050                               // 色号差
        + (sheen(i, j) - 0.5) * 0.035;                             // 磨光面的反光不均
      if (bev < 1.2) b -= 0.32;                                    // 2 mm 板缝（缝底暗）
      else if (bev < 5) b += (5 - bev) / 3.8 * 0.085;              // 45° 倒角高光
      const k = clamp(b, 0.16, 0.94) * 255;
      return [k * 1.012, k, k * 0.972];                            // 冷灰花岗岩
    });
  },
  /** 站台侧墙瓷片：**300×600 釉面砖**（横向 2 块一循环、错缝）+ 2 mm 缝 + 釉面反光。
   *  釉面砖的三个可读特征：规整的错缝网格、缝比砖暗得多、釉面有一道由上到下的
   *  柔和反光（真实釉面砖在站台灯下的样子）。旧版是 512² 上一张几乎没结构的灰图，
   *  近看就是"一块灰墙"。 */
  tiles: () => {
    const S = 1024, TW = 512, TH = 256;                  // 2×4 块砖
    const body = tileFbm(S, 60, 33, 3), glaze = tileFbm(S, 4, 37, 2), spk = tileNoise(S, 900, 41);
    return paint(S, (i, j) => {
      const row = Math.floor(j / TH), ox = (row % 2) * TW / 2;
      const sx = (i + ox) % TW, sy = j % TH;
      const bev = Math.min(sx, TW - 1 - sx, sy, TH - 1 - sy);
      let b = 0.855
        + (body(i, j) - 0.5) * 0.040
        + (spk(i, j) - 0.5) * 0.020
        + (glaze(i, j) - 0.5) * 0.055;
      if (bev < 1.2) b -= 0.36;                                    // 缝（最暗）
      else if (bev < 4) b += (4 - bev) / 2.8 * 0.070;              // 砖棱高光
      /* 釉面反光：必须是**周期**函数（一个循环内首尾接得上），
         `pow(1-sy/TH, 2.2)` 这种"从顶到底衰减"在平铺处会突然跳回去。 */
      b += (0.5 + 0.5 * Math.cos(sy / TH * Math.PI * 2)) * 0.030;
      const k = clamp(b, 0.20, 1) * 255;
      return [k * 0.994, k, k * 1.010];
    });
  },
  asphalt: () => {
    const S = 512, n = tileFbm(S, 128, 41, 4), p = tileNoise(S, 300, 55);
    return paint(S, (i, j) => {
      let b = 0.30 + (n(i, j) - 0.5) * 0.16 + (p(i, j) - 0.5) * 0.13;
      const k = clamp(b, 0.06, 0.6) * 255;
      return [k * 0.99, k, k * 1.02];
    });
  },
  /**
   * 航拍地面：一个循环 = 400 m × 400 m 的城市肌理（街区 / 楼房顶 / 院树 / 厂房）。
   *
   * 为什么需要它：跟随相机的远景地面原来是一整片 #8b95a0 的沥青微差，
   * 从驾驶室看出去没问题（视线几乎平行地面，看到的都是烘焙出来的街面），
   * 但观景机位在 90~130 m 高空侧看地标时，画面下 2/3 全是这块"平原"，
   * 黄昏的橙色阳光一打，就成了一片沙漠——城市看起来根本不在地上。
   * 这块贴图让"走廊以外的世界"也有街区尺度，代价是一张 512² 的程序化图。
   */
  aerial: () => {
    const S = 512, NB = 8;                      // 一个循环 8×8 个街区
    const cell = S / NB;
    const n = tileFbm(S, 96, 911, 3), p = tileNoise(S, 320, 917);
    const dist = tileNoise(S, 3, 941);          // 城区级的大块明暗（老城/新区）
    const h2 = (a, b2, c2) => {
      let x = (a * 374761393 + b2 * 668265263 + c2 * 2147483647) >>> 0;
      x = (x ^ (x >> 13)) * 1274126177 >>> 0;
      return ((x ^ (x >> 16)) >>> 0) / 4294967295;
    };
    return paint(S, (i, j) => {
      /* 先把坐标轻轻扭一下再切街区。纯正交网格在 400 m 一循环的航拍图上
         就是 8×8 个一样大的方格，观景机位在 100 m 高空看出去满屏是"大富翁"
         棋盘（实测港区/外滩两张截图整个下半屏都是它）。真实路网的走向是
         慢慢弯的：扭 ±9 m 足以打破棋盘感，又不会把地块撕碎。
         扭曲量取自两张**可平铺**噪声，所以循环边界仍然接得上。 */
      const wi = i + (n(i, j) - 0.5) * 18, wj = j + (p(i, j) - 0.5) * 18;
      /* 街区号取模（用于哈希），但**格内比例必须从不取模的位置算** ——
         旧版 `fu = (wi − bi*cell)/cell` 里 bi 已经取过模，于是跨过贴图边界时
         wi 前进 512 而 bi 只前进 0，fu 整整差 8 —— 每块 400 m 的地面在接缝上
         错开 8 个街区（"扭曲打破棋盘"那一步引入的，肉眼是远处地面的一条带）。 */
      const biRaw = Math.floor(wi / cell), bjRaw = Math.floor(wj / cell);
      const bi = ((biRaw % NB) + NB) % NB, bj = ((bjRaw % NB) + NB) % NB;
      const fu = wi / cell - biRaw, fv = wj / cell - bjRaw;
      const kind = h2(bi, bj, 1);
      /* 街宽逐街区变化：等宽街道拼出来是棋盘，不像城市。
         0.08~0.24 的比例 = 4~12 m 的路，主支路混在一起才读得出层级。 */
      const road = 0.08 + h2(bi, bj, 5) * 0.16;
      if (fu < road || fv < road) {                       // 街道
        const g = 0.30 + (n(i, j) - 0.5) * 0.08 + (p(i, j) - 0.5) * 0.05;
        const k = clamp(g, 0.1, 1) * 255;
        return [k * 0.97, k, k * 1.06];
      }
      const su = (fu - road) / (1 - road), sv = (fv - road) / (1 - road);
      /* 地块内部：绿地 / 水面 / 大跨厂房 / 密排楼房 */
      if (kind < 0.10) {                                  // 公园、操场
        const g = 0.20 + (n(i, j) - 0.5) * 0.22 + (p(i, j) - 0.5) * 0.10;
        const k = clamp(g, 0.05, 1) * 255;
        return [k * 0.72, k * 1.02, k * 0.66];
      }
      if (kind < 0.15) {                                  // 河湾、蓄水池
        const g = 0.15 + (p(i, j) - 0.5) * 0.06;
        const k = clamp(g, 0.04, 1) * 255;
        return [k * 0.78, k * 0.92, k * 1.16];
      }
      // 横竖分别决定排几栋：让地块有长条、有方格、有整块大 footprint
      const nx = kind > 0.86 ? 1 : (1 + Math.floor(h2(bi, bj, 6) * 3.99));
      const ny = kind > 0.86 ? 1 : (1 + Math.floor(h2(bi, bj, 7) * 3.99));
      const pi = Math.min(nx - 1, Math.floor(su * nx)), pj = Math.min(ny - 1, Math.floor(sv * ny));
      const pu = su * nx - pi, pv = sv * ny - pj;
      const t = h2(bi * 4 + pi, bj * 4 + pj, 2);
      const gap = 0.10 + h2(bi, bj, 3) * 0.06;              // 栋与栋之间的缝
      const inB = pu > gap && pu < 1 - gap && pv > gap && pv < 1 - gap;
      let g;
      if (!inB) g = 0.26 + (p(i, j) - 0.5) * 0.07;           // 院内空地 / 消防通道
      else if (kind > 0.88) g = 0.52 + (p(i, j) - 0.5) * 0.05;  // 亮屋面（厂房采光带）
      else g = 0.34 + t * 0.30 + (n(i, j) - 0.5) * 0.10;      // 普通屋面
      // 屋檐阴影：每个栋体的东南侧压暗，读得出体积
      if (inB && (pu > 1 - gap * 1.6 || pv > 1 - gap * 1.6)) g *= 0.70;
      if (inB && (pu < gap * 1.5 || pv < gap * 1.5)) g *= 1.12;
      g *= 0.86 + dist(i, j) * 0.30;                       // 城区级明暗
      const k = clamp(g, 0.05, 1) * 255;
      return [k * 1.03, k, k * 0.95];
    });
  },
  /** 道砟：**一颗颗碎石**（周期性 Voronoi —— 每格一个抖动中心，取最近中心决定
   *  这颗石头的明度）。旧版是三张噪声叠出来的灰糊，"碎石"读不出来。
   *  距离用**环绕度量**，所以整张图仍然无缝平铺。 */
  ballast: () => {
    const S = 512, N = 24, cell = S / N;
    const r = rng(61);
    const jx = new Float32Array(N * N), jy = new Float32Array(N * N), jv = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) { jx[k] = r(); jy[k] = r(); jv[k] = r(); }
    const grain = tileNoise(S, 220, 67), dust = tileNoise(S, 30, 71);
    return paint(S, (i, j) => {
      const gx = i / cell, gy = j / cell, c0 = Math.floor(gx), r0 = Math.floor(gy);
      let best = 1e9, bv = 0.5;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r0 + dr, cc = c0 + dc;
        const wr = ((rr % N) + N) % N, wc = ((cc % N) + N) % N, w = wr * N + wc;
        let px = (cc + jx[w]) * cell - i, py = (rr + jy[w]) * cell - j;
        if (px > S / 2) px -= S; else if (px < -S / 2) px += S;      // 环绕度量 → 无缝
        if (py > S / 2) py -= S; else if (py < -S / 2) py += S;
        const d = px * px + py * py;
        if (d < best) { best = d; bv = jv[w]; }
      }
      const k = clamp(0.185 + bv * 0.42 + (grain(i, j) - 0.5) * 0.11 + (dust(i, j) - 0.5) * 0.06, 0.05, 0.80) * 255;
      return [k * 1.03, k, k * 0.93];
    });
  },
  noise: () => {
    const S = 256, n = tileFbm(S, 64, 77, 4);
    return paint(S, (i, j) => { const k = clamp(0.5 + (n(i, j) - 0.5) * 0.7, 0, 1) * 255; return [k, k, k]; });
  },
  /** 车体面漆：**橘皮纹（orange peel）+ 清漆的流动不均**。
   *  真实车漆在清漆层下有一层极细的橘皮（喷涂雾化留下的），它正是"这是漆、
   *  不是塑料"的来源；再叠一层更慢的清漆厚度差（抛光痕）。幅度必须小 ——
   *  大了就成"砂纸"。 */
  paint: () => {
    const S = 512, peel = tileNoise(S, 300, 83), flow = tileFbm(S, 7, 87, 3), spk = tileNoise(S, 1100, 89);
    return paint(S, (i, j) => {
      const k = 236 + (peel(i, j) - 0.5) * 9 + (flow(i, j) - 0.5) * 7 + (spk(i, j) - 0.5) * 4;
      return [k, k, k];
    });
  },

  /** 车窗玻璃：深色带天光反射与室内微亮（alpha 用于半透）。
   *  V 是车窗的**高度方向**（0 顶 1 底），所以天光反射自上而下衰减；
   *  U 上加两道斜向的掠射高光（真实车窗在站台灯下的样子）。 */
  window: () => {
    const S = 512, haze = tileNoise(S, 22, 91);
    return paint(S, (i, j, u, v) => {
      const sky = Math.pow(1 - v, 2.4) * 0.58;
      const inner = 0.055 + 0.045 * Math.sin(u * 22) * Math.sin(v * 9);
      const b = 0.055 + sky + Math.max(0, inner) + (haze(i, j) - 0.5) * 0.05;
      /* 掠射高光的谐波系数必须是**整数**（u、v 各走一个整周期），否则平铺裂缝。 */
      const streak = Math.pow(Math.max(0, Math.sin((u * 2 + v * 1) * Math.PI * 3)), 22) * 0.34;
      const streak2 = Math.pow(Math.max(0, Math.sin((u * 3 - v * 2) * Math.PI * 2)), 30) * 0.16;
      return [(b * 0.72 + streak + streak2) * 255, (b * 0.86 + streak + streak2) * 255,
        (b * 1.1 + streak * 1.2 + streak2) * 255, 255];
    });
  },

  /** 建筑立面窗格：三套变体，一个循环都是 12 m，只是开间与层高不同
   *  bldgWin  住宅塔楼 1.5 m × 3.0 m
   *  bldgWin2 写字楼   2.0 m × 4.0 m（大开间、整层亮灯多）
   *  bldgWin3 老式塔楼 1.0 m × 2.0 m（小窗密排）
   *  参数表见 FACADE_VARIANTS（测试 test-facade.js 直接读它）。
   */
  bldgWin: () => facadeTile(FACADE_VARIANTS.bldgWin.cols, FACADE_VARIANTS.bldgWin.rows,
    FACADE_VARIANTS.bldgWin.seed, FACADE_VARIANTS.bldgWin.opt),
  bldgWin2: () => facadeTile(FACADE_VARIANTS.bldgWin2.cols, FACADE_VARIANTS.bldgWin2.rows,
    FACADE_VARIANTS.bldgWin2.seed, FACADE_VARIANTS.bldgWin2.opt),
  bldgWin3: () => facadeTile(FACADE_VARIANTS.bldgWin3.cols, FACADE_VARIANTS.bldgWin3.rows,
    FACADE_VARIANTS.bldgWin3.seed, FACADE_VARIANTS.bldgWin3.opt),

  /** 道砟/水面波纹：给黄浦江用 */
  water: () => {
    const S = 256, a = tileNoise(S, 22, 111), b2 = tileNoise(S, 64, 113), c = tileNoise(S, 150, 117);
    return paint(S, (i, j) => {
      /* 波纹的载波频率取"整数个周期 / 一个贴图循环"（旧版 i*0.20 不是），
         否则平铺处波纹相位对不上、江面上一道竖缝。 */
      const ripples = Math.sin(i * (Math.PI * 2 * 16) / S + a(i, j) * 9) * 0.5 + 0.5;
      const k = 0.62 + ripples * 0.30 + (c(i, j) - 0.5) * 0.12 + (b2(i, j) - 0.5) * 0.18;
      const v = clamp(k, 0.3, 1.25) * 255;
      return [v * 0.86, v * 0.94, v];
    });
  },
  brick: () => {
    const S = 256, n = tileFbm(S, 90, 131, 3);
    return paint(S, (i, j) => {
      /* 砖行高必须整除贴图边长（256/16=16），否则平铺处砖行对不上、裂缝。 */
      const bw = 32, bh = 16, row = Math.floor(j / bh), off = (row % 2) * bw / 2;
      let b = 0.62 + (n(i, j) - 0.5) * 0.16;
      if ((i + off) % bw < 2 || j % bh < 2) b = 0.86;
      const k = clamp(b, 0.2, 1) * 255;
      return [k, k * 0.80, k * 0.68];
    });
  },
};

/**
 * 建筑立面窗格。
 *
 * 两条硬约束：
 *  1. mode 1 是"乘算细节"，所以整张图必须偏亮，否则乘完建筑就成纯黑。
 *     这里墙 ≈0.50、未点亮的窗 ≈0.18、亮窗 ≈1.0：楼体剪影靠顶点色压暗，
 *     窗靠顶点自发光点亮，层次才成立。
 *  2. **贴图的一个循环必须等于 FACADE_M 米的真实墙面**，而且要按"整层亮 /
 *     逐户亮"来分布灯。之前一个循环只有 3.2 m 却塞了 8×8 格窗，一格窗
 *     0.4 m；加上完全随机的点亮判定，近看整面楼就是电视雪花。
 *
 * @param cols   一个循环内的横向开间数（决定窗宽 = FACADE_M/cols 米）
 * @param rows   一个循环内的楼层数（决定层高 = FACADE_M/rows 米）
 * @param opt    {litRatio 逐户亮灯基准, floorMix 整层亮灯的楼层比例,
 *                warm 亮窗里暖光的比例, seed}
 */
function facadeTile(cols, rows, seed, opt) {
  opt = opt || {};
  /* 尺寸闸门：一格窗必须是人能看懂的窗，不是一像素噪点。
   * 这条断言是踩过坑加的——最早一个贴图循环只覆盖 3.2 m 却塞了 8×8 格，
   * 窗宽 0.4 m，近处整面楼就是雪花屏。 */
  const winW = FACADE_M / cols, winH = FACADE_M / rows;
  if (!(winW >= 0.9 && winW <= 2.6 && winH >= 2.0 && winH <= 4.6)) {
    throw new Error('立面窗格尺寸不合理: ' + cols + '×' + rows + ' → 窗宽 ' +
      winW.toFixed(2) + ' m / 层高 ' + winH.toFixed(2) +
      ' m（要求窗宽 0.9~2.6 m、层高 2.0~4.6 m，一个循环 = ' + FACADE_M + ' m）');
  }
  const litRatio = opt.litRatio == null ? 0.30 : opt.litRatio;
  const floorMix = opt.floorMix == null ? 0.34 : opt.floorMix;
  const warmMix = opt.warm == null ? 0.62 : opt.warm;
  const S = 512, n = tileNoise(S, 140, seed + 3), r = rng(seed);
  /* 行/列各自的属性。注意它们以 cols/rows 为周期，所以平铺处天然接缝无痕。 */
  const floorLit = [], floorTone = [], colTone = [], colBay = [];
  for (let j = 0; j < rows; j++) { floorLit.push(r() < floorMix); floorTone.push(0.80 + r() * 0.36); }
  for (let i = 0; i < cols; i++) { colTone.push(0.86 + r() * 0.26); colBay.push(0.92 + 0.14 * Math.abs(Math.sin((i + 1) * 1.7))); }
  const cell = [];
  for (let j = 0; j < rows; j++) { cell[j] = []; for (let i = 0; i < cols; i++) cell[j][i] = r(); }
  return paint(S, (i, j) => {
    const u = i / S * cols, v = j / S * rows;
    const ci = ((Math.floor(u) % cols) + cols) % cols, cj = ((Math.floor(v) % rows) + rows) % rows;
    const fu = u - Math.floor(u), fv = v - Math.floor(v);
    const frame = 0.17;
    const h = cell[cj][ci];
    let g, rgbMul;
    if (fu > frame && fu < 1 - frame && fv > frame * 0.72 && fv < 1 - frame * 0.72) {
      // 整层亮的楼层几乎全亮（只留一两户熄灯），其余楼层按 litRatio 逐户亮
      const lit = floorLit[cj] ? h < 0.94 : h < litRatio;
      // 玻璃：上半反射天空、下半映街面，未点亮的窗因此不是死黑方块
      const sky = Math.pow(1 - fv, 2.2);
      g = lit ? 0.95 + h * 0.05 : 0.13 + sky * 0.26;
      if (lit) {
        const warm = ((ci * 7 + cj * 13) % 100) / 100 < warmMix;
        rgbMul = warm ? [1.10, 0.97, 0.80] : [0.94, 0.99, 1.10];
      } else {
        rgbMul = [0.90, 0.97, 1.06];
      }
      if (Math.abs(fu - 0.5) < 0.020) g *= 0.60;           // 窗中梃
      if (Math.abs(fv - 0.54) < 0.014) g *= 0.80;          // 上下分格
      g *= colTone[ci] * floorTone[cj];
    } else {
      // 墙（结构柱 + 楼板带）：中灰、细粒、开间有明暗节奏、层间有暗线
      g = 0.50 + (n(i, j) - 0.5) * 0.11;
      if (fv < 0.055 || fv > 0.945) g *= 0.70;
      g *= colBay[ci];
      rgbMul = [0.97, 0.99, 1.03];
    }
    const b = clamp(g, 0, 1) * 255;
    return [b * rgbMul[0], b * rgbMul[1], b * rgbMul[2]];
  });
}

/* 立面贴图的真实尺度：一个循环 = 12 m × 12 m 墙面。
 * 所有使用 bldgWin* 材质的几何都必须按这个尺度给出 UV：
 *   box   → uv: FACADE_UV
 *   sweep → uvAlong: FACADE_UV
 *   ringStack / cylY → uvY: FACADE_UV（ringStack 的横向按周长自动换算）
 * 这个常量导出到 SH.FACADE_UV，改它等于同时改所有楼的窗格尺寸。 */
const FACADE_M = 12;
const FACADE_UV = 1 / FACADE_M;

/** 三套立面变体。窗宽 = FACADE_M/cols，层高 = FACADE_M/rows ——
 *  这两个数由 facadeTile 强制校验（0.9~2.6 m / 2.0~4.6 m），
 *  因为超出范围就是一面电视雪花，或者一面只有两格窗的塑料板。 */
const FACADE_VARIANTS = {
  bldgWin: { cols: 8, rows: 4, seed: 101, opt: { litRatio: 0.34, floorMix: 0.22, warm: 0.74 } },
  bldgWin2: { cols: 6, rows: 3, seed: 202, opt: { litRatio: 0.30, floorMix: 0.46, warm: 0.34 } },
  bldgWin3: { cols: 12, rows: 6, seed: 303, opt: { litRatio: 0.26, floorMix: 0.16, warm: 0.86 } },
};

/** 生成全部贴图并上传 */
function buildAll(renderer, list) {
  const names = list || Object.keys(BUILDERS);
  for (const n of names) {
    if (!BUILDERS[n]) continue;
    if (n === 'sign' || n === 'white') continue;
    const c = BUILDERS[n]();
    renderer.texFromCanvas(n, c, true);
    /* 法线贴图（`<名>N`）：同一张图的亮度当高度做浮雕。只有列进
       `NRM_STRENGTH` 的材质才生成 —— 一张 1024² 的法线图要 4 MB 显存，
       全生成等于把贴图显存翻一倍，而"天上那块纯色"之类的贴图也不需要浮雕。 */
    if (NRM_STRENGTH[n]) renderer.texFromCanvas(n + 'N', normalFromCanvas(c, NRM_STRENGTH[n]), true);
  }
  renderer.texFromCanvas('white', BUILDERS.white(), false);
}

/* ==================================================================== 标识图集
 * 世界烘焙时按需收集要画的牌子，最后一次性生成 2048² 图集。
 * 这样站名、导向、线路图、广告全是真实可读的中文——南京版完全没有。
 * ==========================================================================*/
class SignAtlas {
  constructor(size) {
    this.size = size || 2048;
    this.canvas = cv(this.size, this.size);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = 'rgba(0,0,0,0)';
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.x = 4; this.y = 4; this.rowH = 0;
    this.rects = new Map();
    this.pad = 3;
    /* 越界与新增都要能被外面看见：
       `add` 以前只按横向换行、`this.y` 一路往下长却从不检查是否出了画布，
       于是画到画布外面（什么都看不见），而 rect 照样返回一个 v>1 的坐标，
       采样时绕回图集顶部 —— **每一块站牌都显示别的东西**。
       现在越界直接记名并返回 fallback（近于空白），宁可"这块牌子是空的"，
       也不能"每个站的牌子都写着同一个站名"。 */
    this.overflowed = [];
    this.dirty = false;
  }
  /** 图集边长：按 GPU 上限取。全线站牌共用一张图集（烘焙时不得另起一张，
   *  否则 rect 坐标与真正上传的那张对不上），2048² 装不下 33 站长线路。 */
  static bestSize(gl) {
    const max = (gl && gl.getParameter && gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048;
    return Math.max(1024, Math.min(4096, max));
  }
  /**
   * 登记一块面板。draw(ctx,w,h) 在 (0,0,w,h) 区域内绘制。
   * @return rect [u0,v0,u1,v1]（纹理坐标）
   */
  add(key, w, h, draw) {
    if (this.rects.has(key)) return this.rects.get(key);
    w = Math.ceil(w); h = Math.ceil(h);
    const need = this.pad * 2;
    if (w + need > this.size || h + need > this.size) { this.overflowed.push(key); return this.fallback(); }
    if (this.x + w + need > this.size) { this.x = 4; this.y += this.rowH + need + 2; this.rowH = 0; }
    if (this.y + h + need > this.size) { this.overflowed.push(key); return this.fallback(); }
    const px = this.x + this.pad, py = this.y + this.pad;
    this.ctx.save();
    this.ctx.translate(px, py);
    this.ctx.beginPath(); this.ctx.rect(0, 0, w, h); this.ctx.clip();
    try { draw(this.ctx, w, h); } catch (e) { console.warn('sign draw failed', key, e); }
    this.ctx.restore();
    // 半像素内缩，避免平铺边缘采样到邻居
    const S = this.size;
    const r = [(px + 0.5) / S, (py + 0.5) / S, (px + w - 0.5) / S, (py + h - 0.5) / S];
    this.rects.set(key, r);
    this.x += w + this.pad * 2 + 2;
    this.rowH = Math.max(this.rowH, h);
    this.dirty = true;
    return r;
  }
  has(key) { return this.rects.has(key); }
  get(key) { return this.rects.get(key); }
  /** 兜底矩形（找不到时用） */
  fallback() { return [0, 0, 0.001, 0.001]; }
}

/* ------------------------------------------------- 具体牌子的画法（可复用） */
/** 站台吊挂站名标：线路色左条 + 中文站名 + 英文 + 编号 */
function signStationPlate(ctx, w, h, opt) {
  const { name, en, code, color, color2, next1, next2 } = opt;
  ctx.fillStyle = '#f3f7f9'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color; ctx.fillRect(0, 0, h * 0.42, h);
  if (color2) { ctx.fillStyle = color2; ctx.fillRect(h * 0.42, 0, h * 0.16, h); }
  ctx.fillStyle = '#0d1418';
  ctx.textBaseline = 'middle';
  ctx.font = '900 ' + Math.round(h * 0.46) + 'px ' + CN_FONT;
  ctx.fillText(name, h * 0.62, h * 0.40);
  ctx.fillStyle = '#4a5c66';
  ctx.font = '600 ' + Math.round(h * 0.17) + 'px ' + CN_FONT;
  ctx.fillText((en || '').toUpperCase(), h * 0.64, h * 0.72);
  if (code) {
    ctx.fillStyle = color; ctx.font = '900 ' + Math.round(h * 0.24) + 'px ' + CN_FONT;
    ctx.textAlign = 'right'; ctx.fillText(code, w - 10, h * 0.32); ctx.textAlign = 'left';
  }
}
/** 站台导向牌（出口 / 换乘） */
function signWayfind(ctx, w, h, opt) {
  ctx.fillStyle = '#12303f'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opt.color || '#00a0e9'; ctx.fillRect(0, 0, w, h * 0.16);
  ctx.fillStyle = '#eaf6fb'; ctx.textBaseline = 'middle';
  ctx.font = '800 ' + Math.round(h * 0.34) + 'px ' + CN_FONT;
  ctx.fillText(opt.text || '', 12, h * 0.56);
  if (opt.sub) { ctx.font = '600 ' + Math.round(h * 0.18) + 'px ' + CN_FONT; ctx.fillStyle = '#8fb6c6'; ctx.textAlign = 'right'; ctx.fillText(opt.sub, w - 12, h * 0.56); ctx.textAlign = 'left'; }
}
/** 线路色圆形站徽（屏蔽门楣 / 车头方向牌） */
function signLineBadge(ctx, w, h, opt) {
  const r = Math.min(w, h) / 2 - 2;
  ctx.fillStyle = opt.color; ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 ' + Math.round(h * 0.52) + 'px ' + CN_FONT;
  ctx.fillText(opt.text || '', w / 2, h / 2 + 1);
  ctx.textAlign = 'left';
}
/** 屏蔽门上的线路图（简化：一条线 + 站点刻度 + 当前站高亮） */
function signRouteMap(ctx, w, h, opt) {
  ctx.fillStyle = '#f7fafb'; ctx.fillRect(0, 0, w, h);
  const pad = h * 0.18, y = h * 0.52, n = opt.stations.length;
  ctx.strokeStyle = opt.color; ctx.lineWidth = Math.max(3, h * 0.05);
  ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  for (let i = 0; i < n; i++) {
    const x = pad + (w - pad * 2) * (n === 1 ? 0.5 : i / (n - 1));
    const cur = i === opt.index;
    ctx.fillStyle = cur ? '#ffcf3c' : '#fff';
    ctx.strokeStyle = cur ? '#c8202c' : '#5b7481'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, cur ? h * 0.10 : h * 0.055, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = '#12222c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 ' + Math.round(h * 0.19) + 'px ' + CN_FONT;
  ctx.fillText(opt.title || '', w / 2, h * 0.16);
  ctx.textAlign = 'left';
}
/** 车厢内广告位（上海地铁常见的灯箱广告） */
function signAd(ctx, w, h, seed) {
  const r = rng(seed);
  const hues = ['#0e5a8a', '#7a1f3d', '#1f6b4a', '#8a5a12', '#3a2b6b', '#0d6b6b'];
  const a = hues[Math.floor(r() * hues.length)], b = hues[Math.floor(r() * hues.length)];
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, a); g.addColorStop(1, b);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,' + (0.10 + r() * 0.12) + ')';
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(r() * w, r() * h, w * (0.1 + r() * 0.3), h * (0.1 + r() * 0.3), r() * 3, 0, 7); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '900 ' + Math.round(h * 0.20) + 'px ' + CN_FONT;
  const words = [' Shanghai 上海', '地铁城市生活', '进站 · 出站 · 遇见', '下一站 更好', '浦江两岸'];
  ctx.fillText(words[Math.floor(r() * words.length)], w * 0.08, h * 0.55);
}
/** 自助售票/充值机的屏面。上海的机器是"一屏到底"的触摸屏：上沿一条线路色，
 *  中间四个大按钮，下面一排投币口与二维码。远看只需要读出"这是一块发亮的屏"。 */
function signTvm(ctx, w, h, opt) {
  ctx.fillStyle = '#0d1b26'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opt.color || '#00a0e9'; ctx.fillRect(0, 0, w, h * 0.09);
  ctx.fillStyle = '#dceaf2'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.font = '800 ' + Math.round(h * 0.085) + 'px ' + CN_FONT;
  ctx.fillText('自助售票 · 充值', w / 2, h * 0.155);
  const cols = ['单程票', '交通卡', '充值', '二维码'];
  const bw = w * 0.40, bh = h * 0.145, gx = w * 0.045, gy = h * 0.235;
  for (let i = 0; i < 4; i++) {
    const x = gx + (i % 2) * (bw + gx * 0.4), y = gy + ((i / 2) | 0) * (bh + gy * 0.5);
    ctx.fillStyle = i === 0 ? (opt.color || '#00a0e9') : '#17303f';
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#eaf6fb'; ctx.font = '700 ' + Math.round(h * 0.062) + 'px ' + CN_FONT;
    ctx.fillText(cols[i], x + bw / 2, y + bh / 2);
  }
  ctx.fillStyle = '#243c4c'; ctx.fillRect(0, h * 0.80, w, h * 0.20);
  ctx.fillStyle = '#7fa6b6'; ctx.textAlign = 'left';
  ctx.font = '600 ' + Math.round(h * 0.05) + 'px ' + CN_FONT;
  ctx.fillText('现金 / 移动支付', w * 0.06, h * 0.875);
  ctx.textAlign = 'right'; ctx.fillStyle = '#c8dde8';
  ctx.fillText('找零零钱不收', w * 0.94, h * 0.875);
  ctx.textAlign = 'left';
}
/** 站台钟面。上海站台上两种都有：老站的圆盘模拟钟、新站的方形 LED 钟。
 * 这里画**方壳 + 里面的圆盘**（而不是"圆盘 + 透明四角"）——
 * `sign` 材质没开 blend，着色器虽然按 `tx.a` 算 alpha，帧缓冲却是不透明的，
 * 于是"画一个圆、其余留空"会得到一块**白色方板**。
 * 与其给 `sign` 开混合（那会让全站所有牌子改变绘制次序），不如把壳画进贴图。 */
function signClock(ctx, w, h, opt) {
  ctx.fillStyle = '#151f28'; ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - h * 0.05;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f7f8'; ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.06); ctx.strokeStyle = opt.color || '#1d2a33'; ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6 - Math.PI / 2, big = i % 3 === 0;
    const r0 = r * (big ? 0.72 : 0.82), r1 = r * 0.90;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineWidth = big ? r * 0.055 : r * 0.028; ctx.strokeStyle = '#22303a'; ctx.stroke();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#22303a';
  ctx.font = '800 ' + Math.round(r * 0.22) + 'px ' + CN_FONT;
  ctx.fillText('12', cx, cy - r * 0.55);
  ctx.fillText('6', cx, cy + r * 0.58);
  /* 指针：图定发车时刻附近的样子（10:09 那类"广告钟"读得最舒服） */
  const hand = (frac, len, wid) => {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(cx - Math.sin(a) * r * 0.10, cy + Math.cos(a) * r * 0.10);
    ctx.lineTo(cx + Math.sin(a) * r * len, cy - Math.cos(a) * r * len);
    ctx.lineWidth = wid; ctx.strokeStyle = '#16222a'; ctx.stroke();
  };
  hand(10 / 12 + 9 / 60 / 12, 0.50, r * 0.075);
  hand(9 / 60, 0.76, r * 0.045);
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.055, 0, Math.PI * 2); ctx.fillStyle = '#c8202c'; ctx.fill();
  ctx.textAlign = 'left';
}
/** 安全标识 / 警示 */
function signWarn(ctx, w, h, opt) {
  ctx.fillStyle = '#f5c518'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#141414';
  for (let x = -h; x < w; x += h * 0.9) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h * 0.45, h); ctx.lineTo(x + h * 0.45 + h, 0); ctx.lineTo(x + h, 0); ctx.fill(); }
  ctx.fillStyle = '#12222c'; ctx.fillRect(0, h * 0.30, w, h * 0.44);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.font = '800 ' + Math.round(h * 0.28) + 'px ' + CN_FONT;
  ctx.fillText(opt.text || '小心间隙', w / 2, h * 0.52);
  ctx.textAlign = 'left';
}
/** 车头方向牌（黑底白字，南京版没有做） */
function signDestination(ctx, w, h, opt) {
  ctx.fillStyle = '#0a0f13'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opt.color || '#fff';
  ctx.fillRect(0, 0, w * 0.10, h);
  ctx.fillStyle = '#f2f7fa'; ctx.textBaseline = 'middle';
  ctx.font = '900 ' + Math.round(h * 0.5) + 'px ' + CN_FONT;
  ctx.fillText(opt.text || '', w * 0.14, h * 0.5);
}

SH.FACADE_UV = FACADE_UV;
SH.FACADE_M = FACADE_M;
SH.FACADE_VARIANTS = FACADE_VARIANTS;
SH.textures = { buildAll, SignAtlas, tileNoise, tileFbm, paint, cv, CN_FONT, facadeTile, FACADE_UV, FACADE_M, FACADE_VARIANTS, BUILDERS,
  signStationPlate, signWayfind, signLineBadge, signRouteMap, signAd, signWarn, signDestination, signTvm, signClock,
  /* 诊断口（判据用）：最后一次 paint 的逐像素函数与边长 */
  lastPaint: () => ({ fn: lastPaintFn, size: lastPaintSize }) };

})(typeof window !== 'undefined' ? window : globalThis);
