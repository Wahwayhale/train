/* dev/inst-check.js — 实例化通道的实景对账（真 GPU，不靠猜）
 *
 * 为什么要有它：实例化通道的两个失效模式在**离线判据里全是静默的**。
 *   ① 实例数没传到 GL —— drawElementsInstanced 的 instanceCount 退回 1，
 *      于是一组 12 个实例只画第 1 个。draw call 数照样降了（perf 表看起来"优化成功"），
 *      三角形统计也跟着少算 11/12，画面只是"车变少了"，而"街上车少"本来就像正常。
 *   ② shader 里的实例基变换写反（把列当行点乘）—— 顶点被 Rᵗ 而不是 R 变换，
 *      直线段上看着几乎对，弯道上的车歪着走。
 * 两种都能"全绿"。唯一的裁判是 GPU：这里把 JS 侧请求的实例数与 GL 侧真正提交的
 * 实例数逐帧对账，再把"实例化路径"与"逐实例回退路径"同一帧做像素 A/B。
 *
 * 用法：
 *   node dev/inst-check.js                      # 默认 l1 @ 0.5 street（街面车流）
 *   node dev/inst-check.js l1 0.5 platform
 *   RUN=1 node dev/inst-check.js l1 4 cab       # 真实行车局（AI 车队在场）
 *   OPP=1 node dev/inst-check.js l5 3 platform  # 对向车队
 *   B=1   node dev/inst-check.js ...            # 只跑 A/B，不跑实例数对账
 *
 * 判据两条，红字即退出码非 0：
 *   实例账：一帧里 GL 侧来自 drawInstanced 的实例总数 == JS 侧请求的实例总数；
 *   A/B：隐藏半透材质后，两条路径的画面差异 ≤ 0.5% 像素（不透明几何与顺序无关，
 *        差异只可能来自实例矩阵或 shader 基变换本身）。
 * 半透材质之所以要隐藏：实例化把中段车改成"先全部不透明、再全部玻璃"，
 * 混合叠序**有意**变了（交接书 §4.3 步 3），不分开就量不出几何错没错。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('✗ 找不到 Chrome/Edge'); process.exit(1); }

const a = process.argv.slice(2);
const cfg = {
  line: a[0] || 'l1',
  mid: a[1] == null ? 0.5 : parseFloat(a[1]),
  view: a[2] || 'street',
  run: process.env.RUN === '1',
  opp: process.env.OPP === '1',
  shot: process.env.SHOT === '1',
  nopin: process.env.NOPIN === '1',
  skipCount: process.env.B === '1',
  /* showcase 模式把玩家车门开到指定开度（dev/shot.js 的 showcaseDoor 同族）：
     玩家中段车与 AI 车在开门时差一处 —— 玻璃批次按 emi:1 提亮，关门对拍量不到它。 */
  doors: process.env.DOORS != null ? parseFloat(process.env.DOORS) : null,
};
/* 与 renderer MATERIALS 的 blend:true 同源 —— 抄一份就是第二个真值，
   所以从页面里现取。见页面代码的 blendMats。 */
/* 端口每次随机：改完 src/*.js 再用同一端口，Chrome 会命中子资源的 HTTP 缓存
   （serve.js 不发 ETag），页面里跑的还是旧 renderer —— 症状是"改了没生效"。
   origin 一变缓存就绕开了（本项目换端口验证过多次）。 */
const PORT_S = 8890 + (process.pid % 97);
const PORT_D = PORT_S + 400;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 页面函数：字符串拼接构造（dev/shot.js PAGE_FN 的同一条纪律 —— 外层套模板插值
   会把页面里的 ${} 二次求值，当场语法错），页面代码内不许出现反引号。 */
const PAGE_FN = '(async (cfg) => {' +
  'const a = window.__SH, c = a.canvas, gl = a.r.gl;' +
  /* 自证页面跑的是磁盘上这份 renderer（子资源缓存会静默给出旧代码） */
  'const srcTxt = await (await fetch("/src/renderer.js")).text();' +
  'const srcFix = { shader: srcTxt.indexOf("aI0.xyz * aPos.x") >= 0, batch: srcTxt.indexOf("_drawBatch(b, ov, n)") >= 0, reset: srcTxt.indexOf("gl.uniform1f(u.inst, 0)") >= 0 };' +
  'window.requestAnimationFrame = function () { return 0; };' +
  'a.setLine(cfg.line, false);' +
  'a.running = false; a.session = null; a.traffic = null;' +
  'const S = a.line.al.stationS, i0 = Math.floor(cfg.mid);' +
  'const scS = S[i0] + (S[Math.min(i0 + 1, S.length - 1)] - S[i0]) * (cfg.mid - i0);' +
  'if (cfg.run) {' +
  '  a.hour = 8.5; a.clock = 8.5 * 3600; a.startIdx = Math.max(0, i0); a.view = cfg.view;' +
  '  a.begin(); a.running = true;' +
  /* 把三列 AI 车钉到玩家前方，并给出真实的车载与门开度：
     ① 判据不能押在"这一帧恰好有一列车在 900 m 内"—— 实测 begin() 后第一帧
        visible() 为空，drawExternal 一次都没调，判据会静默空跑（画个 0% 差异
        看起来像"两条路径一致"）；
     ② 门开度 > 0 才走得到"滑移并进每实例矩阵"那一段；车载 > 0 才走得到乘客分档。
     钉的是调度器自己的字段（t.s / t.tr.s / t.open / t.load），绘制路径与实景同一条。
     NOPIN=1 用来验不加钉的真实行车局。 */
  '  if (!cfg.nopin) {' +
  '    const ps = a.session.s, tt = a.traffic.trains;' +
  '    for (let k = 0; k < tt.length; k++) {' +
  '      const t = tt[k];' +
  '      if (k < 3) { t.s = ps + 260 + k * 250; t.tr.s = t.s; t.tr.v = 0; t.open = 0.42; t.load = 0.85; }' +
  '      else { t.s = ps + 2600 + k * 400; t.tr.s = t.s; t.tr.v = 0; }' +
  '    }' +
  '  }' +
'} else {' +
'  if (cfg.doors != null) a.showcaseDoor = cfg.doors;' +
'  a.showcase = { s: scS, t: 0 }; a.bakeShowcase(); a.view = cfg.view;' +
'}' +
  /* 对向车队：与 shot.js OPP=1 同一份配方（正向车撒出取景半径，只留对向） */
  'if (cfg.opp) {' +
  '  const al = a.line.al, total = al.total;' +
  '  if (!a.traffic) { a.traffic = new window.SH.traffic.Dispatcher(a.line); a.traffic.reset(0); }' +
  '  a.traffic.playerS = null;' +
  '  a.traffic.trains.forEach(function (t, i) { t.s = (scS + 2600 + i * 500) % total; t.tr.s = t.s; t.tr.v = 0; });' +
  '  if (!a.opp) { a.opp = new window.SH.traffic.Dispatcher(a.line.mirror(), { hour: a.hour, dayT0: a.clock || 0, rain: a.rain }); a.opp.reset(total - scS); a.opp.playerS = null; }' +
  '  a.opp.trains.forEach(function (t, i) { t.s = i ? (total - scS + 2600 + i * 500) % total : total - scS + 80; t.tr.s = t.s; t.tr.v = 0; });' +
  '  a.running = true;' +
  '}' +
  'await new Promise(function (res) { setTimeout(res, 1200); });' +
  /* 接线自证：判据报"没走实例化"时，三种原因（没有 AI 车可见 / drawExternal 没被调 /
     调了但走的是回退分支）画面上完全一样。这里把三者分开报。 */
  'const pre = { trains: a.traffic ? a.traffic.trains.length : -1, oppTrains: a.opp ? a.opp.trains.length : -1,' +
  '  running: !!a.running, session: !!a.session, s: a.session ? +a.session.s.toFixed(0) : null,' +
  '  view: a.view, midCarB: !!a.trainView.midCarB, cars: a.line.profile.cars, street: !!a.street,' +
  '  elevated: a.session ? !!a.line.isElevated(a.session.s) : null,' +
  /* 街面车流判据的**适用前提**从产品真值取：车流机制只沿高架走廊铺车
     （street.js draw() 第一行就筛 isElevated），取证里程 ±400 m 都不在走廊上时
     "撤掉车流画面不动"是几何事实，不是车流丢了 —— 判据此时明说不适用，不空跑也不放水。 */
  '  elevNear: [scS - 400, scS - 200, scS, scS + 200, scS + 400].some(function (x) { return a.line.isElevated(x); }) };' +
  'const xw = { ext: 0, extOpp: 0 };' +
  'const de0 = a.trainView.drawExternal.bind(a.trainView);' +
  'a.trainView.drawExternal = function () { xw.ext++; if (a._cutOn) a._suppress = 1; const q = de0.apply(null, arguments); a._suppress = 0; return q; };' +
  'const do0 = a.trainView.drawExternalOpp.bind(a.trainView);' +
  'a.trainView.drawExternalOpp = function () { xw.extOpp++; if (a._cutOn) a._suppress = 1; const q = do0.apply(null, arguments); a._suppress = 0; return q; };' +
  /* 街面车流的同类开关：a.street.draw 整块撤掉 = 量"实例化的车流占多少画面" */
  'if (a.street) { const ds0 = a.street.draw.bind(a.street);' +
  '  a.street.draw = function (rr, eye) { if (a._cutStreet) return; return ds0(rr, eye); }; }' +
  /* ---- 对账用的三层桩 ---- */
  'const ic = { reqCalls: 0, reqInst: 0, glCalls: 0, glInst: 0, inside: false, detail: [], emiCalls: 0, emiInst: 0 };' +
  'const dei = gl.drawElementsInstanced ? gl.drawElementsInstanced.bind(gl) : null;' +
  'if (dei) gl.drawElementsInstanced = function (m, cnt, ty, off, n) {' +
  '  if (ic.inside) { ic.glCalls++; ic.glInst += (n || 1); if (ic.detail.length < 24) ic.detail.push([cnt / 3, n || 1]); }' +
  '  return dei(m, cnt, ty, off, n);' +
  '};' +
  'const od = a.r.draw.bind(a.r);' +
  'a.r.draw = function (b, M, ov) { if (a._hideSet && a._hideSet[b.mat]) return; if (a._suppress && b.tag === "train") return; return od(b, M, ov); };' +
  'let diRef = a.r.drawInstanced ? a.r.drawInstanced.bind(a.r) : null;' +
  /* 第 135 条的教训：这个包装器以前只转发三个参数。加了"按实例给涂装色"之后，
     A 路（实例化）拿不到 tints、B 路（逐实例回退）拿得到 —— A/B 差出 1.19%，
     看起来像产品把车画错了，实际是**探针自己漏传了一个参数**。
     包装器必须原样转发整条签名，否则它量的不是同一条通道。 */
  'const wrap = diRef ? function (b, mats, ov, tints) {' +
  '  ic.reqCalls++; ic.reqInst += mats.length;' +
  /* 门玻璃 emi 账：玩家路径开门时车门玻璃批次带 {emi:1}（AI 车没有）。
     只数"mat=window 且 ov.emi===1"的调用 —— 侧窗玻璃走 B.glass、不带 emi，混不进来。 */
  '  if (ov && ov.emi === 1 && b.mat === "window") { ic.emiCalls++; ic.emiInst += mats.length; }' +
  '  if (a._hideSet && a._hideSet[b.mat]) return;' +
  '  if (a._suppress && b.tag === "train") return;' +
  '  ic.inside = true; try { diRef(b, mats, ov, tints); } finally { ic.inside = false; }' +
  '  return undefined;' +
  '} : null;' +
  'a.r.drawInstanced = wrap;' +
  /* 半透材质名单从材质表现取，不在这里抄第二份 */
  'const blendMats = {};' +
  'const MT = window.SH.MATERIALS || {};' +
  'for (const k in MT) if (MT[k] && MT[k].blend) blendMats[k] = 1;' +
  'const frameOnce = function (t) { a.frame(t); return c.toDataURL("image/png"); };' +
  /* ---- ① 实例数对账：一帧的账 ---- */
  'const t0 = performance.now();' +
  'a._hideSet = null;' +
  'ic.reqCalls = 0; ic.reqInst = 0; ic.glCalls = 0; ic.glInst = 0; ic.detail = []; ic.emiCalls = 0; ic.emiInst = 0;' +
  'const urlI = frameOnce(t0);' +
  'const count = { reqCalls: ic.reqCalls, reqInst: ic.reqInst, glCalls: ic.glCalls, glInst: ic.glInst, detail: ic.detail.slice(0), emiCalls: ic.emiCalls, emiInst: ic.emiInst, statsDraws: a.r.stats.draws, statsTris: Math.round(a.r.stats.tris) };' +
  /* ---- ② A/B：实例化 vs 逐实例回退（隐藏半透） ---- */
  /* dt 钉 0（App.frame 里 paused 只做这一件事）：三条路径之间不许有任何"场景自己
     动了"的差异，否则噪声地板（0.07%）比被测差异还大，门槛只能放到 0.3%，
     而 Rᵀ 那一类错实测是 0.56%~0.95% —— 松到那个程度就抓不住它。 */
  'a.paused = true;' +
  'a._hideSet = blendMats;' +
  'ic.reqCalls = 0; ic.reqInst = 0; ic.glCalls = 0; ic.glInst = 0;' +
  'const urlA = frameOnce(t0);' +
  'const abInst = { reqInst: ic.reqInst, glInst: ic.glInst, draws: a.r.stats.draws, tris: Math.round(a.r.stats.tris) };' +
  'a.r.drawInstanced = null;' +
  'const urlB = frameOnce(t0);' +
  'const abPlain = { draws: a.r.stats.draws, tris: Math.round(a.r.stats.tris) };' +
  'const load = async function (u) { return createImageBitmap(await (await fetch(u)).blob()); };' +
  'const grab = async function (u) { const im = await load(u); const cc = new OffscreenCanvas(im.width, im.height);' +
  '  const x = cc.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);' +
  '  return x.getImageData(0, 0, im.width, im.height).data; };' +
  /* 噪声地板：C = 再走一遍**实例化**路径。A↔C 之间只有 2 ms 的推进与 GPU 精度，
     没有代码路径差异 —— 所以它是"两条路径本来就该差这么多"的下限。
     门槛按地板给（4 倍 + 0.02 个百分点），而不是拍一个看起来严格的数。 */
  'a.r.drawInstanced = wrap;' +
  'const urlC = frameOnce(t0);' +
  'a.paused = false;' +
  'const imA = await load(urlA);' +
  'const pxdiff = function (X, Y) {' +
  '  let diff = 0, n = 0, sumAbs = 0, maxAbs = 0;' +
  '  for (let i = 0; i < X.length; i += 4) {' +
  '    const dr = Math.abs(X[i] - Y[i]), dg = Math.abs(X[i + 1] - Y[i + 1]), db = Math.abs(X[i + 2] - Y[i + 2]);' +
  '    const mx = Math.max(dr, dg, db); n++; sumAbs += (dr + dg + db) / 3; if (mx > maxAbs) maxAbs = mx;' +
  '    if (mx > 8) diff++;' +
  '  }' +
  '  return { diffPct: +(100 * diff / n).toFixed(3), meanAbs: +(sumAbs / n).toFixed(3), maxAbs };' +
  '};' +
  'const dB = await grab(urlB), dA = await grab(urlA), dC = await grab(urlC);' +
  'const ab = pxdiff(dA, dB), floor = pxdiff(dA, dC);' +
  'ab.w = imA.width; ab.h = imA.height;' +
  'ab.inst = abInst; ab.plain = abPlain; ab.blendHidden = Object.keys(blendMats).length; ab.floor = floor;' +
  /* ---- ③ 对照面：这些实例化到底占了多少画面 ---- */
  /* 没有这一条，"A/B 差 0%"有两种完全相反的解释：两条路径一致 / 这里根本没画东西。
     把 AI 车的批次整块撤掉（tag=train，且只在 drawExternal/Opp 里撤，玩家自己的车不动），
     再撤掉街面车流，各量一次像素变化 —— 撤了画面不动 = 判据在空跑。 */
  'a.paused = true; a._hideSet = null; a.r.drawInstanced = wrap;' +
  'a._cutOn = false; a._cutStreet = false;' +
  'const urlX = frameOnce(t0);' +
  'a._cutOn = true;' +
  'const urlY = frameOnce(t0);' +
  'a._cutOn = false; a._cutStreet = true;' +
  'const urlZ = frameOnce(t0);' +
  'a._cutStreet = false; a.paused = false;' +
  'const dX = await grab(urlX);' +
  'const cov = { ai: pxdiff(dX, await grab(urlY)), street: pxdiff(dX, await grab(urlZ)) };' +
  /* SHOT=1：再各拍一张**不隐藏半透**的全画面（inst-full-A/B）。
     实例化把中段车改成"先全部不透明、再全部玻璃"，混合叠序是有意改变的
     （交接书 §4.3 步 3），A/B 判据为了量几何把它隐藏了 —— 观感那一半只能看图，
     而"改前改后各拍一张"在这里一次就成，不用另找旧版本回退。 */
  'let full = null;' +
  'if (cfg.shot) {' +
  '  a.paused = true; a._hideSet = null; a.r.drawInstanced = wrap;' +
  '  const urlFA = frameOnce(t0);' +
  '  a.r.drawInstanced = null;' +
  '  const urlFB = frameOnce(t0);' +
  '  a.paused = false; a.r.drawInstanced = wrap;' +
  '  await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inst-full-A", data: urlFA }) }).catch(function () {});' +
  '  await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inst-full-B", data: urlFB }) }).catch(function () {});' +
  '  const fA = await grab(urlFA), fB = await grab(urlFB);' +
  '  full = pxdiff(fA, fB);' +
  '}' +
  'await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inst-ab-A", data: urlA }) }).catch(function () {});' +
  'await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inst-ab-B", data: urlB }) }).catch(function () {});' +
  'return { api: a.r.api, gl2: !!a.r.gl2, hasDrawInstanced: !!wrap, srcFix: srcFix, pre: pre, xw: xw, count: count, ab: ab, cov: cov, full: full, view: cfg.view, line: cfg.line };' +
  '})';

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'serve.js'), String(PORT_S)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT_S}/index.html`); if (r.ok) break; } catch (e) { }
    await sleep(200);
  }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT_D,
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions', '--mute-audio',
    '--use-angle=swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) { } try { srv.kill(); } catch (e) { } };
  process.on('exit', cleanup);
  let ver = null;
  for (let i = 0; i < 75 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT_D}/json/version`)).json(); } catch (e) { await sleep(200); }
  }
  if (!ver) { console.error('✗ Chrome 远程调试端口 60 秒没起来'); cleanup(); process.exit(1); }
  const tgt = await (await fetch(`http://127.0.0.1:${PORT_D}/json/new?` + encodeURIComponent(`http://127.0.0.1:${PORT_S}/index.html`), { method: 'PUT' })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    const r = await call('Runtime.evaluate', { expression: '!!(window.__SH && window.__SH.line)', returnByValue: true });
    up = !!(r.result && r.result.value); if (!up) await sleep(300);
  }
  if (!up) { console.error('✗ 页面 30 秒没起来（__SH 未就绪）'); cleanup(); process.exit(1); }
  /* 取证前把自适应分辨率钉死（与 dev/shot.js 同一条纪律）：这一支量的是"JS 请求的
     实例数 ↔ GL 实画的实例数"与像素 A/B，像素预算中途自己变了两边就对不上账。 */
  await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.r.setResAuto(false); a.resetDrs(); return true;})()' });
  const r = await call('Runtime.evaluate', {
    expression: `(${PAGE_FN})(${JSON.stringify(cfg)})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    console.log('✗ 探针异常：' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    ws.close(); cleanup(); process.exit(1);
  }
  const v = r.result.value;
  const mode = (cfg.run ? '行车' : 'showcase') + (cfg.opp ? '+对向' : '');
  console.log(`${v.line}@${cfg.mid} ${cfg.view}（${mode}）· ${v.api} · GL2=${v.gl2} · renderer 有 drawInstanced=${v.hasDrawInstanced}`);
  let bad = 0;
  /* 先自证被测对象：三处修复的字面量不在页面拉到的 renderer.js 里，
     下面所有数字量的都是缓存里的旧代码（本项目栽过子资源缓存）。 */
  const sf = v.srcFix || {};
  if (!sf.shader || !sf.batch || !sf.reset) {
    bad++;
    console.log(`✗ 页面里的 renderer.js 缺修复标记 shader=${sf.shader} batch=${sf.batch} reset=${sf.reset} —— 测的不是磁盘上这份代码`);
  }
  const ct = v.count;
  if (cfg.skipCount) {
    console.log('实例账：B=1 跳过');
  } else if (!ct.reqCalls) {
    const pr = v.pre || {}, xw = v.xw || {};
    console.log('✗ 实例账：这一帧没有任何 drawInstanced 调用 —— 场景里没东西走实例化通道，本判据等于没跑');
    console.log(`    接线：AI 正向车队 ${pr.trains} 列 · 对向 ${pr.oppTrains} 列 · drawExternal 调 ${xw.ext} 次 · drawExternalOpp 调 ${xw.extOpp} 次`
      + ` · running=${pr.running} session=${pr.session} s=${pr.s} · 车型中间车批次 ${pr.midCarB ? '有' : '无'}`
      + ` · 编组 ${pr.cars} 节 · 街面车流 ${pr.street ? '在' : '无'}（${pr.view} 机位 · 该里程 ${pr.elevated === null ? 'n/a' : pr.elevated ? '高架' : '非高架'}）`);
    bad++;
  } else {
    const ok = ct.glInst === ct.reqInst && ct.glCalls === ct.reqCalls;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 实例账：JS 请求 ${ct.reqCalls} 次调用 / ${ct.reqInst} 个实例，`
      + `GL 实画 ${ct.glCalls} 次 / ${ct.glInst} 个实例`
      + (ok ? '' : ` —— 少画 ${ct.reqInst - ct.glInst} 个实例（每次实画 ${ct.glCalls ? Math.round(ct.glInst / ct.glCalls) : 0} 个）`));
    if (!ok) console.log('    样例 [每调用三角形数, 实画实例数]：' + JSON.stringify(ct.detail.slice(0, 8)));
    console.log(`    帧 stats：draws ${ct.statsDraws} · tris ${ct.statsTris}`);
    /* 门玻璃 emi 账：showcase（玩家列车）开门时必须 >0（中段车的玻璃亮灯走了实例化），
       关门时必须 = 0（AI 车与关门状态都不许漏 emi）。 */
    if (cfg.doors > 0 && !ct.emiCalls) {
      bad++;
      console.log('✗ 门玻璃 emi 账：门开着却没有一个 window 批次带 emi:1 进实例化 —— 玩家车的门玻璃亮灯丢了');
    } else if (!cfg.doors && !cfg.run && ct.emiCalls) {
      bad++;
      console.log(`✗ 门玻璃 emi 账：门没开却有 ${ct.emiCalls} 次 window 批次带 emi:1（${ct.emiInst} 实例）—— emi 漏到了不该亮的地方`);
    } else if (ct.emiCalls) {
      console.log(`✓ 门玻璃 emi 账：${ct.emiCalls} 次 window 批次带 emi:1（${ct.emiInst} 实例）`);
    }
  }
  const ab = v.ab;
  const fl = ab.floor || { diffPct: 0, meanAbs: 0, maxAbs: 0 };
  const blendWarn = ab.blendHidden ? '' : '（材质表里没找到 blend 项，A/B 没隐藏半透）';
  /* 门槛由噪声地板给：A↔C 是同一条实例化路径连拍两张，只差 2 ms 推进与 GPU 精度。
     把门槛写成绝对常数 = 要么松到抓不住 Rᵀ 那一类（实测漏过），要么紧到天天假红。 */
  const capDiff = Math.max(0.02, fl.diffPct * 4 + 0.01);
  const capMean = Math.max(0.4, fl.meanAbs * 4 + 0.1);
  const okAB = ab.diffPct <= capDiff && ab.meanAbs <= capMean;
  if (!okAB) bad++;
  console.log(`${okAB ? '✓' : '✗'} A/B（实例化 vs 逐实例回退，隐藏 ${ab.blendHidden} 个半透材质）${blendWarn}：`
    + `差异像素 ${ab.diffPct}%（上限 ${capDiff.toFixed(3)}%）· 平均色差 ${ab.meanAbs}（上限 ${capMean.toFixed(2)}）· 最大色差 ${ab.maxAbs}`);
  console.log(`    噪声地板（实例化↔实例化连拍）：差异 ${fl.diffPct}% · 平均 ${fl.meanAbs} · 最大 ${fl.maxAbs}`);
  if (ab.inst.tris !== ab.plain.tris) {
    bad++;
    console.log(`✗ 两条路径提交的三角形数不等：实例化 ${ab.inst.tris} vs 回退 ${ab.plain.tris} —— 有实例没画出来或多画了`);
  }
  const saved = ab.plain.draws - ab.inst.draws;
  if (!cfg.skipCount && ct.reqCalls > 0 && saved <= 0) {
    bad++;
    console.log(`✗ 实例化没有省 draw（${ab.inst.draws} vs ${ab.plain.draws}）—— 通道没生效或在原地打转`);
  } else if (saved > 0) {
    console.log(`    实例化路径 draws ${ab.inst.draws} · 回退 ${ab.plain.draws} → 省 ${saved} 次 draw`);
  }
  console.log('    两张图存 shots/inst-ab-A.png（实例化）与 inst-ab-B.png（回退），肉眼复核用');
  /* 对照面：撤掉才知画面里到底有没有它 —— 没有这一条，"差 0%"可能是"没画东西" */
  const cov = v.cov || {}, xw = v.xw || {};
  const extCalls = (xw.ext || 0) + (xw.extOpp || 0);
  if (extCalls > 0) {
    const okAI = cov.ai && cov.ai.diffPct >= 0.02;
    if (!okAI) bad++;
    console.log(`${okAI ? '✓' : '✗'} 对照面：drawExternal ${xw.ext} 次 / 对向 ${xw.extOpp} 次，`
      + `把 AI 车整块撤掉画面变 ${cov.ai ? cov.ai.diffPct : '—'}%（最大色差 ${cov.ai ? cov.ai.maxAbs : '—'}）`
      + (okAI ? '' : ' —— 上面那条 A/B 量的是一片空气'));
  }
  if (cfg.view === 'street' && !((v.pre || {}).elevNear)) {
    console.log('—— 对照面：街面车流不适用（取证里程 ±400 m 不在高架走廊上 —— 车流机制只沿高架走廊铺车，这里本就没有车流可撤，判据不空跑也不放水）');
  } else if (cfg.view === 'street') {
    const okSt = cov.street && cov.street.diffPct >= 0.02;
    if (!okSt) bad++;
    console.log(`${okSt ? '✓' : '✗'} 对照面：街面车流整块撤掉画面变 ${cov.street ? cov.street.diffPct : '—'}%`
      + (okSt ? '' : ' —— 街面机位却没看到车流，实例化的车流不在画面里'));
  }
  if (v.full) {
    const fu = v.full;
    console.log(`    SHOT=1 全画面（含半透，叠序有意变了）：差异 ${fu.diffPct}% 像素 · 平均 ${fu.meanAbs} · 最大 ${fu.maxAbs}`
      + ' —— 只记录不断言，观感靠 shots/inst-full-A.png 与 inst-full-B.png 对比');
  }
  ws.close(); cleanup();
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
