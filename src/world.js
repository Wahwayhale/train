/* ============================================================================
 * world.js — 世界烘焙
 *
 * 一个 `LightField` + 一组烘焙函数，把"里程区间"变成顶点缓冲。
 *
 * 为什么这样能比南京版好看得多：
 *   南京版的隧道灯光靠"把灯画进贴图"，所以光斑跟着贴图走、不随几何变化，
 *   而且墙面明暗是恒定的。
 *   这里在烘焙阶段对每个顶点真实累加附近灯具的点光源贡献（含法向夹角与
 *   距离衰减），写进顶点色与自发光。于是：
 *     · 灯下的拱腰亮、背光的道床暗，是连续渐变的
 *     · 曲线内侧与外侧受光不同
 *     · 车站灯槽在站台边缘形成柔和的光带，而不是均匀一片
 *   代价是烘焙时的一次性计算，运行时零开销。
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { clamp, lerp, rgbOf, rng, hash32, rand01, smoothstep, fbm1, valueNoise1D } = SH;
const { Builder, Geo } = SH;

/* 胶轮 APM（浦江线）断面参数 —— **轨道与车辆共用这一份**。
   行车道中心 `laneLat` 与承重胎中心必须同一个数，导向轨的 `guideLat/guideTop`
   与水平导向轮的 `rollerLat` 必须互相咬得住；两边各写字面量的话，
   改轨道的人不会想到去改车，于是"胎压在空气上、轮夹着空气跑"，
   而顶点数、绕序、烘焙全部正常 —— 这一族的错从来不会被几何判据抓到。 */
SH.APM = { laneIn: 0.60, laneOut: 1.30, laneLat: 0.95, tyreW: 0.17, tyreR: 0.35,
  guideIn: 0.27, guideOut: 0.37, guideLat: 0.32, guideTop: 0.12, chanFloor: -0.30,
  rollerLat: 0.42, deckHalf: 2.10, deckBot: -0.55, deckTop: -0.35, conIn: 1.36, conOut: 1.44 };

const { cross, norm3 } = Geo;

/* ===================================================== 沿街楼群的占位范围
 * 高架两侧的城市是观景机位最大的威胁：楼心落在横向 69.5~97.5 m，楼体半宽最多
 * 12 m，楼脚在街面以下 0.1 m，楼高上限 = max(低层区 30, 高层区 46) × 1.6。
 * 由此推出三条硬边界——
 *   corridor  |横向| < 55.7 m：高架正下方的道路走廊（车行道是 ±55），保证没有楼
 *   roof      轨面上方 72.1 m（内侧车道）/ 46.5 m（外侧车道）：飞越屋顶线就不可能被挡
 *   outside   |横向| > 110.3 m：越过后 city() 不再产生任何楼
 * 所以拍侧景地标只有两种合法机位：待在走廊里，或者高过屋脊。
 * 跨江/跨河点另算——那些里程的楼群和街面被 waterRanges 整段挖掉了。
 *
 * 2026-10-01 这一条从 24~76 抬到 67~117，因为街面机位拍到**一栋楼站在车行道正中间**。
 * 走廊断面是车行道 ±55、人行道 57~64、临街地块 64~96，而楼道的最近一条在横向 28
 * （半宽 7.5 + 基座 ⇒ 占到 22~34）——**楼本来就是盖在马路上的**。以前从驾驶室
 * 11 m 高度往下看、以及从航拍高度看，都只看到"两侧有楼"，看不出它们脚下是沥青；
 * 只有行人机位把这件事摊开。真实高架路（沪闵路、中山北路）的第一排建筑
 * 也在 60~70 m 外：主路 + 辅路 + 绿化带 + 退让红线。
 */
const CITY_BAND = { min: SH.STREET_WALK.lotLine, max: 97.5, base: SH.STREET_Y - 0.1, hLo: [8, 30], hHi: [12, 46], hMul: 1.6, crown: 9.5 };
/* 黄昏投影的方向：ENVS.dusk.sunDir = [-0.72, 0.11, 0.68]，取反并归一化的 xz 分量。
   写死在这里是有意的 —— 户外只跑 dusk 一套环境，烘焙几何与它必须同源。 */
const _sd = SH.ENVS.dusk.sunDir, _sl = Math.hypot(_sd[0], _sd[2]);
const SHADOW_DIR = [-_sd[0] / _sl, -_sd[2] / _sl];
CITY_BAND.hMax = Math.max(CITY_BAND.hLo[1], CITY_BAND.hHi[1]) * CITY_BAND.hMul;
CITY_BAND.roof = CITY_BAND.base + CITY_BAND.hMax + CITY_BAND.crown;   // 屋脊 + 塔冠/机房
/* 横向占位要算上向外挑的部分：楼体半宽最大 12 m（w=8+16 之半），楼脚暗带
   再加 0.8 m，女儿墙/机房另算。取 12.8 m。 */
CITY_BAND.depth = 12.8;
/* 楼群的"车道"表：每条车道有自己的中心与限高。
   外侧那条压低有两个理由：① 观景相机的视线正是在横向 95~105 m 处掠过 72 m 屋脊，
   把高层区放那里，test-facade 实测三个机位看不见地标（抬相机高度也不行，抬到 136 m
   又变成"天空只占 7.7%"的俯拍，两头都错）；② 真实城市的高层塔楼沿街向内，
   高架外侧那条带子是物流园/旧里/低层商铺。
   **通视判据必须读这张表**：以前它拿全局屋脊去比，于是一条实际只有 57 m 的
   低层带把 71 m 的视线判成"被挡"——保守到失真。 */
CITY_BAND.lanes = [{ c: 71, hi: true }, { c: 96, hi: false }];
CITY_BAND.roofLo = CITY_BAND.base + CITY_BAND.hLo[1] * CITY_BAND.hMul + CITY_BAND.crown;
SH.cityRoofAt = lat => {
  const a = Math.abs(lat);
  let cap = -Infinity;
  for (const ln of CITY_BAND.lanes)
    if (Math.abs(a - ln.c) <= CITY_BAND.depth) cap = Math.max(cap, ln.hi ? CITY_BAND.roof : CITY_BAND.roofLo);
  return cap;
};
CITY_BAND.corridor = CITY_BAND.min - CITY_BAND.depth - 1;   // 10.2 m：高架正下方的空廊
/* 街面标高的唯一定义处在 core.js（SH.STREET_Y），取用一律走 al.streetDy(s)。 */
CITY_BAND.outside = CITY_BAND.max + CITY_BAND.depth;        // 88.8 m：越过就没有楼了
SH.CITY_BAND = CITY_BAND;

/* ============================================================ 车站横断面（一处） */
/** 高架/地下车站的横向尺寸，全部以"距线路中心"计（米）。
 *  以前这些数散在 `station()` 里写成"站台边缘再加 4.6 / 4.9 / 5.1 米"这类字面量，
 *  于是雨棚、檐口、立柱、灯带、护栏各偏各的：side=+1 的那一半车站上整片雨棚
 *  偏到站台外侧 3 m 的空气里，灯带悬空 —— 只有俯瞰机位看得见。
 *  现在全部从这里派生，`test-drive.js` 断言"棚罩台、灯在棚下、栏在台上"。 */
const PLAT_FRONT = 2.05, PLAT_W = 3.5;
/** 行道树的横向位置（靠路缘一侧）；行人（含 street 机位）走在内侧。 */
const TREE_LAT = SH.STREET_WALK.tree;
/** 灯杆与地块界围墙的横向位置（与人行道带、streetBand 同源，都读 SH.STREET_WALK）。 */
const LAMP_LAT = SH.STREET_WALK.lamp, WALL_LAT = SH.STREET_WALK.wall;
/* 底商店招/雨棚配色：药房绿白、快餐红、五金蓝、老字号深红配金、杂货土黄。
   店招走 emissive 加算通道 —— 黄昏里"街灯初上"那一层靠的是自发光，
   不是几百个真光源（光照列表一爆，整条走廊的烘焙就废了）。 */
const SHOP_C = [['#c8402e', '#e0663f'], ['#2f7d52', '#d9d2c4'], ['#d9a52b', '#8a3f2a'],
  ['#3a6ea8', '#cfd6da'], ['#8a2f4a', '#d8b26a']];
const STATION_X = {
  front: PLAT_FRONT, width: PLAT_W, outer: PLAT_FRONT + PLAT_W,
  canopyIn: PLAT_FRONT + 0.3, canopyOut: PLAT_FRONT + 3.7,
  rail: PLAT_FRONT + 3.42,
  /* 桥面外沿相对**站台外缘**的挑檐。原来高架站台区桥面硬写 ±7.6，而
     `front + width + 2.05 = 2.05 + 3.5 + 2.05` 正好是 7.6 —— 把它写成式子，
     对向股道外侧那条站台板加宽后桥面才会跟着一起长（否则板子悬在桥面外 2 m）。 */
  deckOver: 2.05,
  lamps: [PLAT_FRONT + 1.0, PLAT_FRONT + 2.6],
  sign: PLAT_FRONT + 0.20, psd: PLAT_FRONT + 0.06, tactile: PLAT_FRONT + 1.35, yellow: PLAT_FRONT + 0.55,
  /* 柱面线路色环的标高（轨面以上）。原来在 2.9，与柱身倒计时屏（1.90~2.82）
     重叠 7 cm —— 画面上是"绿带从屏幕里穿出来"。抬到 3.30（头顶以上）。
     这两个数单独提出来，是因为"色环压到屏上"是纯几何冲突：
     只有把两者的标高写在同一个地方，判据才量得到它。 */
  pillarRing: 3.30,
  /* ---- 地下侧式站的**站厅层**（第二层）标高与范围（轨面以上，米）----
     以前这一段根本没有第二层：那段"楼梯"12 级从横向 8.25 一路长到 11.99，
     而箱涵壁在 11.0 —— 也就是说它**穿墙之后停在半空**，谁也没到得了哪儿；
     闸机、售票机、长椅全都摆在站台层的走廊里（真实侧式站的付费区在站厅层）。
     现在把走廊上方做成一块真的站厅板：板下 2.18 m 是通向扶梯的免费通道，
     板上 2.45 m 是站厅，闸机线整体搬上去。
     数字不是拍的：走廊地坪 0.42、箱顶 5.55，取板面 2.95 让两侧净高都不低于
     2.1 m（地铁公共区最小净高的量级），且 30° 扶梯的水平投影 4.38 m
     正好放得进 5.1 m 宽的走廊。判据 test-xsect 直接读这一组数。 */
  mezzTop: 2.95, mezzT: 0.35, mezzIn: 6.25,
  /* 箱涵半宽：以前 11.0 这个数在 station() 的字面量、hallBand 的推导、
     test-bake 的判据里各写一份 —— 改一处就会让另外两处量到别的东西。 */
  boxW: 11.0,
  /* 扶梯/楼梯：横向跨越走廊（30°），下口在站台侧通道、落点在站厅板上 */
  escFoot: 5.85, escDeg: 30, escLane: 1.25, stairW: 1.7, voidHalf: 1.95,
  /* 柱身倒计时屏：屏宽按 'ptd' 实时纹理 512×192 的比例定高，
     屏心取"站台机位平视略偏上"（眼高在站台面上 1.68 m）。 */
  ptdY: 2.36, ptdW: 1.90,
  /* 站台净高与墙高：station() 里的 ceilH / wallH 字面量搬到这里，对向站台（farPlatform）
     必须与它同源，否则两侧吊顶高度不一样，从站台看过去是斜的。 */
  ceilH: 4.95, wallH: 3.05,
};
STATION_X.canopyW = STATION_X.canopyOut - STATION_X.canopyIn;
SH.STATION_X = STATION_X;
/* ============================================================ 岛式站台的横向口径
 * 对向股道的横向位置原本是全线一个常量（`−side × SH.TRACK_OFFSET`）：烘焙
 * （buildRuns 的 `oppLat`）、运行时对向车渲染（`LineRuntime.oppLat`）、取证机位
 * （dev/shot.js）三处各自抄一遍同一个式子。**侧式站台**下它确实是常数，但
 * **岛式站台**要求两条股道之间夹得下一座站台 —— 站区里的线间距必须比区间宽，
 * 于是它天生是一个**逐里程的函数**。先把这个函数立成单点，岛式站体才有地方长。
 *
 * 三条口径写死在这里，别改回"看起来更简单"的写法：
 * ① **本线永远贴线路中心线（lat 0）**。物理/ATO/闭塞分区/停车标/人群全部按中心线算，
 *    让本线搬家等于把三层一起改掉；加宽只动对向股道。
 * ② **岛式在两根股道的内侧**（右侧行车下，岛式对两个方向都是"内侧那一面"），
 *    所以加宽方向是**往远离本线的一侧**（−side），过渡段单调，绝不穿越本线。
 * ③ 岛式站的站台两侧缘距必须与侧式同一个 `STATION_X.front`（2.05 m）——
 *    否则"岛式"就只是把站台画宽一点，而车与台的净距是另一套数。 */
SH.PLAT_TYPE = {};            // 逐站例外：'island' 钉岛式 / 'side' 钉侧式 —— 填进去的每一条都要带出处
SH.ISLAND_W = 8.0;            // 岛式站台宽（米）。上海地铁地下岛式站台的常见量级
SH.ISLAND_TRANS = 80;         // 线间距加宽的过渡段长度（米），站界外 each side
/** 站型口径（B 阶段第一步，§7.1 的保守默认档）：**地下站默认岛式，露天/高架站保持侧式**，
 *  逐站例外走 `SH.PLAT_TYPE`（永远最高优先）。"地下"按线别事实算，不按印象：
 *  一站服务多条线时，只有**每条停它的线在这里都是高架/地面区间之外**才判岛 ——
 *  只要有一条线在这里露天，站体就跟那条线走（岛的箱体没法一半露天一半地下）。
 *  高架事实来自各线自己的 `elevated` 站名区间（与 LineRuntime.isElevated 同源的数据，
 *  这里按站名展开成站集合）；maglev 全线高架 ⇒ 自动侧式。惰性 memoize：
 *  world.js 加载时 data/shanghai.js 还没进来，首次调用才建表。 */
SH.platTypeDefault = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    const facts = {};                        // 站名 → { lines, elev }
    for (const id in SH.LINES) {
      const def = SH.LINES[id], br = def.branch;
      /* 本线的高架站集合 —— 与 LineRuntime._elevatedRanges 同一套解析：
         主线区间已由数据层转成**序号**；支线交路的站表 = 主线截到分岔站 + 支线站序，
         区间端点不在交路里时截到分岔站（春申路→望园路 到支线就是 春申路→东川路）。 */
      const set = new Set();
      for (const r of (def.elevated || []))
        for (let i = r[0]; i <= r[1]; i++) if (def.stations[i]) set.add(def.stations[i]);
      if (br) {
        const list = def.stations.slice(0, def.stations.indexOf(br.at) + 1).concat(br.stations);
        const fork = list.indexOf(br.at);
        const resolve = x => { const i = list.indexOf(x); return i >= 0 ? i : fork; };
        for (const r of (def.elevatedNames || [])) {
          const a = resolve(r[0]), b = resolve(r[1]);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (list[i]) set.add(list[i]);
        }
        for (const r of (br.elevated || [])) {
          const a = list.indexOf(r[0]) >= 0 ? list.indexOf(r[0]) : fork;
          const b = list.indexOf(r[1]) >= 0 ? list.indexOf(r[1]) : fork;
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (list[i]) set.add(list[i]);
        }
      }
      const all = new Set(def.stations);
      if (br) for (const n of br.stations) all.add(n);
      for (const n of all) {
        const f = facts[n] || (facts[n] = { lines: 0, elev: 0 });
        f.lines++;
        if (set.has(n)) f.elev++;
      }
    }
    return (cache = facts);
  };
})();
/** 该站的站台形式（单点）。优先级：SH.PLAT_TYPE 例外 > 默认口径。
 *  不许在调用点自己判 —— 这里是唯一的判站型处（§7.1：换边的唯一来源）。 */
SH.platType = name => {
  const ex = SH.PLAT_TYPE[name];
  if (ex === 'island' || ex === 'side') return ex;
  const f = SH.platTypeDefault()[name];
  return f && f.lines > 0 && f.elev === 0 ? 'island' : 'side';
};
/** 开门侧 / 站体侧（带符号，相对线路中心；§7.1 的唯一出处）。
 *  几何事实（§7.1"必须先接受的一条结论"）：右侧行车 + 对向轨在本线的 −side 侧
 *  ⇒ 夹在两股道中间的岛必然在 **−side** 那一侧 —— **岛式站的开门侧与侧式站相反**。
 *  口径：凡是"人/相机/门/牌"在哪一侧的都读这一个函数；凡是"股道在哪一侧"的
 *  一律继续读 `stationSide`（换了就等于让物理股道跟着站型搬家）。
 *  `s` 取列车的当前里程（停车标附近），门侧跟着"最近的那座站"走 —— 一列车
 *  全线跑，岛式站开另一侧，判据 shortdest/侧别播报读同一份。 */
SH.boardSideAt = (line, s) => {
  const side = line.stationSide(0);            // 股道侧全线恒边（A 阶段不变量）
  let name = null;
  if (typeof line.nearStation === 'function') {
    const ns = line.nearStation(s);
    name = line.stations && line.stations[ns && ns.i != null ? ns.i : 0];
  } else if (line.stations && line.al && line.al.stationS) {
    let bd = Infinity, bi = 0;                 // 判据的 mock line 没有 nearStation：按站表里程就近找
    for (let i = 0; i < line.al.stationS.length; i++) {
      const d = Math.abs(line.al.stationS[i] - s);
      if (d < bd) { bd = d; bi = i; }
    }
    name = line.stations[bi];
  }
  return SH.platType(name) === 'island' ? -side : side;
};
/** 岛式站区里两根股道之间的横向净距 = 站台宽 + 两道站台缘距。 */
SH.islandSpan = () => SH.ISLAND_W + 2 * STATION_X.front;
/**
 * 对向股道横向位置的**唯一**函数（带符号，相对线路中心；本线在 0）。
 * 区间 = `−side × SH.TRACK_OFFSET`（4.0 m 线间距，侧式断面那一套）；
 * 岛式站区内 = `−side × SH.islandSpan()`，站界外 `ISLAND_TRANS` 米内 smoothstep 过渡。
 * 表里没有岛式站时，逐米恒等于旧常量 —— 这一步只立接缝，不改产品。
 */
SH.oppLatAt = function (line, s) {
  const side = line.stationSide(0), base = -side * SH.TRACK_OFFSET;
  const S = line.al.stationS;
  if (!S || !S.length) return base;
  let best = -1, bd = Infinity;
  for (let i = 0; i < S.length; i++) { const d = Math.abs(S[i] - s); if (d < bd) { bd = d; best = i; } }
  const name = line.stations && line.stations[best];
  if (!name || SH.platType(name) !== 'island') return base;
  const wide = -side * SH.islandSpan();
  const u = SH.clamp((bd - SH.STATION_HALF) / SH.ISLAND_TRANS, 0, 1);
  const f = u * u * (3 - 2 * u);                    // smoothstep：两端斜率为 0，接缝不折角
  return wide + (base - wide) * f;
};
/** 对向站台缘口距**线路中心**的距离（绝对值，米）= 对向股道的横向 + 与本侧同一个 `front`。
 *  为什么要有它（2026-10-06 实量出来的缺陷）：`farPlatform()` 原先直接抄本侧的
 *  `STATION_X.front`，等于把本侧站台**关于线路中心镜像** —— 镜像出来的板正好盖在
 *  −4 m 那条股道上（实测：对向侧 granite 顶点 −2.05~−3.10、盲道 −3.10、黄线 −2.40、
 *  屏蔽门柱 −2.06，而钢轨在 −3.14~−4.86）。侧式站台的定义就是"在股道的外侧"，
 *  所以缘口必须越过对向股道再留一个 front。
 *  消费者：`farPlatform` 的 13 处摆位、对向候乘的横向带（含 `crowdStationFar`）、
 *  高架站台区桥面的对向挑檐、`test-bake`/`test-xsect` 的对向带判据。
 *  传进来的就是 `SH.oppLatAt` 那一份（线间距探针会把它一起搬走）；没有对向股道的
 *  线路（磁浮 / 浦江线 APM）传 0 —— 那一侧的镜像站台是既有行为，不归这次修订管。 */
SH.farFrontOf = lat => Math.abs(lat) + SH.STATION_X.front;

/**
 * 站台出入口（楼梯口）相对**站心**的里程偏移 —— 唯一定义（米）。
 *
 * 为什么必须单点：这组偏移有两个消费者，而且它们必须永远一致 ——
 *   ① `station()` 的楼梯几何（楼梯口开在哪）；
 *   ② `crowdStation()` 的下车人流终点（人往哪儿走、在哪儿上楼/下楼离场）。
 * 以前楼梯是 `s - 70 + i * 105`、下车人流却是"走向站台端头（s0+8 / s1-8）"，
 * 于是画面读出来是"下车的人走到站台尽头凭空消失"——那里既没有楼梯也没有出口。
 * 判据用**常数探针**钉住：运行时把这组偏移整体挪一段，楼梯与下车人流必须一起搬家
 * （test-pax「出入口单点」节）。
 */
/* SH.PLATFORM_EXITS 的定义已上移到 core.js：地面路口信号（SH.JUNCTION）也要读它，
 * 而 core 是所有模块的第一个依赖。这里不再重复赋值。 */

/**
 * 下车人流的两条生命周期上限（第 112 条）—— 视觉层与 Session 的 egress 过程**同源**。
 *
 * `KEEP`：列车离开该站超过这个里程，站台已经在画面外/小到读不出，过程直接结束。
 *        它把"关门后还在走的人"限制在一个可接受的时长里 —— 否则一次停站之后
 *        会持续重建几十秒的人群批次（这是每帧 CPU 的主要开销之一）。
 * `sec`： 过程的最长持续时间（自开门起）= 最后一个人出现的时间 + 最远的一段走行。
 *        最远走行按站台尺度取上界（门位在站心 −144~+36、出入口在 −70/+35，
 *        最大 74 m，取 80 m 留余量），速度与 `crowdInto` 的 walkV 同值。
 */
SH.EGRESS_KEEP = 300;
SH.egressSec = (need, rate) => {
  const nA = Math.min(110, Math.round((need || 0) / 3.4));
  return 0.8 + (nA * 3.4) / Math.max(1, rate || 1) + 80 / 1.35;
};

/**
 * 下车步行者"拐向梯段"的进度阈值（第 112 条）：`raw > EXIT_TURN` 之后，
 * 人从沿站台走改为拐向梯段口并沿楼梯升降。单点定义 —— crowdInto 的走行模型
 * 与判据（"末段的人确实落在最后这一段路径上"）读同一个值。
 */
SH.EXIT_TURN = 0.84;

/* ==================================================================== 灯光场 */
/**
 * 烘焙光照的空间哈希网格。
 * 灯按 (x,z) 分桶，查询一个顶点时只遍历邻近桶——这是烘焙阶段唯一的热点。
 */
class LightGrid {
  constructor(cell) {
    this.cell = cell || 24;
    this.map = new Map();
    this.lights = [];
  }
  /* 桶键必须是**整数**，不能是 "i:j" 字符串；而且**一个点只查一个桶**。
     这两条都是同一个量级问题：query 是按顶点调的，一次烘焙几十万个顶点，
     原来每个顶点要扫 (2·ceil(maxRad/cell)+1)² 个桶（灯最大半径 90 m、格 28 m
     时是 81 个），还要为每个桶拼一个字符串 —— CPU 剖析里 `query` 一个函数
     占掉烘焙自耗时 37 %，这正是玩家看到的"每站发车卡一下"（bakeMs 实测
     298~323 ms）。
     现在改成"登记时铺满自己照得到的格子，查询时只看脚下那一格"：
     灯只有几百个、顶点有几十万，把开销挪到便宜的那一侧，结果完全等价 ——
     半径 r 的灯能照到的点，必然落在 [L−r, L+r] 覆盖的那些格子里。
     取值域：世界坐标 ±114 km（cell 取最小的 24 m 时是 ±4096 格），上海网络
     最长线路 63 km，远在用不到的一半以内。 */
  _key(i, j) { return (i + 4096) * 8192 + (j + 4096); }
  add(x, y, z, col, rad, inten, spot, dir) {
    const l = { x, y, z, col, rad, rad2: rad * rad, inten, spot: spot || 1, dir };
    this.lights.push(l);
    const c = this.cell, map = this.map;
    const i0 = Math.floor((x - rad) / c), i1 = Math.floor((x + rad) / c);
    const j0 = Math.floor((z - rad) / c), j1 = Math.floor((z + rad) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = (i + 4096) * 8192 + (j + 4096);
      let a = map.get(k); if (!a) map.set(k, a = []);
      a.push(l);
    }
    return l;
  }
  /** 查询点光照，累加到 out {b:[r,g,b], e:number} */
  query(px, py, pz, nx, ny, nz, out) {
    out.b0 = out.b1 = out.b2 = 0; out.e = 0;
    const c = this.cell;
    const a = this.map.get((Math.floor(px / c) + 4096) * 8192 + (Math.floor(pz / c) + 4096));
    if (!a) return out;
    for (let k = 0; k < a.length; k++) {
      const l = a[k];
      const dx = l.x - px, dy = l.y - py, dz = l.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > l.rad2) continue;
      const d = Math.sqrt(d2) + 1e-4;
      const ndl = (nx * dx + ny * dy + nz * dz) / d;
      if (ndl <= 0) continue;
      const att = 1 - d / l.rad;
      const w = l.inten * att * att * ndl;
      out.b0 += l.col[0] * w; out.b1 += l.col[1] * w; out.b2 += l.col[2] * w;
    }
    return out;
  }
}
SH.LightGrid = LightGrid;

/* ================================================================== 世界构建 */
/**
 * @param cfg {
 *   al: Alignment,
 *   kindAt(s) -> 'tunnel'|'viaduct'|'cutcover'|'ground',
 *   stationIdxAt(s) -> 邻近站序号或 -1,
 *   color, color2, lineName, stations,
 *   profile: {width, bodyH, roofR, headLen, midLen, doors, doorPitch, doorW, gap},
 *   sign: SignAtlas,
 *   night: 0..1  夜景强度
 * }
 */
/* ==================================================== 磁浮轨道梁截面（Transrapid） */
/** T 形混凝土轨道梁的横断面尺寸（米，相对轨面 = 车体悬浮基准）。
 *  正线 `guideway()` 与停车库内的磁浮存车线共用这一处，
 *  否则两边各写一份，改一处就出现"正线是磁浮梁、库里长出两根钢轨"。 */
const GW = { HW: 1.45, SW: 0.55, TF: 0.02, UB: -0.50, SB: -1.95, statorPitch: 2.15 };
/** 顺时针（顶边左→右）：`Geo.miter` 的"外法向 = (-dy, dx)"要求这个绕向。 */
function gwProfile() {
  return Geo.miter([
    { x: -GW.HW, y: GW.TF }, { x: GW.HW, y: GW.TF },
    { x: GW.HW, y: GW.UB }, { x: GW.SW, y: GW.UB },
    { x: GW.SW, y: GW.SB }, { x: -GW.SW, y: GW.SB },
    { x: -GW.SW, y: GW.UB }, { x: -GW.HW, y: GW.UB },
  ]);
}

class WorldBuilder {
  constructor(cfg) {
    this.cfg = cfg;
    this.b = new Builder();
    this.lg = new LightGrid(28);
    this.q = { b0: 0, b1: 0, b2: 0, e: 0 };
    this.ambient = [0.30, 0.33, 0.40];
    this.sun = null;                    // {dir, col} 仅地面段用
    this.cityLots = [];                 // city() 摆出去的楼体 footprint，供"不得互穿"断言
    this.streetItems = [];              // 街具登记（路灯/围墙段/树穴/店招），判据按它核对烘焙结果
    this.farPlatforms = [];             // 对向站台（第二座侧式站台）登记；不进 facilities（那条有 mats 契约）
    this._farPlaced = new Set();        // 远景方格城市：世界格号去重，相邻烘焙窗口重叠
    /* 地标占位区（世界 xz 矩形）。远景楼群必须避开它们，否则盒体城市会
       直接长在黄浦江/淀山湖的水面上 —— 远景水面不在 waterRanges 里
       （那一列只管"横穿线路、要把街面挖断"的点），拦不住侧景类的江与湖。 */
    this.noBuild = [];
    this._out = [];
  }

  /**
   * 安装 lightFn。
   *
   * 关键分工（之前搞错过一次，画面整体发黑）：
   *   · 运行时着色器负责**太阳方向光 + 半球环境光 + 高光 + 雾**——这些与视角/时刻有关，
   *     本来就该每帧算。
   *   · 烘焙阶段只负责**人工光源**（隧道灯带、站台灯槽、广告灯箱、地标障碍灯），
   *     因为运行时不知道它们在哪。
   *   · 所以 tint 是"在 1.0 之上加多少灯光"，而**不是**"环境光乘以多少"。
   *     早先这里把 ambient 也乘进顶点色，运行时又乘一次半球环境光，
   *     室外地面变成 ambient² ≈ 0.07，几乎全黑、楼看着悬空。
   */
  /**
   * 人工光的顶点钩子（**唯一实现**）。
   *
   * 抽成静态是为了让**运行时重建**的几何（站台人群，第 101 条）与烘焙走同一份
   * 光照公式：人群要在开门期间按客流人数重建，而它必须和别的站台几何一样被
   * 站台灯照亮 —— 各写一份就是第二个真值，且症状是"人群突然变成一片纯黑剪影"。
   */
  static lightFn(lg) {
    const q = { b0: 0, b1: 0, b2: 0, e: 0 };
    /* 返回值是**复用**的：`Builder.vtx` 拿到就当场把 b/emi/tint 三个数读进局部变量
       （mesh.js:47-53），不保留引用。原来每个顶点 new 一个对象 + 一个 tint 数组，
       一次烘焙几十万顶点 —— 剖析里 GC 占 7.4 %，就是这类东西喂出来的。 */
    const res = { b: 1, emi: 0, tint: [1, 1, 1] };
    return function (x, y, z, nx, ny, nz) {
      lg.query(x, y, z, nx, ny, nz, q);
      /* 灯光走**加算通道（顶点自发光）**，不再乘进反照率。
         着色器里是 lit = base*(天光+日照) + base*自发光*emiBoost：
         以前把灯算成 base 的乘子，于是"人工光"和"环境光"是相乘关系——
         隧道里环境光只有 0.09，灯算到 1.6 倍也只是 0.09×1.6，
         整条隧道仍然是黑的（再叠加以前 8bit 反照率把 >1 直接削平，
         等于灯光被丢了两次）。现在：
           自发光 = 灯的强度（加算，不受环境光摆布）
           tint   = 各通道 (1+b)/(1+max)，把冷暖色偏留住，同时恒 ≤ 1 不再溢出。 */
      const m = Math.max(q.b0, q.b1, q.b2);
      const T = res.tint;
      if (!(m > 0)) { res.emi = 0; T[0] = T[1] = T[2] = 1; return res; }
      const inv = 1 / (1 + m);
      res.emi = m; T[0] = (1 + q.b0) * inv; T[1] = (1 + q.b1) * inv; T[2] = (1 + q.b2) * inv;
      return res;
    };
  }

  /** 把人工光钩子装到主构建器上，并把引用留给运行时重建用（见 lightFn）。 */
  _installLight() {
    this.lightFn = SH.WorldBuilder.lightFn(this.lg);
    this.b.light(this.lightFn);
  }

  /* ------------------------------------------------------ 灯光：隧道灯带 */

  /** 旋转矩形分离轴判交。轴向必须与 test-land.js 的 corners() **逐字一致**：
   *  局部 x = (cos yaw, sin yaw) 配半宽 hw，局部 z = (−sin yaw, cos yaw) 配半长 hd。
   *  第一版我按"`d` 沿线路前向"推成 (sin, cos)/(cos, −sin)，等于把整个楼体镜像了：
   *  判交照跑、一单都不报，test-land 的 3 对穿插原封不动 —— 自我一致的错判
   *  比没有判交更糟，因为它看起来是有的。 */
  static lotsHit(a, b) {
    const axes = L => [[Math.cos(L.yaw), Math.sin(L.yaw), L.hw], [-Math.sin(L.yaw), Math.cos(L.yaw), L.hd]];
    const A = axes(a), B = axes(b);
    const px = b.x - a.x, pz = b.z - a.z;
    for (const [nx, nz] of [[A[0][0], A[0][1]], [A[1][0], A[1][1]], [B[0][0], B[0][1]], [B[1][0], B[1][1]]]) {
      const ra = a.hw * Math.abs(A[0][0] * nx + A[0][1] * nz) + a.hd * Math.abs(A[1][0] * nx + A[1][1] * nz);
      const rb = b.hw * Math.abs(B[0][0] * nx + B[0][1] * nz) + b.hd * Math.abs(B[1][0] * nx + B[1][1] * nz);
      if (Math.abs(px * nx + pz * nz) > ra + rb - 0.6) return false;   // 与判据同一条 0.6 m 余量
    }
    return true;
  }

  /** 楼群按三条车道式排布；曲线段上"按构造不重叠"是不成立的（相邻两栋的 yaw 不同），
   *  所以摆之前必须真的判一次交，撞了就不摆 —— 少一栋楼看不见，两栋楼长在一起看得见。 */
  _lotFits(lot) {
    const R = this._lotsByCell || (this._lotsByCell = new Map());
    const CELL = 64, key = (x, z) => ((Math.floor(x / CELL) + 4096) * 8192) + (Math.floor(z / CELL) + 4096);
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const arr = R.get(key(lot.x + gx * CELL, lot.z + gz * CELL));
      if (!arr) continue;
      for (const o of arr) if (WorldBuilder.lotsHit(o, lot)) return false;
    }
    const k = key(lot.x, lot.z);
    if (!R.has(k)) R.set(k, []);
    R.get(k).push(lot);
    return true;
  }


  /** 把里程切成同类型的连续段（depot / station / viaduct / tunnel）。
   *  **必须由这里单点提供**：game.js 的 bake 与 test-wind / test-wedge / test-bake
   *  各自复刻过一份分类器，于是新加一种类型（停车基地）时，游戏里烘得到、
   *  判据里烘不到 —— 新几何完全没被绕序与超大面片检查覆盖过。
   *  放在 world.js 是因为各测试都 require 它，而 game.js 在离线测试里只 eval 类定义。 */
  static runsOf(line, s0, s1, step) {
    const al = line.al;
    const runs = []; let cur = null;
    for (let s = s0; s <= s1; s += (step || 10)) {
      const ns = line.nearStation(s);
      const kind = SH.depotAtS(al, s) ? 'depot'
        : (ns.d < SH.STATION_HALF ? 'station' : (line.isElevated(s) ? 'viaduct' : 'tunnel'));
      if (!cur || cur.kind !== kind) { cur = { kind, s0: s, s1: s }; runs.push(cur); }
      else cur.s1 = s;
    }
    return runs;
  }

  /**
   * 把 runsOf 的分段结果落成几何 —— **唯一的一份实现**。
   *
   * 以前 game.js 的 bake 与 test-wind / test-wedge 各写了一份同样的 if/else 链，
   * 后果是"只改游戏侧的新几何永远进不了绕序与超大面片判据"（停车基地那一次
   * 就是这么漏掉的）。三份复刻如今也已经各自漂移了：tunnelTube 的半径与步长、
   * 站端补的那段隧道、库内灯带，哪一份都不是权威。测试要能看见新东西，
   * 前提是先只有一份东西可测。
   *
  /**
   * 线路全线站牌预热（稳帧提升）：
   * 在开局/切换线路时，将全线所有车站的站名牌、大字壁、广告、换乘标、出入口
   * 一次性登记入图集并绘制完毕。
   * 运行期间再烘焙各站时，sign.add 直接命中缓存 rect，
   * 彻底避免行车中途触发 4096² (64MB) 贴图上传引发的几十毫秒严重冻结。
   */
  static prewarmSigns(sign, line) {
    if (!sign || !line || !line.stations) return;
    const color = line.color;
    for (let i = 0; i < line.stations.length; i++) {
      const name = line.stations[i];
      const en = (line.def && line.def.stationsEn && line.def.stationsEn[name]) || SH.EN[name] || name;
      const code = 'P' + (i + 1);
      sign.add('plate:' + name, 512, 106, (c, w, h) => SH.textures.signStationPlate(c, w, h, { name, en, code, color }));
      sign.add('big:' + name, 640, 184, (c, w, h) => SH.textures.signStationPlate(c, w, h, { name, en, code, color, big: true }));
      sign.add('ad:' + (hash32(name, i) % 97), 256, 96, (c, w, h) => SH.textures.signAd(c, w, h, hash32(name, i)));
      sign.add('way:' + name, 384, 96, (c, w, h) => SH.textures.signWayfind(c, w, h, { text: '换乘 · 出站', sub: 'Way out · Interchange', color }));
      sign.add('exit:' + name, 384, 96, (c, w, h) => SH.textures.signWayfind(c, w, h, { text: '出入口 A · B', sub: 'Way out A · B', color }));
      sign.add('tvm:' + name, 128, 160, (c, w, h) => SH.textures.signTvm(c, w, h, { color }));
      sign.add('clk:' + name, 128, 128, (c, w, h) => SH.textures.signClock(c, w, h, { color }));
      if (SH.INTER_META && SH.INTER_META[name] && SH.INTER_META[name].type === 'in') {
        const interList = (SH.INTER[name] || []).filter(x => x.id !== line.id);
        if (interList.length) {
          const linesZh = '换乘 ' + interList.map(x => x.name).join(' · ');
          const linesEn = 'Transfer to Line ' + interList.map(x => x.name.replace('号线', '')).join(' · ');
          const signColor = interList[0].color || '#00a0e9';
          sign.add('inter:' + name, 320, 80, (c, w, h) =>
            SH.textures.signWayfind(c, w, h, { text: linesZh, sub: linesEn, color: signColor }));
        }
      }
    }
    const dz = SH.depotZones ? SH.depotZones(line.al) : [];
    for (let k = 0; k < dz.length; k++) {
      const opt = dz[k];
      sign.add('depot:' + (opt.id || k), 512, 106, (c, w, h) =>
        SH.textures.signStationPlate(c, w, h, { name: opt.name || '停车基地', en: opt.en || 'DEPOT', code: 'D' + (opt.id || (k + 1)), color }));
    }
  }

  static buildRuns(wb, line, s0, s1, pax) {
    const sign = wb.cfg.sign;
    if (!sign) throw new Error('WorldBuilder.cfg.sign 未设置：站牌会画进一张永不上传的临时图集');
    const runs = SH.WorldBuilder.runsOf(line, s0, s1);
    /* 磁浮：整条线的"轨道"是 T 形轨道梁 + 长定子，不是钢轨枕木（见 guideway()）。
       这个标志必须在跑循环之前算好：库线、正线、车站三处都要用。 */
    const mg = !!(line.maglev || (line.profile && line.profile.maglev));
    /* 浦江线：胶轮 APM，行车道 + 导向轨，不是钢轨也不是长定子梁（见 apmLane()）。
       标志读车型表的 `rubber`（物理侧也用同一个），不要读线路名。 */
    const apm = !!(line.aPM || (line.stock && line.stock.rubber) || (line.profile && line.profile.rubber));
    /* 对向股道（第 108 条 双线断面）：站区与高架段多烘一条反向轨道，
       站台上才看得到对向车进站 —— 这是"这是地铁"最直观的一幕。
       磁浮/胶轮是单线专列构造（导轨梁在正中），没有"对面股道"可言；
       车辆基地与隧道区间也不烘 —— 隧道是双洞各自独立，本洞里看不见对向轨，
       对向车在隧道里按 game.js 的 oppVisible 隐藏，只在洞口出现/消失。
       对向股道的横向位置由**线**决定（stationSide 已单点化为全线常量）：
       −side × SH.TRACK_OFFSET，全线恒定 —— 连续的物理股道不许在站间换边，
       逐站掷骰子会让对向轨在有的站跑到站台底下。 */
    const oppOn = !mg && !apm;
    /* 地面路口表：一次算好挂在 builder 上（每次烘焙窗口都调 city()，
       而路口是**全线**的事，不能按窗口重算 —— 编号决定灯色偏移，重算会错位）。 */
    if (!wb._jx) wb._jx = SH.junctions(line);
    /* 对向股道的横向位置：逐里程问 `SH.oppLatAt`（岛式站区要加宽，见那一段的三条口径）。
       表里没有岛式站时它逐米恒等于旧常量 `-side × SH.TRACK_OFFSET`。 */
    const oppLat = oppOn ? s => SH.oppLatAt(line, s) : 0;
    /* 对向站台的横向基准从这里传给 builder（`farPlatform` / 高架桥面都读它）。
       没有对向股道的线路给 null —— 那一侧不搬家，保持既有镜像摆位。 */
    wb._oppLat = oppOn ? oppLat : null;
    /* 司机那一侧（`stationSide` 是全线常量，test-xsect 的"全线恒边"钉着它）：
       里程标与信号柱都只认这一个边。以前里程标写的是不带符号的 `2.35`、信号柱写的是
       `Math.round(s0/500)%2` —— 后者跟着"窗口从哪儿切"决定左右，前者干脆不分边，
       于是在 side=−1 的线上它们站在**两股道之间**（横向 2.35/2.42，离对向轨中心 1.6 m，
       正好卡在对面那列车和司机之间；17 号线 徐盈路 由 test-xsect 的空档判据量出 8 个顶点）。 */
    wb._side = line.stationSide(0);
    /* 街面机位净空区：露天站出入口（ss + PLATFORM_EXITS）旁 ±26 m 不种树 ——
       test-shot 的街面机位就站在出入口边，9 号线佘山实测画面中心 23.3% 是
       树冠（"相机站在树坑里"）。净空区钉绝对里程，逐窗口都生效。 */
    const clearZones = [];
    for (let i = 0; i < line.al.stationS.length; i++) {
      const ss = line.al.stationS[i];
      if (!line.isElevated(ss)) continue;
      for (const ex of SH.PLATFORM_EXITS) clearZones.push(ss + ex);
    }
    const stationInfo = [];
    for (const r of runs) {
      const a = Math.max(s0, r.s0 - 22), z = Math.min(s1, r.s1 + 22);
      if (z - a < 8) continue;
      if (r.kind === 'depot') {
        const dz = SH.depotAtS(line.al, (a + z) / 2) || SH.depotAtS(line.al, a);
        /* 股道数不再从调用口传：SH.DEPOT 是唯一住处（第 109 条），库区信号与
           停车线、进路表读同一份，调用口一个数会漂移。 */
        wb.depot(a, z, { side: dz ? dz.side : 1, color: line.color, id: line.id, maglev: mg, apm: apm });
        if (mg) wb.guideway(a, z, { pierH: 4 });
        else if (apm) wb.apmLane(a, z, { pierH: 0 });
        else wb.track(a, z, { step: 4, ballast: false });
        wb.tunnelLights(a, z, 30, true);
      } else if (r.kind === 'tunnel') {
        wb.tunnelLights(a, z, 6.2, true);
        wb.tunnelTube(a, z, { radius: 2.95, yOff: 2.30, step: 4 });
        /* 端头引入段即使是隧道，胶轮线也还是行车道 + 导向轨：
           第一版只改了高架分支，结果浦江线两端各冒出一段钢轨和枕木。 */
        if (apm) wb.apmLane(a, z, { pierH: 0 }); else wb.track(a, z, { step: 3 });
      } else if (r.kind === 'viaduct') {
        /* 磁浮不是"高架的一种"，是完全另一种线路构造物：见 guideway()。 */
        if (mg) wb.guideway(a, z, { pierH: 10 });
        else if (apm) wb.apmLane(a, z, { pierH: 8.5 });
        else wb.viaduct(a, z, { pierH: 10 });
        /* 高架段必须有轨道结构。之前只浇 U 形梁就完事，结果整个高架区间的
           画面里"没有钢轨、没有扣件、没有整体道床"——从驾驶室看出去是一条
           空人行道，对一款地铁模拟器来说这是硬伤。供电由 viaduct() 负责，
           所以这里传 noSupply。 */
        if (!mg && !apm) wb.track(a, z, { step: 4, ballast: false, noSupply: true });
        /* 对向股道（第 108 条）：与正线同一份 track() 默认供电（第三轨），
           接触网不烘 —— catenary() 的门型支柱立在 lat ± 2.42 = ±1.58/±6.42，
           ±6.42 已经悬在梁槽（半宽 3.05）之外。 */
        if (oppOn) wb.track(a, z, { step: 4, ballast: false, catenary: false, lat: oppLat, signage: false });
        wb.city(a, z, hash32(line.id, Math.round(a / 100)), { clearZones });
      } else {
        const ns = line.nearStation((a + z) / 2);
        const i = ns.i, ss = ns.s;
        if (stationInfo.some(x => x.i === i)) continue;
        const side = line.stationSide(i);
        const name = line.stations[i];
        const en = SH.EN[name] || name;
        const inter = (SH.INTER[name] || []).filter(x => x.id !== line.id);
        const rect = sign.add('plate:' + name, 512, 106, (c, w, h) => SH.textures.signStationPlate(c, w, h, { name, en, code: 'P' + (i + 1), color: line.color }));
        wb.tunnelLights(a - 120, z + 120, 6.2, true);
        /* 人群密度直接取客流模型的候乘人数：站台上有几个人，
           就是司机该停多久的依据，而不是随机撒的点。 */
        const waiting = pax ? pax.waitingAt(name, i) : null;
        /* 对向站台的候乘（同一客流模型的对向桶，见 farPlatform 的注释）：
           与本侧同一次取数路径，时段/换乘系数同源，只有方向盐值不同。 */
        const waitingOpp = pax ? pax.waitingAt(name, i, -1) : null;
        wb.station(ss, side, { name, en, code: 'P' + (i + 1), idx: i, lineId: line.id, seed: hash32(name, 7), open: line.isElevated(ss), crowd: waiting, crowdOpp: waitingOpp });
        // 高架车站同样要有钢轨与扣件，否则站台上的视线里是空的梁槽。
        // 供电按**本线的供电方式**分支（逐米审计抓出来的第二处）：接触轨线
        // （16 号线）站内延续第三轨；接触网线不再用第三轨凑数 —— 门架支柱
        // 立在 lat ±2.42 会插进站台，所以挂**裸线**（只有承力索与导线，
        // 没有支柱），接触网从两端的 viaduct() 无缝延续过站。
        if (apm && line.isElevated(ss)) wb.apmLane(a, z, { pierH: 0 });
        else if (line.isElevated(ss) && !mg) {
          const third = !!(wb.cfg.profile && wb.cfg.profile.supply === 'third');
          if (third) wb.track(a, z, { step: 5, ballast: false, catenary: false });
          else { wb.track(a, z, { step: 5, ballast: false, noSupply: true, catenary: false }); wb.catenary(a, z, { bare: true }); }
        }
        /* 高架车站的对向股道（第 108 条）：站台上向对面看，对向车就在
           −side × SH.TRACK_OFFSET 那条道上进出 —— 第三轨与正线同一份默认。 */
        if (oppOn && line.isElevated(ss) && !mg) wb.track(a, z, { step: 5, ballast: false, catenary: false, lat: oppLat, signage: false });
        /* 高架车站正下方也必须有街面。出入口的梯段与站厅本来就是照"落到街面"
           盖的（站厅底在轨面下 10.9），可街面以前只在 viaduct 分支里铺 ——
           站体正下方只剩那张跟随相机的航拍地面，站厅像一块砖摆在雪地里。
           范围用**未经 ±22 外扩**的 r.s0..r.s1：相邻高架区间各自外扩 22 m，
           两边都铺就会在接缝处叠出两片共面的街面（z-fighting）。
           noBuild：站体下方不放楼 —— 最近那条楼车道在横向 28、半宽 7.5 加基座
           占到 34，正好把横向 32.75 的站厅整间埋掉。 */
        if (line.isElevated(ss)) {
          wb.city(Math.max(s0, r.s0), Math.min(s1, r.s1), hash32(line.id, i), { noBuild: true, clearZones });
          /* 出入口外的街面人行横道：楼梯落到街面，正对着斑马线，这才是"出入口"。
             位置与站台侧都取 `wb._jx`（= `SH.junctions` 里 `exit` 那些），
             而 `street.js` 的过街行人读同一份 —— 各算一份就会出现
             "画了线的地方没人过、有人的地方没线"。 */
          for (const j of wb._jx) if (j.exit && j.si === i) wb.crossing(j.s, j.side);
        }
        stationInfo.push({ i, s: ss, side, name, en, inter, rect });
        // 站台端部之外继续是隧道或高架
        if (!line.isElevated(ss)) {
          wb.tunnelLights(ss - 230, a, 6.2, true); wb.tunnelTube(Math.max(s0, ss - 235), a, {});
          if (apm) { wb.apmLane(Math.max(s0, ss - 235), a, { pierH: 0 }); wb.apmLane(a, z, { pierH: 0 }); }
          /* 引入段轨道必须**贯通箱体到站尾**（第 108 条修复）：以前只铺到
             箱体入口（a = 站区头 −22），探针实测站台中心 ±80 m 内钢轨顶点为 0
             —— 站台底下是一段约 160 m 的"无轨区"，司机进站时车轮悬空。
             现在直接铺到 z（站区尾 +22），与隧道分支的同 step=3 轨道在端头
             以相同步长叠接（与既有的站端 22 m 重叠同机制），第三轨一并进来
             （横向 ±1.37，箱体墙 ±5.5 装得下）。 */
          else wb.track(Math.max(s0, ss - 235), z, {});
          /* 对向股道贯通箱体（第 108 条）：站台上向对面看，对向车从
             −side × SH.TRACK_OFFSET 那条道进站。第三轨横向 ±1.37 装得下
             （4.0 + 1.37 = 5.37 < 5.5），接触网不烘 —— 支柱会戳穿箱体墙。 */
          if (!apm && oppOn) wb.track(a, z, { step: 4, ballast: false, catenary: false, lat: oppLat, signage: false });
        }
      }
    }
    return stationInfo;
  }

  tunnelLights(s0, s1, spacing, warm) {
    const al = this.cfg.al;
    const col = warm ? [1.00, 0.84, 0.58] : [0.86, 0.93, 1.00];
    for (let s = Math.ceil(s0 / spacing) * spacing; s <= s1; s += spacing) {
      const fr = al.frame(s);
      for (const side of [-1, 1]) {
        const p = al.world(fr, side * 2.05, 3.55);
        // tint 是"1 + 灯光"，所以这个数是叠加量：1.15 让灯下墙面亮到约 2 倍基色
        this.lg.add(p[0], p[1], p[2], col, 13.5, 0.95, 1, null);
      }
      // 拱顶中央弱光，把车顶照亮
      const pc = al.world(fr, 0, 4.3);
      this.lg.add(pc[0], pc[1], pc[2], col, 9, 0.35, 1, null);
    }
  }

  /* ---------------------------------------------------------- 隧道管片 */
  /**
   * 盾构圆形隧道。
   * @param radius 内轮廓半径
   * @param yOff   圆心相对轨面的高度
   */
  tunnelTube(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al, R = opts.radius || 2.95, yOff = opts.yOff == null ? 2.30 : opts.yOff;
    const step = opts.step || 4;
    const path = al.frames(s0, s1, step);
    // 圆心抬高：截面坐标以 frame 的 p 为原点，所以把截面整体下移 yOff
    /* 法向必须**朝隧道内侧**，不是 circleProfile 给的朝岩体方向。
       绕序靠 flip 已经朝向车内（所以看得见），但烘焙光照读的是这里的 nx/ny：
       法向朝外时，隧道灯到壁面的向量与法向的点积恒为负、被 clamp 成 0，
       于是整条隧道的壁面拿不到一点灯光，只有钢轨和道床是亮的——
       这才是"隧道里黑得只剩两条轨"的真正原因。
       绕序不能动（一动这些面就被背面剔除、隧道直接消失），只把法向翻过来。 */
    const prof = Geo.circleProfile(R, opts.seg || 26, yOff).map(p => ({ x: p.x, y: p.y - yOff, nx: -p.nx, ny: -p.ny }));
    // 底板（行走面以下填平）
    this.b.sweep(path, prof, {
      mat: 'segment', color: rgbOf('#8d949a'), closed: true, flip: true,
      uvAlong: 1 / 6, vSpan: 1,
    });
    // 盾构管是单面的（法向朝内供车内看），从外面看会直接看穿管子。
    // 补一层低分段的粗外壁，隧道口与追尾视角就不再穿帮。
    const outer = Geo.circleProfile(R + 0.34, 22, yOff).map(q => ({ x: q.x, y: q.y - yOff, nx: q.nx, ny: q.ny }));
    this.b.sweep(path, outer, { mat: 'concreteD', color: rgbOf('#5f686f'), closed: true, uvAlong: 1 / 12, vSpan: 1 });
    /* 洞口：管子是开口的，从外面看会得到一个"悬空的黑洞"——
       既看不见尽头有什么，也看不出它穿进了什么。补一圈端环 + 三块门框，
       画面上就是一个真正的盾构洞口。端环用 quadPts 逐段拼（法向沿洞口轴，
       绕序由 quadPts 自动跟随法向），门框是左/右/顶三块混凝土盒。 */
    this._tunnelPortal(s0, +1, R, yOff);
    this._tunnelPortal(s1, -1, R, yOff);
    // 整体道床
    /* 顶点法向交给 Geo.miter 算：每条边的外法向、每个角取相邻两边平均。
       原来四个点的法向是手填的，顶面那条边的两端正好是 (-1,0) 与 (1,0)，
       平均成零向量 —— 于是道床顶面（也就是走行板）既拿不到烘焙灯，
       绕序也没人裁决。 */
    const bed = Geo.miter([
      { x: -2.55, y: -0.05 }, { x: 2.55, y: -0.05 },
      { x: 2.30, y: -0.62 }, { x: -2.30, y: -0.62 },
    ]);
    this.b.sweep(path, bed, { mat: 'concreteD', color: rgbOf('#4b5257'), closed: true, uvAlong: 1 / 3, vSpan: 1 });
    // 侧电缆支架 + 疏散平台
    /* 这类"薄板截面"的每一段要用**自己那面**的法向：底面 -1、侧面 ±1、顶面 +1。
       原来四点全给 (0, 1)，于是底面与侧面的着色法向和绕序相反——
       在 test-wind.js 里表现为 steel/metal 各有几万到十几万个反向三角形，
       而烘焙光照对这些面永远算不出灯。 */
    for (const side of [-1, 1]) {
      const tray = Geo.rectProfile(0, 0, 0.42, 0.06);
      const pp = al.frames(s0, s1, 12);
      const saved = pp.map(f => { const p = al.world(f, side * 2.30, 0.62); f.p = p; return f; });
      this.b.sweep(saved, tray, { mat: 'metal', color: rgbOf('#6b747c'), closed: false, uvAlong: 1 / 4, vSpan: 1 });
      if (side === -1) {
        const walk = Geo.rectProfile(0, 0, 0.95, 0.09);
        const w2 = al.frames(s0, s1, 12).map(f => { const p = al.world(f, -2.28, -0.10); f.p = p; return f; });
        this.b.sweep(w2, walk, { mat: 'steel', color: rgbOf('#5b646b'), closed: false, uvAlong: 1 / 3, vSpan: 1 });
      }
    }
    // 环向加固框与联络通道门（细节密度）
    for (let s = Math.ceil(s0 / 6) * 6; s < s1; s += 6) {
      const fr = al.frame(s);
      if (Math.abs(hash32('rib' + s, 3) % 100) > 12) continue;
      const p = al.world(fr, 0, 2.3);
      this.b.cylZ([p[0], p[1], p[2]], 0.06, 0.1, rgbOf('#39424a'), { mat: 'metal', seg: 10 });
    }
    for (let s = Math.ceil(s0 / 120) * 120; s < s1; s += 120) {
      const fr = al.frame(s);
      const p = al.world(fr, -2.72, 1.15);
      this.b.plate([p[0], p[1], p[2]], [0, 0, 1.15], [0, 1.85, 0], norm3(cross(fr.f, fr.u)), rgbOf('#2b333a'), { mat: 'paint', uv: 1 });
      const lp = al.world(fr, -2.62, 2.55);
      this.lg.add(lp[0], lp[1], lp[2], [0.55, 0.85, 1.0], 5, 0.5);
    }
    return this;
  }

  /**
   * 盾构洞口：一圈端环 + 三块门框。
   * 管子本身是开口的，以前从外面看就是"一根悬空的黑洞"——看不见尽头有什么，
   * 也看不出它穿进了什么。端环把管壁与周围地形之间的环缝封掉，门框给出
   * 一个明确的洞口轮廓，追尾/正面/航拍三种视角下才像个隧道口。
   * @param s 洞口里程 @param sign +1 = 在区间的起点端（环面朝里程减小方向）
   */
  _tunnelPortal(s, sign, R, yOff) {
    const al = this.cfg.al;
    const fr = al.frame(Math.max(0, Math.min(al.total, s)));
    const nrm = [sign * fr.f[0], 0, sign * fr.f[2]];      // 环面朝外（水平，洞口不倾斜）
    const r0 = R + 0.30, r1 = R + 1.45, N = 22;
    const at = (rr, a) => al.world(fr, Math.cos(a) * rr, -yOff + Math.sin(a) * rr);
    for (let i = 0; i < N; i++) {
      const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2;
      this.b.quadPts(at(r0, a0), at(r1, a0), at(r1, a1), at(r0, a1), rgbOf('#6a737a'),
        { mat: 'concreteD', normal: nrm, uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    }
    /* 门框：左右立柱 + 顶梁。给了 yaw 之后与洞口轴平行（box 现在支持绕 y 转）。
       材质是专属的 `portal`（贴图与 concrete 同一张，观感不变）——
       共用 `concrete` 时"撤掉门框"这条负控测不住：洞口中央带里的 concrete
       还来自桥台与墩身，实测撤干净仍有 4.8% 而门槛只有 1.5%。 */
    const yaw = Math.atan2(fr.f[0], fr.f[2]);
    const cy = -yOff;
    for (const side of [-1, 1]) {
      const p = al.world(fr, side * (r1 + 0.42), cy);
      this.b.box([p[0], p[1], p[2]], [0.84, 2 * r1 + 1.7, 1.15], rgbOf('#7d858b'),
        { mat: 'portal', uv: 1 / 2, yaw });
    }
    const tp = al.world(fr, 0, cy + r1 + 1.15);
    this.b.box([tp[0], tp[1], tp[2]], [2 * r1 + 2.1, 0.9, 1.15], rgbOf('#7d858b'),
      { mat: 'portal', uv: 1 / 2, yaw });
    return this;
  }

  /** 磁浮轨道梁：T 形混凝土梁 + 两侧翼板下沿的**长定子段**。
   *
   * 上海磁浮是世界第一条商用高速磁浮线，它的"线路"根本不是轨道：
   * **没有钢轨、没有枕木、没有道床、没有接触网** —— 直线电机的一半（长定子）
   * 装在轨道梁两侧翼板的下沿，车辆从上面抱住梁翼、靠悬浮气隙骑在梁上，
   * 导向与稳定也靠同一对翼板。以前这里直接套地铁的 U 形梁 + `track()`，
   * 于是这条全世界最快的线路在画面里长得跟 3 号线一模一样（追拍机位一眼可见），
   * 而"磁浮"恰恰是车迷会专门去开一趟的那条线。
   *
   * 尺寸取 Transrapid 的量级：梁顶翼板宽 2.9 m、定子段 2 m 一节、
   * 跨长 14.2 m（上海线典型梁跨），悬浮气隙约 10 mm（画成 8 cm 才看得见）。 */
  guideway(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al;
    const path = al.frames(s0, s1, 4);
    const HW = GW.HW, SW = GW.SW, TF = GW.TF, UB = GW.UB, SB = GW.SB;
    const prof = gwProfile();
    this.b.sweep(path, prof, { mat: 'concrete', color: rgbOf('#b2b9bd'), closed: true, uvAlong: 1 / 3, vSpan: 1 / (2 * HW) });
    /* 长定子段：两列叠片钢包，贴在翼板下沿、朝内上方对着车体里的悬浮架。
       一节 2 m、留 0.15 m 缝，缝里露出梁体混凝土。 */
    for (let s = Math.ceil(s0 / 2.15) * 2.15; s < s1; s += 2.15) {
      const fr = al.frame(s + 1.0);
      for (const side of [-1, 1]) {
        const p = al.world(fr, side * 1.12, UB - 0.13);
        this.b.box([p[0], p[1], p[2]], [0.42, 0.24, 2.0], rgbOf('#3b444d'), { mat: 'steel', faces: [0, 1, 2, 3, 5] });
        const e = al.world(fr, side * 0.90, UB - 0.02);
        this.b.box([e[0], e[1], e[2]], [0.06, 0.05, 2.0], rgbOf('#6e787f'), { mat: 'metal' });
      }
    }
    /* 梁翼上沿的不锈钢导向边缘：车体的抱臂就在这条边上擦过，
       没有这两条亮边，梁顶与车底之间就是一整片没有层次的灰。 */
    for (const side of [-1, 1]) {
      const sp = path.map(f => { const p = al.world(f, side * (HW - 0.04), TF + 0.03); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(sp, [{ x: 0, y: 0, nx: side, ny: 0 }, { x: 0, y: 0.10, nx: side, ny: 0 }],
        { mat: 'metal', color: rgbOf('#8f999f'), closed: false, uvAlong: 1 / 2, vSpan: 1 });
    }
    /* 梁缝与桥墩：跨长 14.2 m。墩底必须扎进街面以下（走 groundY 基准），
       与地铁高架同一族规则；跨江/跨河那段不打墩，让斜拉桥自己的塔承重。 */
    for (let s = Math.ceil(s0 / 14.2) * 14.2; s < s1; s += 14.2) {
      const fr = al.frame(s);
      if (!inAny(s, this.cfg.waterRanges)) {
        const j = al.world(fr, 0, UB - 0.02);
        this.b.box([j[0], j[1], j[2]], [2 * HW + 0.06, 0.06, 0.16], rgbOf('#4d5459'), { mat: 'concreteD' });
      }
      if (inAny(s, this.cfg.waterRanges)) continue;
      const h0 = opts.pierH == null ? 9.5 : opts.pierH;
      const foot = Math.min(-1.95 - h0, al.streetDy(s) - 0.3);
      const h = foot < -1.95 ? -1.95 - foot : h0;
      const p = al.world(fr, 0, (-1.95 + foot) / 2);
      this.b.box([p[0], p[1], p[2]], [1.15, h, 3.0], rgbOf('#9aa2a7'), { mat: 'concrete', faces: [0, 1, 4, 5], uv: 0.25 });
      const cap = al.world(fr, 0, -1.90);
      this.b.box([cap[0], cap[1], cap[2]], [1.8, 0.4, 4.2], rgbOf('#8d959a'), { mat: 'concrete' });
    }
    /* 线路两侧的安全围栏 + 检修通道：真实磁浮沿线是封闭线路，
       梁两侧各有一条检修走道，没有它画面里就是一根悬空的光梁。 */
    for (const side of [-1, 1]) {
      const wp = path.map(f => { const p = al.world(f, side * 2.35, -1.0); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(wp, [{ x: 0, y: 0, nx: side, ny: 0 }, { x: 0, y: 1.2, nx: side, ny: 0 }],
        { mat: 'glassSoft', color: rgbOf('#8fb9c6'), closed: false, uvAlong: 1 / 2.5, vSpan: 1 });
    }
    return this;
  }

  /** 明挖箱涵段（车站之间进出站的地方，断面变矩形） */
  /** 一台**自动扶梯**或一部**楼梯**：在（横向,竖向）平面里从 (x0,y0) 升到 (x1,y1)，
   *  沿线路方向居中在 `so` 处、宽 `w`。x 传**无符号横向距离**，内部乘 side。
   *
   *  为什么要自己造正交基：`sweep` 把截面 x→fr.r、y→fr.u，而这条构件的前进方向
   *  在（横向,竖向）平面里 —— 沿用轨道基等于让截面长轴与路径同向，扫出来是
   *  一条塌扁带子而不是 1.25 m 宽的梯体（第 71 条"高架站扶手沿下降方向扫矩形"
   *  同源，那一版扫出塌扁带、并把 63 级悬空踏步盒改成折线裙才修好）。
   *  所以这里给路径点配 r′=线路前向、u′=normalize(cross(r′,切向))、f′=切向。
   */
  _stepsUp(fr, side, x0, y0, x1, y1, so, w, esc) {
    const al = this.cfg.al;
    const W = (x, y) => {
      const q = al.world(fr, side * x, y);
      return [q[0] + fr.f[0] * so, q[1] + fr.f[1] * so, q[2] + fr.f[2] * so];
    };
    const A = W(x0, y0), B = W(x1, y1);
    const tan3 = norm3([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
    let up3 = norm3(cross(fr.f, tan3));
    /* 下行梯（高架站街面↔站台）时 cross 出来的"上"会翻到地下那侧，
       桁架就跑到踏步上面去了。按世界 Y 把它扳回来 —— 判据量的是"桁架在踏步之下"。 */
    if (up3[1] < 0) up3 = [-up3[0], -up3[1], -up3[2]];
    const L = Math.hypot(x1 - x0, y1 - y0), half = w / 2;
    const nodes = [];
    for (let k = 0; k <= 8; k++) {
      const kk = k / 8;
      nodes.push({ p: W(x0 + (x1 - x0) * kk, y0 + (y1 - y0) * kk), r: fr.f, u: up3, f: tan3, s: kk * L });
    }
    /* 桁架：一条 0.62 m 深的闭合箱梁沿斜面扫过去。没有它，踏步就是
       "一排浮在空中的瓷砖"——高架站楼梯改之前正是这个读法。 */
    this.b.sweep(nodes, Geo.rectProfile(-half, -0.62, half, -0.02),
      { mat: 'metal', color: rgbOf('#8d959b'), closed: true, uvAlong: 1 / 2, vSpan: 1 / w });
    /* 两侧栏板 + 扶手带：玻璃栏板立得**垂直于斜面**（真实扶梯就是这样），
       扶手带压在栏板顶上。材质按 esc 分：扶梯用玻璃、楼梯用实体栏板。 */
    for (const sgn of [-1, 1]) {
      const rail = nodes.map(n => ({
        p: [n.p[0] + n.r[0] * sgn * half, n.p[1] + n.r[1] * sgn * half, n.p[2] + n.r[2] * sgn * half],
        r: n.r, u: n.u, f: n.f, s: n.s }));
      this.b.sweep(rail, Geo.rectProfile(-0.035, 0, 0.035, 1.05),
        { mat: esc ? 'glassSoft' : 'granite', color: rgbOf(esc ? '#9fd0dc' : '#b4bbbf'),
          alpha: esc ? 0.42 : 1, closed: true, uvAlong: 1 / 2, vSpan: 1 });
      const cap = nodes.map(n => ({
        p: [n.p[0] + n.r[0] * sgn * half + n.u[0] * 1.10, n.p[1] + n.u[1] * 1.10, n.p[2] + n.u[2] * 1.10],
        r: n.r, u: n.u, f: n.f, s: n.s }));
      this.b.sweep(cap, Geo.rectProfile(-0.065, -0.05, 0.065, 0.05),
        { mat: 'metal', color: rgbOf('#252c33'), closed: true, uvAlong: 1 / 2, vSpan: 1 / 0.13 });
    }
    /* 踏步。`box` 的 yaw 让盒子与线路平行 —— 尺寸写世界轴就是第 30 条那一族
       （"台阶与线路不平行"）。扶梯 0.40 m 一级连续齿链；楼梯按 0.16 m 踢面。 */
    const yaw = Math.atan2(fr.f[0], fr.f[2]);
    const n = Math.max(6, Math.round(esc ? L / 0.40 : (y1 - y0) / 0.16));
    for (let k = 0; k < n; k++) {
      const kk = (k + 0.5) / n, p = W(x0 + (x1 - x0) * kk, y0 + (y1 - y0) * kk);
      this.b.box([p[0], p[1] + (esc ? -0.03 : -0.09), p[2]],
        esc ? [0.40, 0.07, w * 0.88] : [(x1 - x0) / n, 0.18, w * 0.92],
        rgbOf(esc ? '#5b646b' : '#b4bbbf'),
        { mat: esc ? 'metal' : 'granite', faces: [2], yaw });
    }
    /* 上下两端着陆板：没有端部平台，梯体就是"斜着插进地里的一根梁"。 */
    for (const [px, py] of [[x0 - 0.6, y0], [x1 + 0.6, y1]]) {
      const p = W(px, py);
      this.b.box([p[0], p[1] - 0.07], [1.25, 0.14, w + 0.55], rgbOf('#a7aeb2'), { mat: 'concrete', yaw });
    }
    /* 扶梯底部的地脚灯 + 沿线一盏烘焙灯：人工光走**加算**通道（第 17 条），
       乘进反照率等于在地下 0.09 的天光里白装。 */
    const mid = W((x0 + x1) / 2, (y0 + y1) / 2);
    this.lg.add(mid[0], mid[1] + 2.2, mid[2], [0.92, 0.96, 1], 8.5, 0.55);
    const foot = W(x0 - 0.2, y0 + 0.05);
    this.b.box([foot[0], foot[1] + 0.02, foot[2]], [0.30, 0.03, w * 0.7], rgbOf('#ffd9a0'),
      { mat: 'emissive', emi: 0.9, yaw });
    return this;
  }

  cutCover(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al, w = opts.w || 4.55, h = opts.h || 5.75, y0 = opts.y0 == null ? -0.7 : opts.y0;
    /* 箱涵两道墙的位置可带偏移（B 阶段第 2 层：岛式明挖箱体不对称 ——
       岛背后 10.65、走廊侧 14.3）。缺省仍是对称 ±w，老调用一个字不用改。 */
    /* xlo/xhi 由调用方按"带符号横向"给出，这里统一排序 —— rectProfile 与梁尺寸都要求 xlo<xhi */
    const xl0 = opts.xlo == null ? -w : opts.xlo, xh0 = opts.xhi == null ? w : opts.xhi;
    const xlo = Math.min(xl0, xh0), xhi = Math.max(xl0, xh0);
    const path = al.frames(s0, s1, opts.step || 5);
    const hh = h - y0;
    /* 明挖箱涵是"槽"：列车在里面看的是**底板的上表面**和**两道内侧墙**。
       原来的截面写成 (-w,y0)→(w,y0)→(w,h)→(-w,h)→(-w,y0)，等于把顶部又封了一道
       （那条"盖板"两端法向是 (1,0) 与 (-1,0)，平均成零向量，绕序没人裁决、
       光照也算不出来），而底板法向写成 (0,-1) —— 朝岩体，于是整个箱涵的
       可见面全部是"绕序与法向相反"的那一侧：混凝土壁拿不到一点烘焙光。
       现在按真实可见面重给：三点两条墙 + 底板，法向一律朝槽内，
       角点取相邻两边的角平分线；flip 交给 sweep 的自动判定。 */
    const k = Math.SQRT1_2;
    const prof = [
      { x: xlo, y: hh, nx: 1, ny: 0 },
      { x: xlo, y: 0, nx: k, ny: k },
      { x: xhi, y: 0, nx: -k, ny: k },
      { x: xhi, y: hh, nx: -1, ny: 0 },
    ];
    this.b.sweep(path, prof, { mat: 'concrete', color: rgbOf('#9aa2a8'), closed: false, uvAlong: 1 / 3, vSpan: 1 / Math.max(1, 2 * w) });
    // 顶板结构梁（箱体不对称时梁长跟两道墙走）
    for (let s = Math.ceil(s0 / 7) * 7; s < s1; s += 7) {
      const fr = al.frame(s);
      const p = al.world(fr, (xlo + xhi) / 2, h - 0.22);
      this.b.box([p[0], p[1], p[2]], [xhi - xlo, 0.42, 0.36], rgbOf('#8b9399'), { mat: 'concrete', faces: [2, 3, 4, 5] });
    }
    // 双侧灯槽（贴各自那道墙）
    for (let s = Math.ceil(s0 / 6) * 6; s <= s1; s += 6) {
      const fr = al.frame(s);
      for (const wx of [xlo + 0.55, xhi - 0.55]) {
        const p = al.world(fr, wx, h - 0.55);
        this.b.plate([p[0], p[1], p[2]], [0, 0, 2.4], [0, 0.16, 0], [0, -1, 0], rgbOf('#eaf2f8'), { mat: 'emissive', uv: 1, emi: 1.5 });
        this.lg.add(p[0], p[1], p[2], [0.90, 0.95, 1.0], 15, 0.85);
      }
    }
    return this;
  }

  /* -------------------------------------------------------------- 轨道 */
  /** 两点间方杆（landmark.js 的 strut 同款，世界侧也要用：行道树的主枝）。 */
  _strut(p0, p1, hw, color, opts) {
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
    this.b.sweep([{ p: p0, r, u, f, s: 0 }, { p: p1, r, u, f, s: len }], prof,
      { mat: opts.mat || 'paint', color, closed: true, uvAlong: 1 / Math.max(2, len), vSpan: 1, emi: opts.emi || 0 });
  }

  /** 双股钢轨 + 枕木/道床 + 扣件 + 里程标 + 接触网或第三轨。
   *  `opts.lat`：整条轨道结构（钢轨、扣件、道床、排水、供电）横向平移的
   *  里程，用于**对向股道**（双线断面，第 108 条）。横向平移的是"股道中心"，
   *  不是把右轨再往右挪 —— 平移之后左右轨仍按本股道中心 ± gauge/2 布，
   *  这才是平行双线，而不是四轨错开。
   *  `opts.signage`：里程标/信号机只属于**本线**的闭塞体系（SH.blocks 是按
   *  本线站表铺的），对向股道传 false 跳过，否则信号柱会立在别人的分区上。 */
  track(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al;
    const gauge = opts.gauge || 1.5;
    const lat = opts.lat || 0;
    /* `lat` 允许是**里程的函数**（对向股道在岛式站区要搬家）。整条轨道结构 ——
       钢轨、道床板、扣件、排水槽、第三轨 —— 必须一起跟着这个函数走，
       否则就是"轨移了道床没移"，那种"进了参数没进公式"的老错。 */
    const LAT = typeof lat === 'function' ? lat : () => lat;
    const path = al.frames(s0, s1, opts.step || 3);
    const rp = Geo.railProfile();
    for (const side of [-1, 1]) {
      const shifted = path.map(f => { const p = al.world(f, LAT(f.s) + side * gauge / 2, -0.06); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(shifted, rp, { mat: 'rail', color: rgbOf('#9aa0a4'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
    }
    // 整体道床板：以前轨下只有零星扣件与排水缝，两股轨之间直接露出
    // 梁槽底板/隧道底 —— 驾驶室视角读起来像"公路上画了两条线"。
    // 一整条混凝土道床板（lat ±1.15、厚 0.30、顶面 −0.05）把轨道结构
    // 做成"体"，扣件坐在板上，排水缝压在板顶。枕木道床（ballast）分支
    // 自有碎石体，不铺这块板。
    if (!opts.ballast) {
      const bp = al.frames(s0, s1, opts.step || 3).map(f => { const p = al.world(f, LAT(f.s), 0); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(bp, Geo.rectProfile(-1.15, -0.35, 1.15, -0.05),
        { mat: 'concreteD', color: rgbOf('#7b838a'), closed: true, uvAlong: 1 / 3, vSpan: 1 / 2.3 });
    }
    // 枕木 / 道床板
    const spacing = opts.sleeperSpacing || 0.65;
    const from = Math.ceil(s0 / spacing) * spacing;
    if (opts.ballast) {
      for (let s = from; s < s1; s += spacing) {
        const fr = al.frame(s);
        const p = al.world(fr, LAT(s), -0.10);
        this.b.box([p[0], p[1], p[2]], [2.6, 0.16, 0.24], rgbOf('#3d3733'), { mat: 'concreteD', faces: [2, 4, 5] });
      }
    } else {
      // 整体道床：只画扣件，成本低得多
      for (let s = from; s < s1; s += 1.3) {
        for (const side of [-1, 1]) {
          const fr = al.frame(s);
          const p = al.world(fr, LAT(s) + side * gauge / 2, -0.02);
          this.b.box([p[0], p[1], p[2]], [0.30, 0.06, 0.16], rgbOf('#2f363b'), { mat: 'metal', faces: [2] });
        }
      }
    }
    // 轨枕间排水槽 / 道床缝
    for (let s = Math.ceil(s0 / 6.5) * 6.5; s < s1; s += 6.5) {
      const fr = al.frame(s);
      const p = al.world(fr, LAT(s), -0.03);
      this.b.box([p[0], p[1], p[2]], [3.0, 0.02, 0.06], rgbOf('#394145'), { mat: 'concreteD', faces: [2] });
    }
    /* 供电：noSupply = 一点都不铺（高架正线的供电由 viaduct() 自己负责 ——
       以前这个口子只是写进了注释，track() 根本不读它，于是每条 'oh' 线的高架
       段同时长出接触网（viaduct 铺的）与第三轨（这里铺的），16 号线则铺出
       两份第三轨；逐米审计 dev/audit-track.js 的"高架段第三轨"就是它）。
       catenary = 接触网；都不传 = 第三轨（隧道/库区/地下站引入段的设计口径）。 */
    if (opts.noSupply) {}
    else if (opts.catenary) this.catenary(s0, s1);
    else this.thirdRail(s0, s1, gauge, lat);
    // 里程标与信号
    if (opts.signage !== false) this.signage(s0, s1);
    return this;
  }

  thirdRail(s0, s1, gauge, lat) {
    const al = this.cfg.al;
    const prof = Geo.coverProfile(0.16, 0.24);
    const LAT = typeof lat === 'function' ? lat : () => (lat || 0);
    for (const side of [-1, 1]) {
      const shifted = al.frames(s0, s1, 4).map(f => { const p = al.world(f, LAT(f.s) + side * (gauge / 2 + 0.62), 0.16); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(shifted, prof, { mat: 'concrete', color: rgbOf('#7e868c'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
    }
  }

  catenary(s0, s1, opts) {
    const al = this.cfg.al;
    opts = opts || {};
    const path = al.frames(s0, s1, 6);
    const wire = [{ x: 0, y: 0, nx: 0, ny: 1 }, { x: 0.05, y: 0, nx: 0, ny: 1 }];
    for (const off of [-0.38, 0.38]) {
      const wp = path.map(f => { const p = al.world(f, off, 5.55); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(wp, wire, { mat: 'steel', color: rgbOf('#3a4147'), closed: false, uvAlong: 1, vSpan: 1 });
    }
    if (opts.bare) return;
    // 门型接触网支柱：单侧悬臂更贴近上海高架的实景，
    // 双侧门架在驾驶室视角里会变成压在眼前的黑色横梁。
    for (let s = Math.ceil(s0 / 32) * 32; s < s1; s += 32) {
      const fr = al.frame(s);
      const side = (Math.round(s / 32) % 2) ? 1 : -1;
      const p = al.world(fr, side * 2.42, 0);
      this.b.box([p[0], p[1] + 2.9, p[2]], [0.20, 5.8, 0.20], rgbOf('#8b959b'), { mat: 'metal', faces: [0, 1, 2, 3] });
      const arm = al.world(fr, side * 1.3, 5.62);
      this.b.box([arm[0], arm[1], arm[2]], [2.4, 0.13, 0.13], rgbOf('#7d878d'), { mat: 'metal' });
      const drop = al.world(fr, side * 0.35, 5.35);
      this.b.box([drop[0], drop[1], drop[2]], [0.06, 0.55, 0.06], rgbOf('#5d666c'), { mat: 'metal' });
    }
  }

  /** 里程标、限速标、停车标、信号机 */
  signage(s0, s1) {
    const al = this.cfg.al;
    for (let s = Math.ceil(s0 / 200) * 200; s < s1; s += 200) {
      const fr = al.frame(s), p = al.world(fr, this._side * 2.35, 0.9);
      this.b.box([p[0], p[1], p[2]], [0.05, 0.5, 0.22], rgbOf('#e8eef2'), { mat: 'paint', emi: 0.25 });
    }
    /* 信号机：架数与间距**读闭塞分区表**（`SH.blocks`，与调度器同一份），
       不是"从里程 0 起铺的整数公里格"。真实固定闭塞的边界是"出站信号机
       （站中心+96）+ 站间再均分 2~4 格"，所以按站分段 —— 出站口那一架就是
       出站信号机，与真实同一布局，不再需要单独一列出站信号机。
       灯位自上而下 绿·红·黄，与"三灯位凑四显示"是同一套机构。 */
    const LENS = [
      { aspect: 'proceed', dy: 0.36, color: '#1c6b3c' },
      { aspect: 'stop', dy: 0.00, color: '#7a1d24' },
      { aspect: 'caution', dy: -0.36, color: '#7a5c17' },
    ];
    this.sigLamps = this.sigLamps || [];
    this._sigSeen = this._sigSeen || new Set();
    /* 信号机沿**分区入口**铺：`SH.blocks(al)` 就是"出站信号机（站中心+96）+
       站间再均分 2~4 格"的边界表，调度器的防护与这些透镜的里程读同一份，
       才不会出现"画面绿灯正对着被占用分区"这种自洽的假系统。 */
    const B = SH.blocks(al, (this.cfg.stations && this.cfg.stations.length) || al.stationS.length);
    for (let i = 0; i < B.length; i++) {
      const s = B[i][0];
      if (s < s0 || s >= s1) continue;
      /* 相邻 run 各有 22 m 重叠（见 buildRuns），同一个里程会被两个 run 各交一遍；
         以前这个重叠只让信号柱双画（同位置同颜色，看不出来），现在透镜要进
         批次表，重复一次就是同一盏灯画两遍。按里程去重，键取整以免浮点累加错位。 */
      const key = Math.round(s);
      if (this._sigSeen.has(key)) continue;
      this._sigSeen.add(key);
      /* 信号柱立在**司机能看到的那一侧**，而且这一侧由线决定（`wb._side`），不由窗口切法决定。
         以前写的是 `Math.round(s0/500)%2`：注释说"与 run 的边界从哪儿切无关"，可它算的正是
         `s0` —— 换一个切法就换一条边，站台上量到的对向间隙顶点就是它派来的。
         而且"侧式站台的对面"在两股道只有 4 m 的站箱里等于"对面那列车的限界里"。 */
      const fr = al.frame(s), sd = this._side;
      const p = al.world(fr, sd * 2.42, 0);
      this.b.box([p[0], p[1] + 1.3, p[2]], [0.10, 2.6, 0.10], rgbOf('#39424a'), { mat: 'metal' });
      const h = al.world(fr, sd * 2.42, 2.66);
      this.b.box([h[0], h[1], h[2]], [0.44, 1.10, 0.34], rgbOf('#151b1f'), { mat: 'paint' });
      /* 透镜：每片单独成批，运行时按 `Dispatcher.aspectAt()` 用
         `r.draw(b, IDENT, {emi})` 点亮 —— 与屏蔽门/手柄/驾驶室指示灯同一条按批次
         覆盖通道。法向取 **−f**（朝着接近中的司机），所以从背面看会被正确剔掉；
         以前用 `cylZ` 把灯片轴向写成世界 Z，东西向的线路上整架信号机是侧着的。
         `plate` 的 ax/ay 是**全长**不是半长（这条已经咬过一次），所以 0.30 = 30 cm 见方，
         与真实透镜 φ≈200 mm 加遮檐同量级。 */
      for (const lens of LENS) {
        const c = al.world(fr, sd * 2.46, 2.66 + lens.dy);
        const sub = new Builder();
        sub.plate([c[0], c[1], c[2]],
          [fr.r[0] * 0.30, fr.r[1] * 0.30, fr.r[2] * 0.30],
          [fr.u[0] * 0.30, fr.u[1] * 0.30, fr.u[2] * 0.30],
          [-fr.f[0], -fr.f[1], -fr.f[2]], rgbOf(lens.color), { mat: 'light', emi: 1 });
        this.sigLamps.push({ s: key, block: i, aspect: lens.aspect, kind: 'exit', mesh: sub.finish() });
      }
    }

    /* ---- 进站信号机（第 104 条）----
     * 每一站的**站台入口侧**（站中心 − 96 m）再架一架，防护的是"站台所在的那个
     * 闭塞分区"。它与出站信号机是两件不同的事：出站信号机防护**前方区间**，
     * 进站信号机防护**站台本身** —— 真实固定闭塞里司机进站的凭证就是它，
     * 绿灯才允许进站。以前全线只有出站信号机，"进站"这件事在信号上没有凭证。
     *
     * 为什么代价可以接受：运行时烘焙窗口只有 ~840 m（含 1~2 站），所以一次只多
     * 6 个批次；`test-traffic` 那种烘全线的情形只在离线判据里出现。
     *
     * **仍然没有的**：侧向进路的**双黄** —— 它要求折返渡线几何（E4），
     * 没有渡线的"双黄"是在显示一条不存在的进路。库区的月白/蓝已经落地
     * （第 109 条，进路表 `SH.routes` + 入库信号机 + 矮柱调车信号机）。 */
    for (let i = 1; i < al.stationS.length; i++) {
      const s = al.stationS[i] - SH.STATION_HALF;
      if (s < s0 || s >= s1) continue;
      const key = Math.round(s);
      if (this._sigSeen.has(key)) continue;
      /* 防护分区 = 站台所压的那一格（站台从 S[i−1]+96 铺到 S[i]+96） */
      let bi = -1;
      for (let k = 0; k < B.length; k++) if (B[k][0] <= s + 0.5 && s + 0.5 < B[k][1]) { bi = k; break; }
      if (bi < 0) continue;
      this._sigSeen.add(key);
      const fr = al.frame(s), sd = (t => (Math.round(t / 500) % 2) ? 1 : -1)(s0);
      const p = al.world(fr, sd * 2.42, 0);
      this.b.box([p[0], p[1] + 1.3, p[2]], [0.10, 2.6, 0.10], rgbOf('#39424a'), { mat: 'metal' });
      const h = al.world(fr, sd * 2.42, 2.66);
      this.b.box([h[0], h[1], h[2]], [0.44, 1.10, 0.34], rgbOf('#151b1f'), { mat: 'paint' });
      for (const lens of LENS) {
        const c = al.world(fr, sd * 2.46, 2.66 + lens.dy);
        const sub = new Builder();
        sub.plate([c[0], c[1], c[2]],
          [fr.r[0] * 0.30, fr.r[1] * 0.30, fr.r[2] * 0.30],
          [fr.u[0] * 0.30, fr.u[1] * 0.30, fr.u[2] * 0.30],
          [-fr.f[0], -fr.f[1], -fr.f[2]], rgbOf(lens.color), { mat: 'light', emi: 1 });
        this.sigLamps.push({ s: key, block: bi, aspect: lens.aspect, kind: 'entry', mesh: sub.finish() });
      }
    }
    /* 出站与进站两族信号机**都**不往光照网格里加点光源：一盏 φ0.2 m 的灯照不亮
       4 m 半径，而它在烘焙时被算进去的颜色与运行时的真实显示是两个真值 ——
       显示会变，烘焙的辉光不会。灯具自身的可见性交给 `mat:'light'` 的自发光。 */
  }

  /* -------------------------------------------------------------- 高架 */
  /* ---------------------------------------------------------- 浦江线 APM
   * 胶轮 + 混凝土行车道 + 中央导向轨。浦江线是上海唯一一条胶轮自动捷运，
   * 它既不是钢轨整体道床，也不是磁浮的长定子梁 —— 以前两者都被当成"高架的一种"
   * 铺了钢轨和枕木，从司机台看出去是一条不该存在的铁轨。
   * 断面（x 横向、y 竖向，y=0 是行车道顶面 = 本项目的"轨面"）：
   *   两条 0.70 m 宽的行车道（胎面）中心在 ±0.95，中间是导向槽；
   *   槽底 −0.30，两根导向轨在 ±0.32、顶面 +0.12（水平导向轮夹着它们跑）；
   *   承力板 −0.35 ~ −0.55、宽 ±2.10；接触轨贴在行车道外缘 ±1.40。
   * 环序一律逆时针（与 `gwProfile()` 同一约定），法向交给 `Geo.miter`。 */
  apmLane(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al;
    const path = al.frames(s0, s1, 4);
    const A = SH.APM, DH = A.deckHalf, DB = A.deckBot, DT = A.deckTop;
    const deck = Geo.miter([
      { x: -DH, y: DB }, { x: DH, y: DB }, { x: DH, y: DT },
      { x: A.laneOut, y: DT }, { x: A.laneOut, y: 0 }, { x: A.laneIn, y: 0 },
      { x: A.laneIn, y: A.chanFloor }, { x: -A.laneIn, y: A.chanFloor }, { x: -A.laneIn, y: 0 },
      { x: -A.laneOut, y: 0 }, { x: -A.laneOut, y: DT }, { x: -DH, y: DT },
    ]);
    this.b.sweep(path, deck, { mat: 'concrete', color: rgbOf('#aeb5b9'), closed: true, uvAlong: 1 / 3, vSpan: 1 / 4.4 });
    const bar = (a, b, y0, y1, mat, col, vs) => {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      this.b.sweep(path, Geo.miter([
        { x: lo, y: y0 }, { x: hi, y: y0 }, { x: hi, y: y1 }, { x: lo, y: y1 },
      ]), { mat: mat, color: rgbOf(col), closed: true, uvAlong: 1 / 2, vSpan: vs });
    };
    for (const side of [-1, 1]) {
      bar(side * A.guideIn, side * A.guideOut, A.chanFloor, A.guideTop, 'steel', '#8d979e', 1 / 0.42);
      bar(side * A.conIn, side * A.conOut, -0.16, -0.04, 'metal', '#6f7a82', 1 / 0.12);
    }
    /* 伸缩缝：每 12 m 一道深色横缝。没有它，整条行车道就是一片没有刻度的灰，
       而且速度感全无 —— 胶轮线路的缝距是司机判断位置的唯一视觉线索。 */
    for (let s = Math.ceil(s0 / 12) * 12; s < s1; s += 12) {
      const fr = al.frame(s);
      for (const side of [-1, 1]) {
        const p = al.world(fr, side * A.laneLat, 0.005);
        this.b.box([p[0], p[1], p[2]], [A.laneOut - A.laneIn, 0.02, 0.06], rgbOf('#4d5257'), { mat: 'paint' });
      }
    }
    /* 桥墩：墩底必须扎进街面以下（走 streetDy 基准），与地铁高架同一族规则；
       跨江/跨河那段不打墩。pierH 传 0 表示这一段在站房/库房底下，不露墩。 */
    const ph = opts.pierH == null ? 8.5 : opts.pierH;
    if (ph > 0) for (let s = Math.ceil(s0 / 12) * 12; s < s1; s += 12) {
      if (inAny(s, this.cfg.waterRanges)) continue;
      const fr = al.frame(s);
      const foot = Math.min(-0.55 - ph, al.streetDy(s) - 0.3);
      const h = foot < -0.55 ? -0.55 - foot : ph;
      const p = al.world(fr, 0, (-0.55 + foot) / 2);
      this.b.box([p[0], p[1], p[2]], [1.20, h, 3.20], rgbOf('#98a0a5'), { mat: 'concrete', faces: [0, 1, 4, 5], uv: 0.25 });
      const cap = al.world(fr, 0, -0.52);
      this.b.box([cap[0], cap[1], cap[2]], [2.20, 0.42, 4.80], rgbOf('#8d959a'), { mat: 'concrete' });
    }
    return this;
  }

  viaduct(s0, s1, opts) {
    opts = opts || {};
    const al = this.cfg.al;
    const path = al.frames(s0, s1, 4);
    // U 形梁槽
    const deck = [
      { x: -3.05, y: -0.70, nx: 0, ny: -1 }, { x: 3.05, y: -0.70, nx: 0, ny: -1 },
      { x: 3.05, y: 0.55, nx: 1, ny: 0 }, { x: 2.72, y: 0.55, nx: 1, ny: 0.2 },
      { x: 2.72, y: -0.35, nx: 0, ny: -1 }, { x: -2.72, y: -0.35, nx: 0, ny: -1 },
      { x: -2.72, y: 0.55, nx: -1, ny: 0.2 }, { x: -3.05, y: 0.55, nx: -1, ny: 0 },
    ];
    this.b.sweep(path, deck, { mat: 'concrete', color: rgbOf('#a7aeb2'), closed: false, uvAlong: 1 / 3, vSpan: 0.3 });
    // 声屏障
    for (const side of [-1, 1]) {
      const sp = path.map(f => { const p = al.world(f, side * 3.02, 0.55); return { p, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(sp, [{ x: 0, y: 0, nx: side, ny: 0 }, { x: 0, y: 1.5, nx: side, ny: 0 }],
        { mat: 'glassSoft', color: rgbOf('#9fd0dc'), closed: false, uvAlong: 1 / 2.5, vSpan: 1 });
    }
    // 桥墩
    for (let s = Math.ceil(s0 / 26) * 26; s < s1; s += 26) {
      /* 跨江/跨河的里程不打墩：那一段的荷载由斜拉桥自己的塔与索承担。
         以前每 26 m 一根，一直打到江心，观景截图里桥下就是一排棕色板子
         插在水里，比桥塔还抢眼。 */
      if (inAny(s, this.cfg.waterRanges)) continue;
      const fr = al.frame(s);
      const h0 = opts.pierH == null ? 9.5 : opts.pierH;
      /* 墩底要扎进街面以下。街面走 groundY 基准，而这里以前只按固定 pierH
         从**本里程轨面**往下量 —— 两者实测最多差 3.5 m，于是有的高架站的
         桥墩吊在路面上方三米多（墩底与街面不同源这一族的第六次）。 */
      const foot = Math.min(-0.7 - h0, al.streetDy(s) - 0.3);
      const h = foot < -0.7 ? -0.7 - foot : h0;
      const p = al.world(fr, 0, (-0.7 + foot) / 2);
      this.b.box([p[0], p[1], p[2]], [1.5, h, 5.6], rgbOf('#98a0a5'), { mat: 'concrete', faces: [0, 1, 4, 5], uv: 0.25 });
      const cap = al.world(fr, 0, -0.66);
      this.b.box([cap[0], cap[1], cap[2]], [2.2, 0.5, 7.4], rgbOf('#8d959a'), { mat: 'concrete' });
    }
    // 供电方式：上海全线架空接触网，仅 16 号线与浦江线为接触轨
    // opts.noSupply：高架分支里 viaduct() 已经架过接触网/接触轨，
    // 这里再走一遍就会看到双份门架与双线。
    if (!opts.noSupply) {
      const oh = (this.cfg.profile && this.cfg.profile.supply) !== 'third';
      if (oh || opts.catenary) this.catenary(s0, s1); else this.thirdRail(s0, s1, 1.5);
    }
    return this;
  }

  /* -------------------------------------------------------------- 停车基地 */
  /**
   * 终点停车基地：出入段线 + 停车线 + 车挡 + 入库信号机 + 运用库棚 + 高杆灯。
   *
   * 为什么放在**线路端头之外**、并且整段按"露天"处理：真实地铁正线两端都以
   * 出入段线接到地面运用库，司机跑完最后一趟就是"入库"。这一段原本会被当成
   * 地下段套上隧道管（端头站后面不是高架就是隧道），那样基地根本没有存在的空间。
   *
   * 三条硬约定（每一条都是这一族 bug 换来的）：
   *   · 横向/竖向一律走轨道基 `al.world(f, lat, dy)`，不出现 `[0,0,k]`、`[k,0,0]`
   *     这类世界轴字面量 —— 线路 bearing 是随机的，世界轴只在碰巧沿 Z 的那段对；
   *   · 库内地面与轨道同基（轨面 −0.15），**不用街面基准 −10.9** —— 基地是
   *     一个与轨面齐平的露天场院，不是"街面上摆了几条轨"；
   *   · 人会在背后活动的面（库房墙、雨棚）必须是**闭合有厚度**的截面，
   *     否则参与背面剔除时从那一侧整个消失。
   *
   * @param a   基地起始里程（入库信号机外方）
   * @param z   基地尽头里程（车挡之后）
   * @param opt {side, roads, color, sign}
   */
  depot(a, z, opt) {
    opt = opt || {};
    const al = this.cfg.al, B = this.b, R = rgbOf;
    const side = opt.side < 0 ? -1 : 1;
    /* 股道几何只读单点常数（SH.DEPOT，第 109 条）：条数 / 间距 / 首线横距。
       以前 roads 从调用口传、pitch 在这里抄一份 —— 调用口一个数、这里一个数，
       改一处另一处不动，停车线就会和进路表互相打脸。 */
    const roads = SH.DEPOT.roads;
    const pitch = SH.DEPOT.pitch;
    const path = al.frames(a, z, 6);
    const W = (f, lat, dy) => al.world(f, side * lat, dy);
    const frame = (f, lat, dy) => ({ p: W(f, lat, dy), r: f.r, u: f.u, f: f.f, s: f.s });
    /* 库内地坪：一条与轨面齐平的**闭合矩形截面**板（有厚度，不是单面片），
       横向从正线外侧 SH.DEPOT.first 铺到最外一条停车线再放 8 m。
       注意截面是沿"横向"铺开的，所以路径取中心线、宽度写进 profile ——
       把两条横向边拼成一条来回的路径会折成一片自交面。 */
    const F0 = SH.DEPOT.first;
    const span = F0 + roads * pitch + 8;
    const mid = (F0 + span) / 2, wid = span - F0;
    const apron = path.map(f => frame(f, mid, -0.30));
    /* rectProfile 的四个参数是 (x0,y0,x1,y1) **坐标**，不是宽高 ——
       以前传成 (-wid/2, -0.15, wid, 0.30)，地坪外缘多铺了 50%、
       顶面还抬到轨面 0（设计口径是 −0.15）。 */
    B.sweep(apron, Geo.rectProfile(-wid / 2, -0.15, wid / 2, 0.15),
      { mat: 'concreteD', color: R('#5a6066'), closed: true, uvAlong: 1 / 6, vSpan: 1 / wid, emi: 0.04 });
    /* 停车线：地铁是"每根道床带 + 两根钢轨"，磁浮是"一条轨道梁"。
       库里长出钢轨是硬伤 —— 这条线全线没有轮轨接触。 */
    const maglev = !!(opt.maglev || (this.cfg.profile && this.cfg.profile.maglev));
    const rp = Geo.railProfile();
    for (let i = 1; i <= roads; i++) {
      const lat = F0 + i * pitch;
      if (maglev) {
        const beam = path.map(f => frame(f, lat, 0));
        B.sweep(beam, gwProfile(), { mat: 'concrete', color: R('#b2b9bd'), closed: true, uvAlong: 1 / 3, vSpan: 1 / (2 * GW.HW) });
        for (let s = a + 1; s < z - 2; s += GW.statorPitch) {
          const bf = al.frame(s);
          for (const g of [-1, 1]) {
            const p = W(bf, lat + g * 1.12, GW.UB - 0.13);
            B.box([p[0], p[1], p[2]], [0.42, 0.24, 2.0], R('#3b444d'), { mat: 'steel', faces: [0, 1, 2, 3, 5] });
          }
        }
      } else if (!opt.apm) {
        /* 胶轮线的存车线同样是行车道 + 导向轨，不铺钢轨与道床 */
        const bed = path.map(f => frame(f, lat, -0.10));
        B.sweep(bed, [{ x: -1.3, y: 0, nx: 0, ny: 1 }, { x: 1.3, y: 0, nx: 0, ny: 1 }],
          { mat: 'ballast', color: R('#3a3733'), closed: false, uvAlong: 1 / 3, vSpan: 1 / 2.6 });
        for (const g of [-0.75, 0.75]) {
          const rail = path.map(f => frame(f, lat + g, -0.06));
          B.sweep(rail, rp, { mat: 'rail', color: R('#9aa0a4'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
        }
      }
      /* 车挡：库尾端头，混凝土挡块 + 黄黑警示带 */
      const bf = al.frame(z - 4);
      const bp = W(bf, lat, 0.45);
      B.box([bp[0], bp[1], bp[2]], [2.8, 1.1, 0.7], R('#8d949a'), { mat: 'concrete' });
      const st = W(bf, lat, 1.25);
      B.box([st[0], st[1], st[2]], [2.8, 0.5, 0.22], R('#e0b53c'), { mat: 'paint', emi: 0.16 });
    }
    /* 运用库棚：覆盖最外两条线。立柱 + 闭合矩形截面的屋面板（有厚度，能从背面看）。 */
    const shedIn = F0 + Math.max(1, roads - 1) * pitch - 3.2, shedOut = F0 + roads * pitch + 4.2;
    const roofY = 6.4;
    for (let s = a + 12; s < z - 14; s += 9) {
      const fr = al.frame(s);
      for (const lat of [shedIn, shedOut]) {
        const p = W(fr, lat, 0);
        B.box([p[0], p[1] + roofY / 2, p[2]], [0.45, roofY, 0.45], R('#6d747a'), { mat: 'steel' });
      }
    }
    /* 雨棚：路径取中心线，**宽度写进 profile**。
       上一版把"内侧一条边 + 外侧一条边倒序"拼成一条路径，那是一条来回折返的
       自交路径 —— test-wind 当场抓到 roof 14 个绕序反向三角形。 */
    const rfMid = (shedIn + shedOut) / 2, rfW = shedOut - shedIn + 1.2;
    const roof = path.map(f => frame(f, rfMid, roofY));
    B.sweep(roof, Geo.rectProfile(-rfW / 2, -0.14, rfW, 0.28),
      { mat: 'roof', color: R('#4b5257'), closed: true, uvAlong: 1 / 6, vSpan: 1 / rfW, emi: 0.12 });
    /* 檐口梁：一块三百多米长、只有 0.42 m 厚的板，如果边缘什么都没有，
       从库外看就是"一张飘在空中的纸"。两侧各加一道下翻边梁，板就有了厚度感。 */
    for (const sgn of [-1, 1]) {
      const eave = path.map(f => frame(f, rfMid + sgn * (rfW / 2 - 0.22), roofY - 0.30));
      B.sweep(eave, Geo.rectProfile(-0.18, -0.36, 0.18, 0.36),
        { mat: 'metal', color: R('#767d83'), closed: true, uvAlong: 1 / 4, vSpan: 1 });
    }
    /* 屋架下弦的灯带：站在库房底下抬头，屋顶底面是一块**不受光的暗面**，
       实测半个画面是纯黑的洞（比"没有顶棚"更假）。真实运用库是每条停车线的
       屋架下弦挂一排灯 —— 所以灯带按**停车线中心**铺，一条线一列灯，
       而不是随便给两条：放在屋脊两侧 26% 处时车顶亮、道床上方仍然全黑。
       走自发光通道，不是乘进反照率（见光照那条铁律）。 */
    for (let k = 1; k <= roads; k++) {
      const strip = path.map(f => frame(f, F0 + k * pitch, roofY - 0.24));
      B.sweep(strip, [{ x: -0.32, y: 0, nx: 0, ny: -1 }, { x: 0.32, y: 0, nx: 0, ny: -1 }],
        { mat: 'light', color: R('#ffe7bd'), closed: false, uvAlong: 1 / 3, vSpan: 0.64 / 3, emi: 0.62 });
    }
    /* 入库信号机 + 矮柱调车信号机（第 109 条，E3）：显示是**算出来的**，位置读进路表。
       以前这里是两片焊死的自发光盒（红常亮 + 暗绿）：司机跑完末班驶向基地，
       老远就看见一架红灯 —— 信号在说"禁止进入"，而他的进路恰恰就是进库。
       现在灯位挂进 sigLamps（与正线同一套"按批次点亮"通道），显示与占用同真值：
       入库信号机 红/月白两显示（引道被占 → 红，出清 → 月白）；
       每条停车线口一架矮柱调车信号机（指定股道 → 月白，其余 → 蓝，
       "指定股道"由 Dispatcher.shuntRoad 按已回库车数轮转，单点定义）。
       没有道岔几何（停车线是平行横移，不是折返渡线），"股道口"取停车标前 12 m
       —— 司机对位停车时这一列灯就在正前方，月白的那根就是该去的股道。 */
    const mid2 = (a + z) / 2;
    /* 窗口与引道的距离：重叠 0；只在 ±22 m 延伸里擦到边的窗口取最近的基地。
       （两条引道相距几公里，"最近"的只可能是自己的基地 —— 这个兜底不会
       把窗口指错基地，只救那些 midpoint 落在延伸段里、引道口又不在窗口内的
       窄条窗口。） */
    const gap = r => a > r.lead[1] ? a - r.lead[1] : z < r.lead[0] ? r.lead[0] - z : 0;
    const Rts = SH.routes(al);
    let rt = Rts.find(r => mid2 >= r.lead[0] && mid2 <= r.lead[1]);
    if (!rt && Rts.length) rt = Rts.reduce((b, r) => (!b || gap(r) < b.d ? { r, d: gap(r) } : b), null).r;
    if (!rt) throw new Error('depot(): 库区进路表（SH.routes）里找不到这个基地 —— 库区信号的位置必须读表，不许退回散抄的里程');
    /* 法向朝着接近中的司机：尾端基地从末站 +s 驶入，头部基地从首站 −s 驶入 ——
       与正线同一约定（面向来车方向，背面被剔掉）。 */
    const sgDir = rt.end === 0 ? -1 : 1;
    this.sigLamps = this.sigLamps || [];
    this._sigSeen = this._sigSeen || new Set();
    if (!this._sigSeen.has('in:' + rt.end)) {
      this._sigSeen.add('in:' + rt.end);
      const sg = al.frame(rt.sigS), sgw = W(sg, 3.6, 0);
      B.box([sgw[0], sgw[1] + 2.4, sgw[2]], [0.22, 4.8, 0.22], R('#39424a'), { mat: 'metal' });
      const hd = W(sg, 3.6, 5.0);
      B.box([hd[0], hd[1], hd[2]], [0.5, 1.1, 0.34], R('#1b2226'), { mat: 'metal' });
      /* 灯位：月白在上（允许入库）、红在下（禁止）—— 与正线"上灯位权限高"同一读法。
         占用范围 [sigS+10, mark]：车一进引道，身后的入库信号机就转红；
         停准之后保持红，直到这列车出清引道。 */
      for (const lens of [
        { aspect: 'shunt', dy: 0.15, color: '#4c565e' },
        { aspect: 'stop', dy: -0.28, color: '#7a1d24' },
      ]) {
        const c = W(sg, 3.67, 5.0 + lens.dy);
        const sub = new Builder();
        sub.plate([c[0], c[1], c[2]],
          [sg.r[0] * 0.24, sg.r[1] * 0.24, sg.r[2] * 0.24],
          [sg.u[0] * 0.24, sg.u[1] * 0.24, sg.u[2] * 0.24],
          [sg.f[0] * -sgDir, sg.f[1] * -sgDir, sg.f[2] * -sgDir], R(lens.color), { mat: 'light', emi: 1 });
        this.sigLamps.push({ s: Math.round(rt.sigS), aspect: lens.aspect, kind: 'depotIn',
          grp: 'in:' + rt.end, lo: rt.sigS + 10, hi: rt.mark, mesh: sub.finish() });
      }
    }
    for (let i = 1; i <= roads; i++) {
      if (this._sigSeen.has('sh:' + rt.end + ':' + i)) continue;
      this._sigSeen.add('sh:' + rt.end + ':' + i);
      const sR = rt.mark + 12, frR = al.frame(sR), latR = F0 + i * pitch;
      const pw = W(frR, latR, 0);
      B.box([pw[0], pw[1] + 0.35, pw[2]], [0.14, 0.70, 0.14], R('#39424a'), { mat: 'metal' });
      const hh = W(frR, latR, 0.75);
      B.box([hh[0], hh[1], hh[2]], [0.30, 0.62, 0.22], R('#151b1f'), { mat: 'paint' });
      for (const lens of [
        { aspect: 'shunt', dy: 0.12, color: '#4c565e' },
        { aspect: 'shuntStop', dy: -0.12, color: '#2b4d80' },
      ]) {
        const c = W(frR, latR + 0.05, 0.75 + lens.dy);
        const sub = new Builder();
        sub.plate([c[0], c[1], c[2]],
          [frR.r[0] * 0.17, frR.r[1] * 0.17, frR.r[2] * 0.17],
          [frR.u[0] * 0.17, frR.u[1] * 0.17, frR.u[2] * 0.17],
          [frR.f[0] * -sgDir, frR.f[1] * -sgDir, frR.f[2] * -sgDir], R(lens.color), { mat: 'light', emi: 1 });
        this.sigLamps.push({ s: Math.round(sR), aspect: lens.aspect, kind: 'shunt',
          grp: 'sh:' + rt.end + ':' + i, road: i, mesh: sub.finish() });
      }
    }
    /* 高杆灯：库前每隔 30 m 一盏，照亮整片场院（人工光必须走加算的自发光通道） */
    for (let s = a + 20; s < z - 12; s += 30) {
      const fr = al.frame(s), p = W(fr, 3.0, 0);
      B.box([p[0], p[1] + 6.5, p[2]], [0.2, 13, 0.2], R('#5c646a'), { mat: 'steel' });
      const q = W(fr, 3.9, 12.9);
      B.box([q[0], q[1], q[2]], [1.6, 0.3, 0.5], R('#cfd6da'), { mat: 'lamp', emi: 1.5 });
    }
    /* 基地标牌：入库门架上一块"停车基地 · 入库"，用站牌同一套图集与 panel 约定 */
    const sign = this.cfg.sign;
    if (sign) {
      const rect = sign.add('depot:' + (opt.id || this.cfg.stations.length), 512, 106, (c, w, h) =>
        SH.textures.signWayfind(c, w, h, { text: '停车基地 · 入库', sub: 'DEPOT · INBOUND', color: opt.color || '#E4002B' }));
      const gf = al.frame(a + 14);
      for (const lat of [5.5, 9.0]) {
        const p = W(gf, lat, 4.6);
        const nrm = norm3([gf.r[0] * -side, gf.r[1] * -side, gf.r[2] * -side]);
        B.panel([p[0], p[1], p[2]], [0, 0, 4.4 * side], [0, 0.92, 0], nrm, rect, [1, 1, 1], 0.5);
      }
    }
    /* 让远景楼群别长在库里（先登记禁建矩形，再画 farCity 的顺序由调用方保证） */
    const c0 = al.frame(a), c1 = al.frame(z);
    const w0 = W(c0, 0, 0), w1 = W(c1, 0, 0);
    const pad = span + 12;
    this.noBuild.push({ x0: Math.min(w0[0], w1[0]) - pad, x1: Math.max(w0[0], w1[0]) + pad,
      z0: Math.min(w0[2], w1[2]) - pad, z1: Math.max(w0[2], w1[2]) + pad });
    return this;
  }

  /* -------------------------------------------------------------- 车站 */
  /**
   * 侧式/岛式车站。屏蔽门 + 灯槽 + 站名标 + 导向牌 + 广告灯箱 + 柱子。
   * @param s     停车标里程
   * @param side  站台在列车前进方向的哪一侧（+1 右 / -1 左）
   */
  station(s, side, opt) {
    const al = this.cfg.al, cfg = this.cfg;
    const name = opt.name, en = opt.en, code = opt.code, color = cfg.color;
    const PLAT_FRONT = STATION_X.front;      // 站台边缘距线路中心（横向尺寸见 SH.STATION_X）
    const half = SH.STATION_HALF;             // 站台区半长（含端头，单点定义见 SH.STATION_HALF）
    const s0 = s - 150, s1 = s + 42;
    const wallH = 3.05, ceilH = 4.95, boxW = STATION_X.boxW;
    /* ---- B 阶段第 2 层：站体符号 `board` 与岛式横向口径 ----
       `board` = 站体/缘口那一侧的带符号横向。侧式站 board === side（与历史逐字节同）；
       岛式站 board = −side —— 夹在两股道之间的岛必然在本线**内侧**（§7.1 的几何结论），
       缘口、黄线、盲道、屏蔽门、门头梁、色带、站台屏全部跟着 board 走。
       箱涵不对称：岛式明挖箱体从 **越过对向股道** 的远端墙
       （board×(islandSpan + front + 1.6)）到 −board×14.3（走廊/站厅侧加深，
       闸机线与站厅板都在那一侧）——侧式箱体 ±11.0 对称，两道墙的坐标各是
       一份式子（WALLN/WALLF），不许在调用点自己抄。
       **第 2 层这里写的是 board×10.65（"岛背后留 0.6 m 检修空间"）—— 那是错的**：
       对向股道在 board×islandSpan = board×12.1，比 10.65 还远 1.45 m，于是
       箱涵的远端墙**夹在岛的对向缘口与对向股道之间**，岛式站的两条缘口里
       有一条（黄线/盲道/屏蔽门/门头梁/站名标全都在）正对着一堵墙，
       对向车从墙外开过去谁也看不见 —— 岛式站的**定义性画面**（两股道夹一座岛）
       在几何上不成立。远端墙必须越过对向股道，岛的远缘才是真的缘口。
       走廊（闸机/售票/站厅/楼梯）留在 `side` 侧：岛式站的站厅侧走廊在正线外侧。 */
    const island = SH.platType(name) === 'island';
    const board = island ? -side : side;
    const PLAT_W_ISL = SH.ISLAND_W;
    const WALLN = island ? -board * 14.3 : side * boxW;    // 走廊那道墙（内侧坐标）
    /* 远端墙：岛式必须越过对向股道（board×islandSpan），否则缘口对着墙 */
    const WALLF = island ? board * (SH.islandSpan() + PLAT_FRONT + 1.6) : -side * boxW;
    const WALLX_ = island ? Math.abs(WALLN) - 0.35 : boxW - 0.35;  // 设施挂墙的基准
    /* 缘口表：每条缘口一条 { e: 缘口带符号横向, inw: 指向岛/站台内侧 }。
       侧式一条缘口；岛式两条，各自面对一条股道，家具沿 inw 向板内退。 */
    const edges = island
      ? [{ e: board * PLAT_FRONT, inw: board }, { e: board * (PLAT_FRONT + PLAT_W_ISL), inw: -board }]
      : [{ e: side * PLAT_FRONT, inw: side }];
    const BACK = island ? PLAT_FRONT + 0.0 : PLAT_FRONT + STATION_X.width;   // 走廊内缘（岛式没有"站台后区"，从轨侧走道起）
    const WALLX = WALLX_;

    // ---- 明挖箱体（把隧道过渡成矩形空间） ----
    // 高架车站不套箱体：上海 3/5/6/8/9/10/11/13/16/17 号线的地上站都是
    // 露天站台 + 雨棚，套上地下站的矩形箱之后，从站台看出去是一堵墙，
    // 黄昏的城市完全被挡掉，画面立刻从"高架车站"退化成"隧道里的洞"。
    const open = !!opt.open;
    if (!open) this.cutCover(s0, s1, { w: boxW, h: ceilH + 0.6, y0: -0.85, step: 4,
      xlo: island ? Math.min(WALLF, WALLN) : -side * boxW,
      xhi: island ? Math.max(WALLF, WALLN) : side * boxW });

    // ---- 高架车站的站台区桥面与桥墩 ----
    if (open) {
      const dp = al.frames(s0 - 6, s1 + 6, 8);
      /* 站台区桥面是**不对称**的：本线一侧的外沿还是 `front+width+挑檐 = 7.6`，
         对向一侧现在要罩住"越过对向股道之外"的那条站台板，所以外沿跟着
         `SH.farFrontOf` 走（线间距 4 m 时 11.6 m）。以前两边都写 7.6，是因为
         那板的镜像摆在 −2.05~−5.55，正好塞在同一块桥面里 —— 那个摆位是错的。 */
      const DK = STATION_X.deckOver, FARF = SH.farFrontOf(this._oppLat ? this._oppLat(s) : 0);
      const dn = STATION_X.front + STATION_X.width + DK, df = FARF + STATION_X.width + DK;
      /* 截面 x 是**带符号**的横向（沿 fr.r），所以两侧的外沿要先按 side 转正再排序：
         直接写 `side>0 ? -df : dn` 会让 side=−1 的桥面朝boarding 那一侧长 11.6、
         对向那一侧只有 7.6 —— 板子照样悬在桥面外（实测 3 号线 上海南站）。 */
      const e1 = side * dn, e2 = -side * df;
      const xlo = Math.min(e1, e2), xhi = Math.max(e1, e2);
      const deck = [
        { x: xlo, y: -1.05, nx: 0, ny: -1 }, { x: xhi, y: -1.05, nx: 0, ny: -1 },
        { x: xhi, y: 0.05, nx: 1, ny: 0 }, { x: xlo, y: 0.05, nx: -1, ny: 0 },
      ];
      this.b.sweep(dp, deck, { mat: 'concrete', color: rgbOf('#a7aeb2'), closed: true, uvAlong: 1 / 3, vSpan: 1 });
      for (let dz = Math.ceil((s0 - 6) / 13) * 13; dz < s1 + 6; dz += 13) {
        const fr = al.frame(dz);
        /* 柱列贴着两条桥面外沿各退 2.2 m（原来的 ±5.4 就是这个式子在对称桥面下的值）。 */
        for (const px of [side * (dn - 2.2), -side * (df - 2.2)]) {
          const p = al.world(fr, px, -1.05 - 10.2 / 2);
          this.b.box([p[0], p[1], p[2]], [1.4, 10.2, 2.2], rgbOf('#98a0a5'), { mat: 'concrete', faces: [0, 1, 4, 5] });
        }
        const cp = al.world(fr, side * (dn - df) / 2, -1.02);
        this.b.box([cp[0], cp[1], cp[2]], [dn + df - 4.4 + 2.4, 0.5, 2.0], rgbOf('#8d959a'), { mat: 'concrete' });
      }
      // 站台外侧护栏：站在站台板外缘内侧 8 cm，不是悬在桥面上。
      // 栏板要给楼梯口留缺口（B2b）：露天站的楼梯从站台外沿往街面降，
      // 楼梯口（dz ± 1.7 m）必须开在护栏上，否则乘客被自己的护栏拦住 ——
      // 诚实清单上"高架站楼梯穿出护栏"那一笔，一半账在这里清。
      const STAIR_HALF = 1.7;
      const stairAt = i => s + SH.PLATFORM_EXITS[i];
      const railSegs = [];
      let ra = s0;
      for (let i = 0; i < 2; i++) {
        const gz = stairAt(i);
        if (gz - STAIR_HALF > ra && gz < s1) railSegs.push([ra, gz - STAIR_HALF]);
        ra = Math.max(ra, gz + STAIR_HALF);
      }
      if (ra < s1) railSegs.push([ra, s1]);
      for (const [a, z] of railSegs) {
        const rail = al.frames(a, z, 4).map(f => { const q = al.world(f, side * STATION_X.rail, 0.42); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        if (rail.length < 2) continue;
        this.b.sweep(rail, [{ x: 0, y: 0, nx: side, ny: 0 }, { x: 0, y: 1.15, nx: side, ny: 0 }],
          { mat: 'glassSoft', color: rgbOf('#9fd0dc'), closed: false, uvAlong: 1 / 2.5, vSpan: 1 });
      }
    }

    // ---- 站台板 ----
    /* 往"站体那一侧"铺的截面：sweep 把截面 x 映射到 fr.r，所以区间必须按符号平移
       （rectProfile 要求 x0<x1，不能反过来写）。原来这些截面全写成无符号的 0~w，
       于是 side=−1 的那一半车站上，站台板、安全黄线、盲道、门头梁、线路色带**整体
       往线路中心长** —— 实测 3 号线 漕溪路 的站台板横向占到 +1.45 m，把正线压掉一半。
       与上面雨棚那一条同源，规则还是"截面 x 一律带符号"。
       B 阶段第 2 层：符号从 side 换成 **board**（侧式 = side，逐字节不变；岛式 = −side），
       岛式板宽 ISLAND_W（8 m），横跨 board×2.05 ~ board×10.05，两条缘口各对一条股道。 */
    const outRect = (w, y0, y1) => Geo.rectProfile(side > 0 ? 0 : -w, y0, side > 0 ? w : 0, y1);
    const boardRect = (w, y0, y1) => Geo.rectProfile(board > 0 ? 0 : -w, y0, board > 0 ? w : 0, y1);
    const outRect_ = (sgn, w, y0, y1) => Geo.rectProfile(sgn > 0 ? 0 : -w, y0, sgn > 0 ? w : 0, y1);
    const outStrip = w => [{ x: 0, y: 0, nx: 0, ny: 1 }, { x: board * w, y: 0, nx: 0, ny: 1 }];
    const path = al.frames(s0, s1, 4);
    const pw = island ? PLAT_W_ISL : STATION_X.width;
    const prof = boardRect(pw, -1.0, 0.42);
    const pp = path.map(f => { const q = al.world(f, board * PLAT_FRONT, 0); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
    /* 站台板的花岗岩贴图必须**各向同性**：U 是沿线路的弧长、V 是截面周长占比，
       两者要落在同一个"米/循环"上，否则 600 mm 的方砖会被拉成长条
       （旧版 uvAlong=1/1.2、vSpan=1 → 一个循环摊在 18.8 m 的周长上，横竖差 16 倍，
       站台地面在截图里就是"一条条顺着股道的灰条"）。这里统一到 2.4 m 一个循环
       —— 一张图 4×4 块板，正好 600 mm 一块。 */
    this.b.sweep(pp, prof, { mat: 'granite', color: rgbOf('#b9bfc2'), closed: true,
      uvAlong: 1 / 2.4, vSpan: (pw + 1.42) * 2 / 2.4 });
    /* ---- 站台后区（站厅侧）地坪 ----
       原来站台板只铺到站台外沿（横向 2.05~5.55），再往外一直到箱涵壁（10.65）
       是**一个 1.27 m 深的坑**（坑底是 `cutCover` 的 −0.85）。而下面那段楼梯
       的第一级就架在这个坑上方（横向 8.25、dy 0.42）—— 也就是说"楼梯"从
       第一级开始就是悬空的，闸机、售票机这些设施更是连放都放不下。
       真实侧式车站的站台外侧本来就是通向楼梯与闸机的那条走廊，
       所以这里补一块与站台同标高的地坪，把坑填掉。
       岛式站：走廊在**正线外侧**（side 侧、2.05 到 14.3 那道墙），地坪同样补 ——
       闸机线与站厅板都站在它上面；岛背后的 0.6 m 检修空间不铺（WALLF 到岛缘）。 */
    if (!open) {
      const bp2 = path.map(f => { const q = al.world(f, side * BACK, 0); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(bp2, outRect_(side, WALLX - BACK, -1.0, 0.42),
        { mat: 'granite', color: rgbOf('#aab1b5'), closed: true, uvAlong: 1 / 1.2, vSpan: 1 });
      /* 后区与站台之间那一道 0.42 m 的台缘要看得见：没有它，
         两块同标高的地坪会读成"一整片没有边界的白地"。 */
      const kp2 = path.map(f => { const q = al.world(f, side * (BACK - 0.03), 0.44); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(kp2, outStrip(0.10), { mat: 'metal', color: rgbOf('#9aa4aa'), closed: true, uvAlong: 1 / 1.5, vSpan: 1 });
    } else {
      /* 露天站（B2b）：站台板（2.05~5.55）到外沿护栏（7.45）之间补一条
         与站台同标高的通道地坪 —— 闸机线、售票机就站在这条通道上，
         乘客下了车从站台走到楼梯口。以前这 1.9 m 是光秃秃的桥面，
         护栏一封，"站厅"根本无处安放。 */
      const RW0 = PLAT_FRONT + pw + 0.04, RW1 = STATION_X.rail + 1.98;
      /* sweep 的截面 x 是**相对路径点**的（路径摆在通道中线），所以区间要减去中线；
         材质用 concrete —— test-xsect 把 granite|lo 钉在站台板 2.05~5.55，
         通道是桥面上的混凝土地坪，本来也不该跟站台板混成一种材质。 */
      const wC = (RW0 + RW1) / 2;
      const wp3 = path.map(f => { const q = al.world(f, side * wC, 0); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(wp3, Geo.rectProfile(side > 0 ? RW0 - wC : -(RW1 - wC), -1.0, side > 0 ? RW1 - wC : -(RW0 - wC), 0.42),
        { mat: 'concrete', color: rgbOf('#a7aeb2'), closed: true, uvAlong: 1 / 1.2, vSpan: 1 });
      const kp3 = path.map(f => { const q = al.world(f, side * (RW0 - 0.02), 0.44); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(kp3, outStrip(0.10), { mat: 'metal', color: rgbOf('#9aa4aa'), closed: true, uvAlong: 1 / 1.5, vSpan: 1 });
    }
    /* ---- 站务员亭 ----
       站台后区走廊（横向 ~6.5）靠站台端头的小亭子：铝合金框 + 朝轨道的
       玻璃带 + 平顶 + 顶上一台空调。以前站台上只有乘客设施，
       没有"有人值守"的证据。位置避开楼梯口（PLATFORM_EXITS ± 1.7）。 */
    {
      const bz = s0 + 9, bl = 2.3, bw = 1.45, bh = 2.30, bx = side * 6.55;
      const bfr = al.frame(bz);
      const W = (dz, lat, dy) => al.world(al.frame(dz), side * lat, dy);
      const yawB = Math.atan2(bfr.f[0], bfr.f[2]);
      const boxB = (dz, lat, dy, sz, slat, sy) => {
        const q = W(dz, lat, dy);
        this.b.box([q[0], q[1], q[2]], [slat, sy, sz], rgbOf('#9aa4ab'), { mat: 'metal', yaw: yawB });
      };
      // 四角柱 + 背墙（远离轨道一面），朝轨道一面留玻璃带
      boxB(bz, bx + side * bw / 2, 0.42 + bh / 2, bl, 0.06, bh); // 背墙（横 lat 方向厚 0.06）
      boxB(bz - bl / 2 + 0.03, bx, 0.42 + bh / 2, 0.06, bw, bh); // 端墙 ×2
      boxB(bz + bl / 2 - 0.03, bx, 0.42 + bh / 2, 0.06, bw, bh);
      boxB(bz, bx - side * 0, 0.42 + 0.05, bl + 0.1, bw + 0.1, 0.10);   // 地槛
      // 朝轨道面：下墙 + 玻璃带 + 上墙
      {
        const q1 = W(bz, bx - side * bw / 2, 0.42 + 0.45);
        this.b.box([q1[0], q1[1], q1[2]], [0.06, 0.90, bl], rgbOf('#a8b0b6'), { mat: 'metal', yaw: yawB });
        const q2 = W(bz, bx - side * bw / 2, 0.42 + 1.35);
        this.b.box([q2[0], q2[1], q2[2]], [0.03, 0.80, bl - 0.2], rgbOf('#9fd0dc'), { mat: 'glassSoft', alpha: 0.35, yaw: yawB });
        const q3 = W(bz, bx - side * bw / 2, 0.42 + 2.05);
        this.b.box([q3[0], q3[1], q3[2]], [0.06, 0.50, bl], rgbOf('#a8b0b6'), { mat: 'metal', yaw: yawB });
      }
      // 平顶 + 顶上空调 + 亭内一盏灯（光照网格）
      boxB(bz, bx, 0.42 + bh + 0.05, bl + 0.14, bw + 0.14, 0.10);
      boxB(bz + 0.5, bx + side * 0.2, 0.42 + bh + 0.18, 0.7, 0.5, 0.28);
      const lp = W(bz, bx, 0.42 + bh - 0.15);
      this.lg.add(lp[0], lp[1], lp[2], [1, 0.95, 0.85], 8, 0.5);
    }
    // 盲道 + 安全黄线（每条缘口各一遍 —— 岛式两条缘口各对一条股道）
    for (const E of edges) {
      const lat = x => E.e + E.inw * x;
      const yellow = path.map(f => { const q = al.world(f, lat(0.55), 0.435); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(yellow, outStrip(0.42),
        { mat: 'paint', color: rgbOf('#e0b53c'), closed: false, uvAlong: 1, vSpan: 1, emi: 0.12 });
      const tactile = path.map(f => { const q = al.world(f, lat(1.35), 0.44); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(tactile, outStrip(0.55),
        { mat: 'paint', color: rgbOf('#c8a13a'), closed: false, uvAlong: 2, vSpan: 1, emi: 0.08 });
    }

    // ---- 屏蔽门系统（门体玻璃在 train.js 里做动画，这里只做固定框） ----
    /* 浦江线（胶轮 APM）是**半高安全门**：门柱 1.5 m、顶一道扶手梁，
       没有 2.62 m 的门楣与线路色带 —— 那是全高屏蔽门的构件，装在 3.2 m 高的
       胶轮车旁边本身就是穿帮（列车门高 1.9 m，全高门的门框比车还高）。
       判据在 test-bake.js：APM 站横向 1.9~2.3 m 带上不许出现高于 2.0 m 的 metal。 */
    const apm = !!(this.cfg.profile && this.cfg.profile.rubber);
    const doorCount = Math.round((140) / 2.2);
    for (const E of edges) for (let i = -1; i <= doorCount; i++) {
      /* 屏蔽门立柱链跟着停车标走（SH.STOP_MARK）：门叶（game.js _psd 的
         DoorZs）对齐的是停在停车标上的列车，立柱链必须同一个偏移，
         否则门叶与立柱/固定板错开 39 m —— 屏蔽门整体错位。 */
      const dz = s + SH.STOP_MARK - 4 - i * 2.2;
      if (dz < s0 + 4 || dz > s1 - 4) continue;
      const fr = al.frame(dz);
      const p = al.world(fr, E.e + E.inw * 0.06, 0.44);
      this.b.box([p[0], p[1] + (apm ? 0.75 : 1.28), p[2]], [0.10, apm ? 1.50 : 2.56, 0.14], rgbOf('#39424a'), { mat: 'metal' });
    }
    if (apm) {
      /* 半高门的扶手梁：顶在门柱头上的一根不锈钢管 */
      for (const E of edges) {
        const rail2 = path.map(f => { const q = al.world(f, E.e + E.inw * 0.06, 1.92); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(rail2, Geo.rectProfile(E.inw > 0 ? 0 : -0.07, 0, E.inw > 0 ? 0.07 : 0, 0.07),
          { mat: 'metal', color: rgbOf('#8f999f'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
      }
    } else {
    // 门头梁 + 线路色带（每条缘口各一道）
    for (const E of edges) {
      const lat = x => E.e + E.inw * x;
      const erc = (w, y0, y1) => Geo.rectProfile(E.inw > 0 ? 0 : -w, y0, E.inw > 0 ? w : 0, y1);
      const hdr = path.map(f => { const q = al.world(f, lat(0.06), 2.62); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(hdr, erc(0.22, 0, 0.34),
        { mat: 'metal', color: rgbOf('#4a545c'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
      const band = path.map(f => { const q = al.world(f, lat(0.175), 2.40); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(band, erc(0.14, 0, 0.16),
        { mat: 'paint', color: rgbOf(color), closed: true, uvAlong: 1, vSpan: 1, emi: 0.30 });
    }
    }
    /* ---- 站台端部的端门：司机进站时看到的"尽头那扇门"。
       全高门站给 2.56 m 框网门（三道横档 + 黄警示牌），APM 半高门站给 1.35 m 矮栅 ——
       test-bake 有条判据：APM 站横向 1.9~2.3 m 带上不许出现高于 2.0 m 的 metal。
       位置在门柱链之外（门柱到 s0+4 / s1−4 为止），不与固定框重叠。 */
    for (const dz of [s0 + 3.5, s1 - 3.5]) for (const E of edges) {
      const frG = al.frame(dz);
      const yawG = Math.atan2(frG.f[0], frG.f[2]);
      const pg0 = al.world(frG, E.e + E.inw * 0.06, 0.44);
      const gh = apm ? 1.35 : 2.56;
      this.b.box([pg0[0], pg0[1] + gh / 2, pg0[2]], [0.07, gh, 1.12], rgbOf('#2c343b'), { mat: 'metal', yaw: yawG });
      for (let gb = 0; gb < 3; gb++) {
        /* 横档高度跟着门高走：APM 矮栅最高一档 1.24 m —— 不许飘进
           "横向 1.9~2.3 m 高于 2.0 m 的 metal"那条 test-bake 判据的射程里。 */
        const pb = al.world(frG, E.e + E.inw * 0.06, (apm ? 0.52 : 0.99) + gb * (apm ? 0.36 : 0.62));
        this.b.box([pb[0], pb[1], pb[2]], [0.05, 0.07, 1.12], rgbOf('#4a545c'), { mat: 'metal', yaw: yawG });
      }
      const ps = al.world(frG, E.e + E.inw * 0.115, apm ? 1.39 : 1.99);
      this.b.box([ps[0], ps[1], ps[2]], [0.03, 0.30, 0.42], rgbOf('#d9a947'), { mat: 'paint', yaw: yawG });
    }

    // ---- 站名标（屏蔽门楣上，中文+英文，真字；APM 半高门没有门楣，挂雨棚下） ----
    const rect = cfg.sign.add('plate:' + name, 512, 106, (c, w, h) => SH.textures.signStationPlate(c, w, h, { name, en, code, color }));
    for (const dz of [s - 34, s + 6, s - 66]) {
      if (dz < s0 + 6 || dz > s1 - 6) continue;
      const fr = al.frame(dz);
      if (apm) {
        /* 挂雨棚下沿：面向站台，横向轴沿轨道走（不能再写世界轴 [0,0,k]，
           那是"只有沿线沿 Z 时才碰巧对"那一族）。 */
        const wp = al.world(fr, side * (PLAT_FRONT + 1.6), ceilH - 1.30);
        const nrm2 = norm3([fr.r[0] * -side, fr.r[1] * -side, fr.r[2] * -side]);
        this.b.panel([wp[0], wp[1], wp[2]], [fr.f[0] * 4.6, fr.f[1] * 4.6, fr.f[2] * 4.6], [0, 0.95, 0], nrm2, rect, [1, 1, 1], 0.55);
        const rod = al.world(fr, side * (PLAT_FRONT + 1.6), ceilH - 0.55);
        this.b.box([rod[0], rod[1], rod[2]], [0.05, 0.5, 0.05], rgbOf('#6d767d'), { mat: 'metal' });
      } else for (const E of edges) {
      const p = al.world(fr, E.e + E.inw * 0.20, 2.28);
      const nrm = norm3([fr.r[0] * -E.inw, fr.r[1] * -E.inw, fr.r[2] * -E.inw]);
      this.b.panel([p[0], p[1], p[2]], [0, 0, 4.6 * E.inw], [0, 0.95, 0], nrm, rect, [1, 1, 1], 0.55);
      }
    }

    // ---- 吊顶 + 灯槽 ----
    /* 棚板的横向范围：内缘距线路中心 2.35、宽 3.4 ⇒ 外缘 5.75，正好罩住
       2.05~5.55 的站台板（外缘挑出 0.2）。
       **截面 x 必须按 side 平移区间**（`rectProfile` 的点序要求 x0<x1，不能反过来）：
       第一版写成无符号的 `rectProfile(0, …, 3.2, …)` 而路径在 `side*(PLAT_FRONT+3.2)`，
       于是 side=−1 那一半车站碰巧压在站台上，side=+1 那一半整片雨棚偏到站台外侧 3 m
       的空气上，檐口梁、立柱、两排灯带跟着一起悬空 —— 只有俯瞰机位看得见。 */
    const ci = STATION_X.canopyIn, cw = STATION_X.canopyW, co = STATION_X.canopyOut;
    /* 岛式：一块吊顶罩住整座岛（内缘 board×(PF−0.3)、宽 W+0.6）；
       侧式：罩住单侧站台板（2.35~5.75）。 */
    const ceilLo = island ? board * (PLAT_FRONT - 0.3) : side * ci;
    const ceilW = island ? PLAT_W_ISL + 0.6 : cw;
    const ceil = path.map(f => { const q = al.world(f, ceilLo, ceilH); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
    /* 吊顶必须是**有厚度的板**，不能是一张法向朝上的单面片。
       原来截面两点都给 ny=+1，于是从站台上抬头看的是它的背面 —— 参与背面剔除就整个消失，
       画面上变成"两根黑色灯带悬浮在黄昏的天空里"，比没有顶棚更假。
       改成 0.06 m 厚的闭合矩形截面：底面朝下（站台看它）、顶面朝上（俯瞰与外部看它）。 */
    this.b.sweep(ceil, Geo.rectProfile(ceilLo > 0 ? 0 : -ceilW, -0.06, ceilLo > 0 ? ceilW : 0, 0.06),
      /* 吊顶同样要各向同性（截面周长 = 2×(ceilW+0.12)）——旧版 vSpan=1/ceilW
         等于"一个循环摊在一百多米顶板上"，顶面是一整片没有尺度感的灰。 */
      { mat: 'tiles', color: rgbOf('#cfd6da'), closed: true, uvAlong: 1 / 1.2, vSpan: (ceilW + 0.12) * 2 / 1.2 });
    if (open) {
      /* 露天站厅的雨棚：棚板外挑、带檐口梁、由站台外侧立柱支撑。
         没有檐口与柱子时，那块棚子看着就是"悬浮的天花板"。 */
      const eave = path.map(f => { const q = al.world(f, side * co, ceilH - 0.28); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      /* 檐口梁与压顶条：截面 x 是沿 fr.r 的，所以宽度必须带 `side` 的符号，
         否则负侧车站这两条构件是**往线路中心长**的（盖在正线上）。
         压顶条原来靠 `flip: side < 0` 兜绕序 —— 那是"只有一侧对"的老写法，
         现在截面法向给全，绕序交给 sweep 按法向自动判定。 */
      const ev0 = side > 0 ? 0 : -0.34, ev1 = side > 0 ? 0.34 : 0;
      this.b.sweep(eave, Geo.rectProfile(ev0, 0, ev1, 0.62),
        { mat: 'metal', color: rgbOf('#c3cbd0'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
      this.b.sweep(path.map(f => { const q = al.world(f, side * (co + 0.05), ceilH + 0.04); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; }),
        [{ x: 0, y: 0, nx: 0, ny: 1 }, { x: 0.5 * side, y: 0, nx: 0, ny: 1 }],
        { mat: 'roof', color: rgbOf('#aeb7bd'), closed: false, uvAlong: 1 / 2, vSpan: 1 });
      for (let dz = s0 + 5; dz < s1 - 4; dz += 9.5) {
        const fr = al.frame(dz);
        const p = al.world(fr, side * (co - 0.15), 0.42);
        this.b.box([p[0], p[1] + (ceilH - 0.7) / 2, p[2]], [0.46, ceilH - 0.7, 0.46], rgbOf('#b7bfc5'), { mat: 'metal', faces: [0, 1, 4, 5] });
        const tp = al.world(fr, side * (co - 0.15), ceilH - 0.36);
        this.b.box([tp[0], tp[1], tp[2]], [0.9, 0.36, 0.9], rgbOf('#aab3b9'), { mat: 'metal' });
        /* ---- 屋面这一层（诚实清单：顶棚上表面曾是一整片空白板）----
           真实高架站屋面 = 连续的采光天窗带 + 屋面设备基础。天窗带按立柱
           同一跨距（9.5 m）摆，设备按里程哈希稀疏放 —— 俯瞰/观景机位从上
           往下看，屋面不再是白板。 */
        const rf = al.frame(dz + 4.7);
        const rc = al.world(rf, side * (ci + cw / 2), ceilH + 0.10);
        const fw = [rf.f[0] * 4.4, 0, rf.f[2] * 4.4], rw = [rf.r[0] * side * (cw - 1.2), 0, rf.r[2] * side * (cw - 1.2)];
        this.b.plate([rc[0], rc[1], rc[2]], fw, rw, [0, 1, 0], rgbOf('#9fd0dc'), { mat: 'glassSoft', alpha: 0.35, uv: 1 / 2 });
        for (const e of [-1, 1]) {
          const fr2 = al.world(rf, side * (ci + cw / 2), ceilH + 0.09);
          this.b.plate([fr2[0] + fw[0] * e / 2 * 0.94, fr2[1], fr2[2] + fw[2] * e / 2 * 0.94],
            [rf.f[0] * 0.06, 0, rf.f[2] * 0.06], [rw[0] * 1.02, 0.04, rw[2] * 1.02], [0, 1, 0],
            rgbOf('#8b959b'), { mat: 'metal', uv: 1 });
        }
        if (rand01('roofac' + Math.round(dz), side) > 0.45) {
          const ac = al.world(rf, side * (ci + 0.9), ceilH + 0.20);
          this.b.box([ac[0], ac[1], ac[2]], [1.1, 0.34, 1.6], rgbOf('#7d868c'), { mat: 'metal', yaw: Math.atan2(rf.f[0], rf.f[2]) });
        }
      }
    }
    for (let dz = s0 + 6; dz < s1; dz += 3) {
      const fr = al.frame(dz);
      /* 露天站的灯带不能再按地下站的量级给。地下 uEmiBoost 2.05、天光 0.085，
         emi 1.7 是"好看"；露天黄昏天光 0.46~0.66，同一盏灯算出来 3.6 倍白，
         直接削顶成纯白 —— 从站台平视过去，两条 2.6 m 灯带每 3 m 一根连成两道
         白刀，把黄昏的天空划开，是全图最扎眼的东西。
         降到 0.62 并补一道深色灯槽：灯带要有边框才读得出是灯具，
         而不是一张贴在顶棚上的发光纸。 */
      const lampEmi = open ? 0.62 : 1.7;
      /* 灯带跟着缘口走：侧式两排（PLAT_FRONT+1.0/+2.6），岛式两条缘口各一排
         （每条缘口的 inw+1.0 处）—— 岛面宽 8 m，两排灯正好罩住两条缘口。 */
      const lampLats = island ? edges.map(E => E.e + E.inw * 1.0)
        : STATION_X.lamps.map(off => side * off);
      for (const ll of lampLats) {
        const p = al.world(fr, ll, ceilH - 0.10);
        this.b.plate([p[0], p[1] + 0.062, p[2]], [0, 0, 2.74], [0, 0.11, 0], [0, 1, 0], rgbOf('#333c44'), { mat: 'metal', uv: 1 });
        this.b.plate([p[0], p[1], p[2]], [0, 0, 2.6], [0, 0.09, 0], [0, -1, 0], rgbOf('#eaf3ff'), { mat: 'emissive', uv: 1, emi: lampEmi });
      }
      /* 站台区照度。灯光现在走**加算通道**（顶点自发光），量级是"叠加多少灯"，
         不再是"1+灯光"的乘子。
         露天站要额外乘 1.5：黄昏环境的半球天光比地下亮一个数量级
         （uSkyCol 0.46~0.66 vs 地下的 0.085），而 uEmiBoost 反而更低（1.55 vs 2.05），
         同一盏灯在露天站厅里既被天光淹掉、又被压了增益，
         画面上就是"地下站好看、地上站发灰发暗"。 */
      const lampMul = open ? 1.5 : 1;
      for (const ll of lampLats) this.lg.add(...al.world(fr, ll, ceilH - 0.3), [0.95, 0.97, 1.0], 19, 0.95 * lampMul);
      this.lg.add(...al.world(fr, 0, ceilH - 0.4), [0.92, 0.96, 1.0], 15, 0.50 * lampMul);
    }
    // 轨道区顶灯
    for (let dz = s0 + 4; dz < s1; dz += 6.5) {
      const fr = al.frame(dz), p = al.world(fr, 0, ceilH - 0.2);
      this.lg.add(p[0], p[1], p[2], [0.90, 0.95, 1.0], 14, 0.95);
    }

    /* ---- 站台倒计时屏：几何在立柱循环里建（见下面 `ptdBatches`）----
     * 这块屏是"这条线在运行"最直接的感觉，也是 B1 那条"单一口径"的唯一出口。
     * 它必须**单独成批**（不进 `this.b`），因为屏面贴图是运行时按秒重传的
     * 实时纹理 'ptd'，而世界的其它批次都是一次烘焙定死的 ——
     * 混在一起就等于要么屏不变、要么每帧重传整张图集。
     * 位置与朝向经历了三轮才做对，每一轮都是被"看不见"逼出来的：
     *   ① 吊在柱间、横向 3.6 m —— 与立柱（5.15 m）从站台机位看出去只差 1.5 m，
     *      柱子正好压住屏面；
     *   ② "吸附到柱间正中" —— 吸附算出来的位置几乎总落在 `s1−12` 之外被
     *      `continue` 跳过，**一批都没有建出来**，而代码看起来完全合理。
     *      ——"位置对不齐就跳过"是这条流水线里最容易静默失效的一种写法；
     *   ③ 吊在 `ceilH−0.96`（站台面上 3.6 m）—— 仰角太大、又被吊顶灯带压着，
     *      屏在画面上只有几个像素。
     * 现在**直接建在立柱柱身的内侧面上**：位置由立柱循环本身给出，
     * 不再有任何"算出来不对就跳过"的分支；屏面法向 −side·r（朝站台），
     * 屏心在站台面上 1.92 m（人平视略偏上，不抬头）。 */
    this.ptdBatches = this.ptdBatches || [];
    /* 站台机位（`SH.platformShot`）眼位在 `站心−26`、横向 side×3.5、dy 2.10。
       屏只有落在**机位前方**才可能进画，所以只给 `站心−20 ~ 站心+26` 这一段
       的柱子装屏（柱距 9 m ⇒ 约 6 块，最近的一块在前方 6 m、最远的 48 m）。
       ——这是第 29/68 条同族的第四次：**"某个东西看不见"要先量它与相机/遮挡物
       在画面上的投影关系，不是先调它的大小或亮度。** */
    const ptdSpan = dz => dz >= s - 20 && dz <= s + 26;

    // ---- 站台中柱 + 导向牌 + 广告 + 倒计时屏 ----
    for (let dz = s0 + 10; dz < s1 - 4; dz += 9) {
      const fr = al.frame(dz);
      const p = al.world(fr, side * (PLAT_FRONT + 3.1), 0.42);
      /* `uv: 0.45`（每米 0.45 个循环）不是调亮度：原来 `uv: 1` 让站厅面砖的
         砖缝每 6.25 cm 一道，而贴图里一道砖缝只有 512 中的 2 个像素 ——
         真实站厅面砖的砖层是 10~15 cm 一道，这里本来就细了一倍。
         它与柱子中腰那道细横带**无关**（见 README 诚实清单），别把两件事混起来。 */
      this.b.box([p[0], p[1] + (ceilH - 0.42) / 2, p[2]], [0.72, ceilH - 0.42, 0.72], rgbOf('#a4adb3'), { mat: 'tiles', uv: 0.45 });
      const bp = al.world(fr, side * (PLAT_FRONT + 3.1), 0.62);
      this.b.box([bp[0], bp[1], bp[2]], [0.9, 0.22, 0.9], rgbOf('#8f979c'), { mat: 'concrete' });
      // 柱面线路色环
      /* 高度取 `STATION_X.pillarRing`（3.30），不再就地写 2.9 ——
         2.9 会与柱身倒计时屏（屏顶 2.82）重叠 7 cm，判据见 test-shot.js。 */
      const rp = al.world(fr, side * (PLAT_FRONT + 3.1), STATION_X.pillarRing);
      this.b.box([rp[0], rp[1], rp[2]], [0.78, 0.30, 0.78], rgbOf(color), { mat: 'paint', faces: [0, 1, 4, 5], emi: 0.3 });
      /* 倒计时屏：挂在柱身**内侧**（朝站台那面），屏宽 1.90 m —— 比柱子的
         0.72 m 宽出一截多，两头各挑出 0.59 m，真实柱身屏就是这样挑出来的。
         屏高必须与 'ptd' 实时纹理的 512×192 同比（1.90 × 192/512 = 0.7125），
         否则一行字在屏面上被拉成 1.7 倍的竖条。
         屏心 dy 2.36（站台面上 1.94 m）：站台机位眼高是站台面上 1.68 m，
         于是屏落在**平视略偏上**的位置 —— 之前挂在站台面上 3.6 m 时仰角 40°，
         屏在画面上只剩几个像素，正是"下一班还有几分钟"最该被读到却读不到。 */
      if (ptdSpan(dz)) {
        const yawP = Math.atan2(fr.f[0], fr.f[2]);
        const PTD_W = STATION_X.ptdW, PTD_H = PTD_W * 192 / 512, PTD_DY = STATION_X.ptdY;
        /* 柱内侧柱面在横向 5.15−0.36 = 4.79；屏壳 0.18 m 厚，坐在柱面上往外挑 */
        const lat = side * (PLAT_FRONT + 3.1 - 0.36 - 0.09);
        const shell = new Builder();
        const c = al.world(fr, lat, PTD_DY);
        /* 屏壳用**浅色铝框**而不是深灰：站台背墙本来就是深色砖/深色涂料，
           深色屏壳贴在深色墙上等于什么都没有 —— 真实柱身屏外面是一圈亮银框，
           隔着 40 m 也读得出"这里有一块屏"。 */
        shell.box([c[0], c[1], c[2]], [0.18, PTD_H + 0.10, PTD_W + 0.10],
          rgbOf('#b6bfc5'), { mat: 'metal', yaw: yawP, uv: 1 });
        /* 屏面用 `panel`（UV 落在 0..1）而不是 `plate`：后者按"每米多少个循环"
           生成世界 UV，给一张 512×192 的实时纹理用等于把它重复上百次，
           屏幕上是一片高频噪点，而不是一行字。 */
        const nrm = norm3([fr.r[0] * -side, 0, fr.r[2] * -side]);
        const fc = al.world(fr, lat - side * 0.094, PTD_DY);
        shell.panel([fc[0], fc[1], fc[2]],
          [fr.f[0] * PTD_W, fr.f[1] * PTD_W, fr.f[2] * PTD_W], [0, PTD_H / 2, 0], nrm,
          [0, 0, 1, 1], [1, 1, 1], 1, 'ptd');
        this.ptdBatches.push({ mesh: shell.finish(), idx: opt.idx == null ? null : opt.idx,
          s: dz, lat: side * (PLAT_FRONT + 3.1 - 0.36 - 0.09), dy: PTD_DY, h: PTD_H, w: PTD_W });
        /* 屏的背光：真实站台屏是站台最亮的物件之一，会把柱身和地坪照亮。
           注意这盏灯**照不到屏面自己**——屏面在独立的 `shell` 批里、没装
           `lightFn`，它的亮度只由贴图 × uEmiBoost 决定。 */
        const lp = al.world(fr, lat - side * 0.34, PTD_DY);
        this.lg.add(lp[0], lp[1], lp[2], [0.85, 0.92, 1.0], 4.6, 0.42);
      }
      // 悬挂导向
      if ((dz - s0) % 27 < 9) {
        const wp = al.world(fr, side * (PLAT_FRONT + 2.4), ceilH - 0.9);
        const rect2 = cfg.sign.add('way:' + name, 384, 96, (c, w, h) => SH.textures.signWayfind(c, w, h, { text: '换乘 · 出站', sub: 'Way out · Interchange', color }));
        const nrm = norm3([-fr.u[0] * 0 + fr.r[0] * -side, 0, fr.r[2] * -side]);
        this.b.panel([wp[0], wp[1], wp[2]], [0, 0, 3.4 * side], [0, 0.85, 0], nrm, rect2, [1, 1, 1], 0.5);
        const rod = al.world(fr, side * (PLAT_FRONT + 2.4), ceilH - 0.35);
        this.b.box([rod[0], rod[1], rod[2]], [0.05, 0.7, 0.05], rgbOf('#6d767d'), { mat: 'metal' });
      }
    }
    /* ---- 站厅侧设施：闸机组 / 售票机 / 时钟 / 导向牌 / 长椅 / 垃圾桶 ----
     * 真实上海站台上"这地方在运行"的证据不是灯，是**闸机**：一排柜体、
       几对玻璃翼闸、一条给大箱子走的宽通道，柜顶一块绿区读卡面。
       这里只在**地下站**做（高架站的站台外沿是玻璃护栏，横向到 7.45 就到头了，
       闸机那种 1.5 m 进深放不下；而且高架站那段楼梯本身还穿出护栏，
       是另一笔账，见诚实清单）。
     * 每一件都往 `this.facilities` 登记一条记录（种类 + 里程 + 横向 + 标高），
     * 判据除了数记录条数，还要**回到烘焙出来的顶点里核对那个位置真的有东西** ——
     * 只数记录等于"代码说自己建了"，而记录与几何脱钩这件事本项目栽过
     * （站台屏那批"重置累积数组"）。 */
    this.facilities = this.facilities || [];
    {
      /* ---- 站厅侧设施（B2b）：地下站与露天站共用同一套几何 ----
         真实上海站台上"这地方在运行"的证据不是灯，是**闸机**：一排柜体、
         几对玻璃翼闸、一条给大箱子走的宽通道，柜顶一块绿区读卡面。
         以前只在地下站做 —— 高架化线路（16 号线 / 浦江线 / 磁浮）一座都没有。
         现在露天站在站台外沿与新补的通道地坪上摆同一样的东西：
         "墙"的位置从箱涵壁（WALLX≈10.65）换成外护栏线（7.45），
         "后缘"从后区地坪（BACK）换成通道内缘（站台板外 0.2 m）。
         每一件都往 `this.facilities` 登记一条记录（种类 + 里程 + 横向 + 标高），
         判据除了数记录条数，还要**回到烘焙出来的顶点里核对那个位置真的有东西**。 */
      const open_ = open;
      /* 地下站：付费区设施在**站厅层**（板上），不是和站台同层的走廊里。
         闸机线的横向起点也必须从板内缘起算 —— 用走廊地坪的 BACK(5.55) 会让
         1.5 m 深的柜体有 0.9 m 悬在板外，画面上就是"闸机飘在半空"。 */
      const FL = open_ ? 0.42 : STATION_X.mezzTop, yawOf = f => Math.atan2(f.f[0], f.f[2]);
      const FBack = open_ ? PLAT_FRONT + pw + 0.20 : STATION_X.mezzIn;
      const FWall = open_ ? STATION_X.rail + 1.98 : WALLX;
      const hangH = open_ ? 2.60 : ceilH - 1.05;          // 吊挂导向牌的底高
      const tvmRect = cfg.sign.add('tvm:' + name, 128, 160, (c, w, h) => SH.textures.signTvm(c, w, h, { color }));
      const clkRect = cfg.sign.add('clk:' + name, 128, 128, (c, w, h) => SH.textures.signClock(c, w, h, { color }));
      const exitRect = cfg.sign.add('exit:' + name, 384, 96, (c, w, h) => SH.textures.signWayfind(c, w, h, { text: '出入口 A · B', sub: 'Way out A · B', color }));
      /* 楼梯口位置与下面那段楼梯同源（`SH.PLATFORM_EXITS`），闸机线排在楼梯前 5 m：
         下了车往出口走，先过闸机再上楼梯 —— 与真实动线一致。 */
      for (let i = 0; i < 2; i++) {
        const stairDz = s + SH.PLATFORM_EXITS[i];
        /* 闸机线在楼梯前 5 m、沿线路占 4.3 m，所以要落在烘焙窗口
           （`s0 = s−150`、`s1 = s+42`）里。原来这里写 `s1 − 18`，
           于是 `s+35` 那一组（闸机线在 s+30）被判成"太靠边"整组跳过 ——
           每座站只剩一排闸机，而代码看上去像两排。 */
        if (stairDz < s0 + 18 || stairDz > s1 - 10) continue;
        const D = stairDz - 5.0;
        /* ---- 闸机组：5 个柜体，柜间 4 条通道（其中一条 0.92 m 宽通道）----
           柜体进深 1.50 m（横向，也就是乘客通过的方向）、宽 0.35 m（沿线路）、
           高 0.60 m；翼闸玻璃立在通道中央、垂直于进站方向。 */
        const CAB = 0.35, AIS = [0.55, 0.55, 0.92, 0.55], GDEP = 1.50, GH = 0.60;
        const gLat = FBack + 0.10 + GDEP / 2;
        let dz = D - (CAB * 5 + AIS.reduce((a, b) => a + b, 0)) / 2;
        for (let g = 0; g < 5; g++) {
          const f1 = al.frame(dz + CAB / 2), y1 = yawOf(f1);
          const p = al.world(f1, side * gLat, FL);
          this.b.box([p[0], p[1] + GH / 2, p[2]], [GDEP, GH, CAB], rgbOf('#c6ced2'),
            { mat: 'metal', uv: 1, yaw: y1 });
          /* 柜顶读卡区（自发光，真实是绿/橙两色指示） */
          const tp = al.world(f1, side * (gLat - GDEP / 2 + 0.30), FL + GH);
          this.b.box([tp[0], tp[1], tp[2]], [0.44, 0.03, 0.26], rgbOf('#3ce089'),
            { mat: 'emissive', emi: 1.3, yaw: y1 });
          /* 通行方向小立牌：真实闸机两端各有一块 */
          const sp = al.world(f1, side * (gLat - GDEP / 2 + 0.10), FL + GH + 0.20);
          this.b.box([sp[0], sp[1], sp[2]], [0.05, 0.40, 0.24], rgbOf('#2b333a'), { mat: 'metal', yaw: y1 });
          this.facilities.push({ kind: 'gate', s: dz + CAB / 2, lat: side * gLat, dy: FL + GH / 2, mats: ['metal', 'emissive'] });
          dz += CAB;
          if (g >= AIS.length) break;
          /* ---- 通道：两片玻璃翼闸（法向沿线路，正对乘客通过方向）+ 顶部指示带 ----
             翼闸是**沿线路方向**排的两片，法向取 `f2.f`（乘客是横向穿过去的），
             宽度按通道宽分半 —— 通道宽 0.92 m（宽通道）时两片各 0.43 m。 */
          const aw = AIS[g], f2 = al.frame(dz + aw / 2), fw = aw / 2 - 0.03;
          for (let k2 = 0; k2 < 2; k2++) {
            const off = (k2 - 0.5) * aw / 2;
            const q = al.world(f2, side * gLat, FL + 0.48);
            q[0] += f2.f[0] * off; q[1] += f2.f[1] * off; q[2] += f2.f[2] * off;
            this.b.plate(q, [f2.f[0] * fw, f2.f[1] * fw, f2.f[2] * fw], [0, 0.96, 0],
              [f2.f[0], f2.f[1], f2.f[2]], rgbOf('#8fd4e6'), { mat: 'glassSoft', alpha: 0.30, uv: 1 });
          }
          const ip = al.world(f2, side * gLat, FL + GH + 0.16);
          this.b.box([ip[0], ip[1], ip[2]], [GDEP * 0.9, 0.05, aw - 0.10],
            rgbOf(g === 2 ? '#ffc451' : '#3ce089'), { mat: 'emissive', emi: 1.0, yaw: yawOf(f2) });
          dz += aw;
        }
        /* ---- 自助售票/充值机：三台靠墙，屏面自发光 ---- */
        for (let k = 0; k < 3; k++) {
          const tdz = D + 3.4 + k * 0.84, f3 = al.frame(tdz), y3 = yawOf(f3);
          const cl = FWall - 0.30, p3 = al.world(f3, side * cl, FL);
          this.b.box([p3[0], p3[1] + 0.88, p3[2]], [0.52, 1.76, 0.78], rgbOf('#b7bfc4'),
            { mat: 'metal', uv: 1, yaw: y3 });
          const n3 = norm3([f3.r[0] * -side, 0, f3.r[2] * -side]);
          const q3 = al.world(f3, side * (cl - 0.266), FL + 1.10);
          this.b.panel([q3[0], q3[1], q3[2]],
            [f3.f[0] * 0.62, f3.f[1] * 0.62, f3.f[2] * 0.62], [0, 0.36, 0], n3, tvmRect, [1, 1, 1], 0.95);
          this.lg.add(...al.world(f3, side * (cl - 0.7), FL + 1.5), [0.80, 0.90, 1.0], 3.4, 0.30);
          this.facilities.push({ kind: 'tvm', s: tdz, lat: side * cl, dy: FL + 0.88, mats: ['metal', 'sign'] });
        }
        /* ---- 钟：站厅侧墙上，离地 2.55 m。壳比盘面小一圈（盘面 0.72、壳 0.60），
             反过来壳就盖在盘面外面，画面上是一只"白方板上的圆"。 ---- */
        for (const cdz of [D - 7.0, D + 7.0]) {
          const f4 = al.frame(cdz), cl4 = FWall - 0.10, p4 = al.world(f4, side * cl4, FL + 2.55);
          /* 露天站这里没有墙：钟挂在一根立杆上（杆从通道地坪到 2.9 m） */
          if (open_) {
            const pl4 = al.world(f4, side * cl4, FL);
            this.b.box([pl4[0], pl4[1] + 1.45, pl4[2]], [0.07, 2.90, 0.07], rgbOf('#6d767d'), { mat: 'metal', yaw: yawOf(f4) });
          }
          this.b.box([p4[0], p4[1], p4[2]], [0.09, 0.60, 0.60], rgbOf('#8f989e'), { mat: 'metal', yaw: yawOf(f4) });
          const n4 = norm3([f4.r[0] * -side, 0, f4.r[2] * -side]);
          const q4 = al.world(f4, side * (cl4 - 0.052), FL + 2.55);
          this.b.panel([q4[0], q4[1], q4[2]],
            [f4.f[0] * 0.72, f4.f[1] * 0.72, f4.f[2] * 0.72], [0, 0.36, 0], n4, clkRect, [1, 1, 1], 0.9);
          this.facilities.push({ kind: 'clock', s: cdz, lat: side * cl4, dy: FL + 2.55, mats: ['metal', 'sign'] });
        }
        /* ---- 闸机线上方吊出入口导向牌 ---- */
        {
          /* 露天站没有吊顶：两根立杆从地坪把牌子撑起来 */
          const f5 = al.frame(D), l5 = FBack + 0.80, p5 = al.world(f5, side * l5, hangH);
          const n5 = norm3([f5.r[0] * -side, 0, f5.r[2] * -side]);
          this.b.panel([p5[0], p5[1], p5[2]],
            [f5.f[0] * 3.2, f5.f[1] * 3.2, f5.f[2] * 3.2], [0, 0.66, 0], n5, exitRect, [1, 1, 1], 0.55);
          for (const sg of [-1, 1]) {
            const f5s = al.frame(D + sg * 1.3);
            if (open_) {
              const base5 = al.world(f5s, side * l5, FL);
              this.b.box([base5[0], base5[1] + (hangH + 0.33) / 2, base5[2]], [0.05, hangH + 0.33, 0.05], rgbOf('#6d767d'), { mat: 'metal' });
            } else {
              const rp5 = al.world(f5s, side * l5, hangH + 0.33);
              this.b.box([rp5[0], rp5[1], rp5[2]], [0.05, 0.66, 0.05], rgbOf('#6d767d'), { mat: 'metal' });
            }
          }
          this.facilities.push({ kind: 'exitSign', s: D, lat: side * l5, dy: hangH, mats: ['sign', 'metal'] });
        }
        /* ---- 长椅 + 垃圾桶：靠墙一排，站台上的"等车"该有的东西 ---- */
        for (let k = 0; k < 3; k++) {
          const bdz = D + 8.5 + k * 2.4, f6 = al.frame(bdz), y6 = yawOf(f6), bl = FWall - 0.72;
          const pb = al.world(f6, side * bl, FL);
          this.b.box([pb[0], pb[1] + 0.44, pb[2]], [0.52, 0.07, 1.70], rgbOf('#8d6a4a'), { mat: 'paint', uv: 1, yaw: y6 });
          this.b.box([pb[0], pb[1] + 0.70, pb[2]], [0.07, 0.46, 1.70], rgbOf('#8d6a4a'), { mat: 'paint', uv: 1, yaw: y6 });
          for (const sg of [-1, 1]) {
            const lg6 = al.world(f6, side * bl, FL);
            this.b.box([lg6[0] + f6.f[0] * sg * 0.68, lg6[1] + 0.20, lg6[2] + f6.f[2] * sg * 0.68],
              [0.44, 0.41, 0.06], rgbOf('#7d868c'), { mat: 'metal', yaw: y6 });
          }
          this.facilities.push({ kind: 'bench', s: bdz, lat: side * bl, dy: FL + 0.44, mats: ['paint', 'metal'] });
        }
        for (const bdz of [D + 4.6, D + 15.6]) {
          const f7 = al.frame(bdz), bl7 = FWall - 0.55, p7 = al.world(f7, side * bl7, FL);
          this.b.cylY([p7[0], p7[1] + 0.42, p7[2]], 0.24, 0.84, rgbOf('#4d565c'), { mat: 'metal', seg: 10, uv: 1 });
          this.b.cylY([p7[0], p7[1] + 0.87, p7[2]], 0.26, 0.06, rgbOf('#2f373c'), { mat: 'metal', seg: 10, uv: 1 });
          this.facilities.push({ kind: 'bin', s: bdz, lat: side * bl7, dy: FL + 0.42, mats: ['metal'] });
        }
      }
    }
    /* ---- 换乘通道 3D 几何（第 116 / 122 条）----
       长度不再写死：`SH.transferPlan(name, meta)` 按 walkSec × 走行速度算出
       通道本体的米数，再按换乘线条数分腿（1 主干 + 每线一支），转角按线路名
       哈希定长。以前这里固定 6.8 m，而同一份数据说这站要走 70~210 秒 ——
       文案在涨、几何一动不动，是第 69 条"文案↔几何↔实测对账"那一族的又一例。
       地下站的通道口开在**站厅层**（闸机就在板上），不是站台层：
       真实车站没有"从站台直接拐进换乘通道"这种事。 */
    const lineId = opt.lineId || (cfg.line && cfg.line.id) || cfg.id;
    const interList = (SH.INTER[name] || []).filter(x => x.id !== lineId && x.color !== color);
    const interMeta = SH.INTER_META && SH.INTER_META[name];
    const plan = SH.transferPlan(name, interMeta);
    if (interMeta && interMeta.type === 'in' && interList.length > 0 && plan.legs.length) {
      const corW = 4.8, corH = 3.20, FL = open ? 0.42 : STATION_X.mezzTop;
      const sPortal = s - 45;
      const frP = al.frame(sPortal);
      /* 局部水平基：x = 出站方向（横向，带 side 符号后使用）、y = 沿线路 */
      const P2 = (x, y, up) => {
        const q = al.world(frP, side * x, up);
        return [q[0] + frP.f[0] * y, q[1] + frP.f[1] * y, q[2] + frP.f[2] * y];
      };
      const L0 = open ? STATION_X.rail + 1.98 : WALLX;
      let px = L0, py = 0, ang = 0;
      const legs = [];
      for (let i = 0; i < plan.legs.length; i++) {
        const lg = plan.legs[i];
        ang += lg.turn * Math.PI / 180;
        const bx = px + lg.len * Math.cos(ang), by = py + lg.len * Math.sin(ang);
        legs.push({ x0: px, y0: py, x1: bx, y1: by, len: lg.len, ang, kind: lg.kind,
          /* 主干是共用的那一段（牌上列全部线路），从第一支开始一支一线 */
          line: i === 0 ? null : interList[i - 1] });
        px = bx; py = by;
      }
      /* 烘焙光是**在写顶点那一刻**查 LightGrid 的（站厅层那次"板底全黑"就是这么
         治的），所以整条通道的灯必须**先全部登记、再开始铺几何**：灯留在各自腿的
         几何之后加，腿的顶点就查不到自己这条腿的灯。同一机位实测：
         平均亮度 126.1/暗部 4.3%（灯在几何之后）→ 136.4/3.8%（灯先登记）。 */
      for (const lg of legs) {
        for (let t = 3; t < lg.len; t += 6) {
          const k = t / lg.len, lp = P2(lg.x0 + (lg.x1 - lg.x0) * k, lg.y0 + (lg.y1 - lg.y0) * k, FL + corH - 0.3);
          this.lg.add(lp[0], lp[1], lp[2], [0.90, 0.94, 1.0], 11, 0.7);
        }
      }
      for (const lg of legs) {
        const mx = (lg.x0 + lg.x1) / 2, my = (lg.y0 + lg.y1) / 2;
        /* 每段用"方向向量的真实方位角"求 yaw：把 (cos·r + sin·f) 这条水平方向
           转成 box 的 yaw（yaw 让盒子的局部 Z 对齐该方向）。 */
        const dx = Math.cos(lg.ang) * frP.r[0] * side + Math.sin(lg.ang) * frP.f[0];
        const dz2 = Math.cos(lg.ang) * frP.r[2] * side + Math.sin(lg.ang) * frP.f[2];
        const yw = Math.atan2(dx, dz2);
        const nx = -Math.sin(lg.ang), ny = Math.cos(lg.ang);   // 该段的水平法向
        const slab = (x, y, up, w, h, l, mat, col, emi) => {
          const p = P2(x, y, up);
          this.b.box([p[0], p[1], p[2]], [w, h, l], rgbOf(col), { mat, uv: 1, yaw: yw, emi });
        };
        /* 通道本体一整条一盒，**不按 6 m 分段** —— 试过，量出来是退步：
           分段把顶/地面的角点挪到"就在自己那盏灯下面"的位置，而烘焙光是
           逐顶点按法向点积算的：顶棚底面对正下方的灯掠射（dot≈0.08），
           整条腿的顶点从此吃不到远处大半径灯的贡献 —— 同一机位实测
           平均亮度 136.4/暗部 3.8%（整盒）→ 65.6/55.1%（6 m 分段）。
           一整条一盒的代价是墙面只有 4 个角、光照在角之间线性插值，
           于是通道后半段偏暗、墙上有一道横贯的贴图缝：记在缺陷清单里，
           解法在光照采集那一侧（掠射项/面光源），不在分段这一侧。 */
        slab(mx, my, FL - 0.10, corW, 0.20, lg.len, 'granite', '#aeb5b9');            // 地坪
        slab(mx, my, FL + corH + 0.10, corW, 0.20, lg.len, 'paint', '#d2d8dc');       // 顶棚
        for (const sg of [-1, 1]) slab(mx + sg * nx * corW / 2, my + sg * ny * corW / 2,
          FL + corH / 2, 0.25, corH, lg.len, 'tiles', '#e4eaee');                     // 两侧壁
        /* 尽端封墙只在最后一段；中间段的端头留给下一段接上 */
        if (lg === legs[legs.length - 1]) slab(lg.x1, lg.y1, FL + corH / 2, corW, corH, 0.25, 'tiles', '#dfe5e9');
        /* 灯带每 6 m 一道（相位钉绝对弧长，重烘不挪窝）；光源已在几何之前统一登记 */
        for (let t = 3; t < lg.len; t += 6) {
          const k = t / lg.len, lx = lg.x0 + (lg.x1 - lg.x0) * k, ly = lg.y0 + (lg.y1 - lg.y0) * k;
          slab(lx, ly, FL + corH - 0.04, corW - 1.6, 0.06, 2.4, 'emissive', '#f2f8fc', 1.8);
        }
        /* 门头框 + 悬挂导向牌：每段入口一道门套，牌面写**这一支去的那条线**
           （以前是一块牌写全部线路，于是走错方向也看不出来） */
        const post = (o) => {
          const p = P2(lg.x0 + o * nx * (corW / 2 + 0.13), lg.y0 + o * ny * (corW / 2 + 0.13), FL + corH / 2);
          this.b.box([p[0], p[1], p[2]], [0.26, corH + 0.26, 0.24], rgbOf('#2b333a'), { mat: 'metal', yaw: yw });
        };
        post(-1); post(1);
        const li = lg.line;
        const txt = li ? ('换乘 ' + li.name) : '换乘 ' + interList.map(x => x.name).join(' · ');
        const sub = li ? ('Transfer to Line ' + li.name.replace('号线', '')) : '';
        const rect = cfg.sign.add('interline:' + name + ':' + (li ? li.id : 'all'), 320, 80,
          (c, w, h) => SH.textures.signWayfind(c, w, h, { text: txt, sub, color: (li && li.color) || color }));
        const sp = P2(lg.x0, lg.y0, FL + corH - 0.55);
        /* 牌面的宽度轴必须**垂直于**它自己的法向。第一版把 ax 写成了梯段方向、
           法向又写成 −梯段方向，两者共线 ⇒ cross(ax,ay) 与给定法向无关，
           绕序没人裁决 —— test-wind 的棘轮当场抓到 102 个反向 sign 三角形。
           （与第 45 条同一族：构件的两个轴要互相垂直，且都来自同一个基。） */
        const wx = -Math.sin(lg.ang) * frP.r[0] * side + Math.cos(lg.ang) * frP.f[0];
        const wz = -Math.sin(lg.ang) * frP.r[2] * side + Math.cos(lg.ang) * frP.f[2];
        const nrm = norm3([-dx, 0, -dz2]);
        this.b.panel([sp[0], sp[1], sp[2]], [wx * 3.6, 0, wz * 3.6], [0, 0.72, 0], nrm, rect, [1, 1, 1], 0.85);
        /* 登记的不是"通道中点"一个点，而是**这条腿的轴两端**。
           判据以前按"离记录点多远之内有几个顶点"来核，那是给闸机、垃圾桶
           这种 1 m 级小件用的：通道是一个十几米长的扫掠盒，顶点只在八个角上，
           中点悬在走廊中央，四周一个顶点都没有 —— 于是"几何明明在那儿"
           被判成"只有登记没有几何"。改成量**到轴线的距离**，判据问的问题
           也从"这里有没有东西"变成"东西是不是贴着这条声称的走廊铺开"，
           比原来更强；横向容差取通道自己的半宽，不写死。 */
        const a0 = P2(lg.x0, lg.y0, FL + corH / 2), a1 = P2(lg.x1, lg.y1, FL + corH / 2);
        this.facilities.push({
          kind: 'transferPassage', s: sPortal + my, lat: side * mx, dy: FL + 1.4,
          w0: [a0[0], a0[1], a0[2]], w1: [a1[0], a1[1], a1[2]], halfW: corW / 2, h: corH,
          len: lg.len, mats: ['granite', 'tiles', 'metal', 'sign', 'emissive'],
          lines: li ? [li.id] : interList.map(x => x.id), station: name,
        });
      }
      /* 尽端导向牌 */
      {
        const last = legs[legs.length - 1];
        const rect = cfg.sign.add('interend:' + name, 320, 80, (c, w, h) =>
          SH.textures.signWayfind(c, w, h, { text: '换乘 ' + interList.map(x => x.name).join(' · '),
            sub: 'Transfer', color: interList[0].color || color }));
        const ep = P2(last.x1, last.y1, FL + 1.85);
        const ewx = -Math.sin(last.ang) * frP.r[0] * side + Math.cos(last.ang) * frP.f[0];
        const ewz = -Math.sin(last.ang) * frP.r[2] * side + Math.cos(last.ang) * frP.f[2];
        this.b.panel([ep[0], ep[1], ep[2]], [ewx * 3.4, 0, ewz * 3.4], [0, 0.85, 0],
          norm3([-Math.cos(last.ang) * frP.r[0] * side - Math.sin(last.ang) * frP.f[0], 0,
            -Math.cos(last.ang) * frP.r[2] * side - Math.sin(last.ang) * frP.f[2]]), rect, [1, 1, 1], 0.75);
      }
    }
    /* ---- 共线同站台（type 'shared'）：不建通道，建"同一站台对面"的双面吊牌 ----
       3/4 号线共线段那几站的"换乘"就是走到站台对面，凭空修一条通道是假的；
       但站台上必须有一块说清"这是同一站台"的牌子，否则屏与画面互相打脸。 */
    if (interMeta && interMeta.type === 'shared' && interList.length > 0) {
      const txt = interList.map(x => x.name).join(' · ') + ' 同一站台';
      const rect = cfg.sign.add('shared:' + name, 384, 96, (c, w, h) =>
        SH.textures.signWayfind(c, w, h, { text: txt, sub: 'Same platform', color }));
      for (const off of [-24, 24]) {
        const fr2 = al.frame(s + off);
        const p = al.world(fr2, side * (PLAT_FRONT + STATION_X.width / 2), ceilH - 0.55);
        for (const sg of [-1, 1]) {
          const nrm = norm3([fr2.f[0] * sg, 0, fr2.f[2] * sg]);
          this.b.panel([p[0], p[1], p[2]], [fr2.f[0] * 3.2 * sg, 0, fr2.f[2] * 3.2 * sg], [0, 0.80, 0],
            nrm, rect, [1, 1, 1], 0.8);
        }
        const h1 = al.world(fr2, side * (PLAT_FRONT + STATION_X.width / 2), ceilH - 0.12);
        this.b.box([h1[0], h1[1], h1[2]], [0.10, 0.9, 0.10], rgbOf('#3a4249'), { mat: 'metal' });
      }
      this.facilities.push({ kind: 'transferShared', s, lat: side * (PLAT_FRONT + STATION_X.width / 2),
        dy: ceilH - 0.55, mats: ['sign', 'metal'], lines: interList.map(x => x.id), station: name });
    }
    // ---- 侧墙广告灯箱（露天站没有侧墙，改成站台上独立的落地灯箱） ----
    const adCount = 4;
    if (open) {
      for (let i = 0; i < 3; i++) {
        const dz = s0 + 20 + i * ((s1 - s0 - 40) / 2);
        const fr = al.frame(dz);
        const p = al.world(fr, side * (PLAT_FRONT + 3.9), 0.42);
        this.b.box([p[0], p[1] + 1.35, p[2]], [0.30, 2.70, 4.30], rgbOf('#c9d1d6'), { mat: 'metal', faces: [0, 1, 4, 5] });
        const r = cfg.sign.add('ad:' + ((hash32(name, i) % 97)), 256, 96, (c, w, h) => SH.textures.signAd(c, w, h, hash32(name, i)));
        for (const sg of [-1, 1]) {
          const q = al.world(fr, side * (PLAT_FRONT + 3.9 + sg * 0.17), 1.42);
          const nrm = norm3([fr.r[0] * -sg, 0, fr.r[2] * -sg]);
          this.b.panel([q[0], q[1], q[2]], [0, 0, 4.1 * sg], [0, 1.55, 0], nrm, r, [1, 1, 1], 0.8);
        }
        this.lg.add(p[0], p[1] + 2.0, p[2], [0.85, 0.9, 1.0], 7, 0.30);
      }
    } else
    for (let i = 0; i < adCount; i++) {
      const dz = s0 + 12 + i * ((s1 - s0 - 24) / adCount) + 6;
      const fr = al.frame(dz);
      const p = al.world(fr, WALLN - side * 0.35, 1.9);
      const key = 'ad:' + ((hash32(name, i) % 97));
      const r = cfg.sign.add(key, 256, 96, (c, w, h) => SH.textures.signAd(c, w, h, hash32(name, i)));
      const nrm = norm3([fr.r[0] * -side, 0, fr.r[2] * -side]);
      this.b.panel([p[0], p[1], p[2]], [0, 0, 6.2 * side], [0, 2.3, 0], nrm, r, [1, 1, 1], 0.85);
      this.lg.add(...al.world(fr, WALLN - side * 1.2, 2.4), [0.85, 0.9, 1.0], 8, 0.35);
    }
    /* ---- 站台外侧的站厅墙（地下站）----
     原来只有**对面**（无站台一侧）贴了浅色面砖，站台外侧直接是箱涵的
     `concrete` 深色内壁 —— 于是站台机位画面里占面积最大的一块是深灰，
     实拍平均亮度只有 70/255、暗部占 47.7%。真实上海地下站的站台外侧
     就是一整面**浅色面砖 + 一条深色踢脚 + 连续广告灯箱**，比对面那侧
     还亮（它的灯箱正对站台，灯箱自己的光把这面墙打亮了）。
     这里补上这面墙，并把广告灯箱前移一点，让它真的贴在墙上。 */
    if (!open) {
      const back = path.map(f => { const q = al.world(f, WALLN - side * 0.22, 2.2); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      /* UV 必须**各向同性**：墙的 U 是沿线路弧长、V 是竖向，两者要落在同一个
         "米/循环"上。旧版 vSpan=1/4.4（截面 4.4 m）等于"一个循环摊在 19 m 墙上"，
         300×600 的面砖被拉成 19 m 一条的长条。现在 1.2 m 一个循环 = 0.6×0.3 m 面砖。 */
      this.b.sweep(back, [{ x: 0, y: -2.2, nx: -side, ny: 0 }, { x: 0, y: 2.2, nx: -side, ny: 0 }],
        { mat: 'tiles', color: rgbOf('#e6ebee'), closed: false, uvAlong: 1 / 1.2, vSpan: 4.4 / 1.2 });
      /* 踢脚：一条 0.35 m 高的深色带。没有它，浅色墙一直落到地面，
         而真实站厅那一条深色分带是"墙裙"，同时也是玩家判断自己站在
         站厅还是区间里的那条线。 */
      const skirt = path.map(f => { const q = al.world(f, WALLN - side * 0.26, 0.60); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(skirt, [{ x: 0, y: -0.19, nx: -side, ny: 0 }, { x: 0, y: 0.19, nx: -side, ny: 0 }],
        { mat: 'tiles', color: rgbOf('#7f8a91'), closed: false, uvAlong: 1 / 1.2, vSpan: 0.38 / 1.2 });
    }
    // ---- 对面侧墙（无站台一侧）贴瓷片 + 大字壁 ----
    /* 大字壁两种站都要用，所以先建纹理再分支。
       露天站原来**根本没有这堵墙**，于是站名也没有可贴的面 —— 高架站看过去
       就是"一块飘在空中的甲板"。 */
    const bigRect = cfg.sign.add('big:' + name, 640, 184, (c, w, h) => {
      c.fillStyle = '#eef4f6'; c.fillRect(0, 0, w, h);
      c.fillStyle = color; c.fillRect(0, h - Math.round(h * 0.054), w, Math.round(h * 0.054));
      c.fillStyle = '#12222c'; c.textBaseline = 'middle';
      c.font = '900 ' + Math.round(h * 0.52) + 'px ' + SH.textures.CN_FONT;
      c.fillText(name, 24, h * 0.44);
      c.font = '700 ' + Math.round(h * 0.17) + 'px ' + SH.textures.CN_FONT;
      c.fillStyle = '#5a6d78'; c.fillText((en || '').toUpperCase(), 26, h * 0.79);
    });
    if (open) {
      const og = -side;
      /* 站台外沿的玻璃栏板原来埋在地坪底下：路径点取 `dy = -1.0`、截面高 1.05，
         于是它铺在轨面 −1.0 ~ +0.05，而**站台面在轨面 +0.44** —— 整道栏板在地板以下，
         画面上就是"只有 H 型钢架、没有墙"。改成坐在地坪上、高 1.3 m，
         并补扶手与下槛：玻璃没有上下两道实体就读不出是一道围护。
         站台侧（sg === side）要给楼梯口留缺口 —— 乘客从这条线走到楼梯。 */
      const STAIR_HALF2 = 1.7;
      for (const sg of [-1, 1]) {
        const segs = [];
        if (sg === side) {
          let ra = s0;
          for (let i = 0; i < 2; i++) {
            const gz = s + SH.PLATFORM_EXITS[i];
            if (gz - STAIR_HALF2 > ra && gz < s1) segs.push([ra, gz - STAIR_HALF2]);
            ra = Math.max(ra, gz + STAIR_HALF2);
          }
          if (ra < s1) segs.push([ra, s1]);
        } else segs.push([s0, s1]);
        for (const [a, z] of segs) {
          const fp = al.frames(a, z, 4).map(f => { const q = al.world(f, sg * 7.45, 0.44); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
          if (fp.length < 2) continue;
          this.b.sweep(fp, [{ x: 0, y: 0, nx: sg, ny: 0 }, { x: 0, y: 1.30, nx: sg, ny: 0 }],
            { mat: 'glassSoft', color: rgbOf('#9fd0dc'), closed: false, uvAlong: 1 / 2.5, vSpan: 1 });
          const hp = al.frames(a, z, 4).map(f => { const q = al.world(f, sg * 7.45, 1.76); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
          this.b.sweep(hp, Geo.rectProfile(-0.045, -0.045, 0.09, 0.09),
            { mat: 'metal', color: rgbOf('#b9c2c8'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
          const kp = al.frames(a, z, 4).map(f => { const q = al.world(f, sg * 7.45, 0.52); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
          this.b.sweep(kp, Geo.rectProfile(-0.05, -0.08, 0.10, 0.16),
            { mat: 'metal', color: rgbOf('#8b949a'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
        }
      }
      /* 非站台侧：女儿墙 + 百叶 + 大字壁。墙顶留 2.9 m，再往上开敞 ——
         高架站要的是"围而不闭"，全封起来就成了地下站搬到天上。 */
      const WH = 2.9;
      const wp = path.map(f => { const q = al.world(f, og * (boxW - 0.3), -1.0 + WH / 2); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(wp, Geo.rectProfile(-0.12, -WH / 2, 0.24, WH),
        { mat: 'tiles', color: rgbOf('#dfe6ea'), closed: true, uvAlong: 1 / 1.5, vSpan: 1 / WH });
      for (let k = 0; k < 5; k++) {
        const lp = path.map(f => { const q = al.world(f, og * (boxW - 0.3), -1.0 + WH + 0.18 + k * 0.26); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(lp, Geo.rectProfile(-0.05, -0.085, 0.10, 0.17),
          { mat: 'metal', color: rgbOf('#aab4ba'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
      }
      for (const dz of [s - 20, s - 58]) {
        const fr = al.frame(dz);
        const p = al.world(fr, og * (boxW - 0.44), 0.9);
        const nrm = norm3([fr.r[0] * -og, 0, fr.r[2] * -og]);
        this.b.panel([p[0], p[1], p[2]], [0, 0, 7.0 * og], [0, 2.0, 0], nrm, bigRect, [1, 1, 1], 0.42);
      }
    } else {
    const opp = path.map(f => { const q = al.world(f, WALLF + 0, 2.2); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
    this.b.sweep(opp, [{ x: 0, y: -2.2, nx: -side, ny: 0 }, { x: 0, y: 2.2, nx: -side, ny: 0 }],
      { mat: 'tiles', color: rgbOf('#e3e9ec'), closed: false, uvAlong: 1 / 1.5, vSpan: 1 / 4.4 });
    for (const dz of [s - 20, s - 58]) {
      const fr = al.frame(dz);
      const p = al.world(fr, WALLF - 0.12, 2.1);
      const nrm = norm3([fr.r[0] * side, 0, fr.r[2] * side]);
      this.b.panel([p[0], p[1], p[2]], [0, 0, 7.0 * -side], [0, 2.0, 0], nrm, bigRect, [1, 1, 1], 0.42);
    }
    }   // end else（地下站的对面侧墙）
    /* ---- 对向站台（第二座侧式站台）----
       上面那堵墙是"这座站只有一座站台"的产物。上海地铁绝大多数站是双侧式
       或一岛一侧，轨道对面那一侧本来就有一条能上车的站台。 */
    opt.peer = SH.peerAtShared(opt.lineId, name);
    /* B 阶段第 2 层：岛式站对向没有站台 —— 岛本体就是两股道之间那一座，
       farPlatform 再铺一条就是凭空造出第三座站体；对向候乘在第 3 层分到岛的两缘。 */
    if (!island) this.farPlatform(s, side, opt, rect);

    // ---- 楼梯 / 出入口 ----
    /* 原来这里只有 12 级、总升高 2.04 m，而且 `0.42 + k*0.17` 是**往上走**的：
       高架站的"楼梯"其实是一段从站台往外伸出的悬空短跑，既到不了街面，
       也没有雨棚与站厅 —— 从街面看就是"一道楼梯悬在半空"。
       另外这些台阶盒子以前**没传 yaw**，尺寸写的是世界 X/Z，于是台阶与线路
       不平行（同族第四次：见第 30 条屏蔽门）。
       露天站现在按真实高架站的做法：3 跑 + 2 平台一路降到街面（轨面下 10.9），
       两侧不锈钢扶手，落地端一个售票厅 + 出挑雨棚。
       地下站保留原来那段短跑（它读的是"上去到站厅"，本来就不该到街面）。 */
    /* ================= 地下侧式站的**站厅层**（第二层）=================
       走廊（横向 5.55→10.65、地坪 0.42、箱顶 5.55）以前是一层通高的空廊：
       闸机、售票机、长椅全摆在站台层，而"楼梯"穿墙停在半空。
       现在把走廊上方做成一块真的站厅板（标高见 SH.STATION_X.mezzTop 那段注释）：
       板下 2.18 m 是出闸前的免费通道，板上 2.45 m 是站厅，闸机线整体搬上去。
       板在两个楼梯口处**留洞** —— 扶梯与楼梯要从板下穿上来，
       不留洞就是"梯体把自己顶穿"，留了洞才有真实的落口。 */
    if (!open && WALLX - STATION_X.mezzIn > 2.0) {
      const MT = STATION_X.mezzTop, MTT = STATION_X.mezzT, MI = STATION_X.mezzIn, VH = STATION_X.voidHalf;
      /* ---- 先布灯，再写几何 ----
         烘焙灯光是**顶点写出去那一刻**查光照网格的（`Builder.light` 钩子），
         所以"先扫板、后 add 灯"会让这块板自己的灯照不到自己：
         实测站厅板底面整片纯黑 —— 比没有这层板更糟。
         （与第 106 条同源："任何某处几何没被照亮，先问它进没进光照网格"，
         这一例是进了网格、但进晚了。） */
      /* 两排、每 4 m：站厅板横跨 4.4 m，只在外侧布一排的话，从站台看过去
         整块板底是黑的（实测同一块画面 43.9，补内侧一排后到 60+）。
         灯具本体与光源同点位 —— 只给光源不给面板，画面上就是"天花板自己亮了"。 */
      const LROWS = [MI + 0.62, MI + (WALLX - MI) * 0.62];
      for (let ls = Math.ceil(s0 / 4) * 4; ls < s1; ls += 4) {
        const f3 = al.frame(ls);
        for (const lat of LROWS) {
          const lp = al.world(f3, side * lat, MT - MTT - 0.22);
          this.lg.add(lp[0], lp[1], lp[2], [0.90, 0.95, 1.0], 16, 0.95);
          const hp = al.world(f3, side * lat, 5.30);
          this.lg.add(hp[0], hp[1], hp[2], [0.90, 0.95, 1.0], 16, 0.9);
        }
      }
      const segs = [];
      let ca = s0;
      for (let i = 0; i < 2; i++) {
        const gz = s + SH.PLATFORM_EXITS[i];
        if (gz - VH > ca) segs.push([ca, gz - VH]);
        ca = Math.max(ca, gz + VH);
      }
      if (ca < s1) segs.push([ca, s1]);
      for (const [a, z] of segs) {
        if (z - a < 1.5) continue;
        const dp = al.frames(a, z, 6).map(f => { const q = al.world(f, side * MI, 0); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(dp, outRect(WALLX - MI, MT - MTT, MT),
          { mat: 'concrete', color: rgbOf('#aeb5b9'), closed: true, uvAlong: 1 / 2, vSpan: 1 / (WALLX - MI) });
      }
      /* 栏板沿**整段**内缘通铺（洞口两侧正好也需要它），不是只在有板的段落 */
      /* 栏板必须是**有厚度的闭合截面**（0.06 厚、1.05 高，两面各给法向）：
         两点同 y 的"截面"扫出来是零高度的带子，等于没装。 */
      const bal = path.map(f => { const q = al.world(f, side * MI, MT); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(bal, [{ x: 0, y: 0, nx: 0, ny: 1 }, { x: side * 0.06, y: 0, nx: 0, ny: 1 },
        { x: side * 0.06, y: 1.05, nx: 0, ny: -1 }, { x: 0, y: 1.05, nx: 0, ny: -1 }],
        { mat: 'glassSoft', color: rgbOf('#9fd0dc'), closed: true, alpha: 0.45, uvAlong: 1 / 2, vSpan: 1 });
      const hand = path.map(f => { const q = al.world(f, side * MI, MT + 1.08); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(hand, outRect(0.055, -0.05, 0.055),
        { mat: 'metal', color: rgbOf('#8d959a'), closed: true, uvAlong: 1 / 1.5, vSpan: 1 / 0.11 });
      /* 线路色檐口：板边那 0.45 m 涂本线色。没有它，一块灰板压在走廊上方
         读起来像"吊顶掉了一半"，有了色带才读成"这一层是站厅"。 */
      /* 线路色檐口：贴在板边外侧的一道**竖向** 0.45 m 色带。
         第一版写成 `outStrip(0.06)` —— 而 outStrip 的两点同 y，是零高度的
         水平带，等于根本没立起来，板边读不出"这是一层的边"。
         竖向薄构件必须给 4 点闭合截面、两面各自法向（第 41 条同源）。 */
      const fas = path.map(f => { const q = al.world(f, side * (MI - 0.03), MT - MTT); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
      this.b.sweep(fas, [{ x: 0, y: 0, nx: -side, ny: 0 }, { x: side * 0.06, y: 0, nx: side, ny: 0 },
        { x: side * 0.06, y: 0.45, nx: side, ny: 0 }, { x: 0, y: 0.45, nx: -side, ny: 0 }],
        { mat: 'paint', color: rgbOf(color), closed: true, uvAlong: 1 / 3, vSpan: 1 });
      /* 支撑柱：相位钉在**绝对里程**上（第 67 条那条规矩），否则每重烘一次
         整排柱子就跟着窗口挪几米。 */
      for (let cs = Math.ceil(s0 / 6.4) * 6.4; cs < s1; cs += 6.4) {
        const f2 = al.frame(cs), p2 = al.world(f2, side * (MI + 0.42), (MT - MTT + 0.42) / 2);
        this.b.box([p2[0], p2[1], p2[2]], [0.44, MT - MTT - 0.42 + 0.02, 0.44], rgbOf('#b7bec2'),
          { mat: 'tiles', yaw: Math.atan2(f2.f[0], f2.f[2]) });
        const rg = al.world(f2, side * (MI + 0.42), STATION_X.pillarRing + 1.6);
        this.b.box([rg[0], rg[1], rg[2]], [0.50, 0.16, 0.50], rgbOf(color), { mat: 'paint', yaw: Math.atan2(f2.f[0], f2.f[2]) });
      }
      /* 灯具本体（发光面板）：光源在上面已经进过光照网格，这里只画"灯长什么样"。
         没有面板的发光在画面上就是"那片天花板自己亮了"，读不出是灯具。 */
      for (let ls = Math.ceil(s0 / 4) * 4; ls < s1; ls += 4) {
        const f3 = al.frame(ls);
        for (const lat of LROWS) {
          const lo = al.world(f3, side * lat, MT - MTT - 0.03);
          this.b.plate([lo[0], lo[1], lo[2]], [f3.f[0] * 2.2, f3.f[1] * 2.2, f3.f[2] * 2.2], [0, 0.12, 0], [0, -1, 0],
            rgbOf('#eaf2f8'), { mat: 'emissive', uv: 1, emi: 1.35 });
          const hi = al.world(f3, side * lat, 5.30);
          this.b.plate([hi[0], hi[1], hi[2]], [f3.f[0] * 2.2, f3.f[1] * 2.2, f3.f[2] * 2.2], [0, 0.12, 0], [0, -1, 0],
            rgbOf('#eef4f9'), { mat: 'emissive', uv: 1, emi: 1.5 });
        }
      }
    }
    /* ================= 岛式站的**付费区上岛**（B 阶段第 3 层，§7.1）=================
       付费区在**岛上方**：一块站厅板罩住整座岛（两缘各挑出 0.35 m），闸机线上板，
       楼梯/扶梯从**两条缘口各自**上到板 —— 每个出入口服务一条缘（交替布在
       `SH.PLATFORM_EXITS`），"经楼梯下到两侧缘口"就是这条动线。
       板上留洞给梯体穿上来，与走廊站厅同一套留洞口径（洞口 = 出入口里程 ± voidHalf）。
       走廊（正线外侧）那块板保留为非付费区/通道层 —— 换乘通道与街面出口都在那一侧。
       为什么必须两条缘口各来一遍：岛式站的两条缘口**分别对着一股道**，
       所以"上岛的付费区"天生要服务两条缘；侧式站只有一条缘口，没有这一层。
       岛在 `board = −side` 那侧 ⇒ `_stepsUp` 的横向自乘 `side` 之后还要再取负，
       梯体才落在岛上（下同）。 */
    if (island && !open) {
      const MT = STATION_X.mezzTop, MTT = STATION_X.mezzT, VH = STATION_X.voidHalf;
      const cLat = board * (PLAT_FRONT + PLAT_W_ISL / 2);   // 板轴 = 岛中线
      const HW = PLAT_W_ISL / 2 + 0.35;                     // 两缘各挑 0.35 m
      /* ---- 先布灯，再写几何 ----
         烘焙灯光是**顶点写出去那一刻**查光照网格的，所以"先扫板、后加灯"会让
         这块板自己的灯照不到自己（走廊站厅那次实测板底整片纯黑，比没这层板更糟）。
         板上/板下两排，沿岛两条缘各一列。 */
      const LROWS = [board * (PLAT_FRONT + 1.3), board * (PLAT_FRONT + PLAT_W_ISL - 1.3)];
      for (let ls = Math.ceil(s0 / 4) * 4; ls < s1; ls += 4) {
        const f3 = al.frame(ls);
        for (const lat of LROWS) {
          const lp = al.world(f3, lat, MT - MTT - 0.22);
          this.lg.add(lp[0], lp[1], lp[2], [0.90, 0.95, 1.0], 16, 0.95);
          const hp = al.world(f3, lat, 5.30);
          this.lg.add(hp[0], hp[1], hp[2], [0.90, 0.95, 1.0], 16, 0.9);
        }
      }
      /* ---- 板本体：分段扫，两个洞口处留空（梯体从这里穿上来）---- */
      const exitsDz = SH.PLATFORM_EXITS.map(o => s + o);
      const segsI = [];
      let caI = s0;
      for (const gz of exitsDz) {
        if (gz - VH > caI) segsI.push([caI, gz - VH]);
        caI = Math.max(caI, gz + VH);
      }
      if (caI < s1) segsI.push([caI, s1]);
      for (const [a2, z2] of segsI) {
        if (z2 - a2 < 1.5) continue;
        const dp = al.frames(a2, z2, 6).map(f => { const q = al.world(f, cLat, 0); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(dp, Geo.rectProfile(-HW, MT - MTT, HW, MT),
          { mat: 'concrete', color: rgbOf('#aeb5b9'), closed: true, uvAlong: 1 / 2, vSpan: 1 / (2 * HW) });
      }
      /* ---- 两条板边：栏板（有厚度的闭合截面）+ 竖向线路色檐口 ----
         两点同 y 的"截面"扫出来是零高度的带子，等于没装（第 41 条那一族）。 */
      for (const E of edges) {
        const latOf = x => E.e + E.inw * x;
        const bal = path.map(f => { const q = al.world(f, latOf(-0.35), MT); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(bal, [{ x: 0, y: 0, nx: 0, ny: 1 }, { x: E.inw * 0.06, y: 0, nx: 0, ny: 1 },
          { x: E.inw * 0.06, y: 1.05, nx: 0, ny: -1 }, { x: 0, y: 1.05, nx: 0, ny: -1 }],
          { mat: 'glassSoft', color: rgbOf('#9fd0dc'), closed: true, alpha: 0.45, uvAlong: 1 / 2, vSpan: 1 });
        const fas = path.map(f => { const q = al.world(f, latOf(-0.38), MT - MTT); return { p: q, r: f.r, u: f.u, f: f.f, s: f.s }; });
        this.b.sweep(fas, [{ x: 0, y: 0, nx: E.inw, ny: 0 }, { x: E.inw * 0.06, y: 0, nx: E.inw, ny: 0 },
          { x: E.inw * 0.06, y: 0.45, nx: E.inw, ny: 0 }, { x: 0, y: 0.45, nx: E.inw, ny: 0 }],
          { mat: 'paint', color: rgbOf(color), closed: true, uvAlong: 1 / 3, vSpan: 1 });
      }
      /* ---- 灯具本体（发光面板）：与光源同点位 ---- */
      for (let ls = Math.ceil(s0 / 4) * 4; ls < s1; ls += 4) {
        const f3 = al.frame(ls);
        for (const lat of LROWS) {
          const lo = al.world(f3, lat, MT - MTT - 0.03);
          this.b.plate([lo[0], lo[1], lo[2]], [f3.f[0] * 2.2, f3.f[1] * 2.2, f3.f[2] * 2.2], [0, 0.12, 0], [0, -1, 0],
            rgbOf('#eaf2f8'), { mat: 'emissive', uv: 1, emi: 1.35 });
          const hi = al.world(f3, lat, 5.30);
          this.b.plate([hi[0], hi[1], hi[2]], [f3.f[0] * 2.2, f3.f[1] * 2.2, f3.f[2] * 2.2], [0, 0.12, 0], [0, -1, 0],
            rgbOf('#eef4f9'), { mat: 'emissive', uv: 1, emi: 1.5 });
        }
      }
      /* ---- 楼梯/扶梯：每个出入口一台扶梯 + 一部楼梯，从**自己那条缘口**
         向岛内升到板面（"下到两侧缘口"就是这条动线）。
         `_stepsUp` 的横向自乘 `side`，而岛在 `board = −side` 那侧 ⇒ 传进去的 x
         是"距缘口向岛内的距离"取负。两个出入口落在两条**不同的缘**上：
         i=0 走近缘（板×PLAT_FRONT），i=1 走远缘（板×(PLAT_FRONT+ISLAND_W)）。
         端点一律排成 x0 < x1 —— 楼梯的踏面盒尺寸是 `(x1−x0)/n`，
         反过来写就是"尺寸为负"（cutCover 那次 7240 个反向三角形的同族）。 */
      const riseI = MT - 0.42, runI = riseI / Math.tan(STATION_X.escDeg * SH.DEG);
      const offI = 0.9;                       // 扶梯/楼梯沿线路各让 0.9 m（洞口 ±VH 装得下）
      for (let i = 0; i < 2; i++) {
        const frI = al.frame(exitsDz[i]);
        const dA = PLAT_FRONT + 0.9, dB = dA + runI;      // 距缘口向岛内的距离（正数）
        const xa = i === 0 ? -dA : -(PLAT_W_ISL + PLAT_FRONT - dA);
        const xb = i === 0 ? -dB : -(PLAT_W_ISL + PLAT_FRONT - dB);
        const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
        const y0 = xa < xb ? 0.42 : MT, y1 = xa < xb ? MT : 0.42;
        this._stepsUp(frI, side, x0, y0, x1, y1, -offI, STATION_X.escLane, true);
        this._stepsUp(frI, side, x0, y0, x1, y1, offI, STATION_X.stairW, false);
      }
      /* ---- 对向候乘分到**岛的对向缘**（第 3 层）----
         岛式站没有对向站台（`farPlatform` 已关），但对向车照样要进站开门 ——
         等对向车的人就站在岛的对向那条缘上。横向带 = 岛中线（含 0.2 m 余量）
         到远缘内侧 0.55 m 之间，正好落在本侧候乘带（2.90~6.20）之外，
         两股人流不会重叠。朝向要 `flip`：这条缘在 +board·r 那一侧。
         烘进**静态世界批次**（`this.b`）—— 运行时重建只重建本侧（`crowdStation`），
         烘进 crowdB 会在第一次重建时整批消失（与 farPlatform 的对向人群同一条纪律）。 */
      if (opt.crowdOpp != null) {
        const FAR0 = PLAT_FRONT + PLAT_W_ISL / 2 + 0.2;
        SH.WorldBuilder.crowdInto(this.b, al, board, FAR0 - 0.85, s0, s1,
          hash32(name, 7) ^ 0x51ed27, opt.crowdOpp,
          PLAT_FRONT + PLAT_W_ISL - 0.55, null, null, null, null, null, true);
      }
    }
    for (let i = 0; i < 2; i++) {
      /* 楼梯口里程 = 站心 + SH.PLATFORM_EXITS[i]（单点）。下车人流读同一组值。 */
      const dz = s + SH.PLATFORM_EXITS[i];
      const fr = al.frame(dz);
      /* 街面标高**按出入口自己的里程**取：al.streetDy 是"平滑轨面 + SH.STREET_Y"
         换算回本里程轨面的 dy，与 city() 铺的街面、跟随相机的远景地面同一个基。
         以前这里写死 −10.9（局部轨面下 10.9），而街面在 groundY−10.9 ——
         实测两者最多差 3.5 m，站厅就会半截埋进街面或悬在半空。 */
      const GND = al.streetDy(dz);
      const yaw = Math.atan2(fr.f[0], fr.f[2]);
      if (!open) {
        /* 地下站的楼梯口：横跨走廊 30° 升到站厅层。
           以前这里是 12 级 `0.34 m` 的短跑，从横向 8.25 一路长到 11.99 ——
           而箱涵壁在 11.0，也就是说它**穿墙之后停在半空**，谁也没到得了哪儿。
           现在一台扶梯 + 一部楼梯，下口在站台侧通道、落点结结实实踩在站厅板上。 */
        const rise = STATION_X.mezzTop - 0.42;
        const run = rise / Math.tan(STATION_X.escDeg * SH.DEG);
        const x0 = STATION_X.escFoot, x1 = x0 + run;
        /* `so` 是**相对该出入口里程**的沿线路偏移，不是绝对里程 ——
           第一版在这里传了 `dz - …`（绝对里程），于是两台梯体被沿切线甩到
           3.4 km 之外：站台上什么都看不见，而判据的"首级/顶级"两条竟然
           被走廊台缘那条 metal 压条假绿过去了。 */
        const off = (STATION_X.escLane + STATION_X.stairW) / 2;
        this._stepsUp(fr, side, x0, 0.42, x1, STATION_X.mezzTop, -off, STATION_X.escLane, true);
        this._stepsUp(fr, side, x0, 0.42, x1, STATION_X.mezzTop, off, STATION_X.stairW, false);
        continue;
      }
      const RUN = 21, RISE = 0.18, TREAD = 0.30, LAND = 1.8;
      const x0 = PLAT_FRONT + 6.2;
      /* 梯段轮廓（x=横向、y=竖向，都在该里程的轨道截面里）。
         以前这里是一串 0.3×0.18 的悬空踏步盒加两块平台板：没有梯梁、没有裙板，
         从侧面看就是"一排浮在空中的瓷砖"，街面机位里读不出"楼梯"两个字。
         现在把 63 级折线和下部实体写成**一个闭合多边形**，沿线路方向扫 2.2 m：
         踏步面照旧是锯齿，梯体一次成型，侧面自然就是那道斜裙；裙底落到街面以下
         0.35 m，避免梯体自己浮空。
         点序按 rectProfile 的约定走顺时针（顶边向右），miter 的外法向才成立。 */
      const prof = [{ x: x0, y: 0.44 }];
      let lat = x0, dy = 0.44;
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < RUN; k++) {
          prof.push({ x: lat + TREAD, y: dy });          // 踏面
          dy -= RISE;
          prof.push({ x: lat + TREAD, y: dy });          // 踢面
          lat += TREAD;
        }
        if (r < 2) { prof.push({ x: lat + LAND, y: dy }); lat += LAND; }   // 休息平台
      }
      const bot = Math.min(dy, GND) - 0.35;
      prof.push({ x: lat, y: bot }, { x: x0, y: bot });
      /* 负侧镜像：截面 x 是沿 fr.r 的，站房在 −r 侧就要把整个多边形关于 x=0 翻过去；
         翻完点序跟着反向，所以再倒序一次把顺时针约定还回来。 */
      const prof2 = side > 0 ? prof : prof.slice().reverse().map(q => ({ x: -q.x, y: q.y }));
      const stair = [dz - 1.1, dz + 1.1].map(m => { const g = al.frame(m); return { p: al.world(g, 0, 0), r: g.r, u: g.u, f: g.f, s: m }; });
      this.b.sweep(stair, Geo.miter(prof2),
        { mat: 'granite', color: rgbOf('#b4bbbf'), closed: true, uvAlong: 1 / 2, vSpan: 40 });
      /* 扶手：一根 7×7 cm 方钢沿下降方向扫过去，两侧各一。
         这里必须**自己造一组正交基**：sweep 的截面 x→fr.r、y→fr.u，而这条路径
         是在 (横向,竖向) 平面里前进的 —— 沿用轨道基等于让截面长轴与路径同向，
         扫出来的不是栏杆而是一条塌扁带子（test-wind 报的那 10 个反向三角形、
         截图里"只见一条斜线"都是它）。顺带修一条更蠢的：旧代码把两根扶手沿
         fr.r 错开 ±1.15 m，而梯段那 2.2 m 的宽度是**沿线路方向**的 ——
         等于一内一外装了两条互相穿过的栏杆。 */
      for (const sgn of [-1, 1]) {
        const nodes = [];
        let l2 = x0, d2 = 0.44 + 0.95;
        nodes.push([l2, d2]);
        for (let r = 0; r < 3; r++) {
          l2 += RUN * TREAD; d2 -= RUN * RISE; nodes.push([l2, d2]);
          if (r < 2) l2 += LAND;
        }
        const rf = [];
        for (let k = 0; k < nodes.length; k++) {
          const A = nodes[Math.max(0, k - 1)], B = nodes[Math.min(nodes.length - 1, k + 1)];
          const pa = al.world(fr, side * A[0], A[1]), pb = al.world(fr, side * B[0], B[1]);
          const t = norm3([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
          const uu = norm3(cross(fr.f, t));
          const p = al.world(fr, side * nodes[k][0], nodes[k][1]);
          rf.push({ p: [p[0] + fr.f[0] * sgn * 1.05, p[1] + fr.f[1] * sgn * 1.05, p[2] + fr.f[2] * sgn * 1.05],
            r: fr.f, u: uu, f: t, s: nodes[k][0] });
        }
        this.b.sweep(rf, Geo.rectProfile(-0.035, -0.035, 0.035, 0.035),
          { mat: 'metal', color: rgbOf('#9aa4aa'), closed: true, uvAlong: 1 / 2, vSpan: 1 / 2 });
      }
      /* 与楼梯并排的一台**长扶梯**：真实高架站（3/5/8/9…号线）就是"一部楼梯 +
         一台上行扶梯"并排挂在桥面外侧，只有楼梯没有扶梯的高架站是不存在的。
         复用同一个 `_stepsUp`：斜率由楼梯的实际起终点决定（这里 ≈27°，
         与真实自动扶梯的 27.3°/30° 一档），不另写一套梯体公式。 */
      this._stepsUp(fr, side, x0, 0.44, lat, dy + 0.12, 1.1 + 0.2 + STATION_X.escLane / 2, STATION_X.escLane, true);
      /* 落地端的站厅与雨棚：没有这一间房子，"出入口"就只是一堆台阶。 */
      const ex = lat + 2.0;
      const gp = al.world(fr, side * ex, GND + 1.75);
      this.b.box([gp[0], gp[1], gp[2]], [4.0, 3.5, 5.6], rgbOf('#c6ced3'), { mat: 'tiles', yaw });
      /* 门口：朝街面那一侧挖一块深色凹进去的玻璃门洞。
         一个纯色方盒在街面机位里读不出"可以进去"，加一道 1.8×2.3 m 的暗口就有了。 */
      const dp = al.world(fr, side * (ex + 2.02), GND + 1.20);
      this.b.box([dp[0], dp[1], dp[2]], [0.08, 2.4, 1.9], rgbOf('#28303a'), { mat: 'glassSoft', yaw });
      const cp = al.world(fr, side * (ex - 1.1), GND + 3.72);
      this.b.box([cp[0], cp[1], cp[2]], [6.6, 0.24, 8.0], rgbOf('#8f989e'), { mat: 'metal', yaw });
      this.b.box([cp[0], cp[1] - 0.3, cp[2]], [6.9, 0.36, 8.3], rgbOf('#727b81'), { mat: 'metal', faces: [3], yaw });
      this.lg.add(...al.world(fr, side * ex, GND + 3.3), [0.95, 0.97, 1.0], 11, 0.75);
      /* _shadow 的 gy 是**世界 Y**（它直接当盒子的中心高用），而 GND 是相对轨面的 dy。
         以前这里传 GND+0.02，等于把影子钉在世界 y=−10.88 上 —— 全线轨面世界高
         在 ±15 m 之间走，于是站厅的投影在有的站浮在半空、有的站沉到地下。 */
      this._shadow(gp[0], gp[2], 4.0, 5.6, yaw, 3.5, al.world(fr, side * ex, GND)[1] + 0.02, rgbOf('#9aa4ae'));
      /* 出站通道：站厅落在街面标高，但**走廊断面的行人道在横向 57~64 m**，
         中间这二十多米是车行道。真实高架站就是靠这样一条带路缘石的地面通道
         把出入口接到人行道上的；没有它，站厅就是"路中间孤零零一间房子"。
         63 级 × 0.30 踏面正好把 11.34 m 的高差落在横向 30.75 m 处，
         这是踏步尺寸决定的，不是随手摆的。 */
      const w0 = lat, w1 = 57.0;
      const wp2 = al.world(fr, side * (w0 + w1) / 2, GND + 0.04);
      this.b.box([wp2[0], wp2[1], wp2[2]], [w1 - w0, 0.10, 3.0], rgbOf('#a9b1b6'), { mat: 'granite', faces: [0, 2], yaw });
      for (const sgn of [-1, 1]) {
        /* 两条路缘石在通道的**两侧**（沿线路方向各错开 1.5 m）。
           以前把偏移加在横向坐标上，等于两条石条一内一外叠在通道中间，
           通道两边反而没有沿。 */
        const kp = al.world(fr, side * (w0 + w1) / 2, GND + 0.22);
        this.b.box([kp[0] + fr.f[0] * sgn * 1.5, kp[1] + fr.f[1] * sgn * 1.5, kp[2] + fr.f[2] * sgn * 1.5],
          [w1 - w0, 0.26, 0.22], rgbOf('#8d959a'), { mat: 'granite', faces: [0, 1, 4, 5], yaw });
      }
    }
    // ---- 站台人群（剪影式，给空间以尺度） ----
    /* 高架站的玻璃护栏在 STATION_X.rail（5.47 m）：散布上限必须收在护栏内，
       否则人越出护栏、隔着玻璃变成一团半透明鬼影（dev/shot.js 的 ghost 截图）。 */
    /* 岛式站的候乘带 = 岛的**近半幅**（板×front ~ 板×(front+ISLAND_W/2)）——
       与运行时重建（`crowdStation`）读同一个 `board` 与同一条带宽公式，
       否则"关门时人在走廊侧、开门时人跳到岛上"（B 第 2 层只改了运行时那一条）。 */
    const maxOff = open ? STATION_X.rail - 0.45 : (island ? STATION_X.front + SH.ISLAND_W : 9.5);
    /* 人群单独成批（第 101 条）：`crowdB` 给了就写进它，不给就照旧写进世界网格。
       离线判据（test-bake / test-wind / test-wedge）不设 `crowdB`，所以它们看到的
       三角形集合与改动前**逐字节一致** —— 这正是"加一类东西先问哪条判据看得见它"
       的答案：不改判据的口径，而是给新批次一个可选的去向。
       切进 `crowdB` 时要把**同一份人工光**装上去，否则运行时重建的人群没有灯光。 */
    if (this.crowdB) {
      const main = this.b;
      this.b = this.crowdB;
      if (this.lightFn) this.b.light(this.lightFn);
      /* 人群带 = 站台全程（不跟停车标挪）：停车标移到站台端之后，整列车
         （门线 s−145..s+37）本来就落在站台 s−150..s+42 里，全站台候车
         恰好覆盖每一扇门。 */
      this.crowd(s, board, PLAT_FRONT, s0, s1, opt.seed || 1, opt.crowd, maxOff, SH.WorldBuilder.hallBand(s, open), SH.WorldBuilder.streetBand(this.cfg.al));
      this.b = main;
    } else {
      this.crowd(s, board, PLAT_FRONT, s0, s1, opt.seed || 1, opt.crowd, maxOff, SH.WorldBuilder.hallBand(s, open), SH.WorldBuilder.streetBand(this.cfg.al));
    }
    /* 站务员（第 105 条）：烘在**世界网格**里，不进人群批次 ——
       人群会在开门期间被重建（人数随乘降下降），站务员不上车。
       登记进 `facilities`（kind `'staff'`），这样"记录 ↔ 几何"那条判据
       自动把它一起验了，不必再写一份。 */
    {
      const staff = [];
      /* 站务员站在**站台**上 —— 岛式站的站台是岛（board 那侧），
         读 `side` 会让他站在正线对面的走廊里（第 2 层只换了人群，漏了这一个）。 */
      SH.WorldBuilder.staffInto(this.b, al, board, s, staff);
      this.facilities = this.facilities || [];
      for (const o of staff) this.facilities.push({ kind: 'staff', s: o.s, lat: o.lat, dy: o.dy, mats: ['paint'] });
    }
    return this;
  }

  /**
   * 站台上的人。四个要点：
   *  1. **数量由客流模型给**（opt.crowd），不是固定 46 个 —— 人群密度本身就是
   *     "这站有多少人在等"的可视化，司机一眼能判断该停多久；
   *  2. 人不是轴对齐的盒子。原来算出了 yaw 却没用，所有人同一朝向，
   *     从站台机位看过去是一排纸片。改用"十字交叉两块板"的经典做法，
   *     任何视角看都是个立体的人，代价只有两个盒子。
   *  3. **朝向按"在干什么"给**：守在门口的排队者面向屏蔽门（身体横着，
   *     宽轴与站台平行），散布的走客顺着站台走（宽轴横着来车方向），
   *     各带 ±0.3 rad 抖动。`crowdInfo` 把每个人的朝向记下来，
   *     test-pax 据此断言"排队的人确实横过来、走客确实顺着" ——
   *     朝向是行为的一部分，不是配色。
   *  4. **谁都不许站到护栏外**：`maxOff` 由调用方按"护栏在哪"给，
   *     不是拍脑袋的常数。
   */
  crowd(s, side, platFront, s0, s1, seed, count, maxOff, hall, street) {
    this.crowdInfo = this.crowdInfo || [];
    SH.WorldBuilder.crowdInto(this.b, this.cfg.al, side, platFront, s0, s1, seed, count, maxOff, this.crowdInfo,
      null, null, hall, street, SH.WorldBuilder.camSpot(s));
    return this;
  }

  /** 本线路每个车站的街区类型（一次算好缓存）。地名学判不出的走径向兜底，
   *  见 core.js 的 zoneAtLine —— 两级判据都公开可查，判据会数"有多少站是兜底"。 */
  _zones() {
    if (this._zoneCache) return this._zoneCache;
    const names = this.cfg.stations || [], S = (this.cfg.al && this.cfg.al.stationS) || [];
    const core = [];
    names.forEach((n, i) => { if (SH.CORE_STATIONS.indexOf(n) >= 0) core.push(i); });
    this._zoneS = S;
    this._zoneCache = names.map((n, i) => SH.zoneAtLine(n, i, names.length, core.length > 0, core));
    return this._zoneCache;
  }
  /** 该里程的街区类型：取**最近车站**那一档。分区分出来了但几何照旧，
   *  就是"文案在涨、画面一动不动"那一族缺陷。 */
  zoneAt(s) {
    const zs = this._zones(), S = this._zoneS || [];
    if (!zs.length || !S.length) return Object.assign({ key: 'other' }, SH.SCENE_ZONES.other);
    /* 里程单调前进时用上一次的索引起步：绝对相位预热要沿整条线走一遍，
       每次都线性扫 30 个站会把这件事变成 O(n²)。 */
    let bi = this._zi || 0, bd = Math.abs(S[bi] - s);
    for (let i = 1; i < S.length; i++) { const d = Math.abs(S[i] - s); if (d < bd) { bd = d; bi = i; } }
    this._zi = bi;
    const z = zs[bi];
    return Object.assign({ key: z.zone }, SH.SCENE_ZONES[z.zone]);
  }
  /** 从**绝对里程 0** 起按分区档距推进，直到进入烘焙窗口 ——
   *  摆放相位必须钉在绝对里程上（第 67 条），否则窗口一挪，
   *  树与楼跟着换位置，test-bake 的"重烘挪家具"当场报红。 */
  _phaseTo(from, a, getStep) {
    let p = from;
    while (p < a) p += getStep(p);
    return p;
  }

  /** 对向站台（第二座侧式站台）。
   *
   * 以前一座站只建**本线行驶方向那一侧**的站台，对面那一侧是一堵贴瓷片的
   * 墙加一块大字壁（`station()` 里"对面侧墙"那一节）。从站台上望过去，
   * 轨道对面是"一整面没有门的墙" —— 而上海地铁绝大多数站是两座侧式站台
   * 或一岛一侧，对面那侧本来就该有一条能上车的站台。
   * 目标里"站台设计和建模必须 Unity 级"最显眼的一处缺口就是它。
   *
   * 这里镜像的是**看得出来的那五件**：站台板、安全黄线与盲道、屏蔽门立柱链
   * 与门头梁＋线路色带、雨棚/吊顶与灯带、站名标。不镜像闸机、楼梯、站厅、
   * 换乘通道 —— 那些是"这一侧的乘客怎么用这一座站"的构件，双侧各来一套
   * 既没有依据也没有人看。
   * 横向尺寸全部走 STATION_X（与 station() 同一份），截面 x 一律带 sg 符号
   * （当年 3 号线 漕溪路 的站台板压掉正线一半，就是忘了这一条）。
   */
  farPlatform(s, side, opt, rect) {
    const al = this.cfg.al, cfg = this.cfg;
    const sg = -side;                                  // 对向站台在那一侧
    const open = !!opt.open;
    const pw = STATION_X.width;
    const s0 = s - 150, s1 = s + 42;
    const apm = !!(this.cfg.profile && this.cfg.profile.rubber);
    const color = (opt.peer && opt.peer.color) || this.cfg.color;
    const outRect = (w, y0, y1) => Geo.rectProfile(sg > 0 ? 0 : -w, y0, sg > 0 ? w : 0, y1);
    /* 缘口在对向股道的**外侧**（见 `SH.farFrontOf` 那段实量记录）：下面 13 处
       `sg * (PLAT_FRONT + d)` 一律照本侧的相对尺寸写，只有基准这一处不同。 */
    const PLAT_FRONT = SH.farFrontOf(this._oppLat ? this._oppLat(s) : 0);
    const path = al.frames(s0, s1, 4);
    /* ---- 站台板 ---- */
    const pp = path.map(f => ({ p: al.world(f, sg * PLAT_FRONT, 0), r: f.r, u: f.u, f: f.f, s: f.s }));
    this.b.sweep(pp, outRect(pw, -1.0, 0.42),
      { mat: 'granite', color: rgbOf('#b3b9bd'), closed: true, uvAlong: 1 / 1.2, vSpan: 1 });
    if (!open) {
      const WALLX = STATION_X.boxW - 0.35, BACK = PLAT_FRONT + pw;
      const bp = path.map(f => ({ p: al.world(f, sg * BACK, 0), r: f.r, u: f.u, f: f.f, s: f.s }));
      this.b.sweep(bp, outRect(WALLX - BACK, -1.0, 0.42),
        { mat: 'granite', color: rgbOf('#a5acaf'), closed: true, uvAlong: 1 / 1.2, vSpan: 1 });
    }
    /* ---- 安全黄线 + 盲道 ----
       这两条用**闭合薄矩形**（`outRect`）而不是两点开放截面：两点截面的 x 必须
       升序，而 `sg` 为负时 `0 → sg*w` 是降序 —— test-wind 直接把这一族的绕序
       全部标成反向（"绕序 = 可见性"那条铁律，站台上量到 5760 个反向三角形）。 */
    const yl = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 0.35), 0.42), r: f.r, u: f.u, f: f.f, s: f.s }));
    this.b.sweep(yl, outRect(0.14, 0, 0.025),
      { mat: 'paint', color: rgbOf('#d9a947'), closed: true, uvAlong: 1, vSpan: 0.14, emi: 0.12 });
    const bl = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 1.05), 0.42), r: f.r, u: f.u, f: f.f, s: f.s }));
    this.b.sweep(bl, outRect(0.60, 0, 0.025),
      { mat: 'granite', color: rgbOf('#c9cfd2'), closed: true, uvAlong: 1 / 0.3, vSpan: 2 });
    /* ---- 屏蔽门立柱链 + 门头梁 + 线路色带 ---- */
    const doorCount = Math.round(140 / 2.2);
    for (let i = -1; i <= doorCount; i++) {
      const dz = s + SH.STOP_MARK - 4 - i * 2.2;
      if (dz < s0 + 4 || dz > s1 - 4) continue;
      const fr = al.frame(dz);
      const p = al.world(fr, sg * (PLAT_FRONT + 0.06), 0.44);
      this.b.box([p[0], p[1] + (apm ? 0.75 : 1.28), p[2]], [0.10, apm ? 1.50 : 2.56, 0.14],
        rgbOf('#39424a'), { mat: 'metal' });
    }
    if (apm) {
      /* 半高安全门只有扶手梁：门头梁 + 线路色带是 2.62 m 的构件，
         装在 3.2 m 高的胶轮车旁边本身就是穿帮（本线那一侧同一个分支，
         test-bake 有判据：APM 站站台门带上不许有高于 2.0 m 的 metal）。 */
      const rail2 = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 0.06), 1.92), r: f.r, u: f.u, f: f.f, s: f.s }));
      this.b.sweep(rail2, outRect(0.07, 0, 0.07),
        { mat: 'metal', color: rgbOf('#8f999f'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
    } else {
      const hdr = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 0.06), 2.62), r: f.r, u: f.u, f: f.f, s: f.s }));
      this.b.sweep(hdr, outRect(0.22, 0, 0.34),
        { mat: 'metal', color: rgbOf('#4a545c'), closed: true, uvAlong: 1 / 2, vSpan: 1 });
      const band = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 0.175), 2.40), r: f.r, u: f.u, f: f.f, s: f.s }));
      this.b.sweep(band, outRect(0.14, 0, 0.16),
        { mat: 'paint', color: rgbOf(color), closed: true, uvAlong: 1, vSpan: 1, emi: 0.30 });
    }
    /* ---- 吊顶 / 雨棚 + 两条灯带 ----
       灯带是 emissive 加算，不点真光源：一座站两侧各一排，全站就是几十盏，
       而换乘通道那次的实测教训是"灯多了整条走廊烘焙压垮"。 */
    const ceilY = STATION_X.ceilH;
    const cp = path.map(f => ({ p: al.world(f, sg * (PLAT_FRONT + 0.3), ceilY), r: f.r, u: f.u, f: f.f, s: f.s }));
    this.b.sweep(cp, outRect(STATION_X.canopyOut - STATION_X.canopyIn, -0.16, 0),
      { mat: 'light', color: rgbOf('#dfe5e8'), closed: true, uvAlong: 1 / 3, vSpan: 1 });
    for (const lx of [PLAT_FRONT + 1.0, PLAT_FRONT + 2.6]) {
      const lp = path.map(f => ({ p: al.world(f, sg * lx, ceilY - 0.22), r: f.r, u: f.u, f: f.f, s: f.s }));
      this.b.sweep(lp, outRect(0.34, 0, 0.05),
        { mat: 'emissive', color: rgbOf('#fff2d8'), closed: true, uvAlong: 1 / 3, vSpan: 0.34 / 3, emi: 0.85 });
    }
    /* ---- 站名标 ----
       共线同站台（shared）那三处（虹桥路 / 延安西路 / 宝山路，3、4 号线同台对面换乘）：
       对面那块牌必须写**对方线路**的名字与色带，否则"过对面站台就是另一条线"
       在画面上不成立 —— 看到的还是本线。 */
    const peer = opt.peer;
    const pr = peer
      ? cfg.sign.add('plate:' + opt.name + ':' + peer.id, 512, 106, (c, w, h) => SH.textures.signStationPlate(c, w, h,
        { name: peer.name, en: 'To Line ' + peer.name.replace(/[^0-9a-zA-Z]/g, '') || peer.id, code: opt.code, color: peer.color }))
      : rect;
    if (pr) for (const dz of [s - 34, s + 6]) {
      if (dz < s0 + 6 || dz > s1 - 6) continue;
      const fr = al.frame(dz);
      const p = al.world(fr, sg * (PLAT_FRONT + 0.20), apm ? ceilY - 1.30 : 2.28);
      const nrm = norm3([fr.r[0] * -sg, fr.r[1] * -sg, fr.r[2] * -sg]);
      this.b.panel([p[0], p[1], p[2]], [fr.f[0] * 4.6 * sg, fr.f[1] * 4.6 * sg, fr.f[2] * 4.6 * sg],
        [0, 0.95, 0], nrm, pr, [1, 1, 1], 0.55);
    }
    /* ---- 对向站台的候乘人群（诚实清单 §7.2）----
       以前对面站台上一个人都没有：一座"在运营"的车站，对面方向的候车
       人数不可能是零。人数与时段走**同一个客流模型**的对向桶
       （`Flow.waitingAt(name, i, -1)`，demand 公式同源、'#opp' 盐值错开），
       由 buildRuns 以 opt.crowdOpp 传入 —— 与本侧 opt.crowd 同一条路径。
       烘进**静态世界批次**（不走 crowdB）：运行时重建（第 101 条）只重建
       本侧站台人群，对向人群烘进 crowdB 会在第一次重建时整批消失。
       种子与本侧错开（同一站两侧的人不该站位相同），hall/street 都不传：
       对向站台没有站厅夹层，街面行人也不能两侧各算一遍。 */
    if (opt.crowdOpp != null) {
      /* 横向带上界按**对向站台板自己的宽度**收：对向一侧没有站厅走廊（那边只有
         一块站台板与吊顶），沿用本侧那个"到 9.5 / 到 rail−0.45"会把人排到板外。 */
      SH.WorldBuilder.crowdInto(this.b, al, sg, PLAT_FRONT, s0, s1,
        hash32(opt.name, 7) ^ 0x51ed27, opt.crowdOpp,
        PLAT_FRONT + (open ? STATION_X.rail - STATION_X.front : pw), null, null, null, null, null);
    }
    this.farPlatforms.push({ s, side: sg, open, apm,
      lat0: PLAT_FRONT, lat1: PLAT_FRONT + pw, ceilY });
    return this;
  }

  /** 屋顶形式按街区类型（`SH.SCENE_ZONES.roof`）：
   *   pitch 古镇/里弄的双坡顶（屋脊沿楼长方向）；
   *   step  新区/枢纽的阶梯退台（顶层收进一圈）；
   *   saw   工业带的锯齿屋顶（沿进深一排朝北斜面）；
   *   flat  原租界与大道公寓的平屋顶 + 女儿墙（已有，不再加东西）。
   *  以前十档分区只有楼高与树被消费，`roof` 与 `pad` 是数据表里的装饰 ——
   *  判据（test-scene）现在会问"屋脊到底有没有长出来"。 */
  _zoneRoof(Z, rp, w, d, cy, sy, yaw, r1, r2) {
    const dark = rgbOf(Z.key === 'oldtown' ? '#3b2f28' : '#5a6167');
    if (Z.roof === 'pitch') {
      const rise = 1.1 + r1 * 0.9;
      for (const sg of [-1, 1]) {
        const ax = [-w * cy, 0, w * sy];
        const ay = [sg * d / 2 * -sy, rise, sg * d / 2 * cy];
        const nrm = SH.Geo.norm3([ay[1] * ax[2] - ay[2] * ax[1], ay[2] * ax[0] - ay[0] * ax[2], ay[0] * ax[1] - ay[1] * ax[0]]);
        this.b.plate([rp[0] + ay[0] / 2, rp[1] + rise / 2, rp[2] + ay[2] / 2], ax, ay, nrm, dark, { mat: 'roof', uv: 1 });
      }
      this.b.box([rp[0], rp[1] + rise, rp[2]], [w + 0.2, 0.16, 0.22], dark, { mat: 'roof', yaw });
    } else if (Z.roof === 'step') {
      this.b.box([rp[0], rp[1] + 1.5, rp[2]], [w * 0.66, 3.0, d * 0.66], rgbOf('#6b7277'), { mat: 'roof', faces: [0, 1, 4, 5], yaw });
      this.b.box([rp[0], rp[1] + 3.6, rp[2]], [w * 0.34, 1.4, d * 0.34], rgbOf('#60676c'), { mat: 'roof', faces: [0, 1, 4, 5], yaw });
    } else if (Z.roof === 'saw') {
      const n = Math.max(2, Math.round(d / 3.2));
      for (let k = 0; k < n; k++) {
        const off = -d / 2 + (k + 0.5) * (d / n);
        const ax = [w * cy, 0, -w * sy];
        const ay = [-(d / n) * 0.5 * -sy, 1.5, -(d / n) * 0.5 * cy];
        const nrm = SH.Geo.norm3([ay[1] * ax[2] - ay[2] * ax[1], ay[2] * ax[0] - ay[0] * ax[2], ay[0] * ax[1] - ay[1] * ax[0]]);
        this.b.plate([rp[0] - off * sy, rp[1] + 0.75, rp[2] + off * cy], ax, ay, nrm, rgbOf('#7d858a'), { mat: 'roof', uv: 1 });
      }
    }
  }

  /** 街面人行道带：树线以外、**地块界围墙以内**；公交站参数与 street.js 同源。
   *  以前内缘写的是 `lotLine - 1.5`（横向 68 m）—— 那是楼线的内侧，比人行道
   *  花岗岩带的实际边界（64 m）宽出 4 m，街面行人有一半站在围墙外面、
   *  甚至站在楼体里。现在内缘由围墙线给出：人是走在路上的，不是走在院子里的。
   *  `dy` 走 `al.streetDy(s)` —— 街面标高与线路断面的关系只在 core 里定义一次。 */
  static streetBand(al) {
    return {
      lat0: SH.STREET_WALK.tree + 0.9, lat1: SH.STREET_WALK.wall - 1.0,
      dy: function (s) { return al.streetDy(s); },
      jitter: 60, bus: SH.ROAD.bus, busShare: 0.35,
    };
  }

  /** 站厅层的可行带（只有地下站有第二层）：横向从闸机柜外沿到箱涵壁内侧，
   *  沿线路避开楼扶梯洞口（洞口上站人 = 人悬在洞里）。
   *  全部数值取自站厅自己的常量 —— 再抄一遍 6.25/10.65 就是第二个真值。 */
  static hallBand(s, open) {
    if (open) return null;
    const MI = STATION_X.mezzIn, VH = STATION_X.voidHalf;
    return { y: STATION_X.mezzTop, lat0: MI + 1.75, lat1: STATION_X.boxW - 0.35 - 0.55,
      voids: SH.PLATFORM_EXITS.map(oo => s + oo), vh: VH + 0.55, jitter: 26 };
  }

  /**
   * 站台人群的几何（**唯一实现**）。
   *
   * 抽成静态是为了让**运行时重建**（第 101 条：开门期间站台人数随乘降下降）
   * 与烘焙走同一段代码 —— 复制一份"人怎么摆"就是第二个真值，而它的症状
   * 是"运行时的人群与烘焙的人群站位/朝向不一样"，从站台机位上不一定看得出来。
   *
   * @param b     目标构建器（烘焙时是 `wb.b`，运行时是一个独立的 'crowd' 批次）
   * @param al    线形
   * @param info  可选：把每个人的 {s, off, queuing, yaw} 记进去（判据用）
   * @param alight 可选（B4）：{dwell, need, rate, dwellNeed, wait0} —— 开门期间的
   *   乘降可视化输入，由 `pax.Flow.visual()` 一次给齐。给了它，队列尾部出现
   *   "往车门线挪"的上车带、站台上有"从门里出来走向端头"的下车人流；
   *   不给（烘焙/关门），几何与旧版逐字节一致。
   */
  /** 站台机位的站位（人群净空泡）。与 `SH.platformShot` 读同一个 `SH.PLAT_CAM` ——
      相机与净空必须是同一个数，各写一份就会出现"挪了相机忘了挪净空"。 */
  static camSpot(ss) {
    return ss == null ? null : { s: ss + SH.PLAT_CAM.dz, lat: SH.PLAT_CAM.lat, r: SH.PLAT_CAM.r };
  }
  static crowdInto(b, al, side, platFront, s0, s1, seed, count, maxOff, info, alight, exits, hall, street, cam, flip) {
    const R = rng(seed >>> 0);
    const hues = SH.PAX_HUES;
    /* 人数 = 候乘人数 ÷ 3.4（上限 240）；`count` 缺省（展示模式）时给 46 个人。
       这里**不再对人数取"至少 6 人"的下限**：乘降把人拉走之后站台必须真的能空，
       否则"人都上车了"这件事在画面上永远差最后 6 个人（第 101 条的判据会量到）。 */
    const n = count == null ? 46 : Math.max(0, Math.min(240, Math.round(count / 3.4)));
    const span = s1 - s0 - 12;
    const offCap = maxOff == null ? 9.5 : maxOff;
    /* 先把每个人的**参数**抽完（随机数消耗顺序与旧版逐字一致，所以站位不变），
       再统一按登车次序发射几何。 */
    const P = [];
    for (let i = 0; i < n; i++) {
      /* 排队者比例沿序列**递增**（0.42 → 1.0）。这不是美术口味，而是让
         "运行时按人数截断"读得对：截断永远从序列尾部开始，而尾部以排队者为主，
         于是画面上先消失的是门口那批人（上车了），留在站台上的是走客。
         固定比例的随机抽签做不到 —— 那样被截掉的人与总体同分布，
         读起来只是"人群随机少了几个人"。
         这个比例是 `i` 的**固定函数**（与 n 无关），所以"保留前 k 个"始终是
         同一批人的前缀，重建时不会整片重排（第 101 条）。 */
      const queuing = rand01('crowdq' + seed, i) < (0.42 + 0.58 * (i / 240));
      const doorT = queuing ? (Math.floor(R() * 8) / 8 + (R() - 0.5) * 0.07) : R();
      const dz = s0 + 6 + clamp(doorT, 0.02, 0.98) * span;
      const off = platFront + 0.85 + Math.pow(R(), 1.5) * Math.min(3.3, Math.max(0.4, offCap - platFront - 0.85));
      const h = 1.56 + R() * 0.28;
      const fr = al.frame(dz);
      /* box 的局部 z 轴是身体的"进深"（窄轴）。排队者窄轴指向屏蔽门
         （-side·r：面朝来车），走客窄轴顺/逆行车方向（±f）。 */
      /* 排队者窄轴指向**自己那条缘**（-side·r 是"往线路中心看"那一侧）。
         `flip`：岛式站的**对向缘**在 +side·r 那一侧（那条缘对的是对向股道），
         等对向车的人必须面朝它 —— 不翻的话一岛两侧的人会背对背站着。 */
      const yaw = queuing
        ? Math.atan2(-side * fr.r[0], -side * fr.r[2]) + (flip ? Math.PI : 0)
        : Math.atan2(fr.f[0], fr.f[2]) + (R() < 0.5 ? 0 : Math.PI);
      const yawJ = yaw + (R() - 0.5) * 0.6;
      const hue = hues[Math.floor(R() * hues.length)];
      const th = 0.40 + R() * 0.06;
      const face = R() < 0.5 ? '#c8a486' : '#8a6a52';
      const lug = R() > 0.80 ? (R() > 0.5 ? '#5b3f3a' : '#2f3a4a') : null;
      const seat = R() > 0.90;
      /* 人群细节（D1）：每个人的"配置"在这里抽完 —— 随机数消耗顺序固定，
         所以前缀稳定性（重建不闪烁）与确定性（回归可复现）都保得住。 */
      const hair = ['#191d21', '#23180f', '#3a2a17', '#101215', '#4a3421'][Math.floor(R() * 5)];
      const pack = !queuing && R() > 0.72;                       // 走客 28% 背包
      const phone = !queuing && R() > 0.55;                      // 走客 45% 看手机
      /* 体型/轮廓变体（D1 续）：抽签照旧在每人自己的段内追加，
         前缀稳定性与确定性不受影响。 */
      const skirt = R() > 0.62;                                  // 38% 裙装轮廓
      const longHair = R() > 0.55;                               // 45% 长发
      const tote = !queuing && !pack && R() > 0.70;              // 空手的走客拎袋
      /* 层级归属用**一次**哈希抽签分桶（u<hall 站厅、u<hall+street 街面、其余站台）：
         一次抽签保证三层的份额严格等于档案值（各自独立抽会让份额随相关性漂移），
         且不占 R() 的序列 —— 否则既有站位与前缀稳定性会整体错位。 */
      const lvlU = rand01('lvl' + seed, i);
      const onHall = !!hall && lvlU < SH.PAX_SPLIT.hall;
      const onStreet = !onHall && !!street && lvlU < SH.PAX_SPLIT.hall + SH.PAX_SPLIT.street;
      /* 站台机位的站位净空（§7.10 量出来的账）：相机眼站在 (站心+PLAT_CAM.dz, 横向
         PLAT_CAM.lat)，而候乘的横向带是 2.90~6.20、沿站台均布 —— 实测 8 处机位里
         6 处**有人正好长在镜头上**（最近 0.82 m），十字人形的两片在 1 m 内摊开，
         画面上就是"一只打开的纸箱"。
         这里**不删人**：人数是司机该停多久的依据，删一个就是谎报一个；
         只把落在净空泡里的人**沿站台推出去** —— 真实人群本来也不会严丝合缝
         叠在同一个位置上等车。站位与半径两边共用 `SH.PLAT_CAM`，
         各写一份就会出现"挪了相机忘了挪净空"。 */
      let pdz = dz, pfr = fr;
      if (cam && !onHall && !onStreet) {
        const dl = pdz - cam.s, wo = Math.abs(off - cam.lat);
        if (Math.abs(dl) < cam.r && wo < cam.r) {
          const k = Math.sqrt(cam.r * cam.r - wo * wo);
          pdz = SH.clamp(cam.s + (dl >= 0 ? k : -k), s0 + 6, s1 - 6);
          pfr = al.frame(pdz);
        }
      }
      P.push({ queuing, dz: pdz, off, h, fr: pfr, yawJ, hue, th, face, lug, seat, hair, pack, phone, skirt, longHair, tote, onHall, onStreet });
    }
    /* 发射顺序 = 生成顺序。**不能按"是否排队"排序**：排序会让"保留前 k 个"
       不再是同一批人（k 变了、排序结果就变了），于是每次重建整片人群都会重排，
       画面上是"人原地闪烁"而不是"人上车"。登车次序由上面那条递增比例保证。 */
    /* B4 上车带：门开着的时候，候乘队列的**尾部**（即将上车的 m 个人）不再
       站在原地消失，而是往前挪到车门线再上车。带宽 = 开门时候乘(k0) × 2.2 s ÷
       dwellNeed —— 司机停多久，门口的人就按什么节奏走光：早高峰车厢挤、
       dwellNeed 25 s，只有几个人在挪；空车 8 s 停站，一截队列都在往前走。
       `wait0` 取**开门那一刻**的候乘（pax.visual 给的 wantOn），不是"现在还剩
       几个" —— 候乘跟着重建一路缩，用它当基数的带会跟着缩没，"密度与开门
       时长挂钩"就量不出来了。没有 alight（烘焙/关门）时带不存在，
       几何与旧版逐字节一致。 */
    /* 带只属于**站台上正在排队的人**：
       —— 站厅/街面的人不能"正在登车"（他们不在这一层）；
       —— 非排队者（在站台上散步/张望的）也不该进带：分层之后站台只剩四成人，
         若还按"站台上最后 N 个人"取，带会一路往前捞到不排队的人，
         "挤得越狠上得越慢"那条比值被稀释成 1.8（原本 3.7）。 */
    const platQue = [];
    for (let i = 0; i < P.length; i++) if (!P[i].onHall && !P[i].onStreet && P[i].queuing) platQue.push(i);
    const bandOf = new Map();
    if (alight && alight.dwellNeed > 0 && platQue.length) {
      const k0 = Math.max(1, Math.round((alight.wait0 != null ? alight.wait0 : (count || 0)) / 3.4));
      const bandM = Math.max(1, Math.min(platQue.length, Math.round(k0 * 2.2 / Math.max(4, alight.dwellNeed))));
      const from = platQue.length - bandM;
      for (let k = from; k < platQue.length; k++) bandOf.set(platQue[k], Math.min(1, (k - from + 1) / bandM));
    }
    const doorLat = platFront + 0.5;
    for (let i = 0; i < P.length; i++) {
      const q = P[i];
      let lat = side * q.off;
      let band = null;
      if (q.queuing && bandOf.has(i)) {
        /* 队尾的人往车门线挪：bp=0 在原位、bp→1 到门线（下一次重建他就上车消失）。
           位置只依赖 (seed, i, 站台人数, 带宽)，全是确定量 —— 重建不闪。 */
        band = bandOf.get(i);
        lat = lat + (side * doorLat - lat) * band;
      }
      /* 上车带里的人确实在挪：相位 = 已经挪过的米数 ÷ 步长。`i*0.31` 是
         脱开同摆的定相（不能用随机数 —— 前缀稳定性会破）。不动的人 band=null
         → 不传 gait → 顶点与旧版逐字节一致。 */
      if (band != null) q.gait = band * Math.abs(q.off - doorLat) / SH.PAX_STEP + i * 0.31;
      /* ---- 街面：人行道上的行人与公交站等车的人 ----
         人行道带在"树线以外、楼线以内"（`streetBand` 从既有单点常量推，不抄数）。
         等车的人钉在最近的候车亭背后并**站着**（没有相位）；其余沿人行道走，
         相位 = 他站/走到这里已经走了多少米 ÷ 步长 —— 街上的人本来就在走，
         这与站台上"排队者不许迈腿"是两回事。 */
      if (q.onStreet) {
        const kw = rand01('stx' + seed, i), ks2 = rand01('sts' + seed, i);
        let sdz = q.dz + (ks2 - 0.5) * street.jitter;
        let so = street.lat0 + (street.lat1 - street.lat0) * kw;
        let atBus = false;
        if (rand01('stb' + seed, i) < street.busShare) {
          const per = street.bus.pitch, ph = street.bus.phase;
          const nb = ph + Math.round((sdz - ph) / per) * per;
          const bside = (Math.round((nb - ph) / per) % 2) ? 1 : -1;
          if (bside === side) { sdz = nb + (kw - 0.5) * 9; so = street.bus.shelterLat + 0.75 + ks2 * 1.6; atBus = true; }
        }
        const frS = al.frame(sdz);
        const yawS = atBus
          ? Math.atan2(side * frS.r[0], side * frS.r[2])
          : Math.atan2(frS.f[0] * (ks2 > 0.5 ? 1 : -1), frS.f[2] * (ks2 > 0.5 ? 1 : -1));
        const sq = Object.assign({}, q, {
          dy: street.dy(sdz) - 0.42, off: so, dz: sdz, yawJ: yawS,
          gait: atBus ? undefined : sdz / SH.PAX_STEP + i * 0.29,
        });
        WorldBuilder.person(b, al, frS, side * so, side, sq);
        /* 记录照抄交给渲染器的那一份（同一条纪律：在这里重算一遍，
           "画了迈步"与"登记为站着"就能同时成立 —— 负控 busstrut 第一版
           正是因为记录重算了才没报红）。 */
        if (info) info.push({ s: sdz, off: so, queuing: atBus, yaw: yawS, street: true, bus: atBus, gait: sq.gait == null ? null : sq.gait });
        continue;
      }
      /* ---- 站厅层的那一份：人站在板上，不是站在站台上 ----
         横向落在"闸机柜以外、箱涵壁以内"这条可行带；沿线路避开楼梯/扶梯洞口
         （洞口上站人 = 人悬在洞里）。朝向：多数面朝闸机线排队（与站台排队者
         同理，窄轴垂直于闸机线），少数顺着站厅走。站厅的人不编行走动画 ——
         他们没有自己的过程时钟，硬给相位就是假动。 */
      if (q.onHall) {
        const kk = rand01('hallx' + seed, i), ks = rand01('halls' + seed, i);
        let hoff = hall.lat0 + (hall.lat1 - hall.lat0) * kk;
        let hdz = q.dz + (ks - 0.5) * hall.jitter;
        for (const v of hall.voids) {
          if (Math.abs(hdz - v) < hall.vh) hdz = v + (hdz >= v ? hall.vh : -hall.vh);
        }
        const frH = al.frame(hdz);
        const queue2 = rand01('hallq' + seed, i) < 0.6;
        const yawH = queue2
          ? Math.atan2(-side * frH.r[0], -side * frH.r[2])
          : Math.atan2(frH.f[0], frH.f[2]) + (ks > 0.5 ? 0 : Math.PI);
        const hq = Object.assign({}, q, {
          dy: hall.y - 0.42, off: hoff, dz: hdz, yawJ: yawH + (ks - 0.5) * 0.4, gait: undefined,
        });
        WorldBuilder.person(b, al, frH, side * hoff, side, hq);
        /* 记录照抄交给渲染器的那一份（与步态同一条纪律）：band 也带出来，
           这样"有人从站厅登车"这种错会在记录上留痕，判据抓得到。 */
        if (info) info.push({ s: hdz, off: hoff, queuing: queue2, yaw: yawH, hall: true, gait: hq.gait == null ? null : hq.gait, band });
        continue;
      }
      WorldBuilder.person(b, al, q.fr, lat, side, q);
      /* 记录里读的是 `q.gait` —— 也就是**交给渲染器的那一份**，不是在这里
         按 band 重算一遍。重算会让"画了迈步"与"登记为站立"能同时成立
         （负控 gaitstand 第一版就是这么溜过去的）。 */
      if (info) info.push({ s: q.dz, off: Math.abs(lat), queuing: q.queuing, yaw: q.yawJ, band,
        gait: q.gait == null ? null : q.gait });
    }
    /* B4 下车人流：车门一开，车里的人**先出来** —— 第 j 个下车的人在开门后
       lag + j×3.4/rate 秒出现在门里（节奏 = 门的通过能力：flow() 的 off 侧
       不吃拥挤度慢化，下客速度就是 rate），沿站台走向**最近的出入口**，
       末段沿梯段上楼（地下站）/下楼（高架站）离场 —— 不是走到站台尽头
       凭空消失（那里既没有楼梯也没有出口）。总量 = 该站 OD 的下车需求
       （pax.visual）。候乘与到站时刻由真实客流模型给 —— 视觉层自己编一个
       下车人数，画面就会和 HUD/结算的"下 N 人"对不上。
       关门之后这个过程由 game.js 的 egress 继续推进（人不会瞬间撤下）。 */
    if (alight && alight.need > 0) {
      const nA = Math.min(110, Math.round(alight.need / 3.4));
      const lag = 0.8, walkV = 1.35;
      /* 出入口由调用方按 `SH.PLATFORM_EXITS` 给（站心 + 偏移，带升降方向）。
         缺省（不传 exits 的老调用路径）退回站台端头 —— 几何与旧版一致。 */
      const EX = (exits && exits.length) ? exits
        : [{ s: s0 + 8, up: 1 }, { s: s1 - 8, up: 1 }];
      /* **独立随机流**：候乘人数在停站期间一路变，若与候乘共用 R，
         每重建一次步行者出生的门位就跟着漂 —— 画面上是"下车的人原地抖"。 */
      const RW = rng((seed ^ 0x5bd1e995) >>> 0);
      for (let j = 0; j < nA; j++) {
        const tIn = lag + (j * 3.4) / Math.max(1, alight.rate || 1);
        const dzD = s0 + 6 + RW() * span;                  // 从哪扇门出来（与候乘同一分布）
        let ex = EX[0], bd = Math.abs(dzD - ex.s);
        for (const e of EX) { const d = Math.abs(dzD - e.s); if (d < bd) { bd = d; ex = e; } }
        const walkT = Math.max(1.2, bd / walkV);
        const raw = ((alight.dwell || 0) - tIn) / walkT;
        const h = 1.56 + RW() * 0.28, th = 0.40 + RW() * 0.06;
        const hue = hues[Math.floor(RW() * hues.length)];
        const face = RW() < 0.5 ? '#c8a486' : '#8a6a52';
        const hair = ['#191d21', '#23180f', '#3a2a17', '#101215', '#4a3421'][Math.floor(RW() * 5)];
        const pack = RW() > 0.72, phone = RW() > 0.55;
        const skirt = RW() > 0.62, longHair = RW() > 0.55, tote = !pack && RW() > 0.70;
        const off1 = platFront + 1.5 + RW() * 1.4;
        const yawJ = (RW() - 0.5) * 0.3;   // **恒抽**：分支里再抽会让后面的人换一套随机数
        if (raw <= 0 || raw >= 1) continue;    // 还没出门 / 已走完 —— 节奏判据量的是这个
        const dz = dzD + (ex.s - dzD) * raw;
        const frC = al.frame(dz);
        /* 先出门（横向从门线挪进走行带），再沿站台走 —— 一条斜线就够，
           站台机位与司机台读出来都是"有人下车、往出入口走" */
        let lat = side * (platFront + 0.55 + (off1 - platFront - 0.55) * Math.min(1, raw * 2.2));
        /* 末段（raw > EXIT_TURN）：拐向梯段口并沿楼梯升降 —— 人在**楼梯上**
           消失，而不是在站台端头凭空不见。横向挪到梯段口（第一级在 platFront+6.2，
           这里取 5.4 —— 停在梯口前一点），竖向 1.15 m × up（地下 +1 上楼 / 高架 −1 下楼）。 */
        let dy = 0;
        const EXIT_TURN = SH.EXIT_TURN;
        if (raw > EXIT_TURN) {
          const k = (raw - EXIT_TURN) / (1 - EXIT_TURN);
          const latX = side * (platFront + 5.4);
          lat = lat + (latX - lat) * k;
          /* `up` 为 0 是**有效值**（对向站台没有 modeled 梯段，人沿站台走向端头）：
             以前写 `ex.up || 1`，把显式的 0 也当成缺省的 +1 —— 没有楼梯的地方
             凭空把人抬上 1.15 m 再消失。缺省判定必须用 == null。 */
          dy = k * 1.15 * (ex.up == null ? 1 : ex.up);
        }
        const dir = ex.s > dzD ? 1 : -1;
        /* 末段朝向改为"朝梯段"（横向），否则人侧着身子爬楼梯 */
        const yaw = raw > EXIT_TURN
          ? Math.atan2(-side * frC.r[0], -side * frC.r[2]) + yawJ * 0.4
          : Math.atan2(frC.f[0] * dir, frC.f[2] * dir) + yawJ;
        /* 步行者的相位与"已经走了多远"同源：raw 是这条行程的比例，
           全程 = walkT × walkV 米。这样腿的摆动和脚下的位移对得上，
           而不是"人偶平移"。 */
        const gait = raw * walkT * walkV / SH.PAX_STEP;
        WorldBuilder.person(b, al, frC, lat, side,
          { h, th, hue, face, hair, pack, phone, lug: null, seat: false, yawJ: yaw, skirt, longHair, tote, dy, gait });
        if (info) info.push({ s: dz, off: Math.abs(lat), queuing: false, yaw, alight: true, p: raw, dy, ex: ex.s, from: dzD, gait });
      }
    }
    return n;
  }

  /**
   * 一个人 = 躯干 + 肩 + 头 + 发 + 两臂 + 腿（+背包/手机/拉杆箱/坐姿）。
   * 烘焙的候乘人群（crowdInto）与 B4 的下车步行者共用这一份 ——
   * 两份"人怎么画"就是第二个真值，症状是"下车的人长得跟候乘的不一样"。
   * `lat` 是**已乘 side** 的横向位置；脚底基准 `Y0 = 站台面 0.42 + q.dy`。
   * `q.dy`（可选）是竖向偏移 —— 下车人流末段沿楼梯上行/下行时用；
   * 不传时恒 0，烘焙路径的顶点逐字节不变。
   */
  static person(b, al, fr, lat, side, q) {
    /* 步态：`q.gait` 是**相位（单位：一步）**，由调用方按"已经走过的米数 ÷ 步长"
       给 —— 与位置同源，所以人往前走、腿跟着摆，不会出现"滑行的人偶"。
       腿一前一后、手臂反向摆、身体随支撑相起伏；不传 gait（候乘、坐着的、车内
       乘客）时所有摆动项恒 0，顶点与旧版逐字节一致 —— 烘焙人群的"前缀稳定"
       依赖这一点，所以这里一律不加随机数。 */
    const ph = (q.gait == null ? 0 : q.gait * Math.PI * 2);
    const sw = Math.sin(ph);
    const bob = q.gait == null ? 0 : 0.016 * q.h * Math.abs(Math.cos(ph));
    const Y0 = 0.42 + (q.dy || 0) + bob;
    const swing = q.gait == null ? 0 : 0.15 * q.h * sw;   // 脚尖前后摆幅
    const p = al.world(fr, lat, Y0 + q.h / 2);
    const c = rgbOf(q.hue);
    b.box([p[0], p[1], p[2]], [q.th, q.h * 0.62, q.th], c, { mat: 'paint', yaw: q.yawJ });
    b.box([p[0], p[1], p[2]], [q.th * 1.45, q.h * 0.58, q.th * 0.34], c, { mat: 'paint', yaw: q.yawJ });
    /* 脖子：头不再是直接"焊"在肩上的圆柱 —— 剪影里"有人形"的第四条证据 */
    const nk = al.world(fr, lat, Y0 + q.h * 0.815);
    b.box([nk[0], nk[1], nk[2]], [0.075, 0.07, 0.075], rgbOf(q.face), { mat: 'paint', yaw: q.yawJ });
    const hp = al.world(fr, lat, Y0 + q.h * 0.88);
    b.cylY([hp[0], hp[1], hp[2]], 0.105, 0.23, rgbOf(q.face), { mat: 'paint', seg: 8 });
    /* 头发：头顶一片薄盖，颜色与肤色/衣服区分 —— 剪影人群里"这是个人"
       的第三条证据（肩宽比、腿、发色） */
    const hr = al.world(fr, lat, Y0 + q.h * 0.955);
    b.box([hr[0], hr[1], hr[2]], [0.185, 0.05, 0.195], rgbOf(q.hair), { mat: 'paint', yaw: q.yawJ });
    if (q.longHair) {
      /* 长发：垂在后脑的一片 —— 与短发的剪影差异在 20 m 外就分得出来 */
      const lh = al.world(fr, lat, Y0 + q.h * 0.865);
      b.box([lh[0] - Math.sin(q.yawJ) * 0.095, lh[1], lh[2] - Math.cos(q.yawJ) * 0.095],
        [0.165, 0.19, 0.06], rgbOf(q.hair), { mat: 'paint', yaw: q.yawJ });
    }
    /* 手臂：垂在体侧的两根细盒，让肩宽有了"从肩到袖"的过渡 */
    for (const sg of [-1, 1]) {
      /* 手臂与同侧腿**反相**（人的自然对侧步），摆幅比腿小 */
      const af = -sg * swing * 0.65;
      const ap = al.world(fr, lat, Y0 + q.h * 0.50);
      const axx = ap[0] + Math.cos(q.yawJ) * sg * (q.th * 0.80) + Math.sin(q.yawJ) * af;
      const azz = ap[2] - Math.sin(q.yawJ) * sg * (q.th * 0.80) + Math.cos(q.yawJ) * af;
      b.box([axx, ap[1], azz], [0.075, q.h * 0.44, 0.075], c, { mat: 'paint', yaw: q.yawJ });
    }
    /* 腿：**两条分开的腿 + 一双鞋**。旧版是一块 0.30 m 宽的整板 —— 站台机位上
       所有人都是"圆锥"，迈步的下车步行者尤其穿帮。裙装变体（q.skirt）换成
       膝上一片裙摆 + 两截小腿，人群的轮廓从此不止一种。 */
    if (q.skirt) {
      const sk = al.world(fr, lat, Y0 + q.h * 0.245);
      b.box([sk[0], sk[1], sk[2]], [0.36, q.h * 0.29, 0.25], c, { mat: 'paint', yaw: q.yawJ });
      for (const sg of [-1, 1]) {
        const kf = sg * swing * 0.55;
        const bp2 = al.world(fr, lat, Y0 + q.h * 0.05);
        b.box([bp2[0] + Math.cos(q.yawJ) * sg * 0.085 + Math.sin(q.yawJ) * kf, bp2[1],
               bp2[2] - Math.sin(q.yawJ) * sg * 0.085 + Math.cos(q.yawJ) * kf],
          [0.10, q.h * 0.10, 0.13], rgbOf('#3a3230'), { mat: 'paint', yaw: q.yawJ });
      }
    } else {
      const lp = al.world(fr, lat, Y0 + q.h * 0.17);
      for (const sg of [-1, 1]) {
        const kf = sg * swing;
        b.box([lp[0] + Math.cos(q.yawJ) * sg * 0.085 + Math.sin(q.yawJ) * kf, lp[1],
               lp[2] - Math.sin(q.yawJ) * sg * 0.085 + Math.cos(q.yawJ) * kf],
          [0.115, q.h * 0.34, 0.16], rgbOf('#22282d'), { mat: 'paint', yaw: q.yawJ });
      }
    }
    for (const sg of [-1, 1]) {
      const ff = sg * swing + 0.03;
      const sp2 = al.world(fr, lat, Y0 + 0.028);
      b.box([sp2[0] + Math.cos(q.yawJ) * sg * 0.085 + Math.sin(q.yawJ) * ff, sp2[1],
             sp2[2] - Math.sin(q.yawJ) * sg * 0.085 + Math.cos(q.yawJ) * ff],
        [0.10, 0.055, 0.24], rgbOf('#161a1e'), { mat: 'paint', yaw: q.yawJ });
    }
    if (q.pack) {
      /* 背包：贴在"背后"。box 的窄轴（局部 z）是面朝的方向，背后 = 沿窄轴负向偏移 */
      const fwdx = Math.sin(q.yawJ), fwdz = Math.cos(q.yawJ);
      const bp = al.world(fr, lat, Y0 + q.h * 0.62);
      b.box([bp[0] - fwdx * 0.20, bp[1], bp[2] - fwdz * 0.20], [0.26, 0.34, 0.14],
        rgbOf('#3f4a52'), { mat: 'paint', yaw: q.yawJ });
    }
    if (q.phone) {
      /* 手机：举在胸前的一小片自发光 —— 夜里站台上星星点点的冷光，
         是"这条线活着"最不起眼也最有效的证据 */
      const fwdx = Math.sin(q.yawJ), fwdz = Math.cos(q.yawJ);
      const pp = al.world(fr, lat, Y0 + q.h * 0.60);
      b.box([pp[0] + fwdx * 0.16, pp[1], pp[2] + fwdz * 0.16], [0.085, 0.15, 0.012],
        rgbOf('#bcd7ea'), { mat: 'light', emi: 0.9, yaw: q.yawJ });
    }
    if (q.tote) {
      /* 手提袋：垂在手边的一小只 —— 不背包的通勤客的轮廓 */
      const tp = al.world(fr, lat, Y0 + q.h * 0.32);
      b.box([tp[0] + Math.cos(q.yawJ) * 0.24, tp[1], tp[2] - Math.sin(q.yawJ) * 0.24],
        [0.10, 0.26, 0.22], rgbOf('#5d4a33'), { mat: 'paint', yaw: q.yawJ });
    }
    if (q.lug) {                             // 拉杆箱：枢纽站特别多
      const bp = al.world(fr, lat + side * 0.42, Y0 + 0.29);
      b.box([bp[0], bp[1], bp[2]], [0.24, 0.58, 0.36], rgbOf(q.lug), { mat: 'paint', yaw: q.yawJ });
    }
    if (q.seat) {                            // 长椅上的候车人：真坐姿（D1）
      /* 坐姿 = 躯干竖直 + 大腿水平 + 小腿竖直。以前只是一个 0.42×0.50×0.30
         的盒子 —— 从站台看那是"一块布盖在长椅上"，不是"坐着一个人" */
      const sp = al.world(fr, lat + side * 1.4, Y0);
      b.box([sp[0], sp[1] + 0.72, sp[2]], [0.40, 0.52, 0.24], c, { mat: 'paint', yaw: q.yawJ });
      b.box([sp[0] + Math.sin(q.yawJ) * 0.14, sp[1] + 0.50, sp[2] + Math.cos(q.yawJ) * 0.14],
        [0.36, 0.10, 0.40], rgbOf('#262c31'), { mat: 'paint', yaw: q.yawJ });
      for (const sg of [-1, 1]) {
        const ax2 = sp[0] + Math.cos(q.yawJ) * sg * 0.12, az2 = sp[2] - Math.sin(q.yawJ) * sg * 0.12;
        b.box([ax2 + Math.sin(q.yawJ) * 0.28, sp[1] + 0.22, az2 + Math.cos(q.yawJ) * 0.28],
          [0.09, 0.44, 0.09], rgbOf('#22282d'), { mat: 'paint', yaw: q.yawJ });
      }
      b.cylY([sp[0], sp[1] + 1.10, sp[2]], 0.10, 0.22, rgbOf(q.face), { mat: 'paint', seg: 8 });
      b.box([sp[0], sp[1] + 1.16, sp[2]], [0.18, 0.05, 0.19], rgbOf(q.hair), { mat: 'paint', yaw: q.yawJ });
    }
  }

  /**
   * 站务员（第 105 条）：站台两端各一名，制服 + 帽 + 手里的信号旗。
   *
   * 为什么值得单独建：真实站台上最"像在运行"的两样东西，一是跳秒的倒计时屏
   * （第 94 条），二就是**站务员** —— 他站在那里本身就是"这条线有人在管"。
   * 而人群是剪影、颜色随机（深浅不一的深色外套），混在里面认不出来；
   * 站务员靠**制服色**（藏青）+ 帽 + 亮黄信号旗 三件区分，不靠数量。
   *
   * 与人群的关键区别：**站务员不进 `crowd` 批次**。人群会在开门期间被重建
   * （人数随乘降下降），站务员不会上车，所以必须烘在世界网格里 ——
   * 放进人群批次的话，车一到站站务员就跟着"上车"消失了。
   */
  static staffInto(b, al, side, s, info) {
    /* 站位取站台两端的稀疏区（人群集中在 s−144~s+36 的中段），
       一名朝向来车（接车），一名背向（送车）。 */
    for (const dz of [s - 72, s + 24]) {
      const fr = al.frame(dz);
      const off = STATION_X.front + 1.55;
      const h = 1.70;
      const yaw = Math.atan2(-side * fr.r[0], -side * fr.r[2]);
      const p = al.world(fr, side * off, 0.42);
      /* 身体：藏青制服（与人群的随机深色区分开） */
      b.box([p[0], p[1] + h * 0.50, p[2]], [0.42, h * 0.86, 0.42], rgbOf('#1d4a6b'), { mat: 'paint', yaw });
      /* 头 + 帽 */
      const hp = al.world(fr, side * off, 0.42 + h * 0.94);
      b.cylY([hp[0], hp[1], hp[2]], 0.105, 0.23, rgbOf('#c8a486'), { mat: 'paint', seg: 8 });
      const cp = al.world(fr, side * off, 0.42 + h * 1.07);
      b.box([cp[0], cp[1], cp[2]], [0.25, 0.09, 0.25], rgbOf('#12314a'), { mat: 'paint', yaw });
      /* 信号旗：亮黄，举在靠轨道那一侧 —— 站台机位与司机台都能一眼读到 */
      const fp = al.world(fr, side * (off - 0.52), 0.42 + h * 0.70);
      b.box([fp[0], fp[1], fp[2]], [0.05, 0.34, 0.30], rgbOf('#ffd23f'), { mat: 'paint', yaw });
      if (info) info.push({ s: dz, lat: side * off, dy: 0.42 + h * 0.5 });
    }
    return 2;
  }

  /**
   * 运行时重建**某一站**的人群（第 101 条）。只建人群，不建别的站台几何。
   *
   * 为什么需要它：人群是"这条线正在运行"最直接的证据 —— 车门一开，站台上的人
   * 走进车门消失、车里的人从门里出来。而人群原先烘在世界网格里，一帧不变。
   * 现在它单独成批（tag `'crowd'`），开门期间按客流模型的人数重建。
   *
   * `lg` 必须是烘焙那一份 LightGrid：重建的人群要被**同一份**站台灯照亮，
   * 否则它会从"站在灯下的乘客"退化成一片纯黑剪影。
   */
  static crowdStation(b, line, lg, i, waiting, info, alight) {
    const al = line.al, ss = al.stationS[i];
    if (ss == null) return 0;
    const side = line.stationSide(i);
    /* B 第 2 层：候乘人群站在**站体**那一侧 —— 岛式站即岛的两缘之间，
       带宽用 ISLAND_W；侧式与历史逐字一致。第 3 层再把对向候乘分到岛的两缘。 */
    const board = SH.boardSideAt(line, ss);
    const open = line.isElevated(ss);
    /* 没有灯光网格（离线判据只关心人数与站位）时不装钩子 —— 顶点按无人工光处理。 */
    if (lg) b.light(SH.WorldBuilder.lightFn(lg));
    /* 出入口（楼梯口）里程与升降方向：与 `station()` 的楼梯**同源**
       （`SH.PLATFORM_EXITS`）。地下站的楼梯是往上走到站厅（up=+1），
       高架站的楼梯是往下走到街面（up=−1）—— 下车人流的末段方向读它。 */
    const exits = SH.PLATFORM_EXITS.map(o => ({ s: ss + o, up: open ? -1 : 1 }));
    return SH.WorldBuilder.crowdInto(b, al, board, STATION_X.front, ss - 150, ss + 42,
      hash32(line.stations[i], 7), waiting, open ? STATION_X.rail - 0.45 : (SH.platType(line.stations[i]) === 'island' ? STATION_X.front + SH.ISLAND_W : 9.5), info, alight, exits,
      SH.WorldBuilder.hallBand(ss, open), SH.WorldBuilder.streetBand(al), SH.WorldBuilder.camSpot(ss));
  }

  /**
   * 对向站台的乘降可视化（诚实清单 §7.2）。
   *
   * 对向车（mirror 交路）在对面站台开门，它的下车人流必须走在**对向站台**上
   * —— 以前 onEgress 把对向车的下车过程也塞进本侧的 egress，画面上是
   * "对向车在对面关门，人却从本侧的车门里走出来"。
   *
   * 与 crowdStation 同一条 crowdInto 路径，只有三处不同：
   *   · side 取 −stationSide（对面那一侧）；
   *   · 没有候乘人群（对向候乘烘在静态世界里，见 farPlatform），只画下车人流；
   *   · 出入口退回**站台端头**（对向站台没有自己的楼扶梯几何，up=0：
   *     人沿站台走到端头离场，不假装那边有梯段）。
   * `info` 照抄交给渲染器的那一份（同一条登记纪律）。
   */
  static crowdStationFar(b, line, lg, i, alight, info) {
    const al = line.al, ss = al.stationS[i];
    if (ss == null) return 0;
    /* B 第 2 层：岛式站对向没有站台 —— 对向下车人流的物理呈现随 farPlatform
       一起关掉；这些人第 3 层分到岛的两缘（远端缘口对对向车）。 */
    if (SH.platType(line.stations[i]) === 'island') return 0;
    const side = -line.stationSide(i);
    const open = line.isElevated(ss);
    if (lg) b.light(SH.WorldBuilder.lightFn(lg));
    const exits = [{ s: ss - 142, up: 0 }, { s: ss + 34, up: 0 }];
    /* 横向基准与 `farPlatform` 同一份（`SH.farFrontOf` ← `SH.oppLatAt`）：对向下车的人
       必须走在那条板子上，而不是走在本侧镜像出来的位置 —— 那边根本没有股道。 */
    const FF = SH.farFrontOf(SH.oppLatAt(line, ss));
    return SH.WorldBuilder.crowdInto(b, al, side, FF, ss - 150, ss + 42,
      hash32(line.stations[i], 7) ^ 0x51ed27, 0,
      FF + (open ? STATION_X.rail - STATION_X.front : STATION_X.width),
      info, alight, exits, null, null);
  }

  /* --------------------------------------------------------- 城市与天际线 */
  /**
   * **走廊之外的远景楼群**（LOD 盒体城市）。
   *
   * 为什么必须有：跟随相机的远景地面是一张贴图，从驾驶室看出去没问题
   * （视线几乎平行地面），但观景机位在 90~130 m 高空斜看地标时，画面下半屏
   * 全是这块"航拍平原"——外滩、港区、跨江三张截图里，地标像贴在桌布上的
   * 模型，因为它周围真的没有任何体量。真实城市里 150 m 到 800 m 全是楼，
   * 天际线的"厚度"就是这么来的。
   *
   * **摆在世界坐标的方格里，不摆在轨道坐标系里。** 第一版是按"横向环带 +
   * 里程槽位"排的，test-land.js 立刻抓到 5 对互穿：横向 752 m 的环带在
   * 半径小于 752 m 的曲线上会**自己折回来**，两侧环带叠在一起。走廊楼群
   * 因为最远只到 88.8 m、而最小曲线半径几百米，所以从来没暴露这个问题。
   * 改成世界方格网之后，这类"沿程折叠"从结构上不可能发生，而且城市不再
   * 跟着地铁拐弯 —— 这本来就更像真实城市。
   *
   * 三条约束：
   *   · 距线路 **240 m** 以内不放（沿街楼群外缘 88.8 m + 一条真正的空带）。
   *     第一版从 150 m 起头，观景机位立刻被自己的远景楼挡住：上赛场机位
   *     边缘遮挡 10.5%、淀山湖水面从 14.3% 掉到 11.5%，都被 test-shot.js 拦下。
   *     150~240 m 这段本来就落在"相机与地标之间"，是视线的必经之路。
   *     240 m 之外还刻意放稀（`0.30 + 0.46t`），越远越密才堆得出天际线。
   *   · 格心抖动 ±12 m、边长 ≤34 m、格距 95 m ⇒ 最坏中心距 71 m > 两栋
   *     半对角线之和 48 m，按构造不重叠；footprint 仍登记进 `cityLots`
   *     让 test-land.js 的分离轴判据复核（**按真实半宽半进深登记**，
   *     填半对角线等于把地盘放大 √2 倍，会误报）。
   *   · 跨江/跨河点按**矩形**排除：水面横穿线路时沿程只有 ±340 m，
   *     横向却铺到 ±1200 m，只按里程挖会把江面上方一排楼照摆。
   */
  /**
   * **落地投影**（平面阴影，不是 shadow map）。全场景以前一个影子都没有，
   * 这是"看起来像玩具"最大的单一原因：桥墩、楼、树全都无影地立着。
   *
   * 黄昏太阳只抬高 6.3°，真实影长是楼高的 9 倍 —— 照实投会把整片地面糊成
   * 黑的。所以按 2.5 倍楼高截断，并沿影长方向铺 N 片同 footprint 的扁块，
   * 颜色从本影一路淡回地面底色，末端自己就消失，看不出被截过。
   * 方向写死取 `ENVS.dusk.sunDir` 的方位角（见文件头 SHADOW_DIR）：
   * 户外只跑 dusk 一套环境，烘焙几何与它不会分家。
   * @param tint 被照地面的底色（街面上的楼给沥青色，远景地上给航拍色）
   */
  _shadow(cx, cz, w, d, yaw, h, gy, tint, steps) {
    const N = steps || 4;
    const L = Math.min(2.5 * h, 95), step = L / N;
    const dx = SHADOW_DIR[0] * step, dz = SHADOW_DIR[1] * step;
    for (let i = 0; i < N; i++) {
      const k = 0.30 * (1 - i / N) * (1 - i / N) + 0.94;     // 本影 0.30 → 几乎回到底色
      this.b.box([cx + dx * (i + 0.5), gy, cz + dz * (i + 0.5)], [w, 0.02, d],
        [tint[0] * k, tint[1] * k, tint[2] * k], { mat: 'rubber', faces: [2], yaw });
    }
    return this;
  }

  farCity(s0, s1) {
    const al = this.cfg.al, B = CITY_BAND;
    const CELL = 95, JIT = 12, WMAX = 34, DMIN = 240, DMAX = 820, SKIRT = 6;
    const nA = valueNoise1D(4409), nB = valueNoise1D(9901);
    const mats = ['bldgWin', 'bldgWin2', 'bldgWin3'];
    const shades = ['#7d868f', '#8b9298', '#6e767e', '#959ba1'];
    /* 采样线路折线，用来算"这个格子离线路多近、在最近点的横向/沿程坐标" */
    const pts = [];
    for (let s = Math.max(0, s0 - DMAX); s <= Math.min(al.total, s1 + DMAX); s += 26) {
      const f = al.frame(s);
      pts.push({ x: f.p[0], z: f.p[2], s, rx: f.r[0], rz: f.r[2], fx: f.f[0], fz: f.f[2], f });
    }
    /* 水面的禁建矩形（沿程 / 横向），来自 cfg.waterRanges 的第三个分量 */
    const cuts = [];
    for (const r of (this.cfg.waterRanges || [])) {
      if (r[2] == null) continue;
      const mid = (r[0] + r[1]) / 2, f = al.frame(clamp(mid, 0, al.total));
      cuts.push({ x: f.p[0], z: f.p[2], rx: f.r[0], rz: f.r[2], fx: f.f[0], fz: f.f[2],
        along: (r[1] - r[0]) / 2 + 30, cross: r[2] });
    }
    /* **沿线路逐采样点扫自己两侧的环形格**，而不是扫整片包围盒：
       一条 30 km 的线包围盒能到 30 km × 30 km，按盒扫就是 11 万个格子。
       两遍走：第一遍只求"每个格子的最近线路点"（Map 里保留最小距离），
       第二遍再按最近点判横向带、摆楼。
       为什么必须先取最近点：如果"第一个看到该格子的采样点"就说了算，
       弯道**内侧**的格子会被一个沿程很远的采样点以 240 m 的斜距认领，
       而它离线路其实只有 100 m —— 实测这样会把 228 栋远景楼塞进沿街楼群里。 */
    const cand = new Map();
    for (const q of pts) {
      const i0 = Math.round((q.x - DMAX) / CELL), i1 = Math.round((q.x + DMAX) / CELL);
      const j0 = Math.round((q.z - DMAX) / CELL), j1 = Math.round((q.z + DMAX) / CELL);
      for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
        const r1 = nA(ci * 0.217 + cj * 0.911), r2 = nB(cj * 0.281 + ci * 0.733);
        const cx = ci * CELL + (r1 - 0.5) * 2 * JIT, cz = cj * CELL + (r2 - 0.5) * 2 * JIT;
        const dx = cx - q.x, dz = cz - q.z, d2 = dx * dx + dz * dz;
        if (d2 > DMAX * DMAX) continue;
        const key = ci + '_' + cj;
        const cur = cand.get(key);
        if (!cur || d2 < cur.d2) cand.set(key, { d2, q, cx, cz, r1, r2, key });
      }
    }
    const seen = this._farPlaced;
    for (const c of cand.values()) {
      const ci = Math.round(c.cx / CELL), cj = Math.round(c.cz / CELL);
      if (c.d2 < DMIN * DMIN || seen.has(c.key)) continue;
      seen.add(c.key);
      const q = c.q, cx = c.cx, cz = c.cz, r1 = c.r1, r2 = c.r2;
      const r3 = rand01('far' + ci + '_' + cj, 1);
      const ddx = cx - q.x, ddz = cz - q.z;
      const lat = Math.abs(ddx * q.rx + ddz * q.rz);
      if (lat < DMIN || lat > DMAX) continue;
        let inWater = false;
        for (const cw of cuts) {
          const ax = cx - cw.x, az = cz - cw.z;
          if (Math.abs(ax * cw.fx + az * cw.fz) <= cw.along && Math.abs(ax * cw.rx + az * cw.rz) <= cw.cross) { inWater = true; break; }
        }
        if (inWater) continue;
        let inLm = false;
        for (const nb of this.noBuild) {
          if (cx > nb.x0 - 30 && cx < nb.x1 + 30 && cz > nb.z0 - 30 && cz < nb.z1 + 30) { inLm = true; break; }
        }
        if (inLm) continue;                                   // 地标（江面/湖面/港区）里不长楼
        /* 越近越稀、越高越密：近处留出视线通道，远景才堆出天际线 */
        const t = (lat - DMIN) / (DMAX - DMIN);
        if (r3 < 0.30 + 0.46 * t) continue;
        const w = 16 + r1 * (WMAX - 16), d = 16 + r2 * (WMAX - 16);
        const h = (10 + 16 * t) + r3 * (14 + 34 * t);
        const yaw = Math.atan2(q.fx, q.fz);
        /* 位置就用**世界格心本身**，只有高程从最近里程点的轨面基准取。
           第一版写成 `al.ground(q.f, sgn*lat, …)`，那是"沿该点的右向走 lat 米"——
           于是所有以同一个采样点为最近的格子，沿程分量被丢掉、全部塌缩到
           同一条横向射线上，test-land.js 当场报 735 对互穿。 */
        /* 楼体往下扎 SKIRT 米。跟随相机的远景地面是一块**平面**，
           虽然它和这里都按 groundY 取基准，但地面平面取的是相机里程的
           groundY、楼取的是自己里程的 groundY，平滑窗口 ±600 m 之外仍会错开
           零点几米到几米。往下扎几米，无论平面在哪都穿过它 —— 既不飘也不留洞。
           （试过补一条烘焙外圈地面带，但比曲线半径还宽的平坦带会在弯道上
           自己折回来：test-wind 报 576 片绕序反向、test-wedge 报 93 块超大面片，
           收到 0.8 倍半径又窄到摆不下几栋楼，已删。） */
        const gy = al.groundY(q.s) + B.base;
        const mi = Math.floor(rand01('farmat' + ci + '_' + cj, 2) * mats.length);
        const shade = rgbOf(shades[Math.floor(r1 * shades.length) % shades.length]);
        const em = 0.26 + 0.36 * r3;
        /* 接触遮蔽用"下段整体压暗"来做，**不加宽、不另贴一块暗面**。
           先试的是楼脚暗带（比楼体宽 1.8 m）+ 一圈接触阴影（再宽 8 m），
           结果更糟：这块比地面暗得多的扁平矩形，在画面里读起来就是
           "每栋楼底下垫了一块漂浮板"。把这块远景地面隐藏后再看同一张图
           才确认：楼的基座本来就在地面以下（几何没问题），
           难看的是暗带本身。所以改成同一 footprint 的下 24% 压暗 ——
           真实街景里楼脚发黑本来就是环境遮蔽，不是地上多了一块影子。 */
        const hLow = Math.max(4, h * 0.24), hUp = h - hLow;
        this.b.box([cx, gy + (hLow - SKIRT) / 2, cz], [w, hLow + SKIRT, d],
          [shade[0] * 0.62, shade[1] * 0.62, shade[2] * 0.66],
          { mat: mats[mi], yaw, uv: SH.FACADE_UV, emi: em * 0.45 });
        this.b.box([cx, gy + hLow + hUp / 2, cz], [w, hUp, d], shade,
          { mat: mats[mi], yaw, uv: SH.FACADE_UV, emi: em });
        this.b.box([cx, gy + h + 0.5, cz], [w + 0.4, 1.0, d + 0.4], rgbOf('#6b7277'),
          { mat: 'roof', faces: [0, 1, 4, 5], yaw });
        /* 远景楼也要有投影。它们落在跟随相机的航拍地面上（groundY − 11.3），
           影子面取 −11.25 刚好压在它上面。 */
        this._shadow(cx, cz, w, d, yaw, h, al.groundY(q.s) + B.base - 0.25, rgbOf('#9aa4ae'));
        if (r3 > 0.955) {                                     // 塔冠 + 航空障碍灯
          this.b.box([cx, gy + h + 4.5, cz], [w * 0.26, 8, d * 0.26], rgbOf('#767d82'), { mat: 'metal', yaw });
          this.lg.add(cx, gy + h + 9.1, cz, [1, 0.25, 0.2], 5, 0.5);
        }
        const fl = { x: cx, z: cz, hw: w / 2, hd: d / 2, yaw, h, side: 0, dist: lat };
        if (!this._lotFits(fl)) continue;
        this.cityLots.push(fl);
    }
    return this;
  }

  /**
   * 高架两侧的城市。用里程分桶的伪随机决定每栋楼的位置/体量/贴图变体，
   * 所以同一区间每次烘焙结果完全一致。
   *
   * 楼群的横向占位和最大高度被抽成 SH.CITY_BAND，因为"观景相机摆在哪才
   * 不会被楼挡死"必须能被 test-facade.js 机器验证——把楼群参数散写在循环里，
   * 任何一次调优都可能悄悄让某个机位失效。
   */
  /**
   * 高架站出入口前的人行横道：斑马线 + 两道停止线。
   *
   * 为什么单独一个方法：站厅落在横向 32.75、人行道在 57~64，中间是一整幅车行道。
   * `station()` 已经铺了那条带路缘石的出站通道，但通道落在**没有斑马线的马路**上，
   * 行人机位里读起来仍然是"马路中间孤零零一间房子"。
   * 高程全部走 `STREET_Y`（与 city() 的街面同一个基），标线再抬 2~3 cm 防共面；
   * 每一片斑马线各自取自己里程的框，不出现世界轴字面量（曲线段才不会斜掉）。
   */
  crossing(dz, side) {
    const al = this.cfg.al;
    const g = al.streetDy(dz) + 0.03;
    const q = al.level(al.frame(dz));
    const yaw = Math.atan2(q.f[0], q.f[2]);
    for (let s = dz - 9; s <= dz + 9; s += 1.5) {
      const p = al.world(q, side * SH.JUNCTION.crossLat, al.streetDy(s) + 0.03);
      this.b.box([p[0], p[1], p[2]], [SH.JUNCTION.crossLen, 0.02, 0.45], rgbOf('#ccd3d7'),
        { mat: 'paint', faces: [2], yaw, emi: 0.10 });
    }
    for (const off of [-11.5, 11.5]) {
      const p = al.world(q, side * SH.JUNCTION.crossLat, g + 0.005);
      this.b.box([p[0], p[1], p[2]], [SH.JUNCTION.crossLen, 0.02, 0.30], rgbOf('#ccd3d7'),
        { mat: 'paint', faces: [2], yaw, emi: 0.10 });
    }
    return this;
  }

  /** 路口信号灯：灯杆 + 悬臂 + 灯箱 + 三枚深色镜片 + 两条停车线。
   *  亮着的那一枚**不在这里**画 —— 烘焙体不会变色，运行时由 street.js 按
   *  `SH.roadLamp` 在登记好的镜片位置上贴一盏自发光。
   *  坐标全部来自 `SH.signalHead`（与车流同一个函数），否则会出现
   *  "红灯亮在灯箱背面""车停在停车线后面三米"这类两边对不上的画面。 */
  trafficLight(j) {
    const al = this.cfg.al, J = SH.JUNCTION;
    for (const sgn of [-1, 1]) {
      const h = SH.signalHead(al, j, sgn);
      this._strut(h.foot, h.mast, 0.14, rgbOf('#4d545a'), { mat: 'metal' });
      this._strut(h.mast, h.head, 0.10, rgbOf('#4d545a'), { mat: 'metal' });
      this.b.box([h.head[0], h.head[1], h.head[2]], [0.32, 1.16, 0.36], rgbOf('#262c31'), { mat: 'metal', yaw: h.yaw });
      for (const lp of h.lens)
        this.b.box([lp[0], lp[1], lp[2]], [0.26, 0.26, 0.07], rgbOf('#171c20'), { mat: 'metal', yaw: h.yaw });
      /* 行人信号箱（§7.9）：与机动车灯共杆、箱面朝斑马线对面，竖排两枚暗镜片
         （上红下绿）。亮着的那枚不在这里画 —— 与机动车镜片同一套
         "暗体烘死、灯头运行时画"，坐标来自 SH.signalHead 的 pedBox/pedLens。 */
      this.b.box([h.pedBox[0], h.pedBox[1], h.pedBox[2]], [0.34, 0.56, 0.28], rgbOf('#262c31'), { mat: 'metal', yaw: h.yaw });
      for (const lp of h.pedLens)
        this.b.box([lp[0], lp[1], lp[2]], [0.16, 0.16, 0.06], rgbOf('#171c20'), { mat: 'metal', yaw: h.yaw });
      /* 停车线：横跨本方向那半幅车行道（中央分隔到外缘实线） */
      const q = al.level(al.frame(h.stopS));
      const sp = al.world(q, sgn * (SH.ROAD.median + SH.ROAD.edge) / 2, al.streetDy(h.stopS) + 0.03);
      this.b.box([sp[0], sp[1], sp[2]], [SH.ROAD.edge - SH.ROAD.median, 0.02, 0.42], rgbOf('#d3dade'),
        { mat: 'paint', faces: [2], yaw: Math.atan2(q.f[0], q.f[2]), emi: 0.10 });
      this.streetItems.push({ kind: 'roadSignal', s: j.s, i: j.i, side: sgn, head: h.head,
        lens: h.lens, stopS: h.stopS, y0: h.y0 });
    }
    return this;
  }

  city(s0, s1, seed, opt) {
    opt = opt || {};
    const al = this.cfg.al;
    const R = rng(seed >>> 0);
    const n1 = valueNoise1D(seed + 7), n2 = valueNoise1D(seed + 31);
    const mats = ['bldgWin', 'bldgWin2', 'bldgWin3'];
    const B = CITY_BAND;
    /* opt.noBuild：只铺街面断面，不放楼。高架**车站**下方要用 ——
       出入口的站厅在横向 32.75、梯段从 8.25 一路铺到 30.75，
       而最近那条楼车道在横向 28（半宽 7.5 + 基座 ⇒ 占到 22~34），
       楼一放就把刚盖好的楼梯和站厅整间埋掉。真实高架站也正是这样：
       站体正下方是疏开的路口与地面通道，两侧临街楼在更外面。 */
    let sCity = this._phaseTo(0, s0, x => this.zoneAt(x).gap);
    while (!opt.noBuild && sCity < s1) {
      const s = sCity;
      const Z = this.zoneAt(s);
      sCity += Z.gap;                                   // 梧桐街区 13 m 一格、郊野 34 m
      if (inAny(s, this.cfg.waterRanges)) continue;     // 江面上不长楼
      for (const side of [-1, 1]) {
        const k = Math.round(s / 17) * 8 + (side > 0 ? 3 : 0);
        const r1 = n1(k * 0.37), r2 = n2(k * 0.53), r3 = rand01('city' + k, side);
        if (r1 < 0.22) continue;                       // 空地/路口
        /* 景观视廊：侧景机位降到 40~80 m 之后，视线在横向 50~115 m 穿过楼群带，
           那一段该侧不放楼（SH.sightCorridors 按视线几何算出里程区间，
           game.js 与两个测试读同一份）。真实城市里这就是景观视廊/路口空地。 */
        const ms = s + (r2 - 0.5) * 3;
        const clr = this.cfg.sightClear;
        if (clr && clr.some(c => c.side === side && ms >= c.s0 && ms <= c.s1)) continue;
        /* 楼群按**三条车道式排布**，不是连续随机横向距离。
           连续随机 + 17 m 槽位会让相邻两栋在斜向错开时互相插进身体里
           ——test-land.js 的分离轴检查实测 4028 栋里有 167 对穿插，
           画面上就是斜视角下"扭成蝴蝶结的一栋楼"。
           排布现在按构造保证不重叠：
             横向  lane ∈ {71, 96} ± 1.5，半宽 ≤ 7.5 + 基座 0.8 → 相邻车道留 17.4 m
             纵向  槽位 17 ± 1.5，进深 ≤ 12 + 基座 1.6 → 前后留 1.4 m
           **最近一条在横向 69.5 m**：车行道到 ±55、人行道到 64、临街地块到 96，
           楼必须站在自己的地块上（这条以前是 28 m，楼直接长在马路中间）。
           只铺两条而不是三条：第三个机位体检（test-facade）实测 96~126 m 高的
           观景相机俯看地标时，视线要在横向 111~129 m 处穿过屋脊线（72 m），
           第三条车道正好落在那里 —— 三个机位直接看不见地标。 */
        const lane = CITY_BAND.lanes[Math.floor(rand01('lane' + k, side) * CITY_BAND.lanes.length)];
        const dist = lane.c + (r3 - 0.5) * 3;
        const w = 8 + r3 * 7, d = 8 + r1 * 4;
        /* 外侧那条压低：见 CITY_BAND.lanes 上面那段（限高表与通视判据同源）。 */
        const low = opt.low || !lane.hi;
        /* 楼高区间按街区类型（见 SH.SCENE_ZONES），但**靠相机那一侧的楼道
           夹回原来的天花板**：观景机位的通视带是按旧楼群分布标定的，
           近侧楼一超过 46 m，river / skyline 那两类机位就糊进街谷里
           （test-shot 实测：主体从 18.8% 掉到 15.6%、水面从 16% 掉到 12.8%）。
           街区性格于是主要靠外侧楼道、地块密度与行道树表达 —— 类型学要活在
           通视约束以内，不是把约束推翻。 */
        const hb = low ? Z.hLo : [Math.min(Z.hHi[0], B.hHi[0]), Math.min(Z.hHi[1], B.hHi[1])];
        const baseH = hb[0] + (low ? r2 : r1) * (hb[1] - hb[0]);
        /* 分区给的楼高再高也不许越过全局顶：观景机位的通视带是按
           `B.hHi[1] × hMul` 这条天花板算的，越过它，"从相机看见地标"就没了
           （test-shot 的 river / skyline 两个机位当场糊进街谷）。 */
        const h = Math.min(baseH * (0.7 + r3 * (B.hMul - 0.7)), B.hHi[1] * B.hMul);
        const fr = al.frame(s + (r2 - 0.5) * 3);
        /* 楼体绕 y 转到该里程的线路航向：local z 与"水平前向"重合，
           于是 size 的第三个分量就是真正的沿线路进深。 */
        const yaw = Math.atan2(fr.f[0], fr.f[2]);
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        /* 楼群、街面、绿化都走 al.ground / al.level：**地面不受轨道超高影响**。
           用 al.world 的话，横向 76 m 处会被 cant 抬/压 2.6 m，
           楼脚与街面错开、远处地标（900 m 外就是 31 m）直接被埋进地面底下。 */
        const p = al.ground(fr, side * dist, B.base + h / 2);
        /* 记录 footprint 给 test-land.js 做"楼不能互相插进身体"的断言。
           以前楼体是世界轴向的，槽位只有 17 m 而边长最大 24 m，
           曲线上相邻两栋必然重叠；画面上就是斜视角下"扭成蝴蝶结的一栋楼"。
           生成器自己记下摆了什么，比让测试去复现这套哈希序列可靠得多。 */
        const lot = { x: p[0], z: p[2], hw: w / 2, hd: d / 2, yaw, h, side, dist, s: ms };
        /* 登记 + 判交：撞了就放弃这栋楼。曲线段上相邻两栋的 yaw 不同，
           "三条车道 + 17 m 槽位"的构造保证在这里不成立 —— 实测换了一版线长之后
           test-land 抓到 3 对穿插。少一栋楼看不见，两栋长在一起看得见。 */
        if (!this._lotFits(lot)) continue;
        this.cityLots.push(lot);
        const mat = mats[Math.floor(r2 * 3) % 3];
        // 楼体基色压暗：黄昏里远处的楼是剪影，不是被照亮的白盒子。
        // 亮度交给窗的自发光去做，这样才有"万家灯火"的层次。
        const tint = 0.30 + r1 * 0.20;
        const col = [tint * (0.88 + r3 * 0.18), tint * (0.92 + r2 * 0.14), tint * (1.02 + r1 * 0.16)];
        this.b.box([p[0], p[1], p[2]], [w, h, d], col, {
          // UV 用 SH.FACADE_UV：一个贴图循环 = 12 m 真实墙面。
          // 之前是 1/3.2，一格窗只有 0.4 m，近看整面楼全是雪花。
          mat, uv: SH.FACADE_UV, faces: [0, 1, 4, 5], yaw,
          // 亮窗靠顶点自发光。之前给到 2.3+ 会把整面楼洗成白色，
          // 黄昏下正确的量级是"窗比墙亮一档"，不是"楼自己在发光"。
          emi: (r1 > 0.58 ? 0.80 + r3 * 0.55 : 0.10 + r2 * 0.16) * (this.cfg.night || 0.55),
        });
        /* 楼脚的暗带（plinth）：真实街景里楼与地面的交界是全世界最暗的一条，
           没有它，楼看起来就是"贴在背景上的一张立面"。加一圈比楼体略宽、
           比街面略高的深色基座，接触阴影立刻成立，代价是每栋一个盒子。 */
        const bp = al.ground(fr, side * dist, B.base + 1.1);
        this.b.box([bp[0], bp[1], bp[2]], [w + 1.6, 2.2, d + 1.6], rgbOf('#2b3035'), { mat: 'concreteD', faces: [0, 1, 4, 5, 2], yaw });
        /* ---- 底商：店招 + 雨棚 + 亮着的门面 ----
           临街第一排（近侧车道）才有店面，比例由分区给（`Z.shop`）：
           老城厢/淮海路几乎每间都铺，工业带几乎没有 —— 上海街景最强的性格
           差异恰恰在这一层：楼的**底下三米**决定这条街是什么。
           以前整排楼从街面到屋顶是同一张窗贴图，梧桐街区和新城区在立面上
           完全一样，"每站有特色"就只剩楼高不同。
           立面在楼体自己的坐标系里给横向偏移：local x 就是横向，
           所以朝街那一面在 |lat| = dist − w/2（不是世界轴向的加减）。 */
        const shopP = Z.shop;
        if (lane === CITY_BAND.lanes[0] && h > 6 && rand01('shop' + k, side) < shopP) {
          const fl = dist - w / 2;
          const SC = SHOP_C[Math.floor(rand01('shopc' + k, side) * SHOP_C.length)];
          const gw = al.ground(fr, side * (fl - 0.05), B.base + 1.35);
          this.b.box([gw[0], gw[1], gw[2]], [0.07, 2.5, d * 0.72], rgbOf('#20262c'),
            { mat: 'glassSoft', alpha: 0.6, faces: [0, 1], yaw, emi: 0.34 });
          const sb = al.ground(fr, side * (fl - 0.09), B.base + 3.30);
          const sc = rgbOf(SC[0]);
          this.b.box([sb[0], sb[1], sb[2]], [0.14, 0.85, d * 0.62], sc,
            { mat: 'emissive', faces: [0, 1], yaw, emi: 0.85 });
          /* 雨棚：出挑 1.4 m、微微落水（外侧低 0.12 m），色比店招浅一档 */
          const aw = al.ground(fr, side * (fl - 0.75), B.base + 2.62);
          const ac = rgbOf(SC[1]);
          this.b.box([aw[0], aw[1], aw[2]], [1.5, 0.10, d * 0.68], ac, { mat: 'paint', yaw });
          lot.shop = { fl, hz: 3.30, col: sc, s: ms };
        }
        // 屋顶设备与女儿墙
        const rp = al.ground(fr, side * dist, B.base + h);
        this.b.box([rp[0], rp[1] + 0.45, rp[2]], [w + 0.3, 0.9, d + 0.3], rgbOf('#6f767b'), { mat: 'roof', faces: [0, 1, 4, 5], yaw });
        // 屋顶机房：偏移量也要在楼体自己的坐标系里给，否则会跑到斜掉的楼角外
        const mx = w * 0.2, mz = -d * 0.15;
        if (r2 > 0.55) this.b.box([rp[0] + mx * cy + mz * sy, rp[1] + 1.6, rp[2] - mx * sy + mz * cy], [2.2, 2.4, 2.2], rgbOf('#5f666b'), { mat: 'metal' });
        this._zoneRoof(Z, rp, w, d, cy, sy, yaw, r1, r2);
        if (r3 > 0.86) {                                 // 高层塔冠
          this.b.box([rp[0], rp[1] + 4.5, rp[2]], [w * 0.28, 8, d * 0.28], rgbOf('#767d82'), { mat: 'metal', yaw });
          this.lg.add(rp[0], rp[1] + 9, rp[2], [1, 0.25, 0.2], 6, 0.5);
        }
        /* 落地投影。影子面刻意高出街面 0.28 m：再低就要和扫掠出来的路面
           z-fighting，再高就会在驾驶室视角里看出"影子浮着"。 */
        const shp = al.ground(fr, side * dist, B.base + 0.28);
        this._shadow(p[0], p[2], w + 1.6, d + 1.6, yaw, h, shp[1], rgbOf('#6d777f'));
      }
      /* 中低空档带（横向 118~132 m、高 ≤8 m）：走廊楼群（71/96 车道）与远景
         盒体城市（240 m 起）之间原来只有航拍贴图 —— 从 40~80 m 的观景机位
         （第 87 条降下来的）看过去是一圈平地，"城市"在那里断层。
         真实高架走廊两侧这一段是厂房/物流园/停车场：又低又稀。
         两条安全边：横向压在所有地标的最小 dist（158 m）以内，不跟地标抢地；
         高度压在 8 m 以下 —— 任何一条过了限高表的视线（≥46.5 m）都远在它上方，
         test-shot 的像素判据兜底。 */
      for (const side of [-1, 1]) {
        const k2 = Math.round(s / 17) * 8 + (side > 0 ? 3 : 0);
        if (rand01('midlo' + k2, side) < 0.52) continue;
        /* 视廊对空档带同样生效：8 m 的盒子挡不住视线，但"视廊里什么都不长"
           是一条更好维护的不变量（test-facade 直接数 cityLots）。 */
        const clr2 = this.cfg.sightClear;
        if (clr2 && clr2.some(c => c.side === side && s >= c.s0 && s <= c.s1)) continue;
        const lat2 = 118 + rand01('midlat' + k2, side) * 14;
        const w2 = 20 + rand01('midw' + k2, side) * 26;
        const d2 = 14 + rand01('midd' + k2, side) * 16;
        const h2 = 4 + rand01('midh' + k2, side) * 4;
        const fr2 = al.frame(s + (n2(k2 * 0.53) - 0.5) * 3);
        const p2 = al.ground(fr2, side * lat2, B.base + h2 / 2);
        const yaw2 = Math.atan2(fr2.f[0], fr2.f[2]);
        const sh2 = rgbOf('#878e94'), t2 = 0.86 + rand01('midt' + k2, side) * 0.22;
        this.b.box([p2[0], p2[1], p2[2]], [w2, h2, d2], [sh2[0] * t2, sh2[1] * t2, sh2[2] * t2], { mat: 'concrete', yaw: yaw2 });
        this.b.box([p2[0], p2[1] + h2 / 2 + 0.15, p2[2]], [w2 + 0.5, 0.3, d2 + 0.5], rgbOf('#5d646a'), { mat: 'roof', faces: [0, 1, 4, 5], yaw: yaw2 });
        const lot2 = { x: p2[0], z: p2[2], hw: w2 / 2, hd: d2 / 2, yaw: yaw2, h: h2, side, dist: lat2, s };
        if (!this._lotFits(lot2)) continue;
        this.cityLots.push(lot2);
      }
    }
    /* 街面：必须**沿中线扫掠**。用轴对齐大盒子会在曲线上露出边缘、
     * 看起来像一块斜插进画面的巨型板子。
     * 注意 flip：两点截面的默认绕序让正面朝下，会被背面剔除掉，
     * 于是地面整个消失、楼看起来悬在半空。
     *
     * 高度：高架线路的轨面在街面上方约 11 m（桥墩 9.5 m + 梁高）。
     * 这里以前把街面扫掠放在 y=0（=轨面），于是从车窗看出去"地面和轨面齐平"，
     * 整条高架看起来是修在平原上的一座堤，而不是穿过城市上空的桥；
     * 而楼的基座用的是 −11，两者差 11 m，楼脚就被地面齐根切掉。
     * 现在街面、绿化、楼的基座统一在轨面下 11 m。
     *
     * 跨江/跨河点（cfg.waterRanges）要把街面**挖断**：水面在街面下方，
     * 不挖断的话地面会把江整个盖住，看起来就是"列车在田里开"。
     */
    const half = 55;   // 半宽 55 m = 一条城市走廊。
    // 半宽 55 m = 一条城市走廊。再宽就会出现几百米一条边的大四边形，
    // 顶点插值（雾/光/贴图）在上面完全失真，画面上就是一张切过天空的膜。
    for (const [a, z] of subtractRanges(s0 - 120, s1 + 120, this.cfg.waterRanges)) {
      if (z - a < 12) continue;
      /* 街面、标线、绿化带都用 al.level() 的**水平地面系**：轨道超高只该抬起
         钢轨和桥面，不该把 110 m 宽的城市走廊斜着掀起来（横向 55 m 处能差 1.9 m，
         楼脚和街面就会错开）。 */
      const gp = al.frames(a, z, 26).map(f => { const q = al.level(f); const p = al.world(q, 0, al.streetDy(f.s)); return { p, r: q.r, u: q.u, f: q.f, s: q.s }; });
      if (gp.length < 2) continue;
      /* 走廊的横断面。以前只有一条 ±55 m 的平带，边缘直接切断：
         · 0.4~1.5 m 的高差在 50 m 外就是 19 像素，读起来是一道把整片地面
           切开的悬崖（17 号线追拍实测，楼群明明扎进地面却整排看着悬空）；
         · 更糟的是最外侧那条"车道"的楼占到横向 63.7~80.3 m，
           **本来就站在烘焙街面之外**，脚下只有那张跟随相机的航拍贴图。
         现在按真实城市断面对铺：车行道 → 排水沟 → 路缘石 → 人行道 → 临街地块，
         一路铺到横向 160 m，正好接上 240 m 起头的远景楼群，中间不再露出贴图。
         每段横向宽度都控制在几十米，避免"几百米一条边"的大四边形
         （雾/光/贴图在超大四边形上会失真）。
         2026-10-01 街面机位又翻出两条：① 原来的"放坡带"是 55→61 从 0 掉到 −1.6，
         而人行道带是 57→64 平在 +0.16 —— **两片在 57.6 处互相穿过**，
         人行道外缘是一圈悬空的薄边，路缘石根本不存在；② 车行道 ±55 m 是一整片
         同色沥青，从行人高度看出去像一片雪地，树和楼全飘在灰板上。
         所以这次把断面改成单调连续（相邻带共用同一个高程），并补路缘石与标线。 */
      const BANDS = [
        { a: -(half + 1.5), b: -half, ya: -0.06, yb: 0, mat: 'asphalt', col: '#4d5459', uv: 1 / 24 },
        { a: -half, b: half, ya: 0, yb: 0, mat: 'asphalt', col: '#4d5459', uv: 1 / 24 },
        { a: half, b: half + 1.5, ya: 0, yb: -0.06, mat: 'asphalt', col: '#4d5459', uv: 1 / 24 },
        { a: 57, b: 64, ya: 0.16, yb: 0.16, mat: 'granite', col: '#99a1a7', uv: 1 / 5 },
        { a: -64, b: -57, ya: 0.16, yb: 0.16, mat: 'granite', col: '#99a1a7', uv: 1 / 5 },
        { a: 64, b: 66.5, ya: 0.16, yb: 0.02, mat: 'concreteD', col: '#666f76', uv: 1 / 30 },
        { a: -66.5, b: -64, ya: 0.02, yb: 0.16, mat: 'concreteD', col: '#666f76', uv: 1 / 30 },
        { a: 66.5, b: 96, ya: 0.02, yb: 0.02, mat: 'concreteD', col: '#666f76', uv: 1 / 30 },
        { a: -96, b: -66.5, ya: 0.02, yb: 0.02, mat: 'concreteD', col: '#666f76', uv: 1 / 30 },
        { a: 96, b: 160, ya: -0.1, yb: -0.35, mat: 'foliage', col: '#4d6144', uv: 1 / 18 },
        { a: -160, b: -96, ya: -0.35, yb: -0.1, mat: 'foliage', col: '#4d6144', uv: 1 / 18 },
      ];
      /* 人行道铺装按街区类型换色（Z.pad）：把 gp 沿里程切成"同色的一段一段"再铺。
         整条走廊一种花岗岩灰，是"分区只进了楼高没进街面"的那种半成品。 */
      const PADB = BANDS.filter(b => b.mat === 'granite');
      const REST = BANDS.filter(b => b.mat !== 'granite');
      const sweepRun = (run, col) => {
        if (run.length < 2) return;
        for (const bd of PADB) {
          const span = Math.abs(bd.b - bd.a);
          this.b.sweep(run, [{ x: bd.a, y: bd.ya, nx: 0, ny: 1 }, { x: bd.b, y: bd.yb, nx: 0, ny: 1 }],
            { mat: bd.mat, color: rgbOf(col), closed: false, flip: true, uvAlong: bd.uv, vSpan: span * bd.uv });
        }
      };
      let run = [gp[0]], runPad = this.zoneAt(gp[0].s).pad;
      for (let i = 1; i < gp.length; i++) {
        const zp = this.zoneAt(gp[i].s).pad;
        if (zp !== runPad) { run.push(gp[i]); sweepRun(run, runPad); run = [gp[i]]; runPad = zp; }
        else run.push(gp[i]);
      }
      sweepRun(run, runPad);
      for (const bd of REST) {
        const span = Math.abs(bd.b - bd.a);
        this.b.sweep(gp, [{ x: bd.a, y: bd.ya, nx: 0, ny: 1 }, { x: bd.b, y: bd.yb, nx: 0, ny: 1 }],
          { mat: bd.mat, color: rgbOf(bd.col), closed: false, flip: true, uvAlong: bd.uv, vSpan: span * bd.uv });
      }
      /* 路缘石：0.5 m 宽、从排水沟底（−0.06）露到人行道面以上 0.04 的**闭合小方条**，
         沿 gp 扫过去。为什么不能只靠人行道那 0.16 m 的高差：单面片从侧面看是零厚度，
         行人的眼睛里"路沿"必须有一条自己的竖直棱。 */
      for (const sgn of [-1, 1]) {
        /* rectProfile 的点序约定是"顶边向右"（x0 < x1），miter 的外法向才成立；
           负侧必须把两个横坐标按大小排好再传，否则整条路缘石的绕序反过来，
           从街面看它就消失了。 */
        const c0 = sgn > 0 ? 56.5 : -57.0, c1 = sgn > 0 ? 57.0 : -56.5;
        this.b.sweep(gp, Geo.rectProfile(c0, -0.08, c1, 0.20),
          { mat: 'granite', color: rgbOf('#b6bec4'), closed: true, uvAlong: 1 / 2, vSpan: 0.5 / 2 });
      }
      /* ---- 车道标线：行人高度唯一的高对比度细节 ----
         中央那一幅本来就有绿化分隔带和它的两条边线，所以这里只补**车行道内部**
         的三条车道虚线 + 外缘实线。全部贴地 2~3 cm，走 al.level 的水平地面系
         （与街面同一个基，不受轨道超高影响）。虚线用 faces:[2] 的扁盒，
         一条 3 m、间距 9 m，一整段烘焙窗约 300 个盒子、600 个三角形 ——
         这是全场景性价比最高的一层细节。 */
      /* 相位必须钉在**绝对里程**上。以前这两个循环的起点是窗口的 a（虚线是 a+4、
         树是 a），而 a 是烘焙窗口被站界与视野钳过的位置 —— 车一动窗口就动，
         于是同一根灯杆、同一排树、同一条车道虚线每次重烘都挪几米：
         路面家具在眼前整体滑动，连按里程取种子的树形/缺株也跟着变。 */
      for (const lat of SH.ROAD.lines) {
        for (const sgn of [-1, 1]) {
          for (let s = Math.ceil(a / 9) * 9; s < z; s += 9) {
            const q = al.level(al.frame(clamp(s, 0, al.total)));
            const p = al.world(q, sgn * lat, al.streetDy(s) + 0.03);
            this.b.box([p[0], p[1], p[2]], [0.15, 0.02, 3.0], rgbOf('#c9d0d4'),
              { mat: 'paint', faces: [2], yaw: Math.atan2(q.f[0], q.f[2]) });
          }
        }
      }
      /* 车行道外缘白实线（非机动车道边线）—— 位置与 street.js 的车道中心同源
         （SH.ROAD.edge），否则"最外侧车道"会压在实线上。 */
      for (const sgn of [-1, 1]) {
        this.b.sweep(gp, [{ x: sgn * SH.ROAD.edge - 0.07, y: 0.025, nx: 0, ny: 1 }, { x: sgn * SH.ROAD.edge + 0.07, y: 0.025, nx: 0, ny: 1 }],
          { mat: 'paint', color: rgbOf('#c9d0d4'), closed: false, flip: true, uvAlong: 1 / 6, vSpan: 0.14 / 6, emi: 0.10 });
      }
      /* 行道树：间距 21 m。树要种在**靠路缘那一侧**（TREE_LAT），
         留出人行道内侧给人走 —— street 机位就站在那里。
         树形是"收分主干 + 两根主枝 + 四个叶团"：以前是单球插棍的棒棒糖，
         40 m 外还好，近景（街面机位、低角度观景机位）一眼就是玩具。
         叶团各带半档色差与逐树随机方位，冠形才不千篇一律；
         一棵约 300 面，比老树多花一倍半 —— 走廊视角里唯一能同时给出
         "人的尺度"和"连续阴影线"的东西，值这个钱。 */
      /* 行道树的间距、冠幅与树种按街区类型换档（SH.SCENE_ZONES）：
         梧桐街区 10 m 一棵大冠悬铃木、郊区新城 13 m 银杏、郊野 26 m 水杉。
         全上海一种树、一个间距，是"分区只进数据没进几何"的典型。 */
      const TREE_SP = [
        { col: ['#3f5d3a', '#4a6a41'], cr: 1.00, th: 1.00 },   // 0 悬铃木（法国梧桐）
        { col: ['#6f7a2f', '#8a8f45'], cr: 0.82, th: 1.18 },   // 1 银杏：窄而高，偏黄绿
        { col: ['#2f5237', '#3d6142'], cr: 0.96, th: 1.24 },   // 2 香樟：常绿浓密
        { col: ['#3f6350', '#4d7259'], cr: 0.60, th: 1.60 },   // 3 水杉：瘦高，滨水与郊野
      ];
      let sTree = this._phaseTo(0, a, x => this.zoneAt(x).pitch);
      while (sTree <= z) {
        const s = sTree;
        const TZ = this.zoneAt(s);
        sTree += TZ.pitch;
        const sp = TREE_SP[TZ.species % TREE_SP.length];
        const fr = al.frame(clamp(s, 0, al.total)), q = al.level(fr);
        const r1 = rand01('tree' + Math.round(s), 1);
        const nearExit = (opt.clearZones || []).some(zn => Math.abs(s - zn) < 26);
        for (const side of [-1, 1]) {
          if (nearExit) continue;                                          // 街面机位净空区
          if (rand01('treeX' + Math.round(s), side) < 0.16) continue;      // 缺株/路口
          const p0 = al.world(q, side * TREE_LAT, al.streetDy(s) + 0.16);
          const th = (3.1 + r1 * 1.6) * sp.th * (TZ.crown / 3.6);
          const cr = (2.0 + r1 * 1.1) * sp.cr * (TZ.crown / 3.6);
          const rC = rand01('treeCrown' + Math.round(s), side);
          /* 主干：三环收分（0.30→0.12），顶在冠高 78% 处 —— 上段让枝干接管 */
          const topY = p0[1] + th * 0.78;
          this.b.ringStack('paint', [
            { y: p0[1], rx: 0.30, rz: 0.30, cx: p0[0], cz: p0[2] },
            { y: p0[1] + th * 0.42, rx: 0.21, rz: 0.21, cx: p0[0], cz: p0[2] },
            { y: topY, rx: 0.12, rz: 0.12, cx: p0[0], cz: p0[2] },
          ], rgbOf('#41332a'), { seg: 6 });
          /* 两个侧叶团的心点：主枝从主干上段伸过去，叶团把枝头包住 */
          const A = rC * 6.283;
          const lobes = [
            { a: A,        off: cr * 0.72, y: th * 0.94, r: cr * 0.58 },
            { a: A + 2.60, off: cr * 0.66, y: th * 0.76, r: cr * 0.50 },
          ];
          for (const lb of lobes) {
            const cx2 = p0[0] + Math.cos(lb.a) * lb.off, cz2 = p0[2] + Math.sin(lb.a) * lb.off;
            const cy2 = p0[1] + lb.y;
            this._strut([p0[0], p0[1] + th * 0.55, p0[2]], [cx2, cy2, cz2], 0.09, rgbOf('#41332a'), { mat: 'paint' });
          }
          /* 叶团：主团压扁盖顶，两侧团包枝头，一团小冠封顶 —— 色差半档 */
          const gA = rgbOf(sp.col[0]), gB = rgbOf(sp.col[1]);
          this.b.sphere([p0[0], p0[1] + th + cr * 0.30, p0[2]], [cr, cr * 0.78, cr],
            { mat: 'foliage', color: gA, segU: 7, segV: 4 });
          for (let li = 0; li < lobes.length; li++) {
            const lb = lobes[li];
            this.b.sphere([p0[0] + Math.cos(lb.a) * lb.off, p0[1] + lb.y + lb.r * 0.35, p0[2] + Math.sin(lb.a) * lb.off],
              [lb.r, lb.r * 0.85, lb.r], { mat: 'foliage', color: li ? gB : gA, segU: 7, segV: 4 });
          }
          this.b.sphere([p0[0] + Math.cos(A + 1.2) * cr * 0.15, p0[1] + th + cr * 0.82, p0[2] + Math.sin(A + 1.2) * cr * 0.15],
            [cr * 0.46, cr * 0.40, cr * 0.46], { mat: 'foliage', color: gB, segU: 7, segV: 4 });
          /* 树穴：人行道砖里扣出一方土。没有它，树像是"插在混凝土里的玩具"；
             有了它，行人高度那条地面线才看得出这棵树是**种在地里的**。
             刻意压到铺装面以下 5 cm，免得与扫掠出来的花岗岩带 z-fighting。 */
          this.b.box([p0[0], p0[1] - 0.10, p0[2]], [1.8, 0.10, 1.8], rgbOf('#4b4232'),
            { mat: 'foliage', faces: [2], yaw: Math.atan2(q.f[0], q.f[2]) });
          this.streetItems.push({ kind: 'pit', s, side, zone: TZ.key, p: p0 });
          /* 树影只铺两段：树冠才 3~4 m，四段就是浪费面数 */
          this._shadow(p0[0], p0[2], cr * 1.8, cr * 1.8, 0, th + cr * 0.5, p0[1] + 0.07,
            rgbOf('#99a1a7'), 2);
        }
      }
      /* ---- 路灯：杆高 / 挑臂 / 灯头数 / 间距全部按分区换 ----
         原租界是铸铁弯臂灯（8 m 杆、1.5 m 单挑臂、30 m 一盏）；枢纽与工业带是
         高杆双挑（12~14 m、3 个灯头、38~45 m 一盏）；老城厢 6.2 m 矮弯臂、24 m
         一盏；郊野只剩 6 m 庭园矮杆、55 m 一盏。
         这一层以前**整条走廊一根灯杆都没有**（grep 街面断面：只有公交站亭）。
         灯头走 emissive 加算，不点真光源 —— 一条街几百盏灯全进光照列表会把
         整个烘焙压垮（换乘通道那一次 126.1 → 47 的实测就是同一族的教训）。
         相位与树、虚线同规矩：钉**绝对里程**，交错侧用"整米奇偶"决定，
         重烘窗口一挪也不会整体滑动。 */
      let sLamp = this._phaseTo(0, a, x => this.zoneAt(x).lamp.gap);
      while (sLamp <= z) {
        const s = sLamp, TZ = this.zoneAt(s);
        sLamp += TZ.lamp.gap;
        if ((opt.clearZones || []).some(zn => Math.abs(s - zn) < 20)) continue;   // 街面机位净空
        const fr = al.frame(clamp(s, 0, al.total)), q = al.level(fr);
        const y0 = al.streetDy(s), gY = Math.atan2(q.f[0], q.f[2]);
        const L = TZ.lamp, side = (Math.round(s) % 2) ? 1 : -1;
        const at = (lat, y) => al.world(q, side * lat, y);
        const LC = rgbOf(TZ.lamp.st === 0 ? '#3d4348' : '#5f686e');   // 老灯杆是深色铸铁
        const pl = at(LAMP_LAT, y0 + 0.36);
        this.b.box([pl[0], pl[1], pl[2]], [0.42, 0.5, 0.42], rgbOf('#4a5157'), { mat: 'concreteD', yaw: gY });
        const top = at(LAMP_LAT, y0 + L.h);
        this._strut(pl, top, L.st === 3 ? 0.075 : L.st === 2 ? 0.16 : 0.115, LC, { mat: 'metal' });
        const H = SH.LAMP_FORMS[L.st], heads = [];
        if (L.st === 0) {
          /* 弯臂：鹅颈先起拱再悬到人行道外侧（灯要照人行道上的人，不是照墙） */
          const mid = at(LAMP_LAT - L.arm * 0.30, y0 + L.h + 0.55);
          heads.push(at(LAMP_LAT - L.arm, y0 + L.h + 0.16));
          this._strut(top, mid, 0.075, LC, { mat: 'metal' });
          this._strut(mid, heads[0], 0.065, LC, { mat: 'metal' });
        } else if (L.st === 1) {
          heads.push(at(LAMP_LAT - L.arm, y0 + L.h - 0.06));
          this._strut(top, heads[0], 0.075, LC, { mat: 'metal' });
        } else if (L.st === 2) {
          heads.push(at(LAMP_LAT - L.arm, y0 + L.h));
          heads.push(at(LAMP_LAT + L.arm * 0.8, y0 + L.h));
          heads.push(at(LAMP_LAT, y0 + L.h + 0.55));
          this._strut(heads[0], heads[1], 0.10, LC, { mat: 'metal' });
          this._strut(top, heads[2], 0.11, LC, { mat: 'metal' });
        } else {
          heads.push(at(LAMP_LAT, y0 + L.h + 0.30));
        }
        for (const hp of heads) {
          this.b.box([hp[0], hp[1], hp[2]], [0.22, 0.20, H.deck * 2.4], rgbOf('#6f777d'), { mat: 'metal', yaw: gY });
          /* 灯罩下表面才是发光面：faces:[3] = −y 那一面（顶面给街面打光会糊成一片白） */
          this.b.box([hp[0], hp[1] - 0.14, hp[2]], [0.16, 0.05, H.deck * 2.0],
            rgbOf('#fff0cc'), { mat: 'emissive', faces: [3], emi: 0.95 });
        }
        this.streetItems.push({ kind: 'lamp', s, side, zone: TZ.key, st: L.st, h: L.h,
          arm: L.arm, heads: heads.length, deck: H.deck, base: pl, top, y0,
          hp: heads.map(p => [p[0], p[1], p[2]]) });
      }
      /* ---- 地块界街具：围墙 / 护栏 / 绿篱，型式按分区（SH.WALL_FORMS）----
         梧桐街区 = 矮墙 + 铁栅（1.38 m，透空，院子看得见）；
         里弄/老城厢 = 2.1 m 砖墙 + 门柱 + **30 m 一个弄口**（里弄的口就在路上）；
         林荫大道/大学园区 = 绿篱 + 12 m 一根矮柱（单位大院的边界是"看不进的绿"）；
         滨水/枢纽/新城 = 1.08 m 金属护栏；工业带 = 2.2 m 铁丝围栏（四道弦 + 5 m 立柱）；
         郊野 = 什么都不立，地里本来就没有墙。
         断面是**沿里程扫掠的闭合小方条**（与路缘石同一配方，绕序由 rectProfile 保证），
         分段时把弄口/门洞真的**挖断**，不是贴一根"门柱"骗过去。 */
      const segF = (sA, sB, step) => al.frames(sA, sB, step).map(f => {
        const q2 = al.level(f);
        return { p: al.world(q2, 0, al.streetDy(q2.s)), r: q2.r, u: q2.u, f: q2.f, s: q2.s, q: q2 };
      });
      const wallRun = (run, type, sgn) => {
        if (run.length < 2 || type === 'none') return;
        const WF = SH.WALL_FORMS[type], yb = 0.02, wt = 0.24;
        const L0 = WALL_LAT - wt, L1 = WALL_LAT + wt;
        /* 负侧的横坐标要按大小排好再交给 rectProfile（与路缘石同一条规矩） */
        const rp = (x0, x1, ya, yb2) => Geo.rectProfile(sgn > 0 ? x0 : -x1, ya, sgn > 0 ? x1 : -x0, yb2);
        const span = (fr2, x0, x1, ya, yb2, mat, col) => {
          if (fr2.length < 2) return;
          this.b.sweep(fr2, rp(x0, x1, ya, yb2), { mat, color: col, closed: true,
            uvAlong: 1 / 3, vSpan: (x1 - x0 + yb2 - ya) / 3 });
        };
        const sA = run[0].s, sB = run[run.length - 1].s;
        const G = WF.gate, U = WF.unit, HALF = G ? 2.2 : 0;
        /* 竖杆/立柱/矮柱的相位同样钉在**绝对里程**上：拿扫掠段的起点当起点，
           烘焙窗口一挪整排柱子就整体平移（树、虚线、灯杆都栽过这个坑）。 */
        const unitAt = (c, lat, yc, hw, hh, mat, col) => {
          const f3 = al.frame(clamp(c, 0, al.total)), q3 = al.level(f3);
          const p = al.world(q3, sgn * lat, al.streetDy(c) + yc);
          this.b.box([p[0], p[1], p[2]], [hw * 2, hh, hw * 2], col,
            { mat, yaw: Math.atan2(q3.f[0], q3.f[2]) });
        };
        const gates = [];
        if (G) for (let c = this._phaseTo(0, sA, () => G); c <= sB + G; c += G) gates.push(c);
        const WALLC = rgbOf(type === 'brick' ? '#9d8a70' : type === 'garden' ? '#8c8578' : '#7d868c');
        const MET = rgbOf('#4e565c');
        let segN = 0;
        for (let k = 0; k <= gates.length; k++) {
          const from = k === 0 ? sA : gates[k - 1] + HALF;
          const to = k === gates.length ? sB : gates[k] - HALF;
          if (to - from < 1.2) continue;
          const fr2 = segF(from, to, 13);
          segN++;
          if (type === 'garden') {
            span(fr2, L0, L1, yb, yb + 0.62, 'brick', WALLC);
            span(fr2, L0 - 0.07, L1 + 0.07, yb + 0.62, yb + 0.70, 'granite', rgbOf('#b6bec4'));
            span(fr2, WALL_LAT - 0.05, WALL_LAT + 0.05, yb + 1.30, yb + 1.38, 'metal', MET);
          } else if (type === 'brick') {
            span(fr2, L0, L1, yb, yb + WF.h, 'brick', WALLC);
            span(fr2, L0 - 0.08, L1 + 0.08, yb + WF.h, yb + WF.h + 0.10, 'granite', rgbOf('#a89f92'));
          } else if (type === 'hedge') {
            span(fr2, L0 - 0.12, L1 + 0.12, yb, yb + WF.h, 'foliage', rgbOf('#3f5a42'));
          } else if (type === 'rail') {
            span(fr2, WALL_LAT - 0.05, WALL_LAT + 0.05, yb + 0.50, yb + 0.60, 'metal', MET);
            span(fr2, WALL_LAT - 0.05, WALL_LAT + 0.05, yb + WF.h - 0.12, yb + WF.h, 'metal', MET);
          } else if (type === 'fence') {
            for (const yy of [0.42, 0.95, 1.50, WF.h - 0.15]) {
              span(fr2, WALL_LAT - 0.03, WALL_LAT + 0.03, yb + yy, yb + yy + 0.05, 'metal', MET);
            }
          }
        }
        let unitN = 0;
        if (U) for (let c = this._phaseTo(0, sA, () => U); c <= sB; c += U) {
          unitN++;
          if (type === 'garden') unitAt(c, WALL_LAT, yb + 1.00, 0.045, 0.60, 'metal', MET);
          else if (type === 'hedge') unitAt(c, WALL_LAT, yb + 0.68, 0.24, 1.36, 'concreteD', rgbOf('#8b8f92'));
          else if (type === 'rail') unitAt(c, WALL_LAT, yb + WF.h / 2, 0.055, WF.h, 'metal', MET);
          else if (type === 'fence') unitAt(c, WALL_LAT, yb + WF.h / 2, 0.07, WF.h, 'metal', MET);
        }
        /* 里弄口：门柱立在洞口两侧，过梁跨在洞口上，洞口里铺一块通向院子的地面。
           墙体在洞口水在这里**真的断开**（上面的分段扫掠），不是贴两根柱子骗过去 ——
           判据量的就是"洞口那段墙上有没有砖墙顶点"。 */
        if (type === 'brick') for (const c of gates) {
          for (const o of [-HALF, HALF]) {
            unitAt(c + o, WALL_LAT, yb + 1.30, 0.43, 2.60, 'brick', rgbOf('#8f7f68'));
          }
          const f3 = al.frame(clamp(c, 0, al.total)), q3 = al.level(f3);
          const lm = al.world(q3, sgn * WALL_LAT, al.streetDy(c) + yb + WF.h + 0.34);
          this.b.box([lm[0], lm[1], lm[2]], [0.56, 0.50, 2 * HALF + 0.6], rgbOf('#8a8074'),
            { mat: 'brick', yaw: Math.atan2(q3.f[0], q3.f[2]) });
          span(segF(c - HALF, c + HALF, 4), WALL_LAT - 3.0, WALL_LAT + 3.4,
            yb - 0.01, yb + 0.02, 'granite', rgbOf('#9a9c9e'));
        }
        this.streetItems.push({ kind: 'wall', s0: sA, s1: sB, side: sgn, type,
          zone: this.zoneAt((sA + sB) / 2).key, h: WF.h, see: WF.see, lat: WALL_LAT,
          gates: gates.length, segN, unitN, y0: al.streetDy((sA + sB) / 2) });
      };
      let wr = [gp[0]], wType = this.zoneAt(gp[0].s).wall;
      const flushWall = () => { wallRun(wr, wType, -1); wallRun(wr, wType, 1); };
      for (let i = 1; i < gp.length; i++) {
        const t = this.zoneAt(gp[i].s).wall;
        if (t !== wType) { flushWall(); wr = [gp[i]]; wType = t; }
        else wr.push(gp[i]);
      }
      flushWall();
      /* ---- 高架快速路（分幅箱梁 + 墩 + 端头落地）----
         上海的高架从来不只一条：地铁 3/4 号线沿着延安西路高架走，1 号线沿线是
         中山北路，3 号线北段是逸仙路 —— "高架旁边还有一条高架，而且上面在跑车"
         是这条走廊最该有、以前却完全没有的一层。
         位置在横向 168 m：街面走廊到 160、中低空档带在 118~132、远景盒体城市
         从 240 起头，这一段本来就是空的；桥面只在街面上方 9 m（=轨面以下 2.9 m），
         压在所有观景机位通视带的下方，不跟地标抢视线（test-shot/test-facade 兜底）。
         哪一侧由**站表**定（同一侧全线一致，重烘不翻边）；哪些站有由分区定
         （`SH.SCENE_ZONES.elev`），端头 60 m 线性落地成匝道。 */
      {
        const E = SH.ELEV_WAY;
        const eSide = SH.elevSide(this.cfg.stations);
        /* 观景机位的通视优先于高架快速路：`cfg.sightClear` 是按"视线穿过楼群带
           (50~125 m)"算出的里程区间，桥带在更外面（横向 ~210 m），视线穿过它的
           里程就在同一侧再往后一点 —— 所以整条区间两侧各放 400 m 余量。
           这不是拍脑袋：test-shot 的 l16 skyline 实测"边缘遮挡 12.0%"就是桥带
           横在视线近端；250 m 余量压到 10.5%（判据线 11%）太贴，400 m 才留得住。
           判据兜底：test-shot 逐机位量像素。 */
        const clrE = (this.cfg.sightClear || []).filter(c => c.side === eSide);
        /* 跨水的街面被 waterRanges 挖断，桥带跟着断 —— 与地面道路同一口径
           （真实高架过江是桥，但这个世界里过江处两侧本来就没有街面）。
           关键是**几何与车流必须同时断**：只断几何会让车悬在江面上 9 m。 */
        const ev = SH.elevFor(al, this.cfg.stations,
          clrE.map(c => [c.s0 - 400, c.s1 + 400])
            .concat((this.cfg.waterRanges || []).map(w => [w[0] - 24, w[1] + 24])));
        const elevBlocked = s => ev.blocked(s);
        const CW = [-E.gap / 2 - E.cw / 2, E.gap / 2 + E.cw / 2];   // 两幅各自相对中心的偏移
        for (const g of ev.segs) {
          /* 先按 25 m 一档切掉被视廊挡住的里程，剩下的连续段才建桥 */
          const pieces = [];
          let cur = null;
          for (let s = Math.max(a, g[0]); s <= Math.min(z, g[1]); s += 25) {
            if (elevBlocked(s)) { if (cur) { pieces.push(cur); cur = null; } continue; }
            if (!cur) cur = [s, s]; else cur[1] = s;
          }
          if (cur) pieces.push(cur);
          for (const pc of pieces) {
          const a0 = pc[0], a1 = pc[1];
          if (a1 - a0 < 20) continue;
          const fr = al.frames(a0, a1, 26).map(f => {
            const q2 = al.level(f), s2 = q2.s;
            return { q: q2, s: s2, h: ev.h(s2), g: ev.grade(s2), foot: 0 };
          });
          for (let ci = 0; ci < 2; ci++) {
            const cl = eSide * (E.lat + CW[ci]);
            /* 落地段：桥面**一边降高一边横向挪**到桥下地面幅那条上
               （`ev.foot` 与 street.js 摆车用同一个函数 —— 车不会开出桥面，
               桥面也不会停在半空）。坡上的断面还要跟着坡度转
               （`SH.pitchBasis`）：不转的话 26 m 一档的水平板叠起来是**台阶**，
               5.5% 的坡照样读得出锯齿，而车是连续跟坡的，两边就对不上了。 */
            const deck = fr.map(f => {
              const bf = SH.pitchBasis(f.q.r, f.q.u, f.q.f, f.g);
              return {
                p: al.world(f.q, cl + ev.foot(f.s, cl), al.streetDy(f.s) + f.h + 0.02),
                r: f.q.r, u: bf[0], f: bf[1], s: f.s,
              };
            });
            /* 箱梁：底板在桥面下 1.6 m，翼缘宽 = 桥面宽 */
            this.b.sweep(deck, Geo.rectProfile(-E.cw / 2, -E.thick, E.cw / 2, 0),
              { mat: 'concrete', color: rgbOf('#8d949a'), closed: true, uvAlong: 1 / 12, vSpan: (E.cw + E.thick) / 12 });
            /* 防撞墙：两侧各一道 1.1 m 高的连续小方条（高架一眼可辨的轮廓线） */
            for (const sg of [-1, 1]) {
              this.b.sweep(deck, Geo.rectProfile(sg > 0 ? E.cw / 2 - 0.38 : -E.cw / 2, 0,
                sg > 0 ? E.cw / 2 : -E.cw / 2 + 0.38, 1.10),
                { mat: 'concreteD', color: rgbOf('#b9c0c4'), closed: true, uvAlong: 1 / 6, vSpan: 1.5 / 6 });
            }
            /* 车道线：幅内两条车道之间一条虚线（与地面同一套 3 m/9 m 规矩）。
               坡道上抬 12 cm：虚线盒子是水平的，而桥面在 3 m 长里掉了 16 cm，
               贴 5 cm 摆就会一半埋进沥青。 */
            for (let s = Math.ceil(a0 / 9) * 9; s < a1; s += 9) {
              const f2 = fr[Math.min(fr.length - 1, Math.max(0, Math.round((s - a0) / 26)))];
              const p = al.world(f2.q, cl + ev.foot(f2.s, cl),
                al.streetDy(f2.s) + f2.h + (Math.abs(f2.g) > 1e-4 ? 0.12 : 0.05));
              this.b.box([p[0], p[1], p[2]], [0.14, 0.02, 3.0], rgbOf('#d6dce0'),
                { mat: 'paint', faces: [2], yaw: Math.atan2(f2.q.f[0], f2.q.f[2]) });
            }
          }
          /* 分幅之间的中央分隔带（两条高架中间那条缝）—— 只在**等高段**建：
             落地匝道是往两侧分头落地的，中间那条缝到了坡上就成了一个越来越宽的
             喇叭口，而 `rectProfile` 的宽度是整条扫掠共用的，没法逐点张开。
             真实高架的落地段也正是两幅各自落地、中间留给地面道路。 */
          const flatFr = fr.filter(f => f.h >= E.h - 0.001);
          if (flatFr.length > 1) {
            const mid = flatFr.map(f => {
              const bf = SH.pitchBasis(f.q.r, f.q.u, f.q.f, f.g);
              return {
                p: al.world(f.q, eSide * E.lat, al.streetDy(f.s) + f.h + 0.02), r: f.q.r, u: bf[0], f: bf[1], s: f.s,
              };
            });
            this.b.sweep(mid, Geo.rectProfile(-0.55, -E.thick, 0.55, 0.55),
              { mat: 'concrete', color: rgbOf('#9aa1a6'), closed: true, uvAlong: 1 / 4, vSpan: 1.65 / 4 });
          }
          /* 桥墩：绝对里程每 30 m 一墩。门槛 5.0 m（原来是 3.5）——
             落地段的桥面在往两侧挪，双柱却不跟着挪（墩在桥面中心线上），
             坡太矮时柱头就伸出板外；同时这段正是**桥下地面幅**要过去的地方，
             立柱戳在行车道里是不成立的。剩下的坡段由落地短跨承担，画面上
             读作"匝道直接落到地面上"，与真实高架一致。
             墩柱 + 盖梁，两幅各一套；落在地标占位区里的直接跳过。 */
          let pierN = 0;
          for (let s = this._phaseTo(0, a0, () => E.pier); s <= a1; s += E.pier) {
            const h = ev.h(s);
            if (h < 5.0) continue;
            const f3 = al.frame(clamp(s, 0, al.total)), q3 = al.level(f3), y0 = al.streetDy(s);
            for (const cl of [eSide * (E.lat + CW[0]), eSide * (E.lat + CW[1])]) {
              const foot = al.world(q3, cl, y0);
              const bx = foot[0], bz = foot[2];
              let hit = false;
              for (const nb of this.noBuild) {
                if (bx > nb.x0 - 6 && bx < nb.x1 + 6 && bz > nb.z0 - 6 && bz < nb.z1 + 6) { hit = true; break; }
              }
              if (hit) continue;
              const gY = Math.atan2(q3.f[0], q3.f[2]);
              const cp = al.world(q3, cl, y0 + h - E.thick - 0.55);
              this.b.box([cp[0], cp[1], cp[2]], [E.cw + 1.0, 1.1, 2.0], rgbOf('#98a0a5'), { mat: 'concrete', yaw: gY });
              const n1 = al.world(q3, cl - 1.9, y0 + (h - E.thick - 1.1) / 2);
              const n2 = al.world(q3, cl + 1.9, y0 + (h - E.thick - 1.1) / 2);
              for (const np of [n1, n2])
                this.b.box([np[0], np[1], np[2]], [1.5, h - E.thick - 1.1, 1.5], rgbOf('#8a9197'), { mat: 'concrete', yaw: gY });
              /* 墩底承台：埋 0.4 m 到街面以下，接触关系才成立 */
              for (const np of [n1, n2])
                this.b.box([np[0], y0 - 0.1, np[2]], [2.6, 1.0, 2.6], rgbOf('#7d848a'), { mat: 'concreteD', yaw: gY });
              pierN++;
              this.streetItems.push({ kind: 'elevPier', s, lat: cl, h, p: [foot[0], y0, foot[2]],
                top: h - E.thick - 1.1, spread: 1.9, colW: 1.5 });
            }
          }
          this.streetItems.push({ kind: 'elev', s0: a0, s1: a1, side: eSide, seg: [g[0], g[1]],
            lat: E.lat, cw: E.cw, hMax: E.h, pierN, ramp: E.ramp });
          }
        }
        /* ---- 桥下地面道路 ----
           高架落地之后**路还在**：延安高架落到地面就是地面道路，而以前这条走廊
           在横向 210 m 处只有桥、桥上有没有车都得靠"坡道尽头凭空消失"来收尾
           （旧代码 `if (c.deck && dh < 0.4) continue;`）。现在两幅各一条 7 m 地面幅，
           落在**两排桥墩的外侧**（`gp.off` 7.5 m > 双柱外缘 2.65 m + 车道半宽 3.5 m），
           走整条露天走廊 —— 不只走在桥下面。
           被观景视廊与水面挖断的里程**用同一张段表**（`ev.blocked`）：
           那儿桥不建、路也不建、车也不画，否则就是"车跑在没有路的高度上"那一族。 */
        for (let ci = 0; ci < 2; ci++) {
          const cl = eSide * (E.lat + CW[ci]);
          const gl = ev.groundLat(cl);              // 落地脚（u=0）的那条横向位置
          const sA = Math.max(0, a), sB = Math.min(al.total, z);
          let cur = null; const gps = [];
          for (let s = sA; s <= sB; s += 26) {
            if (ev.blocked(s)) { if (cur) { gps.push(cur); cur = null; } continue; }
            if (!cur) cur = [s, s]; else cur[1] = s;
          }
          if (cur) gps.push(cur);
          for (const pc of gps) {
            if (pc[1] - pc[0] < 20) continue;
            const path = al.frames(pc[0], pc[1], 26).map(f => {
              const q2 = al.level(f);
              /* 面抬高 5 cm：与跟车的 streetDy+0.02 相容（轮下 2 cm 内量得到铺装），
                 又不至于和这条走廊共用的地面层同面打架。 */
              return { p: al.world(q2, gl, al.streetDy(q2.s) + 0.05), r: q2.r, u: q2.u, f: q2.f, s: q2.s };
            });
            this.b.sweep(path, Geo.rectProfile(-E.gp.w / 2, -0.30, E.gp.w / 2, 0),
              { mat: 'asphalt', color: rgbOf('#4d5459'), closed: true, uvAlong: 1 / 24, vSpan: E.gp.w / 24 });
            /* 幅中心一条虚线：gp.lanes = ±1.75 的两条车道分界正在这里 */
            for (let s = Math.ceil(pc[0] / 9) * 9; s < pc[1]; s += 9) {
              const f2 = al.level(al.frame(SH.clamp(s, 0, al.total)));
              const p = al.world(f2, gl, al.streetDy(s) + 0.10);
              this.b.box([p[0], p[1], p[2]], [0.14, 0.02, 3.0], rgbOf('#d6dce0'),
                { mat: 'paint', faces: [2], yaw: Math.atan2(f2.f[0], f2.f[2]) });
            }
            this.streetItems.push({ kind: 'elevRoad', s0: pc[0], s1: pc[1], side: eSide,
              lat: gl, cw: E.gp.w, lanes: E.gp.lanes, ci, dir: SH.elevDir(eSide, CW[ci]), pierLat: cl });
          }
        }
      }
      /* ---- 公交车站 ----
         走廊里以前"有路没车没站"。候车亭立在人行道（lat ~60.3）、站牌在路缘
         （lat ~55.8）；间距 380 m、左右交替 —— 与 src/street.js 的公交停靠点
         **同一套常数**（相位 210、间隔 380），公交车才停得进站。
         相位钉在绝对里程上（与树/虚线同规矩），重烘不挪窝。 */
      if (!opt.noBuild) for (let sB = Math.ceil((a - SH.ROAD.bus.phase) / SH.ROAD.bus.pitch) * SH.ROAD.bus.pitch + SH.ROAD.bus.phase; sB < z; sB += SH.ROAD.bus.pitch) {
        const bs = (Math.round((sB - SH.ROAD.bus.phase) / SH.ROAD.bus.pitch) % 2) ? 1 : -1;
        const fB = al.frame(clamp(sB, 0, al.total)), qB = al.level(fB);
        const yB = al.streetDy(sB);
        const gY = Math.atan2(qB.f[0], qB.f[2]);
        const post = (dz, lat) => { const q = al.world(qB, bs * lat, yB + 1.25);
          this.b.box([q[0], q[1], q[2]], [0.09, 2.5, 0.09], rgbOf('#5f686e'), { mat: 'metal', yaw: gY }); };
        post(sB - 1.9, 59.7); post(sB + 1.9, 59.7); post(sB + 1.9, 61.1);
        /* 顶棚（微斜）+ 背板玻璃 + 座椅 + 广告灯箱 */
        const rq = al.world(qB, bs * 60.4, yB + 2.62);
        this.b.box([rq[0], rq[1], rq[2]], [1.7, 0.07, 4.6], rgbOf('#aeb7bd'), { mat: 'metal', yaw: gY });
        const bk = al.world(qB, bs * 61.15, yB + 1.75);
        this.b.box([bk[0], bk[1], bk[2]], [0.05, 1.1, 4.2], rgbOf('#9fd0dc'), { mat: 'glassSoft', alpha: 0.35, yaw: gY });
        const bn = al.world(qB, bs * 60.7, yB + 0.85);
        this.b.box([bn[0], bn[1], bn[2]], [0.45, 0.10, 3.2], rgbOf('#7d868c'), { mat: 'metal', yaw: gY });
        const adq = al.world(qB, bs * 61.05, yB + 1.6);
        this.b.box([adq[0], adq[1], adq[2]], [0.10, 0.9, 1.3], rgbOf('#f0d9a8'), { mat: 'emissive', emi: 0.7, yaw: gY });
        /* 站牌：路缘杆 + 牌面（浅底 + 一条深色线路带） */
        const pq = al.world(qB, bs * SH.ROAD.bus.signLat, yB + 1.3);
        this.b.box([pq[0], pq[1], pq[2]], [0.06, 2.6, 0.06], rgbOf('#5f686e'), { mat: 'metal', yaw: gY });
        const sg = al.world(qB, bs * SH.ROAD.bus.signLat, yB + 2.25);
        this.b.box([sg[0], sg[1], sg[2]], [0.04, 0.75, 0.45], rgbOf('#e8eef2'), { mat: 'paint', yaw: gY });
      }
      /* ---- 路口信号灯 ----
         灯位与 street.js 让车停下的那条线，两边都从 `SH.junctions(line)` 与
         `SH.signalHead` 取 —— 只有出入口那两处斑马线有灯是不够的，
         路上每隔一段一条横向路口才是上海的地面路网。 */
      if (!opt.noBuild) for (const j of (this._jx || [])) {
        if (j.s < a - 4 || j.s > z + 4) continue;
        this.trafficLight(j);
      }
      /* 高架桥面自己的投影。桥面离街面约 10.9 m，按黄昏太阳投出去 27 m，
         正好落在走廊里 —— 这是驾驶室视角最重要的一条深度线索：
         以前整条高架无影地浮在路上，桥墩像是插在空气里。
         三段渐淡，末端回到沥青底色，看不出被截断。 */
      {
        const t = rgbOf('#6d777f'), DL = 27;
        for (let i = 0; i < 3; i++) {
          const off = DL * (i + 0.5) / 3;
          const ox = SHADOW_DIR[0] * off, oz = SHADOW_DIR[1] * off;
          const dp = gp.map(q => ({ p: [q.p[0] + ox, q.p[1] + 0.16, q.p[2] + oz], r: q.r, u: q.u, f: q.f, s: q.s }));
          const k = 0.34 * (1 - i / 3) * (1 - i / 3) + 0.95;
          this.b.sweep(dp, [{ x: -6.5, y: 0, nx: 0, ny: 1 }, { x: 6.5, y: 0, nx: 0, ny: 1 }],
            { mat: 'rubber', color: [t[0] * k, t[1] * k, t[2] * k], closed: false, flip: true, uvAlong: 1 / 12, vSpan: 13 / 12 });
        }
      }
      /* 标线与绿化带用**对称截面 + flip: true**，和上面街面同一套配方。
         原来写成 x: 0→9 再按 side 决定 flip，结果只有一侧的绕序与 +y 法向一致，
         另一侧整条绿化带/边线被背面剔除（test-wind.js 量到 foliage 50%、light 30%
         反向就是这个原因）。截面关于 x=0 对称后，两侧都用同一个 flip 就都对。 */
      // 道路标线：中央分隔带两侧边线，高架下的地面一眼能看出是马路而不是荒地
      for (const side of [-1, 1]) {
        const lp = al.frames(a, z, 26).map(f => { const q = al.level(f); const p = al.world(q, side * 5.2, al.streetDy(f.s) + 0.16); return { p, r: q.r, u: q.u, f: q.f, s: q.s }; });
        this.b.sweep(lp, [{ x: -0.12, y: 0, nx: 0, ny: 1 }, { x: 0.12, y: 0, nx: 0, ny: 1 }],
          { mat: 'light', color: rgbOf('#c9cdd0'), closed: false, flip: true, emi: 0.1, uvAlong: 1 / 6, vSpan: 1 });
      }
      // 线路两侧的绿化带（中央分隔带）：横向 6.6~15.6 m，抬 0.12 m 才是"带"而不是"漆"
      for (const side of [-1, 1]) {
        const g2 = al.frames(a, z, 12).map(f => { const q = al.level(f); const p = al.world(q, side * 11.1, al.streetDy(f.s) + 0.12); return { p, r: q.r, u: q.u, f: q.f, s: q.s }; });
        if (g2.length < 2) continue;
        this.b.sweep(g2, [{ x: -4.5, y: 0, nx: 0, ny: 1 }, { x: 4.5, y: 0, nx: 0, ny: 1 }],
          { mat: 'foliage', color: rgbOf('#3f5a42'), closed: false, flip: true, uvAlong: 1 / 8, vSpan: 1 / 9 });
      }
    }
    return this;
  }
}

/** 里程是否落在任一区间内 */
function inAny(s, ranges) {
  if (!ranges || !ranges.length) return false;
  for (const r of ranges) if (s > r[0] && s < r[1]) return true;
  return false;
}

/** [s0,s1] 减去若干区间，返回剩下的连续段。跨江点用它把地面切开。 */
function subtractRanges(s0, s1, cuts) {
  if (!cuts || !cuts.length) return [[s0, s1]];
  const list = cuts.filter(c => c && isFinite(c[0]) && isFinite(c[1]) && c[1] > s0 && c[0] < s1)
    .map(c => [c[0], c[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = s0;
  for (const c of list) {
    if (c[0] > cur) out.push([cur, c[0]]);
    cur = Math.max(cur, c[1]);
  }
  if (cur < s1) out.push([cur, s1]);
  return out;
}

SH.WorldBuilder = WorldBuilder;

})(typeof window !== 'undefined' ? window : globalThis);
