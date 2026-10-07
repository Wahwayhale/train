/**
 * 立面尺度 + 观景机位视线审计。
 *
 * 两件事都是"看起来没事、其实一直在悄悄退化"的类型，所以做成机器断言：
 *
 *  A. 立面窗格的物理尺寸。一个贴图循环必须等于 FACADE_M 米真实墙面，
 *     窗宽/层高必须落在人能看懂的范围里。历史上这里翻过两次：
 *     1) 循环只覆盖 3.2 m 却塞 8×8 格 ⇒ 0.4 m 的窗，近看整面楼是雪花屏；
 *     2) ringStack 的 u 用 i/seg（整圈一个循环）、cylY 的 v 恒等于 0，
 *        于是塔楼的窗横竖各按不同尺度走，裙房完全平色。
 *     ⇒ 逐三角形反解"每米多少个 UV 循环"，必须 ≈ FACADE_UV。
 *
 *  B. 观景相机能不能真的看见那个地标。机位表 SHOT 写在 game.js 里，
 *     但它和 world.city 的楼群参数是分开的两处代码——任何一方被调过，
 *     另一方就可能悄悄失效（画面变成一堵别人的立面）。
 *     ⇒ 用 SH.CITY_BAND 推出"保证空的区域"，逐条视线采样验证。
 */
require('./stub-dom.js');
require('./src/core.js');        // SH 命名空间住在这里，数据要先有落脚点
require('./data/shanghai.js');   // 数据必须在 game.js 之前：SH.STATION_FEATURES 是它的输入
for (const f of ['mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark', 'game']) require('./src/' + f + '.js');
const SH = global.SH;
/* game.js 把 VIEWSPOTS / SHOT / LineRuntime 挂在 SH 上（见文件末尾），
   所以这里直接取，不用再把类源码抠出来 eval。 */
const VIEWSPOTS = SH.VIEWSPOTS, SHOT = SH.SHOT, LineRuntime = SH.LineRuntime;
const C = SH.clamp;
if (!VIEWSPOTS || !SHOT || !LineRuntime) { console.log('✗ game.js 未导出 VIEWSPOTS / SHOT / LineRuntime'); process.exit(1); }

let fail = 0;
const bad = (msg) => { fail++; console.log('  ✗ ' + msg); };

/* ============================================================== A. 窗格尺寸 */
const FM = SH.FACADE_M, FU = SH.FACADE_UV;
console.log(`立面贴图循环 = ${FM} m × ${FM} m（每米 ${FU.toFixed(4)} 个循环）`);
for (const [name, v] of Object.entries(SH.FACADE_VARIANTS)) {
  const w = FM / v.cols, h = FM / v.rows;
  const ok = w >= 0.9 && w <= 2.6 && h >= 2.0 && h <= 4.6;
  if (!ok) bad(`${name} 窗格 ${w.toFixed(2)}×${h.toFixed(2)} m 超出可读范围`);
  console.log(`  ${name.padEnd(9)} ${v.cols}×${v.rows} 格 → 窗宽 ${w.toFixed(2)} m / 层高 ${h.toFixed(2)} m  ${ok ? '✓' : '✗'}`);
  // 真生成一次，触发 facadeTile 内部的尺寸闸门（不合格就抛错）
  try { SH.textures.facadeTile(v.cols, v.rows, v.seed, v.opt); }
  catch (e) { bad(`${name} 生成失败: ${e.message}`); }
}

/* ==================================================== B. 几何上的 UV 尺度 */
/**
 * 三角形上"UV → 世界"若为比例 k 的相似映射，则 面积(uv)/面积(world) = k²，
 * 反解 k 应等于 FACADE_UV。曲面（ringStack 塔身）量的是弦不是弧，误差几个百分点。
 */
function auditUV(batches, tag) {
  let v = 0;
  const seen = [];
  for (const g of batches) {
    const m = SH.MATERIALS[g.mat];
    if (!m || m.mode !== 1 || !/^bldgWin/.test(g.mat)) continue;
    const P = g.pos, U = g.uv, X = g.idx;
    let n = 0, sum = 0, mn = Infinity, mx = -Infinity, out = 0;
    const offs = [];
    for (let t = 0; t + 2 < X.length; t += 3) {
      const a = X[t], b = X[t + 1], c = X[t + 2];
      const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const aw = 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
      const u1 = [U[b * 2] - U[a * 2], U[b * 2 + 1] - U[a * 2 + 1]];
      const u2 = [U[c * 2] - U[a * 2], U[c * 2 + 1] - U[a * 2 + 1]];
      const au = 0.5 * Math.abs(u1[0] * u2[1] - u1[1] * u2[0]);
      if (aw < 0.05 || au < 1e-7) continue;                 // 退化或太小，量不出来
      const k = Math.sqrt(au / aw);
      n++; sum += k; mn = Math.min(mn, k); mx = Math.max(mx, k);
      if (k < FU / 2.2 || k > FU * 2.2) { out++; if (offs.length < 2) offs.push([k, P[a * 3], P[a * 3 + 1], P[a * 3 + 2]]); }
    }
    const ok = n > 0 && Math.abs(sum / n / FU - 1) < 0.25 && out === 0;
    if (!ok) {
      v++;
      bad(`${tag} ${g.mat}: 平均 ${(sum / n).toFixed(4)} vs 应为 ${FU.toFixed(4)}（偏离 ${((sum / n / FU - 1) * 100).toFixed(0)}%），离群 ${out}/${n}`);
      for (const s of offs) console.log(`     离群 k=${s[0].toFixed(4)} 位置 (${s[1].toFixed(0)},${s[2].toFixed(0)},${s[3].toFixed(0)})`);
    }
    seen.push([g.mat, n, sum / n, mn, mx, out, ok]);
  }
  if (!seen.length) console.log(`  ${tag}: 无立面几何`);
  else for (const [m, n, avg, mn, mx, out, ok] of seen)
    console.log(`  ${tag} ${m.padEnd(9)} 三角 ${n.toLocaleString().padStart(7)}  平均 ${avg.toFixed(4)}  区间 [${mn.toFixed(3)}, ${mx.toFixed(3)}]  离群 ${out}  ${ok ? '✓' : '✗'}`);
  return v;
}

/* ============================================ 烘焙几段真实世界，拿来量尺度 */
function bakeDistrict(lineId, s0, s1) {
  const line = new LineRuntime(SH.LINES[lineId]);
  const al = line.al;
  const wb = new SH.WorldBuilder({
    al, color: line.color, color2: line.color2, stations: line.stations,
    sign: new SH.textures.SignAtlas(512), night: 0.62, profile: line.profile,
    waterRanges: line.waterRanges(),     // 与 game.js 的 bake() 一致：跨江点要把街面挖断
    sightClear: SH.sightCorridors(line), // 与 game.js 一致：视廊里的楼真的不盖
  });
  wb.sun = null; wb._installLight();
  const b = wb.b;
  const runs = []; let cur = null;
  for (let s = s0; s <= Math.min(al.total, s1); s += 10) {
    const ns = line.nearStation(s);
    const kind = ns.d < 96 ? 'station' : (line.isElevated(s) ? 'viaduct' : 'tunnel');
    if (!cur || cur.kind !== kind) { cur = { kind, s0: s, s1: s }; runs.push(cur); } else cur.s1 = s;
  }
  for (const rr of runs) {
    const a = Math.max(0, rr.s0 - 22), z = Math.min(al.total, rr.s1 + 22);
    if (z - a < 8) continue;
    if (rr.kind === 'tunnel') { wb.tunnelLights(a, z, 6.2, true); wb.tunnelTube(a, z, {}); wb.track(a, z, {}); }
    else if (rr.kind === 'viaduct') { wb.viaduct(a, z, { pierH: 10 }); wb.city(a, z, SH.hash32(lineId, Math.round(a / 100))); }
    else { const ns = line.nearStation((a + z) / 2); wb.station(ns.s, line.stationSide(ns.i), { name: line.stations[ns.i], en: '', code: '', seed: 1 }); }
  }
  const placed = [];
  for (const sp of (VIEWSPOTS[lineId] || [])) {
    const ss = line.stationSAt(sp.i);
    if (ss == null || !line.isElevated(ss)) continue;
    /* dist 用 == null 判缺省：跨江/跨河类的 dist 就是 0，`|| 900` 会把江搬到 1.8 km 外
       （game.js 同一处踩过，见那里的注释）。测试必须和游戏一致，否则永远测不出来。 */
    const rec = SH.landmarks.place(b, al, ss, sp.side == null ? 1 : sp.side, sp.dist == null ? 900 : sp.dist, sp.kind);
    if (rec) placed.push(Object.assign({}, rec, { name: sp.kind }));
  }
  /* 与 game.js bake() 同序：地标先摆，远景盒体城市再按地标占位挖洞 */
  for (const lm of placed) if (lm.bbox) wb.noBuild.push({
    x0: lm.bbox.min[0], x1: lm.bbox.max[0], z0: lm.bbox.min[2], z1: lm.bbox.max[2] });
  wb.farCity(0, al.total);
  return { line, al, batches: b.finish(), placed, lots: wb.cityLots || [] };
}

const LIDS = (process.argv[2] || 'l3,l6,l17,ml').split(',');
let uvViol = 0;
const baked = {};
for (const id of LIDS) {
  if (!SH.LINES[id]) { bad(`无此线路 ${id}`); continue; }
  baked[id] = bakeDistrict(id, 0, Infinity);
  uvViol += auditUV(baked[id].batches, id);
}
console.log(uvViol ? `✗ 立面 UV 尺度问题 ${uvViol} 处` : '✓ 所有立面几何的 UV 尺度都等于 SH.FACADE_UV');

/* ================================================= C. 观景机位视线是否被挡 */
const BAND = SH.CITY_BAND;
console.log(`\n楼群边界 SH.CITY_BAND：空廊 |横向| < ${BAND.corridor.toFixed(1)} m · 屋脊 ${BAND.roof.toFixed(1)} m · 楼群外 |横向| > ${BAND.outside.toFixed(1)} m`);

/** 世界点 → 里程 / 横向 / 轨面上方高度（40 m 粗搜后 ±80 m 按 2 m 细化） */
function makeLookup(al) {
  const step = 40, fs = [];
  for (let s = 0; s <= al.total + step; s += step) fs.push(al.frame(Math.min(al.total, s)));
  return (p) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i], dx = f.p[0] - p[0], dz = f.p[2] - p[2], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    let best = null, bdist = Infinity;
    const lo = Math.max(0, (bi - 2) * step), hi = Math.min(al.total, (bi + 2) * step);
    for (let s = lo; s <= hi; s += 2) {
      const f = al.frame(s), dx = f.p[0] - p[0], dz = f.p[2] - p[2], d = dx * dx + dz * dz;
      if (d < bdist) { bdist = d; best = f; }
    }
    const f = best;
    return {
      s: f.s,
      lat: (p[0] - f.p[0]) * f.r[0] + (p[1] - f.p[1]) * f.r[1] + (p[2] - f.p[2]) * f.r[2],
      up: (p[0] - f.p[0]) * f.u[0] + (p[1] - f.p[1]) * f.u[1] + (p[2] - f.p[2]) * f.u[2],
    };
  };
}

/** 观景机位：调 game.js 里唯一那份实现（SH.scenicShot）。
    这里以前自己复刻了一份，于是游戏按主体高度把相机降下来之后，
    测试还在验一套已经不存在的相机——两份代码迟早分家，别再抄。 */
function shotPoints(al, lm, trainS) {
  const q = SH.scenicShot({ al }, lm, trainS, Math.abs(lm.s - trainS));
  return { sh: q.sh, eye: q.eye, look: q.look };
}

let camViol = 0, camChecked = 0, frameViol = 0;
for (const id of LIDS) {
  const d = baked[id];
  if (!d) continue;
  const water = d.line.waterRanges() || [];
  for (const lm of d.placed) {
    const al = d.al, lk = makeLookup(al);
    const sp = shotPoints(al, lm, lm.s);
    /* 景观视廊（第 87 条）：低机位的视线穿过楼群带的那一小段被 city() 清空，
       通视判据必须按**同一张表**豁免，否则它量的还是"假设楼群带满铺"。 */
    const corr = (SH.sightCorridors ? SH.sightCorridors(d.line) : [])
      .filter(c => Math.sign(c.side) === Math.sign(lm.side || 1));
    /* 视廊必须是**真的空**，不是"判据假设它空"：直接数 cityLots。
       少了这一条，city() 里那个跳过被删掉、豁免又照给，测试照样全绿 ——
       负控 sightclr 就是冲这个来的。 */
    for (const c of corr) {
      const inCorr = d.lots.filter(l => l.side === c.side && l.s >= c.s0 && l.s <= c.s1);
      if (inCorr.length) bad(`${id} ${lm.name}: 视廊 [${Math.round(c.s0)}, ${Math.round(c.s1)}] 里还有 ${inCorr.length} 栋楼 —— city() 的视廊跳过没生效`);
    }
    /* 低机位（低于楼群屋脊）必须有视廊兜底：没有视廊的低机位是在赌
       "那一排恰好是空地"，城市一加密就塌。 */
    if (sp.sh.mode === 'side' && sp.sh.h < SH.CITY_BAND.roof && !corr.length) {
      bad(`${id} ${lm.name}: 侧景机位高 ${sp.sh.h} m < 屋脊 ${SH.CITY_BAND.roof.toFixed(1)} m，但 sightCorridors 没有给它挖视廊 —— 通视全靠运气`);
    }
    camChecked++;
    const hits = [];
    let binding = null;   // 楼群里那个"最危险的采样点"，用来判断余量还剩多少
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const p = [sp.eye[0] + (sp.look[0] - sp.eye[0]) * t, sp.eye[1] + (sp.look[1] - sp.eye[1]) * t, sp.eye[2] + (sp.look[2] - sp.eye[2]) * t];
      const q = lk(p);
      /* 限高按**横向位置**查 SH.cityRoofAt —— 它和 city() 用的是同一张车道表。
         以前这里拿全局屋脊比：外侧那条低层带（实际 57 m）会把 71 m 的视线
         判成"被挡"，保守到失真，逼着人去抬相机高度，结果构图先坏。 */
      const cap = SH.cityRoofAt(q.lat);
      const inBand = isFinite(cap);
      const blocked = inBand && q.up < cap;
      if (inBand && (!binding || q.up - cap < binding.clear)) binding = { clear: q.up - cap, lat: q.lat, up: q.up, t };
      // 跨江/跨河点的楼群与街面已被 waterRanges 整段挖掉，但前提是里程真的落在水里
      const overWater = water.some(([a, z]) => q.s >= a - 40 && q.s <= z + 40);
      const inCorr = corr.some(c => q.s >= c.s0 && q.s <= c.s1);
      if (blocked && !inCorr && !(sp.sh.mode === 'cross' && overWater)) hits.push(`t=${t.toFixed(2)} 横向 ${q.lat.toFixed(0)} m 高 ${q.up.toFixed(0)} m < 屋脊`);
    }
    const ok = hits.length === 0;
    if (!ok) { camViol++; bad(`${id} ${lm.name}: 视线被沿街楼群挡住（${hits.length} 处，例：${hits[0]}）`); }
    /* 构图判据：地标必须真的**占住画面**。
       以前这里只查"视线不被挡住"，于是跨江机位拍出来江面只占最下面一条、
       桥小得像根火柴棍，测试却全绿 —— "看得见"和"框得好"是两件事。
       把地标包围盒的 8 个角投到机位屏幕上，取占画面宽/高的比例。 */
    let frame = null;
    if (lm.bbox) {
      const fw = [sp.look[0] - sp.eye[0], sp.look[1] - sp.eye[1], sp.look[2] - sp.eye[2]];
      const fl = Math.hypot(...fw); fw[0] /= fl; fw[1] /= fl; fw[2] /= fl;
      let rt = [fw[2], 0, -fw[0]];                 // 水平右向量
      const rl = Math.hypot(...rt) || 1; rt = rt.map(v => v / rl);
      const up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
      const tan = Math.tan(sp.sh.fov * Math.PI / 360), asp = 16 / 9;
      let w0 = 1e9, w1 = -1e9, h0 = 1e9, h1 = -1e9, behind = 0;
      for (let i = 0; i < 8; i++) {
        const p = [(i & 1) ? lm.bbox.max[0] : lm.bbox.min[0], (i & 2) ? lm.bbox.max[1] : lm.bbox.min[1], (i & 4) ? lm.bbox.max[2] : lm.bbox.min[2]];
        const dx = p[0] - sp.eye[0], dy = p[1] - sp.eye[1], dz = p[2] - sp.eye[2];
        const zc = dx * fw[0] + dy * fw[1] + dz * fw[2];
        if (zc < 1) { behind++; continue; }
        const xc = (dx * rt[0] + dy * rt[1] + dz * rt[2]) / (zc * tan * asp);
        const yc = (dx * up[0] + dy * up[1] + dz * up[2]) / (zc * tan);
        w0 = Math.min(w0, xc); w1 = Math.max(w1, xc); h0 = Math.min(h0, yc); h1 = Math.max(h1, yc);
      }
      if (behind === 8) frame = { cover: 0, note: '全部在机位背后' };
      else {
        const cw = Math.min(2, Math.max(0, w1 - w0)), ch = Math.min(2, Math.max(0, h1 - h0));
        frame = { cover: Math.max(cw, ch) / 2, w: cw / 2, h: ch / 2 };
      }
      if (frame.cover < 0.12) {
        frameViol++;
        bad(`${id} ${lm.name}: 地标只占画面 ${(frame.cover * 100).toFixed(1)}%（宽 ${((frame.w || 0) * 100).toFixed(0)}% 高 ${((frame.h || 0) * 100).toFixed(0)}%）—— ${frame.note || '构图太小，机位要挪'}`);
      }
    }
    const marge = binding ? `最紧处 横向 ${binding.lat.toFixed(0)} m / 高出屋脊 ${binding.clear.toFixed(0)} m` : '视线不进楼群';
    console.log(`  ${id.padEnd(4)} ${lm.name.padEnd(9)} eye 高 ${String(sp.sh.h).padStart(3)} m / 横向 ${String(sp.sh.lat).padStart(3)} m —— ${marge} → ${ok ? '✓ 通视' : '✗ 被挡'}` +
      (frame ? `  画面占比 ${(frame.cover * 100).toFixed(0)}% ${frame.cover >= 0.12 ? '✓' : '✗'}` : ''));
  }
}
console.log(camViol ? `✗ ${camViol}/${camChecked} 个观景机位看不见地标` : `✓ ${camChecked} 个观景机位视线全部通视`);
console.log(frameViol ? `✗ ${frameViol} 个机位地标在画面里太小（<12%）` : `✓ 全部机位的地标画面占比 ≥12%`);

/* ================================================= D. 观景点配置是否真的生效 */
/* VIEWSPOTS 里写一个地标，不代表游戏里看得见它：bake() 只在
   line.isElevated(里程) 为真时才放置它（地下段冒出天际线是穿帮）。
   所以"声明了但永远不会出现"的配置必须当场报错，而不是等人去截图发现。 */
let cfgViol = 0, cfgN = 0;
const generic = [];
const lineOf = id => {
  const base = id.split('#')[0];
  const def = SH.LINES[base];
  if (!def) return null;
  return new LineRuntime(def, id.endsWith('#branch') ? 'branch' : undefined);
};
for (const id of Object.keys(VIEWSPOTS)) {
  const line = lineOf(id);
  if (!line || line.id !== id) { bad(`VIEWSPOTS 里的线路不存在：${id}`); cfgViol++; continue; }
  for (const sp of VIEWSPOTS[id]) {
    cfgN++;
    const ss = line.stationSAt(sp.i);
    if (ss == null) { cfgViol++; bad(`${id} ${sp.kind}@${sp.i}：没有这个站序号（共 ${line.stations.length} 站）`); continue; }
    if (!line.isElevated(ss)) { cfgViol++; bad(`${id} ${sp.kind}@${sp.i} s=${Math.round(ss)} 不在高架/地面段，永远不会被放置`); continue; }
    if (!SHOT[sp.kind]) generic.push(`${id} ${sp.kind}`);        // 走 _default 构图，不算错但值得知道
  }
}
console.log(cfgViol ? `✗ ${cfgViol}/${cfgN} 条观景点配置是死的` : `✓ ${cfgN} 条观景点配置全部落在高架段上`);
if (generic.length) console.log('  走默认构图的观景点（可接受，但值得单独调）：' + generic.join('、'));

/* ================================================= E. 「一站一特色」数据表
 * SH.STATION_FEATURES 是逐站景色的唯一数据源（game.js 的 VIEWSPOTS 惰性派生）。
 * 钉三件事：
 *   ① 覆盖性 —— 用户点名的重点站与三条支线端点站必须各有一条；
 *   ② 合法性 —— kind 必须是 landmark.js 的 BUILDERS 键；落点条目的站名必须
 *      存在、且里程落在该线高架段（地下段冒出天际线是穿帮，与 D 节同规）；
 *   ③ 单一来源 —— VIEWSPOTS 的每一条都必须能对账回数据表（防止有人绕开
 *      数据表往 VIEWSPOTS 里手写条目，两份数据各自漂移）。 */
{
  const F = SH.STATION_FEATURES, KINDS = new Set(SH.LANDMARK_KINDS);
  const REQUIRED = ['陆家嘴', '外滩', '豫园', '虹口足球场', '上海赛车场', '迪士尼', '滴水湖',
    '花桥', '闵行开发区', '航中路', '佘山', '中华艺术宫'];
  let eViol = 0;
  for (const nm of REQUIRED)
    if (!F.some(f => f.name === nm)) { eViol++; bad(`一站一特色缺重点站：${nm}`); }
  const placed = [];
  for (const f of F) {
    if (!f.line || !f.at) { eViol++; bad(`特色条目缺 line/at：${f.name}`); continue; }
    if (f.exit) continue;                                   // 出站即景：不落几何，只记录
    if (!KINDS.has(f.kind)) { eViol++; bad(`${f.name} 的 kind「${f.kind}」不是地标构建器`); continue; }
    if (f.via) {                                            // 经他线呈现：他线必须有同 kind 落点
      const ok = F.some(g => !g.exit && !g.via && g.line === f.via && g.kind === f.kind);
      if (!ok) { eViol++; bad(`${f.name} 的 via=${f.via} 上没有同 kind（${f.kind}）的落点`); }
      continue;
    }
    const line = lineOf(f.line);
    if (!line || line.id !== f.line) { eViol++; bad(`特色条目线路不存在：${f.line}`); continue; }
    const ss = line.stationSAt(f.at);
    if (ss == null) { eViol++; bad(`${f.line} 特色落点站名不存在：${JSON.stringify(f.at)}`); continue; }
    if (!line.isElevated(ss)) { eViol++; bad(`${f.line} ${f.name}（${f.kind}）落点不在高架段，永远不会被放置`); continue; }
    placed.push(f);
  }
  /* 单一来源对账：VIEWSPOTS 每条 = 数据表某条 placed 条目（line+at+kind）。 */
  for (const id of Object.keys(VIEWSPOTS)) for (const sp of VIEWSPOTS[id]) {
    const hit = placed.find(f => f.line === id && f.kind === sp.kind &&
      JSON.stringify(f.at) === JSON.stringify(sp.i));
    if (!hit) { eViol++; bad(`VIEWSPOTS 条目对不回数据表：${id} ${sp.kind}@${JSON.stringify(sp.i)}`); }
  }
  console.log(eViol ? `✗ 一站一特色数据表 ${eViol} 处问题（重点站 ${REQUIRED.length} / 落点 ${placed.length}）`
                    : `✓ 一站一特色数据表：重点站覆盖 ${REQUIRED.length}/${REQUIRED.length}，落点 ${placed.length} 条全部合法，与 VIEWSPOTS 单一来源对账通过`);
}
console.log(fail ? `\n合计问题 ${fail}` : '\n✓ 立面尺度、观景构图、观景点配置全部通过');
process.exitCode = fail ? 1 : 0;
