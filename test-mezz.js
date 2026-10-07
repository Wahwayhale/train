/* ============================================================================
 * test-mezz.js — 地下站**站厅层**与楼扶梯的正向判据（第 16 个自测）
 *
 * 为什么单独一个文件：站厅层是这一轮新加的"第二层"，而现有的 15 条判据全是
 * **否定式**的（绕序不许反、面片不许超大、构件不许越中心线）。它们对
 * "第二层到底在不在、楼梯到底接没接上"一个字都没说 —— 把整块站厅板删掉，
 * 15 条照样全绿。这正是本项目反复栽的那一族："写了没做"与"做了没人看"。
 *
 * 特别是这一段历史：改之前地下站那段"楼梯"是 12 级、从横向 8.25 长到 11.99，
 * 而箱涵壁在 11.0 —— **穿墙之后停在半空 2.29 m**。顶点数正常、绕序正常、
 * 烘焙正常，没有任何一条判据看得见它。这里钉的就是它的形状：
 *   ① 站厅板存在，且横跨走廊的绝大部分（扣掉两个洞口）；
 *   ② 板下净高 ≥2.1 m、板上净高 ≥2.4 m（**量顶点**，不是读常数）；
 *   ③ 每个洞口里：首级踏步落在走廊地坪 ±0.06 m（不悬空）、
 *      顶级踏步落在板面 ±0.08 m（不停在半空、不穿墙）；
 *   ④ 踏步横向全落在走廊之内；
 *   ⑤ 闸机线整体在板上（读生成器自己记的 facilities，不复刻一遍摆放公式）；
 *   ⑥ 洞口处**没有**板（留洞是真的留了，不是板压在梯上）。
 *
 * 反向验证（三条都必须报红，实测见文件尾）：
 *   MEZZTUNE='top-0.5'   把板面改矮 0.5 m  → ②板上净高 与 ③顶级踏步 报红
 *   MEZZTUNE='floatstep' 把首级踏步抬 0.5 m → ③首级不悬空 报红
 *   MEZZTUNE='gateback'  把闸机线搬回走廊地坪 → ⑤ 报红
 * 用法：node test-mezz.js [线路id,...]
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
const srcTxt = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = name => { const i = srcTxt.indexOf('class ' + name); let d = 0; for (let k = srcTxt.indexOf('{', i); k < srcTxt.length; k++) { if (srcTxt[k] === '{') d++; else if (srcTxt[k] === '}') { d--; if (!d) return srcTxt.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
const X = SH.STATION_X;
const tune = process.env.MEZZTUNE || '';

/** 建一个地下站的断面窗口，返回按 side 转正的 (横向, 标高) 点集 + 生成器记的设施表 */
function probe(line, si, opts) {
  opts = opts || {};
  const LATMAX = opts.latMax == null ? 16 : opts.latMax, UPMIN = opts.upMin == null ? -3 : opts.upMin;
  const al = line.al, s = al.stationS[si], side = line.stationSide(si);
  /* 投影原点：高架站的梯段离站心 70 m、横向外挑 30 m，在曲线上按站心的弦长
     投影会偏 2 m 量级（R=300 时 cos 误差），所以允许按出入口自己的里程投影。 */
  const sAt = opts.sAt == null ? s : opts.sAt;
  const wb = new SH.WorldBuilder({ al, color: line.color, color2: line.color2, stations: line.stations,
    sign: new SH.textures.SignAtlas(1024), night: 0.62, profile: line.profile });
  wb.sun = null; wb._installLight();
  SH.WorldBuilder.buildRuns(wb, line, Math.max(0, s - 170), Math.min(al.total, s + 60), null);
  const f = al.frame(sAt), c = f.p, pts = [];
  for (const [mat, b] of wb.b.buckets) {
    for (let i = 0; i < b.pos.length; i += 3) {
      const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
      const along = d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2];
      if (Math.abs(along) > 150) continue;
      const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
      const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
      /* 侧式站只量本线那一侧（lat>0）；岛式站的付费区在 board = −side 那侧，
         `opts.neg` 时改量负侧（岛上方站厅那一节用）。 */
      if (opts.neg ? (lat > 0.3 || lat < -LATMAX) : (lat < 0 || lat > LATMAX)) continue;
      if (up < UPMIN || up > 8) continue;
      pts.push({ mat, along, lat, up });
    }
  }
  return { s, side, pts, facilities: wb.facilities || [], boxTop: X.mezzTop + 2.6 };
}

const ids = (process.argv[2] || 'l1,l2,l10').split(',');
let bad = 0, checked = 0;
const errs = [];
const fail = m => { errs.push(m); };

for (const id of ids) {
  const line = new LineRuntime(SH.LINES[id]);
  /* 找一座**地下**车站（站厅层只做在 !open 的分支里） */
  let si = -1;
  for (let i = 1; i < line.stations.length - 1; i++) {
    const m = line.al.stationS[i];
    if (!line.isElevated(m)) { si = i; break; }
  }
  if (si < 0) { fail(`${id} 找不到地下车站，站厅层判据无处可量`); continue; }
  const P = probe(line, si);
  const pts = P.pts;
  const MT = X.mezzTop, MTT = X.mezzT, MI = X.mezzIn;
  /* 走廊外缘从实际顶点里找（箱壁 concrete 的最大横向），不写死 10.65 */
  let wall = 0;
  for (const q of pts) if (q.mat === 'concrete' && q.up > MT - 1 && q.up < MT + 1 && q.lat > MI) wall = Math.max(wall, q.lat);
  checked++;

  /* ① 站厅板存在且横跨走廊（扣掉两个洞口的宽度） */
  const deck = pts.filter(q => q.mat === 'concrete' && Math.abs(q.up - MT) < 0.02 && q.lat > MI - 0.15);
  const deckLat = deck.map(q => q.lat);
  const deckSpan = deckLat.length ? Math.max(...deckLat) - Math.min(...deckLat) : 0;
  if (deck.length < 40) fail(`${id} ${line.stations[si]}：站厅板顶点只有 ${deck.length} 个 —— 第二层根本没烘出来`);
  else if (deckSpan < (wall - MI) * 0.75) fail(`${id} ${line.stations[si]}：站厅板横向只覆盖 ${deckSpan.toFixed(2)} m（走廊 ${MI.toFixed(2)}→${wall.toFixed(2)}）`);
  else if (Math.min(...deckLat) < MI - 0.3) fail(`${id} 站厅板内缘 ${Math.min(...deckLat).toFixed(2)} 越过 mezzIn=${MI}，压到站台上方`);

  /* ② 净高量顶点：板底 − 走廊地坪、箱顶 − 板面 */
  const floor = pts.filter(q => q.mat === 'granite' && q.lat > MI && q.lat < wall && Math.abs(q.up - 0.42) < 0.06);
  const deckBot = pts.filter(q => q.mat === 'concrete' && q.lat > MI && Math.abs(q.up - (MT - MTT)) < 0.02);
  if (!floor.length) fail(`${id} 找不到走廊地坪（granite @0.42，横向 ${MI}~${wall.toFixed(1)}）`);
  if (!deckBot.length) fail(`${id} 找不到站厅板底面（concrete @${(MT - MTT).toFixed(2)}）—— 板不是有厚度的闭合体`);
  if (floor.length && deckBot.length) {
    const clear = Math.min(...deckBot.map(q => q.up)) - Math.max(...floor.map(q => q.up));
    if (clear < 2.1) fail(`${id} ${line.stations[si]}：板下净高只有 ${clear.toFixed(2)} m（<2.1 m，通道没法走人）`);
  }
  const above = pts.filter(q => q.lat > MI && q.lat < wall && q.up > MT + 0.02 && (q.mat === 'concrete' || q.mat === 'emissive' || q.mat === 'tiles'));
  const topMost = above.length ? Math.max(...above.map(q => q.up)) : MT;
  if (topMost - MT < 2.4) fail(`${id} ${line.stations[si]}：板上只有 ${topMost.toFixed(2)} m 可用作净高 ${(topMost - MT).toFixed(2)} m（<2.4 m，站厅层是假的）`);

  /* ③ 每个洞口里的踏步：首级落地、顶级上板、横向在走廊内 */
  for (let i = 0; i < SH.PLATFORM_EXITS.length; i++) {
    const dz = SH.PLATFORM_EXITS[i];
    /* 扶梯与楼梯**按沿线路方向分开量**。
       合在一起量会假绿：一跑楼梯自己就有 ≥12 档，把扶梯那次调用整个删掉，
       合并窗口照样过 —— 那这条断言就只是在量"楼梯在不在"，却在文案里说"楼扶梯"。 */
    const lv = (lo, hi) => new Set(pts.filter(q => (q.mat === 'granite' || q.mat === 'metal')
      && q.along > dz + lo && q.along < dz + hi
      && q.lat > X.escFoot - 0.25 && q.lat < wall - 0.2 && q.up > 0.35 && q.up < MT + 0.15)
      .map(q => Math.round(q.up * 20))).size;
    const band = pts.filter(q => (q.mat === 'granite' || q.mat === 'metal') && Math.abs(q.along - dz) < 2.6
      && q.lat > X.escFoot - 0.25 && q.lat < wall - 0.2 && q.up > 0.35 && q.up < MT + 0.15);
    const escLv = lv(-2.15, -0.8), stLv = lv(0.6, 2.35);
    if (band.length < 20) { fail(`${id} ${line.stations[si]} 出入口 ${i + 1}（站心${dz} m）：洞口里没有踏步（只有 ${band.length} 个顶点）—— 楼扶梯没建`); continue; }
    if (escLv < 10) { fail(`${id} 出入口 ${i + 1}：扶梯带（站心 ${dz}-2.15~-0.8 m）只有 ${escLv} 档高度 —— 扶梯缺失或被删`); continue; }
    if (stLv < 10) { fail(`${id} 出入口 ${i + 1}：楼梯带（站心 ${dz}+0.6~+2.35 m）只有 ${stLv} 档高度 —— 楼梯缺失`); continue; }
    const ups = band.map(q => q.up);
    const lowest = Math.min(...ups), highest = Math.max(...ups);
    if (Math.abs(lowest - 0.42) > 0.06) fail(`${id} 出入口 ${i + 1}：最低踏步在 ${lowest.toFixed(2)} m，走廊地坪是 0.42 —— 首级悬空（落差 ${(lowest - 0.42).toFixed(2)} m）`);
    if (Math.abs(highest - MT) > 0.08) fail(`${id} 出入口 ${i + 1}：最高踏步在 ${highest.toFixed(2)} m，站厅板面是 ${MT} —— 顶级停在半空或冲过板面`);
    const lats = band.map(q => q.lat);
    if (Math.min(...lats) < 5.4) fail(`${id} 出入口 ${i + 1}：踏步内缘 ${Math.min(...lats).toFixed(2)} m 伸进站台（站台外缘 5.55）`);
    /* B 第 2 层：箱涵两道墙按站型取 —— 侧式 ±11.0 对称，岛式走廊侧到 14.3。
       墙的位置从烘焙顶点里量（concrete 在扶梯标高带的最大横向），不再写死 11.0。 */
    const wallRun = SH.platType(line.stations[si]) === 'island' ? 14.3 : 11.0;   // 箱涵墙位随站型（§7.1：岛式走廊侧 14.3）
    if (Math.max(...lats) > wallRun - 0.1) fail(`${id} 出入口 ${i + 1}：踏步外缘 ${Math.max(...lats).toFixed(2)} m 穿过箱涵壁（${wallRun.toFixed(1)}）—— 就是当年那 12 级的形状`);
  }

  /* ⑤ 闸机线整体在板上（读生成器自己记的表） */
  const gates = P.facilities.filter(f => f.kind === 'gate');
  if (!gates.length) fail(`${id} ${line.stations[si]}：没有闸机（facilities 里 gate 为 0）`);
  else {
    const offDeck = gates.filter(g => Math.abs(g.dy - (MT + 0.30)) > 0.35);
    if (offDeck.length) fail(`${id} 有 ${offDeck.length} 组闸机不在站厅层（dy=${offDeck[0].dy.toFixed(2)}，应为板面 ${MT} 之上 0.3 m 左右）`);
    /* 柜体进深 1.5 m，中心至少要落在板内缘 +0.75。这里用 +0.5 当门槛：
       低于它就意味着大半截柜子悬在板外（真实负控 gateback 把闸机线搬回走廊
       外缘 BACK=5.55 起算，中心落在 6.40 —— 正好被这条抓住）。 */
    const hang = gates.filter(g => Math.abs(g.lat) < MI + 0.5);
    if (hang.length) fail(`${id} 有 ${hang.length} 组闸机悬在板外（横向 ${Math.abs(hang[0].lat).toFixed(2)} < 板内缘 ${MI}）—— 柜体 1.5 m 深，一半没有支撑`);
  }

  /* ⑥ 洞口处真的没有板 */
  for (let i = 0; i < SH.PLATFORM_EXITS.length; i++) {
    const dz = SH.PLATFORM_EXITS[i];
    const over = pts.filter(q => q.mat === 'concrete' && Math.abs(q.up - MT) < 0.05 && Math.abs(q.along - dz) < 1.0 && q.lat > MI);
    if (over.length) fail(`${id} 出入口 ${i + 1} 的洞口上方还有站厅板（${over.length} 个顶点）—— 梯体会把自己顶穿`);
  }
}

/* ---- 三条负控：改常数/改几何，对应的断言必须报红 ----
   harness 自己也要自证"变异真的落盘了"（这条项目里栽过：忘了把变量传进
   子进程，跑的全是原始代码，rc=0 被读成"红线抓不住缺陷"）。 */
if (tune) {
  const fs = require('fs'), cp = require('child_process');
  const wp = './src/world.js';
  const worldSrc = fs.readFileSync(wp, 'utf8');
  const SPEC = {
    'top-0.5': [wp, worldSrc, 'mezzTop: 2.95, mezzT: 0.35', 'mezzTop: 2.45, mezzT: 0.35'],
    'floatstep': [wp, worldSrc, 'this._stepsUp(fr, side, x0, 0.42, x1, STATION_X.mezzTop, -off,', 'this._stepsUp(fr, side, x0, 0.92, x1, STATION_X.mezzTop, -off,'],
    'noesc': [wp, worldSrc, 'this._stepsUp(fr, side, x0, 0.42, x1, STATION_X.mezzTop, -off, STATION_X.escLane, true);', '/* removed */'],
    'gateback': [wp, worldSrc, 'const FBack = open_ ? PLAT_FRONT + pw + 0.20 : STATION_X.mezzIn;', 'const FBack = open_ ? PLAT_FRONT + pw + 0.20 : BACK;'],
    /* 岛式站付费区上岛整块不建 —— 侧式那几条断言一个字都不看岛，只有这一节抓得到 */
    'islandoff': [wp, worldSrc, 'if (island && !open) {', 'if (false) {'],
  };
  const spec = SPEC[tune];
  if (!spec) { console.log(`✗ 没有负控「${tune}」（可选：${Object.keys(SPEC).join(' / ')}）`); process.exit(2); }
  const [path, orig, anchor, mut] = spec;
  const hits = orig.split(anchor).length - 1;
  if (hits !== 1) { console.log(`✗ 负控 ${tune} 的锚点命中 ${hits} 处（必须恰好 1 处，否则变异会静默打在别的地方）`); process.exit(2); }
  fs.writeFileSync(path, orig.split(anchor).join(mut));
  if (fs.readFileSync(path, 'utf8') === orig) { console.log(`✗ 负控 ${tune} 落盘后文本没变`); fs.writeFileSync(path, orig); process.exit(2); }
  console.log(`（负控 ${tune} 已注入 —— 子进程里的红字是预期的）`);
  /* 子进程**必须清掉 MEZZTUNE**：继承了就会自己去重注入，锚点已经被自己改过
     所以命中 0 处 → 直接 exit(2) → 父进程把"非零退出"读成"如期报红"，
     于是一条根本没跑断言的负控假通过了（本轮实测抓到）。 */
  let rc = -1, out = '';
  try {
    const r = cp.spawnSync(process.execPath, [__filename], { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, MEZZTUNE: '' } });
    rc = r.status; out = (r.stdout || '') + (r.stderr || '');
  } finally { fs.writeFileSync(path, orig); }
  console.log(out.split(/\r?\n/).filter(l => /✗/.test(l)).slice(0, 4).join('\n'));
  if (fs.readFileSync(path, 'utf8') !== orig) { console.log(`✗ 负控 ${tune} 还原失败：源码仍处在变异状态！`); process.exit(1); }
  /* "跑到了断言"要正面证明：子进程必须打印出判据主题。
     只看退出码会把"根本没跑"读成"报红了"。 */
  const ran = /站厅|踏步|闸机|出入口|净高/.test(out);
  if (!ran) { console.log(`✗ 负控 ${tune} 的子进程根本没跑到断言（退出码 ${rc}）—— 这条负控是空的`); process.exit(1); }
  console.log(rc === 0 ? `✗ 负控 ${tune} 没有报红 —— 这条判据抓不住它声称要抓的缺陷`
    : `✓ 负控 ${tune} 如期报红（子进程确实跑到了断言），源码已逐字节还原`);
  process.exit(rc === 0 ? 1 : 0);
}

/* ---- 高架站：每个出入口必须"楼梯 + 扶梯"并排在位 ----
   只有楼梯的高架站不是真实高架站。这一条也挡住"把 _stepsUp 的扶梯那次调用删掉"
   这类静默回退 —— 删掉之后画面只是少一条斜梁，15 条老判据一条都不会红。 */
for (const id of ids) {
  const line = new LineRuntime(SH.LINES[id]);
  let si = -1;
  for (let i = 1; i < line.stations.length - 1; i++)
    if (line.isElevated(line.al.stationS[i])) { si = i; break; }
  if (si < 0) continue;
  let P = probe(line, si, { latMax: 34, upMin: -14 });
  const MT = X.mezzTop;
  const GND = -Math.abs(SH.STREET_Y);            // 街面在轨面下 10.9（高程基准单点）
  let pairs = 0;
  for (const dz of SH.PLATFORM_EXITS) {
    const s0x = line.al.stationS[si];
    P = probe(line, si, { latMax: 34, upMin: -14, sAt: s0x + dz });
    /* 楼梯带与扶梯带分开数，否则这条只是在量"楼梯在不在"。
       边界要**盖过**梯段自己的半宽：楼梯是沿线路扫 2.2 m 的，它的全部顶点
       只落在路径两端 ±1.1 m 上 —— 窗口取 ±1.05 会把楼梯整个挡在外面，
       于是"7 档 vs 78 档"看起来像产品少了楼梯，其实是探针自己没框住。 */
    const lvE = (lo, hi) => new Set(P.pts.filter(q => (q.mat === 'granite' || q.mat === 'metal')
      && q.along > lo && q.along < hi && q.lat > 7.5 && q.lat < 32
      && q.up < 0.5 && q.up > GND - 0.5).map(q => Math.round(q.up * 12))).size;
    if (lvE(-1.3, 1.3) >= 12 && lvE(1.3, 2.7) >= 12) pairs++;
  }
  if (pairs < SH.PLATFORM_EXITS.length)
    fail(`${id} ${line.stations[si]}（高架站）：${SH.PLATFORM_EXITS.length} 个出入口里只有 ${pairs} 处量到连续的梯级高度带 —— 楼梯或扶梯缺失`);
  else checked++;
}

/* ---- 岛式站：付费区上岛（B 第 3 层，§7.1）----
   侧式站的付费区在正线外侧那条走廊的上方；岛式站的两条缘口**分别对着一股道**，
   所以付费区必须罩在**岛的上方**、楼梯从两条缘口各自上板。
   上面那一段的 `probe` 只量 lat>0（本线那一侧），看不见岛 —— 这里用 `{neg:true}`
   再量一遍负侧，钉三件事：板罩住整座岛（两缘各挑檐）、两个洞口真的留了、
   两条缘各有梯体且顶级踩在板面。 */
let islChecked = 0;
for (const id of ids) {
  const line = new LineRuntime(SH.LINES[id]);
  let si = -1;
  for (let i = 1; i < line.stations.length - 1; i++)
    if (!line.isElevated(line.al.stationS[i]) && SH.platType(line.stations[i]) === 'island') { si = i; break; }
  if (si < 0) continue;                          // 这条线没有地下岛式站
  const P = probe(line, si, { neg: true, latMax: 14 });
  const pts = P.pts;
  const MTi = X.mezzTop, nA = -(X.front - 0.35), nB = -(X.front + SH.ISLAND_W + 0.35);
  islChecked++;
  const deck = pts.filter(q => q.mat === 'concrete' && Math.abs(q.up - MTi) < 0.02 && q.lat < nA + 0.3 && q.lat > nB - 0.3);
  if (deck.length < 40) { fail(`${id} ${line.stations[si]}：岛上方没有站厅板（concrete @${MTi} 只有 ${deck.length} 个顶点）—— 付费区没上岛`); continue; }
  const dl = deck.map(q => q.lat);
  if (Math.max(...dl) < nA - 0.15) fail(`${id} ${line.stations[si]}：岛上方站厅板内缘 ${Math.max(...dl).toFixed(2)} m，应挑到近缘 ${nA.toFixed(2)}`);
  if (Math.min(...dl) > nB + 0.15) fail(`${id} ${line.stations[si]}：岛上方站厅板外缘 ${Math.min(...dl).toFixed(2)} m，应挑到远缘 ${nB.toFixed(2)}`);
  for (let i = 0; i < SH.PLATFORM_EXITS.length; i++) {
    const dz = SH.PLATFORM_EXITS[i];
    const over = pts.filter(q => q.mat === 'concrete' && Math.abs(q.up - MTi) < 0.05 && Math.abs(q.along - dz) < 1.0 && q.lat < 0);
    if (over.length) fail(`${id} 岛式站出入口 ${i + 1} 的洞口上方还有站厅板（${over.length} 个顶点）—— 梯体会把自己顶穿`);
    const band = pts.filter(q => (q.mat === 'granite' || q.mat === 'metal')
      && Math.abs(q.along - dz) < 2.6 && q.lat < nA + 0.2 && q.lat > nB - 0.2 && q.up > 0.35 && q.up < MTi + 0.15);
    const lv = new Set(band.map(q => Math.round(q.up * 20))).size;
    if (band.length < 20 || lv < 10) { fail(`${id} 岛式站出入口 ${i + 1}（站心${dz} m）：岛上洞口里没有梯体（${band.length} 顶点 / ${lv} 档）—— 上岛的楼扶梯没建`); continue; }
    const ups = band.map(q => q.up);
    if (Math.abs(Math.max(...ups) - MTi) > 0.08) fail(`${id} 岛式站出入口 ${i + 1}：最高踏步在 ${Math.max(...ups).toFixed(2)} m，站厅板面是 ${MTi} —— 顶级停在半空`);
  }
}
if (islChecked) checked += islChecked;

if (errs.length) { bad = errs.length; console.log('  ✗ ' + errs.slice(0, 8).join('\n  ✗ ')); }
else console.log(`✓ 站厅层与楼扶梯：第二层在位、净高量得出、每个洞口首级落地顶级上板、闸机全在板上、洞口真的留了；高架站每个出入口楼梯带与扶梯带都在位；岛式站付费区上岛（板罩住整座岛、两条缘各有一台梯体）（共测 ${checked} 处车站）`);
process.exit(bad ? 1 : 0);
