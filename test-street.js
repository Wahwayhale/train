/* ============================================================================
 * test-street.js — 街面车流与公交车站的离线判据（第 15 个自测）
 *
 * 为什么要有它：`src/street.js` 与 `src/world.js` 的街面烘焙是两套代码在描述
 * 同一条马路，而以前没有任何一条判据把它们对起来。结果是一次很具体的错：
 * world.js 把车道虚线烘在 |横向| = 25 / 34.5 / 44，street.js 让车也跑在这三个数
 * 上 —— **每一辆车都正正地跨着一条虚线**，从高架驾驶室看下去整条街的线是从车身
 * 中间穿过去的。顶点数正常、绕序正常、烘焙正常，14 条判据一条都不红。
 *
 * 这里量六组东西，全部量**结果**：
 *   A. 断面单点：车道中心由边界两两取中点算出，且不许与任何一条虚线重合。
 *   B. 车流不许跑到车行道外（|横向| ≤ 外缘实线），也不许退回绿化带里。
 *   C. 公交靠站：进站横向并入到公交道、停靠点在站亭 ±20 m 内。
 *   D. 公交离站后速度必须回到基准（曾经 `baseV` 在减速之后才第一次取值，
 *      于是第一次靠站就把整局钉死在 3 m/s 蠕行）。
 *   E. 实例对账：`_expect`（截断前独立算出的应提交数）== `_drawn`（真提交数），
 *      且必须 > 0 —— 空跑的"0% 差异"不是通过（这条项目里栽过）。
 *   F. 接线 lint：world.js 的虚线/站亭必须读 SH.ROAD；game.js 的通用批次循环
 *      必须排除 tag 'street'（局部坐标的车网格按单位阵画=一摞车堆在世界原点）。
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic', 'street', 'landmark', 'game']) {
  try { require('./src/' + f + '.js'); } catch (e) { console.log('✗ require ' + f + ': ' + e.message); process.exit(1); }
}
require('./data/shanghai.js');
const SH = global.SH;
const fs = require('fs');
let bad = 0;
const ok = (cond, msg) => { if (!cond) { console.log('✗ ' + msg); bad++; } };

/* ---------------------------------------------------------------- A 断面单点 */
{
  const R = SH.ROAD;
  ok(R && Array.isArray(R.lanes) && R.lanes.length === R.lines.length + 1,
    'SH.ROAD.lanes 必须由 bounds 两两取中点算出（车道数 = 虚线数 + 1），实际 ' +
    (R && R.lanes ? R.lanes.length : '无'));
  for (let i = 0; i < R.lanes.length; i++) {
    const a = R.bounds[i], b = R.bounds[i + 1];
    ok(R.lanes[i] > a + 0.5 && R.lanes[i] < b - 0.5,
      `车道中心 ${R.lanes[i]} 没落在边界 ${a}~${b} 中间（至少离两条线 0.5 m）`);
    ok(R.lines.indexOf(R.lanes[i]) < 0,
      `车道中心 ${R.lanes[i]} 与某条车道虚线重合 —— 车会压在虚线上开`);
  }
  ok(R.busLane === R.lanes[R.lanes.length - 1], '公交道必须是最外侧那条车道');
  ok(R.busLane < R.edge, `公交道 ${R.busLane} 越过了外缘实线 ${R.edge}`);
}

/* 造一条真线路 + 一台假渲染器 */
const LINE = process.env.STREET_LINE || 'l3';
const line = new SH.LineRuntime(SH.LINES[LINE]);
const al = line.al;
const st = new SH.street.StreetTraffic(line);

/* ------------------------------------------------------- B/C/D 车流与公交行为 */
let s0 = 0;    // 全模块共用：E 组要拿同一段露天区当眼点
{
  /* 找一段足够长的露天区间来测 */
  for (let s = 100; s < al.total - 1200; s += 50) {
    let all = true;
    for (let k = 0; k < 900; k += 50) if (!line.isElevated(s + k)) { all = false; break; }
    if (all) { s0 = s; break; }
  }
  ok(s0 > 0, `线 ${LINE} 上找不到 900 m 连续露天段，B/C/D 三组测不了`);

  /* 把每辆车摆进这段露天区，跑 60 s（高架上的车在 H 组单独量） */
  for (const c of st.cars) { if (c.deck) continue; c.s = s0 + (c.id * 37) % 900; c.lat = c.lane; c.dwell = 0; }
  let out = 0, worst = 0;
  for (let f = 0; f < 3600; f++) {
    st.update(1 / 60);
    for (const c of st.cars) {
      if (c.deck) continue;
      const w = Math.abs(c.lat);
      worst = Math.max(worst, w);
      if (w > SH.ROAD.edge) out++;
    }
  }
  ok(out === 0, `有 ${out} 帧次车跑到外缘实线（${SH.ROAD.edge} m）之外`);
  ok(worst >= SH.ROAD.lanes[0] - 0.01, `最内车道 ${SH.ROAD.lanes[0]} 没有车走过（实测最大横向 ${worst}）`);

  /* C/D：挑一辆本侧有停靠点的公交，把它放到站前 40 m */
  const bus = st.cars.find(c => c.kind === 'bus' && st.stops.some(sp => sp.side === c.side)) ||
    st.cars.find(c => c.kind === 'bus');
  ok(!!bus, '没有公交车可以测');
  if (bus) {
    const sp = st.stops.find(s2 => s2.side === bus.side);
    /* 放在站前 300 m：并线要横移 28 m、按 1.6 m/s 是 17.6 s，
       太近放就等于要求一辆车在 40 m 里做完三车道并线，那是考卷错不是车错。 */
    bus.s = sp.s - 300 * bus.side; bus.v = bus.baseV; bus.dwell = 0; bus.lat = bus.lane; bus.stopS = null;
    const v0 = bus.baseV;
    let sawDwell = false, latAtStop = 0, sAtStop = 0, vAfter = 0;
    for (let f = 0; f < 60 * 90; f++) {
      if (bus.dwell > 0 && !sawDwell) { sawDwell = true; latAtStop = bus.lat; sAtStop = bus.s; }
      st.update(1 / 60);
      if (sawDwell && bus.dwell <= 0) vAfter = Math.max(vAfter, bus.v);
      /* 离站后又跑到下一个站前减速是正常行为，所以量"离站后的峰值速度"
         而不是"最后一帧的速度" —— 后者会把正常的第二次进站读成 bug。 */
      if (sawDwell && vAfter >= v0 - 0.01) break;
    }
    ok(sawDwell, '公交在站前 300 m 出发，90 s 内没有进站停靠');
    ok(Math.abs(latAtStop - SH.ROAD.busLane) < 0.35,
      `公交停靠时横向 ${latAtStop.toFixed(2)}，没并到公交道 ${SH.ROAD.busLane}（站亭在人行道上，车停在行车道里=路边违停）`);
    ok(Math.abs(sAtStop - sp.s) < 20,
      `公交停靠里程与站亭差 ${Math.abs(sAtStop - sp.s).toFixed(1)} m（>20 m 就是停在了站外）`);
    ok(vAfter >= v0 - 0.01,
      `离站后峰值速度 ${vAfter.toFixed(2)} m/s，没回到基准 ${v0.toFixed(2)} —— baseV 那条老错回来了`);
    /* 停靠之后必须真的离开（dwell 无限续期那一族的直接判据）。
       时长按路口周期标定：JUNCTION.cycle = 90 s 下最长红灯 60 s + 起步/排队，
       公交离站后等一个红灯再走是正常行为 —— 40 s 的旧标定会把它读成缺陷；
       真正要抓的"dwell 无限续期"是一辈子不动，95 s（一个整周期 + 起步余量）仍然抓得住。 */
    let left = false;
    for (let f = 0; f < 60 * 95; f++) { st.update(1 / 60); if (Math.abs(bus.s - sAtStop) > 150) { left = true; break; } }
    ok(left, '公交停靠后 95 s 内没有驶离该站（dwell 被无限续期 = 永远钉在站上）');
  }
}

/* ------------------------------------------------------------- E 实例对账 */
{
  const drawn = [];
  const fake = {
    upload: meshes => meshes.map(m => ({ mat: m.mat, tag: 'street' })),
    drawInstanced: (b, mats, ov, tints) => { drawn.push({ mat: b.mat, n: mats.length, ov, tints }); },
  };
  st.attach(fake);
  ok(st.gpu && st.gpu.length === st.variants.length, 'attach 后 gpu 变体数与网格变体数不一致');
  const q = al.level(al.frame(s0 + 400));
  const eye = al.world(q, 0, 4);
  drawn.length = 0;
  st.draw(fake, eye, 0, 1);
  ok(st._drawn > 0, `相机 480 m 内一辆车都没提交（眼点 s=300，露天判据 line.isElevated 是不是把这段吃掉了？）`);
  ok(st._expect === st._drawn, `实例对账不平：应提交 ${st._expect}，实提交 ${st._drawn}`);
  /* ---- 第 135 条：涂装必须真的到得了 draw call ----
     以前变体表按 (车型,涂装) 烘 13 份，可 `push()` 没把 col 存进变体记录 ⇒ 索引键
     全是 `kind|undefined`，而查表用的是 `kind|3` —— **永远 miss**，退回该车型的
     第一份几何。结果 13 个变体里只有 5 个被用到，七档轿车漆在画面上只有一档，
     而"有几个变体/有没有车漆族"这类判据全都看不见这件事。
     现在几何按车型（5 份），颜色是每实例三个 float：判据直接量"送进 drawInstanced
     的那份数组"。 */
  {
    const cs = drawn.filter(d => d.mat === 'carShell');
    ok(cs.length > 0, '没有任何 carShell 批次 —— 车壳材质没上屏');
    for (const d of cs) ok(d.tints && d.tints.length === d.n * 3,
      `carShell 批次的实例色数组长度 ${d.tints ? d.tints.length : '没有'}，实例数×3 = ${d.n * 3} —— 错位一帧就是"这辆车穿那辆车的漆"`);
    const legal = new Set(st.tints.map(t => t.map(x => x.toFixed(3)).join(',')));
    const key = d => [d[0], d[1], d[2]].map(x => x.toFixed(3)).join(',');
    let widest = new Set(), all = new Set(), badTint = 0;
    for (const d of cs) {
      const s = new Set();
      for (let i = 0; i < d.n; i++) {
        const k = key([d.tints[i * 3], d.tints[i * 3 + 1], d.tints[i * 3 + 2]]);
        if (!legal.has(k)) badTint++;
        s.add(k);
      }
      if (s.size > widest.size) widest = s;
      for (const x of s) all.add(x);
    }
    ok(badTint === 0, `${badTint} 个实例的色不在涂装表里 —— 颜色有两个出处了`);
    ok(widest.size >= 3, `同一车型的一组里只出现 ${widest.size} 种涂装 —— 涂装维度没到屏上（第 135 条要修的正是这件事）`);
    ok(all.size >= 5, `全场景只出现 ${all.size} 种涂装（表里有 ${st.tints.length} 档），要么车太少要么颜色被吞了`);
    ok(st.variants.length === new Set(st.variants.map(v => v.kind)).size,
      '变体表里同一车型有多份几何 —— 涂装又回到"每档烘一份"，批次会按涂装数翻倍');
  }
  /* 每组每材质都拿到了同一个实例数（分组截断没把某一组整组丢掉） */
  const perGroup = new Map();
  for (const d of drawn) perGroup.set(d.n, (perGroup.get(d.n) || 0) + 1);
  ok(perGroup.size >= 1 && [...perGroup.values()].reduce((a, b) => a + b, 0) === drawn.length,
    '实例数分布异常（分组被整组丢掉）');

  /* F：夜间车灯必须拿到加算覆盖，白天不许拿 */
  drawn.length = 0; st.draw(fake, eye, 1, 1);
  const lit = drawn.filter(d => d.mat === 'light');
  ok(lit.length > 0, '没有 light 材质的批次（前后灯没烘出来？）');
  ok(lit.every(d => d.ov && d.ov.emi > 1.5), `night=1 时车灯 emi 覆盖没生效：${JSON.stringify(lit.map(d => d.ov))}`);
  drawn.length = 0; st.draw(fake, eye, 0, 1);
  ok(drawn.filter(d => d.mat === 'light').every(d => !d.ov), 'night=0 时车灯仍被加了 emi —— 白天不该开灯');

  /* 时段密度：0.4 与 1.0 的抽水量必须真的不同（否则那条映射是死的） */
  drawn.length = 0; st.draw(fake, eye, 0, 1); const n1 = st._want;
  st.draw(fake, eye, 0, 0.4); const n2 = st._want;
  ok(n2 < n1 * 0.75, `密度 0.4 只抽掉 ${n1}→${n2}，抽样没生效`);
}

/* ------------------------------------------------- G 视锥必须先于距离截断 */
{
  /* 复刻那次"提交数正常、上报全绿灯、画面上一辆车都没有"的失效：
     cap 按"离眼最近"留 12 辆，而高架下的街面最近的那批全在相机背后/桥正下方，
     于是画面里那 200~400 m 的车被画面外的车挤掉了。
     判据形式：给假渲染器一个半空间视锥，要求**提交的每一辆都在视锥内**。
     一旦有人把视锥筛删掉或把顺序换回"先距离后视锥"，这条立刻红。 */
  const q = al.level(al.frame(s0 + 400));
  const eye = al.world(q, 0, 4);
  const K = eye[0] - 5;
  const box = (min, max) => (min[0] + max[0]) / 2 > K;
  const seen = [];
  const fake = {
    upload: meshes => meshes.map(m => ({ mat: m.mat, tag: 'street' })),
    boxInFrustum: box,
    drawInstanced: (b, mats) => { for (const m of mats) seen.push([m[12], m[13], m[14]]); },
  };
  if (!st.gpu) st.attach(fake);
  st.draw(fake, eye, 0, 1);
  ok(seen.length > 0, '视锥筛之后一辆车都没提交（假视锥是半个空间，不该这么苛刻）');
  const outside = seen.filter(p => !(p[0] > K)).length;
  ok(outside === 0, `有 ${outside}/${seen.length} 辆被提交的车在假视锥之外 —— 视锥筛没生效或被顺序吃掉了`);
}

/* ----------------------------------------------------------- F 接线 lint */
{
  const w = fs.readFileSync('./src/world.js', 'utf8');
  ok(/for \(const lat of SH\.ROAD\.lines\)/.test(w),
    'world.js 的车道虚线没读 SH.ROAD.lines（写死数字就会和车流再次各说各话）');
  ok(/SH\.ROAD\.bus\.phase/.test(w) && /SH\.ROAD\.bus\.pitch/.test(w),
    'world.js 的候车亭间距/相位没读 SH.ROAD.bus（与 street.js 的停靠点必须同源）');
  const g = fs.readFileSync('./src/game.js', 'utf8');
  ok(/b\.tag === 'street'/.test(g),
    "game.js 的通用批次循环没有排除 tag 'street' —— 局部坐标的车网格会被按单位阵画在世界原点");
  const s = fs.readFileSync('./src/street.js', 'utf8');
  ok(!/for \(const lane of \[/.test(s), 'street.js 里又出现了写死的车道数组');
}

/* ------------------------------------------ H 高架快速路：桥面几何 ↔ 桥上车流
 * 目标里那句"路上也得有汽车**在高架跑**"要的是：旁边那条分幅高架上真的有车在跑，
 * 而且车是**站在烘出来的桥面上**的 —— 桥面在 world.js、车流在 street.js、
 * 高度函数在 core.js，三处必须同源。所以这一组两头都量：
 *   ① 车流：数量、在本幅桥面以内、速度档、真的在推进、端头落地段不悬空；
 *   ② 几何：桥面与桥墩的顶点、分区闸门；
 *   ③ 对账：抽样的车，它轮下 0.4 m 内必须有烘焙桥面顶点（否则就是"车在空气里跑"）。 */
{
  const E = SH.ELEV_WAY, ev = SH.elevFor(al, line.stations);
  const eS = SH.elevSide(line.stations);
  const CW = [-E.gap / 2 - E.cw / 2, E.gap / 2 + E.cw / 2];
  ok(ev.segs.length > 0, `线 ${LINE} 判不出任何高架快速路段（上海的高架走廊不该一段都没有）`);
  const deck = st.deckCars;
  ok(deck.length > 40, `高架上的车只有 ${deck.length} 辆（两幅 × 两车道 × 每 55 m 一辆）`);
  let off = 0;
  for (const c of deck) {
    const d = Math.min(...CW.map(o => Math.abs(c.lat - eS * (E.lat + o))));
    if (d > E.cw / 2 - 0.9 + 1e-6) off++;
  }
  ok(off === 0, `有 ${off} 辆高架车跑到本幅桥面以外（半宽 ${E.cw / 2}，含 0.9 m 余量）`);
  /* 速度档看 `baseV`（自由流目标速度）而不是 `v`：有了跟驰之后 `v` 低于 baseV
     正是它该做的事。轿车档仍在 80~100 km/h，混进来的货车 55~62 km/h ——
     **没有速度差就没有"车流"**，只有一排平移的盒子，跟驰与并线都无从发生。 */
  ok(deck.every(c => (c.baseV >= 22 && c.baseV <= 28) || (c.baseV >= 15 && c.baseV <= 18)),
    '高架车的速度档不对（快速路上只该有 80~100 km/h 的轿车档与 55~62 km/h 的货车档）');
  const slowN = deck.filter(c => c.baseV < 20).length;
  ok(slowN > 0 && slowN * 3 < deck.length,
    `高架上的慢车 ${slowN}/${deck.length} —— 一档都不混（0 辆）或全是慢车都算这条没做`);
  const before = deck.map(c => c.s);
  /* 跑 20 s，每 6 帧采一次样，量"跟驰 + 并线"这四件：穿模、真的刹过、并线发生过、
     变道是渐变不是瞬移。采样而不是逐帧：逐帧会把这条判据从秒级拖到分钟级
     （它前面还接着 1 小时的行人仿真），而 0.1 s 的窗口足以抓到 5.5 m 的瞬移。 */
  const braked = new Set();
  const prev = deck.map(c => [c.lane, c.lat]);
  let clash = 0, changes = 0, tele = 0;
  for (let f = 0; f < 1200; f++) {
    st.update(1 / 60);
    if (f % 6) continue;
    for (let i = 0; i < deck.length; i++) {
      const c = deck[i];
      if (c.v < 0.8 * c.baseV) braked.add(c);
      if (prev[i][0] !== c.lane) changes++;
      if (Math.abs(c.lat - prev[i][1]) > 0.25) tele++;
      prev[i][0] = c.lane; prev[i][1] = c.lat;
    }
    const byLane = new Map();
    for (const c of deck) {
      const k = c.ci * 8 + c.lane;
      let a = byLane.get(k);
      if (!a) { a = []; byLane.set(k, a); }
      a.push(c);
    }
    for (const a of byLane.values()) {
      if (a.length < 2) continue;
      a.sort((x, y) => (x.s - y.s) * a[0].dir);
      for (let i = 0; i + 1 < a.length; i++)
        if ((a[i + 1].s - a[i].s) * a[i].dir < 3.0) clash++;
    }
  }
  ok(clash === 0, `高架同车道出现 ${clash} 次两车距离小于 3 m（穿模）—— 跟驰没起作用`);
  /* 中位速度必须仍在快速路档。这一条是被自己的第一版逼出来的：跟驰曲线直接套
     红灯那条"到停车线刹停"的 √(2ad) 时，整幅桥面集体压到 13 m/s（47 km/h）——
     穿模为 0、刹过车、并过线，前四条全绿，而画面上是一条堵死的快速路。
     "省下来"的指标好查，"堵住了"这种失效只有独立参照才看得见。 */
  const sp = deck.map(c => c.v).sort((a, b) => a - b);
  const med = sp[(sp.length / 2) | 0];
  ok(med >= 18, `高架车流中位速度 ${med.toFixed(1)} m/s（< 18 m/s = 65 km/h）—— 快速路堵成了停车场，跟驰曲线收敛的目标应该是前车速度而不是 0`);
  ok(braked.size > 0, '跑 20 s 没有一辆高架车刹过车 —— 跟驰是装饰，车只会定速平移');
  ok(changes > 0, `跑 20 s 高架上一次都没并线 —— "被慢车堵住就绕过去"没做，慢车会把整幅堵成一列火车`);
  ok(tele === 0, `变道出现 ${tele} 次单帧横向跳变（> 1.2 m/s）—— 车突然出现在另一条道上`);
  const moved = deck.filter((c, i) => Math.abs(c.s - before[i]) > 1).length;
  ok(moved === deck.length, `跑 20 s 只有 ${moved}/${deck.length} 辆高架车动了`);
  /* 两幅必须反向（分幅单向），否则同一侧两条车道对开 */
  ok(new Set(deck.map(c => c.dir)).size === 2, '高架两幅同向 —— 分幅高架的行车方向判错了');
  if (ev.segs.length) {
    const g0 = ev.segs[0];
    ok(ev.h(g0[0] + 1) < 0.5 && Math.abs(ev.h(g0[0] + E.ramp + 5) - E.h) < 0.2 && ev.h((g0[0] + g0[1]) / 2) === E.h,
      `端头落地坡道不对：起点 ${ev.h(g0[0] + 1).toFixed(2)} m、${E.ramp} m 处 ${ev.h(g0[0] + E.ramp + 5).toFixed(2)} m、段中 ${ev.h((g0[0] + g0[1]) / 2).toFixed(2)} m（应 0 / ${E.h} / ${E.h}）`);
    /* 分区闸门：既不能全线都有，也不能全线都没有 */
    const blocked = line.stations.filter((n, i) => ev.h(al.stationS[i]) === 0).length;
    ok(blocked > 0 && blocked < line.stations.length,
      `高架闸门：${blocked}/${line.stations.length} 站旁没有高架（全有/全无都说明分区没进这一层）`);
    /* 覆盖率闸门（blocked 的补刀，2026-10-06）：把分区闸门整个拆掉时，段表并成
       一根 [0,total]，全线唯一 h=0 的站是恰好压在端头坡道上的那个 —— blocked=1
       骗过"不是全有"（变异实测 rc=0）。里程覆盖率才是硬指标：基线 l3 79%
       （哪些走廊铺高架是分区表决定的），闸门拆掉 = 100%。 */
    const cov = ev.segs.reduce((a, g) => a + (g[1] - g[0]), 0) / al.total;
    ok(cov < 0.98, `高架覆盖全线 ${(100 * cov).toFixed(0)}% —— 分区闸门没起作用（每站都允许铺，段表并成了全长）`);
    /* 量几何要挑一段"高架旁边确实是露天走廊"的窗口：
       高架段落在地下站旁边时，街面根本没烘，桥面当然量不到。
       本线量不到就**明说**（不静默跳），但仍然要求全网至少有一条线能取证 ——
       否则"高架快速路"这一层退化成数据表上的字，没人会发现。 */
    const findWin = ln => {
      const evn = SH.elevFor(ln.al, ln.stations);
      for (const gg of evn.segs) {
        for (let t = 0.2; t <= 0.85; t += 0.15) {
          const c0 = gg[0] + (gg[1] - gg[0]) * t;
          let open = true;
          for (let k = -400; k <= 400; k += 100) {
            if (c0 + k < 0 || c0 + k > ln.al.total || !ln.isElevated(c0 + k)) { open = false; break; }
          }
          if (open) return c0;
        }
      }
      return -1;
    };
    const mid = findWin(line);
    ok(mid > 0 || ['l1', 'l3', 'l7', 'l17'].some(id => SH.LINES[id] && findWin(new SH.LineRuntime(SH.LINES[id])) > 0),
      '全网找不出一段"旁边有高架、且确实是露天走廊"的 900 m 窗口 —— 高架快速路在画面上不存在');
    if (mid < 0) console.log(`  · 注：线 ${LINE} 判出的高架段旁边都是地下段，本线的桥面几何取证跳过（STREET_LINE=l3 可看这一层）`);
    if (mid > 0) {
    const sign = new SH.textures.SignAtlas(2048);
    const w = new SH.WorldBuilder({ al, color: SH.LINES[LINE].color, stations: line.stations, sign, night: 0.62, profile: line.profile });
    w.ambient = [0.26, 0.29, 0.36]; w.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; w._installLight();
    SH.WorldBuilder.buildRuns(w, line, mid - 450, mid + 450, null);
    const meshes = w.b.finish();
    const recs = w.streetItems.filter(x => x.kind === 'elev');
    const piers = w.streetItems.filter(x => x.kind === 'elevPier');
    ok(recs.length > 0, '高架段烘出来没有任何桥面登记');
    ok(piers.length > 6, `桥墩登记只有 ${piers.length} 个（30 m 一墩，900 m 走廊应 ≥30）`);
    /* 横向要按**局部基**投影：走廊是弯的，拿一个里程的基去量 ±450 m 会把
       整条桥带量歪。沿程每 100 m 取一个局部系，窗口 ±50 m 首尾相接。 */
    const bandCount = (mats, lo, hi, dyLo, dyHi) => {
      let n = 0;
      for (let sv = mid - 450; sv <= mid + 450; sv += 100) {
        const A2 = al.level(al.frame(SH.clamp(sv, 0, al.total)));
        const O2 = al.world(A2, 0, al.streetDy(sv));
        for (const m of meshes) {
          if (mats.indexOf(m.mat) < 0) continue;
          for (let i = 0; i + 2 < m.pos.length; i += 3) {
            const dx = m.pos[i] - O2[0], dz = m.pos[i + 2] - O2[2], dy = m.pos[i + 1] - O2[1];
            if (dy < dyLo - 6 || dy > dyHi + 6) continue;
            const lt = eS * (dx * A2.r[0] + dz * A2.r[2]);
            if (lt < lo || lt > hi) continue;
            if (Math.abs(dx * A2.f[0] + dz * A2.f[2]) > 50) continue;
            if (dy < dyLo || dy > dyHi) continue;
            n++;
          }
        }
      }
      return n;
    };
    const deckV = bandCount(['concrete'], E.lat - 13, E.lat + 13, 4.0, 11.6);
    const pierV = bandCount(['concrete', 'concreteD'], E.lat - 13, E.lat + 13, -0.5, 4.0);
    ok(deckV > 300, `桥面顶点只有 ${deckV} 个（横向 ${E.lat - 13}~${E.lat + 13} m、街面上方 4~11.6 m）`);
    ok(pierV > 150, `桥墩顶点只有 ${pierV} 个 —— 墩没立起来`);
    /* ---- ③ 车与桥面对账：轮下 0.4 m 内必须有桥面顶点 ---- */
    let onDeck = 0, sampled = 0; const missAt = [];
    for (const c of deck) {
      const h = ev.h(c.s);
      /* 只量**烘到的那一段**里的车：窗口是 mid±450，抽到窗口外的车
         当然量不到桥面 —— 那不是车错，是抽样错。 */
      /* 只量**等高段**的车：落地坡道上相邻两档桥面顶点本来就差到 2 m，
         拿"顶点在车轮上下 0.45 m 内"去要求一辆斜面上的车，量的会是插值而不是桥。 */
      if (h < 4 || h < E.h - 0.05 || Math.abs(c.s - mid) > 400) continue;
      if (sampled >= 12) break;
      sampled++;
      const q2 = al.level(al.frame(c.s));
      const p = al.world(q2, c.lat, al.streetDy(c.s) + h + 0.02);
      const A2 = { r: q2.r, f: q2.f };
      let hit = 0;
      for (const m of meshes) {
        if (m.mat !== 'concrete') continue;
        for (let i = 0; i + 2 < m.pos.length; i += 3) {
          const dx = m.pos[i] - p[0], dz = m.pos[i + 2] - p[2], dy = m.pos[i + 1] - p[1];
          /* 扫掠体的顶点只落在 26 m 一档的采样里程上，纵向窗口必须 ≥13 m，
             否则"桥面是对的"也量不出来（这条在地面墙上已经栽过一次）。 */
          if (Math.abs(dx * A2.f[0] + dz * A2.f[2]) > 20) continue;
          const lt = eS * (dx * A2.r[0] + dz * A2.r[2]);
          if (Math.abs(lt) > E.cw / 2) continue;
          if (dy > -0.45 && dy < 0.1) hit++;
        }
      }
      if (hit > 0) onDeck++; else missAt.push(Math.round(c.s));
    }
    const recsE = (w.streetItems || []).filter(x => x.kind === 'elev').map(x => [Math.round(x.s0), Math.round(x.s1)]);
    ok(sampled > 4 && onDeck === sampled,
      `抽样 ${sampled} 辆高架车，只有 ${onDeck} 辆轮下 0.45 m 内量到桥面顶点（车跑在空气里/埋进梁里）`
      + (missAt.length ? `；量不到的里程 ${JSON.stringify(missAt)}，烘到的桥面段 ${JSON.stringify(recsE)}` : ''));
    /* 光有车流数据不算：眼点摆到桥面上方，必须有实例真的提交给渲染器 */
    const fake2 = { upload: ms => ms.map(m => ({ mat: m.mat, tag: 'street' })), drawInstanced: () => {} };
    if (!st.gpu) st.attach(fake2);
    const qd = al.level(al.frame(mid));
    st.draw(fake2, al.world(qd, eS * (E.lat + 6.5), al.streetDy(mid) + E.h + 2), 0, 1);
    ok(st._deckDrawn > 0, `眼点摆在桥面上方 2 m，提交的高架车实例 ${st._deckDrawn} 辆（0 = 高架上是空的）`);
    /* ---- ⑤ 桥下地面道路：几何真的在、而且不戳进桥墩 ----
       高架落地之后路还在。以前这条走廊在横向 210 m 处**只有桥**，
       桥面车开到坡道尽头就凭 `dh < 0.4` 蒸发 —— "车下高架去了哪儿"没有答案。 */
    const roads = w.streetItems.filter(x => x.kind === 'elevRoad');
    ok(roads.length > 0, '桥下地面道路一条都没登记（高架落地段下面还是空气）');
    /* 横向带**从登记里算**，不写死：地面幅中心是 `E.lat ± (gap/2 + cw/2 + off)`，
       抄一份常数就等于让判据跟着常数字面量走 —— 改口径时它不会报。 */
    let rLo = Infinity, rHi = -Infinity;
    for (const rd of roads) {
      rLo = Math.min(rLo, Math.abs(rd.lat) - rd.cw / 2 - 1);
      rHi = Math.max(rHi, Math.abs(rd.lat) + rd.cw / 2 + 1);
    }
    const roadV = bandCount(['asphalt'], rLo, rHi, -0.30, 0.10);
    ok(roadV > 200, `桥下地面道路的铺装顶点只有 ${roadV} 个（横向 ${rLo.toFixed(0)}~${rHi.toFixed(0)} m、街面上下 0.3 m 内）`);
    {
      const piers = w.streetItems.filter(x => x.kind === 'elevPier');
      let cross = 0, worst = Infinity;
      for (const rd of roads) for (const pr of piers) {
        if (pr.s < rd.s0 - 5 || pr.s > rd.s1 + 5) continue;
        /* 地面幅的内缘 vs 该幅**最近那一根柱子的外缘**：柱心离幅中心 1.9 m，
           柱宽 1.5 m（这两个数是 world.js 登记进来的，判据不再自己抄一份）。 */
        const gap = Math.abs(rd.lat - pr.lat) - (pr.spread + pr.colW / 2) - rd.cw / 2;
        if (gap < 0.5) cross++;
        worst = Math.min(worst, gap);
      }
      ok(cross === 0,
        `${cross} 处桥下地面幅与桥墩柱重叠（最小间隙 ${worst.toFixed(2)} m，应 ≥0.5）—— 立柱戳在行车道里`);
      ok(roads.every(r => Math.abs(r.lat - eS * E.lat) > Math.abs(r.pierLat - eS * E.lat)),
        '地面幅没有落在桥墩**外侧**（往线路中心那一侧落地会穿正线与桥墩）');
    }
    }
  }
  /* ---- ④ 接线 lint：三处必须同源 ---- */
  const sw = fs.readFileSync('./src/world.js', 'utf8'), ss2 = fs.readFileSync('./src/street.js', 'utf8');
  ok(/SH\.elevFor\(/.test(sw) && /SH\.elevFor\(/.test(ss2), 'world.js 或 street.js 没走 SH.elevFor（桥面与车流会各算一套高度）');
  ok(/SH\.elevSide\(/.test(sw) && /SH\.elevSide\(/.test(ss2), 'world.js 或 street.js 没走 SH.elevSide（桥与车可能一边一条）');
}

/* ------------------------------------ K 高架落地段：纵坡口径、跟坡、落地不消失（第 136 条）
 * 三条都要**独立表达式**：坡度的真值来自 `ev.h` 自己差分（不是 `ev.grade`），
 * 方向的规则写成"相对本路中心，lat 大的一侧走 +s"（不是 `SH.elevDir`），
 * 否则判据只是在复读产品怎么写。 */
{
  const E = SH.ELEV_WAY, ev = SH.elevFor(al, line.stations);
  const eS = SH.elevSide(line.stations), CW = [-E.gap / 2 - E.cw / 2, E.gap / 2 + E.cw / 2];
  /* ① 坡长是**派生**的。以前 `ramp: 60` 是个独立常量，与 `h: 9` 合起来 = 15% 纵坡 ——
     画面上是滑滑梯而不是城市快速路的匝道；而"坡长"与"坡度"各写一个数，
     改了其中一个另一个不会跟着错，于是没人知道。 */
  ok(E.ramp === Math.round(E.h / E.grade),
    `坡长 ${E.ramp} m 与 h/grade = ${(E.h / E.grade).toFixed(1)} m 不一致（两个数各自为政）`);
  ok(E.h / E.ramp <= E.grade + 1e-9,
    `落地段纵坡 ${(100 * E.h / E.ramp).toFixed(1)}% 超过口径 ${(100 * E.grade).toFixed(1)}%`);
  {
    const g0 = ev.segs[0], k = 15;
    let lo = Infinity, hi = -Infinity;
    for (let s = g0[0] + k + 2; s < g0[0] + E.ramp - k - 2; s += 5) {
      const gg = (ev.h(s + k) - ev.h(s - k)) / (2 * k);
      if (gg < lo) lo = gg; if (gg > hi) hi = gg;
    }
    ok(hi - lo < 1e-3 && Math.abs(lo - E.grade) < 0.002,
      `实测落地段纵坡 ${(100 * lo).toFixed(2)}%~${(100 * hi).toFixed(2)}% —— 应与口径 ${(100 * E.grade).toFixed(2)}% 一致且沿程恒定`);
    ok(ev.h(g0[0] + E.ramp - 1) < E.h && ev.h(g0[0] + E.ramp + 30) === E.h,
      `坡道长度与口径不符：${E.ramp} m 处应还在坡上、+30 m 处必须到顶`);
  }
  /* ② 行车方向只有一条规则：相对**这条路自己的中心**，lat 大的那一幅走 +s。
     高架以前写死 `ci === 0 ? 1 : -1`（正好相反）；两幅各自单向所以不会对着开，
     画面上读不出来 —— 但一辆车要从地面幅一路开上匝道，跨的是同一个定义。
     **两侧都得量**：`ci === 0 ? 1 : -1` 在 `elevSide = −1` 的那些线上恰好与
     正确规则重合，只量当前这条线就会把 bug 放走（实测 l3 就是那一条）。 */
  {
    const rule = (eSide, cl) => (cl - eSide * E.lat > 0 ? 1 : -1);
    const perSide = {};
    for (const id of Object.keys(SH.LINES)) {
      const eSide = SH.elevSide(SH.LINES[id].stations);
      if (perSide[eSide]) continue;
      const ln = new SH.LineRuntime(SH.LINES[id]);
      if (!SH.elevFor(ln.al, ln.stations).segs.length) continue;
      const s2 = new SH.street.StreetTraffic(ln);
      const bad = s2.deckCars.filter(c => c.dir !== rule(eSide, c.cl));
      perSide[eSide] = { id, n: s2.deckCars.length, bad: bad.length, ctr: eSide * E.lat };
      if (perSide[1] && perSide[-1]) break;
    }
    const sides = Object.keys(perSide);
    ok(sides.length === 2, `高架方向这条只量到一侧（${sides.join('/')}）—— 另一侧的规则没人看过`);
    const badAll = sides.reduce((a, k) => a + perSide[k].bad, 0);
    ok(badAll === 0, sides.filter(k => perSide[k].bad).map(k => `${perSide[k].id} 线 ${perSide[k].bad}/${perSide[k].n} 辆高架车的方向`
      + `与"右侧通行"相反（分幅相对本路中心 lat ${perSide[k].ctr} 的符号与 dir 不匹配）`).join('；')
      || '高架两幅的行车方向与右侧通行一致');
    const badG = st.cars.filter(c => !c.deck && c.side !== (c.side * c.lat > 0 ? 1 : -1));
    ok(badG.length === 0, `${badG.length} 辆地面车不符合同一条方向规则（判据与产品两套规则）`);
    for (let ci = 0; ci < 2; ci++) {
      const gl = ev.groundLat(eS * (E.lat + CW[ci]));
      ok(SH.elevDir(eS, CW[ci]) === (gl - eS * E.lat > 0 ? 1 : -1),
        `地面幅与桥面幅的行车方向不同一条（横向 ${gl.toFixed(1)}）—— 落地前后方向翻转 = 车在坡脚调头`);
    }
  }
  /* ③ 车流跟坡：桥面在坡上是**斜的**，而实例矩阵以前只有 yaw ——
     车"平着滑下坡"，前轮埋进防撞墙、后轮悬空。 */
  const recMat = [];
  const fakeK = { upload: ms => ms.map(m => ({ mat: m.mat, tag: 'street' })),
    drawInstanced: (b, mm) => { if (b.mat === 'carShell') for (const M of mm) recMat.push(M); } };
  if (!st.gpu) st.attach(fakeK);
  let target = null, gTarget = 0;
  for (const c of st.deckCars) {
    const k = 15, gg = (ev.h(c.s + k) - ev.h(c.s - k)) / (2 * k);
    if (Math.abs(gg) < 0.03 || ev.blocked(c.s) || !line.isElevated(c.s)) continue;
    const q = al.level(al.frame(c.s));
    if (Math.abs(q.f[1]) > 0.005) continue;          // 对齐线自己有纵坡时量不出匝道的
    target = c; gTarget = gg; break;
  }
  ok(!!target, '找不到一辆"在落地坡道上、且对齐线本身水平"的高架车 —— 跟坡这条无从下手');
  if (target) {
    const q = al.level(al.frame(target.s));
    const pos = al.world(q, target.lat + ev.foot(target.s, target.cl),
      al.streetDy(target.s) + 0.02 + ev.h(target.s));
    recMat.length = 0;
    st.draw(fakeK, pos, 0, 1);
    let best = null, bd = 1e9;
    for (const M of recMat) {
      const d = Math.hypot(M[12] - pos[0], M[13] - pos[1], M[14] - pos[2]);
      if (d < bd) { bd = d; best = M; }
    }
    ok(best && bd < 0.6, `那辆坡上的车没被提交（最近的一个矩阵差 ${bd.toFixed(2)} m）`);
    if (best) {
      const expF = Math.sin(Math.atan(gTarget)) * target.dir;
      ok(Math.abs(best[9] - expF) < 0.01,
        `坡上的车 fwd 竖直分量 ${best[9].toFixed(4)}，应 ≈ ${expF.toFixed(4)}（坡度 ${(100 * gTarget).toFixed(1)}%）`);
      ok(Math.abs(best[9]) > 0.5 * Math.abs(gTarget),
        `车完全没有俯仰（|fwd.y| = ${Math.abs(best[9]).toFixed(4)}，半个坡度是 ${(0.5 * Math.abs(gTarget)).toFixed(4)}）`);
    }
  }
  /* ④ 落地不再凭空消失：越过高架段端头之后，**只要这条路还在**，车就必须在画面里。
     旧写法 `if (c.deck && dh < 0.4) continue;` 在这里的红字是"路还在、车没了"。 */
  {
    /* 端头要挑在**露天走廊**上：高架段的边界是分区闸门给的，它经常正好落在
       地铁的地下段旁边 —— 那儿连街面都没烘，采样全被 `isElevated` 跳过，
       于是"落地对账"会采到 0 帧并装作通过（第一版就是这么红的）。 */
    let g = null, c0 = null;
    for (const cand of ev.segs) {
      for (const end of [[cand[1], 1], [cand[0], -1]]) {
        const se = end[0], sgn = end[1];
        if (se < 2500 || se > al.total - 2500) continue;
        let open = true;
        for (let k = -600; k <= 600; k += 100) {
          if (!line.isElevated(se + k) || ev.blocked(se + k)) { open = false; break; }
        }
        if (!open) continue;
        const car = st.deckCars.find(c => c.dir === sgn &&
          (sgn > 0 ? (c.s < se && c.s > se - 500) : (c.s > se && c.s < se + 500)));
        if (car) { g = cand; c0 = car; break; }
      }
      if (c0) break;
    }
    ok(!!c0, '全网这条线找不到一个"端头在露天走廊里、且有车正驶出去"的高架段 —— 落地连续性这条量不了');
    if (c0) {
      const rec2 = [];
      const fake2 = { upload: ms => ms.map(m => ({ mat: m.mat, tag: 'street' })),
        drawInstanced: (b, mm) => { if (b.mat === 'carShell') for (const M of mm) rec2.push(M); } };
      let miss = 0, seen = 0, yJump = 0, prevP = null, landed = 0;
      for (let f = 0; f < 300 && c0; f++) {
        st.update(0.1);
        if (!line.isElevated(c0.s) || ev.blocked(c0.s)) continue;
        const q = al.level(al.frame(c0.s));
        const pos = al.world(q, c0.lat + ev.foot(c0.s, c0.cl), al.streetDy(c0.s) + 0.02 + ev.h(c0.s));
        rec2.length = 0;
        st.draw(fake2, pos, 0, 1);
        let bd = 1e9;
        for (const M of rec2) {
          const d = Math.hypot(M[12] - pos[0], M[13] - pos[1], M[14] - pos[2]);
          if (d < bd) bd = d;
        }
        seen++;
        if (bd > 0.6) miss++;
        if (prevP && Math.abs(pos[1] - prevP[1]) > 1.2) yJump++;
        if (ev.h(c0.s) < 0.4 && !ev.seg(c0.s)) landed++;   // 已经在段外、地面上跑过
        prevP = pos;
        if (c0.s > g[1] + 900 || c0.s < g[0] - 900) break;
      }
      ok(seen > 40, `落地对账只采到 ${seen} 帧（采样窗口内这条路不在露天走廊里，换线测）`);
      ok(landed > 0, '这辆 car 根本没走出过高架段（坡道之外仍是段内）—— 落地这一段没被量到');
      ok(miss === 0, `越过端头后有 ${miss}/${seen} 帧"路还在、车没了"—— 落地段仍在凭空蒸发`);
      ok(yJump === 0, `落地途中有 ${yJump} 帧单步高度跳变 > 1.2 m —— 车不是沿坡道开下去的`);
    }
  }
  /* ⑤ 接线 lint：坡道形状必须只有一份函数在算 */
  const swk = fs.readFileSync('./src/world.js', 'utf8'), skk = fs.readFileSync('./src/street.js', 'utf8');
  ok(/SH\.pitchBasis\(/.test(swk) && /SH\.pitchBasis\(/.test(skk),
    'world.js 或 street.js 没走 SH.pitchBasis（桥面斜着、车平着 —— 两边各写一遍俯仰就是两个真值）');
  ok(/ev\.foot\(/.test(swk) && /this\.elev\.foot\(/.test(skk),
    'world.js 或 street.js 没走 elev.foot（落地横向两套算法 = 车开出桥面）');
  ok(/SH\.elevDir\(/.test(skk), 'street.js 的分幅方向没走 SH.elevDir（与地面道路两套规则）');
  ok(/groundLat\(/.test(swk), 'world.js 的桥下地面幅没读 groundLat（落地脚与地面幅各摆各的）');
}

/* ------------------------------------------ I 地面路口信号：灯、停车线、车真停
 * 目标里"路上也得有汽车…公交车和公交车站吧，也要拉满"缺的最后一环：
 * 以前斑马线画在出入口外，路上却没有任何东西能让车停下 —— 行人过的是
 * 一条永远直行的马路。这一节量四件事：
 *   ① 路口表本身（出入口 + 绝对网格、编号决定相位偏移）；
 *   ② 灯杆/灯箱/三枚镜片/停车线**真的烘出来了**（登记 ↔ 顶点成对）；
 *   ③ 灯色按周期走、两股反向互斥、不同路口不同步（全线同色 = 停电不是信号）；
 *   ④ 车真的会停：红灯期间不许有车头越过停车线，且确实有车排在线前。 */
{
  const J = SH.JUNCTION, jx = SH.junctions(line);
  ok(jx.length > 8, `本线只判出 ${jx.length} 个路口（出入口 2×露天站 + 每 ${J.pitch} m 一条横街）`);
  const gaps = jx.slice(1).map((j, i) => j.s - jx[i].s);
  ok(jx.every(j => j.i >= 0 && j.s >= 0 && j.s <= al.total), '路口编号/里程越界');
  /* ① 出入口那两处必须在斑马线上（与 world.js 的 crossing() 同一判据） */
  let exitOk = 0, exitTot = 0;
  for (let i = 0; i < line.stations.length; i++) {
    const ss = al.stationS[i];
    if (!line.isElevated(ss)) continue;
    for (const ex of SH.PLATFORM_EXITS) {
      exitTot++;
      if (jx.some(j => Math.abs(j.s - (ss + ex)) < 1)) exitOk++;
    }
  }
  ok(exitOk === exitTot && exitTot > 0, `露天站出入口的斑马线有 ${exitOk}/${exitTot} 处配到信号灯（其余是"有人行横道却没灯"）`);
  /* ② 灯与停车线的几何：挑一个路口烘出来，按登记的镜片位置找顶点 */
  const jj = jx.find(x => line.isElevated(x.s) && x.s > 500 && x.s < al.total - 500) || jx[0];
  {
    const sign = new SH.textures.SignAtlas(2048);
    const w = new SH.WorldBuilder({ al, color: SH.LINES[LINE].color, stations: line.stations, sign, night: 0.62, profile: line.profile });
    w.ambient = [0.26, 0.29, 0.36]; w.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; w._installLight();
    SH.WorldBuilder.buildRuns(w, line, jj.s - 400, jj.s + 400, null);
    const meshes = w.b.finish();
    const sigs = (w.streetItems || []).filter(x => x.kind === 'roadSignal');
    ok(sigs.length >= 2, `路口 ${Math.round(jj.s)} 只烘出 ${sigs.length} 盏信号灯（两股方向至少各一盏）`);
    let lensHit = 0, stopHit = 0;
    for (const sg of sigs) {
      let n = 0;
      for (const m of meshes) {
        if (m.mat !== 'metal') continue;
        for (let i = 0; i + 2 < m.pos.length; i += 3) {
          if (Math.abs(m.pos[i] - sg.head[0]) < 0.9 && Math.abs(m.pos[i + 1] - sg.head[1]) < 1.5
            && Math.abs(m.pos[i + 2] - sg.head[2]) < 0.9) n++;
        }
      }
      if (n >= 8) lensHit++;
      /* 停车线：登记里程上、本半幅车道里必须有白色 paint 顶点 */
      const q = al.level(al.frame(sg.stopS)), o = al.world(q, 0, al.streetDy(sg.stopS));
      let p = 0;
      for (const m of meshes) {
        if (m.mat !== 'paint') continue;
        for (let i = 0; i + 2 < m.pos.length; i += 3) {
          const dx = m.pos[i] - o[0], dz = m.pos[i + 2] - o[2], dy = m.pos[i + 1] - o[1];
          const lt = sg.side * (dx * q.r[0] + dz * q.r[2]), ac = dx * q.f[0] + dz * q.f[2];
          if (Math.abs(ac) > 3 || dy < 0 || dy > 0.2) continue;
          if (lt < SH.ROAD.median || lt > SH.ROAD.edge) continue;
          p++;
        }
      }
      if (p >= 4) stopHit++;
    }
    ok(lensHit === sigs.length, `灯箱与镜片几何：${lensHit}/${sigs.length} 盏在登记位置量到金属顶点`);
    ok(stopHit === sigs.length, `停车线：${stopHit}/${sigs.length} 条在本方向半幅车道里量到白色顶点`);
  }
  /* ③ 灯色：周期、互斥、不同步 */
  {
    const seen = new Set();
    for (let t = 0; t < J.cycle; t++) seen.add(SH.roadLamp(t, 0, 1));
    ok(seen.has('green') && seen.has('amber') && seen.has('red'), `一个周期里只出现 ${[...seen]}（三档必须都有）`);
    let g = 0, a = 0, r = 0;
    for (let t = 0; t < J.cycle; t++) { const L = SH.roadLamp(t, 0, 1); if (L === 'green') g++; else if (L === 'amber') a++; else r++; }
    ok(g === J.green && a === J.amber && r === J.cycle - J.green - J.amber,
      `相位时长与型式表不符：绿 ${g} / 黄 ${a} / 红 ${r}，表上 ${J.green}/${J.amber}/${J.cycle - J.green - J.amber}`);
    let both = 0, redLen = 0;
    for (let t = 0; t < J.cycle; t += 1) {
      const p1 = SH.roadLamp(t, 3, 1), p2 = SH.roadLamp(t, 3, -1);
      if (p1 === 'green' && p2 === 'green') both++;
      if (p1 === 'red') redLen++;
    }
    ok(both === 0, `两股反向同时绿灯 ${both} 秒 —— 冲突相位，车会撞在路口中间`);
    ok(redLen >= 20, `本方向的红灯只有 ${redLen} 秒/周期 —— 行人过街相位（出入口外那条斑马线）不够`);
    const at = new Set(jx.slice(0, 12).map(j => SH.roadLamp(20, j.i, 1)));
    ok(at.size >= 2, `第 20 秒时前 12 个路口的灯色只有 ${[...at]} 一种 —— 全线同色是停电，不是信号`);
    /* ---- ⑤ 行人相位与汽车信号联动（§7.9）----
       walk 与任一方向的 green/amber 重叠 = 人车冲突（安全属性，逐秒对账）；
       walk 窗口 ≥ 斑马线过街时长（crossLat 双向 25 m ÷ 1.2 m/s ≈ 21 s）；
       闪烁（清空尾差）≤ 6 s；三个相位在周期里都得出现（恒 red 或恒 green 的
       行人灯不是联动，是贴错图）。 */
    {
      let clash = 0, walkLen = 0, flashLen = 0, dontLen = 0;
      for (let t = 0; t < J.cycle; t++) {
        const w = SH.walkLamp(t, 3);
        if (w === 'walk') walkLen++;
        else if (w === 'flash') flashLen++;
        else dontLen++;
        if (w !== 'dont' && (SH.roadLamp(t, 3, 1) !== 'red' || SH.roadLamp(t, 3, -1) !== 'red')) clash++;
      }
      const crossSec = Math.ceil(25 / 1.2) + 4;   // 斑马线横向 25 m（crossing() 的涂装长度）
      ok(clash === 0, `行人通行/闪烁与机动车绿灯重叠 ${clash} 秒 —— 行人相位没跟汽车信号联锁，是人车冲突`);
      ok(walkLen >= crossSec, `行人通行只有 ${walkLen} s（斑马线 25 m ÷ 1.2 m/s 需 ≥${crossSec} s）—— 人还没过完街就变灯`);
      ok(flashLen > 0 && flashLen <= 6, `闪烁清空段 ${flashLen} s（应 1~6 s）—— 没有清空段就是把人晾在斑马线上`);
      ok(dontLen > 0, '行人灯整周期没有一个禁行秒 —— 联动名存实亡');
      const phases = new Set([0, 20, 40].map(t => SH.walkLamp(t, 3)));
      ok(phases.size >= 2, `行人灯抽样相位只有 ${[...phases]} 种 —— 恒亮等于没联动`);
    }
  }
  /* ④ 车流真的停：跑两个周期，逐帧查"红灯越线"，并确认线前有排队 */
  {
    const st2 = new SH.street.StreetTraffic(line);
    const near = jx.filter(j => Math.abs(j.s - jj.s) < 900);
    st2.cars.forEach((c, i) => { if (!c.deck) c.s = near[i % near.length].s - 260 * (i % 2 ? 1 : -1); });
    /* 先把车放下再跑 60 s 让它稳定：瞬移会把车直接摆在某条停车线前 2 m、
       时速 36 km —— 那一列物理上刹不住， counted 成"闯红灯"是测试自己造的。 */
    for (let k = 0; k < 240; k++) st2.update(0.25);
    let ran = 0, queued = 0, stopped = 0, checked = 0, committed = 0;
    for (let k = 0; k < J.cycle * 4; k++) {
      const before = st2.cars.map(c => ({ s: c.s, side: c.side, deck: !!c.deck, v: c.v }));
      st2.update(0.25);
      for (const j of jx) for (const side of [-1, 1]) {
        if (SH.roadLamp(st2.clock, j.i, side) !== 'red') continue;
        const stopS = SH.junctionStop(j, side);
        st2.cars.forEach((c, i) => {
          if (c.deck || c.side !== side) return;
          const dWas = (stopS - before[i].s) * side, dNow = (stopS - c.s) * side;
          /* 只判"本来刹得住却越线"的车：刹车距离 v²/2a 算给它的上一帧速度。
             黄灯末了已经贴在线前 3 m、时速 36 km 的那一列物理上停不住，
             把它算成闯红灯会得到 42 帧次/4 个周期的假数（实测）。
             而控制器一旦不看灯，越线的就是**全部**车 —— 这条照样红。 */
          const brake = before[i].v * before[i].v / (2 * st2.brake) + 1.5;
          if (dWas > 0 && dWas < 60) {
            checked++;
            if (dNow < 0) { if (dWas > brake) ran++; else committed++; }
            if (dNow > -1 && dNow < 25) queued++;
            if (c.v < 0.4) stopped++;
          }
        });
      }
    }
    ok(checked > 200, `红灯期间只有 ${checked} 帧次"车在线后来回看"，样本太少说明车根本没靠近路口`);
    ok(ran === 0, `红灯期间有 ${ran} 帧次"刹得住却越线"（另有 ${committed} 帧次是物理上停不住的committed越线，不计）`);
    ok(committed < ran + checked * 0.05, `刹不住的车占比 ${(100 * committed / Math.max(1, checked)).toFixed(1)}% —— 控制器几乎总是在线前才决定刹车`);
    ok(stopped > 0 && queued > 0, `红灯前排队的车：线后 25 m 内 ${queued} 帧次、其中停稳 ${stopped} 帧次`);
    /* 定量的控制器检查。统计口径会被公交排队糊过去 —— 实测把信号 cap 整个撤掉，
       4 个周期里仍然 0 越线，因为车多半被公交挡住了。所以这里单独摆一列
       80 m 外、54 km/h 的**空车**（全网只剩它），挑一个此刻对本方向是红灯的路口，
       跑 15 s：它必须停在线前。撤掉控制器，这条立刻红。 */
    {
      const st3 = new SH.street.StreetTraffic(line);
      const car = st3.cars.find(c => !c.deck) || st3.cars[0];
      st3.cars = [car]; st3.deckCars = [];
      car.kind = 'sedan'; car.lane = SH.ROAD.lanes[0]; car.lat = car.lane; car.dwell = 0; car.stopS = null;
      let j2 = null, clk = 0, stopS = 0;
      /* 必须挑"车眼下最近的那个路口"：路口之间可以只隔一百多米（出入口与
         绝对网格叠在一起），摆好车之后 `_nextJunction` 会返回另一个 —— 控制器
         听最近那盏灯是对的，测试的前提就错了（第一版就是这么假红）。 */
      for (const j of st3.jx) {
        /* 必须用 st3 自己那份表：`SH.junctions` 每次都新建对象，跨数组比身份永远不相等 */
        const sp = SH.junctionStop(j, car.side);
        car.s = sp - 80 * car.side;
        if (st3._nextJunction(car) !== j) continue;
        for (let t = 1; t < J.cycle; t++) {
          /* 车到线要 ~6 s：那之后灯还得是红的，否则"它该通行"也没错 */
          if (SH.roadLamp(t, j.i, car.side) === 'red' && SH.roadLamp(t + 7, j.i, car.side) === 'red') {
            j2 = j; clk = t; stopS = sp; break;
          }
        }
        if (j2) break;
      }
      ok(!!j2, '找不到一个"车前 80 m、且接下来 7 s 都是红灯"的路口，控制器这条测不了');
      if (j2) {
        car.v = 15; st3.clock = clk; car.s = stopS - 80 * car.side;
        for (let k = 0; k < 60; k++) st3.update(0.25);
        const d = (stopS - car.s) * car.side;
        ok(d > -0.5 && car.v < 0.6,
          `红灯前 80 m、54 km/h 的一列空车：15 s 后离停车线 ${d.toFixed(1)} m、速度 ${car.v.toFixed(2)} m/s（必须停在线前）`);
      }
    }
    /* 运行时灯头：三档各画一次，实例数必须跟着灯色走 */
    let drawn = [];
    const fake = { upload: ms => ms.map(m => ({ mat: m.mat, tag: 'street' })), drawInstanced: (b, mats) => { drawn.push(mats.length); } };
    st2.attach(fake);
    const q = al.level(al.frame(jj.s)), eye = al.world(q, 0, 4);
    drawn = []; st2.drawSignals(fake, eye, 0); const n1 = st2._signalsDrawn || 0;
    drawn = []; st2.clock += J.cycle / 2; st2.drawSignals(fake, eye, 0); const n2 = st2._signalsDrawn || 0;
    ok(n1 > 0 && n2 > 0, `路口灯头实例：${n1} / ${n2}（0 = 灯箱烘了但灯从来没亮）`);
    ok(drawn.length > 0, '灯头没有提交任何批次');
  }
  /* ⑤ 同源 lint：几何与车流都必须走 SH.junctions / SH.junctionStop / SH.roadLamp */
  {
    const sw = fs.readFileSync('./src/world.js', 'utf8'), ss2 = fs.readFileSync('./src/street.js', 'utf8');
    ok(/SH\.junctions\(/.test(sw) && /SH\.junctions\(/.test(ss2), 'world.js 或 street.js 没走 SH.junctions（灯位与让停点会各算一套）');
    ok(/SH\.junctionStop\(/.test(ss2) && /SH\.junctionStop\(/.test(fs.readFileSync('./src/core.js', 'utf8')), '停车线里程没走 SH.junctionStop（烘的线与车停的线会错开）');
    ok(/SH\.roadLamp\(/.test(ss2), 'street.js 没走 SH.roadLamp（车停不停与灯亮不亮无关）');
  }
}

/* ------------------------------------------------------- I. 斑马线上真的过街的人（§7.9 剩下的那半条）
   行人灯早就联动了，可路上从来没有人在过街 —— "灯给人看"只做了一半。
   这一节量四件事，全部是**跑出来的**，不是读源码：
     ① 每一处斑马线（= `SH.junctions` 里 `exit` 那批，与 world.js 烘条纹同一份）
        都有人走，且每处不止一个人；
     ② **安全属性**：机动车红灯期间（= 行人 'dont'）斑马线上必须一个人都没有。
        这条不是靠"人只在看得到绿灯时走"就成立 —— 踏上斑马线之前还要确认
        **剩下的行人时间够走完**，否则人会被放到车道中央然后灯就变了
        （第一版就是这么写的：只看 `lamp !== 'dont'`，实测 1.35% 的采样是
        "人在带上而灯已红"）；
     ③ 过街耗时不超过配时预算（25 m ÷ 1.2 m/s ≈ 20.8 s ≤ walk 26 s + flash 4 s），
        且**改速度必须连带改配时** —— 这条断言直接读两张表算，不写死秒数；
     ④ 斑马线的位置/侧向只有一处出处（world.js 从 `wb._jx` 取，不再自己数
        `SH.PLATFORM_EXITS`），否则会出现"画了线的地方没人过、有人的地方没线"。 */
console.log('—— 过街行人 ——');
{
  const st9 = new SH.street.StreetTraffic(line);
  const cx = st9.jx.filter(j => j.exit);
  ok(cx.length > 0, `${line.name} 上没有一处斑马线（SH.junctions 的 exit 条目为空）`);
  ok(st9.peds.length >= 2 * cx.length,
    `每处斑马线至少两个人：${cx.length} 处 / ${st9.peds.length} 人`);
  const J = SH.JUNCTION, need = J.crossLen / SH.PAX_WALK_V;
  const p0 = J.green + J.amber, win = (2 * p0 - 4) - p0 + 4;      // walk 段 + flash 段
  ok(need <= win, `走完斑马线要 ${need.toFixed(1)} s，行人窗口只有 ${win} s（walk ${p0 - 4} + flash 4）—— 配时与步行速度脱钩了`);
  let onStrip = 0, dontOn = 0, done = 0, maxT = 0;
  const ever = new Set();
  for (let f = 0; f < 7200; f++) {                              // 1 小时仿真
    st9.update(0.5);
    for (const p of st9.peds) {
      const on = p.u > 0.001 && p.u < 0.999;
      if (on) {
        onStrip++; ever.add(p.j.i);
        if (st9.pedLamp(p) === 'dont') dontOn++;
      }
      if (on && !p._on) p._t0 = st9.clock;
      if (!on && p._on) { done++; const t = st9.clock - p._t0; if (t > maxT) maxT = t; }
      p._on = on;
    }
  }
  ok(onStrip > 0 && done > 0,
    `1 小时仿真里确实有人在过街：带上采样 ${onStrip}、完成过街 ${done} 次`);
  ok(!dontOn,
    `机动车红灯期间斑马线上没人（${onStrip} 个"人在带上"的采样里 ${dontOn} 个撞上 'dont'）—— 上桥前要核对剩下的行人时间够不够走完`);
  ok(maxT > 0 && maxT <= need + 2,
    `单次过街最长 ${maxT.toFixed(1)} s ≤ 预算 ${need.toFixed(1)} s + 2 s（超出说明有人被留在车道上）`);
  ok(ever.size === cx.length,
    `每一处斑马线在 1 小时里都有人走过：${ever.size}/${cx.length}（漏的那几处=行人与斑马线脱钩）`);
  {
    const sw = fs.readFileSync('./src/world.js', 'utf8');
    ok(/for \(const j of wb\._jx\) if \(j\.exit && j\.si === i\) wb\.crossing\(j\.s, j\.side\);/.test(sw)
      && !/wb\.crossing\(ss \+ ex, side\)/.test(sw),
      'world.js 烘斑马线不再自己数 SH.PLATFORM_EXITS（位置与侧向必须走 SH.junctions 那一份，与过街行人同源）');
  }
}

/* ------------------------------------------------- K 分级推进（帧率账）
 * `street.update` 一轮要过 7788 辆车，实测每帧 2.4 ms —— 占掉 60 fps 预算的四成多，
 * 而 draw 只画相机眼点 480 m 内的车。所以 update 分两档：近档全量、远档只推进。
 * 这一组量的就是"分级到底买了什么、代价被限制在哪"：
 *   ① 被画出来的那 480 m 里不许有重叠（远档不跟驰，远处会叠 —— 那部分根本不上屏）；
 *   ② 近档半径必须 ≥ 画程的三倍（两个常数分别写在两处，关系必须由判据钉住）；
 *   ③ **不传相机时一律全量** —— 否则本文件其它所有判据量的都是被裁过的交通；
 *   ④ 远档必须仍在前进（镜头转过去看到一排停着的车 = 省错了方向）；
 *   ⑤ 分级必须真的省时间（同机时测，阈值给得很松）。 */
{
  const srcTxt = fs.readFileSync('./src/street.js', 'utf8');
  const mNear = srcTxt.match(/const NEAR_S = ([0-9.]+)/);
  const mDraw = srcTxt.match(/draw\(r, eye[^)]*\)[\s\S]{0,400}?(480) \* (480)/);
  ok(!!mNear && !!mDraw, `读不到近档半径或画程常数（NEAR_S=${mNear && mNear[1]}、draw 半径=${mDraw && mDraw[1]}）—— 这两个数换了写法，这条判据就瞎了`);
  if (mNear && mDraw) ok(+mNear[1] >= 3 * +mDraw[1],
    `近档半径 ${mNear[1]} m 不足画程 ${mDraw[1]} m 的三倍 —— 被画出来的车必须已经在全量档里跑稳`);

  const total = line.al.total;
  const camS = al.stationS[(line.stations.length / 2) | 0];
  const stK = new SH.street.StreetTraffic(line);
  const t0 = Date.now();
  for (let f = 0; f < 3600; f++) stK.update(1 / 60, camS);
  const msCull = Date.now() - t0;
  /* ① 画程内的同车道净距 */
  const DRAW_R = mDraw ? +mDraw[1] : 480;
  const byLane = new Map();
  let drawn = 0;
  for (const c of stK.cars) {
    if (c.deck) continue;
    let d = Math.abs(c.s - camS); if (d > total / 2) d = total - d;
    if (d > DRAW_R) continue;
    drawn++;
    const k = c.side + '|' + Math.round(c.lat * 10);
    let a = byLane.get(k); if (!a) { a = []; byLane.set(k, a); } a.push(c);
  }
  let worst = Infinity;
  for (const a of byLane.values()) {
    if (a.length < 2) continue;
    a.sort((x, y) => (x.s - y.s) * a[0].side);
    for (let i = 0; i + 1 < a.length; i++) {
      const g = (a[i + 1].s - a[i].s) * a[i].side - 4.6;
      if (g < worst) worst = g;
    }
  }
  ok(drawn > 20, `跑 60 s 之后画程 ${DRAW_R} m 内只剩 ${drawn} 辆车 —— 分级把车分没了，不是省了 CPU`);
  ok(worst >= 3, `画程内最小同车道净距 ${worst.toFixed(2)} m（应 ≥3）—— 远档的叠车跑到镜头前了`);
  /* ④ 远档仍在前进 */
  const farCar = stK.cars.find(c => {
    let d = Math.abs(c.s - camS); if (d > total / 2) d = total - d;
    return d > 5000 && !c.deck;
  });
  ok(!!farCar, '找不到 5 km 外的车（这条没法量远档）');
  if (farCar) {
    const s0 = farCar.s, v0 = farCar.baseV;
    stK.update(1 / 60, camS);
    ok(Math.abs(farCar.s - s0) >= v0 / 60 * 0.5,
      `远档车这一帧只走了 ${Math.abs(farCar.s - s0).toFixed(2)} m（基准 ${v0.toFixed(1)} m/s）—— 镜头转过去会看到一排停着的车`);
  }
  /* ③ 不传相机 = 全量档。这条不能拿"远处那辆车走了多远"来量 —— 全量档里它本来
      就会因为红灯和排队而慢下来（实测 1 s 只走 11 m，那是它在刹车，不是被裁掉）。
      能分清两条路的只有"远档恒速"这个特征，加上源码 lint 说清门在哪。 */
  ok(/cull = camS == null \? null/.test(srcTxt),
    '源码里"不传相机就全量"那道门不见了 —— 本文件其它判据量的都会是被裁过的交通');
  {
    const s0 = farCar.s, want = farCar.baseV / 60;
    stK.update(1 / 60, camS);
    let d = Math.abs(farCar.s - s0); if (d > total / 2) d = total - d;
    ok(Math.abs(d - want) < 1e-6, `远档车一帧走 ${d.toFixed(4)} m，基准是 ${want.toFixed(4)} m —— 远档必须是"不看灯不跟驰的恒速推进"`);
  }
  /* ⑤ 分级必须真的省时间（同机时测，阈值给得很松：只要不是 0 收益就该报） */
  const stG = new SH.street.StreetTraffic(line);
  const t1 = Date.now();
  for (let f = 0; f < 1200; f++) stG.update(1 / 60);
  const perFull = (Date.now() - t1) / 1200, perCull = msCull / 3600;
  ok(perCull < perFull * 0.8,
    `分级没省到时间：全量 ${perFull.toFixed(2)} ms/帧 vs 分级 ${perCull.toFixed(2)} ms/帧 —— 那这两档白分`);
}

/* ------------------------------------------------- J 车型剪影（"建模要 Unity 级"）
 * 变体数、draw call、三角形数全都正常，而画面上 SUV 就是"高一点的轿车"、
 * 轮子是一颗压扁的球 —— 这是本项目反复踩过的那一族：**统计指标对得上，造型对不上**。
 * 所以这一组不问"有没有 13 个变体"，直接量每辆车烘出来的网格：
 * 长宽高、paint 的高度分层（三箱式）、轮子在不在下方、玻璃带的高度、
 * 以及"加细节不许加材质族"（批次 = 变体 × 材质，多一族就吃掉帧率余量）。 */
{
  const byKind = {};
  for (const v of st.variants) if (!byKind[v.kind]) byKind[v.kind] = v;
  const kinds = ['sedan', 'suv', 'van', 'taxi', 'bus'];
  ok(kinds.every(k => byKind[k]), `车型表里缺 ${kinds.filter(k => !byKind[k]).join('/')} —— 分型从表上就少了`);
  const scan = (v, mat, fn) => {
    for (const m of (v.groups[mat] || [])) for (let i = 0; i + 2 < m.pos.length; i += 3) fn(m.pos, i, m);
  };
  const bb = k => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const mat in byKind[k].groups) scan(byKind[k], mat, (p, i) => {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    });
    return { L: z1 - z0, W: x1 - x0, H: y1 - y0 };
  };
  const B = {}; for (const k of kinds) B[k] = bb(k);
  /* ① 剪影必须互不相同（这才是"分型"的可证伪定义） */
  ok(B.bus.L >= 10 && B.van.L >= 5.2 && B.suv.L > B.sedan.L,
    `车长分型不对：公交 ${B.bus.L.toFixed(2)}（应 ≥10）、厢式 ${B.van.L.toFixed(2)}（应 ≥5.2）、SUV ${B.suv.L.toFixed(2)} vs 轿车 ${B.sedan.L.toFixed(2)}`);
  ok(B.suv.H >= B.sedan.H + 0.30,
    `SUV 只比轿车高 ${(B.suv.H - B.sedan.H).toFixed(2)} m（应 ≥0.30）—— 离地间隙与座舱高度没有分型，剪影上是一辆车`);
  ok(B.van.H >= B.suv.H + 0.30,
    `厢式车只比 SUV 高 ${(B.van.H - B.suv.H).toFixed(2)} m（应 ≥0.30）—— 厢式车的高顶是它的身份`);
  ok(B.taxi.H > B.sedan.H + 0.05 && Math.abs(B.taxi.L - B.sedan.L) < 0.05,
    `出租与轿车剪影差 ${B.taxi.H.toFixed(2)} vs ${B.sedan.H.toFixed(2)} m —— 顶灯是出租车唯一的剪影特征`);
  /* ② 三箱式：paint 至少分出 4 个高度档（下盘 / 主车身 / 引擎盖与行李箱盖 / 座舱与顶板）。
     一块方板的车身只有 2 档 —— 那正是重写前的样子。 */
  const tiers = k => {
    const s = new Set();
    scan(byKind[k], 'carShell', (p, i) => s.add(Math.round(p[i + 1] / 0.2)));
    return s.size;
  };
  ok(tiers('sedan') >= 4 && tiers('suv') >= 4 && tiers('van') >= 3,
    `车壳高度档：轿车 ${tiers('sedan')}、SUV ${tiers('suv')}、厢式 ${tiers('van')}（应 ≥4/4/3）—— 车身还是一块方板，没有引擎盖/行李箱台阶`);
  /* ③ 轮子：轮胎是**故意没合并**的那一族（橡胶的材质差异看得见，而且 `sphere`
     不写逐顶点色 —— 并进 carShell 之后这条就量不到了，实测五种车型轮子顶点各 0 个）。
     要求：左右成对、前后至少两个轴位、顶面不超过 1.15 m。 */
  for (const k of kinds) {
    let n = 0, pos = 0, neg = 0, yTop = -9;
    const axles = new Set();
    scan(byKind[k], 'steel', (p, i) => {
      n++; if (p[i] > 0) pos++; else neg++;
      if (p[i + 1] > yTop) yTop = p[i + 1];
      axles.add(Math.round(p[i + 2] / 2));
    });
    ok(n > 0 && pos > 0 && neg > 0 && axles.size >= 2,
      `${k} 找不到成对的轮子（steel 顶点 ${n}，正侧 ${pos}、负侧 ${neg}、轴位 ${axles.size}）`);
    ok(yTop <= 1.15, `${k} 的轮子顶到 ${yTop.toFixed(2)} m —— 那不是轮子，是车顶`);
  }
  /* ④ 玻璃带：公交的侧窗必须明显比轿车高（车窗线是车型的第二身份） */
  const glassY = k => { let s = 0, n = 0; scan(byKind[k], 'glassSoft', (p, i) => { s += p[i + 1]; n++; }); return n ? s / n : 0; };
  ok(glassY('bus') > glassY('sedan') + 0.3 && glassY('sedan') > 0.6,
    `侧窗带高度：公交 ${glassY('bus').toFixed(2)}、轿车 ${glassY('sedan').toFixed(2)} —— 玻璃带没有按车型分层`);
  /* ⑤ 前后灯都在车头车尾（z 跨正负），否则夜里看是一辆没有方向的车 */
  {
    let zmin = 9, zmax = -9;
    scan(byKind.sedan, 'light', (p, i) => { if (p[i + 2] < zmin) zmin = p[i + 2]; if (p[i + 2] > zmax) zmax = p[i + 2]; });
    ok(zmin < -1 && zmax > 1, `轿车的灯只在一头（z ${zmin.toFixed(2)}~${zmax.toFixed(2)}）—— 前照灯与尾灯必须各在一头`);
  }
  /* ⑥ 批次对账（第 131 条建，第 135 条改口径）：一辆车的材质族预算是
     carShell（吃涂装）/ carTrim（深色饰条，**不许**吃涂装）/ glassSoft / light /
     steel（轮胎）五族。第 131 条把 paint 与 metal 合成一族是错的：省下的批次是假的
     （网格数没变，只是换名字，实测 draw call 319/320 一动不动），而它把"该染的"与
     "不许染的"混进同一个桶 —— 格栅、门缝、裙板跟着涂装走就不像那辆车了。
     **两头都要量**：总批次有界（5 车型 × 5 族 = 25）+ 车漆是专属族不是借用全局。 */
  const over = st.variants.filter(v => Object.keys(v.groups).length > 5);
  ok(over.length === 0, `${over.length} 个变体用了 5 族以上的材质 —— 批次 = 变体 × 材质，多一族就是五个 draw call`);
  const nb = st.variants.reduce((a, v) => a + Object.keys(v.groups).length, 0);
  ok(nb <= 25, `车辆批次合计 ${nb}（5 车型 × 5 族 = 25 是预算）—— 帧率红线只剩 10 个余量，超了就得先合并再谈细节`);
  const borrowed = st.variants.filter(v => v.groups.paint || v.groups.metal);
  ok(borrowed.length === 0, `${borrowed.length} 个变体的车身还在用全局 paint/metal —— 车漆高光就没法单独调（调 paint 会连着全城标线一起变），上面那条"省批次"也就成了无本之利`);
  ok(st.variants.every(v => v.groups.carShell), '有变体没有 carShell 族 —— 吃涂装的那一族没建起来');
  ok(st.variants.every(v => v.groups.carTrim), '有变体没有 carTrim 族 —— 深色饰条被并进料吃涂装的桶里了');
  ok(st.variants.every(v => v.groups.steel), '有变体的轮胎被并进车壳了 —— 橡胶是这堆零件里唯一材质差异看得见的');
}

/* ---- 第 135 条：按实例给色的那条通道（渲染器侧） ----
   通道在 GL 与 shader 里，离线量不到像素，所以量**结构**：谁有权吃色由材质表
   单点决定、批次标志从表里推导（不许按材质名硬判）、shader 两边都判 `a > 0.5`
   （通用属性默认 (0,0,0,1) —— 少了这道判据，全场景的车都会染黑）。
   实景对账跑 node dev/inst-check.js（实例数 + 像素 A/B + 对照面）。 */
{
  const rs = require('fs').readFileSync('src/renderer.js', 'utf8');
  const errs = [];
  if (!/carShell:\s*\{[^}]*tint:\s*1/.test(rs)) errs.push('carShell 没标 tint:1 —— 没有一族吃实例色，涂装还是得靠烘几何');
  if (/carTrim:[^}]*tint/.test(rs)) errs.push('carTrim 也标了 tint —— 深色饰条会跟着涂装走');
  if (!/MATERIALS\[m\.mat\] && MATERIALS\[m\.mat\]\.tint/.test(rs)) errs.push('批次标志不是从材质表推的（按材质名硬判就是第二个真值）');
  if (!/aIT\.a > 0\.5/.test(rs) || !/uTint\.a > 0\.5/.test(rs)) errs.push('shader 少了一边（实例/GL1）的 a>0.5 判据 —— 默认值会把车染黑');
  if (!/const STR = 20/.test(rs)) errs.push('实例缓冲的步长没写成 20（16 矩阵 + 4 颜色）—— 颜色会盖进矩阵的平移列');
  if (!/data\[off \+ 19\] = tints && b\.tint \? 1 : 0/.test(rs)) errs.push('实例色的 a 不是按批次标志给的 —— 玻璃、灯、轮胎会跟着涂装走（"这辆车是红色的"变成"这辆车是红色玻璃红色轮胎"）');
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 按实例给色的通道结构在位（材质表单点、批次标志推导、两边 a>0.5 判据、步长 20）');
}

console.log(bad ? `\n${bad} 条报红` : `\n街面车流/公交判据全部通过（线 ${LINE}）`);
process.exit(bad ? 1 : 0);
