/* 街区类型学判据（景色那一层的"每站都有说得出的场景"）。
 *
 * 为什么单独一个判据：SH.STATION_FEATURES 只覆盖 33/491 站，其余站在画面上
 * 是同一种楼、同一种树、同一种铺装 —— 那就是"一列地铁穿过一座没有地方的城市"。
 * 现在每站先由地名学、再由径向位置兜底判出街区类型（SH.SCENE_ZONES），
 * 楼高、地块密度、行道树间距/冠幅/树种全部读它。
 *
 * 判据守四件事，缺一都可能是假的：
 *   ① 覆盖 —— 491 站全部有分区，兜底档（other）必须为 0；
 *   ② 分区**进了几何** —— 两个不同分区的走廊，楼高中位数与槽位间距要量得出差别；
 *   ③ 树也要跟着换 —— 同一长度里冠幅顶点数不同；
 *   ④ 街具也要跟着换 —— 路灯型式/杆高/灯距、地块界围墙型式与完成面高、
 *      里弄口是否真的断开、底商店招的间数与发光面，全部"登记 ↔ 烘焙顶点"成对核。
 */
'use strict';
global.window = global;
global.document = { createElement: () => ({ width:0, height:0, getContext: () => ({ fillStyle:'', createLinearGradient:()=>({addColorStop(){}}), createRadialGradient:()=>({addColorStop(){}}), beginPath(){},arc(){},fill(){},rect(){},clip(){},save(){},restore(){},translate(){},fillRect(){},clearRect(){},drawImage(){},fillText(){},strokeText(){},measureText:()=>({width:10}),strokeStyle:'',lineWidth:1,font:'',textAlign:'',textBaseline:'',moveTo(){},lineTo(){},stroke(){},ellipse(){},putImageData(){},createImageData:()=>({data:new Uint8Array(4)}), getImageData:()=>({data:new Uint8Array(4)}) }), style:{setProperty(){}} }), addEventListener(){}, querySelectorAll:()=>[], getElementById:()=>null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({ matches: false });
global.performance = require('perf_hooks').performance;
const fs = require('fs'), path = require('path');
const R = f => path.join(__dirname, f);
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio']) require(R('src/' + f + '.js'));
require(R('data/shanghai.js'));
const SH = global.SH;
const fakeR = {
  textures: { sign: null }, batches: [],
  upload(m) { this.batches.push(...m); return m; },
  dropTag() {}, texFromCanvas() { return {}; }, draw() {}, begin() {}, end() {},
};
const gsrc = fs.readFileSync(R('src/game.js'), 'utf8');
const grab = name => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const ok = (c, m) => { if (!c) fails++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
/* 街具的横向量测窗口：围墙中心线（SH.STREET_WALK.wall）左右各放 1.0 m。
   上限刻意小于"灯杆(63.2)→墙(65.0)"的 1.8 m 间距，灯与墙不会互相串量。 */
const WALL_LO = SH.STREET_WALK.wall - 1.0, WALL_HI = SH.STREET_WALK.wall + 1.0;

/* ---------- ① 覆盖：每一站都要有分区，且兜底必须为 0 ---------- */
const rows = [];
let tot = 0, byName = 0, byRadial = 0, otherN = 0;
const zoneCount = {};
for (const [id, d] of Object.entries(SH.LINES)) {
  const core = [];
  d.stations.forEach((s, i) => { if (SH.CORE_STATIONS.indexOf(s) >= 0) core.push(i); });
  const zs = d.stations.map((s, i) => SH.zoneAtLine(s, i, d.stations.length, core.length > 0, core));
  const kinds = new Set(zs.map(z => z.zone));
  for (const z of zs) { tot++; zoneCount[z.zone] = (zoneCount[z.zone] || 0) + 1; if (z.basis === 'name') byName++; else byRadial++; if (z.zone === 'other') otherN++; }
  rows.push({ id, name: d.name, n: d.stations.length, kinds: kinds.size });
}
ok(otherN === 0, `${tot} 站全部有街区类型；落在"未分类·兜底"的 ${otherN} 站（必须为 0，否则"每站有特色"是文案）`);
ok(byName + byRadial === tot && byName > tot * 0.25,
  `判据来源：地名学 ${byName} 站（${(100 * byName / tot).toFixed(0)}%）、径向兜底 ${byRadial} 站`);
const thin = rows.filter(r => r.n >= 12 && r.kinds < 3);
ok(thin.length === 0, `站数 ≥12 的线路里，分区种类 <3 的有 ${thin.length} 条${thin.length ? '（' + thin.map(t => t.name + ' ' + t.kinds).join('、') + '）' : ''}`);
console.log('  分区分布：' + Object.entries(zoneCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${SH.SCENE_ZONES[k].label} ${v}`).join(' · '));

/* ---------- ②③ 分区要进几何：拿真实线路烘两段走廊来量 ---------- */
const lineCache = {};
function corridor(lineId, si, span) {
  const def = SH.LINES[lineId];
  const line = lineCache[lineId] || (lineCache[lineId] = new LineRuntime(def));
  const sign = new SH.textures.SignAtlas(2048);
  const w = new (class extends SH.WorldBuilder {})({ al: line.al, color: def.color, stations: def.stations, sign, night: 0.62, profile: line.profile });
  w.ambient = [0.26, 0.29, 0.36]; w.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; w._installLight();
  const s = line.al.stationS[si];
  SH.WorldBuilder.buildRuns(w, line, Math.max(0, s - span / 2), s + span / 2, null);
  const lots = (w.cityLots || []).filter(l => Math.abs(l.s - s) <= span / 2);
  const meshes = w.b.finish();
  /* 树冠顶点：高度要相对**街面**量 —— 高架站的街面在轨道以下十几米，
     拿轨道标高当基准会把整排行道树筛成"不存在"。 */
  let fol = 0, roofUp = 0, roofN = 0, roofH = 0, padCol = [0, 0, 0], padN = 0;
  const streetY = line.al.world(line.al.frame(s), 0, line.al.streetDy(s))[1];
  for (const m of meshes) if (m.mat === 'foliage') for (let i = 0; i + 2 < m.pos.length; i += 3) {
    const dy = m.pos[i + 1] - streetY;
    if (dy > 2 && dy < 22) fol++;
  }
  /* 屋顶形式：女儿墙顶在 +0.9 m，凡是 `roof` 材质又高出这个线的顶点，
     就是双坡/退台/锯齿长出来的东西（平屋顶档应当几乎没有）。 */
  /* 屋顶形式要按**每栋楼自己的顶高**量。原来写的是"高出地面 34 m 以上"，
     那是在拿两段的绝对楼高差做对比：低层档哪怕长了双坡屋脊也永远数不到，
     报出来的 0.00 vs 9.83 看着像结论，其实量的是"一边楼矮一边楼高"。 */
  /* 屋顶形式量的是「高出本栋女儿墙顶的 roof 顶点数」。
     楼脚基准必须与生成器同一个：`al.ground(fr, lat, CITY_BAND.base + h/2)` ——
     所以楼顶 = 该 frame 下 B.base 的世界 y 加 h，再加 0.9 的女儿墙。
     前两版分别拿"绝对 34 m"和"footprint 内 roof 顶点的竖向跨度"当基准：
     前者量的是两边楼高不同，后者连 _zoneRoof 整个关掉都还是绿的
     （女儿墙与别的 roof 几何自己就有跨度），都是看着像结论的空指标。 */
  const lots0 = w.cityLots.filter(l => Math.abs(l.s - s) <= span / 2);
  const above = lots0.map(() => 0);
  const hi = lots0.map(() => 0);
  for (const m of meshes) if (m.mat === 'roof') for (let i = 0; i + 2 < m.pos.length; i += 3) {
    for (let li = 0; li < lots0.length; li++) {
      const l = lots0[li];
      if (Math.abs(m.pos[i] - l.x) > l.hw + 1.2 || Math.abs(m.pos[i + 2] - l.z) > l.hd + 1.2) continue;
      const top = line.al.ground(line.al.frame(l.s), 0, SH.CITY_BAND.base)[1] + l.h + 0.95;
      if (m.pos[i + 1] > top) {
        above[li]++;
        if (m.pos[i + 1] - top > hi[li]) hi[li] = m.pos[i + 1] - top;
      }
      break;
    }
  }
  const nz = above.filter(v => v > 0);
  roofUp = above.length ? above.reduce((a, b) => a + b, 0) / above.length : 0;
  roofN = nz.length;
  /* 形状用"最高那根 roof 顶点高出女儿墙多少米"量：平屋顶 0、双坡 ≈1.5、
     阶梯退台 ≈4.3。上一版这里写的是 `Math.max(...above)` —— 那是**顶点条数**
     被当成米打印出来（"30.00 m"），单位错到判据自己都不信自己。 */
  roofH = hi.length ? med(hi.filter(v => v > 0)) : 0;    // 中位数：单栋异常值不该主导一个形式结论

  /* ---- 街具：路灯 / 地块界围墙 / 树穴 / 底商店招 ----
     登记（`world.streetItems`）与烘焙结果**成对**核：只数登记表的话，
     "记了但没建"完全查不出来 —— 那正是换乘通道第一版翻过的坑。
     量法：顶点相对某个里程的横向/纵向坐标（街具的规矩本来就是"离轨道中心
     几米、离街面几米"），沿走廊每 100 m 取一个局部基重新投影，
     免得在曲线上用一条世界轴向的长窗口把整排墙量歪。 */
  const atS = sv => {
    const q = line.al.level(line.al.frame(SH.clamp(sv, 0, line.al.total)));
    return { o: line.al.world(q, 0, line.al.streetDy(q.s)), r: q.r, f: q.f };
  };
  /* 人行道铺装色：只量人行道那**两条断面角棱** —— 横向 57 / 64 m、完成面 +0.16 m。
     两道筛一道都不能少：
     · 逐顶点先把三分量归一（和 = 1，只留色相比例）再平均。顶点色 = 原色 × 光照，
       不归一的话两个窗口各自的光照漂就能冒充色差，nopadzone 实测 rc=0。
     · 必须按横向 + 高度把采样收到人行道上。上一版按"高度 0~1 m 的全部 granite"
       平均，站体地坪、楼脚基座那些**固定花岗岩灰**的顶点比人行道多一个量级
       （东宝兴路走廊 1120 : 238），把色相稀释成中性灰 —— 基线只剩 0.0191，
       量的已经不是铺装，而是"这条走廊里站体几何有多少"。 */
  const PAD_LAT = [56.9, 64.2], PAD_DY = [0.13, 0.19];
  for (let sv = Math.max(0, s - span / 2); sv <= s + span / 2 + 1e-9; sv += 100) {
    const W = atS(sv);
    for (const m of meshes) {
      if (m.mat !== 'granite' || !m.col) continue;
      for (let i = 0; i + 2 < m.pos.length; i += 3) {
        const dx = m.pos[i] - W.o[0], dz = m.pos[i + 2] - W.o[2], dy = m.pos[i + 1] - W.o[1];
        if (dy < PAD_DY[0] || dy > PAD_DY[1]) continue;
        if (Math.abs(dx * W.f[0] + dz * W.f[2]) > 50) continue;
        const lat = Math.abs(dx * W.r[0] + dz * W.r[2]);
        if (lat < PAD_LAT[0] || lat > PAD_LAT[1]) continue;
        const s3 = (m.col[i] + m.col[i + 1] + m.col[i + 2]) || 1;
        padCol[0] += m.col[i] / s3; padCol[1] += m.col[i + 1] / s3; padCol[2] += m.col[i + 2] / s3; padN++;
      }
    }
  }
  const probeWin = (A, latLo, latHi, dyLo, dyHi, mats, halfAlong, side) => {
    let n = 0, up = -1e9; const sample = [];
    for (const m of meshes) {
      if (mats.indexOf(m.mat) < 0) continue;
      for (let i = 0; i + 2 < m.pos.length; i += 3) {
        const dx = m.pos[i] - A.o[0], dz = m.pos[i + 2] - A.o[2], dy = m.pos[i + 1] - A.o[1];
        if (dy < dyLo - 4 || dy > dyHi + 4) continue;           // 先把高楼与树冠粗筛掉
        if (dy < dyLo || dy > dyHi) continue;                   // 再按精确高度带取
        const lt = side * (dx * A.r[0] + dz * A.r[2]);
        const ac = dx * A.f[0] + dz * A.f[2];
        if (lt < latLo || lt > latHi || Math.abs(ac) > halfAlong) continue;
        n++; if (dy > up) up = dy;
        if (sample.length < 4) sample.push([m.mat, +ac.toFixed(2), +dy.toFixed(2)]);
      }
    }
    return { n, up, sample };
  };
  /** 沿 [sA,sB] 每 100 m 量一次并求和（halfAlong=50 正好首尾相接不重复） */
  const probeRun = (sA, sB, latLo, latHi, dyLo, dyHi, mats, side) => {
    let n = 0, up = -1e9;
    for (let sv = sA; sv <= sB + 1e-9; sv += 100) {
      const r = probeWin(atS(sv), latLo, latHi, dyLo, dyHi, mats, 50, side);
      n += r.n; if (r.up > up) up = r.up;
    }
    return { n, up };
  };
  const items = (w.streetItems || []).filter(it => {
    const c = it.kind === 'wall' ? (it.s0 + it.s1) / 2 : it.s;
    return Math.abs(c - s) <= span / 2;
  });
  const lamps = items.filter(it => it.kind === 'lamp');
  const walls = items.filter(it => it.kind === 'wall');
  const pits = items.filter(it => it.kind === 'pit');
  /* 灯头与灯杆：登记点周围找顶点（灯罩下表面那块发光面 + 杆脚）。
     这里给的是**世界轴向**的正方形窗口，所以 r/f 必须是三维基向量：
     写成 [1,0] / [0,1] 时 A.r[2]、A.f[1] 全是 undefined，投影成 NaN，
     而 |NaN| > 阈值为 false —— 横向与纵向两道筛选一起失效，
     于是"登记点附近有没有几何"退化成"全场随便哪儿有没有这个材质"，
     树穴/灯杆两条负控照样绿（nopitgeo 实测 126/126 命中，而坑位已经沉到街面下 6 m）。 */
  let headHit = 0, headTot = 0, poleHit = 0;
  const E = { r: [1, 0, 0], f: [0, 0, 1] };
  for (const lp of lamps) {
    if (probeWin(Object.assign({ o: lp.base }, E), -0.5, 0.5, -0.2, 1.6, ['metal'], 0.5, 1).n > 0) poleHit++;
    for (const hp of lp.hp) {
      headTot++;
      if (probeWin(Object.assign({ o: hp }, E), -1, 1, -0.45, 0.45, ['emissive'], 1.2, 1).n > 0) headHit++;
    }
  }
  /* 围墙：按型式自己的特征材质量"墙上到底有没有东西"，并量出完成面高。
     材质表就是这一档型式的**构成清单**（矮墙+压顶+铁栅 / 砖墙+压顶 / 绿篱 / 护栏 / 围栏）；
     'concreteD' 故意不列 —— 楼脚基座也用它，会把"墙上有没有东西"变成"楼在不在那里"。 */
  const wallMat = { garden: ['brick', 'granite', 'metal'], brick: ['brick', 'granite'],
    hedge: ['foliage'], rail: ['metal'], fence: ['metal'] };
  const wl = {};
  for (const it of walls) {
    const key = it.type;
    if (!wl[key]) wl[key] = { n: 0, up: -1e9, len: 0, gates: 0, gateIn: 0, gateChk: 0, gateOut: 0,
      gateBad: [], runs: 0, unitN: 0, topN: 0, topLen: 0 };
    const side = it.side, mats = wallMat[key] || [];
    const r = probeRun(it.s0, it.s1, WALL_LO, WALL_HI, 0.0, it.h + 0.75, mats, side);
    /* 墙体"顶棱"：扫掠体的顶点只出现在断面四角，所以"每 13 m 一档、每档两个顶角"
       才是墙**连续存在**的证据。只数墙带里的顶点数会把幽灵墙（登记了、扫掠没建）
       放过去 —— 门柱、竖杆各自是盒子，8 个角一样落在带里。这条按 ±0.06 m 卡住墙顶。 */
    const tEdge = 0.02 + it.h;
    const rt = probeRun(it.s0, it.s1, WALL_LO, WALL_HI, tEdge - 0.02, tEdge + 0.06, mats, side);
    wl[key].topN += rt.n; wl[key].topLen += it.s1 - it.s0;
    wl[key].n += r.n; wl[key].up = Math.max(wl[key].up, r.up);
    wl[key].len += it.s1 - it.s0; wl[key].gates += it.gates; wl[key].runs++; wl[key].unitN += it.unitN;
    /* 里弄口要**真的断开**：洞口正中那段（±1.6 m，人刚好走过去）在墙的高度上
       一个砖顶点都不该有；而洞口两侧（离中心 5~25 m）必须还是墙。
       少了这对着，"门洞"就只是墙面上贴的两根柱子。
       两条高度带都是 0.4~2.2：扫掠体的顶点**只落在断面角上**（墙脚 0.02、墙顶 2.12），
       立面中间根本没有顶点 —— 拿 0.5~2.1 去量会把一整面墙量成"没有墙"。
       外侧取 5~25 m 是因为墙体的采样列按 13 m 一档，窗口太窄会一格都碰不到。 */
    if (key === 'brick' && it.gates) {
      const G = SH.WALL_FORMS.brick.gate;
      for (let c = Math.ceil(it.s0 / G) * G, n = 0; c <= it.s1 && n < 8; c += G, n++) {
        wl[key].gateChk++;
        /* ±1.5 m：门柱是 0.86 m 见方的柱，绕线路航向转之后它的**角**到
           |Δs| = 2.2 − 0.61 = 1.59 m（柱心 2.2、对角半径 0.43·√2），
           扫掠段端头经 miter 外伸到 1.99 m。窗口给 1.5 正好落在洞口里；
           再宽 0.1 m 就把门柱自己量成"墙没断"。 */
        const inGap = probeWin(atS(c), WALL_LO, WALL_HI, 0.4, 2.2, mats, 1.5, side);
        if (inGap.n === 0) wl[key].gateIn++;
        else wl[key].gateBad.push([+c.toFixed(1), inGap.n, JSON.stringify(inGap.sample)]);
        wl[key].gateOut += probeWin(atS(c - 15), WALL_LO, WALL_HI, 0.4, 2.2, mats, 10, side).n
          + probeWin(atS(c + 15), WALL_LO, WALL_HI, 0.4, 2.2, mats, 10, side).n;
      }
    }
  }
  /* 底商：登记与烘焙成对 —— 店招那块发光面就在"楼体朝街那一面"的位置上 */
  /* 树穴也一样：登记了 126 个不算数，坑位上那块土得真在顶点里。 */
  let pitHit = 0;
  /* 窗口 1.5 m 而不是 1.2：树穴是 1.8 m 见方、绕该里程航向转的，
     转角 45° 时它的四个角到 (1.27, 0) —— 卡在 1.2 与 1.4 之间就会随曲率忽明忽灭
     （lilong 实测 26/126，把窗口放到 1.5 后 126/126）。 */
  for (const p of pits) {
    if (probeWin(Object.assign({ o: [p.p[0], p.p[1] - 0.05, p.p[2]] }, E),
      -1.5, 1.5, -0.30, 0.10, ['foliage'], 1.5, 1).n > 0) pitHit++;
  }
  const shopLots = lots.filter(l => l.shop);
  let shopHit = 0;
  for (const l of shopLots) {
    const pt = line.al.ground(line.al.frame(l.s), l.side * (l.shop.fl - 0.09), SH.CITY_BAND.base + l.shop.hz);
    const A2 = atS(l.s);
    if (probeWin({ o: pt, r: A2.r, f: A2.f }, -0.7, 0.7, -0.9, 0.9, ['emissive'], 4.5, l.side).n > 0) shopHit++;
  }
  return {
    zone: w.zoneAt(s).key, roof: w.zoneAt(s).roof, lots, fol, roofUp, roofN, roofH, name: def.stations[si],
    pad: padN ? padCol.map(c => c / padN) : null, padHex: w.zoneAt(s).pad, padN,
    lamps, walls, pits, pitHit, headHit, headTot, poleHit, wl, shopN: shopLots.length, shopHit,
    lampSt: med(lamps.map(x => x.st)), lampH: med(lamps.map(x => x.h)),
    lampPitch: pitchOf(lamps), shopRate: w.zoneAt(s).shop,
    wallLen: walls.reduce((a, b) => a + (b.s1 - b.s0), 0),
  };
}
function med(a) { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; }
/* 块色 → 色相比例（三分量和 = 1）：与判据里逐顶点归一同一口径 */
function normHex(hex) { const v = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16)); const s = v[0] + v[1] + v[2]; return v.map(x => x / s); }
function pitchOf(lots) {
  const ss = lots.map(l => l.s).sort((a, b) => a - b);
  const g = []; for (let i = 1; i < ss.length; i++) if (ss[i] - ss[i - 1] > 0.5) g.push(ss[i] - ss[i - 1]);
  return med(g);
}
/* 找两条线里的"梧桐街区"与"郊区新城"各一段来对比：这两档在楼高与密度上
   本来就该差一个量级，量不出差别就说明分区没进几何。 */
/* 对比段按分区挑：找一个判为 wutong 的站与一个判为 suburb 的站，
   并且离线路两端都够 500 m（走廊要烘得出来）。 */
/* 候选站：该分区、且**走廊烘得出楼**（地下站的街面不在烘焙范围内，
   拿它做对比会得到 0 栋楼，然后判据在量空气）。 */
function candidates(zkey) {
  const out = [];
  for (const [id, d] of Object.entries(SH.LINES)) {
    const core = [];
    d.stations.forEach((n, i) => { if (SH.CORE_STATIONS.indexOf(n) >= 0) core.push(i); });
    for (let i = 2; i < d.stations.length - 2; i++)
      if (SH.zoneAtLine(d.stations[i], i, d.stations.length, core.length > 0, core).zone === zkey) out.push([id, i]);
  }
  return out;
}
function firstWithLots(zkey, min) {
  for (const c of candidates(zkey)) { const r = corridor(c[0], c[1], 900); if (r.lots.length >= min) return Object.assign({ at: c }, r); }
  return null;
}
/* 梧桐街区多半在地下段（原租界全线地下），拿不到街面走廊时退一步：
   用"能烘出 ≥8 栋楼"的两个不同分区做对比 —— 对比仍然成立，
   只是不再特指 wutong vs suburb；判据把实际用的分区打出来。 */
function firstAny(exclude) {
  for (const [id, d] of Object.entries(SH.LINES)) {
    const core = [];
    d.stations.forEach((n, i) => { if (SH.CORE_STATIONS.indexOf(n) >= 0) core.push(i); });
    for (let i = 2; i < d.stations.length - 2; i++) {
      const z = SH.zoneAtLine(d.stations[i], i, d.stations.length, core.length > 0, core).zone;
      if (exclude && exclude.indexOf(z) >= 0) continue;
      const r = corridor(id, i, 900);
      if (r.lots.length >= 8) return Object.assign({ at: [id, i] }, r);
    }
  }
  return null;
}
const A = firstWithLots('wutong', 8) || firstWithLots('lilong', 8) || firstAny(null);
const B = (A && firstWithLots('suburb', 8) && firstWithLots('suburb', 8).zone !== A.zone ? firstWithLots('suburb', 8) : null)
  || (A ? firstAny([A.zone]) : null);
const wt = A && A.at, sb = B && B.at;
if (!A || !B || A.zone === B.zone) bad(`找不到能烘出 ≥8 栋楼的 wutong / suburb 走廊（wutong=${!!A} suburb=${!!B}）—— 对比段无从建立`);
console.log(`  对比段：${wt && wt[0]}·${A ? A.name : '-'}(${A ? A.zone : '-'}) ${A ? A.lots.length : 0} 栋 vs ${sb && sb[0]}·${B ? B.name : '-'}(${B ? B.zone : '-'}) ${B ? B.lots.length : 0} 栋`);
if (!A || !B || A.zone === B.zone) {
  bad(`两段走廊分区相同（${A.zone}），这条对比没有意义 —— 换站号`);
} else {
  const hA = med(A.lots.map(l => l.h)), hB = med(B.lots.map(l => l.h));
  ok(hA > 0 && hB > 0 && Math.abs(hA - hB) / Math.max(hA, hB) > 0.3,
    `楼高中位数 ${hA.toFixed(1)} m vs ${hB.toFixed(1)} m（相差 ${(100 * Math.abs(hA - hB) / Math.max(hA, hB)).toFixed(0)}%，应 >30%）—— 分区进了楼高`);
  const pA = pitchOf(A.lots), pB = pitchOf(B.lots);
  ok(pA > 0 && pB > 0 && Math.abs(pA - pB) > 1.5,
    `沿街槽位间距 ${pA.toFixed(1)} m vs ${pB.toFixed(1)} m（相差 ${Math.abs(pA - pB).toFixed(1)} m，应 >1.5）—— 分区进了地块密度`);
  ok(A.fol > 0 && B.fol > 0 && Math.abs(A.fol - B.fol) / Math.max(A.fol, B.fol) > 0.15,
    `行道树冠顶点 ${A.fol} vs ${B.fol}（相差 ${(100 * Math.abs(A.fol - B.fol) / Math.max(A.fol, B.fol)).toFixed(0)}%）—— 分区进了树（间距/冠幅/树种）`);
  /* 屋顶形式与铺装色也必须是**被消费**的，不是数据表里的装饰 */
  const rf = X => X.roofUp;
  ok(A.roof !== B.roof, `两段走廊的屋顶形式档：${A.roof} vs ${B.roof}${A.roof === B.roof ? '（相同，无法对比 —— 换站号）' : ''}`);
  ok(A.roofN > 8 && B.roofN > 8,
    `长出女儿墙的楼：${A.roofN}/${A.lots.length} 与 ${B.roofN}/${B.lots.length} 栋（<8 说明屋顶形式根本没建）`);
  ok(Math.abs(A.roofH - B.roofH) > 0.8,
    `屋顶高出女儿墙的中位高度 ${A.roofH.toFixed(2)} m vs ${B.roofH.toFixed(2)} m（相差应 >0.8 m）—— 形式之间要量得出区别`);
  ok(A.pad && B.pad && A.padN > 40 && B.padN > 40,
    `人行道铺装顶点样本 ${A.padN} / ${B.padN}（太少说明根本没铺到）`);
  if (A.pad && B.pad) {
    /* 逐顶点归一之后三分量和恒为 1，量级（0~255 还是 0~1）已经被消掉，
       色差与对账都直接在 0~1 的色相比例上量。 */
    const d = Math.abs(A.pad[0] - B.pad[0]) + Math.abs(A.pad[1] - B.pad[1]) + Math.abs(A.pad[2] - B.pad[2]);
    ok(d > 0.02, `人行道铺装平均色差 ${d.toFixed(4)}（归一到 0~1，应 >0.02）：${A.pad.map(v=>v.toFixed(3)).join(',')} vs ${B.pad.map(v=>v.toFixed(3)).join(',')}`);
    /* 光"两段不一样"不够 —— 稀释、光照、第三方几何都能造出不一样。
       每一段还要各自对回分区表里那一块色：表↔渲染对账，采样的到底是不是铺装。 */
    const dref = X => { const t = normHex(X.padHex); return Math.abs(X.pad[0] - t[0]) + Math.abs(X.pad[1] - t[1]) + Math.abs(X.pad[2] - t[2]); };
    ok(dref(A) < 0.02 && dref(B) < 0.02,
      `量到的铺装色对回分区表：${A.zone} ${A.padHex} 偏 ${dref(A).toFixed(4)}、${B.zone} ${B.padHex} 偏 ${dref(B).toFixed(4)}（应 <0.02，大就说明采样里混进了别的花岗岩）`);
  }
}
/* ---------- ④ 街具：路灯 / 地块界围墙 / 树穴 / 底商店招 ----------
 * 灯、墙、店招是"街面这一层"最容易被写成数据表的东西：型式在 core.js 里
 * 一排一排地不同，画面上却还是同一条街。所以每一条都问两遍 ——
 * ① 登记了没有，② 登记那个位置到底有没有顶点。 */
{
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '—');
  for (const X of [A, B]) {
    ok(X.lamps.length >= 8, `${X.name}(${X.zone})：路灯登记 ${X.lamps.length} 盏（900 m 走廊少于 8 盏 = 根本没布灯）`);
    ok(X.poleHit === X.lamps.length, `灯杆立起来了：${X.poleHit}/${X.lamps.length} 盏在登记杆脚找到金属顶点`);
    ok(X.headTot > 0 && X.headHit === X.headTot, `灯头有发光面：${X.headHit}/${X.headTot} 个灯头（型式 ${X.lampSt}，${pct(X.headHit, X.headTot)}）`);
    ok(X.pits.length >= 4 && X.pitHit === X.pits.length,
      `树穴：${X.pitHit}/${X.pits.length} 个在登记坑位量到土面顶点（行道树是种在地里的，不是插在混凝土上的玩具）`);
    /* 型式表 ↔ 烘焙结果 直接对账：不这样写的话，"固定 30 m 一盏"这种变异
       靠两段走廊互相一抵消就绿了（实测：lilong/suburb 各退化成 24/20 m）。 */
    const ZL = SH.SCENE_ZONES[X.zone].lamp;
    ok(Math.abs(X.lampPitch - ZL.gap) <= 1.5,
      `灯距实测 ${X.lampPitch.toFixed(1)} m = 型式表 ${X.zone} 档的 ${ZL.gap} m（±1.5）`);
    ok(X.lampSt === ZL.st && Math.abs(X.lampH - ZL.h) <= 0.3,
      `灯型与杆实测 ${X.lampSt} 型式 / ${X.lampH.toFixed(1)} m = 型式表 ${ZL.st} / ${ZL.h} m`);
    const ts = [...new Set(X.walls.map(v => v.type))];
    ok(X.wallLen > 1.1 * 900, `地块界街具长度 ${X.wallLen.toFixed(0)} m（两侧合计；900 m 走廊应 >990 m）型式 ${ts.join('+') || 'none'}`);
    for (const key of Object.keys(X.wl)) {
      const WF = SH.WALL_FORMS[key], r = X.wl[key];
      ok(r.n > 60, `${WF.name}：沿墙带量到 ${r.n} 个特征顶点、${r.runs} 段、竖杆 ${r.unitN} 根`);
      ok(r.topN >= 0.6 * r.topLen / 13,
        `${WF.name} 墙顶棱连续：${r.topLen.toFixed(0)} m 长墙体量到 ${r.topN} 个墙顶顶点（每 13 m 一档、每档 2 个角 → 应 ≥${(0.6 * r.topLen / 13).toFixed(0)}）`);
      ok(r.up >= WF.h * 0.6 && Math.abs(r.up - WF.top) <= 0.35,
        `${WF.name} 实测最高构件 ${r.up.toFixed(2)} m（型式表：墙 ${WF.h} m、顶 ${WF.top} m）`);
    }
    ok(X.shopHit === X.shopN, `店招几何：${X.shopHit}/${X.shopN} 间在"楼体朝街那一面"的登记位置找到发光顶点`);
  }
  ok(A.lamps.length && B.lamps.length && (A.lampSt !== B.lampSt || Math.abs(A.lampH - B.lampH) > 1.5),
    `灯型与杆高按分区换：${A.zone} 型式 ${A.lampSt}·${A.lampH.toFixed(1)} m vs ${B.zone} 型式 ${B.lampSt}·${B.lampH.toFixed(1)} m`);
  ok(Math.abs(A.lampPitch - B.lampPitch) > 3,
    `灯距按分区换：${A.lampPitch.toFixed(1)} m vs ${B.lampPitch.toFixed(1)} m（相差 ${Math.abs(A.lampPitch - B.lampPitch).toFixed(1)} m）`);
  const tA = [...new Set(A.walls.map(v => v.type))].join('+') || 'none';
  const tB = [...new Set(B.walls.map(v => v.type))].join('+') || 'none';
  ok(tA !== tB, `地块界型式按分区换：${A.zone} ${tA} vs ${B.zone} ${tB}（相同就说明围墙只进了数据）`);
  /* 底商是"比例"而不是"开关"：给的百分比与真实铺出来的间数要对得上账 */
  for (const X of [A, B]) {
    const rate = X.lots.length ? X.shopN / X.lots.length : 0;
    if (X.shopRate > 0) ok(X.shopN > 0 && rate > 0.10,
      `${X.name}(${X.zone}) 底商 ${X.shopN}/${X.lots.length} 栋 = ${(100 * rate).toFixed(0)}%（分区给的比例 ${(100 * X.shopRate).toFixed(0)}%，只要求同一量级）`);
    else ok(X.shopN === 0, `${X.name}(${X.zone}) 底商 ${X.shopN} 间（该档不给店招，就必须是 0）`);
  }
  /* 郊野档"什么都不立"也要能被证伪：找到一段 farm 走廊，墙带里不许有顶点 */
  const F = firstWithLots('farm', 3);
  if (!F) bad('找不到能烘出 ≥3 栋楼的"郊野与林带"走廊 —— "郊野没有围墙"这条无法证伪');
  else {
    const n = Object.keys(F.wl).reduce((a, k) => a + F.wl[k].n, 0);
    ok(F.walls.length === 0 && n === 0,
      `${F.name}(farm)：围墙登记 ${F.walls.length} 段、墙带顶点 ${n} 个（郊野本来就没有地块界墙，两者都必须为 0）`);
  }
  /* 里弄口必须真的断开：洞口那段没墙、洞口两侧还是墙 */
  const BR = firstWithLots('lilong', 5) || firstWithLots('oldtown', 5);
  if (!BR) bad('找不到能烘出 ≥5 栋楼的里弄/老城厢走廊 —— 弄口"挖断"这条无法证伪');
  else {
    const r = BR.wl.brick;
    ok(!!r && r.gates > 0, `${BR.name}(${BR.zone})：砖墙登记 ${r && r.gates} 个弄口（${r && r.runs} 段）`);
    ok(!!r && r.gateChk > 0 && r.gateIn === r.gateChk && r.gateOut >= 4 * r.gateChk,
      `弄口真的断开：查了 ${r && r.gateChk} 个洞口、${r && r.gateIn} 个内侧无墙；洞口两侧 5~25 m 处合计 ${r && r.gateOut} 个砖墙顶点（每口应 ≥4）`
      + (r && r.gateBad.length ? '；未断开的洞口 ' + JSON.stringify(r.gateBad.slice(0, 3)) : ''));
  }
}
/* 分区表本身也要被量一次：不许有两个分区参数完全相同（那等于一个分区写了两遍名字） */
{
  const ks = Object.keys(SH.SCENE_ZONES).filter(k => k !== 'other');
  const seen = new Map();
  for (const k of ks) {
    const z = SH.SCENE_ZONES[k], sig = JSON.stringify([z.hLo, z.hHi, z.gap, z.pitch, z.crown, z.species,
      z.roof, z.pad, z.lamp, z.wall, z.shop]);
    if (seen.has(sig)) bad(`分区 ${k} 与 ${seen.get(sig)} 参数完全相同 —— 名字不同、几何相同，是假分类`);
    else seen.set(sig, k);
  }
  ok(ks.length >= 9, `${ks.length} 个街区类型，参数两两不同`);
}

console.log(fails ? `\n✗ 街区类型学判据 ${fails} 条不通过` : '\n✓ 街区类型学判据全部通过');
process.exit(fails ? 1 : 0);
