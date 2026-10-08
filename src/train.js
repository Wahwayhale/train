/* ============================================================================
 * train.js — 车辆建模与沿曲线运行
 *
 * 关键点：
 *   1. 车体用"截面沿车长放样"生成，带鼓形腰（drum），不是南京版的光板长方体。
 *   2. 车头用多组截面放样成流线鼻部。
 *   3. 车门分成 A/B 两组网格（同一侧所有门页朝同一方向滑），运行时沿车体
 *      局部 z 平移——这样开关门只需要两次 draw，而不是每扇门一个批次。
 *   4. 每节车按它自己所在里程的 frame 定位，所以过弯时你会真的看到
 *      车厢之间的折角与转向架偏转。南京版的车在弯道上依然是笔直的。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { clamp, lerp, rgbOf, m4trs, m4basis, mat4, m3normalFromM4 } = SH;
const { Builder, Geo } = SH;
const { cross, norm3 } = Geo;

/* 上海 A 型车参考尺寸（米）。数据核实后会被 data/*.js 覆盖。 */
const DEFAULTS = {
  width: 3.00, floorY: 1.13, roofY: 3.80, headLen: 24.4, midLen: 22.0, gap: 0.35,
  doors: 5, doorPitch: 4.5, doorW: 1.40, doorH: 1.92,
  wheelR: 0.42, bogieCenters: 15.7, cars: 6, supply: 'oh',
  livery: '#E4002B', accent: '#ff6b7f', roof: '#8d959a', skirt: '#3d454a',
  band: '#c9ced1', window: '#0e171d', nose: '#e9edef',
};

/* ------------------------------------------------------------ 车体截面 */
function bodyProfile(p, at) {
  // at: 0=底 1=顶，用于放样时收缩
  const hw = p.width / 2 * (at == null ? 1 : at.w);
  const y0 = p.floorY * (at ? at.f : 1), y1 = p.roofY * (at ? at.r : 1);
  /* 磁浮的横断面是**抱梁的管形**：Transrapid 车体下部要向两侧伸出抱臂夹住轨道梁翼板，
     所以四角比地铁的方箱圆润得多（地铁 0.16/0.34，磁浮 0.52/0.74），
     整体接近"高 ≈ 宽"的圆角矩形。以前磁浮直接复用地铁断面，
     于是刚给它铺对了长定子轨道梁，车却是一列地铁盒子飘在梁上。 */
  return p.maglev
    ? Geo.roundedProfile(hw, y0, y1, 0.52, 0.74, 7, 0.022)
    : Geo.roundedProfile(hw, y0, y1, 0.16, 0.34, 4, 0.022);
}

/* ---------------------------------------------------------- 车窗带与客室
 * 车壳按窗带剖成上下两段（Geo.shellSplit），侧壁在窗位真正留空 ——
 * 这一步是"从站台能看见车厢里"的**前提**：原来侧壁是连续扫掠壳，
 * 车窗后面 8 mm 就是一块不透明的车体板，透过玻璃看进去第一眼撞的是它，
 * 于是整节车在站台上只是一条黑带，与真实"一眼看到座椅和吊环"差得最远。
 * 下面这组常数是窗带的唯一出处：玻璃、窗框、窗台压条、客室开口高度全部读它。
 */
/* 全部高度**相对地板面**（不是轨面）。数值取上海 A 型车客室：
 *   地板面 0 · 座面 0.43 · 靠背顶 0.98 · 窗台 0.95 · 窗楣 1.80
 *   横向扶手 1.83 · 窗带高 0.85 · 客室净高约 2.15
 * **这一组数第一版写错过一次，症状是"开了窗还是一条黑带"**：窗台原来取 0.62，
 * 而座面在 0.43 —— 窗位整个落在**座位下方**，从站台透过窗看到的只有客室地板与
 * 灯带，一条座椅也读不出来，于是"窗开了"与"窗没开"在画面上完全一样。
 * 这与"几何坏了先怀疑相机"是同一族的教训：**画面上读不出东西，先量那个东西的
 * 高度区间与自己是不是重叠**，而不是去调透明度。
 */
SH.CARWIN = {
  lo: 0.95,          // 窗台（相对地板面）
  hi: 1.80,          // 窗楣
  mid: 1.375,        // 窗带中心
  h: 0.85,           // 窗带高
  sill: 0.885,       // 窗台不锈钢压条中心
  head: 1.865,       // 窗楣内衬压条中心
  led: 1.99,         // 门上方车内走字屏中心
  ad: 1.99,          // 侧墙广告灯箱中心（与走字屏同高，两者沿车长错开）
  rail: 1.83,        // 横向扶手 / 立杆顶高度
  pole: 0.55,        // 立杆离侧壁距离
  seat: 0.43,        // 座面高
  seatD: 0.44,       // 座面进深
  back: 0.98,        // 靠背顶
  strap: 0.30,       // 吊环带长
};
const WIN = SH.CARWIN;

/** 本节车全部车门的**局部 z 中心**（车中心为原点，+z 向前）。
 *  车窗立柱、客室长条座分段、门区立杆三处都要按"门在哪"排布，
 *  各写一份就会有一处与车门错开半个门距 —— 站台上看就是"立杆顶在门缝里"。 */
function doorZs(p, L, kind) {
  const span = (p.doors - 1) * p.doorPitch;
  const c = kind === 'head' ? -noseOf(p).len / 2 : 0;   // 头车车门整体后移到鼻部之后
  const out = [];
  for (let k = 0; k < p.doors; k++) out.push(c - span / 2 + k * p.doorPitch);
  return out;
}

/**
 * 门叶**全开时的滑动量**（米）：一片叶要走完自己的宽度（doorW/2）才能把门洞
 * 整幅让开，再加 2 cm 余量。
 *
 * 原来这个数在 game.js 里写死 0.72 —— 对 1.4 m 的门（doorW/2 = 0.70）恰好够，
 * 对浦江线 1.6 m 的门（doorW/2 = 0.80）就差了 8 cm：开门之后门洞右沿仍压着
 * 一小条门页。单点定义在这里，两种门宽一起成立。
 */
const doorSlide = p => p.doorW / 2 + 0.02;

/** 侧窗模块宽（含立柱）与立柱宽：A/C 型车侧墙都是 ~1.35 m 一个窗模块。 */
const WIN_PITCH = 1.35, WIN_MULL = 0.075;

/** 本节车一侧的**逐扇**窗洞（返回 [中心 z, 净宽] 数组）。
 *
 * 以前这里是两份各写各的东西：一根 box 的玻璃带横铺 86% 车长，另有一份
 * 1.35 m 间距的立柱循环。玻璃带**横穿门洞** —— 门滑开之后，门洞里还挡着
 * 一扇关着的窗，"开门看见客室"这件事在门区被自己否掉了；而立柱落在哪
 * 也不决定玻璃从哪断开。现在窗洞与立柱出自同一份划分：门区整段让开
 * （按门宽 + 门框半宽裁掉，不是按中心距跳过，否则 1.275 m 的窗会啃进门 0.3 m）。 */
function windowBays(p, L, kind, noseLen) {
  const doors = doorZs(p, L, kind);
  const a = -L / 2 + (kind === 'head' ? 0.60 : 0.55);
  const b = kind === 'head' ? L / 2 - noseLen - 0.40 : L / 2 - 0.40;
  const keep = p.doorW / 2 + 0.09;                 // 门框外沿
  const out = [];
  for (let c = a + WIN_PITCH / 2; c < b; c += WIN_PITCH) {
    let z0 = c - WIN_PITCH / 2 + WIN_MULL / 2, z1 = c + WIN_PITCH / 2 - WIN_MULL / 2;
    for (const d of doors) {
      if (d - keep < z1 && d + keep > z0) {         // 与门区相交就裁，不相交不动
        if (c <= d) z1 = Math.min(z1, d - keep); else z0 = Math.max(z0, d + keep);
      }
    }
    z0 = Math.max(z0, a); z1 = Math.min(z1, b);
    if (z1 - z0 >= 0.35) out.push([(z0 + z1) / 2, z1 - z0]);
  }
  return out;
}

/** 立柱位置 = 相邻窗洞的公共边界（同一个划分推出来，不再另起一份间距）。 */
function mullionZs(bays) {
  const e = [];
  for (const [c, w] of bays) { e.push(c - w / 2, c + w / 2); }
  e.sort((x, y) => x - y);
  const out = [];
  for (const z of e) if (!out.length || z - out[out.length - 1] > 0.02) out.push(z);
  return out;
}

/** 贯通道（折棚风挡）+ 车钩：一节车的端头不是一个黑盒子，是三样东西 ——
 *  ① 车端刚框；② 能压缩的折棚（真实 6~8 褶，交替大小才读得出"这是可以皱的"）；
 *  ③ 车钩与风管（密接式车钩的钩头 + 两个带色帽的总风/制动软管）。
 *  原来这里只有一个 `box(p.width*0.72, 2.05, 0.30)` 的橡皮疙瘩：两车之间的
 *  `p.gap` 根本没被跨住（0.30 < 0.35），从站台斜看过去接头处是**敞开的黑洞**，
 *  而车钩在连挂状态下永远看不见。 */
function addGangway(b, p, zEnd, dir) {
  const W = p.width * 0.72, H = 2.05, cy = p.floorY + 1.30;
  const span = Math.max(0.16, p.gap - 0.04);        // 跨到邻车车端
  const z0 = zEnd + dir * 0.02, z1 = zEnd + dir * span;
  /* ① 车端刚框：门洞四周的框体（左右 + 顶 + 底门槛） */
  for (const s of [-1, 1]) b.box([s * W / 2, cy, zEnd + dir * span * 0.5], [0.10, H, span], rgbOf('#3a4247'), { mat: 'metal' });
  b.box([0, cy + H / 2 + 0.05, zEnd + dir * span * 0.5], [W + 0.20, 0.10, span], rgbOf('#3a4247'), { mat: 'metal' });
  b.box([0, cy - H / 2 - 0.04, zEnd + dir * span * 0.5], [W + 0.20, 0.08, span], rgbOf('#4a5257'), { mat: 'metal' });
  /* ② 折棚：交替大小的矩形环，褶数按跨距定（每 ~0.09 m 一褶） */
  const n = Math.max(3, Math.round(span / 0.09));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, zz = z0 + (z1 - z0) * t, k = (i % 2 ? 1.0 : 0.86);
    const pw = 0.035, d = dir * Math.abs(z1 - z0) / n * 0.5;
    for (const s of [-1, 1]) b.box([s * W * k / 2, cy, zz], [pw, H * (0.94 + 0.06 * k), Math.abs(d)], rgbOf('#1b2226'), { mat: 'rubber' });
    b.box([0, cy + H * k / 2, zz], [W * k, pw, Math.abs(d)], rgbOf('#1b2226'), { mat: 'rubber' });
    b.box([0, cy - H * k / 2, zz], [W * k, pw, Math.abs(d)], rgbOf('#1b2226'), { mat: 'rubber' });
  }
  /* ③ 车钩：钩尾框 + 钩头 + 风管（在折棚下方，轨面以上 0.72 m 是车钩中心线） */
  const yk = 0.72, cz = zEnd + dir * (span * 0.5 + 0.10);
  b.box([0, yk, zEnd + dir * 0.16], [0.34, 0.30, 0.32], rgbOf('#22282c'), { mat: 'metal' });
  b.cylZ([0, yk, cz], 0.115, 0.30, rgbOf('#2b3237'), { mat: 'steel', seg: 10 });
  b.box([0, yk + 0.02, zEnd + dir * (span + 0.16)], [0.26, 0.20, 0.14], rgbOf('#3b4348'), { mat: 'metal' });
  for (const s of [-1, 1]) {                        // 总风 / 制动软管：挂在钩头两侧
    b.cylZ([s * 0.26, yk - 0.26, cz], 0.030, 0.20, rgbOf('#20262a'), { mat: 'rubber', seg: 8 });
    b.cylZ([s * 0.26, yk - 0.26, zEnd + dir * (span + 0.10)], 0.045, 0.06,
      rgbOf(s < 0 ? '#c8b400' : '#8a8f94'), { mat: 'metal', seg: 8 });
  }
}

/** 磁浮抱臂与悬浮架：车体两侧下到轨道梁翼板下方，向内勾住。
 *  这是磁浮唯一"看得见为什么不用轮子"的结构，从追拍与站台外侧都能看到。 */
function addMaglevSkirt(b, p, z0, z1) {
  const len = z1 - z0, cz = (z0 + z1) / 2;
  for (const side of [-1, 1]) {
    /* 外侧立板：从车体下沿一直包到梁翼下方 */
    b.box([side * (p.width / 2 - 0.10), p.floorY - 0.42, cz], [0.16, 0.84, len], rgbOf('#c3cad0'), { mat: 'paint' });
    /* 向内勾的抱臂：顶到梁翼下沿（定子段外侧） */
    b.box([side * 1.30, -0.30, cz], [0.62, 0.16, len], rgbOf('#8f979d'), { mat: 'metal' });
    /* 导向/悬浮模块：贴在梁翼两侧上下成对，气隙按 10 mm 画成 8 cm 才看得见 */
    for (const dz of [-len * 0.3, len * 0.3]) {
      b.box([side * 1.62, 0.02, cz + dz], [0.30, 0.62, 1.30], rgbOf('#2b3238'), { mat: 'metal' });
    }
  }
  /* 梁上方的车底裙：磁浮没有"看得见转向架"这件事，车底是平的 */
  b.box([0, p.floorY - 0.10, cz], [p.width * 0.72, 0.20, len], rgbOf('#aeb6bc'), { mat: 'paint' });
}

/* --------------------------------------------------- 车体（外壳）的人工光
 *
 * 车体是 `buildMiddleCar` 直接产出的烘焙几何，**不进世界的光照网格** ——
 * 于是隧道环境光 0.085 直接打在浅灰色车皮上，画面里整列车是一条黑影，
 * 只有那条自带 `emi` 的线路色腰带读得出来。车迷第一眼看到的就是这个。
 *
 * 真实隧道里车体靠三样东西被照亮：站厅/站台灯的漫射、客室从门窗漏出来的光、
 * 以及隧道自身的顶部灯管。这里按同样的三样建一条回调：
 *   · 基础补光：从车窗高度往上更强（顶部灯管在车顶上方），
 *     裙板以下明显衰减（照不到地面以下）；
 *   · 窗带溢光：窗带附近额外一档暖白，正是"客室比隧道亮"这件事在车皮上的样子；
 *   · 下部压暗：裙板与走行部保持暗，读得出"这条黑白分界在真实高度"。
 * 走加算通道（`emi`），与项目"人工光不许乘进反照率"的铁律一致。
 */
function carShellLight(p) {
  const W = SH.CARWIN;
  return (x, y, z, nx, ny, nz) => {
    const h = y - p.floorY;                       // 相对地板面
    if (h < -1.2) return { b: 1, emi: 0.15, tint: [1, 1, 1] };
    /* 顶部灯管：越接近车顶越亮，裙板以下几乎不参与 */
    let k = 0.30 + 0.34 * Math.max(0, Math.min(1, (h + 0.6) / 2.6));
    /* 窗带溢光：客室的 300 lux 从 0.85 m 高的窗里漏出来，在车皮上是一条亮带。
       这一档是"隔着车窗看见车厢"这件事在**车外**留下的唯一痕迹。 */
    if (h > W.lo - 0.35 && h < W.hi + 0.35) k += 0.26 * (1 - Math.abs(h - W.mid) / (W.h / 2 + 0.35));
    /* 侧面比端面亮：站台灯与客室都在侧面 */
    const side = 0.85 + 0.15 * Math.abs(nx);
    k *= side * (0.9 + 0.1 * Math.abs(ny));
    return { b: 1, emi: k, tint: [1, 1.0, 1.02] };    // 略偏冷，与客室灯的暖白区分开
  };
}

/* ------------------------------------------------------------ 车头鼻型
 * 真实上海车辆的车头差别不在颜色，在三件事：鼻部悬伸多长、截面沿鼻长收缩得
 * 多快（钝圆还是尖锥）、前风挡是一整块面罩还是被中柱分成两块。
 * 以前这里只有一个写死的 `noseLen = 4.6` 与一组写死的指数，A 型车、C 型车、
 * 磁浮、胶轮 APM 共用同一张鼻面 —— 磁浮那截著名的长鼻锥和浦江线方头方脑的
 * 小 cab 在画面上是同一个东西。
 * 数取公开照片与技术图的目测比例：
 *   len      鼻部悬伸长度（鼻尖到车体直段起点）
 *   wExp/wAmt 半宽沿鼻长的收缩 `1 - t^wExp * wAmt`（t=1 是鼻尖）
 *   yExp/yAmt 高度方向的收缩；dropExp/dropAmt 鼻尖整体下沉
 *   screen   风挡：yFrom 起弧、中柱宽度（0 = 一整块）、玻璃自发光
 *   lights   前照灯：对数 n、横向位置 dx、高度 y、半径 r（磁浮是一条带所以 r 小 dx 大）
 */
const NOSE = {
  A: { len: 4.6, wExp: 2.6, wAmt: 0.16, yExp: 2.0, yAmt: 0.20, dropExp: 2.2, dropAmt: 0.30,
       screen: { yFrom: 2.42, pillar: 0.085, emi: 0.22, rake: 0.62 },
       lights: [{ n: 2, dx: 0.84, y: 1.75, r: 0.14 }, { n: 2, dx: 0.84, y: 1.43, r: 0.09 }] },
  /* C 型车（06C/07C/05C）：车体窄、鼻更钝，风挡同样带中柱但整体矮一截 */
  C: { len: 3.9, wExp: 3.0, wAmt: 0.12, yExp: 2.4, yAmt: 0.14, dropExp: 2.6, dropAmt: 0.22,
       screen: { yFrom: 2.28, pillar: 0.075, emi: 0.22, rake: 0.50 },
       lights: [{ n: 2, dx: 0.72, y: 1.62, r: 0.12 }, { n: 1, dx: 0.0, y: 1.34, r: 0.10 }] },
  /* 磁浮 Transrapid：长鼻锥（悬伸过半节司机室），两侧收得多、鼻尖下沉明显，
     风挡是一整块黑色面罩（无中柱），灯是一条横带 */
  MAG: { len: 5.8, wExp: 1.7, wAmt: 0.40, yExp: 1.6, yAmt: 0.34, dropExp: 1.9, dropAmt: 0.46,
       screen: { yFrom: 2.10, pillar: 0, emi: 0.16, rake: 1.35 },
       lights: [{ n: 2, dx: 1.05, y: 1.16, r: 0.10 }, { n: 2, dx: 1.05, y: 0.92, r: 0.07 }] },
  /* 浦江线胶轮 APM（Innovia APM 100）：几乎没有鼻子，方头方脑，一整块小风挡 */
  RUB: { len: 1.6, wExp: 3.4, wAmt: 0.07, yExp: 3.0, yAmt: 0.08, dropExp: 3.0, dropAmt: 0.10,
       screen: { yFrom: 2.34, pillar: 0, emi: 0.20, rake: 0.24 },
       lights: [{ n: 2, dx: 0.58, y: 1.30, r: 0.08 }] },
};
const noseOf = p => NOSE[p.noseShape] || NOSE.A;

/* ------------------------------------------------------------ 中间车 */
function buildMiddleCar(p, opt) {
  opt = opt || {};
  const L = p.midLen;
  /* 门叶按滑动方向（A组 -z、B组 +z）与车身侧向（L组 side<0、R组 side>0）分成4组Builder，
     以支持单侧开门（仅站台侧门页滑开，非站台侧保持静止闭合）。 */
  const body = new Builder(), glass = new Builder();
  const doorsAL = new Builder(), doorsBL = new Builder();
  const doorsAR = new Builder(), doorsBR = new Builder();
  body.light(carShellLight(p));
  const straight = (z) => ({ p: [0, 0, z], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: z });
  const path = [];
  for (let i = 0; i <= 8; i++) path.push(straight(-L / 2 + L * i / 8));
  const prof = bodyProfile(p);

  /* 主车体：**按窗带剖成两段**。lower 是窗台以下的侧壁 + 车底，upper 是窗楣以上
     的侧壁 + 车顶；两条多段线在窗带端点共用同一坐标，于是除窗带外处处封闭。 */
  const sh = Geo.shellSplit(p.width / 2, p.floorY * 0, p.roofY,
    p.maglev ? 0.52 : 0.16, p.maglev ? 0.74 : 0.34, p.maglev ? 7 : 4, 0.022,
    p.floorY + WIN.lo, p.floorY + WIN.hi);
  body.sweep(path, sh.lower, { mat: 'body', color: rgbOf(p.band), closed: false, uvAlong: 1 / 2.2, vSpan: 1 / 3 });
  body.sweep(path, sh.upper, { mat: 'body', color: rgbOf(p.band), closed: false, uvAlong: 1 / 2.2, vSpan: 1 / 3 });
  // 车顶（圆弧盖）
  const roofR = p.width / 2 * 0.92;
  const rpath = [];
  for (let i = 0; i <= 6; i++) rpath.push({ p: [0, p.roofY - 0.06, -L / 2 + L * i / 6], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: i });
  body.sweep(rpath, Geo.circleProfile(roofR, 12).filter(q => q.y > -0.02).map(q => ({ x: q.x, y: q.y * 0.55 + 0.02, nx: q.nx, ny: q.ny })),
    { mat: 'metal', color: rgbOf(p.roof), closed: false, uvAlong: 1 / 2, vSpan: 1 });
  // 裙板 + 线路色腰带：用 box 而不是 sweep —— 这两处是竖直薄板，
  // 用扫掠要把"车长方向"塞进 path、"高度"塞进截面 x，极易把基向量搞混，
  // 搞错了就会在车外飘出一条斜杠。
  const bays = windowBays(p, L, 'mid');
  /* ---- 1 号线：**实拍贴图侧板**（用户给的 BVE 模型，assets/l1train）----
     模型的 `SetTextureCoordinates` 给出的是一张线性映射：u=(z+22.4)/22.4 沿车长、
     v=(3.37−y)/2.55 沿高度（v 从图像**上方**算：v=0 在车顶沿、v=1 在裙板上沿）。
     这里把它重参数化到本车自己的 z∈[−L/2, L/2]：u=(z+L/2)/L。
     窗带（floorY+0.95 ~ floorY+1.80）**照样留空** —— 照片上画的门窗被切掉，
     由几何自己的窗洞/门叶承担，所以门与窗的位置必须与照片对齐（见 A8L1 车档）。
     贴图放在比裙板/腰线带更外 4 mm 处，免得与那两条程序化色带 z-fighting。 */
  const PH = p.photo === 'l1';
  const phV = y => (3.37 - y) / 2.55;
  const phU = z => (z + L / 2) / L;
  const photoBand = (side, y0, y1, len) => {
    body.plate([side * (p.width / 2 + 0.010), (y0 + y1) / 2, 0], [0, 0, len], [0, -(y1 - y0), 0], [side, 0, 0],
      rgbOf('#ffffff'), { mat: 'l1Side', uv: 1 / len, uvV: 1 / 2.55, uv0: [phU(-len / 2), phV(y1)] });
  };
  for (const side of [-1, 1]) {
    const x = side * (p.width / 2 + 0.006);
    body.box([x, p.floorY - 0.22, 0], [0.014, 0.44, L * 0.90], rgbOf(p.skirt), { mat: 'paint', faces: side > 0 ? [0] : [1] });
    body.box([x, p.floorY + 0.17, 0], [0.016, 0.30, L * 0.95], rgbOf(p.livery), { mat: 'paint', faces: side > 0 ? [0] : [1], emi: 0.20 });
    /* 侧墙涂装带：原来是一整块 2.26 m 高的板，正好把窗带也盖住 ——
       玻璃挂在外侧 8 mm 处所以"看上去有窗"，但玻璃后面仍然没有客室。
       现在按窗带剖成上下两条，窗位整段留空。 */
    /* 侧墙涂装带：按窗带剖成上下两条。上面一条要一直铺到车顶圆角起点，
       所以它的上边界不写成常数，取车壳剖分给出的 `sh.yB`（竖直侧壁的顶端）。
       写死 2.26 会在磁浮（圆角 0.74）上留下一段没上漆的白壳。 */
    const belowH = WIN.lo, aboveHi = sh.yB - p.floorY;
    if (PH) {
      /* 实拍侧板：从模型侧板的下沿 0.82 到车顶沿 3.37，按窗带剖成上下两条。
         照片的侧板本来就是"窗台以下 + 窗楣以上"两块，中间那一条是门窗，
         被几何自己的窗洞与门叶接管。 */
      photoBand(side, 0.82, p.floorY + WIN.lo, L * 0.995);
      photoBand(side, p.floorY + WIN.hi, 3.37, L * 0.995);
    } else {
      body.box([x, p.floorY + belowH / 2, 0], [0.012, belowH, L * 0.93], rgbOf(p.band), { mat: 'body', faces: side > 0 ? [0] : [1] });
      body.box([x, p.floorY + WIN.hi + (aboveHi - WIN.hi) / 2, 0], [0.012, aboveHi - WIN.hi, L * 0.93],
        rgbOf(p.band), { mat: 'body', faces: side > 0 ? [0] : [1] });
    }
    // 窗台压条 + 窗楣内衬：让开口读得出是一扇窗，而不是一条缝
    body.box([side * (p.width / 2 + 0.030), p.floorY + WIN.sill, 0], [0.052, 0.085, L * 0.955],
      rgbOf('#9aa4aa'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    body.box([side * (p.width / 2 + 0.030), p.floorY + WIN.head, 0], [0.048, 0.095, L * 0.955],
      rgbOf('#8b959b'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    // 立柱：由窗洞划分推出来的公共边界（见 windowBays）
    for (const dz of mullionZs(bays)) {
      body.box([side * (p.width / 2 + 0.026), p.floorY + WIN.mid, dz], [0.040, WIN.h + 0.16, WIN_MULL],
        rgbOf('#8f999f'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    }
  }
  // 侧窗：**逐扇**玻璃（每扇一个 box，门洞处不留玻璃）
  for (const side of [-1, 1]) {
    for (const [cz, w] of bays) {
      glass.box([side * (p.width / 2 + 0.014), p.floorY + WIN.mid, cz], [0.010, WIN.h, w], rgbOf(p.window),
        { mat: 'window', faces: side > 0 ? [0] : [1], emi: 0.30 });
    }
  }
  // 车门：A 组向 -z 滑，B 组向 +z 滑
  const span = (p.doors - 1) * p.doorPitch;
  for (let k = 0; k < p.doors; k++) {
    const dz = -span / 2 + k * p.doorPitch;
    for (const side of [-1, 1]) {
      const half = p.doorW / 2;
      for (const dir of [-1, 1]) {
        /* dir<0 = 门洞左半幅（叶 A，向 −z 滑开）；dir>0 = 右半幅（叶 B，向 +z）。
           按 side 分左右（side < 0 为左侧，side > 0 为右侧），实现单侧开门。 */
        const bb = side < 0 ? (dir < 0 ? doorsAL : doorsBL) : (dir < 0 ? doorsAR : doorsBR);
        const z0 = dz + dir * half / 2;
        const x = side * (p.width / 2 + 0.016);
        if (PH) {
          /* 门叶也走实拍贴图：叶在自己的 z 位置上取照片里对应的那一小段。
             叶会滑动，贴图跟着叶走 —— 真实列车的门叶本来就是"带着自己那块漆"滑的。 */
          const dl = half * 0.98;
          bb.plate([x, p.floorY + p.doorH / 2, z0], [0, 0, dl], [0, -p.doorH, 0], [side, 0, 0], rgbOf('#ffffff'),
            { mat: 'l1Side', uv: 1 / dl, uvV: 1 / 2.55, uv0: [phU(z0 - dl / 2), phV(p.floorY + p.doorH)] });
        } else {
          bb.plate([x, p.floorY + p.doorH / 2, z0], [0, 0, half * 0.98], [0, p.doorH, 0], [side, 0, 0], rgbOf(p.band),
            { mat: 'body', uv: 1 });
        }
        // 车门玻璃
        bb.plate([x + side * 0.006, p.floorY + 1.28, z0], [0, 0, half * 0.86], [0, 0.74, 0], [side, 0, 0], rgbOf(p.window),
          { mat: 'window', uv: 1 / 1.2 });
        // 门页下缘色带
        bb.plate([x + side * 0.006, p.floorY + 0.16, z0], [0, 0, half * 0.94], [0, 0.22, 0], [side, 0, 0], rgbOf(p.livery),
          { mat: 'paint', uv: 1, emi: 0.14 });
        // 门缝橡皮
        bb.plate([x + side * 0.008, p.floorY + p.doorH / 2, dz + dir * half], [0, 0, 0.03], [0, p.doorH, 0], [side, 0, 0], rgbOf('#1a1f23'),
          { mat: 'rubber', uv: 1 });
      }
      /* 门框：**必须是框，不能是一整块板**。
         车壳现在在窗带高度留空，如果门框还是一整块不透明的暗板，
         开门以后看到的仍是墙 —— 站台上"门开着却看不见车厢"就是这么来的。
         改成两根竖框 + 一道顶框，门洞整段留空。 */
      const jx = side * (p.width / 2 + 0.020);
      for (const e of [-1, 1]) {
        body.plate([jx, p.floorY + p.doorH / 2, dz + e * (p.doorW / 2 + 0.055)], [0, 0, 0.055], [0, p.doorH + 0.12, 0], [side, 0, 0],
          rgbOf('#232a2f'), { mat: 'paint', uv: 1 });
      }
      body.plate([jx, p.floorY + p.doorH + 0.055, dz], [0, 0, p.doorW + 0.11], [0, 0.06, 0], [side, 0, 0],
        rgbOf('#232a2f'), { mat: 'paint', uv: 1 });
      // 门区踢脚（门洞下沿一道金属门槛，兼作客室与车体的交界）
      body.box([side * (p.width / 2 - 0.05), p.floorY + 0.012, dz], [0.10, 0.024, p.doorW], rgbOf('#6f787e'), { mat: 'metal' });
    }
  }
  // 走行部：地铁是两台转向架；磁浮没有轮子，是沿梁布置的悬浮/导向架；
  // 浦江线是胶轮 —— 承重胎压在两条行车道上、水平导向轮夹住中央导向轨。
  const bc = p.bogieCenters / 2;
  if (p.maglev) addMaglevSkirt(body, p, -L * 0.36, L * 0.36);
  else for (const bz of [-bc, bc]) {
    if (p.rubber) addRubberBogie(body, p, bz); else addBogie(body, p, bz);
  }
  // 车顶设备：空调机组是"有形状的机器"（斜肩舱体 + 冷凝格栅 + 端部风帽），
  // 以前是三块平板盒 —— 站台/观景机位从上往下看全是光板。 Pantograph 错开。
  for (const dz of [-L * 0.26, L * 0.02, L * 0.28]) addRoofAC(body, p, L, dz, p.supply === 'oh' ? [] : [-L * 0.02]);
  // 车底设备箱：两台转向架之间挂牵引箱/制动电阻/蓄电池 ——
  // 以前车底是空的，从站台低头和弯道外侧看一眼就假。
  if (!p.maglev && !p.rubber) addUnderframeEquipment(body, p, L);
  if (p.supply === 'oh') for (const bz of [-bc, bc]) addPantograph(body, p, bz + (bz < 0 ? -1 : 1) * 0.0);
  // 贯通道 + 车钩（朝 -z 端；+z 端由前一节车负责，避免同一接头画两遍）
  addGangway(body, p, -L / 2, -1);
  const mAL = doorsAL.finish(), mBL = doorsBL.finish();
  const mAR = doorsAR.finish(), mBR = doorsBR.finish();
  return {
    body: body.finish(),
    doorsA: mAL.concat(mAR),
    doorsB: mBL.concat(mBR),
    doorsAL: mAL, doorsBL: mBL,
    doorsAR: mAR, doorsBR: mBR,
    glass: glass.finish(),
  };
}

function addBogie(b, p, z) {
  const y = 0.42;
  b.box([0, y + 0.30, z], [p.width * 0.72, 0.34, 2.70], rgbOf('#2c3439'), { mat: 'metal' });
  b.box([0, y + 0.62, z], [p.width * 0.50, 0.20, 1.50], rgbOf('#39424a'), { mat: 'metal' });
  /* 轮子轴向是**横向**（局部 x）。以前这里用 `cylZ` —— Builder 只有 cylY/cylZ，
     于是轮轴沿行车方向，圆面朝着车头车尾：从站台/街面看过去只剩一条 0.14 m 的
     竖线，等于没有轮子。压扁的球（x 半径 = 胎宽一半）在任何朝向下都是个圆盘。 */
  for (const az of [-0.62, 0.62]) for (const sx of [-1, 1]) {
    const wx = sx * p.width * 0.40;
    b.sphere([wx, y + 0.06, z + az], [0.07, p.wheelR, p.wheelR], { mat: 'steel', color: rgbOf('#161a1d'), segU: 14, segV: 10 });
    b.sphere([wx, y + 0.06, z + az], [0.10, p.wheelR * 0.62, p.wheelR * 0.62], { mat: 'steel', color: rgbOf('#4a5257'), segU: 12, segV: 8 });
  }
  b.box([0, y + 0.06, z], [p.width * 0.80, 0.12, 0.16], rgbOf('#202629'), { mat: 'metal' });
}

/**
 * 胶轮 APM 转向架（浦江线）。与 `WorldBuilder.apmLane()` 的断面**必须同源**：
 *   行车道顶面 y=0、中心横向 ±0.95、宽 0.70  ⇒ 承重胎压在那两条带上；
 *   导向轨在 ±0.32、顶面 +0.12            ⇒ 水平导向轮从外侧夹着它跑（±0.42）；
 * 胎面半径 0.35（`wheelR` 就是这个数），所以轴心在 y = 0.35。
 * 导向轮贴地（y≈0.02）才能碰到导向轨的下半段。
 */
function addRubberBogie(b, p, z) {
  const A = SH.APM, y = A.tyreR;
  b.box([0, y + 0.40, z], [p.width * 0.66, 0.30, 2.30], rgbOf('#2c3439'), { mat: 'metal' });
  b.box([0, y + 0.68, z], [p.width * 0.46, 0.18, 1.20], rgbOf('#39424a'), { mat: 'metal' });
  for (const az of [-0.66, 0.66]) for (const sx of [-1, 1]) {
    b.sphere([sx * A.laneLat, y, z + az], [A.tyreW / 2, y, y], { mat: 'paint', color: rgbOf('#101315'), segU: 12, segV: 9 });
    b.sphere([sx * A.laneLat, y, z + az], [A.tyreW / 2 + 0.02, y * 0.42, y * 0.42], { mat: 'steel', color: rgbOf('#5b646b'), segU: 10, segV: 7 });
  }
  for (const az of [-0.34, 0.34]) for (const sx of [-1, 1]) {
    b.sphere([sx * A.rollerLat, (A.chanFloor + A.guideTop) / 2, z + az], [0.075, 0.12, 0.12],
      { mat: 'paint', color: rgbOf('#171b1e'), segU: 10, segV: 6 });
  }
  b.box([0, y + 0.16, z], [2 * A.laneLat, 0.10, 0.14], rgbOf('#202629'), { mat: 'metal' });
}

/* ------------------------------------------------------- 客室内部（看得见的部分）
 * 这是"从站台一眼看出这是上海地铁"的那一层。车壳开了窗洞之后，
 * 窗后面必须真的有东西 —— 空的窗洞只是另一种穿帮。
 *
 * 按真车客室配置（上海 A 型车 4 门 / C 型车 3 门通用）：
 *   纵向长条座（门与门之间，坐垫 0.43 m、靠背 0.98 m，每 0.45 m 一道分隔棱）
 *   门边立杆 + 车中立杆（φ44 不锈钢，管身从地板到扶手高度）
 *   两侧横杆 + 吊环带（每 0.58 m 一个吊环，站台上最认得出的剪影）
 *   侧墙广告灯箱（窗楣以上一条连续灯箱，自发光 —— 从窗外斜看是最亮的一层）
 *   门上方车内走字屏（下一站 + 终点站，玩家在站台能读出来）
 *   顶棚灯带（客室自己的光源，见 carLightFn）
 *   内衬板：车壳是**单面**壳，从内侧看会被背面剔除 → 必须补内衬，
 *     否则透过车窗看到的是"直接穿出车外"的世界，而不是车厢
 *
 * 三角形预算：约 1200 个/节（6 节 ≈ 7.2 k），27 列车同时可见也在预算内。
 */
/* 客室净高（地板面以上，米）。真实 A 型车约 2.15。
 * 灯位、顶棚灯带、内衬顶棚三处共用这一个数 —— 原来"照明的位置"与
 * "看得见的灯具"各有各的高度，于是从窗外看进去顶部是黑的、座位区却亮着，
 * 整节车的亮度分布与真实客室正好相反。写在一处，判据也只查这一处。 */
const carCeilY = 2.16;
SH.carCeilY = carCeilY;

function carLightFn(p) {
  const HN = p.headLen / 2, nose = 4.6;
  /* 客室灯是**成对灯槽**（每侧一条），不是一条中线灯 —— 真车客室顶部是两条
     纵向灯带，站台上看进去的"两道亮线"正是它。中线一条会让顶棚显得像地铁博物馆。 */
/* 强度定标：隧道环境光只有 0.085，而真实客室照度在 300~500 lux ——
     车厢从站台上必须是**比隧道亮得多的一块**，玩家隔着玻璃一眼看见座椅与吊环，
     这件事全靠这个对比。原值 0.72/2.60 让客室顶点平均自发光只有 0.20，
     加上隧道 emiBoost 之后落在 0.3 上下，与站厅照明一个量级，于是"有客室"
     与"没客室"在画面上分不开。现在把强度抬到 1.45、衰减半径放到 3.4
     （覆盖整个客室宽度），并保留 0.30 的背面保底。 */
  const LAMPS = [
    { c: [-(p.width / 2 - 0.55), p.floorY + carCeilY - 0.06, 0], s: 1.45, r: 3.40 },
    { c: [(p.width / 2 - 0.55), p.floorY + carCeilY - 0.06, 0], s: 1.45, r: 3.40 },
  ];
  void HN; void nose;
  return (x, y, z, nx, ny, nz) => {
    let b0 = 0, b1 = 0, b2 = 0;
    for (const L of LAMPS) {
      const dx = L.c[0] - x, dy = L.c[1] - y, dz = L.c[2] - z;
      const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) || 1e-3;
      /* 背面保底 0.30：客室墙面互相反射，纯 cos 衰减会让座位底下与端墙死黑，
         而真实客室没有一处是真黑的（灯带是漫射光）。 */
      const cos = Math.max(0.30, (dx * nx + dy * ny + dz * nz) / d);
      const e = L.s * cos / (1 + d2 / (L.r * L.r));
      b0 += e; b1 += e * 1.01; b2 += e * 1.05;                       // 客室灯偏中性略暖
    }
    const m = Math.max(b0, b1, b2);
    if (!(m > 0)) return { b: 1, emi: 0, tint: [1, 1, 1] };
    const inv = 1 / (1 + m);
    return { b: 1, emi: m, tint: [(1 + b0) * inv, (1 + b1) * inv, (1 + b2) * inv] };
  };
}

/** 一节车的客室几何布局。客室与**车内乘客**都要用它 ——
 *  门区位置、座段分段、内衬面这三样一旦各写一份，人就会坐在门缝上、
 *  或者站在座椅里面，而画面上只是"有个人卡在奇怪的地方"。 */
function carLayout(p, kind) {
  const L = kind === 'head' ? p.headLen : p.midLen;
  const HN = L / 2, nose = 4.6;
  /* 客室可用长度：头车要扣掉司机室（鼻尖后 4.9 m 起是隔墙），中间车到端墙。 */
  const zA = -HN + 0.10, zB = kind === 'head' ? (HN - nose - 0.75) : (HN - 0.10);
  const hw = p.width / 2, innerX = hw - 0.055;
  const dzs = doorZs(p, L, kind);
  const zone = dzs.map(d => [d - p.doorW / 2 - 0.10, d + p.doorW / 2 + 0.10]);
  /* 纵向长条座的分段：由"门区之间"决定，而不是从头铺到尾 ——
     座椅与门错开半米正是真实客室的排法。 */
  const seats = [];
  {
    let cur = zA + 0.55;
    for (const z of zone) { if (z[0] > cur) seats.push([cur, z[0]]); cur = Math.max(cur, z[1]); }
    if (zB - 0.55 > cur) seats.push([cur, zB - 0.55]);
  }
  return { L, HN, nose, zA, zB, hw, innerX, dzs, zone, seats, ceilY: carCeilY };
}

/** 一节车的客室。kind: 'mid' | 'head'（头车客室在司机室隔墙之后）。
 *  @param destRect 车头目的地屏在图集里的格子（门上方走字屏的静态底：开往终点站） */
function buildCarInterior(p, opt, kind, destRect) {
  opt = opt || {};
  const b = new Builder();
  b.light(carLightFn(p));            // 客室自己的人工光（车内乘客另有一次，见 buildCarPax）
  const G = carLayout(p, kind);
  const { zA, zB, hw, innerX, dzs, zone, seats, ceilY } = G;
  const y = v => p.floorY + v;                       // 相对地板面
  const p2 = G; void p2;

  /* ---- 地板 ---- */
  b.plate([0, y(0.004), (zA + zB) / 2], [innerX, 0, 0], [0, 0, (zB - zA) / 2], [0, 1, 0],
    rgbOf('#4a5157'), { mat: 'paint', uv: 1 });
  /* 中央防滑走道条（比地板浅一档，站台斜看进去先读到这条） */
  b.plate([0, y(0.009), (zA + zB) / 2], [innerX * 0.46, 0, 0], [0, 0, (zB - zA) / 2], [0, 1, 0],
    rgbOf('#5c646a'), { mat: 'paint', uv: 1 });

  /* ---- 内衬板（窗带以下 / 窗楣以上 / 顶棚 / 端墙）----
     车壳法向朝外，从车内看是背面 → 背面剔除会让整节车"透光"。
     内衬补上这一层，同时它就是客室的墙面配色。 */
  /* 客室净高：真实 A 型车约 2.15 m，而本项目的车顶在轨面上 3.80、地板 1.13，
     差 2.67 m —— 那是**结构**高度（要装空调与风道），内衬顶棚要落下来一截，
     否则 2.5 m 净高的车厢从窗外看进去会显得像仓库。与 carLightFn 共用同一个数。 */
  for (const side of [-1, 1]) {
    const nrm = [-side, 0, 0];
    /* 窗台以下的裙板：这是从车窗**斜下方**能看见的那一面，所以它不能没有 —— */
    b.plate([side * innerX, y(WIN.lo / 2), (zA + zB) / 2], [0, 0, (zB - zA) / 2], [0, WIN.lo / 2, 0], nrm,
      rgbOf('#c8ced2'), { mat: 'paint', uv: 1 });
    /* 窗楣到顶棚的侧墙：广告灯箱挂在这里 */
    b.plate([side * innerX, y((WIN.hi + ceilY) / 2), (zA + zB) / 2],
      [0, 0, (zB - zA) / 2], [0, (ceilY - WIN.hi) / 2, 0], nrm,
      rgbOf('#d6dbe0'), { mat: 'paint', uv: 1 });
    /* 侧墙广告灯箱：窗楣以上一条连续灯箱，自发光。
       从站台斜看进车窗，最先读到的是这一层亮度 —— 真实车厢也是这样。 */
    const adTop = Math.min(ceilY - 0.10, WIN.ad + 0.13), adBot = Math.max(WIN.hi + 0.02, WIN.ad - 0.13);
    const adY = (adTop + adBot) / 2, adH = adTop - adBot;
    if (adH > 0.02) {
      for (let dz = zA + 0.9; dz < zB - 0.9; dz += 2.35) {
        if (zone.some(z => dz > z[0] - 0.5 && dz < z[1] + 0.5)) continue;
        const len = Math.min(2.05, zB - 0.9 - dz);
        b.plate([side * (innerX - 0.012), y(adY), dz], [0, 0, len / 2], [0, adH / 2, 0], nrm,
          rgbOf('#e6e2d6'), { mat: 'emissive', emi: 0.60 });
        b.plate([side * (innerX - 0.020), y(adY), dz], [0, 0, len / 2 + 0.04], [0, adH / 2 + 0.04, 0], nrm,
          rgbOf('#8e969c'), { mat: 'metal' });
      }
    }
  }
  b.plate([0, y(ceilY), (zA + zB) / 2], [innerX, 0, 0], [0, 0, (zB - zA) / 2], [0, -1, 0],
    rgbOf('#dfe4e8'), { mat: 'paint', uv: 1 });
  /* 顶棚灯带：两条纵向自发光条（与 carLightFn 的两个灯位同源）。
     灯带必须在**窗楣以上**才看得见（窗带高度 0.95~1.80，灯带在 2.16），
     而从站台是**斜着往上看**进车窗的 —— 所以它是"客室亮不亮"的第一眼线索。 */
  for (const side of [-1, 1]) {
    b.plate([side * (hw - 0.55), y(ceilY - 0.012), (zA + zB) / 2], [0.11, 0, 0], [0, 0, (zB - zA) / 2 - 0.15], [0, -1, 0],
      rgbOf('#f2f7fb'), { mat: 'emissive', emi: 1.9 });
  }
  for (const e of [zA, zB]) {
    b.plate([0, y(ceilY / 2), e], [innerX, 0, 0], [0, ceilY / 2, 0], [0, 0, e === zA ? 1 : -1],
      rgbOf('#c2c8cd'), { mat: 'paint', uv: 1 });
  }

  /* ---- 纵向长条座 ----
     分段由 `carLayout` 给出（与车内乘客同一份），这里只负责摆出来。 */
  for (const side of [-1, 1]) {
    for (const [a, c] of seats) {
      if (c - a < 0.35) continue;
      const mid = (a + c) / 2, len = c - a;
      const xIn = side * (innerX - WIN.seatD / 2 - 0.01);
      /* 座面 */
      b.box([xIn, y(WIN.seat - 0.03), mid], [WIN.seatD, 0.06, len], rgbOf('#3f6f9e'), { mat: 'paint' });
      /* 座下裙板（真实是封闭的成型座，侧面有一道深色） */
      b.box([side * (innerX - 0.02), y(WIN.seat / 2 - 0.02), mid], [0.05, WIN.seat - 0.04, len], rgbOf('#5b636a'), { mat: 'paint' });
      /* 靠背 */
      b.box([side * (innerX - 0.055), y((WIN.seat + WIN.back) / 2), mid], [0.075, WIN.back - WIN.seat, len],
        rgbOf('#3f6f9e'), { mat: 'paint' });
      /* 分隔棱：每 0.46 m 一道，站台上看过去就是"一排小方块" */
      for (let dz = a + 0.23; dz < c - 0.15; dz += 0.46)
        b.box([xIn, y(WIN.seat + 0.005), dz], [WIN.seatD * 0.92, 0.05, 0.035], rgbOf('#4a7dae'), { mat: 'paint' });
    }
  }

  /* ---- 立杆 ---- */
  const poleX = side => side * (innerX - WIN.pole - 0.02);
  for (const dz of dzs) {
    for (const e of [-1, 1]) {
      for (const side of [-1, 1])
        b.cylY([poleX(side), y(WIN.rail / 2), dz + e * (p.doorW / 2 + 0.16)], 0.022, WIN.rail, rgbOf('#b6bec4'), { mat: 'metal', seg: 6 });
    }
  }
  for (const side of [-1, 1]) for (const dz of [-0.9, 0.9])
    b.cylY([poleX(side), y(WIN.rail / 2), dz], 0.022, WIN.rail, rgbOf('#b6bec4'), { mat: 'metal', seg: 6 });
  /* ---- 两侧横杆 + 吊环 ---- */
  for (const side of [-1, 1]) {
    b.cylZ([poleX(side), y(WIN.rail), (zA + zB) / 2], 0.020, zB - zA - 0.2, rgbOf('#c2cad0'), { mat: 'metal', seg: 6 });
    for (let dz = zA + 0.55; dz < zB - 0.4; dz += 0.58) {
      if (zone.some(z => dz > z[0] && dz < z[1])) continue;
      b.cylZ([poleX(side), y(WIN.rail - WIN.strap / 2), dz], 0.006, WIN.strap, rgbOf('#9aa3aa'), { mat: 'metal', seg: 4 });
      b.box([poleX(side), y(WIN.rail - WIN.strap - 0.055), dz], [0.030, 0.085, 0.055], rgbOf('#e2e8ec'),
        { mat: 'paint', faces: [0, 1, 4, 5] });
    }
  }

  /* ---- 门上方车内走字屏 ----
     静态底（开往终点站）走站牌图集，玩家那一份的"下一站"由 game.js 的
     实时纹理 'led' 覆盖 —— 两个格子分开，避免每帧重传 4096² 图集。 */
  if (destRect) {
    for (const dz of dzs) for (const e of [-1, 1]) {
      const s = e > 0 ? 1 : -1;
      const cz = dz + e * (p.doorW / 2 + 0.34);
      for (const side of [-1, 1]) {
        b.panel([side * (innerX - 0.03), y(WIN.led), cz], [0, 0, 0.34], [0, 0.105, 0], [-side, 0, 0],
          destRect, [1, 1, 1], 0.55, 'led');
      }
      void s;
    }
  }
  /* 紧急报警器 + 灭火器（门区侧墙），小件但读得出是客室 */
  for (const dz of dzs) for (const side of [-1, 1]) {
    b.box([side * (innerX - 0.045), y(1.42), dz + p.doorW / 2 + 0.42], [0.055, 0.20, 0.10],
      rgbOf('#c8352c'), { mat: 'paint' });
  }
  return b.finish();
}

/* ------------------------------------------------------------ 车内乘客
 * 车窗开成真的洞之后，客室里没有人的时候那扇窗就是一块**空亮的盒子**：
 * 有座椅有灯带，但没有人。真实上海一节 A 型车早高峰站着的人比坐着的多，
 * 而这件事是"挤不上车"那条规则的画面兑现 —— HUD 上写着 118%，
 * 站台上看过去却是一节空车，两件事对不上。
 *
 * 做法：**三档增量批次**。level k 的批次只装"第 k 档新增的人"，
 * 绘制时按车载画 level 1..k，于是三批总共只建 58 个人（而不是 58×3）。
 * 人是两块盒子（身体 + 头）= 12 个三角形，一节车合计约 700 个三角形。
 *
 * 档位次序也是有讲究的：先坐下、再站起来（真实车厢就是这样，
 * 有座先坐、坐满了人才站），所以 L1 全是坐的、L2 才开始有站的、
 * L3 座位坐满、通道里站满 —— 而 L3 仍然只有 32 个人，
 * 真实超员车厢一节能站 150 人（那是取舍，见诚实清单）。 */
const PAX_HUES = ['#2f3a52', '#3b2f2a', '#4a3f52', '#26404a', '#523a30', '#2c4a3a', '#5a4a2a', '#33383f'];
const PAX_SKIN = ['#c9a184', '#b08563', '#d8b89b', '#9c7150', '#e0c4a8'];

/** 一档车内乘客。level 1/2/3，返回已 finish 的网格数组。 */
function buildCarPax(p, kind, level) {
  if (!(level >= 1)) return [];
  const b = new Builder();
  b.light(carLightFn(p));            // 乘客要与客室同一套光，否则窗里是"黑底上的人"
  const G = carLayout(p, kind);
  const { zA, zB, innerX, zone, seats } = G;
  const y = v => p.floorY + v;
  /* 确定性随机：同一节车、同一档永远是同一批人（回归可复现，
     而"车厢里的人每次进站都换一身"在画面上是明显的抖动）。 */
  let seed = (kind === 'head' ? 811 : 197) * 131 + level * 7717;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 8388608; };
  const pick = a => a[Math.min(a.length - 1, (rnd() * a.length) | 0)];

  /* 一个"人"：躯干 + 头。坐着的从座面起，站着从地板起。 */
  const person = (x, z, baseY, h, yaw) => {
    const sh = pick(PAX_SKIN), cl = pick(PAX_HUES);
    const bodyH = h - 0.26, bw = 0.34 + 0.06 * rnd();
    b.box([x, y(baseY + bodyH / 2), z], [bw, bodyH, 0.24], rgbOf(cl), { mat: 'paint', yaw });
    b.box([x, y(baseY + bodyH + 0.13), z], [0.185, 0.26, 0.20], rgbOf(sh), { mat: 'paint', yaw });
  };

  /* ---- 坐着的：排在座段上，一个座 0.50 m ----
     L1/L2 只填一部分座段，L3 填满 —— 真实车厢里前几节先满、后几节还空着，
     这个"从头往后填"的次序本身就是上海的样子。 */
  const slots = [];
  for (const side of [-1, 1]) for (const [a, c] of seats) {
    for (let z = a + 0.28; z < c - 0.22; z += 0.50)
      slots.push({ x: side * (innerX - WIN.seatD / 2 - 0.01), z, baseY: WIN.seat + 0.02, h: 0.78, yaw: side > 0 ? 0 : Math.PI });
  }
  const seated = { 1: 8, 2: 12, 3: slots.length }[level] || 0;
  for (let i = 0; i < Math.min(seated, slots.length); i++) {
    const s0 = slots[(i * 3 + level) % slots.length];
    person(s0.x, s0.z, s0.baseY, s0.h, s0.yaw);
  }
  /* ---- 站着的：门区以外均匀铺开、左右交替 ----
     `u` 必须取**尝试次数**而不是已放人数：取"已放人数"的话，被门区跳过的
     那些尝试算出来的 z 完全一样，循环卡死在一个位置上 —— 实测 L3 只站下
     7 个人（而目标是 18）。这类"用输出当输入"的循环在画面上表现为
     "超员车厢里通道是空的"，而代码看起来完全正常。 */
  const standing = { 1: 0, 2: 6, 3: 18 }[level] || 0;
  let placed = 0, tries = 0;
  while (placed < standing && tries++ < standing * 8) {
    const u = (tries - 0.5) / (standing * 1.6);
    const z = zA + 0.7 + u * (zB - zA - 1.4);
    if (zone.some(q => z > q[0] - 0.30 && z < q[1] + 0.30)) continue;
    const side = (placed % 2) ? 1 : -1;
    const x = side * (0.40 + 0.30 * rnd());
    if (Math.abs(x) > innerX - 0.34) continue;
    person(x, z + (rnd() - 0.5) * 0.16, 0.01, 1.66 + 0.10 * rnd(), (rnd() - 0.5) * 0.7);
    placed++;
  }
  /* 靠门把手的一对"扶手人"：站在门区**外沿**、立杆旁边，前臂抬到横杆高度。
     站在门区里面是错的 —— 门叶是沿 z 滑开的，人站在那里会被门切过去。
     这是从站台斜看进车窗最能读出"车里有人"的一组剪影。 */
  if (level >= 3) {
    for (const dz of [G.dzs[0], G.dzs[G.dzs.length - 1]]) {
      if (dz == null) continue;
      for (const side of [-1, 1]) {
        const x = side * (innerX - 0.48);
        const zz = dz + side * (p.doorW / 2 + 0.10 + 0.30);
        person(x, zz, 0.01, 1.68, side > 0 ? 0.15 : -0.15);
        b.box([x - side * 0.14, y(1.44), zz], [0.30, 0.09, 0.12], rgbOf(pick(PAX_HUES)), { mat: 'paint' });
      }
    }
  }
  return b.finish();
}

/** 满载率 → 车内乘客档位。**门槛来自"一节车 310 人定员、只画 32 个人"**：
   画满 32 个人时车其实才 10% 满，但"空车"与"站着人的车"一眼就能分出来，
   而 30% 与 40% 的差别看不出来。所以门槛刻意偏前。 */
function paxLevel(fill) {
  const f = fill == null ? 0 : fill;
  return f <= 0.06 ? 0 : f < 0.40 ? 1 : f < 0.85 ? 2 : 3;
}

/* 逐节车厢档位的确定性偏置（C5）：真实列车各节车厢从不同时是同一档 ——
   通勤方向的头部车厢先满、尾车还空着。偏置数组均值为 0（±0.025），
   所以各节档位的均值仍落在整车档位上（判据钉 ±0.5）；轮转量取 seed，
   同一线路的不同列车错开分布。 */
const CAR_PAX_OFF = [-0.4, 0.2, 0.5, -0.2];
/** 满载率 → 每节车厢各自的乘客档位。@param seed 列车自身的错开量（缺省 0） */
function paxLevels(fill, cars, seed) {
  const base = paxLevel(fill), n = Math.max(1, cars | 0 || 1), rot = ((seed | 0) % 4 + 4) % 4;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.max(0, Math.min(3, Math.round(base + CAR_PAX_OFF[(i + rot) % 4]))));
  return out;
}

/* ------------------------------------------------------------ 车门提示灯（B3）
 * 每个门洞上方一小条琥珀色灯（真实上海列车门区灯的位置），单独成批：
 * 开门常亮、关门随蜂鸣节奏闪（SH.DOOR_BEEP 一格一亮一灭）、关门后熄灭。
 * 站台机位看一列靠站的车，这条琥珀光是"这班车正在上下客"的第一证据。 */
function buildCarDoorLamps(p, kind) {
  const bL = new Builder(), bR = new Builder();
  bL.light(carLightFn(p));
  bR.light(carLightFn(p));
  const L = kind === 'head' ? p.headLen : p.midLen;
  const innerX = p.width / 2 - 0.055;
  for (const dz of doorZs(p, L, kind)) {
    for (const side of [-1, 1]) {
      const b = side < 0 ? bL : bR;
      /* 灯面朝车厢内侧：从开门的门洞与对面站台斜看都能读到 */
      b.plate([side * (innerX - 0.035), p.floorY + p.doorH + 0.26, dz],
        [0, 0, 0.19], [0, 0.030, 0], [-side, 0, 0], rgbOf('#4a3208'), { mat: 'light', emi: 1 });
      /* 灯罩外圈一道深色框：亮着的时候读得出是灯具而不是一块亮斑 */
      b.plate([side * (innerX - 0.030), p.floorY + p.doorH + 0.26, dz],
        [0, 0, 0.215], [0, 0.042, 0], [-side, 0, 0], rgbOf('#20272c'), { mat: 'metal' });
    }
  }
  const mL = bL.finish(), mR = bR.finish();
  const all = mL.concat(mR);
  all.L = mL;
  all.R = mR;
  return all;
}

/* ---- 车顶空调机组 ----
   真实 A 型车是车顶中部的薄型机组：安装座垫出车顶弧面、舱体两侧带斜肩、
   侧面是冷凝格栅（一条 recessed 暗带 + 五片散热肋）、端部一顶风帽。
   以前是三块平板盒，站台/观景机位从上往下看全是光板。
   supply='oh' 的线受电弓占了转向架上方，unitAts 传空位避开。 */
function addRoofAC(b, p, L, z, skip) {
  const w = p.width * 0.58, h = 0.34, len = Math.min(L * 0.20, 4.6);
  const y0 = p.roofY - 0.02, w2 = w / 2;
  if ((skip || []).some(s => Math.abs(s - z) < 2.0)) return;
  /* 安装座：比舱体略窄略长的垫条，把机组从车顶圆弧上"架"起来 */
  b.box([0, y0 + 0.02, z], [w * 0.92, 0.06, len + 0.5], rgbOf('#6a7278'), { mat: 'metal' });
  /* 舱体：两侧斜肩 + 平顶，closed sweep */
  const prof = [
    { x: -w2, y: 0, nx: -1, ny: 0 },
    { x: -w2 + 0.12, y: h * 0.78, nx: -0.55, ny: 0.84 },
    { x: -w2 + 0.30, y: h, nx: 0, ny: 1 },
    { x: w2 - 0.30, y: h, nx: 0, ny: 1 },
    { x: w2 - 0.12, y: h * 0.78, nx: 0.55, ny: 0.84 },
    { x: w2, y: 0, nx: 1, ny: 0 },
  ];
  const path = [];
  for (let i = 0; i <= 2; i++) path.push({ p: [0, y0 + 0.05, z - len / 2 + len * i / 2], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: i });
  b.sweep(path, prof, { mat: 'metal', color: rgbOf('#9aa2a8'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
  /* 端板（sweep 不封端）+ 冷凝格栅 + 端部风帽 */
  for (const e of [-1, 1])
    b.plate([0, y0 + 0.05 + h * 0.5, z + e * (len / 2)], [w2 - 0.05, 0, 0], [0, h * 0.62, 0], [0, 0, e],
      rgbOf('#878f95'), { mat: 'metal' });
  for (const side of [-1, 1]) {
    b.box([side * (w2 - 0.045), y0 + 0.05 + h * 0.40, z], [0.012, h * 0.52, len * 0.80], rgbOf('#252c31'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    for (let i = -2; i <= 2; i++)
      b.box([side * (w2 + 0.008), y0 + 0.05 + h * 0.40, z + i * len * 0.155], [0.014, h * 0.54, 0.055], rgbOf('#5f686e'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
  }
  b.box([0, y0 + 0.05 + h * 0.52, z + len / 2 + 0.11], [w * 0.44, h * 0.44, 0.20], rgbOf('#7d868c'), { mat: 'metal' });
}

/* ---- 车底设备箱 ----
   两台转向架之间的车底以前是空的。真实 A 型车底挂着：牵引逆变器（大箱）、
   制动电阻（中箱带百叶）、蓄电池（小箱）。全部避开转向架（|z| < bc − 2.1）
   与车钩/排障器区。 */
function addUnderframeEquipment(b, p, L, zc) {
  zc = zc || 0;                       // 头车的可用区段以转向架中心 carC 为中心，不在 0
  const bc = p.bogieCenters / 2, y = 0.58, lim = bc - 2.1;
  const boxes = [
    { z: zc - lim * 0.55, w: 1.9, h: 0.50, l: Math.min(2.6, lim), c: '#39424a' },   // 牵引箱
    { z: zc + lim * 0.45, w: 1.35, h: 0.42, l: Math.min(1.9, lim), c: '#333b41' },   // 制动电阻
    { z: zc + lim * 0.88, w: 0.85, h: 0.36, l: Math.min(1.2, lim * 0.6), c: '#2f363b' }, // 蓄电池
  ];
  for (const bx of boxes) {
    b.box([0, y - bx.h / 2, bx.z], [bx.w, bx.h, bx.l], rgbOf(bx.c), { mat: 'metal' });
    /* 吊架：两只薄吊耳把箱子挂到底架 */
    for (const e of [-1, 1])
      b.box([0, y + 0.06, bx.z + e * bx.l * 0.36], [bx.w * 0.5, 0.14, 0.08], rgbOf('#232a2f'), { mat: 'metal' });
  }
  /* 制动电阻百叶：中箱侧面五条横向肋 */
  for (const side of [-1, 1]) for (let i = -2; i <= 2; i++)
    b.box([side * 0.685, y - 0.10, boxes[1].z + i * 0.30], [0.012, 0.20, 0.05], rgbOf('#1d2327'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
}

/* ---- 头车顶设备：天线（刀形 + GPS 球顶）---- */
function addRoofAntenna(b, p, L) {
  const y0 = p.roofY - 0.02;
  b.box([p.width * 0.30, y0 + 0.26, -L * 0.28], [0.045, 0.42, 0.30], rgbOf('#2c3439'), { mat: 'metal' });
  b.sphere([p.width * 0.30, y0 + 0.10, -L * 0.20], [0.15, 0.09, 0.15], { mat: 'metal', color: rgbOf('#c8cfd3'), segU: 10, segV: 6 });
}

function addPantograph(b, p, z) {
  const y = p.roofY + 0.30;
  b.box([0, y, z], [1.20, 0.10, 2.40], rgbOf('#5f686e'), { mat: 'metal' });
  for (const s of [-1, 1]) {
    b.plate([s * 0.02, y + 0.55, z], [0.9, 1.10, 0], [0, 0, 0.06], [0, 0, s], rgbOf('#39424a'), { mat: 'metal' });
  }
  b.box([0, y + 1.05, z], [1.42, 0.05, 0.10], rgbOf('#202629'), { mat: 'steel' });
  b.box([0, y + 1.05, z - 0.55], [1.42, 0.05, 0.08], rgbOf('#202629'), { mat: 'steel' });
  b.box([0, y + 1.05, z + 0.55], [1.42, 0.05, 0.08], rgbOf('#202629'), { mat: 'steel' });
}

/* ------------------------------------------------------------ 头车 */
/**
 * 注意坐标约定：所有车辆网格都以**车中心**为原点，局部 z 范围 [-L/2, +L/2]，
 * +z 为行车方向。鼻部占前端 noseLen，所以鼻尖在 +L/2。
 */
function buildHeadCar(p, opt) {
  opt = opt || {};
  const L = p.headLen, HN = L / 2;
  /* 头车门叶按滑动方向与左右侧分成 4 组 Builder（与中间车同一套机制，支持单侧开门）。 */
  const body = new Builder(), glass = new Builder();
  const doorsAL = new Builder(), doorsBL = new Builder();
  const doorsAR = new Builder(), doorsBR = new Builder();
  body.light(carShellLight(p));
  const nose = noseOf(p), noseLen = nose.len;   // 前端流线段（按车型，见 NOSE）
  const front = HN;                          // 鼻尖所在的局部 z
  const prof = bodyProfile(p);
  // 主体（去掉鼻尖的部分）——同样按窗带剖开，尾端必须封顶
  const main = [];
  for (let i = 0; i <= 6; i++) main.push({ p: [0, 0, -HN + (L - noseLen) * i / 6], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: i });
  /* 尾端必须封顶：main 是从 -HN 开始的开放管，以前两头都不封，
     于是**从后面看最后一节车就是一个黑洞**（磁浮追尾机位实拍到的那块
     黑色矩形就是它）。车头方向不能封 —— 司机位在前鼻之后 1.7 m，
     封了等于自己给自己砌一堵墙，所以只封 capStart。 */
  const sh = Geo.shellSplit(p.width / 2, p.floorY * 0, p.roofY,
    p.maglev ? 0.52 : 0.16, p.maglev ? 0.74 : 0.34, p.maglev ? 7 : 4, 0.022,
    p.floorY + WIN.lo, p.floorY + WIN.hi);
  const sweepOpt = { mat: 'body', color: rgbOf(p.band), closed: false, uvAlong: 1 / 2.2, vSpan: 1 / 3 };
  body.sweep(main, sh.lower, sweepOpt);
  body.sweep(main, sh.upper, sweepOpt);
  // 尾端封顶（首端保持开放：司机的墙）
  {
    const e = 0.02;
    body.sweep([
      { p: [0, 0, -HN], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: 0 },
      { p: [0, 0, -HN + e], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: 1 },
    ], bodyProfile(p), { mat: 'body', color: rgbOf(p.skirt), closed: true,
      capStart: true, capEnd: true, capColor: rgbOf(p.skirt), uvAlong: 1 / 2.2, vSpan: 1 / 3 });
  }
  // 鼻尖：逐段收缩截面
  const N = 12;
  const path = [], profiles = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    path.push({ p: [0, 0, front - noseLen + noseLen * t], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: i });
    const wShrink = 1 - Math.pow(t, nose.wExp) * nose.wAmt;
    const yShrink = 1 - Math.pow(t, nose.yExp) * nose.yAmt;
    const drop = Math.pow(t, nose.dropExp) * nose.dropAmt;
    profiles.push(scaleProfile(prof, wShrink, 1 - drop, yShrink, t));
  }
  body.loft(path, profiles, { mat: 'body', color: rgbOf(p.nose), closed: true, capEnd: false });
  // 前脸只画"嘴"（挡风玻璃下方的深色带）。鼻端不封顶、上方留空，
  // 否则从司机位看出去会被自己车的鼻端挡成一堵墙。
  body.loft(
    [{ p: [0, 0, front - 0.34], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: 0 },
     { p: [0, 0, front - 0.02], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], s: 1 }],
    [maskProfile(p, 0.98), maskProfile(p, 1.0)],
    { mat: 'body', color: rgbOf('#12191f'), closed: false, capEnd: false });
  // 侧窗：逐扇玻璃（与中间车同一份划分，鼻部之前不留窗）
  const hBays = windowBays(p, L, 'head', noseLen);
  for (const side of [-1, 1]) {
    for (const [cz, w] of hBays) {
      glass.box([side * (p.width / 2 + 0.014), p.floorY + WIN.mid, cz], [0.010, WIN.h, w], rgbOf(p.window),
        { mat: 'window', faces: side > 0 ? [0] : [1], emi: 0.30 });
    }
  }
  // 裙板与腰线（延伸到鼻尖）
  for (const side of [-1, 1]) {
    const x = side * (p.width / 2 + 0.006);
    body.box([x, p.floorY - 0.22, -noseLen / 2], [0.014, 0.44, L - noseLen], rgbOf(p.skirt), { mat: 'paint', faces: side > 0 ? [0] : [1] });
    body.box([x, p.floorY + 0.17, -noseLen / 2], [0.016, 0.30, L - noseLen * 0.6], rgbOf(p.livery), { mat: 'paint', faces: side > 0 ? [0] : [1], emi: 0.20 });
    const belowH = WIN.lo, aboveHi = sh.yB - p.floorY;
    body.box([x, p.floorY + belowH / 2, -noseLen / 2], [0.012, belowH, L - noseLen], rgbOf(p.band), { mat: 'body', faces: side > 0 ? [0] : [1] });
    body.box([x, p.floorY + WIN.hi + (aboveHi - WIN.hi) / 2, -noseLen / 2], [0.012, aboveHi - WIN.hi, L - noseLen],
      rgbOf(p.band), { mat: 'body', faces: side > 0 ? [0] : [1] });
    body.box([side * (p.width / 2 + 0.030), p.floorY + WIN.sill, -noseLen / 2], [0.052, 0.085, L - noseLen],
      rgbOf('#9aa4aa'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    body.box([side * (p.width / 2 + 0.030), p.floorY + WIN.head, -noseLen / 2], [0.048, 0.095, L - noseLen],
      rgbOf('#8b959b'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    for (const dz of mullionZs(hBays)) {
      body.box([side * (p.width / 2 + 0.026), p.floorY + WIN.mid, dz], [0.040, WIN.h + 0.16, WIN_MULL],
        rgbOf('#8f999f'), { mat: 'metal', faces: side > 0 ? [0] : [1] });
    }
  }
  /* 前照灯 / 尾灯：灯位与灯径按鼻型排（磁浮是一条横带、APM 只有两盏小灯），
     以前是三盏固定的圆灯长在每型车的同一个位置。 */
  for (const g of nose.lights) for (const side of [-1, 1]) {
    for (let q = 0; q < g.n; q++) {
      const lx = side * (g.dx + (g.n > 1 ? q * g.r * 2.6 : 0)), lz = front - 0.34;
      body.cylZ([lx, g.y, lz], g.r, 0.16, rgbOf('#fff8e2'), { mat: 'light', seg: 12, emi: 2.4 });
    }
  }
  for (const side of [-1, 1]) {
    const lx = side * (nose.lights[0].dx * 1.25), lz = front - 0.36;
    body.cylZ([lx, nose.lights[0].y + 0.30, lz], 0.07, 0.12, rgbOf('#c8322b'), { mat: 'light', seg: 10, emi: 0.9 });
  }
  const dest = opt.sign && opt.sign.rect;
  if (dest) body.panel([0, p.roofY - 0.62, front - 0.24], [0.98, 0, 0], [0, 0.30, 0], [0, 0, 1], dest, [1, 1, 1], 1.1);
  // 车头排障器 + 车钩
  body.box([0, 0.30, front - 0.22], [p.width * 0.92, 0.42, 0.30], rgbOf('#2b3237'), { mat: 'paint' });
  body.box([0, 0.62, front + 0.10], [0.34, 0.30, 0.50], rgbOf('#1b2124'), { mat: 'metal' });
  // 车门与转向架（都在鼻部之后的直线段上）
  const carC = -noseLen / 2;
  for (const dz of doorZs(p, L, 'head')) {
    for (const side of [-1, 1]) {
      const half = p.doorW / 2, x = side * (p.width / 2 + 0.016);
      for (const dir of [-1, 1]) {
        /* dir<0 = 门洞左半幅（叶 A，向 −z 滑开）；dir>0 = 右半幅（叶 B，向 +z）。
           按 side 分左右（side < 0 为左侧，side > 0 为右侧），实现单侧开门。 */
        const bb = side < 0 ? (dir < 0 ? doorsAL : doorsBL) : (dir < 0 ? doorsAR : doorsBR);
        const z0 = dz + dir * half / 2;
        bb.plate([x, p.floorY + p.doorH / 2, z0], [0, 0, half * 0.98], [0, p.doorH, 0], [side, 0, 0], rgbOf(p.band), { mat: 'body', uv: 1 });
        bb.plate([x + side * 0.006, p.floorY + 1.28, z0], [0, 0, half * 0.86], [0, 0.74, 0], [side, 0, 0], rgbOf(p.window), { mat: 'window', uv: 1 / 1.2 });
        bb.plate([x + side * 0.006, p.floorY + 0.16, z0], [0, 0, half * 0.94], [0, 0.22, 0], [side, 0, 0], rgbOf(p.livery), { mat: 'paint', uv: 1, emi: 0.14 });
      }
      /* 门框同样是"框"：车壳开了窗洞，整块暗板会把客室重新挡死。 */
      const jx = side * (p.width / 2 + 0.020);
      for (const e of [-1, 1])
        body.plate([jx, p.floorY + p.doorH / 2, dz + e * (p.doorW / 2 + 0.055)], [0, 0, 0.055], [0, p.doorH + 0.12, 0], [side, 0, 0],
          rgbOf('#232a2f'), { mat: 'paint', uv: 1 });
      body.plate([jx, p.floorY + p.doorH + 0.055, dz], [0, 0, p.doorW + 0.11], [0, 0.06, 0], [side, 0, 0],
        rgbOf('#232a2f'), { mat: 'paint', uv: 1 });
      body.box([side * (p.width / 2 - 0.05), p.floorY + 0.012, dz], [0.10, 0.024, p.doorW], rgbOf('#6f787e'), { mat: 'metal' });
    }
  }
  const bc = p.bogieCenters / 2;
  if (p.maglev) addMaglevSkirt(body, p, carC - bc * 0.9, carC + bc * 0.9);
  else if (p.rubber) { addRubberBogie(body, p, carC - bc); addRubberBogie(body, p, carC + bc); }
  else { addBogie(body, p, carC - bc); addBogie(body, p, carC + bc); }
  if (p.supply === 'oh') addPantograph(body, p, carC + bc * 0.4);
  /* 头车顶设备：空调机组（避开受电弓）+ 刀形天线/GPS 球顶 ——
     以前头车车顶是空的，从站台/观景看头车光秃秃。 */
  addRoofAC(body, p, L, carC - L * 0.20, p.supply === 'oh' ? [carC + bc * 0.4] : []);
  addRoofAC(body, p, L, carC + L * 0.14, p.supply === 'oh' ? [carC + bc * 0.4] : []);
  if (!p.maglev && !p.rubber) addRoofAntenna(body, p, L);
  if (!p.maglev && !p.rubber) addUnderframeEquipment(body, p, L, carC);
  // 车尾贯通道 + 车钩
  addGangway(body, p, -HN, -1);
  const mAL = doorsAL.finish(), mBL = doorsBL.finish();
  const mAR = doorsAR.finish(), mBR = doorsBR.finish();
  return {
    body: body.finish(),
    doorsA: mAL.concat(mAR),
    doorsB: mBL.concat(mBR),
    doorsAL: mAL, doorsBL: mBL,
    doorsAR: mAR, doorsBR: mBR,
    glass: glass.finish(),
  };
}

/** 截面整体缩放/下沉，用于放样出车头 */
function scaleProfile(prof, w, topY, yScale, t) {
  /* `topY` 是"鼻尖顶高系数"（调用方传 1 − drop）。以前这个参数收进来却没人用，
     于是鼻型档案里的 dropAmt 完全不起作用 —— 判据量出来鼻尖顶高实测 3.04
     （= roofY × yScale），与声称的 2.74 差的正是那 0.30 的下沉。
     一个进了参数列表却没进公式的数，就是"档案在涨、几何一动不动"的又一种形态。 */
  const drop = 1 - topY;
  return prof.map(q => ({
    x: q.x * w,
    y: (q.y > 2.2 ? q.y * yScale : q.y - (1 - yScale) * 0.2) - drop,
    nx: q.nx, ny: q.ny,
  }));
}
/** 前脸下部的"嘴"——只覆盖挡风玻璃以下，避免挡住司机视线 */
function maskProfile(p, k) {
  const w = p.width / 2 * 0.86 * k;
  const y0 = p.floorY + 0.26, y1 = p.floorY + 0.86;
  const out = [], n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = Math.PI * (1 - t);
    out.push({ x: Math.cos(a) * w, y: (y0 + y1) / 2 + Math.sin(a) * (y1 - y0) / 2, nx: Math.cos(a), ny: Math.sin(a) * 0.4 });
  }
  return out;
}

/* ------------------------------------------------- 司机室自己的一套人工光 */
/**
 * 内饰（台面、侧墙、手柄、顶棚）是 `buildCabInterior` 直接产出的烘焙几何，
 * **不进世界的光照网格**，所以从来没有一盏灯算到它头上。地下段天光只有 0.085，
 * 于是玩家默认视角看到的是：仪表与 TCMS 因为自带自发光还读得清，
 * 其余（台面、侧墙、他正握着的那两只手柄）是一团剪影。
 *
 * 走**加算通道**：着色器是 `lit += base * vC.a * uEmiBoost`，隧道 `emiBoost` 2.05，
 * 所以 emi 0.6 落在深灰台面上是 0.11×0.6×2.05 ≈ 0.14 的加算量 —— 读得出来，
 * 而绝不会像"乘进反照率"那样被 0.085 的环境光再乘掉一次（项目铁律）。
 * 灯位与自发光板的位置一一对应：顶灯、地脚灯、仪表背光。
 */
function cabLightFn(p) {
  const HN = p.headLen / 2, front = HN;
  const LAMPS = [
    { c: [0, p.roofY - 0.16, front - 2.90], s: 0.95, r: 3.20 },      // 司机室顶灯
    { c: [0, p.floorY + 0.62, front - 3.30], s: 0.30, r: 2.00 },     // 地脚灯
    { c: [-0.02, p.floorY + 0.86, front - 1.62], s: 0.55, r: 1.45 }, // 仪表背光
  ];
  return (x, y, z, nx, ny, nz) => {
    let b0 = 0, b1 = 0, b2 = 0;
    for (const L of LAMPS) {
      const dx = L.c[0] - x, dy = L.c[1] - y, dz = L.c[2] - z;
      const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) || 1e-3;
      /* 背面给 0.35 的保底：真实驾驶室里有大量互反射，纯 cos 衰减会让
         台面下沿、侧墙内侧这些"背对着灯"的面彻底死黑。 */
      const cos = Math.max(0.35, (dx * nx + dy * ny + dz * nz) / d);
      const e = L.s * cos / (1 + d2 / (L.r * L.r));
      b0 += e; b1 += e * 0.98; b2 += e * 1.06;                        // 驾驶室灯偏冷
    }
    const m = Math.max(b0, b1, b2);
    if (!(m > 0)) return { b: 1, emi: 0, tint: [1, 1, 1] };
    const inv = 1 / (1 + m);
    return { b: 1, emi: m, tint: [(1 + b0) * inv, (1 + b1) * inv, (1 + b2) * inv] };
  };
}

/* ------------------------------------------------- 司机台指示灯（会亮会灭） */
/**
 * 指示灯是 cab 里最后一处纯静态摆件：以前五行写在 `buildCabInterior` 里，
 * `emi: i === 3 ? 0.12 : 1.5` —— 颜色与亮灭是**写死的数组**，第 4 盏永远灭、
 * 其余永远亮，与车门/牵引/制动/ATO 的真实状态无关。玩家盯得最久的一块面板
 * 于是在说"一切正常"，而它并没有在看任何东西。
 *
 * 每盏灯单独成批（一批 12 个三角形，代价可忽略），绘制时用
 * `r.draw(b, M, { emi: k })` 这条**已存在的按批次覆盖通道**给亮度，
 * 所以几何还是一次烘焙，动的只是 uniform。
 * 键名就是它反映的那个状态，判据按名字要数，不靠"第几盏"这种位置约定。
 */
/* 透镜的**基色是暗的**：真实指示灯不点亮时是一颗深色玻璃珠，点亮时才被后面
   的光源染上颜色。基色给满饱和的 #4dff9e 会让"灭"的灯与"亮"的灯只差一点亮度，
   整排读起来是五张彩色卡片而不是"哪几盏亮着"。
   下面的基色按"亮档乘出来正好顶到 ~0.95"反推：亮档总倍率
   = 顶点 emi(1.0+内饰光≈1.5) × light 材质 emiBoost 2.2 × LAMP_ON 1.5 ≈ 4.95，
   所以主通道给 0.19 上下。 */
const LAMPS = [
  { key: 'doors', color: '#302609', label: '车门' },
  { key: 'trac', color: '#0d3019', label: '牵引' },
  { key: 'brk', color: '#301f0d', label: '制动' },
  { key: 'ato', color: '#0d3019', label: 'ATO' },
  { key: 'eb', color: '#300a0a', label: '紧急' },
];
/* 亮与灭两档：灭档不是 0 —— 完全归零会让面板上出现"洞"，玩家看不出这里本来有个灯。 */
const LAMP_ON = 1.5, LAMP_OFF = 0.06;

/** 车门提示灯的亮度（B3 单点）。open=门开度 0..1，closing=是否在关门相位。
 *  开到位常亮；关门过程随蜂鸣节奏闪（SH.DOOR_BEEP 一格一亮一灭 —— 灯与
 *  声音必须同一条时间轴，各闪各的就成了两套假设备）；关死后熄灭。
 *  判据（test-env 的门区组）：三档状态取值正确，且关死档 ≠ 0（灯座还在）。 */
function doorLampK(open, closing, time) {
  const o = open == null ? 0 : open;
  if (o > 0.85) return LAMP_ON;
  if (o > 0.03) {
    if (closing) return (Math.floor((time || 0) / SH.DOOR_BEEP) % 2) ? LAMP_OFF : LAMP_ON;
    return LAMP_ON;
  }
  return LAMP_OFF;
}

/** 仪表斜面的基：法向朝司机、"上"沿斜面。buildCabInterior 与指示灯共用这一份，
 *  否则"贴在斜面上"这个约定会有两套数值，改一处就错位。 */
function cabPanel(p) {
  const front = p.headLen / 2;
  const su = [0, 0.803, 0.594], sn = [0, 0.62, -0.78];
  const c = [-0.02, p.floorY + 0.72, front - 1.58];
  return { su, sn, onSlope: (gx, up, off) => [c[0] + gx, c[1] + su[1] * up + sn[1] * off, c[2] + su[2] * up + sn[2] * off] };
}

function buildCabLamps(p) {
  const { su, sn, onSlope } = cabPanel(p);
  return LAMPS.map((d, i) => {
    const b = new Builder();
    b.light(cabLightFn(p));
    const gx = -0.28 + i * 0.14;
    /* 灯必须**朝司机**，而且要在司机的视线带里。
       第一版平躺在水平台面上、法向沿 z：司机视线压在台面上只有 21°，看到的
       是一颗 3.5 cm 深的扁条（约 16×6 像素），还被自己那圈更高的灯座挡住。
       第二版挪到仪表斜面**下缘**（up=−0.22）——朝向对了，但投影在画面 y≈0.93，
       几乎掉出视野底边：斜面上的东西越靠下，因为离眼近，反而投影越低。
       所以放在 TCMS 屏**上方**（屏占 up −0.06~0.18，斜面到 ±0.286），
       那里投影在 y≈0.69，正好在司机扫面板的路线上。 */
    b.plate(onSlope(gx, 0.24, 0.020), [0.05, 0, 0], [0, su[1] * 0.05, su[2] * 0.05], sn,
      rgbOf(d.color), { mat: 'light', emi: 1 });
    b.plate(onSlope(gx, 0.24, 0.0), [0.074, 0, 0], [0, su[1] * 0.074, su[2] * 0.074], sn,
      rgbOf('#10161a'), { mat: 'metal' });
    return { key: d.key, mesh: b.finish() };
  });
}

/* ------------------------------------------------------------ 司机室内部 */
/**
 * 第一视角是默认视角，所以内饰值得单独建模：
 * 台面、TCMS 屏、主控手柄座、A 柱、遮阳板、侧窗框、客室通道门。
 * 坐标与车体一致（原点 = 车中心，+z 向前）。
 */
function buildCabInterior(p, opt) {
  opt = opt || {};
  const b = new Builder();
  b.light(cabLightFn(p));
  const nose = noseOf(p), L = p.headLen, HN = L / 2;
  const front = HN;                          // 鼻尖局部 z
  const wall = rgbOf('#2a3138'), desk = rgbOf('#1c2227');
  /* 前挡风玻璃：从内看是半透深色。
     以前它只覆盖 floorY+1.01~2.03，而台面顶只有 floorY+0.46 —— 中间 0.55 m
     **什么都没有**：司机在仪表台高度直接看见外面的马路（手柄因此像"两根杆子
     站在路上"，而不是"在驾驶室里、隔着玻璃看路"）。
     第一次修的时候按**半长**给了 `ay=0.77` —— 而 `plate` 的 ax/ay 是**全长**，
     结果玻璃整体下移还变短：下沿补上一半、上沿反而多出一个洞（新加的 cab
     判据量出来的）。现在直接由"台面顶 floorY+0.46"与"遮阳板 roofY−0.30"两个
     边界算中心与全长 —— 驾驶室前方不许有任何"直接看见外面"的缝，除了玻璃本身。 */
  const wTop = p.roofY - 0.10, wBot = p.floorY + 0.46;
  /* 这块玻璃按车型**后倾**：`rake` 是顶边相对底边往后倒的水平距离（磁浮的长鼻锥
     最斜、APM 几乎竖直），以前四型车共用一片竖直玻璃 —— 而车头正面恰恰是
     "分型"最容易读出来、也最难造假的地方。
     注意这块玻璃同时是司机看出去的那一层：以前另外在鼻皮上贴过第二层玻璃，
     它挡在司机这层前面，把 cab 判据量到的玻璃覆盖率从 40~54% 打到 15~26% ——
     一个车头不许有两层风挡。 */
  const zPane = front - 0.42, rk = nose.screen.rake;
  b.plate([0, (wTop + wBot) / 2, zPane - rk / 2], [p.width - 0.10, 0, 0], [0, wTop - wBot, -rk], [0, 0, -1], rgbOf('#0a1015'), { mat: 'glassSoft', alpha: 0.20, uv: 1 });
  /* 中柱：档案说风挡分两块才长，说是一整块面罩就不许长 */
  if (nose.screen.pillar > 0) {
    b.plate([0, (wTop + wBot) / 2, zPane - rk / 2 + 0.014], [-nose.screen.pillar, 0, 0], [0, wTop - wBot, -rk], [0, 0, 1],
      rgbOf('#20272c'), { mat: 'body', uv: 1 });
  }
  // 司机台台面
  b.box([-0.02, p.floorY + 0.42, front - 1.28], [2.30, 0.08, 0.95], desk, { mat: 'paint' });
  b.box([-0.02, p.floorY + 0.05, front - 1.28], [2.24, 0.70, 0.80], wall, { mat: 'paint', faces: [2, 4, 5] });
  // 仪表斜面 + TCMS 屏
  b.plate([-0.02, p.floorY + 0.72, front - 1.58], [1.55, 0, 0], [0, 0.46, 0.34], [0, 0.6, -0.8], rgbOf('#12181c'), { mat: 'paint' });
  /* 仪表斜面是 ax=[1,0,0] / ay=[0,0.46,0.34] 的一张斜板，
     贴在它上面的东西必须用**斜面自己的上下方向** su 与**朝司机法向** sn 定位，
     不能各写各的 y/z —— 第一版圆表就是按水平面摆的，结果整只表埋进斜板里，
     截图里只剩两块暗斑。 */
  const { su, sn, onSlope } = cabPanel(p);
  /* 斜面上这几层的**前后间距不是审美问题，是精度问题**。司机台的层次只有几
     厘米，而这一列车的世界坐标在 2 万米开外：float32 在 2.3e4 m 处的分辨率约
     1.4 mm，深度缓冲又是 16 位，两层只要贴到 6 mm 就开始抢深度测试 —— 黑色的
     屏边框会在屏面上啃出一块斜的缺口，并随里程与机位来回翻（玩家实录"显示屏
     有时候闪，就这样子来回黑"）。实测屏/边框 6 mm 时必现，拉到 11.5 mm 整屏
     恢复。所以层次按这张表给，任何一层与它前面那层的间距都不小于 8 mm：
       边框 0.0005 < 屏面 0.012 < 功能键 / 指示灯 0.020
     功能键原来在 up=−0.075 —— 而屏面占 up −0.09~0.21，等于五颗键骑在屏的报警条
     上（截图里那五个灰块），现在挪到屏下沿的边框条上（−0.112，边框到 −0.127）。 */
  /* TCMS 屏的机壳边框：屏下沿一排 5 颗实体按键（真实 TCMS 下方有功能键）。
     边框垫在屏面板之下，屏还是原来那块实时纹理。 */
  if (opt.tcms) {
    b.plate(onSlope(0, 0.06, 0.0005), [0.94, 0, 0], [0, 0.30, 0.222], sn, rgbOf('#0a0e11'), { mat: 'paint' });
    b.panel(onSlope(0, 0.06, 0.012), [0.86, 0, 0], [0, 0.241, 0.178], sn, opt.tcms, [1, 1, 1], 0.9, 'cab');
    /* 屏下边框条上的 5 颗实体功能键：贴斜面（up −0.075 在屏底 −0.06 与
       边框底 −0.09 之间），用 plate 跟着斜面走，box 会与斜面穿模。 */
    for (let bi = 0; bi < 5; bi++) {
      b.plate(onSlope(-0.30 + bi * 0.15, -0.112, 0.020), [0.052, 0, 0], [0, 0.016, 0.012], sn, rgbOf('#39424a'), { mat: 'paint' });
    }
  }
  /* 屏两侧各一只圆表（速度 / 缸压），带一根红针。
     第一视角原来整块司机台是**空的**：`_globalSigns()` 里画好的 TCMS 贴图从来没有
     传进 `buildCabInterior`（game.js 只传了 `{sign}`，`opt.tcms` 永远 undefined），
     于是台面上一块黑、斜面上一块黑，驾驶室截图读起来就是"三块板"。
     圆表同理：以前针是一块**焊死在 12 点方向**的红塑料片，车速 80 也是指着 0。
     现在两张表盘和 TCMS 一样走独立实时纹理 'gauge'（一张画布两半，一次上传），
     uv 窗口按左右分给两只表 —— 表针角度由 SH.dialDeg 算，和 HUD 的电子表同源。 */
  const GF = [[0, 0, 0.5, 1], [0.5, 0, 1, 1]];
  for (let gi = 0; gi < 2; gi++) {
    /* 司机坐在 x=−0.34（−x 那侧，见 game.js 的 cab 机位），真实驾驶室的速度表
       就摆在司机正前方。第一版按"+x 是司机左边"放，结果默认机位里在画面内的
       是缸压表、速度表被挤到画面外 —— 截图一眼看出主次颠倒。 */
    const gx = gi ? 0.63 : -0.63;
    /* 金属表圈：表盘外一圈亮色金属 —— 真实仪表的"圈"是读表时的第一个锚点，
       没有它两块表就是斜面上两块贴片。垫在表盘与深色底板之下（sn 方向更靠里）。 */
    b.plate(onSlope(gx, 0.05, 0.006), [0.218, 0, 0], [0, 0.175, 0.129], sn, rgbOf('#6a7681'), { mat: 'metal' });
    b.plate(onSlope(gx, 0.05, 0.010), [0.19, 0, 0], [0, 0.153, 0.113], sn, rgbOf('#0c1216'), { mat: 'paint' });
    /* 表盘第一版给到 emi 0.5 + 近白色，在黄昏的司机室里两块表就是两张
       发光的白纸，比 TCMS 屏还抢眼。真实表盘是印刷白 + 背光，亮度只比
       周围塑料高半档。 */
    if (opt.gauges) {
      b.panel(onSlope(gx, 0.05, 0.018), [0.15, 0, 0], [0, 0.121, 0.089], sn, GF[gi], [1, 1, 1], 0.55, 'gauge');
    } else {
      b.plate(onSlope(gx, 0.05, 0.018), [0.15, 0, 0], [0, 0.121, 0.089], sn, rgbOf('#8d979e'), { mat: 'light', emi: 0.12 });
      b.plate(onSlope(gx + 0.030, 0.066, 0.024), [0.012, 0, 0], [0, 0.052, 0.039], sn, rgbOf('#c0392b'), { mat: 'paint', emi: 0.3 });
    }
  }
  /* 台面上的指示灯与开关：司机视线扫过台面时唯一能证明"这是一台机器"的东西。 */
  /* 指示灯排不在这里 —— 它们要随系统状态亮灭，所以单独成批，
     见 buildCabLamps()。以前这五行写死在 cab 批次里，`emi: i === 3 ? 0.12 : 1.5`
     与车门/牵引/制动/ATO 毫无关系。 */
  /* 左前按钮排（灯测试/刮雨器/头灯/客室照明一类）：两排带色按钮 + 丝印条。
     真实台面上这一片是"开关密度最高"的区域，四颗无名灰块读不出"机器"。 */
  {
    const caps = ['#3f9e5a', '#c0392b', '#d9a947', '#c8d2d8', '#c8d2d8', '#3f9e5a', '#d9a947', '#c8d2d8'];
    for (let i = 0; i < 8; i++) {
      const row = i >> 2, col = i & 3;
      b.box([-1.02 + col * 0.115, p.floorY + 0.482, front - 1.32 + row * 0.085], [0.042, 0.026, 0.052],
        rgbOf(caps[i]), { mat: 'paint' });
    }
    /* 丝印铭牌条：按钮下方一条浅色板 —— 没有文字，但"有铭牌"这件事本身就是细节 */
    b.box([-0.845, p.floorY + 0.472, front - 1.395], [0.50, 0.012, 0.028], rgbOf('#8d979e'), { mat: 'metal' });
  }
  /* 左右门控面板：各一组"红开绿关"+ 门使能旁路（黄）。真实司机台左右各一组，
     开哪侧门按哪侧 —— HUD 的开门按钮在 3D 世界里就对应这两组。 */
  for (const side of [-1, 1]) {
    const dx = side * 0.98;
    b.box([dx, p.floorY + 0.49, front - 1.06], [0.24, 0.055, 0.15], rgbOf('#20262c'), { mat: 'paint' });
    b.box([dx - 0.055, p.floorY + 0.524, front - 1.06], [0.052, 0.022, 0.062], rgbOf('#c0392b'), { mat: 'paint' });
    b.box([dx + 0.055, p.floorY + 0.524, front - 1.06], [0.052, 0.022, 0.062], rgbOf('#3f9e5a'), { mat: 'paint' });
    b.box([dx, p.floorY + 0.524, front - 1.145], [0.040, 0.020, 0.048], rgbOf('#d9a947'), { mat: 'paint' });
  }
  /* ATO 发车双按钮（台面右前、主控手柄旁）：真实台面上两个并排的绿钮，
     给一点极弱自发光 —— "待命时常亮"的那对按钮。 */
  b.box([0.42, p.floorY + 0.485, front - 0.92], [0.13, 0.045, 0.10], rgbOf('#1d242a'), { mat: 'paint' });
  for (const ax of [0.385, 0.455]) {
    b.box([ax, p.floorY + 0.516, front - 0.92], [0.042, 0.018, 0.055], rgbOf('#3f9e5a'), { mat: 'paint', emi: 0.22 });
  }
  /* 模式选择旋钮（ATO/ATP/RM/切除）+ 钥匙开关：台面正中偏右的两个小圆柱。 */
  b.cylY([0.30, p.floorY + 0.50, front - 1.30], 0.038, 0.035, rgbOf('#2c343b'), { mat: 'metal', seg: 10 });
  b.box([0.30, p.floorY + 0.524, front - 1.285], [0.016, 0.012, 0.055], rgbOf('#d9dfe4'), { mat: 'paint' });
  b.cylY([-0.30, p.floorY + 0.50, front - 1.32], 0.026, 0.030, rgbOf('#39424a'), { mat: 'metal', seg: 10 });
  b.box([-0.30, p.floorY + 0.519, front - 1.308], [0.012, 0.010, 0.034], rgbOf('#10151a'), { mat: 'paint' });
  /* 广播/PIS 控制盒 + 话筒：台面右后区一个斜面小盒，盒上一排站播/客室键。 */
  b.box([0.98, p.floorY + 0.50, front - 1.34], [0.26, 0.09, 0.17], rgbOf('#232a31'), { mat: 'paint' });
  b.plate([0.98, p.floorY + 0.556, front - 1.32], [0.20, 0, 0], [0, 0.045, 0.10], [0, 0.55, -0.84], rgbOf('#141a1f'), { mat: 'paint' });
  for (let i = 0; i < 4; i++) {
    b.box([0.915 + i * 0.045, p.floorY + 0.565, front - 1.305], [0.028, 0.012, 0.032],
      rgbOf(i === 0 ? '#3f9e5a' : '#5a656f'), { mat: 'paint' });
  }
  b.box([1.09, p.floorY + 0.545, front - 1.50], [0.025, 0.085, 0.025], rgbOf('#181e23'), { mat: 'metal' });
  b.cylY([1.09, p.floorY + 0.62, front - 1.50], 0.016, 0.11, rgbOf('#181e23'), { mat: 'metal', seg: 8 });
  b.box([1.09, p.floorY + 0.69, front - 1.50], [0.05, 0.045, 0.05], rgbOf('#242c33'), { mat: 'paint' });
  /* 手柄座正面：级位刻度窗。两座手柄（±0.62）前脸各加一条浅色刻度板 +
     三格刻度块，转头扫一眼就知道手柄在哪个区 —— 与 HUD 级位、TCMS 级位同源同义。 */
  for (const hx of [-0.62, 0.62]) {
    b.box([hx, p.floorY + 0.70, front - 0.955], [0.10, 0.20, 0.018], rgbOf('#c9d3da'), { mat: 'metal' });
    for (let ti = 0; ti < 3; ti++) {
      b.box([hx, p.floorY + 0.645 + ti * 0.055, front - 0.943], [0.062, 0.012, 0.008],
        rgbOf(ti === 1 ? '#8d979e' : '#2b333a'), { mat: 'paint' });
    }
  }
  /* 主控与制动手柄：立柱 + 前伸 + 球头三段，比"两个黑盒子"读得出来是手柄。
     手柄本体**不在这里画** —— 见 buildCabLevers()，它们要按级位转。
     以前这一行注释写着"运行时按级位画"，而代码里根本没有第二处画手柄的地方：
     司机台是烘焙进 cab 批次的一次性几何，HUD 那只电子手柄随级位动、
     3D 这两只永远钉在中间，第一视角看就是"两个塑料柱子"。
     写了没做，比没写更糟。 */
  for (const hx of [-0.62, 0.62]) {
    b.box([hx, p.floorY + 0.62, front - 1.10], [0.22, 0.34, 0.26], rgbOf('#242b31'), { mat: 'metal' });
  }
  /* 台面前沿给一条亮边：整块台面是 #1c2227，在黄昏里就是一团纯黑剪影，
     看不出台面有厚度、也看不出它到哪结束。 */
  b.box([-0.02, p.floorY + 0.47, front - 0.815], [2.30, 0.05, 0.055], rgbOf('#5a656f'), { mat: 'metal' });
  /* 雨刷只有一套（在下面的 A 柱循环里，跟着 side 走）。
     这里原来还有一版：一根 1.50 m 的横杆 + 两根 0.46 m 的竖臂，
     竖臂顶端在司机视线高度上，第一视角看出去就是"视野中间两个黑球加一根杠"，
     而且和下面那套重复 —— 同一台车画了两副雨刷。 */
  // 主控手柄底座在上面那段手柄循环里一起画（同一坐标，别再画第二遍）
  // A 柱与侧墙
  for (const side of [-1, 1]) {
    b.box([side * (p.width / 2 - 0.16), p.floorY + 1.55, front - 0.55], [0.16, 2.10, 0.20], wall, { mat: 'paint' });
    b.plate([side * (p.width / 2 - 0.02), p.floorY + 1.30, front - 2.6], [0, 0, 2.4], [0, 1.1, 0], [side, 0, 0], rgbOf('#0d141a'), { mat: 'window', uv: 1 / 1.2, emi: 0.30 });
    b.box([side * (p.width / 2 - 0.06), p.floorY + 0.95, front - 2.4], [0.08, 1.9, 3.2], wall, { mat: 'paint' });
    /* 侧窗下的操纵台裙：原来侧墙是一整片从地板到窗下的空板，
       真实司机室两侧各有一条放开关的斜裙。 */
    b.box([side * (p.width / 2 - 0.30), p.floorY + 1.03, front - 2.30], [0.36, 0.10, 2.10], rgbOf('#242b31'), { mat: 'paint' });
    /* 裙上的开关排：左侧（头灯/尾灯/雨刮/洗车模式）与右侧（客室照明/空调/通风）
       各一组四键 + 一枚旋钮 —— 转头看侧窗时，裙上不再是"一条空台子"。 */
    for (let si = 0; si < 4; si++) {
      b.box([side * (p.width / 2 - 0.30), p.floorY + 1.092, front - 2.78 + si * 0.14], [0.10, 0.024, 0.062],
        rgbOf(si % 3 === 0 ? '#5a656f' : '#39424a'), { mat: 'paint' });
    }
    b.cylY([side * (p.width / 2 - 0.30), p.floorY + 1.095, front - 2.06], 0.034, 0.024, rgbOf('#2c343b'), { mat: 'metal', seg: 8 });
    /* 指示片不许用亮色：这个位置离顶棚灯只有 ~0.8 m，e≈0.87，base 超过 0.56
       就会在司机室照明判据里过曝（亮灰 #d9dfe4 实测 add 3.19、4 条线被顶破 8%）——
       深枪灰的刻槽读得出"指向"，又不往过曝面积里添顶点。 */
    b.box([side * (p.width / 2 - 0.30), p.floorY + 1.110, front - 2.045], [0.013, 0.008, 0.045], rgbOf('#39424a'), { mat: 'paint' });
    /* 雨刮**不在这里画**（第 106 条）—— 它们要在雨天摆起来，而烘焙批次是
       一次成型的：对雨刮来说"不会动"就是"是假的"。见 buildCabWipers()，
       与两只手柄同一套"几何以铰点为原点、绘制时转基变换"的机制。
       历史备注：这里曾是烘死的横杆 + 斜停杆两代，第一代悬在车顶外的空中，
       第二代斜停在玻璃下沿 —— 但雨天也一样纹丝不动。 */
  }
  // 顶棚与遮阳板
  /* 顶棚必须一直铺到挡风玻璃所在的那个面（front−0.42）。以前它只到 front−0.8，
     于是"玻璃上沿"与"顶棚前缘"之间留着一圈缝：高架段抬头看就是**一片天空直接从
     车顶上面漏进来**（新 cab 判据在 3/5/14/16/17 号线 + 浦江线量到 17~22% 的像素
     落在 3 m 开外，材质是空/bldgWin）。驾驶室是个壳体，壳上不许有缝。 */
  b.box([0, p.roofY - 0.10, front - 2.20], [p.width - 0.1, 0.10, 3.60], rgbOf('#39414a'), { mat: 'paint' });
  b.plate([0, p.roofY - 0.20, front - 0.42], [p.width * 0.90, 0, 0], [0, 0.02, 0.30], [0, -1, 0], rgbOf('#20262b'), { mat: 'paint' });
  // 客室通道门 + 司机室门（在车体后部）
  b.box([-0.55, p.floorY + 1.05, -HN + 1.2], [1.05, 2.05, 0.08], rgbOf('#2f373e'), { mat: 'paint' });
  b.box([0.72, p.floorY + 1.05, -HN + 1.2], [0.90, 2.05, 0.08], rgbOf('#2f373e'), { mat: 'paint' });
  /* 通道门观察窗 + 门锁：转头看后方时，门板不再是两块纯色板 ——
     真实通道门上部有一扇小玻璃窗（看得到客室的灯）。 */
  b.plate([-0.55, p.floorY + 1.52, -HN + 1.15], [0.42, 0, 0], [0, 0.42, 0], [0, 0, 1], rgbOf('#0d141a'), { mat: 'glassSoft', alpha: 0.30, uv: 1 });
  b.plate([0.72, p.floorY + 1.52, -HN + 1.15], [0.36, 0, 0], [0, 0.42, 0], [0, 0, 1], rgbOf('#0d141a'), { mat: 'glassSoft', alpha: 0.30, uv: 1 });
  b.box([-0.12, p.floorY + 1.02, -HN + 1.13], [0.05, 0.12, 0.05], rgbOf('#5a656f'), { mat: 'metal' });
  /* 司机座椅：立柱 + 座垫 + 靠背 + 头枕，在司机位（x=−0.34）正后方。
     环视放开到 ±86° 之后，转头第一眼看到的就是它 —— 以前那里是空的。 */
  b.cylY([-0.34, p.floorY + 0.68, front - 3.42], 0.045, 0.52, rgbOf('#232a30'), { mat: 'metal', seg: 8 });
  b.box([-0.34, p.floorY + 0.97, front - 3.42], [0.50, 0.10, 0.48], rgbOf('#3a4a56'), { mat: 'paint' });
  b.box([-0.34, p.floorY + 1.32, front - 3.66], [0.48, 0.66, 0.11], rgbOf('#3a4a56'), { mat: 'paint' });
  b.box([-0.34, p.floorY + 1.74, front - 3.66], [0.26, 0.15, 0.10], rgbOf('#31404c'), { mat: 'paint' });
  /* 顶棚细节：扬声器格栅（三条细槽）+ 检修盖板（一圈边线）。
     抬头（pitch +0.75 就是为这个放的）时顶棚不再是一整片空白板。 */
  for (let gi = 0; gi < 3; gi++) {
    b.box([-0.52, p.roofY - 0.148, front - 2.55 + gi * 0.10], [0.34, 0.012, 0.035], rgbOf('#181e23'), { mat: 'paint' });
  }
  b.plate([0.55, p.roofY - 0.148, front - 1.75], [0.70, 0, 0], [0, 0.012, 0.55], [0, -1, 0], rgbOf('#2e363d'), { mat: 'paint' });
  /* 灭火器：后墙两扇门之间，红瓶 + 金属抱箍 + 压力表 —— 真实司机室
     后墙的标配，转头扫过后墙时多一件"读得出用途"的东西。 */
  b.cylY([0.10, p.floorY + 0.86, -HN + 1.16], 0.075, 0.52, rgbOf('#b3342c'), { mat: 'paint', seg: 10 });
  b.cylY([0.10, p.floorY + 1.16, -HN + 1.16], 0.032, 0.10, rgbOf('#8c2721'), { mat: 'metal', seg: 8 });
  b.cylY([0.10, p.floorY + 1.24, -HN + 1.16], 0.020, 0.05, rgbOf('#3a4249'), { mat: 'metal', seg: 8 });
  for (const by of [0.78, 1.02])
    b.box([0.10, p.floorY + by, -HN + 1.235], [0.20, 0.05, 0.02], rgbOf('#2c343a'), { mat: 'metal' });
  // 司机室顶灯：第一视角的主要补光
  b.plate([0, p.roofY - 0.16, front - 2.9], [1.20, 0, 0], [0, 0.02, 0.5], [0, -1, 0], rgbOf('#e9f3ff'), { mat: 'emissive', uv: 1, emi: 1.3 });
  b.plate([0, p.floorY + 0.62, front - 3.3], [1.6, 0, 0], [0, 0.02, 0.4], [0, -1, 0], rgbOf('#cfe0ee'), { mat: 'emissive', uv: 1, emi: 0.55 });
  return b.finish();
}

/* ------------------------------------------------- 司机室手柄（要会动的那两件） */
/**
 * 手柄角度：主控走牵引侧（推向前），制动手柄走制动侧（拉向司机）。
 * 游戏的级位轴是一根 −9…4 的连续轴，真实双柄驾驶室正是这样分工的 ——
 * 同一个 notch 按区间喂给两只杆，而不是另编一套控制逻辑。
 * @param which 'master' | 'brake'
 * @param notch 级位（SH.physics.NOTCHES 的 v）
 * @returns 绕局部 x 的弧度，正 = 杆梢朝车头（+z）
 */
function leverAngle(which, notch) {
  const d = Math.PI / 180;
  if (which === 'master') return (notch > 0 ? notch : 0) * 6 * d;      // P1…P4 → 6°…24°
  return clamp(notch, -8, 0) / 8 * 27 * d;                              // B1…B7/FR/EB → −3.4°…−27°
}
SH.leverAngle = leverAngle;

/** 两只手柄各自的几何 + 铰点。几何以**铰点为原点**建，绘制时再平移到铰点，
 *  这样"转"只是一个绕局部 x 的基变换，不需要每帧重算顶点。 */
function buildCabLevers(p) {
  const HN = p.headLen / 2, front = HN;
  return [-0.62, 0.62].map((hx, i) => {
    const b = new Builder();
    b.light(cabLightFn(p));
    const py = p.floorY + 0.78, pz = front - 1.10;      // 铰点：立柱底
    /* 亮度必须比台面高一档：司机台是 #1c2227（近乎纯黑），手柄原来是同色系的
       #39434b + 球头 #171d22 —— 截图里两只手柄**完全看不见**，而它们正是
       "级位动了没有"的唯一 3D 证据。真实驾驶室的手柄读得出来，是因为它衬在
       较亮的操纵台与挡风玻璃之间。 */
    b.box([0, 0.17, 0], [0.07, 0.34, 0.07], rgbOf('#8e9aa3'), { mat: 'metal' });
    b.box([0, 0.34, 0.09], [0.06, 0.06, 0.20], rgbOf('#7d8891'), { mat: 'metal' });
    b.sphere([0, 0.35, 0.18], [0.058, 0.058, 0.058], { mat: 'paint', color: rgbOf('#2f373f'), segU: 10, segV: 7 });
    /* 握把上给一道亮环：整根杆是 #39434b，在黄昏司机室里就是一团黑剪影，
       看不出它转到哪一格 —— 而"手在哪"恰恰是第一视角最该读出来的信息。 */
    b.box([0, 0.30, 0.185], [0.075, 0.045, 0.045], rgbOf('#dfe8ee'), { mat: 'metal' });
    return { which: i === 0 ? 'master' : 'brake', pivot: [hx, py, pz], mesh: b.finish() };
  });
}

/* ------------------------------------------------- 雨刮（雨天才会动的第三件） */
/**
 * 两只雨刮单独成批，几何**以铰点为原点**：绘制时 `车体矩阵 · 平移到铰点 · 绕
 * 局部 z 转扫掠角`。扫掠轴取**车头方向 z**——雨刷在玻璃平面里摆动（刷片沿
 * 横向 x，扫过时刷尖沿玻璃升起），这正是真实雨刮的运动方式。
 * 铰点在刷片**外端**（靠 A 柱那一侧），与真实雨刮的驱动轴同位。
 * 静止位 θ=0：刷片水平贴在玻璃下沿 —— 停车时雨刮就该收在那里。
 * 判据（test-env 的雨天组）：draw(wiper=θ) 与 draw(wiper=0) 的矩阵必须不同，
 * 且矩阵 = 车体矩阵 × trs(铰点) × rz(−side·θ)（两侧平行摆：刷尖同向升起）。
 */
function buildCabWipers(p) {
  const HN = p.headLen / 2, front = HN;
  const wy = p.floorY + 1.04, wz = front - 0.40, wl = 0.86;
  return [-1, 1].map(side => {
    const b = new Builder();
    b.light(cabLightFn(p));
    /* 刷片从铰点伸向车体中线：中心在 (−side·wl/2, 0, 0)。近黑配色 ——
       雨刮在黄昏日照下被洗成棕色就是不够暗，越暗越像剪影。 */
    b.box([-side * wl / 2, 0, 0], [wl, 0.024, 0.045], rgbOf('#141a1f'), { mat: 'paint' });
    /* 刷片下缘的刮条：比骨架更细的一道深色，从驾驶室看得出"贴着玻璃" */
    b.box([-side * wl / 2, -0.020, -0.006], [wl * 0.96, 0.012, 0.030], rgbOf('#0c1116'), { mat: 'paint' });
    /* 铰接座：留在原点（铰点）上，转起来杆子不会脱离转轴 */
    b.box([0, 0.018, 0], [0.06, 0.075, 0.06], rgbOf('#4a545c'), { mat: 'metal' });
    return { side, pivot: [side * 0.88, wy, wz], mesh: b.finish() };
  });
}

/* ------------------------------------------------------------ 车头灯体积光 */
/**
 * 从两盏前照灯向前打出的光锥。
 * 用加法混合的 beam 材质：顶点色由亮到黑就是由浓到透，
 * 所以"衰减"是烘在顶点色里的，运行时零成本。
 * 只在隧道/夜里好看，高架白天会被天空洗掉——由调用方决定是否画。
 */
function buildBeam(p) {
  const b = new Builder();
  const HN = p.headLen / 2, nose = 4.6;
  const z0 = HN - 0.3, LEN = 92;
  const y0 = p.floorY + 0.62;
  const steps = 9;
  for (const sx of [-1, 1]) {
    const ox = sx * p.width * 0.28;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const za = z0 + LEN * t0, zb = z0 + LEN * t1;
      // 随距离扩散，亮度按平方反比衰减到 0
      const wa = 0.5 + 7.0 * t0, wb2 = 0.5 + 7.0 * t1;
      const ha = 0.4 + 4.4 * t0, hb = 0.4 + 4.4 * t1;
      const ba = Math.pow(1 - t0, 2.2), bb = Math.pow(1 - t1, 2.2);
      const warm = [1.0, 0.94, 0.80];
      const q = (x, y, z, k) => [x, y, z, k];
      b.quadPts(q(ox - wa * 0.5, y0 - ha * 0.35, za), q(ox + wa * 0.5, y0 - ha * 0.35, za),
        q(ox + wb2 * 0.5, y0 - hb * 0.35, zb), q(ox - wb2 * 0.5, y0 - hb * 0.35, zb),
        [warm[0] * ba, warm[1] * ba, warm[2] * ba], { mat: 'beam', normal: [0, 0, -1] });
      b.quadPts(q(ox - wa * 0.5, y0 + ha * 0.65, za), q(ox + wa * 0.5, y0 + ha * 0.65, za),
        q(ox + wb2 * 0.5, y0 + hb * 0.65, zb), q(ox - wb2 * 0.5, y0 + hb * 0.65, zb),
        [warm[0] * ba * 0.8, warm[1] * ba * 0.8, warm[2] * ba * 0.8], { mat: 'beam', normal: [0, 0, -1] });
      for (const s of [-1, 1]) {
        b.quadPts(q(ox + s * wa * 0.5, y0 - ha * 0.35, za), q(ox + s * wa * 0.5, y0 + ha * 0.65, za),
          q(ox + s * wb2 * 0.5, y0 + hb * 0.65, zb), q(ox + s * wb2 * 0.5, y0 - hb * 0.35, zb),
          [warm[0] * ba * 0.55, warm[1] * ba * 0.55, warm[2] * ba * 0.55], { mat: 'beam', normal: [-s, 0, 0] });
      }
    }
  }
  return b.finish();
}

/* ------------------------------------------------ BVE 模型车体（README 第 146 条）
 * 用户给的 1 号线列车是 **BVE/OpenBVE 的 CSV 模型**（`assets/l1train/`），
 * 要求"原封不动搬过来" —— 所以这一族函数把模型的一节车直接写成一批几何，
 * 不再经过任何程序化车壳。模型自己的贴图由 `Renderer.registerBveMats` +
 * `texFromImage` 加载，材质名是 `bve:<贴图名>`。
 * 模型的 z=0 在**车尾**（车头在 z≈−23.9），而本项目的车以车心为 0，
 * 所以 emit 时整体在 z 上居中（`SH.bve.zCenter`）。 */
function bveMeshFor(idx, total) {
  const cars = SH.bve && SH.bve.cars;
  if (!cars || !cars.length) return null;
  if (idx <= 0) return cars[0];
  if (idx >= total - 1) return cars[cars.length - 1];
  const mid = cars.slice(1, Math.max(2, cars.length - 1));
  return mid[(idx - 1) % mid.length] || cars[0];
}
function buildBveBody(p, meshes, mirror) {
  const b = new Builder();
  b.light(carShellLight(p));
  const dz = SH.bve.zCenter(meshes);
  SH.bve.emit(b, meshes, { mirror: mirror || 1, xf: [1, 1, 1, 0, 0, dz] });
  return b.finish();
}

/* ------------------------------------------------------------ 列车接触影（视觉方案 1.3）
 * 列车以前完全没有影子：外视角与站台视角里整列车"浮"在轨道上 —— 这是
 * "浮"与"平"的第二主因（体检结论第 3 条）。做法与楼影同族：贴地软边扁块，
 * 不用 shadow map。几何按**车体局部系**烘焙一次（车下一块、每台转向架各一块），
 * 绘制时与车体同一份矩阵平移到轨面下 0.09 m（道床板顶 −0.05 与轨面 0 之间），
 * 随车移动是矩阵的自然结果。
 * 透明度由绘制方按"露天程度 × 太阳强度"给（SH.train.contactShadowAlpha）：
 * 隧道里没有太阳就没有影子；夜间太阳亮度低，影子按 sunCol 的亮度衰减。
 * blend 走 rubber 材质的常规半透通道 —— 与既有落地投影（_shadow）同一材质。 */
function buildContactShadow(p) {
  const b = new Builder();
  const dark = [0.05, 0.055, 0.06];               // 近黑的"影色"（基色，alpha 由绘制方给）
  const L = p.midLen, HB = p.bogieCenters / 2;
  const W = p.width * 0.94;                       // 车影比车体略窄：边缘让光进来才"软"
  /* 车下一块长条（覆盖整节车 + 车钩间隙的暗缝） */
  b.box([0, 0, 0], [W, 0.02, L + p.gap], dark, { mat: 'rubber', faces: [2] });
  /* 每台转向架一块加深的本影（轮对正下方最暗） */
  for (const sz of [-HB, HB]) {
    b.box([0, 0.001, sz], [W * 0.86, 0.02, 3.4], dark, { mat: 'rubber', faces: [2] });
  }
  return b.finish();
}
/** 接触影的透明度（0..1）：露天程度 × 当刻太阳亮度。
 *  sunK = 太阳颜色的相对亮度（0..1 量级），open = 0 全地下 → 1 全高架。
 *  隧道（open→0）里没有太阳贡献，影子必须消失 —— 与"站场浮尘只在地下出现"
 *  同一条口径。夜间太阳亮度 0.2 以下时影子自然淡出（月光不投硬影）。 */
function contactShadowAlpha(sunK, open) {
  if (!(open > 0)) return 0;
  const k = Math.max(0, Math.min(1, sunK == null ? 1 : sunK));
  return 0.34 * open * Math.min(1, k / 0.55);
}
/* 接触影的贴地矩阵：把车体局部系 y 压到 −0.09（轨面 0 与道床板顶 −0.05
   之间 —— 影子必须低于两者，否则与道床 z-fight）。挂 SH（判据用 eval 抠
   game.js 的 TrainView 类体离线跑，模块级符号在 eval 作用域外不可见）。 */
SH.SHADOW_M = m4trs([0, -0.09, 0], [1, 1, 1]);

/* ------------------------------------------------------------ 列车视图 */
class TrainView {
  constructor(profile, opt) {
    this.p = Object.assign({}, DEFAULTS, profile || {});
    this.opt = opt || {};
    this.rebuild();
  }
  rebuild() {
    const p = this.p;
    /* ---- **原封不动搬过来的 BVE 模型**（用户给的 1 号线列车，README 第 146 条）----
       车体 / 车顶 / 车头 / 转向架 / 车轮 / 连挂器全部来自模型自己的 CSV 网格与实拍贴图，
       程序化车壳整块让位。代价写清楚：模型的窗是**画在贴图上的**，所以
       "透过车窗看见客室"、门叶滑开、车内乘客这三条对它不成立 ——
       内饰与车内乘客一并让位（省下的三角形比车壳还多）。
       `SH.bve.cars` 在 Node（离线判据）里由判据自己从磁盘读，在浏览器里由
       App 拉取 —— 没到位时退回程序化车体，不会画出一列空车。 */
    if (p.photo === 'l1' && SH.bve && SH.bve.cars && SH.bve.cars.length) {
      const one = i => {
        const m = bveMeshFor(i, p.cars);
        return { body: buildBveBody(p, m, 1), doorsA: [], doorsB: [], glass: [], inner: [], pax: [], doorLamps: [] };
      };
      this.bve = true;
      this.mid = one(1); this.head = one(0);
      this.cab = buildCabInterior(p, this.opt);
      this.levers = buildCabLevers(p);
      this.lamps = buildCabLamps(p);
      this.wipers = buildCabWipers(p);
      this.carLen = i => (i === 0 || i === p.cars - 1) ? p.headLen : p.midLen;
      this.totalLen = (() => { let t = 0; for (let i = 0; i < p.cars; i++) t += this.carLen(i) + (i < p.cars - 1 ? p.gap : 0); return t; })();
      return;
    }
    this.bve = false;
    this.mid = buildMiddleCar(p, this.opt);
    this.head = buildHeadCar(p, this.opt);
    /* 客室：每节一份，与车体分批。车壳开窗以后这一层才看得见，
       而它必须在**车窗之前**画（不透明），车窗之后画（半透）。 */
    const dest = this.opt.dest || (this.opt.sign && this.opt.sign.rect);
    this.mid.inner = buildCarInterior(p, this.opt, 'mid', dest);
    this.head.inner = buildCarInterior(p, this.opt, 'head', dest);
    /* 车内乘客：三档增量批次。level 0 = 空车（不建几何），
       绘制时按 `SH.train.paxLevel(fill)` 画 level 1..k。 */
    this.mid.pax = [buildCarPax(p, 'mid', 1), buildCarPax(p, 'mid', 2), buildCarPax(p, 'mid', 3)];
    this.head.pax = [buildCarPax(p, 'head', 1), buildCarPax(p, 'head', 2), buildCarPax(p, 'head', 3)];
    /* 车门提示灯（B3）：每节车一批，绘制时按门状态给琥珀色亮度 */
    this.mid.doorLamps = buildCarDoorLamps(p, 'mid');
    this.head.doorLamps = buildCarDoorLamps(p, 'head');
    this.cab = buildCabInterior(p, this.opt);
    this.levers = buildCabLevers(p);
    this.lamps = buildCabLamps(p);
    /* 雨刮（第 106 条）：与手柄同一套"烘焙一次、绘制时转"的机制 */
    this.wipers = buildCabWipers(p);
    this.carLen = i => (i === 0 || i === p.cars - 1) ? p.headLen : p.midLen;
    this.totalLen = (() => { let t = 0; for (let i = 0; i < p.cars; i++) t += this.carLen(i) + (i < p.cars - 1 ? p.gap : 0); return t; })();
  }
  /** 每节车的中心里程（车头停在 sHead，车体向后延伸） */
  carCenters(sHead) {
    const p = this.p, out = [];
    let z = sHead - p.headLen / 2;                 // 0 号车中心
    out.push({ i: 0, s: z, len: p.headLen });
    for (let i = 1; i < p.cars; i++) {
      const len = this.carLen(i);
      z -= p.gap + p.midLen / 2 + (i > 1 ? p.midLen / 2 : 0) * 0;
      z = out[out.length - 1].s - out[out.length - 1].len / 2 - p.gap - len / 2;
      out.push({ i, s: z, len });
    }
    return out;
  }
}

/* 绘制分层：半透明材质必须排在它后面那块不透明几何之后画。
   车壳开了窗洞之后这件事从"无所谓"变成"决定成败" ——
   原来玻璃排在最前，靠"玻璃挂在外侧 8 mm"压住后面的车体板；
   现在玻璃后面真的有客室（不透明，要写深度），再画玻璃就只画在它自己那一层，
   透过窗看到的世界与客室会互相盖错。层号大的后画。 */
const LAYER = { window: 2, screenDoor: 2, glassSoft: 2, water: 2, beam: 3 };
const layerOf = mat => LAYER[mat] || 0;

SH.train = { DEFAULTS, buildMiddleCar, buildHeadCar, buildCabInterior, buildCarInterior, carLightFn, doorZs, doorSlide,
  windowBays, mullionZs, addGangway, WIN_PITCH, WIN_MULL, NOSE, noseOf,
  carLayout, buildCarPax, paxLevel, paxLevels, buildCarDoorLamps, doorLampK,
  buildCabLevers, buildCabLamps, buildCabWipers, LAMPS, LAMP_ON, LAMP_OFF, buildBeam, TrainView, bodyProfile,
  LAYER, layerOf, buildContactShadow, contactShadowAlpha };

})(typeof window !== 'undefined' ? window : globalThis);
