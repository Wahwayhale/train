/* -------------------------------------------------------------- 道路车流
 * 走廊街面上的社会车辆与公交车。以前整条走廊"有路没车"：车道虚线画了、
 * 树种了、楼盖了，唯独一辆车都没有 —— 从高架驾驶室看下去是一条停摆的城。
 *
 * 车辆网格按**车型×涂装**预烘成批（车头 +z），运行时只做两件事：
 *   ① update(dt)：沿车道推进、公交车进站停靠；
 *   ② draw(r, s)：把相机 400 m 内（且在露天段、不在江面）的车用
 *      m4basis 摆到车道上逐批上屏 —— 与 AI 列车/对向车同一套机制。
 *
 * 车道与方向：中央分隔带两侧各三条车道（横向 25/34.5/44，与路面虚线同源），
 * 右侧通行 —— side=+1 的车道往 +s 走，side=−1 往 −s 走。
 * 只在露天段（isElevated）有车：地下段连街面都没有烘，跟世界同一判据；
 * 跨水段街面被 waterRanges 挖断，车辆在桥前后淡出。
 */
(function (global) {
  const SH = global.SH;
  const { rgbOf, rand01 } = SH;

  /* 涂装偏中深色：街面机位里近白车身会被路面眩光吃掉（street6/street7 取证），
   深色与彩色在沥青底上才读得出"这是一辆车"。 */
const CAR_COLORS = ['#3a4147', '#8c2f2b', '#3d5a80', '#4a6a41', '#d9a947', '#20262b', '#7a4a2f'];
/* 涂装的**线性 rgb**（第 135 条：按实例给色）。在模块加载时算一次 —— 每帧
   重新解析 hex 是白功，而这张表就是"车漆有哪几档"的唯一出处。 */
const CAR_TINT = CAR_COLORS.map(c => rgbOf(c));

/* 公交并线提前量：从最内侧车道（20.3）并到公交道（48.5）要横移 28.2 m，
   按 1.6 m/s 的横移速率是 17.6 s，45 km/h 下就是 220 m —— 给到 260 m，
   车才能"先并线、到站前 55 m 才减速"，而不是停在行车道中间再慢慢蹭过去。 */
const MERGE_AHEAD = 260;
/* 近档半径（米）：draw 按相机眼点 480 m 剔除，而相机可以离列车几百米
   （站台机位/街面机位），所以近档给到 1500 m —— 画面上任何一辆车都在近档里，
   分级只影响"这一帧根本没人能看见"的那些车。 */
const NEAR_S = 1500;

  /** 一辆车的网格。local：车中心原点，+z 车头，y=0 路面。
   *
   * 这一版为什么重写（目标里"建模必须 Unity 级"）：原来五种车型在代码里其实只有
   * 两个分支 —— 公交与"其它"，而"其它"里 SUV / 厢式 / 出租只差 `ch`（座舱高）与 `L`
   * 两个数，轮子是一颗压扁的球。判据数得出"变体 13 个"，画面上却读不出车型。
   * 现在按**剪影**分型：三箱式台阶（引擎盖 / 座舱 / 行李箱三段不同高度的 paint）、
   * 倾斜前风挡、后视镜、尾灯带、前格栅、轮毂、SUV 行李架、厢式车侧拉门缝、
   * 公交第二道门与后窗。
   * **材质只准用 paint / glassSoft / metal / steel / light 这五族**：街面机位实测
   * draw call 315 / 上限 330，只剩 15 的余量，而批次是"每变体 × 每材质"一组 ——
   * 新加一种材质就是十三个批次，细节没上来之前帧率先塌。 */
  function buildVehicle(kind, col) {
    const b = new SH.Builder();
    const R = rgbOf;
    const N = SH.Geo.norm3;
    /* 轮子 = 胎圈（steel）+ 露出胎面一圈的轮毂（metal）。
       车轮**不能**真的滚：一辆车只有一个实例矩阵，转轮子要把它拆成"车身批次 +
       四轮批次"，那是 +4 draw call / 每辆车。轮毂那 1 cm 的凸起是"这玩意儿是圆的"
       唯一买得起的视觉线索。 */
    const wheel = (x, z, r) => {
      for (const sx of [-1, 1]) {
        b.sphere([sx * x, r, z], [0.115, r, r], { mat: 'steel', color: R('#12151a'), segU: 12, segV: 8 });
        b.box([sx * x, r, z], [0.125, r * 0.44, r * 0.44], R('#98a2a8'), { mat: 'metal' });
      }
    };
    if (kind === 'bus') {
      const L = 10.6, W = 2.50;
      wheel(0.98, 3.4, 0.50); wheel(0.98, -3.2, 0.50);
      b.box([0, 1.55, 0], [W, 2.15, L], R(col), { mat: 'paint' });
      b.box([0, 1.55, 0], [W * 1.02, 0.85, L * 0.90], R('#1d242a'), { mat: 'glassSoft' });   // 侧窗带
      b.box([0, 0.42, 0], [W * 0.99, 0.28, L * 0.94], R('#2b3238'), { mat: 'metal' });        // 下裙板（深色饰条：不许跟着涂装染色）
      b.plate([0, 2.05, L / 2 - 0.02], [W * 0.76, 0, 0], [0, 0.75, 0], [0, 0, 1], R('#1d242a'), { mat: 'glassSoft' });
      b.plate([0, 2.05, -L / 2 + 0.02], [W * 0.76, 0, 0], [0, 0.75, 0], [0, 0, -1], R('#1d242a'), { mat: 'glassSoft' }); // 后窗
      b.plate([1.30, 2.30, L / 2 - 0.34], [0.9, 0, 0], [0, 0.28, 0], [0, 0, 1], R('#3a3f45'), { mat: 'metal' });          // 路牌（同上）
      b.box([0, 0.55, L / 2 - 0.05], [2.2, 0.4, 0.2], R('#2b3238'), { mat: 'metal' });        // 前脸（同上）
      for (const sx of [-0.8, 0.8]) b.box([sx, 0.62, L / 2 + 0.04], [0.28, 0.12, 0.06], R('#fff6dc'), { mat: 'light', emi: 1.4 });
      for (const sx of [-0.8, 0.8]) b.box([sx, 0.66, -L / 2 - 0.03], [0.24, 0.14, 0.05], R('#c8322b'), { mat: 'light', emi: 0.8 });
      /* 两道门：前门在后轮之前、中门在两轴之间（真实低地板公交的布置）。
         门缝用 metal 薄条而不是"画"上去 —— 它得在侧窗带外面凸出来一点才看得见。 */
      for (const dz of [2.9, -0.6]) {
        b.box([1.05, 0.9, dz], [0.03, 1.7, 0.9], R('#39424a'), { mat: 'metal' });
        b.box([-1.05, 0.9, dz], [0.03, 1.7, 0.9], R('#39424a'), { mat: 'metal' });
      }
      b.box([0, 2.66, 0], [1.9, 0.06, L * 0.56], R('#c8cfd4'), { mat: 'metal' });            // 顶空调
      return b.finish();
    }
    const van = kind === 'van', suv = kind === 'suv';
    const L = van ? 5.4 : suv ? 4.7 : 4.5;
    const W = van ? 1.90 : 1.80;
    const ride = suv ? 0.20 : van ? 0.14 : 0.06;      // 离地间隙：SUV 一眼比轿车高
    const cabH = van ? 1.35 : suv ? 0.82 : 0.58;      // 座舱高
    const cabY = ride + 0.62;
    const zc = van ? -L * 0.06 : -L * 0.04;           // 厢式车的座舱更靠前（车头短）
    wheel(0.80, L * 0.32, suv ? 0.38 : 0.32); wheel(0.80, -L * 0.32, suv ? 0.38 : 0.32);
    /* ---- 三箱式：下盘 / 主车身 / 引擎盖 / 行李箱，四段不同高度的 paint ---- */
    b.box([0, ride + 0.18, 0], [W, 0.22, L * 0.96], R(col), { mat: 'paint' });
    b.box([0, ride + 0.46, 0], [W * 0.99, 0.34, L], R(col), { mat: 'paint' });
    if (!van) {
      b.box([0, ride + 0.66, L * 0.30], [W * 0.92, 0.10, L * 0.30], R(col), { mat: 'paint' });   // 引擎盖
      b.box([0, ride + 0.68, -L * 0.33], [W * 0.92, 0.12, L * 0.26], R(col), { mat: 'paint' });  // 行李箱盖
    }
    /* ---- 座舱 + 顶板（顶板比车身窄一圈，才有"肩线"） ---- */
    b.box([0, cabY + cabH / 2, zc], [W * (van ? 0.98 : 0.90), cabH, L * (van ? 0.72 : 0.40)], R(col), { mat: 'paint' });
    b.box([0, cabY + cabH + 0.02, zc], [W * 0.66, 0.04, L * (van ? 0.60 : 0.26)], R(col), { mat: 'paint' });
    b.box([0, cabY + cabH * 0.60, zc], [W * (van ? 1.00 : 0.94), cabH * 0.44, L * (van ? 0.68 : 0.38)], R('#1d242a'), { mat: 'glassSoft' });
    /* 倾斜前风挡：ax2 同时给 y 与 −z，才有"往后倒"的那一度 ---- */
    if (!van) {
      const wz = L * 0.155, wy = cabY + cabH * 0.52;
      b.plate([0, wy, wz], [W * 0.78, 0, 0], [0, cabH * 0.56, -L * 0.115], N([0, 0.86, 0.51]), R('#1d242a'), { mat: 'glassSoft' });
    } else {
      b.box([0, cabY + cabH * 0.62, L * 0.30], [W * 0.96, cabH * 0.5, 0.06], R('#1d242a'), { mat: 'glassSoft' });
    }
    /* ---- 后视镜 / 格栅 / 灯 ---- */
    for (const sx of [-1, 1])
      b.box([sx * (W / 2 + 0.09), cabY + cabH * 0.44, L * 0.115], [0.14, 0.05, 0.06], R(col), { mat: 'paint' });
    b.box([0, ride + 0.44, L / 2 - 0.01], [W * 0.50, 0.12, 0.04], R('#20262b'), { mat: 'metal' });
    for (const sx of [-0.58, 0.58]) {
      b.box([sx, ride + 0.56, L / 2 - 0.04], [0.30, 0.12, 0.06], R('#fff6dc'), { mat: 'light', emi: 1.2 });
      b.box([sx, ride + 0.58, -L / 2 + 0.04], [0.30, 0.10, 0.05], R('#c8322b'), { mat: 'light', emi: 0.7 });
    }
    b.box([0, ride + 0.58, -L / 2 + 0.03], [W * 0.72, 0.05, 0.04], R('#d8443c'), { mat: 'light', emi: 0.7 }); // 尾灯带
    if (suv) for (const sx of [-0.34, 0.34])
      b.box([sx, cabY + cabH + 0.09, zc], [0.06, 0.05, L * 0.26], R('#8f999f'), { mat: 'metal' });            // 行李架
    if (van) {
      b.box([W / 2 + 0.005, cabY + cabH * 0.42, -L * 0.10], [0.02, cabH * 0.72, L * 0.30], R('#39424a'), { mat: 'metal' });
      b.box([-W / 2 - 0.005, cabY + cabH * 0.42, -L * 0.10], [0.02, cabH * 0.72, L * 0.30], R('#39424a'), { mat: 'metal' });
      b.box([0, cabY + cabH * 0.42, -L / 2 - 0.02], [W * 0.94, cabH * 0.72, 0.03], R('#39424a'), { mat: 'metal' });
    }
    if (kind === 'taxi') b.box([0, cabY + cabH + 0.10, 0.1], [0.5, 0.12, 0.24], R('#d9a947'), { mat: 'light', emi: 0.5 });
    return b.finish();
  }

  /** 按材质归组：draw 时每辆车只有 2~4 个批次。 */
  function groupByMat(meshes) {
    const out = {};
    for (const m of meshes) (out[m.mat] || (out[m.mat] = [])).push(m);
    return out;
  }

  class StreetTraffic {
    /**
     * @param line LineRuntime（al / isElevated / waterRanges）
     */
    constructor(line) {
      this.line = line;
      this.al = line.al;
      this.water = (line.waterRanges && line.waterRanges()) || [];
      /* 车型表：涂装变体各烘一份。公交车在"车型池"里占一席，其余是社会车。 */
      this.variants = [];
      /* 车身的漆面与金属件合并进一个专属族（见 `renderer.js` 的 `carShell`）：
         一辆车的批次从 5 族降到 4 族，而车漆高光从此可以单独调，不必再动全局
         `paint`（那会连着全城的标线、色带、店招一起变）。
         **轮胎故意不并**：橡胶是这堆零件里唯一"材质差异看得见"的地方（深色 +
         带纹理的胎圈），而且 `sphere` 不写逐顶点色 —— 并进去之后判据就连"这辆车
         有没有轮子"都量不到了（实测：合并后五种车型的轮子顶点各 0 个）。
         合并发生在 `groupByMat` **之前**：车型代码里仍按"漆 / 金属 / 橡胶"写材质，
         那是造型事实；"上屏分几批"是渲染事实，两边不必互相污染。 */
      /* 车型表：**一种车型一份几何，涂装走"按实例给色"（第 135 条）**。
         以前是 (车型 × 涂装) 各烘一份 —— 而 `push()` 没把 `col` 存进变体记录，
         `_vIndex` 的键因此全是 `sedan|undefined`，`variantIndex()` 查 `sedan|3`
         永远查不到、退回 `_byKind` 的第一个 sedan ⇒ **13 个变体里只有 5 个真被用到，
         七档轿车漆在画面上只有一档**（判据 J 组以前只量"有几个变体"，量不到
         "哪一列车用的是哪份几何"，所以这件事红不了）。
         现在几何按车型（5 份），颜色是每实例三个 float：涂装真的上屏，
         而批次从"正确实现 13 变体 × 5 族 = 65"塌回 5 × 5 = 25。
         车漆顶点写白，让实例色乘进去；深色饰条（格栅/门缝/裙板/前脸/路牌）
         走 `carTrim` —— 它跟着染就不是那辆车了。 */
      const push = (kind) => {
        const ms = buildVehicle(kind, '#ffffff');
        for (const m of ms) {
          if (m.mat === 'paint') m.mat = 'carShell';
          else if (m.mat === 'metal') m.mat = 'carTrim';
        }
        this.variants.push({ kind, groups: groupByMat(ms) });
      };
      for (const k of ['sedan', 'taxi', 'suv', 'van', 'bus']) push(k);
      this._kinds = this.variants.map(v => v.kind);
      /* 涂装表对外暴露一份：判据要能问"这一辆该是什么色"，而不是自己再抄一份 hex
         （抄一份就是第二个真值，改了 CAR_COLORS 判据还会绿）。 */
      this.tints = CAR_TINT;
      /* 密度：每车道每 70 m 一辆（车道 3→4 条之后总量与原来持平）。
         车道中心读 `SH.ROAD.lanes` —— 以前这里写死 25 / 34.5 / 44，而那三个数
         正是 world.js 烘在路面上的**车道虚线位置**，于是每一辆车都横跨在
         分界线上、看着像同时占两条车道。虚线是分界，不是车道中心。 */
      this.cars = [];
      for (const side of [-1, 1]) for (const lane of SH.ROAD.lanes) {
        const n = Math.ceil(this.al.total / 70);
        for (let i = 0; i < n; i++) {
          const r1 = rand01('car' + i, side * 31 + lane);
          const r2 = rand01('carv' + i, side * 57 + lane);
          const v = 8.5 + r2 * 7;                  // 30~56 km/h
          this.cars.push({
            id: this.cars.length, side, lane,
            /* lat = 当前横向位置（社会车恒回到 lane；公交进站并到外道） */
            lat: lane,
            s: (i + r1) * (this.al.total / n) % this.al.total,
            v, baseV: v,
            kind: r1 < 0.10 ? 'bus' : (r1 < 0.22 ? 'suv' : r1 < 0.30 ? 'van' : r1 < 0.36 ? 'taxi' : 'sedan'),
            col: Math.floor(r2 * CAR_COLORS.length) % CAR_COLORS.length,
            stop: -1, dwell: 0, stopS: null,     // 公交车：下一停靠站 / 剩余停靠时间 / 刚服务过的站
          });
        }
      }
      /* GPU 批次：网格在 attach(r) 里上传（tag 'street'），换线时 detach 释放。
         以前直接把生网格喂给 r.draw —— 那里吃的是上传后的批次，生网格
         会被静默跳过，画面上"有路没车"。 */
      this.gpu = null;
      this.maxPerVariant = 16;                      // 单变体实例上限（先过视锥，再按距离留最近的）
      /* 车型 → 变体下标：draw() 的分组热路径，别每车每帧线性扫变体表。
         涂装不在这个键里（第 135 条：颜色是每实例的 tint，不是每涂装的几何）。 */
      this._byKind = {};
      this.variants.forEach((v, i) => { if (this._byKind[v.kind] == null) this._byKind[v.kind] = i; });
      /* ---- 高架快速路上的车流 ----
         目标里那句"路上也得有汽车**在高架跑**"要的是这个：旁边那条分幅高架
         上得有车在跑，而不是只有一条空桥面。桥面几何在 world.js 里烘，
         高度函数与它**同一份**（`SH.elevFor`），所以车不会悬在桥面上方或埋进梁里。
         两幅各两条车道、限速 80~100 km/h、每 55 m 一辆；没有公交站、没有并线。 */
      /* blocks 与 world.js 同一份：观景机位通视带里不建桥，那里也就不能有桥上车。
         两边各算各的段表，就会出现"车跑在没有桥的高度上"（判据抓到过）。 */
      this.elev = SH.elevFor(this.al, line.stations,
        (SH.sightCorridors ? SH.sightCorridors(line) : [])
          .filter(c => c.side === SH.elevSide(line.stations))
          .map(c => [c.s0 - 400, c.s1 + 400])
          .concat(((line.waterRanges && line.waterRanges()) || []).map(w => [w[0] - 24, w[1] + 24])));
      this.deckCars = [];
      const E = SH.ELEV_WAY, CW = [-E.gap / 2 - E.cw / 2, E.gap / 2 + E.cw / 2];
      const eS = SH.elevSide(line.stations);
      for (let ci = 0; ci < 2; ci++) {
        const cl = eS * (E.lat + CW[ci]);
        /* 分幅各自单向，方向与**地面街同一条规则**（`SH.elevDir`：相对本路中心，
           lat 大的那一幅走 +s）。以前写死 `ci === 0 ? 1 : -1`，两幅不会对着开所以
           画面上读不出来，但它与地面是两套规则 —— 而这一条改动之后一辆车要
           从地面幅一路开上匝道，跨的是同一个方向定义，两套规则会在坡脚翻转。 */
        const dir = SH.elevDir(eS, CW[ci]);
        /* 哪一条是**外侧（慢车）道**：右侧通行下 dir=+1 的司机右手指向 +lat ⇒
           慢车靠的那条是 lat 最大的；反向幅取最小。这一条不是装饰 —— 桥面车流
           一旦有了跟驰，慢车占内侧道就会把整幅堵成一列火车（真实快速路靠
           "货车靠右 + 后车并线绕行"两条一起才不堵）。 */
        const outer = dir > 0 ? Math.max.apply(null, E.lanes) : Math.min.apply(null, E.lanes);
        for (let li = 0; li < E.lanes.length; li++) {
          const off = E.lanes[li];
          const n = Math.ceil(this.al.total / 55);
          for (let i = 0; i < n; i++) {
            const r1 = rand01('dc' + i, ci * 17 + off * 7);
            const r2 = rand01('dcv' + i, ci * 23 + off * 11);
            /* 混速：外侧道抽 26% 做厢式货车，跑 55~62 km/h（快速路最低限速档）。
               没有速度差就没有"车流"，只有一排平移的盒子 —— 跟驰与并线都无从发生。 */
            const kind = off === outer && r1 > 0.74 ? 'van'
              : r1 < 0.12 ? 'van' : r1 < 0.22 ? 'taxi' : 'sedan';
            const slow = kind === 'van' && off === outer && r1 > 0.74;
            const v = slow ? 15.5 + r2 * 2 : 22 + r2 * 6;  // 轿车档仍是 80~100 km/h
            this.deckCars.push({
              id: this.deckCars.length, deck: true,
              lat: cl + off,                               // 带符号的横向（draw 里不再乘 side）
              ci, cl, lane: li, merging: null, blocked: 0,     // 跟驰/并线用的车道身份
              dir,                                         // 分幅各自单向
              /* 起点抖动必须与跟驰的目标车头距**相容**：原来写 `(i + r1) * 间距`，
                 相邻两辆的起点差可以小到 0 —— 定速时代不相撞只是因为同速，一旦有了
                 跟驰，开局就有人贴在前车 16 m 处，而它的目标车头距是 40 m，
                 于是第一帧就刹到 0，刹车波向后放大成整幅堵死（实测中位车速掉到 12 m/s）。
                 现在抖动 0.4~0.6 槽 ⇒ 最小初始间距 0.8 × 55 = 44 m，宽于目标车头距。 */
              s: (i + 0.4 + r1 * 0.2) * (this.al.total / n) % this.al.total,
              v, baseV: v,
              kind,
              col: Math.floor(r2 * CAR_COLORS.length) % CAR_COLORS.length,
            });
          }
        }
      }
      for (const c of this.deckCars) this.cars.push(c);
      /* 高峰抽样按 `id % 100` 取，两套车各自的 id 必须全局唯一，
         否则高架车会与地面车抢同一批抽样槽位（密度对不上账）。 */
      this.cars.forEach((c, i) => { c.id = i; });
      /* ---- 地面路口信号 ----
         灯色只由**绝对时钟 + 路口编号 + 行车方向**算（`SH.roadLamp`），
         所以重开一局、换个烘焙窗口，同一个路口的灯序不变。
         本方向的红/黄就是对面那一股的红/绿（错半周期），两股不会同时绿。 */
      this.jx = SH.junctions(line);
      this.clock = 0;
      /* 同车道跟驰参数：红灯排队时两列车头必须保持 8 m，不然画面上是"一摞车"。
         减速度 3.2 m/s² 是城市小客车的常规舒适-紧急之间；制动曲线故意只用到它的
         八成（下面 `0.8 * brake`）—— 按满值规划，离散积分必然追不上 √(2ad) 那条
         越近越陡的曲线，实测一列 54 km/h 的空车会在 80 m 外开始刹、还是压过停车线 42 m。 */
      this.gap = 8; this.brake = 3.2; this.accel = 1.15;
      /* 公交停靠点：与 world.js 的候车亭**同一张表**（SH.ROAD.bus），
         相位/间隔/左右交替三处同源，公交车才停得进站而不是停进行车道。 */
      this.stops = [];
      for (let sB = SH.ROAD.bus.phase; sB < this.al.total; sB += SH.ROAD.bus.pitch) {
        const side = (Math.round((sB - SH.ROAD.bus.phase) / SH.ROAD.bus.pitch) % 2) ? 1 : -1;
        this.stops.push({ s: sB, side });
      }
      /* ---- 斑马线上真的过街的人（§7.9 剩下的那半条）----
         行人灯早就联动了，可路上永远没有人横穿 —— "灯给人看"这件事只完成了一半。
         每一处斑马线（= `SH.junctions` 里 `exit` 那批，与 world.js 烘条纹同一份）
         放 2~4 个人，只在 `SH.walkLamp` 给 `walk` 的时候走；`flash` 期间**继续走完**
         （闪烁的语义是"清空斑马线"，此时把人钉在原地反而是把人留在车流前的
         车道中央）；`dont` 期间在路缘等。
         步态相位 = 走过的米数 ÷ `SH.PAX_STEP`，与站台人群同一个式子。 */
      this.peds = [];
      for (const j of this.jx) {
        if (!j.exit) continue;
        const n = 2 + (SH.hash32('pedn' + j.i, 11) % 3);
        for (let k = 0; k < n; k++) {
          /* 开局把人放在**路缘**而不是斑马线正中：人是从人行道上来等灯的，
             而把初始态摆在带上，等于凭空让三个人在红灯时站在行车道上
             （第一版就是这么开局，"在带上却是 dont"的样本全来自这里）。 */
          const u0 = rand01('pedu' + j.i, k) < 0.5 ? 0 : 1;
          this.peds.push({
            j, side: j.side,
            u: u0,                                   // 0 = 人行道那一端，1 = 内侧那一端
            dir: u0 ? -1 : 1,
            walked: 0,                               // 相位用的"已走米数"
            h: 1.56 + rand01('pedh' + j.i, k) * 0.28,
            hue: SH.PAX_HUES[SH.hash32('pedc' + j.i, k) % SH.PAX_HUES.length],
            wait: rand01('pedt' + j.i, k) * 14,      // 错开第一批出发时间，别整排同迈
          });
        }
      }
    }

    /** 行人此刻该不该在斑马线上走（单点：判据与 `update` 读同一个式子）。 */
    pedLamp(p) { return SH.walkLamp(this.clock, p.j.i); }

    _inWater(s) { return this.water.some(w => s >= w[0] - 40 && s <= w[1] + 40); }

    /** 变体 = 车型（第 135 条：涂装走实例色，不再是几何）。查不到车型时退回 0 号
     *  是**兜底**（宁可画成轿车也别让这辆车消失），但这种情况本身是缺陷，
     *  所以计个数让判据能看见（`_kindMiss`）。 */
    variantIndex(c) {
      const i = this._byKind[c.kind];
      if (i != null) return i;
      this._kindMiss = (this._kindMiss || 0) + 1;
      return 0;
    }

    /** 街面车流的跟驰表（car → 同方向的前车）。
     *  **不每帧重建**：同方向里快车只会贴到慢车后面、不会穿过它，所以组内顺序稳定；
     *  公交换的是车道不是方向，不影响这张表。只有"越过里程接缝取模"要重排
     *  （推进处置 `_carDirty`）。与 `_deckTable()` 是同一条纪律：
     *  每帧重建的代价实测是 `update` 的一大半（两次 sort + 一个 7788 项的 Map）。 */
    _carLead() {
      if (this._carLeads && !this._carDirty) return this._carLeads;
      this._carDirty = false;
      const q1 = [], qm = [];
      for (const c of this.cars) { if (c.deck) continue; (c.side > 0 ? q1 : qm).push(c); }
      q1.sort((a, b) => a.s - b.s); qm.sort((a, b) => b.s - a.s);
      const m = new Map();
      for (const list of [q1, qm]) for (let i = 0; i + 1 < list.length; i++) m.set(list[i], list[i + 1]);
      this._carLeads = m;
      return m;
    }

    /** 高架桥面的跟驰表：按"哪一幅 + 哪一条车道"分组，组内按**行车方向**排序
     *  （dir=−1 的那幅要排成降序，否则"前方最近的一辆"会算成后方那一辆 ——
     *  与地面 q1/qm 那一对是同一个坑），然后把"下一辆"直接挂到每辆车的 `next` 上，
     *  使推进循环里一次哈希查表都不做。
     *  **这张表不每帧重建**：同车道里快车只会贴到慢车后面、不会穿过它，所以组内
     *  顺序是稳定的；只有"并线完成"与"越过里程接缝"两件事会改它，两处各自置一次
     *  `_deckDirty`。每帧重建的代价实测把 test-street 从 2.5 s 拖到 98 s
     *  （判据里还跑着一小时的行人长仿真）—— 加机制的人必须同时回答它值多少钱。 */
    _deckTable() {
      if (this._deckGroups && !this._deckDirty) return this._deckGroups;
      this._deckDirty = false;
      const g = new Map();
      for (const c of this.cars) {
        if (!c.deck) continue;
        const k = c.ci * 8 + c.lane;
        let a = g.get(k);
        if (!a) { a = []; g.set(k, a); }
        a.push(c);
      }
      for (const a of g.values()) {
        const dir = a[0].dir;
        a.sort((x, y) => (x.s - y.s) * dir);
        for (let i = 0; i < a.length; i++) a[i].next = i + 1 < a.length ? a[i + 1] : null;
      }
      this._deckGroups = g;
      return g;
    }

    /** 高架桥面上一辆车的一步：跟驰 → 被挡就并到内侧道 → 推进里程。
     *  单独成方法而不是塞进 `update` 的大循环：那一轮要过七千多辆车，塞进去
     *  之后整个 `update` 被 V8 判成不可内联，实测每帧多 3 ms（test-street
     *  从 51 s 涨到 98 s）。分开写两边各自可优化 —— 加机制要顺手算它值多少钱。
     *
     *  三条口径写死在这里，别改回"看起来更简单"的写法：
     *  ① **跟驰的收敛目标是前车的速度，不是 0**。直接套红灯那条 √(2ad)
     *     （"到停车线正好刹停"）会把 55 m 平均间隔的自由流压成
     *     `sqrt(2×2.56×23) = 10.8 m/s`，整幅桥面集体 13 km/h —— 那是堵车不是车流。
     *  ② **贴太近时必须能比前车更慢**（`dLead < 6` 那一档）。少了它，一次并线
     *     留下的 −4.4 m 重叠会被"永远追平前车速度"锁死，再也散不开。
     *  ③ 变道是**渐变**的（横向 0.9 m/s ⇒ 换一条 5.5 m 的车道要 6 s），所以起手
     *     的空隙必须按这 6 s 留（±45 m），而且变道途中还要对着目标车道那辆前车
     *     收速（`c.nextTo`）—— 只查后方 26 m 的初版就是这么插到并排车前面去的。 */
    _stepDeck(c, dt, total, dg) {
      const LAN = SH.ELEV_WAY.lanes;
      let vmax = c.baseV;
      const follow = lead => {
        if (!lead) return;
        const dLead = (lead.s - c.s) * c.dir - 4.6;
        const want = Math.max(8, 1.1 * c.v);
        if (dLead >= want + 6) return;
        let cap = lead.v + Math.sqrt(2 * this.brake * 0.8 * Math.max(0, dLead - want));
        if (dLead < 6) cap = Math.min(cap, Math.max(0, lead.v - 4));
        if (cap < vmax) vmax = cap;
      };
      follow(c.next);
      if (dt > 0) {
        c.blocked = vmax < 0.82 * c.baseV ? c.blocked + dt : 0;
        /* 内侧道在哪一边由行车方向定（dir=+1 时 lat 小的一侧是内侧，反向幅相反）：
           写死 `lane-1` 会让一半的车往路肩并。 */
        const inner = c.dir > 0 ? 0 : LAN.length - 1;
        if (c.blocked > 3 && c.merging == null && c.lane !== inner) {
          const to = c.lane + (c.lane < inner ? 1 : -1);
          const tgt = dg.get(c.ci * 8 + to);
          let free = true;
          if (tgt) for (const o of tgt) {
            if (o === c) continue;
            const d = (o.s - c.s) * c.dir;
            if (d > -45 && d < 45) { free = false; break; }
          }
          /* **决定并线的这一刻就把它算进目标车道**（`c.lane = to`），横向再慢慢挪。
             初版是"挪到位才改 `lane`"，于是这 6 秒里目标车道那辆后车根本不把
             它当前车 —— 实测留下 −1 m 的重叠且散不开。并线是"插进车流"，
             不是"到点了才出现在车流里"。 */
          if (free) { c.lane = to; c.merging = to; this._deckDirty = true; }
          c.blocked = 0;
        }
        if (c.merging != null) {
          const want = LAN[c.merging], cur = c.lat - c.cl, step = 0.9 * dt, dd = want - cur;
          if (Math.abs(dd) <= step) c.lat = c.cl + want;
          else c.lat = c.cl + cur + (dd > 0 ? step : -step);
          if (c.lat === c.cl + want) c.merging = null;
        }
      }
      c.v = c.v < vmax ? Math.min(vmax, c.v + this.accel * dt) : Math.max(vmax, c.v - this.brake * dt);
      c.s += c.v * dt * c.dir;
      if (c.s < 0 || c.s >= total) {
        if (c.s < 0) c.s += total; else c.s -= total;
        this._deckDirty = true;                            // 越过里程接缝 = 组内顺序要重排
      }
    }

    /** 本车前方 170 m 内最近的一个路口（含已压过停车线一点点的那个，
     *  否则车会在"下一个路口"与"当前路口"之间跳，灯色跟着抖）。 */
    _nextJunction(c) {
      const J = SH.JUNCTION;
      let best = null, bd = 170;
      for (const j of this.jx) {
        const d = (SH.junctionStop(j, c.side) - c.s) * c.side;
        if (d < -6 || d > bd) continue;
        best = j; bd = d;
      }
      return best;
    }

    /** 亮着的那枚镜片：世界坐标由 `SH.signalHead` 给（与烘焙的灯箱同一个函数）。
     *  灯箱是深色金属，镜片位置就是三枚暗玻璃的位置 —— 只把当前灯色那一枚点亮。 */
    drawSignals(r, eye, night) {
      if (!this.gpu || !this._lensGpu || !this.jx.length) return;
      const e2 = 620 * 620, by = { red: [], amber: [], green: [] };
      /* 行人灯（§7.9）：相位由 SH.walkLamp 单点给 —— 两方向机动车全红才亮绿人。
         闪烁末段按 0.5 占空比点绿（清空已在斑马线上的行人）；禁行亮红人。 */
      const byPed = { red: [], green: [] };
      for (const j of this.jx) {
        const fr = this.al.frame(j.s);
        if (((fr.p[0] - eye[0]) ** 2 + (fr.p[2] - eye[2]) ** 2) > e2) continue;
        const wl = SH.walkLamp(this.clock, j.i);
        const pedOn = wl === 'walk' || (wl === 'flash' && (this.clock % 1) < 0.5);
        for (const sgn of [-1, 1]) {
          const lamp = SH.roadLamp(this.clock, j.i, sgn);
          const h = SH.signalHead(this.al, j, sgn);
          const q = this.al.level(fr);
          const rr = [q.r[0] * sgn, q.r[1] * sgn, q.r[2] * sgn], ff = [q.f[0] * sgn, q.f[1] * sgn, q.f[2] * sgn];
          by[lamp].push(SH.m4basis(rr, q.u, ff, h.lens[lamp === 'red' ? 2 : lamp === 'amber' ? 1 : 0]));
          /* 行人灯两方向各一台（共杆），同一相位 —— 只在 sgn=+1 那台计一次，
             免得同相位画两遍 */
          if (pedOn) byPed.green.push(SH.m4basis(rr, q.u, ff, h.pedLens[1]));
          else byPed.red.push(SH.m4basis(rr, q.u, ff, h.pedLens[0]));
        }
      }
      const ov = night > 0.02 ? { emi: 1 + 2.2 * night } : null;
      let n = 0;
      for (const k of ['red', 'amber', 'green']) {
        if (!by[k].length) continue;
        n += by[k].length;
        for (const b of this._lensGpu[k]) {
          if (r.drawInstanced) r.drawInstanced(b, by[k], ov);
          else for (const M of by[k]) r.draw(b, M, ov);
        }
      }
      for (const k of ['red', 'green']) {
        if (!byPed[k].length) continue;
        n += byPed[k].length;
        for (const b of this._pedGpu[k]) {
          if (r.drawInstanced) r.drawInstanced(b, byPed[k], ov);
          else for (const M of byPed[k]) r.draw(b, M, ov);
        }
      }
      this._signalsDrawn = n;
    }

    attach(r) {
      if (this.gpu) return;
      /* 三枚镜片各烘一份（红/黄/绿），运行时只画当前灯色那一枚 */
      this._lensGpu = {};
      for (const [k, col] of [['red', '#e8483a'], ['amber', '#efb23c'], ['green', '#3fd07a']]) {
        const b = new SH.Builder();
        b.box([0, 0, 0], [0.24, 0.24, 0.10], rgbOf(col), { mat: 'light', emi: 1.6 });
        this._lensGpu[k] = r.upload(b.finish(), 'street');
      }
      /* 行人灯镜片（§7.9）：上红下绿两枚，运行时按 SH.walkLamp 点亮 ——
         与机动车镜片同一套"暗体烘死、灯头运行时画"。 */
      this._pedGpu = {};
      for (const [k, col] of [['red', '#e8483a'], ['green', '#3fd07a']]) {
        const b = new SH.Builder();
        b.box([0, 0, 0], [0.14, 0.14, 0.08], rgbOf(col), { mat: 'light', emi: 1.5 });
        this._pedGpu[k] = r.upload(b.finish(), 'street');
      }
      /* ---- 过街行人的精灵网格 ----
         人形**不另画一份**：调产品自己的 `SH.WorldBuilder.person`，把它烘在
         一个**水平**规范框架（`al.level`：不带超高与坡度）上的顶点整体平移回原点，
         运行时用实例矩阵摆位置与朝向。选水平框架是因为"人是站铅垂的"，
         跟着轨道倾斜会歪着走。
         三档：站立（不传 gait，与站台人群逐字节同一套几何）+ 左右迈腿各一档；
         取档 = floor(走过的米数 ÷ 步长) % 3 —— 相位与位移同源这条纪律，
         过街的人也不能例外。 */
      this._xpedGpu = [];      /* 过街行人的精灵批次（与行人灯镜片 `_pedGpu` 是两回事）*/
      {
        const fr0 = this.al.level(this.al.frame(20));
        const o0 = this.al.world(fr0, 0, 0);
        for (const g of [null, 0.25, 0.75]) {
          const b = new SH.Builder();
          SH.WorldBuilder.person(b, this.al, fr0, 0, 1, {
            h: 1.70, th: 0.42, hue: '#3a4a5d', face: '#c8a486', hair: '#191d21',
            yawJ: 0, dy: -0.42, gait: g,
          });
          const ms = b.finish();
          for (const m of ms) for (let i = 0; i < m.pos.length; i += 3) {
            m.pos[i] -= o0[0]; m.pos[i + 1] -= o0[1]; m.pos[i + 2] -= o0[2];
          }
          const gm = groupByMat(ms), out = {};
          for (const mat of Object.keys(gm)) out[mat] = r.upload(gm[mat], 'street');
          this._xpedGpu.push(out);
        }
      }
      this.gpu = this.variants.map(v => {
        const out = {};
        for (const mat of Object.keys(v.groups)) out[mat] = r.upload(v.groups[mat], 'street');
        return out;
      });
    }

    detach(r) {
      if (!this.gpu) return;
      r.dropTag('street');
      this.gpu = null;
    }

    update(dt, camS) {
      const total = this.al.total;
      this.clock += dt;
      /* 跟驰表与桥面表都**不每帧重建**（见 `_carLead()` / `_deckTable()`）：
         同方向里快车只会贴到慢车后面、不会穿过它 ⇒ 组内顺序是稳定的，
         只有"越过里程接缝"需要重排。原来这里每帧两次 sort + 一个 7788 项的 Map。 */
      const leadOf = this._carLead();
      const dg = this._deckTable();
      /* ---- 分级推进（帧率账）----
         街面车流一轮 7788 辆，全量积分实测 2.4 ms/帧（占掉一帧的四成多），而 draw
         只画相机眼点 480 m 内的车。所以按里程分两档：
           · 近档 |Δs| ≤ NEAR_S（1500 m = 画程的三倍）—— 看灯、跟驰、进站，全量；
           · 远档 —— 不看灯也不跟驰，只按基准速度推进（一辆车三条算术）。
         远档**会**出现车队叠在一起：这是明知的代价，换掉的是七成 CPU。它成立的前提
         是那条"三倍"：任何一辆**被画出来**的车，都已经在近档里被全量积分过一公里多，
         队形早就散开了；而 480 m 外的重叠在屏幕上不到一个像素。
         第一版不是这么写的 —— 它把远档"每 4 帧并一次、一次积分 4dt"，我以为那只是
         步长变粗；实测同样 60 s 之后与全量档最大差到 **460 m**（粗步长让一辆车错过
         一次刹车，之后整列的队形都不一样）—— 那已经不是"精度"，是另一个结果。
         `camS` 不传（离线判据、烘焙检查、任何"没人看"的对账）时**一律全量**：
         分级只许影响没人看的时候，不许影响任何一条判据量到的行为。 */
      const cull = camS == null ? null : (s) => {
        let d = Math.abs(s - camS);
        if (d > total / 2) d = total - d;
        return d <= NEAR_S;
      };
      for (const c of this.cars) {
        if (cull !== null && !cull(c.s)) {
          c.s += c.baseV * dt * (c.deck ? c.dir : c.side);
          if (c.s < 0) { c.s += total; this._carDirty = true; }
          else if (c.s >= total) { c.s -= total; this._carDirty = true; }
          continue;
        }
        const h = dt;
        if (c.deck) { this._stepDeck(c, h, total, dg); continue; }
        /* ---- 让车真的停下：红灯 / 黄灯 / 前面那辆车的排队 ----
           制动曲线按 √(2a·d) 收：离停车线越近允许的速度越低，到线正好为 0。
           已经压过停车线的车不再往回刹（真实车不会倒车回停止线）。 */
        let vmax = c.baseV;
        const j = this._nextJunction(c);
        if (j) {
          const stopS = SH.junctionStop(j, c.side);
          const dStop = (stopS - c.s) * c.side;
          /* 前瞻：司机（和 ATO）看的是"我开到那条线时灯会是什么色"，不是"现在什么色"。
             只按当前灯色决策的话，黄灯末了离停车线还有 40 m 的车物理上刹不住，
             判据"红灯期间不许越线"就会稳定报出上百帧次越线 —— 那不是控制器坏，
             是控制器只看现在。τ 上限 6 s：太远的路口的灯还不该管。 */
          const tau = dStop > 0 ? Math.min(6, dStop / Math.max(1, c.v)) : 0;
          const lamp = SH.roadLamp(this.clock + tau, j.i, c.side);
          c.lamp = lamp;
          if (lamp !== 'green' && dStop > -0.5) {
            vmax = Math.min(vmax, Math.sqrt(2 * this.brake * 0.8 * Math.max(0, dStop)));
          }
        } else c.lamp = null;
        const lead = leadOf.get(c);
        if (lead) {
          const gap = (lead.s - c.s) * c.side - 4.6;
          vmax = Math.min(vmax, Math.sqrt(2 * this.brake * 0.8 * Math.max(0, gap - this.gap)));
        }
        c.v = c.v < vmax ? Math.min(vmax, c.v + this.accel * h) : Math.max(vmax, c.v - this.brake * h);
        let target = c.lane;
        /* 公交车：靠近前方本侧停靠点就减速 + **提前并入最外侧公交道**，停 7 s 再走。
           找"前方最近的同侧停靠点"：停靠点每 380 m 一个、左右交替，
           对某一侧来说有效间隔是 760 m。 */
        if (c.kind === 'bus' && h > 0) {
          const dir = c.side;
          /* 刚服务过的那个站要放行：驶过它 120 m 之后才重新算进"前方停靠点"。
             以前没有这一条 —— 停靠期间车不动，7 s 之后 d 仍然 < 8，于是 dwell
             每帧被续期，公交一辈子钉在那个站上（"加了一个新状态却没人回答
             谁把它关回去"这一族，与 AI 车永远张着门冻在站上是同一个错）。
             距离必须按**最短弧**折一次：还没到站的车算出来是"差一整圈"，
             直接和 120 比会把 stopS 当场清掉（实测：车停在站前 18 m 反复开门）。 */
          if (c.stopS != null) {
            let past = (c.s - c.stopS) * dir;
            if (past > total / 2) past -= total; else if (past < -total / 2) past += total;
            if (past > 120) c.stopS = null;
          }
          let best = null;
          for (const st of this.stops) {
            if (st.side !== c.side || st.s === c.stopS) continue;
            let d = ((st.s - c.s) * dir % total + total) % total;
            if (d < MERGE_AHEAD && (!best || d < best.d)) best = { d, s: st.s };
          }
          if (c.dwell > 0) { c.dwell -= h; target = SH.ROAD.busLane; }
          else if (best && best.d < 8) { c.dwell = 7; c.stopS = best.s; target = SH.ROAD.busLane; }
          else if (best && best.d < 55) { c.v = Math.max(3, c.v - 6 * h); target = SH.ROAD.busLane; }
          else if (best) target = SH.ROAD.busLane;      // 55~MERGE_AHEAD：只并线，不减速
        }
        if (c.dwell <= 0) {
          /* baseV 在构造时就有（以前这里写 `c.baseV || (c.baseV = c.v)`，
             而那行是在进站减速**之后**才第一次取 v —— 于是公交第一次靠站之后
             基准速度被永久钉死在 3 m/s，此后整局都在 11 km/h 蠕行。 */
          if (c.kind === 'bus') c.v = Math.min(c.baseV, vmax, c.v + 4 * h);
          c.s += c.v * h * c.side;
          if (c.s < 0) { c.s += this.al.total; this._carDirty = true; }
          else if (c.s >= this.al.total) { c.s -= this.al.total; this._carDirty = true; }
        }
        /* 横向并入：限速 1.6 m/s —— 30 km/h 下走完一个 3~4 m 的车道宽约 6 s，
           是一条真实的换道轨迹而不是一帧瞬移。以前公交"靠站"是停在行车道正中，
           候车亭立在 60 m 外的人行道上，画面读起来是路边违停而不是进站。 */
        if (h > 0) {
          const dl = target - c.lat, mx = 1.6 * h;
          c.lat = Math.abs(dl) <= mx ? target : c.lat + (dl > 0 ? mx : -mx);
        }
      }
      /* ---- 过街行人推进 ----
         `walk` 才动、`flash` 继续走完（闪烁的语义是"清空斑马线"，此时把人钉在
         原地等于把他人留在车流前的车道中央）、`dont` 在路缘等。
         到端点后歇 5~14 s 再折返，所以任何时刻"斑马线上有没有人"都与灯色自洽 ——
         判据（test-street）逐秒对账的就是这三条。 */
      const span = SH.JUNCTION.crossLen, wv = SH.PAX_WALK_V;
      if (dt > 0) for (const p of this.peds) {
        p.moving = false;
        if (p.wait > 0) { p.wait -= dt; continue; }
        /* 在路缘（u 到端点）的人要**看清剩下的时间够不够走完**才踏上斑马线：
           只看"现在是绿灯"会把人放到车道中央，然后机动车红灯亮他还在那儿
           （第一版就是这么写的，实测 1.35% 的采样是"人在带上而灯已红"）。
           `SH.walkLeft > 0` 本身等价于"此刻是行人通行窗口"（窗口之外返回 0），
           所以这里**不再另看一次灯色** —— 那一行比余量检查更弱，写在一起只会
           把"没核对余量"这个真错掩盖掉（没有判据能证伪的机制就是死代码）。
           已经在带上的人（含闪烁期）一律继续走完：闪烁的语义是"快走清空"，
           此时把人钉在原地等于把他留在车流前的行车道上。 */
        const atEnd = p.u <= 0.001 || p.u >= 0.999;
        if (atEnd && SH.walkLeft(this.clock, p.j.i) < span / wv) continue;
        const step = wv * dt;
        p.moving = true;
        p.u += p.dir * step / span;
        p.walked += step;
        if (p.u >= 1 || p.u <= 0) {
          p.u = p.u > 0.5 ? 1 : 0;
          p.dir = p.u > 0.5 ? -1 : 1;
          p.wait = 5 + rand01('pedw' + p.j.i, (p.walked | 0) + p.u) * 9;
        }
      }
    }

/** 画**相机眼点** 480 m 内的车（按眼点而不是列车里程剔除：
 *  站台/街面机位的相机可以离列车几百米，按里程裁会把画面里的车全裁掉）。
 *  dt 在 update() 里推进；这里只管可见性。
 *  @param night 0..1 天黑档（`env.night`）：车灯/尾灯要跟着天黑亮起来
 *  @param dense 0..1 时段密度（与客流同源的 `SH.pax.rushFactor`）：早晚高峰
 *               街上的车就是比平峰多。抽样按车辆序号取，同一辆车不会每帧闪进闪出。
 *  对账：`_expect`（分组后按 cap 应提交数，由截断前的组大小独立算出）↔
 *       `_drawn`（真正提交给 GL 的数量）—— 任何"省下来"的指标（draw call 下降）
 *       都必须配一条"该给的都给了"的正向核账，否则优化做没做成功没人知道
 *       （这条项目里栽过一次：instanceCount 漏传，48 辆只画 1 辆）。
 *  绘制走**实例化**：按"车型×涂装"分组，每组每材质一次
 *  drawElementsInstanced —— 同几何同材质的车以前逐辆逐批提交，
 *  WebGL2 下 30 辆车只要 ~10 次 draw（perf 对账：street 视角 360 → ~270）。 */
    draw(r, eye, night, dense) {
      const e2 = 480 * 480, groups = new Map();
      const dn = (dense == null ? 1 : dense) * 100;
      const nk = Math.max(0, Math.min(1, night == null ? 0 : night));
      let want = 0;
      for (const c of this.cars) {
        if (!this.line.isElevated(c.s) || this._inWater(c.s)) continue;
        if (c.id % 100 >= dn) continue;
        const q = this.al.level(this.al.frame(c.s));
        /* 高架上的车按**桥面实际高度**摆：`elev.h(s)` 与烘出来的桥面同源，
           落地段车跟着一起落到地面，不会悬在 9 m 高的空气里。 */
        const dh = c.deck ? this.elev.h(c.s) : 0;
        /* 落地**不再是"消失"**：`foot()` 把坡道上的车一路横向并进桥下地面幅，
           所以一辆车从桥上开到地面是同一条轨迹，不是在坡道尽头蒸发。
           只有"这条路本身不存在"的里程才不画：视廊/水面挖断处
           （桥与地面幅在那儿都没烘 —— `blocked` 就是几何与车流共用的那张段表）。 */
        if (c.deck && this.elev.blocked(c.s)) continue;
        const foot = c.deck ? this.elev.foot(c.s, c.cl) : 0;
        const p = this.al.world(q, c.deck ? c.lat + foot : c.side * c.lat,
          this.al.streetDy(c.s) + 0.02 + dh);
        const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > e2) continue;
        /* 先按**视锥**筛，再按距离截断 —— 顺序反了就是以前这个下场：cap 留
           "离眼最近的 12 辆"，而最近的 12 辆全在桥面正下方或相机背后，
           于是提交数正常、上报一切绿灯，画面上却一辆车都没有。
           渲染器在 begin() 里已经算好视锥平面，这里白捡一次 boxInFrustum。 */
        if (r.boxInFrustum) {
          const mn = [p[0] - 6, p[1] - 0.3, p[2] - 6], mx = [p[0] + 6, p[1] + 3.6, p[2] + 6];
          if (!r.boxInFrustum(mn, mx, 12)) continue;
        }
        want++;
        const dir = c.deck ? c.dir : c.side;
        const rr = [q.r[0] * dir, q.r[1] * dir, q.r[2] * dir];
        /* 高架上的车要**跟坡**：桥面在落地段是斜的（斜的就是 `elev.h` 的差分），
           而实例矩阵原本只有 yaw —— 于是车"平着滑下坡"，前轮埋进防撞墙、后轮悬空。
           俯仰与烘桥面读同一个 `SH.pitchBasis`，两边各写一遍差分就是两个真值。
           `dir` 只乘在 right 与 fwd 上（手性不变），车头因此指向**行进方向**的那一侧坡。 */
        const bf = c.deck ? SH.pitchBasis(q.r, q.u, q.f, this.elev.grade(c.s)) : [q.u, q.f];
        const ff = [bf[1][0] * dir, bf[1][1] * dir, bf[1][2] * dir];
        const M = SH.m4basis(rr, bf[0], ff, p);
        const gi = this.variantIndex(c);
        const arr = groups.get(gi) || (groups.set(gi, { mats: [], d2s: [], dk: [], tint: [] }), groups.get(gi));
        arr.mats.push(M); arr.d2s.push(d2); arr.dk.push(!!c.deck);
        arr.tint.push(CAR_TINT[((c.col | 0) % CAR_TINT.length + CAR_TINT.length) % CAR_TINT.length]);
      }
      this._want = want; this._drawn = 0; this._expect = 0; this._deckDrawn = 0;
      /* 实例无排序必要（车不透明），超量时按距离留最近的。 */
      for (const [gi, g] of groups) {
        /* 应提交数按**截断前**的组大小独立算一遍：与下面真正提交的数对账，
           抓"分组/截断路径悄悄丢了一组车"。 */
        this._expect += Math.min(g.mats.length, this.maxPerVariant);
        if (g.mats.length > this.maxPerVariant) {
          const order = g.d2s.map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]).slice(0, this.maxPerVariant).map(x => x[1]);
          g.mats = order.map(i => g.mats[i]);
          g.dk = order.map(i => g.dk[i]);
          g.tint = order.map(i => g.tint[i]);   // 截断必须同步：错位一帧就是"这辆车穿那辆车的漆"
        }
        this._drawn += g.mats.length;
        this._deckDrawn += g.dk.filter(x => x).length;
        const gm = this.gpu[gi];
        /* 天黑给车灯加算：'light' 那一批是前后灯，白天 emi 1.0 就够，
           夜里要压过环境光才读得出"这辆车开着灯"。 */
        const ov = nk > 0.02 ? { emi: 1 + 2.6 * nk } : null;
        /* 这一组的每实例涂装色（第 135 条）。拍平成 3n 的 Float32Array 送进
           实例缓冲；`b.tint`（材质表说了算）决定哪几批真的乘它 —— 在这里
           按材质名再判一次就是第二个真值。 */
        const nI = g.mats.length, flat = new Float32Array(nI * 3);
        for (let i = 0; i < nI; i++) {
          const t = g.tint[i] || [1, 1, 1];
          flat[i * 3] = t[0]; flat[i * 3 + 1] = t[1]; flat[i * 3 + 2] = t[2];
        }
        if (r.drawInstanced) for (const mat of Object.keys(gm)) for (const b of gm[mat]) r.drawInstanced(b, g.mats, mat === 'light' ? ov : null, flat);
        else for (let i = 0; i < nI; i++) {
          for (const mat of Object.keys(gm)) for (const b of gm[mat]) {
            const o = { tint: g.tint[i] };
            if (mat === 'light' && ov) o.emi = ov.emi;
            r.draw(b, g.mats[i], o);
          }
        }
      }
      /* ---- 过街行人 ----
         剔除口径与车一致：**先视锥、再距离**（顺序反了就是"提交数正常而画面上
         一个人没有"那一族）。步态取档 = floor(走过的米数 ÷ 步长) % 3，
         所以腿与位置同源；站着等灯的人用站立档（腿并拢，与站台候乘同一套几何）。 */
      this._pedsDrawn = 0;
      if (this._xpedGpu && this._xpedGpu.length) {
        const J = SH.JUNCTION, groups = [ [], [], [] ];
        for (const p of this.peds) {
          if (!this.line.isElevated(p.j.s)) continue;
          const q = this.al.level(this.al.frame(p.j.s));
          const lat = p.side * (J.crossLat + J.crossLen / 2 - p.u * J.crossLen);
          const pos = this.al.world(q, lat, this.al.streetDy(p.j.s) + 0.02);
          const dx = pos[0] - eye[0], dy = pos[1] - eye[1], dz = pos[2] - eye[2];
          if (dx * dx + dy * dy + dz * dz > e2) continue;
          if (r.boxInFrustum) {
            const mn = [pos[0] - 1, pos[1] - 0.3, pos[2] - 1], mx = [pos[0] + 1, pos[1] + 2.2, pos[2] + 1];
            if (!r.boxInFrustum(mn, mx, 3)) continue;
          }
          const d0 = p.dir * p.side;
          const ry = Math.atan2(d0 * q.r[0], d0 * q.r[2]);
          const gi = p.moving ? (Math.floor(p.walked / SH.PAX_STEP) % 3 + 3) % 3 : 0;
          groups[gi].push(SH.m4trs(pos, 1, ry));
        }
        for (let gi = 0; gi < 3; gi++) {
          const mats = groups[gi];
          if (!mats.length) continue;
          this._pedsDrawn += mats.length;
          const gm = this._xpedGpu[gi];
          if (r.drawInstanced) for (const mat of Object.keys(gm)) for (const b of gm[mat]) r.drawInstanced(b, mats);
          else for (const M of mats) for (const mat of Object.keys(gm)) for (const b of gm[mat]) r.draw(b, M);
        }
      }
    }
  }

  SH.street = { StreetTraffic };
})(typeof window !== 'undefined' ? window : globalThis);
