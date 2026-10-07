/* 逐米轨道审计：除磁浮/浦江线外，把每条线（含支线）整线烘焙，
 * 将全部顶点投回轨道坐标 (s, lat, y)，按 run 分类（depot/station/viaduct/tunnel）
 * 核对每类区段应有的构件覆盖：钢轨、第三轨/接触网、隧道管片、桥面、桥墩、
 * 站台、对向轨。输出每类覆盖率与缺口清单（按里程）。
 *
 * 用法：node dev/audit-track.js [线路id或名称 ...]
 */
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), beginPath() {}, arc() {}, fill() {}, rect() {}, clip() {}, save() {}, restore() {}, translate() {}, fillRect() {}, clearRect() {}, drawImage() {}, fillText() {}, strokeText() {}, measureText: () => ({ width: 10 }), strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', moveTo() {}, lineTo() {}, stroke() {}, ellipse() {}, putImageData() {}, createImageData: () => ({ data: new Uint8Array(4) }), getImageData: () => ({ data: new Uint8Array(4) }) }), style: { setProperty() {} } }), addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({ matches: false });
global.performance = require('perf_hooks').performance;
const path = require('path');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio']) require(path.join(__dirname, '../src/' + f + '.js'));
require(path.join(__dirname, '../data/shanghai.js'));
const SH = global.SH;

const gsrc = require('fs').readFileSync(path.join(__dirname, '../src/game.js'), 'utf8');
const grab = (name) => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

const fakeR = {
  textures: { sign: null }, batches: [],
  upload(meshes) { this.batches.push(...meshes); return meshes; },
  dropTag() {}, texFromCanvas() { return {}; }, draw() {}, begin() {}, end() {},
};

const FILTER = process.argv.slice(2);
const SKIP = new Set(['ml', 'ph']);           // 用户口径：磁浮/浦江线不在本次审计范围
const GAP = 15;                                // 缺口判定长度（m）
/* 对向股道的横向不在这里再抄一份常数：单点是 `SH.oppLatAt`（岛式站区会加宽）。
   写死 4 m 就是这条审计里的第二个真值 —— 岛式一上线，这里会把搬家那段对向轨
   静默算成"没有对向轨"，而覆盖率看起来完全正常。 */

function bakeLine(line, def) {
  const sign = new SH.textures.SignAtlas(2048);
  const w = new SH.WorldBuilder({ al: line.al, color: def.color, stations: line.stations, sign, night: 0.62, profile: line.profile });
  w.ambient = [0.26, 0.29, 0.36]; w.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; w._installLight();
  SH.WorldBuilder.buildRuns(w, line, 0, line.al.total, null);
  return w.b.finish();
}

/* 把顶点投回轨道坐标。对齐框架每 2 m 采样一个，xz 网格哈希 3×3 邻域找最近。 */
function projector(line) {
  const al = line.al, STEP = 2, CELL = 25;
  const samples = [], grid = new Map();
  for (let s = 0; s <= al.total; s += STEP) {
    const f = al.frame(s);
    const rec = { s, p: f.p, f: f.f, r: f.r, u: f.u };
    samples.push(rec);
    const k = Math.floor(f.p[0] / CELL) + ',' + Math.floor(f.p[2] / CELL);
    (grid.get(k) || grid.set(k, []).get(k)).push(rec);
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (x, y, z) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = null, bd = 40 * 40;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = grid.get((cx + i) + ',' + (cz + j));
      if (!c) continue;
      for (const rec of c) {
        const dx = x - rec.p[0], dy = y - rec.p[1], dz = z - rec.p[2];
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = rec; }
      }
    }
    if (!best) return null;
    const d = [x - best.p[0], y - best.p[1], z - best.p[2]];
    return { s: best.s + dot(d, best.f), lat: dot(d, best.r), y: dot(d, best.u) };
  };
}

/* 每米分类：runsOf 用 1 m 步长。 */
function kindsOf(line) {
  const kinds = new Array(Math.ceil(line.al.total) + 1).fill('tunnel');
  for (const r of SH.WorldBuilder.runsOf(line, 0, line.al.total, 1))
    for (let s = Math.floor(r.s0); s <= Math.min(kinds.length - 1, r.s1); s++) kinds[s] = r.kind;
  return kinds;
}

const RESULTS = [];
for (const id of Object.keys(SH.LINES)) {
  const def = SH.LINES[id];
  if (SKIP.has(id)) { console.log(`—— ${def.name}：按口径跳过（磁浮/胶轮无轮轨构造）`); continue; }
  if (FILTER.length && !FILTER.includes(id) && !FILTER.includes(def.name)) continue;
  for (const svc of SH.LINES[id].branch ? ['main', 'branch'] : ['main']) {
    const line = new LineRuntime(def, svc === 'branch' ? 'branch' : undefined);
    const label = def.name + (svc === 'branch' ? ' 支线' : '');
    const t0 = performance.now();
    const meshes = bakeLine(line, def);
    const proj = projector(line);
    const kinds = kindsOf(line);
    const total = Math.ceil(line.al.total);
    /* 每米旗标计数 */
    const bins = Array.from({ length: total + 1 }, () => null);
    const bin = s => { const i = Math.max(0, Math.min(total, Math.floor(s))); return bins[i] || (bins[i] = { rail: 0, opp: 0, third: 0, cat: 0, tube: 0, deck: 0, pier: 0, plat: 0, fast: 0 }); };
    let verts = 0;
    /* 逐米缓存：对向股道的期望横向问单点函数，不自己算 */
    const oppCache = new Map();
    const oppAt = s => { const k = Math.floor(s); let v = oppCache.get(k);
      if (v == null) { v = Math.abs(SH.oppLatAt(line, k)); oppCache.set(k, v); } return v; };
    for (const m of meshes) {
      const P = m.pos;
      for (let i = 0; i < P.length; i += 3) {
        const c = proj(P[i], P[i + 1], P[i + 2]);
        if (!c) continue;
        if (c.s < -5 || c.s > total + 5) continue;
        verts++;
        const b = bin(c.s), alat = Math.abs(c.lat);
        if (m.mat === 'rail') {
          if (alat < 1.1) b.rail++;
          else if (Math.abs(alat - oppAt(c.s)) < 1.1) b.opp++;
        } else if (m.mat === 'segment') b.tube++;
        else if (m.mat === 'concrete') {
          if (c.y < -0.6) b.deck++;
          if (c.y < -6) b.pier++;
          if (Math.abs(alat - 1.37) < 0.45 && c.y > -0.05 && c.y < 0.40) b.third++;
        } else if (m.mat === 'steel' && c.y > 4.5) b.cat++;
        else if (m.mat === 'granite' && c.y > 0.15 && c.y < 0.65) b.plat++;
        else if ((m.mat === 'metal' || m.mat === 'concreteD') && alat < 1.3 && c.y > -0.25 && c.y < 0.15) b.fast++;
      }
    }
    /* 按类型汇总 + 找缺口 */
    const agg = {};
    const gaps = [];
    for (let s = 0; s <= total; s++) {
      const k = kinds[s], b = bins[s] || {};
      const a = agg[k] || (agg[k] = { n: 0, rail: 0, opp: 0, third: 0, cat: 0, tube: 0, deck: 0, pier: 0, plat: 0, fast: 0 });
      a.n++;
      for (const f of ['rail', 'opp', 'third', 'cat', 'tube', 'deck', 'pier', 'plat', 'fast']) if (b[f]) a[f]++;
    }
    /* 缺口：连续 GAP 米以上没有任何旗标的同类型区段 */
    let run0 = -1;
    for (let s = 0; s <= total + 1; s++) {
      const b = s <= total ? bins[s] : null;
      const empty = s > total || !b || (!b.rail && !b.tube && !b.deck && !b.plat && !b.third && !b.cat);
      if (!empty && run0 >= 0) {
        const len = s - run0;
        if (len >= GAP) {
          const kk = kinds[Math.min(total, (run0 + s) >> 1)];
          const have = {};
          for (let q = run0; q < s; q++) { const bb = bins[q] || {}; for (const f of ['rail', 'tube', 'deck', 'plat', 'third', 'cat']) if (bb[f]) have[f] = 1; }
          gaps.push({ s0: run0, s1: s, kind: kk, len: Math.round(len), have: Object.keys(have).join('/') || '∅' });
        }
        run0 = -1;
      } else if (empty && run0 < 0) run0 = s;
    }
    /* 构件专项缺口：隧道无管片 / 高架无桥面桥墩 / 站区无站台 */
    const spec = [];
    const scanKind = (kind, key, minLen) => {
      let r0 = -1;
      for (let s = 0; s <= total + 1; s++) {
        const isK = s <= total && kinds[s] === kind;
        if (!isK) { if (r0 >= 0) { if (s - r0 >= minLen) spec.push(`${kind} 段 ${key} 缺 ${r0}~${s} (${s - r0} m)`); r0 = -1; } continue; }
        const miss = !(bins[s] && bins[s][key]);
        if (!miss && r0 >= 0) { if (s - r0 >= minLen) spec.push(`${kind} 段 ${key} 缺 ${r0}~${s} (${s - r0} m)`); r0 = -1; }
        else if (miss && r0 < 0) r0 = s;
      }
    };
    if (kinds.includes('tunnel')) scanKind('tunnel', 'tube', GAP);
    if (kinds.includes('viaduct')) { scanKind('viaduct', 'deck', GAP); /* 桥墩是离散构件，按间距查：连续 45 m 无墩才报 */
      { let p0 = -1;
        for (let s2 = 0; s2 <= total + 1; s2++) {
          const isV = s2 <= total && kinds[s2] === 'viaduct';
          if (!isV) { p0 = -1; continue; }          // 站区/隧道不算"无墩"
          if (bins[s2] && bins[s2].pier) { if (p0 >= 0 && s2 - p0 > 45) spec.push(`pier 间距超限 ${p0}~${s2} (${s2 - p0} m 无墩)`); p0 = s2; }
        } } }
    if (kinds.includes('station')) {
      /* 站区尾部 60 m 是停车标区：站台板铺到停车标内方 ~53 m 为止
         （停车标 = 板尾再往外 39~53 m 的停车点），尾部这段没有板是设计。 */
      const skipHead = new Set();
      for (const r of SH.WorldBuilder.runsOf(line, 0, line.al.total, 1))
        if (r.kind === 'station') for (let s = Math.max(0, Math.floor(r.s1) - 60); s <= Math.min(total, Math.ceil(r.s1)); s++) skipHead.add(s);
      let r0 = -1;
      for (let s = 0; s <= total + 1; s++) {
        const isK = s <= total && kinds[s] === 'station' && !skipHead.has(s);
        if (!isK) { if (r0 >= 0) { if (s - r0 >= 30) spec.push(`plat 缺 ${r0}~${s} (${s - r0} m)`); r0 = -1; } continue; }
        const miss = !(bins[s] && bins[s].plat);
        if (!miss && r0 >= 0) { if (s - r0 >= 30) spec.push(`plat 缺 ${r0}~${s} (${s - r0} m)`); r0 = -1; }
        else if (miss && r0 < 0) r0 = s;
      }
    }
    /* 供电方式：profile.supply —— 'oh' 高架应为接触网，隧道/库区为第三轨（设计口径） */
    const supply = (line.profile && line.profile.supply) || 'oh';
    /* 高架段供电对账：'oh' 线高架该有接触网、不该有第三轨（track 的 noSupply
       被无视时就会长出第三轨）；'third' 线高架该有第三轨（viaduct 自己铺）。 */
    /* runWith/runWithout：高架段里"有第三轨的连续米数"与"没接触网的连续米数"。
       顶点密度（sweep step 4~6）决定了逐米统计必然虚高，必须按连续段计。 */
    const runScan = (key, minLen, want) => {
      let r0 = -1, n = 0;
      for (let s = 0; s <= total + 1; s++) {
        const hit = s <= total && kinds[s] === 'viaduct' && !!(bins[s] && bins[s][key]);
        const cur = want ? hit : !hit && (s <= total && kinds[s] === 'viaduct');
        if (cur && r0 < 0) r0 = s;
        else if (!cur && r0 >= 0) { if (s - r0 >= minLen) n += s - r0; r0 = -1; }
      }
      return n;
    };
    const viadThird = supply === 'oh' ? runScan('third', 10, true) : 0;
    const viadNoCat = supply === 'oh' ? runScan('cat', 12, false) : 0;
    RESULTS.push({ label, id, svc, total: Math.round(line.al.total), verts, bakeMs: Math.round(performance.now() - t0), agg, gaps, spec, supply, viadThird, viadNoCat });
  }
}

/* ------------------------------------------------------------------ 报告 */
for (const r of RESULTS) {
  console.log(`\n== ${r.label} (${r.id}${r.svc === 'branch' ? '#branch' : ''})  ${r.total} m  顶点 ${r.verts}  烘焙 ${r.bakeMs} ms  供电 ${r.supply}`);
  for (const k of Object.keys(r.agg)) {
    const a = r.agg[k], pct = (n) => a.n ? Math.round(100 * n / a.n) : 0;
    console.log(`   ${k.padEnd(8)} ${String(a.n).padStart(6)} m   钢轨 ${pct(a.rail)}%  对向 ${pct(a.opp)}%  三轨 ${pct(a.third)}%  接触网 ${pct(a.cat)}%  管片 ${pct(a.tube)}%  桥面 ${pct(a.deck)}%  桥墩 ${pct(a.pier)}%  站台 ${pct(a.plat)}%  扣件 ${pct(a.fast)}%`);
  }
  if (r.supply === 'oh' && r.viadThird) console.log(`   ⚠ 高架段第三轨 ${r.viadThird} m（'oh' 线高架不该有第三轨 —— track() 的 noSupply 被无视）`);
  if (r.supply === 'oh' && r.viadNoCat) console.log(`   ⚠ 高架段无接触网 ${r.viadNoCat} m`);
  for (const g of r.gaps) console.log(`   ⚠ 缺口 ${g.s0}~${g.s1} (${g.len} m) [${g.kind}] 仅存: ${g.have}`);
  for (const s of r.spec) console.log(`   ⚠ ${s}`);
  if (!r.gaps.length && !r.spec.length && !r.viadThird) console.log('   ✓ 覆盖完整');
}
const bad = RESULTS.filter(r => r.gaps.length || r.spec.length || (r.supply === 'oh' && (r.viadThird || r.viadNoCat)));
console.log(`\n${RESULTS.length} 条线/交路审计完成，${bad.length} 条有发现`);
process.exit(0);
