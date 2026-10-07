/* ============================================================================
 * mesh.js — 几何烘焙
 *
 * 这是相对南京版最关键的架构升级：
 *   南京版每帧把世界当成 ~1000 个独立 box 用不同颜色画出来（1000 次 draw call）。
 *   这里改成**离线烘焙**：把世界按材质分桶合成大 mesh，运行时一个材质一次
 *   draw call，于是同样的帧预算能画出多一到两个数量级的细节。
 *
 *   顶点属性：位置 + 法向 + UV + 顶点色 + 自发光。
 *   光源（隧道灯带、站台顶灯、夕阳、车灯）在烘焙阶段通过 lightFn 积分进顶点色
 *   与自发光，运行时零额外开销却有连续渐变的光斑——比"把灯烤进贴图"更细。
 *
 *   所有曲面形体都由"横截面沿路径扫掠"生成，因此曲线隧道、曲线高架、
 *   带腰线的车体、钢轨，共用同一套 sweep 代码。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { clamp, rgbOf } = SH;

/* ------------------------------------------------------------------ 工具 */
function addv(a, b, s) { return [a[0] + b[0] * (s == null ? 1 : s), a[1] + b[1] * (s == null ? 1 : s), a[2] + b[2] * (s == null ? 1 : s)]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/* ------------------------------------------------------------------ Builder */
class Builder {
  constructor() {
    this.buckets = new Map();
    this.lightFn = null;
    this.stats = { verts: 0, tris: 0 };
  }

  /** 安装烘焙光照回调 fn(x,y,z,nx,ny,nz) -> {b: 颜色倍增, emi: 自发光}；返回上一个 */
  light(fn) { const prev = this.lightFn; this.lightFn = fn; return prev; }
  push() { return this.lightFn; }
  pop(saved) { this.lightFn = saved; }

  _bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) { b = { mat, pos: [], nrm: [], uv: [], col: [], emi: [], ao: [], idx: [], n: 0 }; this.buckets.set(mat, b); }
    return b;
  }

  /** 追加顶点；颜色与自发光会经过 lightFn 调制 */
  vtx(b, x, y, z, nx, ny, nz, u, v, col, emi) {
    let lb = 1, le = emi || 0, tr = 1, tg = 1, tb = 1;
    if (this.lightFn) {
      const r = this.lightFn(x, y, z, nx, ny, nz);
      if (r) {
        if (r.b != null) lb = r.b;
        if (r.emi != null) le = (emi || 0) + r.emi;
        if (r.tint) { tr = r.tint[0]; tg = r.tint[1]; tb = r.tint[2]; }
      }
    }
    const i = b.n++;
    b.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    b.nrm.push(nx / l, ny / l, nz / l);
    b.uv.push(u, v);
    /* 顶点色要能装下"灯叠加在基色之上"的量：烘焙光照给的是 tint = 1 + 灯光，
     * 可这里以前按 0..1 存，于是**所有超过 1 的灯光全被削平**——
     * 隧道壁、站台墙面上算出来的灯池在打包那一步就没了，画面里只剩钢轨是亮的。
     * 现在存 0..2 折半到 0..1，着色器里再乘回来（vC.rgb * 2.0）。
     * 8 bit 表示 0..2 的步长是 0.0078，对反照率来说足够细。 */
    b.col.push(clamp(col[0] * lb * tr, 0, 2) * 0.5, clamp(col[1] * lb * tg, 0, 2) * 0.5, clamp(col[2] * lb * tb, 0, 2) * 0.5);
    b.emi.push(clamp(le, 0, 2.5));
    return i;
  }

  tri(b, i0, i1, i2) { b.idx.push(i0, i1, i2); this.stats.tris++; }
  quad(b, i0, i1, i2, i3) { b.idx.push(i0, i1, i2, i0, i2, i3); this.stats.tris += 2; }

  /* ------------------------------------------------------------- 矩形盒 */
  /**
   * 轴对齐盒。
   * @param opts.skip  跳过某面 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z
   * @param opts.faces 只画指定面数组
   * @param opts.faceColor 逐面颜色数组（同序）
   * @param opts.faceMat   逐面材质数组（同序）
   * @param opts.uv        贴图每米重复系数
   * @param opts.emi       自发光
   */
  box(center, size, color, opts) {
    opts = opts || {};
    /* opts.yaw：绕 y 轴转一个航向角（弧度）。
     * 盒体以前只能是世界轴对齐的，于是高架两侧的城市在曲线上会变成
     * "一堆互相穿插的方盒"——相邻两栋沿线路只隔 17 m，而世界轴向的边长
     * 最大 24 m，斜着插进彼此身体里，斜视角下看起来就是一栋扭成蝴蝶结的楼。
     * 给了 yaw（取该里程的线路航向）之后楼体与走廊平行，沿线路方向的尺寸
     * 就是真正的进深，可以按槽位限死，不再互穿。 */
    const yaw = opts.yaw || 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rot = v => yaw ? [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy] : v;
    /* 任何一条边超过 200 m 的盒子都切片再画。
     * 一个 2300 m 长的码头平台、1400 m 的滨河路、1040 m 的桥塔前伸臂，
     * 只要用一个盒子表达，它的顶面就是几千米的四边形 —— 雾、光照、贴图
     * 只能在角点之间线性插值，画面上就是一道斜切过场景的亮带/暗带
     * （最初那张"江面变成一片膜"的怪图就是这么来的）。
     * 切片后每片 ≤ 200 m，插值误差小到看不出来，代价只是几十个顶点。 */
    const MAXEDGE = 200;
    const longest = Math.max(size[0], size[1], size[2]);
    if (longest > MAXEDGE) {
      const ax = size[0] === longest ? 0 : (size[1] === longest ? 1 : 2);
      const n = Math.ceil(longest / MAXEDGE), step = size[ax] / n;
      const dir = rot(ax === 0 ? [1, 0, 0] : (ax === 1 ? [0, 1, 0] : [0, 0, 1]));   // 沿**局部**轴切
      for (let i = 0; i < n; i++) {
        const sz = [size[0], size[1], size[2]];
        sz[ax] = step;
        const off = -longest / 2 + step * (i + 0.5);
        const c = [center[0] + dir[0] * off, center[1] + dir[1] * off, center[2] + dir[2] * off];
        this.box(c, sz, color, opts);
      }
      return this;
    }
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2, c = center;
    const us = opts.uv == null ? 1 : opts.uv;
    const want = i => opts.faces ? opts.faces.indexOf(i) >= 0 : opts.skip !== i;
    // 面定义：法向、u 轴半长向量、v 轴半长向量、贴图尺寸
    /* 绕序必须满足 cross(u, v) ∥ n，否则这一面会被背面剔除——
     * GL 默认 frontFace(CCW)、cullFace(BACK)，三角形的朝向由右手定则给出。
     * 上下两面原来写成 u=[hx,0,0]、v=[0,0,±hz]，cross 出来是 ∓y，
     * 也就是**盒子的顶面和底面一直是朝内翻的**：从上面看穿模、从下面看穿模，
     * 而立面（0/1/4/5）是对的，所以平时看不出来。
     * 这条不变量现在由 test-wind.js 逐三角形机器检查。 */
    const F = [
      /* 立面的 UV 方向必须一致：**u 永远沿水平、v 永远沿高度**。
       * 原来 ±X 两面写成 u=[0,hy,0]（沿高度）、v=[0,0,±hz]（沿水平），
       * 也就是这两面上的窗格整体转了 90°：同一栋楼朝东那面窗是横着排的、
       * 朝南那面是竖着排的，两个面在转角处对不上 —— 黄昏下看就是一栋
       * "沿竖直方向折了一下"的楼，截图里完全解释不通，量几何又毫无重叠。
       * 改成 u 沿水平之后仍满足 cross(u,v) ∥ n（±X 两面的水平轴取反向）。 */
      { n: [1, 0, 0],  u: [0, 0, -hz], v: [0, hy, 0] },
      { n: [-1, 0, 0], u: [0, 0, hz],  v: [0, hy, 0] },
      { n: [0, 1, 0],  u: [0, 0, hz],  v: [hx, 0, 0] },
      { n: [0, -1, 0], u: [0, 0, -hz], v: [hx, 0, 0] },
      { n: [0, 0, 1],  u: [hx, 0, 0],  v: [0, hy, 0] },
      { n: [0, 0, -1], u: [-hx, 0, 0], v: [0, hy, 0] },
    ];
    for (let fi = 0; fi < 6; fi++) {
      if (!want(fi)) continue;
      const f = F[fi];
      const mat = (opts.faceMat && opts.faceMat[fi]) || opts.mat || 'concrete';
      const col = (opts.faceColor && opts.faceColor[fi]) || color;
      const b = this._bucket(mat);
      /* opts.uv 的语义 = **每米多少个贴图循环**，和 plate / sweep / cylY /
       * ringStack 一致。原来这里乘的是"半边长 × uv"，而面宽是 2×半边长，
       * 于是同一个数字在 box 上等于 2 米/循环、在 plate 上等于 1 米/循环：
       * 立面贴图因此在盒子上永远是设定尺寸的两倍（窗宽 3 m 而不是 1.5 m），
       * 而且这种偏差肉眼看不出来，只有对照真实尺度才发现。
       * 现在统一取全边长 UE/VE。 */
      const UE = 2 * (Math.abs(f.u[0]) + Math.abs(f.u[1]) + Math.abs(f.u[2])) * us;
      const VE = 2 * (Math.abs(f.v[0]) + Math.abs(f.v[1]) + Math.abs(f.v[2])) * us;
      const U = rot(f.u), V = rot(f.v), NN = rot(f.n);
      const i0 = this.vtx(b, c[0] - U[0] - V[0], c[1] - U[1] - V[1], c[2] - U[2] - V[2], NN[0], NN[1], NN[2], 0, 0, col, opts.emi);
      const i1 = this.vtx(b, c[0] + U[0] - V[0], c[1] + U[1] - V[1], c[2] + U[2] - V[2], NN[0], NN[1], NN[2], UE, 0, col, opts.emi);
      const i2 = this.vtx(b, c[0] + U[0] + V[0], c[1] + U[1] + V[1], c[2] + U[2] + V[2], NN[0], NN[1], NN[2], UE, VE, col, opts.emi);
      const i3 = this.vtx(b, c[0] - U[0] + V[0], c[1] - U[1] + V[1], c[2] - U[2] + V[2], NN[0], NN[1], NN[2], 0, VE, col, opts.emi);
      this.quad(b, i0, i1, i2, i3);
    }
    return this;
  }

  /** 任意朝向的矩形板：中心 + 两个完整边向量 + 法向 */
  plate(center, ax, ay, normal, color, opts) {
    opts = opts || {};
    /* 与 box 同样的保护：任一条边超过 200 m 就切成网格。
       水面、地面这类"必须铺得很远"的平面最容易一脚踩进超大四边形，
       而超大四边形上的插值（雾/光/UV）一定失真。 */
    const lenA = Math.hypot(ax[0], ax[1], ax[2]), lenB = Math.hypot(ay[0], ay[1], ay[2]);
    const MAXEDGE = 200;
    if (lenA > MAXEDGE || lenB > MAXEDGE) {
      const na = Math.max(1, Math.ceil(lenA / MAXEDGE)), nb = Math.max(1, Math.ceil(lenB / MAXEDGE));
      const us0 = opts.uv == null ? 1 : opts.uv;
      const bu = opts.uv0 ? opts.uv0[0] : 0, bv = opts.uv0 ? opts.uv0[1] : 0;
      for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
        const s1 = ax[0] / na, s2 = ax[1] / na, s3 = ax[2] / na;
        const t1 = ay[0] / nb, t2 = ay[1] / nb, t3 = ay[2] / nb;
        const c = [center[0] + s1 * (i - (na - 1) / 2) * 1 + t1 * (j - (nb - 1) / 2),
          center[1] + s2 * (i - (na - 1) / 2) + t2 * (j - (nb - 1) / 2),
          center[2] + s3 * (i - (na - 1) / 2) + t3 * (j - (nb - 1) / 2)];
        /* 切出来的每一块必须接上自己的贴图位置，否则整张大板变成同一块贴图的
           na×nb 份复制——分格越多越明显，远景地面就是这么变成一层条纹的。 */
        const o2 = Object.assign({}, opts, { uv0: [bu + lenA * us0 * (i / na - 0.5), bv + lenB * us0 * (j / nb - 0.5)] });
        this.plate(c, [s1, s2, s3], [t1, t2, t3], normal, color, o2);
      }
      return this;
    }
    const b = this._bucket(opts.mat || 'concrete');
    // 三个分量都要各减 ax/2 与 ay/2。原来 z 分量漏了 ax/2：只要 ax 带 z 分量
    // （沿 z 铺的水面、曲线上的牌面），整个板就沿 z 偏移半个边长。
    const c0 = [center[0] - ax[0] / 2 - ay[0] / 2, center[1] - ax[1] / 2 - ay[1] / 2,
      center[2] - ax[2] / 2 - ay[2] / 2];
    const us = opts.uv == null ? 1 : opts.uv;
    /* uv0：这块板的贴图原点。不给的话每块板都从 (0,0) 开始铺，
     * 于是"跟随相机的远景地面"这种 14×14 分格的平面会变成一格一份的
     * 完全相同的补丁，街区尺度被网格切碎，画面上是一层细条纹。 */
    const u0 = opts.uv0 ? opts.uv0[0] : 0, v0 = opts.uv0 ? opts.uv0[1] : 0;
    /* uvV：V 方向**单独**的每米重复系数（不给就与 U 同值，逐字节不变）。
     * 为什么需要：贴"实拍照片"这类非正方形贴图时，U 与 V 的"米/循环"必须能
     * 分开给 —— 一块 22 m × 2.55 m 的车侧板，U 要 1/22、V 要 1/2.55，
     * 而原来两者共用一个 `us`，只能贴出被拉扁的图（1 号线的车侧就是这么贴的）。 */
    const vs = opts.uvV == null ? us : opts.uvV;
    const la = Math.hypot(ax[0], ax[1], ax[2]) * us, lb = Math.hypot(ay[0], ay[1], ay[2]) * vs;
    const P = (du, dv) => [c0[0] + ax[0] * du + ay[0] * dv, c0[1] + ax[1] * du + ay[1] * dv, c0[2] + ax[2] * du + ay[2] * dv];
    const n = normal || norm3(cross(ax, ay));
    const i0 = this.vtx(b, ...P(0, 0), n[0], n[1], n[2], u0, v0, color, opts.emi);
    const i1 = this.vtx(b, ...P(1, 0), n[0], n[1], n[2], u0 + la, v0, color, opts.emi);
    const i2 = this.vtx(b, ...P(1, 1), n[0], n[1], n[2], u0 + la, v0 + lb, color, opts.emi);
    const i3 = this.vtx(b, ...P(0, 1), n[0], n[1], n[2], u0, v0 + lb, color, opts.emi);
    /* 绕序要跟着**给定法向**走：cross(ax, ay) 与 normal 反向时把四边形倒过来发。
     * 不这么做的话，"法向朝上但 ax×ay 朝下"的板子会被背面剔除——
     * 跟随相机的远景地面正是这种板子，于是它从来没被画出来过，
     * 画面里所有"楼悬在半空、地上什么都没有"的怪图都源于此。 */
    const cv = cross(ax, ay);
    if (cv[0] * n[0] + cv[1] * n[1] + cv[2] * n[2] < 0) this.quad(b, i0, i3, i2, i1);
    else this.quad(b, i0, i1, i2, i3);
    return this;
  }

  /** 四边形（四个显式角点，自动求法向或给定） */
  quadPts(p0, p1, p2, p3, color, opts) {
    opts = opts || {};
    /* 同 box/plate：边长超阈值就切成网格。
       圆形湖面（lakeDisc）用扇形 quadPts，半径 900 m 的扇形如果不再分格，
       就是两个 900 m 长的三角形，插值全废。 */
    const MAXEDGE = 200;
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 > MAXEDGE || l2 > MAXEDGE) {
      const n1 = Math.max(1, Math.ceil(l1 / MAXEDGE)), n2 = Math.max(1, Math.ceil(l2 / MAXEDGE));
      const d1 = e1.map(v => v / n1), d2 = e2.map(v => v / n2);
      /* 切格子的时候 UV 也必须跟着双线性插值。原来把父格的 opts 原样传下去，
         四个角的 uv 被每一块子格重复使用 —— 于是一张 522 m 半径的湖面
         切成 3×3 之后，每一块都从同一个 UV 角点开始铺，贴图被复制成格子，
         画面上是一圈圈的同心"手指"而不是水面。 */
      const UV = (opts.uv && opts.uv.length === 4) ? opts.uv : null;
      const q = (du, dv) => [p0[0] + e1[0] * du + e2[0] * dv, p0[1] + e1[1] * du + e2[1] * dv, p0[2] + e1[2] * du + e2[2] * dv];
      const qUV = (du, dv) => {
        if (!UV) return null;
        const o = {};
        for (const k in opts) if (k !== 'uv') o[k] = opts[k];
        const mixUV = (u, v) => [
          UV[0][0] + (UV[1][0] - UV[0][0]) * u + (UV[3][0] - UV[0][0]) * v + (UV[2][0] - UV[1][0] - UV[3][0] + UV[0][0]) * u * v,
          UV[0][1] + (UV[1][1] - UV[0][1]) * u + (UV[3][1] - UV[0][1]) * v + (UV[2][1] - UV[1][1] - UV[3][1] + UV[0][1]) * u * v];
        o.uv = [mixUV(du, dv), mixUV(du + 1 / n1, dv), mixUV(du + 1 / n1, dv + 1 / n2), mixUV(du, dv + 1 / n2)];
        return o;
      };
      for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        const o2 = qUV(i / n1, j / n2) || opts;
        this.quadPts(q(i / n1, j / n2), q((i + 1) / n1, j / n2), q((i + 1) / n1, (j + 1) / n2), q(i / n1, (j + 1) / n2), color, o2);
      }
      return this;
    }
    const b = this._bucket(opts.mat || 'concrete');
    const n = opts.normal || norm3(cross([p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]], [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]));
    const uv = opts.uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const P = [p0, p1, p2, p3];
    const a = P.map((p, i) => this.vtx(b, p[0], p[1], p[2], n[0], n[1], n[2], uv[i][0], uv[i][1], color, opts.emi));
    /* 与 plate / panel 同一条规则：绕序要跟着**给定法向**。
       quadPts 的角点顺序由调用方决定（湖面是"外沿→内沿"这种反向序），
       不校正的话一半的水面/地面会被背面剔除。 */
    const cv = cross([P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]],
      [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]]);
    if (cv[0] * n[0] + cv[1] * n[1] + cv[2] * n[2] < 0) this.quad(b, a[0], a[3], a[2], a[1]);
    else this.quad(b, a[0], a[1], a[2], a[3]);
    return this;
  }

  /* ------------------------------------------------------------- 圆柱/棱柱 */
  /** 直立圆柱（承重柱、灯杆、树冠干）。axis: 'y' 默认 */
  cylY(center, r, h, color, opts) {
    opts = opts || {};
    const b = this._bucket(opts.mat || 'concrete');
    const seg = opts.seg || 14, base = b.n;
    const rTop = opts.rTop == null ? r : opts.rTop;
    const slope = (rTop - r) / h;
    /* u 已经是弧长（米 × 每米循环数），v 原来写成 (y - center[0]) * 0 ——
     * 恒等于 0，圆柱侧面永远只采样贴图的第 0 行，所以塔楼裙房和塔台的窗
     * 是死的一样平。现在 v 也按同一尺度取真实高度。 */
    const us = opts.uv == null ? 1 : opts.uv;
    for (let j = 0; j < 2; j++) {
      const rr = j ? rTop : r, y = center[1] + (j ? h / 2 : -h / 2);
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nz = -slope;
        this.vtx(b, center[0] + rr * ca, y, center[2] + rr * sa, ca, nz, sa, i / seg * Math.PI * 2 * rr * us, y * us, color, opts.emi);
      }
    }
    /* 侧面的绕序必须朝外。原来写的是 (a, a+1, c+1, c) = 下环→下环next→上环next→上环，
     * 按右手定则得到的几何法向**径向朝内**，而顶点法向 (cos a, ·, sin a) 朝外
     * ——于是所有 cylY 生成的圆柱从外面看被整个背面剔除：灯杆、树、塔台、
     * 塔楼裙房、人群的头和脖子，只有"从里往外看"才存在。
     * 改成 (a, c, c+1, a+1)（下→上→上next→下next），cross 出来正是径向外法向。
     * 注意 cylZ 不能照抄：它的环在 xy 平面、轴在 +z，原写法本来就是朝外的。 */
    for (let i = 0; i < seg; i++) { const a = base + i, c = a + seg + 1; this.quad(b, a, c, c + 1, a + 1); }
    if (opts.caps !== false) this._capY(b, center, r, rTop, h, color, opts, seg);
    return this;
  }
  _capY(b, center, r, rTop, h, color, opts, seg) {
    /* 端盖的 UV 也要走"米"的口径。原来写成 .5 + cos·.5，等于无论半径 0.5 m
     * 还是 30 m 都把整张贴图塞进一个圆盘——塔楼裙房的顶面因此和侧面完全
     * 不是一个尺度（test-facade.js 逐三角形反解 UV 比例时当场抓到）。 */
    const us = opts.uv == null ? 1 : opts.uv;
    for (let s = 0; s < 2; s++) {
      const rr = s ? rTop : r, y = center[1] + (s ? h / 2 : -h / 2), ny = s ? 1 : -1;
      const ci = this.vtx(b, center[0], y, center[2], 0, ny, 0, center[0] * us, center[2] * us, color, opts.emi);
      const ring = b.n;
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2, px = center[0] + rr * Math.cos(a), pz = center[2] + rr * Math.sin(a);
        this.vtx(b, px, y, pz, 0, ny, 0, px * us, pz * us, color, opts.emi);
      }
      /* 端盖的绕序要跟 ny 一致：环上点按 a 递增，从 +y 俯视时 cross 得到 -y，
       * 所以**顶盖反着发、底盖正着发**——原来正好写反，圆柱的顶面与底面
       * 从来看不见（塔楼裙房的顶、灯杆的底都是这个）。 */
      for (let i = 0; i < seg; i++) { if (s) this.tri(b, ci, ring + i + 1, ring + i); else this.tri(b, ci, ring + i, ring + i + 1); }
    }
  }

  /** 沿 Z 轴的圆柱（车轮、灯罩、管道） */
  cylZ(center, r, len, color, opts) {
    opts = opts || {};
    const b = this._bucket(opts.mat || 'metal');
    const seg = opts.seg || 12, base = b.n;
    for (let j = 0; j < 2; j++) {
      const z = center[2] + (j ? len / 2 : -len / 2);
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        this.vtx(b, center[0] + r * ca, center[1] + r * sa, z, ca, sa, 0, z, i / seg, color, opts.emi);
      }
    }
    for (let i = 0; i < seg; i++) { const a = base + i, c = a + seg + 1; this.quad(b, a, a + 1, c + 1, c); }
    if (opts.caps !== false) {
      for (let s = 0; s < 2; s++) {
        const z = center[2] + (s ? len / 2 : -len / 2), nz = s ? 1 : -1;
        const ci = this.vtx(b, center[0], center[1], z, 0, 0, nz, .5, .5, color, opts.emi);
        const ring = b.n;
        for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; this.vtx(b, center[0] + r * Math.cos(a), center[1] + r * Math.sin(a), z, 0, 0, nz, .5 + Math.cos(a) * .5, .5 + Math.sin(a) * .5, color, opts.emi); }
        for (let i = 0; i < seg; i++) { if (s) this.tri(b, ci, ring + i, ring + i + 1); else this.tri(b, ci, ring + i + 1, ring + i); }
      }
    }
    return this;
  }

  /* ------------------------------------------------------------- 扫掠（核心） */
  /**
   * 把 2D 截面沿路径扫掠成管/梁/车体。
   * @param path  [{p:[x,y,z], r:[x,y,z], u:[x,y,z], f:[x,y,z], s:里程}]
   *              r/u/f 为该里程处的右手系（r×u=f）；r,u 张成截面平面
   * @param prof  [{x, y, nx, ny}] 截面点，坐标在 (r,u) 基下，绕序使法向朝外
   * @param opts  {mat, color, closed, uvAlong: 每米 UV 重复, vSpan: 截面周长映射宽度,
   *               colorFn(s, i, j), emiFn(s, i, j), flip}
   */
  sweep(path, prof, opts) {
    opts = opts || {};
    const mat = opts.mat || 'concrete';
    const b = this._bucket(mat);
    const closed = opts.closed !== false;
    const cols = closed ? prof.length : prof.length - 1;   // 环绕边数
    const P = prof.length;
    const step = opts.step || 1;                            // 路径抽稀
    const base = b.n;
    const uScale = opts.uvAlong == null ? 1 : opts.uvAlong;
    // 截面累计周长（用于 v 方向贴图）
    const cum = [0];
    for (let i = 1; i < P; i++) cum.push(cum[i - 1] + Math.hypot(prof[i].x - prof[i - 1].x, prof[i].y - prof[i - 1].y));
    const per = closed ? cum[P - 1] + Math.hypot(prof[0].x - prof[P - 1].x, prof[0].y - prof[P - 1].y) : cum[P - 1];
    const vSpan = opts.vSpan == null ? 1 : opts.vSpan;

    const frames = [];
    /* 断面之间超过 200 m 就先补插值断面。调用方偶尔会偷懒只给首尾两个
       断面（机场大厅的屋顶就是这么写的），那等于把整个扫掠体压成几个
       几百米的巨型三角形——光照、雾、贴图在上面全部失真。 */
    const lerp3 = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
    /* 位置只能线性插值，**不能归一化**。原来这里 r/u/f/p 共用一个 mix3，
       而 mix3 末尾套了 norm3 —— 对方向向量是对的，对位置就是把插值点甩到
       以地标原点为球心的单位球上。只影响"相邻断面间距 > 200 m"的扫掠，
       而这类只有 `strut` 的两点长杆：斜拉桥主跨索长 239 m，中间那一环直接
       塌到地标原点（轨面下 12 m、线路中心线上），于是每根主跨索都变成
       "从原点射向塔顶"的一根巨型尖刺，穿过桥面一直扎到江面以下。
       跨江截图里"斜索插进水里"和 test-shot 新加的河床判据抓到的 48 个三角形，
       全是这一个 norm3。 */
    const nrm3 = (a, c, t) => SH.Geo.norm3(lerp3(a, c, t));
    const dense = [];
    for (let j = 0; j < path.length; j++) {
      const fr = path[j];
      if (j === 0) { dense.push(fr); continue; }
      const pv = path[j - 1];
      const d = Math.hypot(fr.p[0] - pv.p[0], fr.p[1] - pv.p[1], fr.p[2] - pv.p[2]);
      const nn = Math.max(1, Math.ceil(d / 200));
      for (let i = 1; i < nn; i++) {
        const t = i / nn;
        dense.push({ p: lerp3(pv.p, fr.p, t), r: nrm3(pv.r, fr.r, t), u: nrm3(pv.u, fr.u, t), f: nrm3(pv.f, fr.f, t), s: pv.s + (fr.s - pv.s) * t });
      }
      dense.push(fr);
    }
    for (let j = 0; j < dense.length; j += step) frames.push(dense[j]);
    if (frames[frames.length - 1] !== dense[dense.length - 1]) frames.push(dense[dense.length - 1]);

    for (let j = 0; j < frames.length; j++) {
      const fr = frames[j];
      for (let i = 0; i < P; i++) {
        const q = prof[i];
        const x = fr.p[0] + fr.r[0] * q.x + fr.u[0] * q.y;
        const y = fr.p[1] + fr.r[1] * q.x + fr.u[1] * q.y;
        const z = fr.p[2] + fr.r[2] * q.x + fr.u[2] * q.y;
        const nx = fr.r[0] * q.nx + fr.u[0] * q.ny, ny = fr.r[1] * q.nx + fr.u[1] * q.ny, nz = fr.r[2] * q.nx + fr.u[2] * q.ny;
        const col = opts.colorFn ? opts.colorFn(fr.s, i, j, opts.color) : opts.color;
        const emi = opts.emiFn ? opts.emiFn(fr.s, i, j) : opts.emi;
        this.vtx(b, x, y, z, nx, ny, nz, fr.s * uScale, (cum[i] / (per || 1)) * vSpan, col, emi);
      }
    }
    const stride = P;
    /* 环绕索引必须按环取模，不能写 a+1 / c+1：
     * 当 i = P-1（封闭截面的接缝那一格）时，a+1 会跨到**下一环**的第 0 个点，
     * c+1 再跨一环，于是这一格变成自交的四边形，最后一环的 c+1 干脆越界，
     * 读到同一个 bucket 里**下一个物体**的顶点 —— 实测在 1 km 外的轨道端头
     * 生成一条横跨整段隧道的退化长条三角形，画面上就是切过天空的一片"膜"。
     * 每条 closed 扫掠（钢轨、隧道管、车体、导管…）都会中招，且只有最后一环
     * 越界，所以之前一直被认为"看起来正常"。 */
    for (let j = 0; j < frames.length - 1; j++) {
      const r0 = base + j * stride, r1 = r0 + stride;
      const f0 = frames[j], f1 = frames[j + 1];
      for (let i = 0; i < (closed ? P : P - 1); i++) {
        const i2 = (i + 1) % P;
        const a = r0 + i, b2 = r0 + i2, c = r1 + i, d = r1 + i2;
        /* 绕序要跟着截面上给定的法向走。GL 的背面剔除只看绕序，所以
           "法向对、绕序反"的那一面**根本不是变暗，而是从那一侧彻底消失**——
           站台板顶面（granite）之前就是这样被剔掉的：站台看起来是一块黑洞、
           人飘在上面的暗处，烘焙灯也因为这个面的 ndl<=0 而被整条丢掉。
           显式传了 flip 的调用（隧道衬砌、街面扫掠）保持它们原来的选择不变。 */
        let use = !!opts.flip;
        if (opts.flip == null) {
          const q0 = prof[i], q1 = prof[i2];
          const A = [f0.p[0] + f0.r[0] * q0.x + f0.u[0] * q0.y, f0.p[1] + f0.r[1] * q0.x + f0.u[1] * q0.y, f0.p[2] + f0.r[2] * q0.x + f0.u[2] * q0.y];
          const B = [f0.p[0] + f0.r[0] * q1.x + f0.u[0] * q1.y, f0.p[1] + f0.r[1] * q1.x + f0.u[1] * q1.y, f0.p[2] + f0.r[2] * q1.x + f0.u[2] * q1.y];
          const D = [f1.p[0] + f0.r[0] * q1.x + f0.u[0] * q1.y, f1.p[1] + f0.r[1] * q1.x + f0.u[1] * q1.y, f1.p[2] + f0.r[2] * q1.x + f0.u[2] * q1.y];
          const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
          const gx = e1[1] * e2[2] - e1[2] * e2[1], gy = e1[2] * e2[0] - e1[0] * e2[2], gz = e1[0] * e2[1] - e1[1] * e2[0];
          let nx = 0, ny = 0, nz = 0;
          for (let k = 0; k < 2; k++) {
            const q = k ? q1 : q0, fr = k ? f1 : f0;
            nx += fr.r[0] * q.nx + fr.u[0] * q.ny; ny += fr.r[1] * q.nx + fr.u[1] * q.ny; nz += fr.r[2] * q.nx + fr.u[2] * q.ny;
          }
          use = (gx * nx + gy * ny + gz * nz) < 0;
        }
        if (use) this.quad(b, a, c, d, b2);
        else this.quad(b, a, b2, d, c);
      }
    }
    if (opts.capStart) this._capSweep(b, frames[0], prof, opts, false);
    if (opts.capEnd) this._capSweep(b, frames[frames.length - 1], prof, opts, true);
    return this;
  }
  /** 扫掠体端面（扇形填充） */
  _capSweep(b, fr, prof, opts, end) {
    const f = fr.f, nrm = end ? [f[0], f[1], f[2]] : [-f[0], -f[1], -f[2]];
    const ci = this.vtx(b, fr.p[0], fr.p[1], fr.p[2], nrm[0], nrm[1], nrm[2], .5, .5, opts.capColor || opts.color, opts.emi);
    const ring = b.n;
    for (let i = 0; i < prof.length; i++) {
      const q = prof[i];
      this.vtx(b, fr.p[0] + fr.r[0] * q.x + fr.u[0] * q.y, fr.p[1] + fr.r[1] * q.x + fr.u[1] * q.y, fr.p[2] + fr.r[2] * q.x + fr.u[2] * q.y,
        nrm[0], nrm[1], nrm[2], .5 + q.x * .2, .5 + q.y * .2, opts.capColor || opts.color, opts.emi);
    }
    for (let i = 0; i < prof.length - 1; i++) {
      if (end) this.tri(b, ci, ring + i, ring + i + 1); else this.tri(b, ci, ring + i + 1, ring + i);
    }
    this.tri(b, ci, ring + prof.length - 1, ring + 0);
  }

  /**
   * 放样：路径每个站点对应一个**不同**的截面（车头鼻部、隧道口渐变）。
   * @param path  [{p,r,u,f,s}]，长度须与 profiles 一致
   * @param profiles  每个站点的截面点数组
   */
  loft(path, profiles, opts) {
    opts = opts || {};
    const b = this._bucket(opts.mat || 'body');
    const n = Math.min(path.length, profiles.length);
    if (n < 2) return this;
    const P = profiles[0].length;
    const base = b.n;
    for (let j = 0; j < n; j++) {
      const fr = path[j], prof = profiles[j];
      for (let i = 0; i < P; i++) {
        const q = prof[i] || prof[prof.length - 1];
        const x = fr.p[0] + fr.r[0] * q.x + fr.u[0] * q.y;
        const y = fr.p[1] + fr.r[1] * q.x + fr.u[1] * q.y;
        const z = fr.p[2] + fr.r[2] * q.x + fr.u[2] * q.y;
        const nx = fr.r[0] * q.nx + fr.u[0] * q.ny, ny = fr.r[1] * q.nx + fr.u[1] * q.ny, nz = fr.r[2] * q.nx + fr.u[2] * q.ny;
        const col = opts.colorFn ? opts.colorFn(j, i, opts.color) : opts.color;
        this.vtx(b, x, y, z, nx, ny, nz, i / P, j / (n - 1), col, opts.emi);
      }
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < P; i++) {
      // 同 sweep：接缝那一格必须按环取模，不能让 a+1 跨环
      const i2 = (i + 1) % P;
      const a = base + j * P + i, b2 = base + j * P + i2;
      const c = base + (j + 1) * P + i, d = base + (j + 1) * P + i2;
      if (opts.flip) this.quad(b, a, c, d, b2); else this.quad(b, a, b2, d, c);
    }
    if (opts.capEnd) {
      const fr = path[n - 1], prof = profiles[n - 1];
      const ci = this.vtx(b, fr.p[0] + fr.r[0] * 0 + fr.u[0] * 0, fr.p[1], fr.p[2] + fr.f[2] * 0, fr.f[0], fr.f[1], fr.f[2], .5, .5, opts.capColor || opts.color, opts.emi);
      const ring = b.n;
      for (let i = 0; i < P; i++) {
        const q = prof[i];
        this.vtx(b, fr.p[0] + fr.r[0] * q.x + fr.u[0] * q.y, fr.p[1] + fr.r[1] * q.x + fr.u[1] * q.y, fr.p[2] + fr.r[2] * q.x + fr.u[2] * q.y, fr.f[0], fr.f[1], fr.f[2], .5, .5, opts.capColor || opts.color, opts.emi);
      }
      for (let i = 0; i < P - 1; i++) this.tri(b, ci, ring + i, ring + i + 1);
      this.tri(b, ci, ring + P - 1, ring);
    }
    return this;
  }

  /** 多边形沿 Y 拉伸（异形柱、花坛、设备基座） */
  prism(pts2, y0, y1, color, opts) {
    opts = opts || {};
    const b = this._bucket(opts.mat || 'concrete');
    const n = pts2.length;
    for (let i = 0; i < n; i++) {
      const a = pts2[i], c = pts2[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz) || 1;
      const nx = dz / L, nz = -dx / L;
      const q = [
        [a[0], y0, a[1]], [c[0], y0, c[1]], [c[0], y1, c[1]], [a[0], y1, a[1]],
      ];
      const uv = [[0, 0], [L, 0], [L, y1 - y0], [0, y1 - y0]];
      this.quadPts(q[0], q[1], q[2], q[3], color, { mat: opts.mat, normal: [nx, 0, nz], uv, emi: opts.emi });
    }
    if (opts.caps !== false) {
      for (let s = 0; s < 2; s++) {
        const y = s ? y1 : y0, ny = s ? 1 : -1;
        const cx = pts2.reduce((t, p) => t + p[0], 0) / n, cz = pts2.reduce((t, p) => t + p[1], 0) / n;
        const ci = this.vtx(b, cx, y, cz, 0, ny, 0, .5, .5, opts.capColor || color, opts.emi);
        const ring = b.n;
        for (let i = 0; i < n; i++) this.vtx(b, pts2[i][0], y, pts2[i][1], 0, ny, 0, .5, .5, opts.capColor || color, opts.emi);
        for (let i = 0; i < n; i++) { if (s) this.tri(b, ci, ring + i, ring + (i + 1) % n); else this.tri(b, ci, ring + (i + 1) % n, ring + i); }
      }
    }
    return this;
  }

  /**
   * 贴图集单块面板（站名标、广告、导向牌、窗户贴图）。
   * UV 由图集矩形给出，材质固定用 sign 图集。
   */
  panel(center, ax, ay, normal, rect, tint, emi, mat) {
    const b = this._bucket(mat || 'sign');
    // 三个分量都要各减 ax/2 与 ay/2。原来 z 分量漏了 ax/2：只要 ax 带 z 分量
    // （沿 z 铺的水面、曲线上的牌面），整个板就沿 z 偏移半个边长。
    const c0 = [center[0] - ax[0] / 2 - ay[0] / 2, center[1] - ax[1] / 2 - ay[1] / 2,
      center[2] - ax[2] / 2 - ay[2] / 2];
    const P = (du, dv) => [c0[0] + ax[0] * du + ay[0] * dv, c0[1] + ax[1] * du + ay[1] * dv, c0[2] + ax[2] * du + ay[2] * dv];
    const cv = cross(ax, ay);
    const flipped = cv[0] * normal[0] + cv[1] * normal[1] + cv[2] * normal[2] < 0;
    /* 修好上下之后还剩一个**左右镜像**的坑：
       贴图 u 是跟着 ax 走的，而牌子真正被看见的那一面是 `normal` 指向的那面。
       若 cross(ax, ay) 与 normal 反向，说明 (ax, ay) 相对观察者构成左手系，
       从 normal 那侧看过去整张图就是左右反的 —— 司机台 TCMS 的 "TCMS READY"
       在截图里读作 "YДӘЯT SMCT" 就是这么来的。
       所以 u 也要跟着翻。站名牌一类不会受影响：它们靠 `ax` 上带 `side` 符号
       已经把 cross(ax,ay) 转到与法向同侧了，翻不翻都一样。 */
    const u = v => flipped ? rect[2] - (rect[2] - rect[0]) * v : rect[0] + (rect[2] - rect[0]) * v;
    /* 图集的 v 是从**画布顶部**往下量的（`SignAtlas.add` 存的是 canvas 坐标，
       而 `texFromCanvas` 显式关掉了 UNPACK_FLIP_Y）。面板的 dv=1 是 ay 的正方向，
       也就是牌子的"上沿"，所以必须映射到格子的**顶边** rect[1]。
       原来写成 `rect[1] + (rect[3]-rect[1]) * dv`，等于把每一块牌子都上下颠倒：
       站名标、导向牌、广告灯箱、车头目的地屏、司机台 TCMS 全部中招。
       中文 + 远景 + 半透灯箱让这件事在截图里极难看出来，直到把 TCMS 拍到
       1.6 m 的近景才发现整屏字都是倒的。 */
    const w = v => rect[1] + (rect[3] - rect[1]) * (1 - v);
    const i0 = this.vtx(b, ...P(0, 0), normal[0], normal[1], normal[2], u(0), w(0), tint, emi);
    const i1 = this.vtx(b, ...P(1, 0), normal[0], normal[1], normal[2], u(1), w(0), tint, emi);
    const i2 = this.vtx(b, ...P(1, 1), normal[0], normal[1], normal[2], u(1), w(1), tint, emi);
    const i3 = this.vtx(b, ...P(0, 1), normal[0], normal[1], normal[2], u(0), w(1), tint, emi);
    /* 与 plate 同一条规则：绕序要跟着给定的法向。牌面是单面的（sign 参与背面剔除），
       法向朝观众而绕序朝反面的话，整块站名牌就是看不见的。 */
    if (flipped) this.quad(b, i0, i3, i2, i1);
    else this.quad(b, i0, i1, i2, i3);
    return this;
  }

  /**
   * UV 球体。东方明珠的三颗球体、水塔、储气罐都要靠它。
   * @param center 球心 @param r 半径（可传 [rx,ry,rz] 做椭球）
   * @param opts {mat, color, emi, segU, segV, top, bottom}
   */
  sphere(center, r, opts) {
    opts = opts || {};
    const b = this._bucket(opts.mat || 'paint');
    const rx = Array.isArray(r) ? r[0] : r, ry = Array.isArray(r) ? r[1] : r, rz = Array.isArray(r) ? r[2] : r;
    const su = opts.segU || 18, sv = opts.segV || 10;
    const t0 = opts.top == null ? 0 : opts.top, t1 = opts.bottom == null ? 1 : opts.bottom;
    const base = b.n;
    for (let j = 0; j <= sv; j++) {
      const tv = t0 + (t1 - t0) * j / sv, phi = Math.PI * tv;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let i = 0; i <= su; i++) {
        const th = i / su * Math.PI * 2, st = Math.sin(th), ct = Math.cos(th);
        const nx = sp * ct, ny = cp, nz = sp * st;
        this.vtx(b, center[0] + rx * nx, center[1] + ry * ny, center[2] + rz * nz,
          nx / rx, ny / ry, nz / rz, i / su, tv, opts.color, opts.emi);
      }
    }
    for (let j = 0; j < sv; j++) for (let i = 0; i < su; i++) {
      const a = base + j * (su + 1) + i, c = a + su + 1;
      this.quad(b, a, a + 1, c + 1, c);
    }
    return this;
  }

  /**
   * 塔用锥形环带：把一组不同半径的圆环按高度堆起来，每环可带偏心。
   * 上海中心的扭转轮廓、金茂的分段收分都走这个。
   * @param rings [{y, rx, rz, cx, cz, twist}]
   */
  ringStack(mat, rings, color, opts) {
    opts = opts || {};
    const b = this._bucket(mat);
    const seg = opts.seg || 12, base = b.n;
    /* UV 必须是"真实尺度"的：u 取沿周长的弧长、v 取高度，两者都乘以
     * 每米的贴图循环数（SH.FACADE_UV）。原来 u = i/seg，等于把一整圈
     * 塞进一个贴图循环 —— 60 m 直径的塔楼一圈 190 m 只有 8 格窗，
     * 窗宽 24 m；而纵向用的是另一套尺度，横竖完全脱钩。
     * 现在横竖同尺度，窗格尺寸在所有几何上都是同一个物理量。 */
    const uvY = opts.uvY == null ? SH.FACADE_UV : opts.uvY;
    const uvX = opts.uvX == null ? uvY : opts.uvX;
    for (let j = 0; j < rings.length; j++) {
      const rg = rings[j], tw = rg.twist || 0;
      const per = Math.PI * (rg.rx + rg.rz);          // 椭圆周长的 good approximation
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2 + tw;
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = (rg.cx || 0) + rg.rx * ca, z = (rg.cz || 0) + rg.rz * sa;
        // 法向近似取水平外法向
        this.vtx(b, x, rg.y, z, ca / rg.rx, 0.12, sa / rg.rz, (i / seg) * per * uvX, rg.y * uvY, color, opts.emi);
      }
    }
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, c = a + seg + 1;
      /* 与 cylY 同一个坑：(a, a+1, c+1, c) 的几何法向是径向朝内的，
       * 而顶点法向给的是水平外法向 —— 于是塔楼的筒身从外面看被整个剔除，
       * 东方明珠/金茂/上海中心只剩一个"从里往外看"才存在的壳子。
       * 改成 (a, c, c+1, a+1) 才与外法向一致。 */
      this.quad(b, a, c, c + 1, a + 1);
    }
    if (opts.capTop) {
      // 顶盖同样用"世界坐标 × 每米循环数"的平面 UV，与侧面尺度一致
      const rg = rings[rings.length - 1];
      const cxw = rg.cx || 0, czw = rg.cz || 0;
      const ci = this.vtx(b, cxw, rg.y, czw, 0, 1, 0, cxw * uvX, czw * uvX, color, opts.emi);
      const ring = b.n;
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2 + (rg.twist || 0);
        const px = cxw + rg.rx * Math.cos(a), pz = czw + rg.rz * Math.sin(a);
        this.vtx(b, px, rg.y, pz, 0, 1, 0, px * uvX, pz * uvX, color, opts.emi);
      }
      for (let i = 0; i < seg; i++) this.tri(b, ci, ring + i + 1, ring + i);
    }
    return this;
  }

  /* ------------------------------------------------------------- 合并子网格 */
  /**
   * 把另一个 Builder 的结果用 4x4 矩阵变换后并入。
   * 用于"造一台车，放到很多位置"、"造一栋楼，摆满城市"。
   */
  merge(sub, m4, nmat, matOverride) {
    /* 也接受已经 finish() 过的网格（单个或数组）。测试里要"把产品画的那些东西
       搬到世界里再光栅化"，手上只有 finish() 的结果，不该为此再抄一份变换。 */
    const groups = sub && sub.pos ? [sub] : (Array.isArray(sub) ? sub : sub.finish());
    for (const g of groups) {
      const b = this._bucket(matOverride || g.mat);
      const map = (x, y, z) => [
        m4[0] * x + m4[4] * y + m4[8] * z + m4[12],
        m4[1] * x + m4[5] * y + m4[9] * z + m4[13],
        m4[2] * x + m4[6] * y + m4[10] * z + m4[14]];
      const nmap = (x, y, z) => nmat ? [
        nmat[0] * x + nmat[3] * y + nmat[6] * z,
        nmat[1] * x + nmat[4] * y + nmat[7] * z,
        nmat[2] * x + nmat[5] * y + nmat[8] * z] : [x, y, z];
      const base = b.n;
      for (let i = 0; i < g.verts; i++) {
        const p = map(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
        const rawN = [g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]];
        const nn = nmap(rawN[0], rawN[1], rawN[2]);
        const n2 = norm3(nn);
        const col = [g.col[i * 3] / 255, g.col[i * 3 + 1] / 255, g.col[i * 3 + 2] / 255];
        this.vtx(b, p[0], p[1], p[2], n2[0], n2[1], n2[2], g.uv[i * 2], g.uv[i * 2 + 1], col, g.emi[i]);
      }
      for (let k = 0; k < g.idx.length; k++) b.idx.push(base + g.idx[k]);
    }
    return this;
  }

  /* --------------------------------------------------------------- 输出 */
  /**
   * 生成可上传的几何数组。超过 65535 顶点的桶自动分片，
   * 这样不需要 OES_element_index_uint，老设备也能跑。
   */
  finish() {
    const out = [];
    const MAXV = 65000;                       // 留余量：Uint16 索引上限 65535
    for (const b of this.buckets.values()) {
      if (!b.idx.length) continue;
      if (b.n <= MAXV) { out.push(this._pack(b, b.idx, 0, b.n)); continue; }

      /* 贪心分片：一次遍历三角形，同时收集本片的顶点与索引。
       *
       * 这里原来是一段"先重映射、再按片回填顶点"的两段式实现，两个致命错误：
       *   1) `for (const v of tri) tri[tri.indexOf(v)] = ensure(v)` 边遍历边改写
       *      同一个数组，indexOf 会命中刚被改过的槽位，三个索引互相串位；
       *   2) 第一遍写进 chunk 的已经是"片内新编号"，第二遍又拿它当原始顶点号
       *      去查 b.pos[]，等于把整个桶的索引重排了一遍。
       * 结果就是横跨整条线路的巨型瘦三角形——屏幕上表现为一张切过天空的膜，
       * 而且只有顶点数超过 65000 的长线路才会触发，所以短线路看起来一切正常。
       */
      const remap = new Int32Array(b.n);      // 顶点 → 当前片内的新编号
      const stamp = new Int32Array(b.n);      // 该片编号世代号，等于 gen 才算属于本片
      let gen = 1;
      let ch = { pos: [], nrm: [], uv: [], col: [], emi: [], idx: [], n: 0 };
      const ensure = (vi) => {
        if (stamp[vi] === gen) return remap[vi];
        stamp[vi] = gen; remap[vi] = ch.n;
        const p = vi * 3, q = vi * 2;
        ch.pos.push(b.pos[p], b.pos[p + 1], b.pos[p + 2]);
        ch.nrm.push(b.nrm[p], b.nrm[p + 1], b.nrm[p + 2]);
        ch.uv.push(b.uv[q], b.uv[q + 1]);
        ch.col.push(b.col[p], b.col[p + 1], b.col[p + 2]);
        ch.emi.push(b.emi[vi]);
        return ch.n++;
      };
      const flush = () => {
        if (ch.idx.length) out.push(this._packRaw(b.mat, ch.pos, ch.nrm, ch.uv, ch.col, ch.emi, ch.idx, ch.n));
        gen++;
        ch = { pos: [], nrm: [], uv: [], col: [], emi: [], idx: [], n: 0 };
      };
      for (let t = 0; t < b.idx.length; t += 3) {
        const v0 = b.idx[t], v1 = b.idx[t + 1], v2 = b.idx[t + 2];
        let add = 0;
        if (stamp[v0] !== gen) add++;
        if (stamp[v1] !== gen) add++;
        if (stamp[v2] !== gen) add++;
        if (ch.n + add > MAXV) flush();       // 装不下就先落盘，保证三角形不被拆开
        ch.idx.push(ensure(v0), ensure(v1), ensure(v2));
      }
      flush();
    }
    this.buckets.clear();
    return out;
  }
  _pack(b, idx, from, n) { return this._packRaw(b.mat, b.pos, b.nrm, b.uv, b.col, b.emi, idx, n); }
  _packRaw(mat, pos, nrm, uv, col, emi, idx, n) {
    return {
      mat,
      pos: pos instanceof Float32Array ? pos : Float32Array.from(pos),
      nrm: nrm instanceof Float32Array ? nrm : Float32Array.from(nrm),
      uv: uv instanceof Float32Array ? uv : Float32Array.from(uv),
      col: col instanceof Uint8Array ? col : Uint8Array.from(col.map(x => clamp(x, 0, 1) * 255)),
      emi: emi instanceof Uint8Array ? emi : Uint8Array.from(emi.map(x => clamp(x / 2.5, 0, 1) * 255)),
      idx: Uint16Array.from(idx),
      verts: n, count: idx.length,
    };
  }
  get vertexCount() { let t = 0; for (const b of this.buckets.values()) t += b.n; return t; }
}

/* ------------------------------------------------------- 截面生成器（返回 prof 数组） */
/**
 * 鼓形圆角矩形截面 —— 地铁车体轮廓。
 * 顺序为逆时针（x 右、y 上），法向朝外；sweep 默认不翻转即可得到朝外的面。
 * @param w 半宽 @param y0 地板面高 @param y1 车顶高
 * @param rBot 底部圆角 @param rTop 顶部圆角 @param seg 圆角分段
 * @param bulge 腰部外凸比例（0.02 ≈ 鼓形车体）
 */
function roundedProfile(w, y0, y1, rBot, rTop, seg, bulge) {
  seg = seg || 5;
  const rb = Math.min(rBot || 0.12, w * 0.8, (y1 - y0) * 0.3);
  const rt = Math.min(rTop || 0.35, w * 0.95, (y1 - y0) * 0.45);
  const pts = [];
  const add = (x, y, nx, ny) => pts.push({ x, y, nx, ny });
  const arc = (cx, cy, r, a0, a1) => {
    for (let i = 0; i < seg; i++) {
      const a = a0 + (a1 - a0) * i / seg;
      add(cx + r * Math.cos(a), cy + r * Math.sin(a), Math.cos(a), Math.sin(a));
    }
  };
  const yA = y0 + rb, yB = y1 - rt;
  arc(w - rb, y0 + rb, rb, -Math.PI / 2, 0);            // 右下角
  if (bulge) {                                          // 右侧鼓形
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      add(w + bulge * w * Math.sin(Math.PI * t), yA + (yB - yA) * t, 1, 0.12);
    }
  }
  add(w, yB, 1, 0);
  arc(w - rt, y1 - rt, rt, 0, Math.PI / 2);             // 右上角
  add(-w + rt, y1, 0, 1);                               // 车顶
  arc(-w + rt, y1 - rt, rt, Math.PI / 2, Math.PI);      // 左上角
  if (bulge) {
    for (let i = 3; i >= 1; i--) {
      const t = i / 4;
      add(-w - bulge * w * Math.sin(Math.PI * t), yA + (yB - yA) * t, -1, 0.12);
    }
  }
  add(-w, yA, -1, 0);
  arc(-w + rb, y0 + rb, rb, Math.PI, Math.PI * 1.5);    // 左下角
  add(0, y0, 0, -1);                                    // 地板
  return pts;
}

/**
 * 车壳剖分段（两条**开放**多段线）。
 *
 * 为什么要有它：车体原来是 `roundedProfile` 的**闭合环**整圈扫掠，侧壁是连续几何。
 * 于是车窗后面紧贴着侧壁 —— 从站台上透过车窗看进去，第一眼撞上的是一块不透明的
 * 侧壁，"车厢里是黑的"，而这不是贴图问题，是**壳上根本没有洞**。
 *
 * 真车的侧壁在窗带高度是空的（玻璃 + 窗框 + 窗台压条三件套），
 * 所以这里把整圈按窗带 [yLo, yHi] 剖成上下两段：
 *   lower：窗台以下的侧壁 + 车底（底板 + 裙板 + 转向架舱）
 *   upper：窗楣以上的侧壁 + 车顶
 * 两条多段线在窗带两端**共用同一个点**（x = ±w, y = yLo / yHi），
 * 于是壳体除了窗带以外处处封闭，窗带是一条真正的纵向开口。
 *
 * 鼓形腰沿侧壁的高度分布保留（`bulge·w·sin(πt)`，t 从窗台高度到车顶），
 * 所以"鼓形截面"这条卖点没有被这次改动削掉。
 *
 * @returns {lower, upper} 两条开放多段线（点序与 roundedProfile 同向：右侧在前）
 */
function shellSplit(w, y0, y1, rBot, rTop, seg, bulge, yLo, yHi) {
  const rb = Math.min(rBot || 0.12, w * 0.8, (y1 - y0) * 0.3);
  const rt = Math.min(rTop || 0.35, w * 0.95, (y1 - y0) * 0.45);
  const yA = y0 + rb, yB = y1 - rt;
  // 窗带必须落在竖直侧壁段内，否则剖出来的开口会啃掉车顶圆角
  const lo = Math.min(Math.max(yLo, yA + 1e-3), yB - 1e-3);
  const hi = Math.min(Math.max(yHi, lo + 0.05), yB - 1e-3);
  const span = yB - yA || 1;
  /* 侧壁鼓形：与 roundedProfile 同式，但 t 的定义域换成"窗台→车顶"，
     于是上下两段各自在自己的高度区间里采样，鼓形曲线在开口两端仍然连续。 */
  const bl = t => (bulge || 0) * w * Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
  const vert = (out, sign, yFrom, yTo, up) => {
    // 沿竖直侧壁采样：up=true 表示往上走（法向 (sign,0)），false 表示往下走
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = yFrom + (yTo - yFrom) * t;
      out.push({ x: sign * (w + bl((y - yA) / span)), y, nx: sign, ny: up ? 0 : 0 });
    }
  };
  const lower = [], upper = [];
  /* ---- lower：右侧窗台 → 右侧壁 → 右下圆角 → 底板 → 左下圆角 → 左壁 → 左侧窗台 ---- */
  vert(lower, 1, lo, yA, true);
  {
    for (let i = 1; i <= seg; i++) {
      const a = -Math.PI / 2 * (1 - i / seg);          // 0 → −π/2
      lower.push({ x: (w - rb) + rb * Math.cos(a), y: y0 + rb + rb * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  lower.push({ x: 0, y: y0, nx: 0, ny: -1 });
  {
    for (let i = 1; i <= seg; i++) {
      const a = Math.PI + Math.PI / 2 * (i / seg);    // π → 3π/2
      lower.push({ x: (-w + rb) + rb * Math.cos(a), y: y0 + rb + rb * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  vert(lower, -1, yA, lo, true);
  /* ---- upper：右侧窗楣 → 右壁 → 右上圆角 → 车顶 → 左上圆角 → 左壁 → 左侧窗楣 ---- */
  vert(upper, 1, hi, yB, true);
  {
    for (let i = 1; i <= seg; i++) {
      const a = Math.PI / 2 * (i / seg);              // 0 → π/2
      upper.push({ x: (w - rt) + rt * Math.cos(a), y: (y1 - rt) + rt * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  upper.push({ x: -w + rt, y: y1, nx: 0, ny: 1 });
  {
    for (let i = 1; i <= seg; i++) {
      const a = Math.PI / 2 + Math.PI / 2 * (i / seg); // π/2 → π
      upper.push({ x: (-w + rt) + rt * Math.cos(a), y: (y1 - rt) + rt * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  vert(upper, -1, yB, hi, true);
  return { lower: dedupe(lower), upper: dedupe(upper), yLo: lo, yHi: hi, yA, yB };
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 1e-4 && Math.abs(q.y - p.y) < 1e-4) continue;
    out.push(p);
  }
  return out;
}
/**
 * 给一个**闭合多边形截面**算出正确的顶点法向：
 * 每条边的外法向 = normalize(-dy, dx)（点序为顺时针时成立，本仓库手写截面都是这个顺序），
 * 每个顶点取相邻两条边的法向平均（miter）。
 * 这样每条边两端法向的平均值就等于这条边自己的外法向 ——
 * `sweep` 的绕序自动判定和烘焙光照的 n·l 同时成立。
 * 手写截面最容易犯的错就是"整块板给一个法向"或"角点法向随手填"，
 * 后果是某些边两端法向抵消成零向量：绕序没人裁决、灯光永远算不出来。
 */
function miter(pts) {
  const n = pts.length, out = [];
  const edgeN = i => {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dy, -dx) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i], ePrev = edgeN((i - 1 + n) % n), eNext = edgeN(i);
    let nx = ePrev[0] + eNext[0], ny = ePrev[1] + eNext[1];
    const l = Math.hypot(nx, ny) || 1;
    out.push({ x: p.x, y: p.y, nx: nx / l, ny: ny / l });
  }
  return out;
}
/**
 * 矩形闭合截面（梁、门头、支架、色带这类薄板）。
 * 顶点法向取**相邻两边的角平分线**（miter），这样每条边两端法向的平均值
 * 正好等于这条边自己的外法向：绕序自动判定有依据、烘焙光照 n·l 也算得对。
 * 以前这类截面四个角各给一个"整块板"的法向（比如全给 (0,1)），
 * 于是左右两条边的两端法向互相抵消成零向量——屏蔽门门头梁/线路色带
 * 就是这么攒出上千个"绕序与法向相反"的三角形的。
 */
function rectProfile(x0, y0, x1, y1) {
  /* 点序必须是顺时针（顶边向右），miter 的 outward=(-dy,dx) 才成立。 */
  return miter([
    { x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }, { x: x0, y: y0 },
  ]);
}
/** 圆形截面（盾构隧道内壁） */function circleProfile(r, seg, yOff) {
  seg = seg || 24;
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = i / seg * Math.PI * 2;
    pts.push({ x: r * Math.cos(a), y: (yOff || 0) + r * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  return pts;
}
/** 马蹄形截面（盾构+底板，最常见的地铁隧道断面） */
function horseshoeProfile(r, wallH, seg) {
  seg = seg || 22;
  const pts = [];
  // 从左下角起，逆时针：底 → 右墙 → 拱
  pts.push({ x: -r, y: 0, nx: 0, ny: -1 });
  pts.push({ x: r, y: 0, nx: 0, ny: -1 });
  pts.push({ x: r, y: wallH, nx: 1, ny: 0 });
  for (let i = 0; i <= seg; i++) {
    const a = -0.05 + (Math.PI + 0.1) * i / seg;
    pts.push({ x: r * Math.cos(a) * 0.98, y: wallH + r * Math.sin(a) * 0.92, nx: Math.cos(a), ny: Math.sin(a) });
  }
  pts.push({ x: -r, y: wallH, nx: -1, ny: 0 });
  return dedupe(pts);
}
/** 矩形箱涵截面（车站段） */
function boxProfile(w, h) {
  return [
    { x: -w, y: 0, nx: 0, ny: -1 }, { x: w, y: 0, nx: 0, ny: -1 },
    { x: w, y: h, nx: 1, ny: 0 }, { x: w * 0.92, y: h, nx: 0.5, ny: 0.86 },
    { x: 0, y: h, nx: 0, ny: 1 }, { x: -w * 0.92, y: h, nx: -0.5, ny: 0.86 },
    { x: -w, y: h, nx: -1, ny: 0 }, { x: -w, y: 0, nx: -1, ny: 0 },
  ];
}
/** 钢轨截面（简化工字轨） */
function railProfile(h, w) {
  h = h || 0.172; w = w || 0.071;
  return [
    { x: -w * 1.5, y: 0, nx: 0, ny: -1 }, { x: w * 1.5, y: 0, nx: 0, ny: -1 },
    { x: w * 1.5, y: h * 0.12, nx: 1, ny: 0 }, { x: w * 0.45, y: h * 0.22, nx: 1, ny: 0.2 },
    { x: w * 0.45, y: h * 0.78, nx: 0.6, ny: -0.2 }, { x: w * 1.1, y: h * 0.9, nx: 1, ny: 0.3 },
    { x: w * 1.1, y: h, nx: 0, ny: 1 }, { x: -w * 1.1, y: h, nx: -1, ny: 0.3 },
    { x: -w * 1.1, y: h * 0.9, nx: -1, ny: 0.3 }, { x: -w * 0.45, y: h * 0.78, nx: -0.6, ny: -0.2 },
    { x: -w * 0.45, y: h * 0.22, nx: -1, ny: 0.2 }, { x: -w * 1.5, y: h * 0.12, nx: -1, ny: 0 },
  ];
}
/** 接触网/第三轨防护罩 */
function coverProfile(w, h) {
  return [
    { x: -w, y: 0, nx: 0, ny: -1 }, { x: w, y: 0, nx: 0, ny: -1 },
    { x: w, y: h * 0.7, nx: 1, ny: 0 }, { x: w * 0.5, y: h, nx: 0.4, ny: 0.9 },
    { x: -w * 0.5, y: h, nx: -0.4, ny: 0.9 }, { x: -w, y: h * 0.7, nx: -1, ny: 0 },
  ];
}

SH.Builder = Builder;
SH.Geo = { roundedProfile, shellSplit, circleProfile, horseshoeProfile, boxProfile, rectProfile, miter, railProfile, coverProfile, addv, cross, norm3 };

})(typeof window !== 'undefined' ? window : globalThis);
