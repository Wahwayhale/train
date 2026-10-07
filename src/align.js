/* ============================================================================
 * align.js — 轨道中线（平面线形 + 纵断面 + 超高）
 *
 * 南京版整条线是一条直线：车不会侧倾、隧道不会弯、外景视角一眼假。
 * 这里做真正的铁路线形：
 *   · 平面：直线—圆曲线—直线 交替，站台永远设在直线上（真实设计规范）
 *   · 纵断面：坡度控制点 + 线性插值 + 积分查表。
 *     控制点之间坡度线性变化，本身就是一条抛物线竖曲线，
 *     而且平面与纵断面共用同一个里程轴，永远不会错位。
 *   · 超高：曲线按平衡速度外轨抬高，列车与相机随之侧倾
 *   · 曲线限速：V = sqrt(a_unbalanced·g·R)
 *
 * 约定：x 横向、y 竖直、z 前向；里程 s 沿中线累积；heading θ 从 +Z 转向 +X。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { rng, hash32 } = SH;
const { cross, norm3 } = SH.Geo;
const C = SH.clamp, L = SH.lerp;

class Alignment {
  constructor() {
    this.els = [];          // 平面元素 {t,s0,len,k,x0,z0,th0}
    this.total = 0;
    this.gp = [];           // 坡度控制点 {s,g}（g 为千分率）
    this.yTab = null;       // 高程查表
    this.gTab = null;
    this.res = 1;           // 查表分辨率（米）
    /* 未平衡横向加速度：地铁取 0.15~0.17 m/s²；市域/磁浮线不能沿用，
       否则 160 km/h 的线路会被合成曲线限速压到 60 km/h，永远跑不到设计速度。 */
    this.unbal = 0.16;
    this.stationS = [];
    this.stationName = [];
  }
  /* ------------------------------------------------------------ 平面拼装 */
  line(len) { return this._plan({ t: 'l', len, k: 0 }); }
  arc(len, r, dir) { return this._plan({ t: 'a', len, k: (dir || 1) / Math.max(80, r) }); }
  /**
   * 缓和曲线（clothoid）：曲率从 k0 线性变到 k1，弧长 len。
   *
   * 为什么必须有它：真实线路从来不是"直线直接贴圆曲线"。相切只保证方向连续，
   * 曲率仍然是 0 → 1/R 的**阶跃**，于是横向加速度 v²/R 在一瞬间全部加上，
   * 超高也来不及跟。玩家报的"拐弯瞬间抽搐一下"根子就在这里 —— 不是相机、
   * 不是贴图、不是物理积分，是线形少了一段。
   * 位置积分没有初等闭式（Fresnel），所以建元时按 1 m 步长做 Simpson 存表。
   */
  trans(len, k0, k1) { return this._plan({ t: 'e', len, k0, k: k1 }); }
  _clothoid(e) {
    const L = e.len, n = Math.max(2, Math.round(L)), k0 = e.k0, k1 = e.k, h = L / n;
    const tab = { step: h, n, x: new Float64Array(n + 1), z: new Float64Array(n + 1) };
    const th = u => k0 * u + (k1 - k0) * u * u / (2 * L);
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const u0 = i * h, um = u0 + h / 2, u1 = u0 + h;
      const a0 = e.th0 + th(u0), am = e.th0 + th(um), a1 = e.th0 + th(u1);
      x += h / 6 * (Math.sin(a0) + 4 * Math.sin(am) + Math.sin(a1));
      z += h / 6 * (Math.cos(a0) + 4 * Math.cos(am) + Math.cos(a1));
      tab.x[i + 1] = x; tab.z[i + 1] = z;
    }
    e.tab = tab;
  }
  _plan(e) {
    if (!(e.len > 0.01)) return this;
    const prev = this.els[this.els.length - 1];
    /* 缓和曲线绝不合并：它的表是按自己的长度与两端曲率积分出来的，
       合并成长度之后表就废了（而且 k0 会被悄悄改掉）。 */
    if (e.t !== 'e' && prev && prev.t === e.t && Math.abs(prev.k - e.k) < 1e-10) {
      prev.len += e.len;
    } else {
      const st = prev ? this._planAt(prev.s0 + prev.len) : { x: 0, z: 0, th: 0 };
      e.s0 = this.total; e.x0 = st.x; e.z0 = st.z; e.th0 = st.th;
      this.els.push(e);
    }
    this.total += e.len;
    return this;
  }
  /** 在里程 s 处钉一个坡度控制点 */
  gradeAt(s, g) {
    s = Math.max(0, s);
    const i = this.gp.findIndex(p => p.s > s + 1e-6);
    const p = { s, g };
    if (i < 0) this.gp.push(p); else this.gp.splice(i, 0, p);
    this.yTab = null;
    return this;
  }
  _find(els, s) {
    if (!els.length) return null;
    let lo = 0, hi = els.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (els[mid].s0 <= s) lo = mid; else hi = mid - 1; }
    return els[lo];
  }
  _planAt(s) {
    const e = this._find(this.els, s);
    if (!e) return { x: 0, z: 0, th: 0, k: 0 };
    const d = C(s - e.s0, 0, e.len);
    if (e.t === 'l') return { x: e.x0 + Math.sin(e.th0) * d, z: e.z0 + Math.cos(e.th0) * d, th: e.th0, k: 0 };
    if (e.t === 'e') {
      if (!e.tab) this._clothoid(e);
      const tb = e.tab, u = d / tb.step, i = Math.min(tb.n - 1, Math.floor(u)), f = u - i;
      return { x: e.x0 + L(tb.x[i], tb.x[i + 1], f), z: e.z0 + L(tb.z[i], tb.z[i + 1], f),
        th: e.th0 + e.k0 * d + (e.k - e.k0) * d * d / (2 * e.len),
        k: e.k0 + (e.k - e.k0) * d / e.len };
    }
    const k = e.k, th = e.th0 + k * d;
    return { x: e.x0 + (Math.cos(e.th0) - Math.cos(th)) / k, z: e.z0 + (Math.sin(th) - Math.sin(e.th0)) / k, th, k };
  }
  /* ------------------------------------------------------------ 纵断面查表 */
  build(res) {
    this.res = res || 1;
    const n = Math.ceil(this.total / this.res) + 2;
    const gT = this.gTab = new Float32Array(n);
    const yT = this.yTab = new Float32Array(n);
    const gp = this.gp.length ? this.gp : [{ s: 0, g: 0 }];
    if (gp[0].s > 0) gp.unshift({ s: 0, g: gp[0].g });
    let pi = 0;
    for (let i = 0; i < n; i++) {
      const s = i * this.res;
      while (pi < gp.length - 2 && gp[pi + 1].s < s) pi++;
      const a = gp[pi], b = gp[pi + 1] || a;
      const t = b.s > a.s ? C((s - a.s) / (b.s - a.s), 0, 1) : 0;
      gT[i] = L(a.g, b.g, t);
    }
    /* **水平段强制**：跨江/跨河窗口内的坡度直接写零。
       为什么不能只靠两端各钉一个 0‰ 控制点：下面那段"纵断面闭合"会为了把
       站间净高差归零而**改动区间内部的变坡点**，窗口里的坡度就被它又拉回来了
       （实测 3/6/17 号线三处跨河点在闭合之后仍带 3.9~5.6‰ 的坡）。
       所以水平这件事必须在坡度折线全部算完之后、积分成高程之前这一刀切下去。 */
    for (const z of (this.flat || [])) {
      for (let i = Math.max(1, Math.ceil(z[0] / this.res)); i * this.res <= z[1] && i < n; i++) gT[i] = 0;
    }
    let y = 0;
    yT[0] = 0;
    for (let i = 1; i < n; i++) { y += (gT[i] + gT[i - 1]) / 2 / 1000 * this.res; yT[i] = y; }
    this.stationFrame = this.stationS.map(s => this.at(s));
    return this;
  }
  _vAt(s) {
    if (!this.yTab) this.build();
    const i = s / this.res, i0 = Math.floor(i), t = i - i0;
    const n = this.yTab.length;
    const a = C(i0, 0, n - 1), b = C(i0 + 1, 0, n - 1);
    return { y: L(this.yTab[a], this.yTab[b], t), g: L(this.gTab[a], this.gTab[b], t) / 1000 };
  }
  /** 里程 s 处的完整状态 */
  at(s) {
    s = C(s, 0, this.total);
    const p = this._planAt(s), v = this._vAt(s);
    const vEq = this.vEq || 19.0;                        // 平衡速度（m/s），高速线抬高
    /* 超高直接由**本里程的曲率**给出。曲率现在沿缓和曲线线性爬升，
       超高就跟着同一段爬升 —— 真实线路里"缓和曲线"同时承担着曲率与超高两件事。
       以前这里对曲率做 ±45 m 九点平均来"造"一段缓和：那是把一个阶跃拆成九个
       小阶跃（平均窗口按 5.6 m 离散步进圆曲线，每跨进一个采样点超高就跳 1/9 格）。
       实测最大超高斜率 0.27 °/m、横向加速度变化率 5.0 m/s³，
       是舒适上限 0.45 m/s³ 的十一倍 —— 玩家报的"拐弯抽搐一下"就是这么来的。
       **台阶要在线形里去掉，不是在角度上平滑掉。** */
    const cant = Math.atan(p.k * vEq * vEq / 9.81);
    return { s, x: p.x, y: v.y, z: p.z, th: p.th, k: p.k, grade: v.g, cant: C(cant, -0.105, 0.105) };
  }
  /** 里程 s 处的右手正交基（right/up/forward），已含超高侧倾 */
  frame(st) {
    if (typeof st === 'number') st = this.at(st);
    const cp = Math.cos(st.th), sp = Math.sin(st.th);
    const phi = Math.atan(st.grade), cg = Math.cos(phi), sg = Math.sin(phi);
    const f = norm3([sp * cg, sg, cp * cg]);
    let r = norm3(cross([0, 1, 0], f));
    let u = cross(f, r);
    if (st.cant) {
      const c = Math.cos(st.cant), s2 = Math.sin(st.cant);
      const r2 = [r[0] * c + u[0] * s2, r[1] * c + u[1] * s2, r[2] * c + u[2] * s2];
      u = [u[0] * c - r[0] * s2, u[1] * c - r[1] * s2, u[2] * c - r[2] * s2];
      r = r2;
    }
    return { p: [st.x, st.y, st.z], r, u, f, s: st.s, k: st.k, grade: st.grade, cant: st.cant, th: st.th };
  }
  /** 世界坐标 = 中线点 + 横向 offset + 竖向 dy（沿该处 up，即含超高） */
  world(fr, offset, dy) {
    const o = offset || 0, h = dy || 0;
    return [fr.p[0] + fr.r[0] * o + fr.u[0] * h, fr.p[1] + fr.r[1] * o + fr.u[1] * h, fr.p[2] + fr.r[2] * o + fr.u[2] * h];
  }
  /**
   * 把 frame 的截面基换成"水平地面系"：r 取水平方向的右、u 取世界铅垂。
   *
   * world() 用的是轨道自己的右手系，其中 r 带着**超高**（cant，最大 0.034 rad ≈ 2°）。
   * 贴在轨道上的构件（桥面、站台、接触网、车体）应该跟着这个倾斜面走；
   * 但街面、绿化带、楼群、地标是**地面**，不该被轨道的超高抬起来。
   * 用 world() 摆地面物体时，横向每一百米就附带 3.4 m 的垂直位移：
   * 实测 900 m 外的淀山湖被压低 31 m，整个埋到远景地面底下——
   * 观景机位拍出来是一片街区，没有湖。
   */
  /** 街面相对**本里程轨面**的 dy：把"平滑轨面 + SH.STREET_Y"换算回 al.world 要的局部量。
   *  凡是往地上铺的东西（街面断面、行道树、标线、出入口站厅、桥墩底、行人机位）
   *  都用它，不要再自己写 −10.9 —— 见 core.js 里那条常数为什么存在。 */
  streetDy(s) { return this.groundY(s) - this.frame(s).p[1] + SH.STREET_Y; }
  /**
   * **地面高程基准**：轨面高度沿线 ±600 m 的平均值。
   *
   * 为什么需要：跟随相机的远景地面是一块**平面**，而烘焙出来的东西按
   * 各自里程的轨面取基。纵断面闭合只管到"每个站间净高差归零"，区间内部
   * 该爬还是爬 20 多米 —— 于是 900 m 外的地面平面与局部轨面能差十几米，
   * 17 号线追拍实测就是"一整排楼飘在半空"（楼本身是扎进地面的，
   * 扎的是它自己里程的地面，不是相机脚下这块）。
   * 地面是地形，本来就不该跟着高架的纵断面一起起伏：真实世界里
   * 是桥墩长短在变，不是地在跟着桥爬。
   */
  groundY(s) {
    const T = 150, W = 4;
    const tab = this._gyTab || (this._gyTab = new Map());
    const at = (i) => {
      let v = tab.get(i);
      if (v == null) {
        let sum = 0, n = 0;
        for (let k = -W; k <= W; k++) { sum += this.frame(SH.clamp(i * T + k * T, 0, this.total)).p[1]; n++; }
        v = sum / n; tab.set(i, v);
      }
      return v;
    };
    const i0 = Math.floor(s / T), f = s / T - i0;
    return at(i0) * (1 - f) + at(i0 + 1) * f;
  }

  level(fr) {
    const rx = fr.r[0], rz = fr.r[2];
    const l = Math.hypot(rx, rz) || 1;
    return {
      p: fr.p, r: [rx / l, 0, rz / l], u: [0, 1, 0], f: fr.f,
      s: fr.s, k: fr.k, grade: fr.grade, cant: 0, th: fr.th,
    };
  }
  /** 地面系下的世界坐标（街面 / 楼群 / 地标用它，轨道构件用 world） */
  ground(fr, offset, dy) {
    const o = offset || 0, h = dy || 0;
    let rx = fr.r[0], rz = fr.r[2];
    const l = Math.hypot(rx, rz) || 1; rx /= l; rz /= l;
    return [fr.p[0] + rx * o, fr.p[1] + h, fr.p[2] + rz * o];
  }
  /** 采样 [s0,s1] 的 frame 序列 */
  frames(s0, s1, step) {
    const out = [];
    const n = Math.max(2, Math.ceil((s1 - s0) / Math.max(0.5, step)));
    for (let i = 0; i <= n; i++) out.push(this.frame(s0 + (s1 - s0) * i / n));
    return out;
  }
  /** 该里程的曲线限速 km/h（按 0.16 m/s² 未平衡横向加速度） */
  curveLimitKmh(s) {
    const st = this.at(s);
    if (!st.k) return Infinity;
    return Math.sqrt(this.unbal * 9.81 / Math.abs(st.k)) * 3.6;
  }
  /** [s0,s1] 内最小曲线半径 */
  minRadius(s0, s1) {
    let k = 0;
    for (let s = s0; s <= s1; s += 5) k = Math.max(k, Math.abs(this.at(s).k));
    return k ? 1 / k : Infinity;
  }
  /** 站间是否含曲线（决定要不要设曲线限速牌） */
  hasCurve(s0, s1) { return this.minRadius(s0, s1) < 3000; }
}
/* 两端停车基地的里程区间。**写成只依赖 al 的纯函数**：
 * 分类器 runsOf 与离线判据都拿一个"像 line 的对象"在调，方法挂在
 * LineRuntime 上会让 test-bake 那种手搓的假 line 直接炸
 * （实测 `line.depotZones is not a function`，20 条线全红）。 */
SH.depotZones = al => {
  if (al._dz) return al._dz;
  const S = al.stationS, out = [];
  const tail = { end: S.length - 1, from: S[S.length - 1] + 250, to: al.total - 4, mark: al.total - 150, side: 1 };
  if (tail.to - tail.from > 220) out.push(tail);
  const head = { end: 0, from: 4, to: S[0] - 250, mark: 150, side: -1 };
  if (head.to - head.from > 220) out.push(head);
  al._dz = out;
  return out;
};
SH.depotAt = (al, endIdx) => SH.depotZones(al).find(z => z.end === endIdx) || null;
SH.depotAtS = (al, s) => SH.depotZones(al).find(z => s >= z.from && s <= z.to) || null;
/* 库区停车线几何（第 109 条，E3）：条数 / 间距 / 首线横距的唯一住处。
   world.depot() 的停车线、进路表的侧向 lat、调车信号机"指定股道"的折算
   都读它 —— 三处各抄一份 6.0 就是三份会各自漂移的真值。 */
SH.DEPOT = { roads: 4, pitch: 6.0, first: 3.5 };
/* 库区进路表（E3）：每个停车基地一套 —— 入库信号机里程、直股引道
   （从入库信号机到车挡 mark）、侧向停车线 lat 表。
   "进路"这个概念在这里第一次成为表：入库信号机与矮柱调车信号机的
   位置、防护范围都从这张表取，不许在 world 里再抄一份 from+6。
   缓存在 al 上（与 depotZones 同一约定）。 */
SH.routes = al => {
  if (al._routes) return al._routes;
  const out = SH.depotZones(al).map(z => ({
    kind: 'depot', end: z.end, side: z.side,
    sigS: z.from + 6, mark: z.mark,
    lead: [z.from, z.to],
    roads: Array.from({ length: SH.DEPOT.roads }, (_, k) => SH.DEPOT.first + (k + 1) * SH.DEPOT.pitch),
  }));
  al._routes = out;
  return out;
};


/* ================================================================== 线路生成 */
/** 站台有效直线段：6A 车长 ~140 m 全落在停车标之前，之后只需留 58 m */
const PRE = 182, POST = 58;

/**
 * 由站名与站间距生成线形。
 * 保证：每个停车标前后 [PRE, POST] 米内是直线且坡度为 0。
 */
function buildLineAlignment(stations, gaps, seed, opts) {
  opts = opts || {};
  const al = new Alignment();
  /* 设计速度越高，曲线越缓、超高越大。
     vMax=80 → 半径系数 1（地铁不受影响）；160 → 2.8；300（磁浮）→ 11.5，
     同时把未平衡加速度放宽到 0.30 m/s²（市域标准）。
     系数从 1.3 抬到 1.9 的理由是**缓和段的长度上限被转角卡住**：
     一道 |dth|=0.1 rad、R=2770 m 的弯只有 235 m 可铺，而 300 km/h 需要 330 m，
     于是磁浮的横向加速度变化率永远压在 0.45 的线上。真实 300 km/h 线路的
     最小半径本来就是 7000 m 量级，不是"地铁的弯放大一点"。 */
  const vK = Math.max(0, (opts.vMax || 80) - 80) / 40;
  const rScale = 1 + vK * 1.9;
  al.unbal = Math.min(0.30, 0.16 + vK * 0.035);
  /* 平衡速度（m/s）= 0.8 倍设计速度：80 km/h 线 → 64 km/h，与原来的 19 m/s 一致；
     磁浮 300 km/h → 240 km/h，超高才够把列车压住。 */
  al.vEq = 0.80 * (opts.vMax || 80) / 3.6;
  /* 夹直线长度（两道弯之间的直线段）。市域/高速口径里 300 km/h 的最小夹直线
     是 500 m 量级，地铁则允许曲线近接，所以只对 vMax≥160 的线启用——
     给地铁插夹直线会把站里程推走，动到全部既有判据。 */
  const tangent = (opts.vMax || 80) >= 160 ? Math.round(1.6 * (opts.vMax || 80)) : 0;
  al.stationName = stations.slice();
  const R = rng(seed >>> 0);
  let bias = 0, lastDir = 0;

  al.gradeAt(0, 0);
  /* 首尾引入段默认就是 640 m —— 因为**两端必须有地方放停车基地**（出入段线 +
     4 条停车线 + 车挡 + 信号机），这是"一条线路是什么"的一部分，不是调用方
     可选的装饰。原来默认 PRE+300 / POST+320：站后只剩 378 m，基地区间长度
     124 m 被自己的长度门槛判掉，于是 test-bake 里那些不复用 LineRuntime
     的假 line 对象全都只有一处基地，而游戏里看起来"没问题"。 */
  al.line(opts.leadIn || 640);
  /* 停车标放在直线的**末端**（后面紧跟 gap 循环里的 line(POST) 补足站后直线）。
     原来写成 al.total - POST，等于把首站往前挪了 58 m，于是首站站后只有
     POST-58=0 m 直线，而且首站间距比其它站短 58 m —— 站台"前 182 后 58"
     的规范对首站失效，站间距也整体不一致。 */
  al.stationS.push(al.total);               // 第 0 站停车标
  al.gradeAt(al.stationS[0] - PRE, 0);
  al.gradeAt(al.stationS[0] + POST, 0);

  for (let i = 0; i < gaps.length; i++) {
    const s0 = al.stationS[i];
    al.line(POST);
    const need = Math.max(80, gaps[i] - POST - PRE);
    /* 站间越长，坡度上限必须越小。区间净高差虽然闭合到 0，但内部仍留着
       一个"上坡—下坡"的鼓包，幅度 ≈ |g|·L/4：16/17 号线这种 2~3 km 站距按
       ±27‰ 跑就是 ±15 m、来回 30 m。而整个世界的高程基准挂在轨面上
       （街面 −10.9、水面 −10.2、地标锚点 −12），轨面自己起伏 30 m，
       远处的湖面和街面就被埋掉了。这里按"区间内抬升 ≤ 8 m"反推坡度上限。 */
    const gCap = Math.min(27, 1000 * 8 / Math.max(60, need / 4));
    let used = 0, guard = 0;
    const gStart = 0, gEnd = 0;
    const pts = [];                          // 区间内的 (进度, 坡度) 计划
    let g = 0;
    /* 跨江/跨河点：大桥必须落在**直线 + 水平段**上。
       桥塔、加劲梁、水面都是刚性水平件，线路在桥上带坡进弯，桥面就与水面拧着 ——
       test-shot 的河床判据抓到"梁底扎进水面"就是这个。而以前生成器根本不知道
       哪里有江：实测 5 个跨水点**全部**压在曲线上（5 号线跨黄浦江在 R=1980 m、
       −11.32‰ 的坡上，3 号线跨河在 R=518 m 上）。真实线路的过河段恰恰是
       整条线里最直最平的一段。 */
    const cx = (opts.cross || []).indexOf(i) >= 0;
    let blk = null;
    if (cx) {
      const mid = gaps[i] / 2 - POST;                    // 两站正中，换算到 used 坐标
      const W = Math.min(Math.max(120, need - 60), 460);
      blk = [Math.max(0, mid - W / 2), Math.min(need, mid + W / 2)];
      al.gradeAt(s0 + gaps[i] / 2 - W / 2, 0);
      al.gradeAt(s0 + gaps[i] / 2 + W / 2, 0);
      (al.flat || (al.flat = [])).push([s0 + gaps[i] / 2 - W / 2, s0 + gaps[i] / 2 + W / 2]);
    }
    while (used < need - 30 && guard++ < 24) {
      const remain = need - used;
      if (blk && used < blk[1]) {
        /* 窗口之前剩下的长度不足以铺一道完整的"缓和—圆—缓和"，就别硬塞，
           直接直着铺到窗口之外：宁可这里长直，也不把弯挤到桥上。 */
        if (blk[0] - used < 90) { al.line(blk[1] - used); used = blk[1]; continue; }
      }
      const r = ((remain < 300 ? 340 : 480) + Math.floor(R() * (remain < 300 ? 230 : 420))) * rScale;
      let dth = (0.10 + R() * 0.40) * (R() < 0.5 ? -1 : 1);
      bias = bias * 0.70 + dth * 0.30;
      dth = dth * 0.78 + bias * 0.22;
      if (Math.abs(dth) < 0.035) dth = 0.05 * (lastDir ? -lastDir : 1);
      let dir = dth > 0 ? 1 : -1;
      if (dir === lastDir && R() < 0.45) { dir = -dir; dth = Math.abs(dth) * dir; }
      lastDir = dir;
      let clen = Math.abs(dth) * r;
      /* 原来是 `line(tan) + arc(clen)`：夹一段直线再直接贴圆曲线。相切只保证
         方向连续，曲率照样 0 → 1/R 阶跃，横向加速度 v²/R 在一瞬间全加上 ——
         这就是"拐弯抽搐"的根。现在按真实线形铺 直线—缓和—圆曲线—缓和—直线。
         缓和段长度按"未被平衡横向加速度变化率 ≤ 0.45 m/s³"反推：
             Δa = v²·K 摊在 L 米上、车速 v ⇒ 速率 = v³·K / L ⇒ L ≥ v³·K / 0.45
         70 km/h、R=343 m ⇒ 47 m，正是地铁常用的 40~60 m 缓和段。
         两端各铺一条、圆曲线缩短 Lt，总转角 K·(clen−Lt) + K·Lt = K·clen 与原来**完全一致**，
         所以站间距、停车标、站台在直线上这三条不变量都不动。 */
      const K = 1 / Math.max(80, r);
      const vv = (al.vEq || 15.5) / 0.8;                 // 用设计速度，不是平衡速度
      const LtWant = Math.max(14, vv * vv * vv * K / 0.45);
      /* 缓和段最长可以占到整道弯的 85%（只留 15% 的圆曲线核心）。
         高速线尤其如此——真实 300 km/h 线路的"曲线"常常几乎全是缓和段；
         卡在 60% 时磁浮那道 R=4148 m 的弯只能铺 240 m，实测 0.49 m/s³ 仍超。 */
      let Lt = Math.min(Math.max(clen * 0.85, 14), LtWant);
      const room = (blk && used < blk[0] ? blk[0] : need) - used;
      /* 空间不够时**先扣圆曲线、保住缓和段**；连一道完整缓和段都塞不下，
         这道弯就干脆不做，余下的长度直着过去 —— 真实高速线正是这样：
         曲线稀疏、直线很长，而不是"弯道挤在区间末尾、缓和段压成二三十米"。
         磁浮 300 km/h 下被压短的那一段实测 da/dt = 0.85 m/s³，是舒适上限的 1.9 倍。 */
      if (clen + Lt > room) {
        clen = room - Lt;
        if (clen < 24) break;
        Lt = Math.min(Lt, clen * 0.85);
      }
      /* 三条长度必须**恰好**吃掉 room 之内的一段，多铺一厘米都会把后面的
         站里程推走（浦江线实测站间距偏 1.7 m，就是这道弯的总长超过了 room）：
         先按剩余空间封顶缓和段，再让圆曲线只用到剩下的长度。 */
      Lt = Math.min(Lt, Math.max(6, (room - 8) / 2));
      const aLen = Math.max(8, Math.min(clen - Lt, room - 2 * Lt));
      al.trans(Lt, 0, dir * K); used += Lt;
      al.arc(aLen, r, dir); used += aLen;
      al.trans(Lt, dir * K, 0); used += Lt;
      /* 夹直线：两道弯之间必须有直线段。以前曲线是**首尾相接**铺的，
         于是磁浮 29 km 里直线只占 0.9% —— 一条 300 km/h 的线全程在 S 弯里扭，
         而它出名恰恰是因为有一段可以放开跑的长直。
         只对 vMax≥160 生效：市域/高速标准里 300 km/h 的最小夹直线是 500 m 级，
         地铁的弯本来就近接，硬插直线会把站里程推走、动到全部既有判据。 */
      if (tangent) {
        const roomT = need - used - 30;
        if (roomT > tangent) { const tj = tangent * (0.7 + R() * 0.6); al.line(tj); used += tj; }
      }
      // 曲线段配套变坡：下坡进弯、上坡出弯（更贴近真实纵断面）
      g = C(g + dir * (5 + R() * 12) + (R() - 0.5) * 5, -gCap, gCap);
      pts.push({ at: used, g });
      if (used >= need - 20) break;
    }
    if (used < need) { al.line(need - used); used = need; }
    /* ---------- 纵断面闭合：把这一站的站间净高差归零 ----------
     * 变坡点是随机游走出来的，整条线可以一路爬到 +58 m 再掉到 −140 m。
     * 上海是三角洲平原，真实线路的地面高程全线只差几米；更要命的是
     * **整个世界的高程基准都挂在轨面上**：街面 = 轨面 − 11、地标锚点 = 轨面 − 12、
     * 跟随相机的远景地面 = 列车所在里程的轨面 − 11。轨面沿线爬几十米，
     * 列车脚下的远景地面就比远处地标高几十米 —— 淀山湖被整个埋到地面底下，
     * 观景机位拍出来是一片街区、没有湖。
     *
     * 这里逐区间做闭合：把该区间折线坡度的积分（=净高差）摊平掉。
     * 两端控制点是车站标志处的 0‰，必须保持 0（停车精度与安全都依赖它），
     * 所以只平移区间内部的点，迭代几次收敛，并夹在 ±27‰ 以内。 */
    for (let it = 0; it < 8; it++) {
      const seq = [{ at: 0, g: 0 }].concat(pts, [{ at: used, g: 0 }]);
      let rise = 0;
      for (let k = 0; k + 1 < seq.length; k++) rise += (seq[k].g + seq[k + 1].g) / 2 * (seq[k + 1].at - seq[k].at);
      if (Math.abs(rise) < 2) break;                    // ‰·m ⇒ 2 ≈ 2 mm，够紧了
      const c = rise / used;
      for (const p of pts) p.g = C(p.g - c, -gCap, gCap);
    }
    // 进站前把坡度拉回 0
    pts.push({ at: used, g: 0 });
    for (const p of pts) al.gradeAt(s0 + POST + p.at * (gaps[i] - POST - PRE) / Math.max(1, used) + 0, p.g);
    al.gradeAt(s0 + gaps[i] - PRE, 0);
    al.line(PRE);
    al.stationS.push(al.total);
    al.gradeAt(al.total + POST, 0);
  }
  const last = al.stationS[al.stationS.length - 1];
  al.line(opts.leadOut || 640);
  al.gradeAt(al.total, 0);
  al.build();
  return al;
}

/** 由站名对做确定性哈希，生成"看起来合理且永远一致"的站间距 */
/* 站间距生成的**唯一**实现。以前 game.js 的 LineRuntime._gaps 与这里各写一份：
   游戏里多一条"市中心站间距 ×0.86"的调制，测试侧没有；哈希偏移一个是 i+17、
   一个是 i+18。于是 test-core 那套线形判据（未被平衡横向加速度变化率 ≤0.45、
   跨江段必须直平）量的根本不是游戏里那条线 —— 判据自己在骗人。 */
function synthGaps(stations, base, spread, seedShift, totalM) {
  const b = base || 1150, sp = spread || 620, out = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const h = hash32(stations[i] + '>' + stations[i + 1], (seedShift || 0) + i + 17);
    let g = b + (h % sp);
    // 市中心站间距小、郊区大：用站名是否含枢纽/景区粗略调制
    if (/路|桥|门|场|中心/.test(stations[i]) && g > b * 1.15) g *= 0.86;
    out.push(Math.round(g));
  }
  /* 官方运营里程标定：把合成图案整体缩放到"首末站心距 = totalM"。
     保留市区密/郊区疏的**相对**图案（那由站名哈希给），只改绝对尺度 ——
     逐站里程没有公开表，能标定的只有总长这一层。320 m 下限是站间最小跨距，
     缩放后仍要留得下一条站台 + 一组道岔。 */
  if (totalM && out.length) {
    let sum = 0;
    for (const g of out) sum += g;
    const k = totalM / sum;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(320, Math.round(out[i] * k));
  }
  return out;
}

SH.Alignment = Alignment;
SH.buildLineAlignment = buildLineAlignment;
/* 一条线的线形种子也只允许有一处定义。以前 game.js 用 hash32(baseId, 977)、
   test-core 用写死的 7，两边站间距一致了随机弯位却仍是另一条线，
   "判据量的就是游戏里那条"只成立一半。 */
SH.lineSeed = (baseId) => hash32(baseId, 977);
SH.synthGaps = synthGaps;
/** 一条线的跨距序列：图案 + 官方运营里程标定，**一次读全 def**。
 *  所有调用点（游戏侧 `LineRuntime._gaps`、test-core、test-drive）都必须走这个入口：
 *  以前三处各自写 `synthGaps(stations, base, spread)`，谁漏传一个新参数就会静默算出
 *  另一套线形 —— "第二个真值"就是这么长出来的（`_gaps()` 曾多一条调制、哈希偏移差 1）。 */
SH.lineGaps = (def, stations, seedShift) =>
  synthGaps(stations, def.base, def.spread, seedShift, def.km ? def.km * 1000 : 0);

/* ------------------------------------------------------------------------- 闭塞
   放在这里而不是 traffic.js：世界几何（信号机）与调度器都要读，而 index.html 里
   world.js 在 traffic.js **之前**加载。同一条理由决定了 `synthGaps` 也住在这。 */

/** 闭塞分区表。真实地铁隧道里一个站间区间是**好几个轨道电路分区**
 *  （典型 300~600 m），不是整段一个闭塞。按"整段站间出清才放行"建模会把
 *  通过能力压到 一站间运行时分 一节，1 号线目标间隔 1434 m 就永远达不到
 *  放行所需的 1555 m —— 实测 26 列里 81% 的时间被扣在站上、正点率 0%。
 *
 *  这是**分区边界的唯一出处**：调度器的放行/防护判据与 `WorldBuilder.signage`
 *  的信号机里程都读它。固定闭塞里信号机就是"分区入口的那根柱子"，两者一旦脱钩
 *  （信号按装饰性的固定米数铺），画面上一架绿灯可能正对着一个被占用的分区 ——
 *  好看，但是说谎。 */
/* 闭塞分区不是"从里程 0 起铺的整数公里格"。真实固定闭塞的边界是
   "出站信号机（站台出口 s+96）+ 站间再均分 2~4 格"，一站一个局部原点 ——
   这才是"一格一车、红灯=占用"的出处。所以分区不是 floor(s/blk) 的
   全局格，而是"每对相邻站之间单独铺"。`blocks()` 就是唯一出处：
   调度器的防护/显示与 `WorldBuilder.signage` 的信号机都读它，两者才不会脱钩。 */
/* 站台区半长的**唯一定义**（含端头 96 m，站台全长 192 m）。"站中心 ± 这个数"
   就是站区防护尺度：`SH.blocks` 的分区头、`SH.stationSignals` 的出站口、
   `WorldBuilder.runsOf` 的分类器站区、进站信号机里程、`station()` 的站台几何、
   `_portals` 的洞口剔除全部读它。改这个数 = 一次站区断面修订，所有几何跟着走；
   哪个消费者还写着字面量 96，`test-traffic` 的常数探针判据会当场报红。 */
SH.STATION_HALF = 96;
/* 停车标里程 = 站台中心 + STOP_MARK（**唯一定义**，米）。
   站台几何铺在 [S−150, S+42]（station()），192 m 正好装进一列 8A（≈186 m）
   —— 车头停在 S+39（距远端 3 m）时车尾在 S−147（距近端 3 m），全列车
   收在站台里；此前停车标就是站台中心 S，8A 的车尾甩出站台 36 m，
   车头离远端还有 42 m —— 玩家看到的就是"停在站台中间"。
   消费者：game.js 的 targetS / _psd 门叶、world.js 的屏蔽门立柱与人群带 ——
   四处必须一起搬家（门叶对不齐立柱 = 屏蔽门错位），test-drive 的
   「停车标在站台端」判据看住全车落进站台。 */
SH.STOP_MARK = 39;
/* 双线断面横向间距的**唯一定义**（米）。上海地铁双线并行标准线间距 4.0 m：
   两股道中心相距 4 m 时，钢轨净距 4 − 1.5 = 2.5 m，车体净距 4 − 2 × 1.4 = 1.2 m
   —— 正是站台上看着对向车"擦身而过"又不觉得危险的那个距离。
   消费者：`buildRuns` 的对向轨烘焙、`game.js` 的对向车镜像渲染、
   `test-xsect` 的"对向轨存在 / 两股道间空 / 隧道无双轨"判据。
   改这个数 = 一次全线双线断面修订，几何与渲染跟着走；哪个消费者还写着
   字面量 4，常数探针判据会当场报红。 */
SH.TRACK_OFFSET = 4.0;
SH.blocks = (al, nStations) => {
  const S = al.stationS, out = [];
  /* 出站口防护里程 = SH.stationSignals（站中心 + SH.STATION_HALF，逐站对齐），
     分区头从这里取 —— 信号机柱子与分区边界不是两件事，也不许是两份公式。
     终点站出站口在 al.total 之外时钳到终点（把终点站当车挡），全线几何里
     终点站都留有余量，钳位恒为恒等，但它定义着边界情形。 */
  const E = SH.stationSignals(al);
  for (let i = 0; i < S.length; i++) {
    const a = E[i];
    const b = (i + 1 < S.length) ? E[i + 1] : al.total;
    const lo0 = Math.min(a, al.total), hi0 = Math.max(a, al.total);
    if (i + 1 >= S.length) { out.push([lo0, hi0]); continue; }
    const len = b - a;
    if (len <= 0) continue;
    /* 站间 1.2~2.4 km，÷2.5 给 2~4 格；取整保持整数边界（floor 精确），
       太短的站间不会塌成"一格都没有"。 */
    const u = Math.round(Math.max(1, len / Math.round(C(len / 2.5, 300, 700))));
    const step = len / u;
    for (let j = 0; j < u; j++) {
      const lo = a + j * step, hi = (j === u - 1) ? b : a + (j + 1) * step;
      out.push([lo, hi]);
    }
  }
  return out;
};
/* 车站出站口防护里程表：站中心 + SH.STATION_HALF，**与 stationS 逐站对齐**，
   终点越界时钳到 al.total。`SH.blocks` 的分区头就是这张表 —— 出站信号机与
   闭塞分区边界同源，才谈得上"红灯 = 防护分区被占"。 */
SH.stationSignals = (al) =>
  (al.stationS || []).map(s => Math.min(s + SH.STATION_HALF, al.total));

/* 三显示自动闭塞的显示表。`clear` = 从该信号机起**连续出清**的分区数：
   0（防护分区被占）⇒ 停车信号；1 ⇒ 注意信号（要求准备减速）；≥2 ⇒ 按规定速度运行。
   `code` 是中国铁路的灯位代号（L 绿 / U 黄 / H 红），司机口里说的就是这个字。
   灯位自上而下 L·H·U —— 与"三灯位凑四显示"用的是同一套机构（绿黄同亮 = 四显示的
   第三个显示），本项目站间只有 1.2~1.5 km，三显示够用。 */
SH.ASPECTS = [
  { key: 'stop', code: 'H', cn: '红', name: '停车信号', clear: 0 },
  { key: 'caution', code: 'U', cn: '黄', name: '注意信号', clear: 1 },
  { key: 'proceed', code: 'L', cn: '绿', name: '运行信号', clear: 2 },
];
/* 调车/入库显示（第 109 条，E3）：**追加在主线三显示之后** —— 主线显示表
   下标 0..2 一个都不动，`Dispatcher.aspectAt` 的 `Math.min(2, ·)` 上限与这段
   下标是同一个约定，主线出站/进站信号机永远不会显示月白。
   双黄（侧向进路）等 E4 的折返渡线几何落地后再加：没有渡线的"双黄"是在
   显示一条不存在的进路，正是本项目反对的名义化。 */
SH.ASPECTS.push(
  { key: 'shunt', code: 'B', cn: '月白', name: '调车允许信号', clear: 1 },
  { key: 'shuntStop', code: 'A', cn: '蓝', name: '调车禁止信号', clear: 0 },
);
/* 点亮/熄灭的自发光倍率（走 `r.draw(b,M,{emi})` 的按批次覆盖通道）。
   与驾驶室指示灯同一条约定：**灭的时候必须还是一颗深色玻璃珠**，
   不然整排读起来是三张彩色卡片而不是"哪一盏亮着"。
   灭灯的"暗"住在透镜基色里：world.js 灯位颜色一律暗玻璃（Rec.709 亮度
   < 0.45，test-traffic E3 ⑨ 看住）—— ACES 后处理把亮灭差压到 ~1.2×，
   浅灰基色（旧 #b8c8d4/#b8c4cc，亮度 ~0.77）的灭灯透镜连 bloom 阈值 0.62
   都过了，灭着也像亮着，库区指定股道根本读不出来。
   on 的下限住在"亮得像灯"里，而增益链有一处容易漏算：plate 的烘焙自发光
   （{emi:1}）进顶点 alpha 时按 mesh 的 0..2.5 归一，vC.a = 0.4，所以发射项
   = 基色 × 0.4 × 2.2（light 材质）× on × 曝光 1.06。基色换成暗玻璃（亮度
   0.33）之后 pre-bloom 亮度要越过 1.17（阈值 0.62 + 满档 0.55）才有光晕：
   0.331×(0.92 漫反射 + 0.88×on) ≥ 1.17 → on ≥ 2.74 —— on 1.2 只有 0.75，
   "亮"退化成"灰一点"，与"灭"又分不开；取 2.8 给 1.19，亮灯 ≈215 挂光晕，
   与旧浅灰基色 + on 0.5 那版被接受的亮灯读数（~210）同档。 */
SH.SIG_EMI = { on: 2.8, off: 0.03 };
SH.PLAT = { PRE, POST };

})(typeof window !== 'undefined' ? window : globalThis);
