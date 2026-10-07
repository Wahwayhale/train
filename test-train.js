/* 无头列车几何判据：逐扇车窗 / 立柱同源 / 贯通道与车钩 / 车型分型。
 *
 * 为什么单独一个判据：test-bake 只看"整车建得出来、不出 NaN、窗后面有客室"，
 * 它不区分"一扇一扇的窗"与"一条横贯车门的玻璃带"。后者是这轮之前的真实状态：
 * 侧窗是一根铺满 86% 车长的 box，**从门洞底下穿过去** —— 门滑开之后门洞里
 * 还挡着一扇关着的窗，"开门看见客室"这件事在门区被自己否掉了；而立柱是另一份
 * 1.35 m 间距的循环，玻璃从哪儿断开跟立柱落在哪儿毫无关系。
 * 贯通道同理：一个 0.30 m 的橡皮疙瘩跨不住 0.35 m 的车钩间隙，折棚与车钩都没有。
 *
 * 判据一律读**烘焙出来的顶点**（`buildMiddleCar` 的返回网格），不读函数返回值 ——
 * 与 test-bake 的"记录↔几何"同一条纪律：函数说什么不算，顶点在那儿才算。
 *
 * 负控（在 dev/negctl.js 里，落盘变异 + 逐字节还原）：
 *   bandwin  玻璃退回一整条带（横穿门洞）
 *   nopleat  贯通道退回单个盒子（跨不过间隙、没有折棚与车钩）
 *   mullindep 立柱与窗洞边界错开 0.4 m（两份各写各的）
 */
'use strict';
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', createLinearGradient: () => ({ addColorStop() {} }), beginPath() {}, arc() {}, fill() {}, rect() {}, clip() {}, save() {}, restore() {}, translate() {}, fillRect() {}, clearRect() {}, drawImage() {}, fillText() {}, measureText: () => ({ width: 10 }) }), style: { setProperty() {} } }), addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({ matches: false });
global.performance = require('perf_hooks').performance;
const fs = require('fs'), path = require('path');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'bve', 'train', 'physics', 'pax', 'audio']) require(path.join(__dirname, 'src', f + '.js'));
require(path.join(__dirname, 'data', 'shanghai.js'));
const SH = global.SH;

/* 车型参数只有一份出处：game.js 的 LineRuntime._profile()。
   这里把它整段取出来当函数用 —— 在测试里再抄一遍映射，就是第四份"各写各的"。 */
const gsrc = fs.readFileSync(path.join(__dirname, 'src', 'game.js'), 'utf8');
const gi = gsrc.indexOf('_profile() {');
let gd = 0, ge = -1;
for (let k = gsrc.indexOf('{', gi); k < gsrc.length; k++) { if (gsrc[k] === '{') gd++; else if (gsrc[k] === '}') { gd--; if (!gd) { ge = k + 1; break; } } }
if (gi < 0 || ge < 0) { console.log('✗ 取不到 game.js 的 _profile()：判据的参数出处断了'); process.exit(1); }
const profileFn = eval('(function(){' + gsrc.slice(gi, ge).replace('_profile() {', 'return function () {') + '})()');
const mkProfile = key => {
  const def = Object.values(SH.LINES).find(d => d.stock === key);
  return profileFn.call({ stock: SH.STOCK[key], color: (def && def.color) || '#E4002B', maglev: !!SH.STOCK[key].maglev, maxKmh: 80 });
};

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const T = SH.train, WIN = SH.CARWIN;

/** 从网格里恢复"轴对齐的矩形面片"（box/plate 的一个面）。
 *  原来这里是"每 4 个顶点算一个盒子"—— 同一个材质桶里既有盒子也有圆柱
 *  （`cylY`/`cylZ` 的顶点数不是 4 的整数倍），第一个圆柱之后分组就整体错位，
 *  量出来的"窗扇数/立柱数"是噪声。现在按索引缓冲走：两个相邻三角形若
 *  恰好覆盖 4 个不同顶点、且这 4 点共面于一个轴对齐平面，才算一个面片。 */
function faces(meshes, mat, keep) {
  const out = [];
  for (const m of meshes) {
    if (mat !== '*' && m.mat !== mat) continue;
    const pos = m.pos, idx = m.idx;
    for (let t = 0; t + 5 < idx.length; t += 6) {
      const u = [...new Set([idx[t], idx[t + 1], idx[t + 2], idx[t + 3], idx[t + 4], idx[t + 5]])];
      if (u.length !== 4) continue;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const v of u) {
        const o = v * 3, X = pos[o], Y = pos[o + 1], Z = pos[o + 2];
        if (X < x0) x0 = X; if (X > x1) x1 = X;
        if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
      }
      /* 必须是"贴在一面轴对齐平面上的矩形"：三个轴向里恰好一个是零厚度 */
      const flat = [x1 - x0 < 1e-4, y1 - y0 < 1e-4, z1 - z0 < 1e-4].filter(Boolean).length;
      if (flat !== 1) continue;
      const b = { x0, x1, y0, y1, z0, z1 };
      if (!keep || keep(b)) out.push(b);
    }
  }
  out.sort((a, b) => a.z0 - b.z0);
  const merged = [];
  for (const b of out) {
    const p = merged[merged.length - 1];
    if (p && b.z0 <= p.z1 + 0.01 && Math.abs(b.z1 - p.z1) < 0.01 && Math.abs(b.y0 - p.y0) < 0.01) { p.n++; continue; }
    merged.push(Object.assign({ n: 1 }, b));
  }
  return merged;
}

const KEYS = process.argv.slice(2).filter(k => SH.STOCK[k]);
const stocks = KEYS.length ? KEYS : ['A8', 'A6D', 'C6', 'A3', 'RUB', 'MAG'];
for (const key of stocks) {
  const p = mkProfile(key), L = p.midLen;
  const part = T.buildMiddleCar(p, {});
  const bays = T.windowBays(p, L, 'mid');
  const keep = p.doorW / 2 + 0.09;
  const doors = T.doorZs(p, L, 'mid');
  console.log(`${key} ${p.type} 车宽 ${p.width} 门 ${p.doors} 对：窗洞 ${bays.length} 扇/侧`);

  /* ① 逐扇：玻璃必须是一扇一扇，且数量与窗洞划分一致 */
  const panes = faces(part.glass, 'window');
  if (panes.length !== bays.length) bad(`${key}：玻璃 ${panes.length} 块 ≠ 窗洞划分 ${bays.length} 扇`);
  for (let i = 0; i < Math.min(panes.length, bays.length); i++) {
    if (Math.abs((panes[i].z0 + panes[i].z1) / 2 - bays[i][0]) > 0.02 || Math.abs((panes[i].z1 - panes[i].z0) - bays[i][1]) > 0.02) {
      bad(`${key}：第 ${i} 扇玻璃与划分对不上（几何 ${(panes[i].z1 - panes[i].z0).toFixed(2)} m @ ${(panes[i].z0 + panes[i].z1) / 2} vs 声称 ${bays[i][1].toFixed(2)} m @ ${bays[i][0]}）`);
      break;
    }
  }
  /* ② 门洞里不许有侧窗：这正是"一整条玻璃带"那个缺陷的正面判据 */
  for (const pane of panes) {
    for (const d of doors) {
      if (pane.z1 > d - keep + 0.005 && pane.z0 < d + keep - 0.005) {
        bad(`${key}：玻璃 ${pane.z0.toFixed(2)}~${pane.z1.toFixed(2)} 压进门洞 ${d}（让开 ±${keep.toFixed(2)}）—— 门开到位后面前还是一扇关着的窗`);
        break;
      }
    }
  }
  /* ③ 窗高：玻璃必须落在窗带高度上（相对地板面 lo~hi） */
  for (const pane of panes.slice(0, 1)) {
    if (Math.abs(pane.y0 - (p.floorY + WIN.lo)) > 0.02 || Math.abs(pane.y1 - (p.floorY + WIN.hi)) > 0.02)
      bad(`${key}：玻璃高度 ${pane.y0.toFixed(2)}~${pane.y1.toFixed(2)} 不在窗带 ${p.floorY + WIN.lo}~${p.floorY + WIN.hi}`);
  }
  /* ④ 立柱必须落在窗洞边界上（同源），不是另起一份间距。
     筛选条件要钉在"侧皮上、窗带高度、窄"三件事同时成立：只按窄 + 高筛，
     会把车顶天线、受电弓的立杆也算进来（它们也是又窄又高的 metal 盒子）。 */
  const skinX = p.width / 2 + 0.026;
  const mull = faces(part.body, 'metal', b => (b.z1 - b.z0) < 0.12 && (b.y1 - b.y0) > WIN.h &&
    Math.abs(Math.abs(b.x0) - skinX) < 0.035 && Math.abs((b.y0 + b.y1) / 2 - (p.floorY + WIN.mid)) < 0.05);
  const edges = [];
  for (const [c, w] of bays) { edges.push(c - w / 2, c + w / 2); }
  if (mull.length < bays.length + 1) bad(`${key}：立柱只有 ${mull.length} 根，${bays.length} 扇窗至少要 ${bays.length + 1} 个边界`);
  let off = 0;
  for (const m of mull) {
    const c = (m.z0 + m.z1) / 2;
    if (!edges.some(e => Math.abs(e - c) < 0.02)) off++;
  }
  if (off) bad(`${key}：${off}/${mull.length} 根立柱不在窗洞边界上 —— 立柱与窗洞又是两份各写各的`);

  /* ⑤ 贯通道：必须跨住车钩间隙，且有折棚褶与车钩 */
  const zEnd = -L / 2;
  const beyond = faces(part.body, '*', b => b.z1 < zEnd + 0.02 && b.z0 < zEnd - 0.02);
  const far = beyond.reduce((m, b) => Math.min(m, b.z0), 1e9);
  const reach = zEnd - far;
  if (!(reach >= p.gap * 0.75)) bad(`${key}：贯通道只伸出 ${reach.toFixed(2)} m，跨不住 ${p.gap} m 的车钩间隙 —— 接头是个敞开的黑洞`);
  const rub = faces(part.body, 'rubber', b => b.z1 < zEnd - 0.01);
  const pleats = [];
  for (const b of rub) { const c = (b.z0 + b.z1) / 2; if (!pleats.some(q => Math.abs(q - c) < 0.03)) pleats.push(c); }
  if (pleats.length < 3) bad(`${key}：折棚只有 ${pleats.length} 褶（<3 就是一块板，读不出"这是能皱的"）`);
  /* 车钩系部件只属于**有轮轨**的车：磁浮车辆是铰接连接（wheelR = 0），
     真实 Transrapid 车厢之间没有密接式车钩，硬要它长出一个钩头才是假的。 */
  if (p.wheelR > 0) {
    const low = beyond.filter(b => b.y1 < p.floorY - 0.2);
    if (!low.length) bad(`${key}：车端下部（地板面以下）没有任何车钩系部件 —— 连挂状态下车钩永远看不见`);
    const hose = faces(part.body, 'metal', b => b.z1 < zEnd - 0.01 && b.y1 < p.floorY - 0.3 && (b.x1 - b.x0) < 0.12);
    if (hose.length < 2) bad(`${key}：钩头两侧的风管只有 ${hose.length} 根（总风 + 制动至少两根）`);
  } else if (beyond.length < 3) bad(`${key}：磁浮车端只有 ${beyond.length} 件连接几何`);
}

/* ⑥ 分型：不同车型烘出来的车必须量得出差别，否则"分型"只是数据表上的字 */
{
  const sig = k => {
    const p = mkProfile(k), part = T.buildMiddleCar(p, {});
    let maxAbsX = 0, verts = 0, low = 0;
    for (const m of part.body) {
      verts += m.verts;
      for (let i = 0; i < m.pos.length; i += 3) {
        maxAbsX = Math.max(maxAbsX, Math.abs(m.pos[i]));
        if (m.pos[i + 1] < p.floorY - 0.4) low++;
      }
    }
    return { k, w: +maxAbsX.toFixed(2), verts, low, panes: T.windowBays(p, p.midLen, 'mid').length };
  };
  const S = ['A8', 'C6', 'RUB', 'MAG'].map(sig);
  console.log('分型签名：' + S.map(s => `${s.k} 半宽 ${s.w} 顶点 ${s.verts} 车底顶点 ${s.low} 窗 ${s.panes}`).join(' | '));
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    if (S[i].verts === S[j].verts && S[i].w === S[j].w && S[i].panes === S[j].panes)
      bad(`${S[i].k} 与 ${S[j].k} 烘出来的车完全一样 —— 车型档案没进到几何里`);
  }
  const a8 = S[0], mag = S[3];
  if (!(mag.w > a8.w)) bad(`磁浮车体（半宽 ${mag.w}）没有比 A 型车（${a8.w}）宽 —— 3.70 m 的车宽没进几何`);
  if (!(a8.low > mag.low)) bad(`A 型车车底设备顶点 ${a8.low} 不高于磁浮 ${mag.low} —— 磁浮没有转向架与悬挂设备，两者不该一样`);
}

/* ⑦ 分型车头：鼻长、鼻尖收窄、鼻尖下沉、风挡倾角、灯位数、有无中柱
      —— 全部从烘焙顶点量，且与 NOSE 档案里声称的数一一对账。 */
{
  const V = (meshes, pred) => {
    const out = [];
    for (const m of meshes) for (let i = 0; i + 2 < m.pos.length; i += 3) {
      const v = [m.pos[i], m.pos[i + 1], m.pos[i + 2]];
      if (pred(m.mat, v)) out.push({ mat: m.mat, v });
    }
    return out;
  };
  const sigs = [];
  for (const key of ['A8', 'C6', 'MAG', 'RUB']) {
    const p = mkProfile(key), head = T.buildHeadCar(p, {});
    const nose = (SH.train.NOSE || {})[p.noseShape] || {};
    const L = p.headLen, front = L / 2;
    if (!nose.len) { bad(`${key}：noseShape=${p.noseShape} 在 NOSE 档案里没有条目`); continue; }
    /* 鼻尖半宽/顶高：只看**鼻皮**。前脸那块"嘴"（maskProfile，比鼻皮宽 3 cm
       是故意的）与排障器都伸到鼻尖带里，不加高度门就会量到它们 ——
       实测排障器半宽 1.38、嘴 1.29，而真正的鼻尖皮是 1.26。 */
    const tip = V(head.body, (mat, v) => v[2] > front - 0.25 && v[1] > p.floorY + 1.0);
    if (!tip.length) { bad(`${key}：鼻尖（z > ${front - 0.25}）一个鼻皮顶点都没有`); continue; }
    let tipW = 0, tipTop = -1e9;
    for (const q of tip) { tipW = Math.max(tipW, Math.abs(q.v[0])); tipTop = Math.max(tipTop, q.v[1]); }
    const wantW = p.width / 2 * (1 - nose.wAmt), wantTop = p.roofY * (1 - nose.yAmt) - nose.dropAmt;
    if (Math.abs(tipW - wantW) > wantW * 0.08)
      bad(`${key}：鼻尖半宽实测 ${tipW.toFixed(2)}，档案声称 ${wantW.toFixed(2)}（wAmt ${nose.wAmt}）—— 鼻型参数没进到几何里`);
    if (Math.abs(tipTop - wantTop) > 0.25)
      bad(`${key}：鼻尖顶高实测 ${tipTop.toFixed(2)}，档案声称 ≈${wantTop.toFixed(2)}（yAmt ${nose.yAmt} + drop ${nose.dropAmt}）`);
    /* 鼻长 = 鼻尖到"直段结束"的距离。收窄是渐进的（t^2.6），所以不能问
       "半宽从哪儿开始变小"（阈值一挪答案就跟着挪，实测 3.45/4.6 差 1.15 m），
       要问的是**最靠前的那个仍是全宽的截面**在哪 —— 直段与鼻部放样共用
       鼻长起点那一圈，它是全宽的，再往前每一圈都比它窄。 */
    const noseV = V(head.body, (mat, v) => v[2] > front - nose.len - 0.6 && v[1] > p.floorY + 0.5 && v[1] < p.roofY + 0.3);
    let hwMax = 0;
    for (const q of noseV) hwMax = Math.max(hwMax, Math.abs(q.v[0]));
    let zSh = 1e9;
    for (const q of noseV) if (Math.abs(q.v[0]) >= hwMax * 0.999 && q.v[2] < zSh) zSh = q.v[2];
    const lenMeas = front - zSh;
    if (Math.abs(lenMeas - nose.len) > 0.35)
      bad(`${key}：鼻长实测 ${lenMeas.toFixed(2)} m，档案声称 ${nose.len} m（容差 0.35）`);
    /* 风挡：司机那一层玻璃（glassSoft）。它必须**按车型后倾** ——
       竖直的一片横跨≈0，档案里的 rake 没进几何就会被这条抓到 */
    const cab = T.buildCabInterior(p, {});
    const scr = V(cab, (mat, v) => mat === 'glassSoft' && v[2] > front - nose.len);
    if (scr.length < 4) bad(`${key}：前风挡只有 ${scr.length} 个顶点`);
    else {
      const ys = scr.map(q => q.v[1]), zs = scr.map(q => q.v[2]);
      const dy = Math.max(...ys) - Math.min(...ys), dz = Math.max(...zs) - Math.min(...zs);
      if (!(dy > 0.4)) bad(`${key}：风挡竖跨只有 ${dy.toFixed(2)} m，接不住台面到车顶这条带`);
      if (Math.abs(dz - nose.screen.rake) > 0.15)
        bad(`${key}：风挡后倾实测 ${dz.toFixed(2)} m，档案声称 ${nose.screen.rake} m —— 车头那张脸没进到几何里`);
    }
    /* 中柱：档案说风挡分两块才长，说是一整块面罩就不许长 */
    const pillar = V(cab, (mat, v) => mat === 'body' && Math.abs(v[0]) < 0.14 &&
      v[2] > front - nose.len && v[1] > p.floorY + 0.44);
    if (nose.screen.pillar > 0 && pillar.length < 4)
      bad(`${key}：档案说风挡被中柱分成两块，车头却量不到中柱（顶点 ${pillar.length}）`);
    if (!nose.screen.pillar && pillar.length >= 4)
      bad(`${key}：档案说风挡是一整块面罩，车头却长出了中柱（${pillar.length} 个顶点）`);
    /* 灯位：数量与高度都要对上 */
    /* 灯按"排"数：一盏 cylZ 有几十上百个顶点，数顶点等于没数 */
    const got = V(head.body, (mat, v) => mat === 'light' && v[2] > front - 0.6);
    const rows = [];
    for (const q of got) if (!rows.some(r => Math.abs(r - q.v[1]) < 0.15)) rows.push(q.v[1]);
    if (rows.length !== nose.lights.length + 1)
      bad(`${key}：前脸灯排实测 ${rows.length} 排（y=${rows.map(r => r.toFixed(2)).join(',')}），档案声称 ${nose.lights.length} 排灯 + 1 排尾灯`);
    for (const g of nose.lights) {
      const hit = got.filter(q => Math.abs(q.v[1] - g.y) < 0.06).length;
      if (!hit) bad(`${key}：档案声称灯位在 y=${g.y}，实测没有灯在那儿`);
    }
    sigs.push({ key, len: +lenMeas.toFixed(2), tipW: +tipW.toFixed(2), tipTop: +tipTop.toFixed(2), lights: rows.length, pillar: pillar.length });
  }
  console.log('鼻型签名：' + sigs.map(s => `${s.key} 鼻长 ${s.len} 鼻尖半宽 ${s.tipW} 鼻尖顶高 ${s.tipTop} 灯 ${s.lights} 中柱顶点 ${s.pillar}`).join(' | '));
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
    const a = sigs[i], b = sigs[j];
    if (a.len === b.len && a.tipW === b.tipW && a.tipTop === b.tipTop && a.lights === b.lights)
      bad(`${a.key} 与 ${b.key} 的车头一模一样（鼻长/鼻尖/灯位全等）—— 分型档案没起作用`);
  }
}

/* ---- BVE 列车模型（README 第 146 条）：用户给的 1 号线列车，原封不动搬过来 ----
   判据必须**自己从磁盘读 CSV**：浏览器里这套是 fetch 下来的，离线跑不到；
   而"车体换没换"这件事恰恰只能在这里量 —— 不读的话模型解析坏了 19 个套件照样全绿。 */
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'assets', 'l1train', 'csv');
  const files = ['01.csv', '02.csv', '03.csv', '04.csv', '05.csv', '06.csv'];
  const cars = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) { bad(`BVE 模型缺文件 ${f} —— 1 号线列车会静默退回程序化车体`); break; }
    cars.push(SH.bve.parse(fs.readFileSync(fp, 'utf8')));
  }
  if (cars.length === files.length) {
    cars.forEach((c, i) => {
      let v = 0, fc = 0, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const m of c) {
        v += m.v.length; fc += m.f.length;
        for (const q of m.v) { if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]; }
      }
      if (c.length < 40) bad(`BVE 车 ${i + 1}：子网格只有 ${c.length} 个（模型应 ≥40）—— 解析漏了段`);
      if (v < 1500) bad(`BVE 车 ${i + 1}：顶点只有 ${v} 个（应 ≥1500）—— 顶点没解析全`);
      if (fc < 400) bad(`BVE 车 ${i + 1}：面只有 ${fc} 个（应 ≥400）`);
      if (z1 - z0 < 20) bad(`BVE 车 ${i + 1}：车长只有 ${(z1 - z0).toFixed(2)} m（应 ≥20）—— 变换（Rotate/Translate）没生效`);
      /* 上限放到 5.6：02/05 两节动车带**受电弓**（实测顶到 5.09 m），
         车顶本体仍是 3.8 —— 这条断言挡的是"坐标轴搞反了"（高度变成 20 多米）。 */
      if (y0 < -1.5 || y1 > 5.6) bad(`BVE 车 ${i + 1}：高度 ${y0.toFixed(2)}~${y1.toFixed(2)} m 不合理（轨面 y=0、车顶 3.8、受电弓 5.1）`);
    });
    const keep = SH.bve.cars;
    SH.bve.cars = cars;
    const names = [];
    for (const c of cars) for (const n of SH.bve.texNames(c)) if (names.indexOf(n) < 0) names.push(n);
    SH.registerBveMats(names);
    const p1 = Object.assign({}, SH.train.DEFAULTS, SH.STOCK.A8L1);
    const tv = new SH.train.TrainView(p1, {});
    if (!tv.bve) bad('1 号线列车没走 BVE 模型（TrainView.bve 为假）—— 车档 photo 或 SH.bve.cars 没接上');
    let tri = 0; for (const b of tv.mid.body) tri += (b.idx ? b.idx.length / 3 : 0);
    if (tri < 800) bad(`BVE 中间车只烘出 ${tri} 个三角形（应 ≥800）—— 网格没进 Builder`);
    const mats = tv.mid.body.map(b => b.mat).join(' ');
    for (const must of ['bve:side', 'bve:yane', 'bve:sharin', 'bve:daisha1']) {
      if (mats.indexOf(must) < 0) bad(`BVE 车体里没有 ${must}* 批次 —— 侧墙/车顶/车轮/转向架缺一块`);
    }
    /* mode 必须是 **3（真乘）**：BVE 的贴图是灰度细节图、颜色在 SetColor 里，
       mode 2（整张替换）会丢掉颜色（第一版就是这么变成一片灰白的），
       mode 1（绕 1.0 的细节调制）会把整车压成中灰。 */
    if (!SH.MATERIALS['bve:sharin.bmp'] || SH.MATERIALS['bve:sharin.bmp'].mode !== 3)
      bad('bve:* 材质没注册（或没走 mode 3 真乘）—— 列车会落回混凝土兜底材质或丢掉涂装色');
    SH.bve.cars = keep;
    if (!fails) console.log(`  ✓ BVE 列车模型：6 节车（子网格 ${cars.map(c => c.length).join('/')}），中间车 ${tri} 三角形、${tv.mid.body.length} 批材质`);
  }
}

console.log(fails ? `\n✗ 列车几何判据 ${fails} 条不通过` : '\n✓ 列车几何判据全部通过');
process.exit(fails ? 1 : 0);
