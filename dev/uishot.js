/* dev/uishot.js — DOM 界面截图取证：dev/shot.js 拍的是 WebGL 画布（toDataURL），
 * 永远看不见 DOM 界面；而"UI 挡不挡画面"只有整页截图（Page.captureScreenshot）才量得到。
 *
 * 用法：
 *   node dev/uishot.js <名称> <场景> [再来一组...]
 *   场景：home / select / game / game2 / pause / help / settings / result
 *     game  = 选 LINE（默认 l2）从 START（默认 8）发车，推进 FRAMES（默认 40）帧后的驾驶界面
 *     game2 = 同 game，但发车后切换一次 HUD 简洁模式（若存在 #hud-zen）
 *   环境变量：LINE=l2 START=8 FRAMES=40 W=1440 H=900
 *
 * 实现约束与 dev/shot.js 同源：serve.js 与 Chrome 都由本脚本拉起并回收；
 * canvas 没有 preserveDrawingBuffer，所以 WebGL 部分靠 Page.captureScreenshot
 * 在合成层拿（不走 toDataURL），DOM 与 3D 同帧可见。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('✗ 找不到 Chrome/Edge'); process.exit(1); }

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) { console.error('用法：node dev/uishot.js <名称> <场景> [再来一组...]'); process.exit(1); }
const jobs = [];
for (let i = 0; i < args.length; i += 2) jobs.push({ name: args[i], scene: args[i + 1] });

const PORT_S = 8891, PORT_D = 9345;
const W = +(process.env.W || 1440), H = +(process.env.H || 900);
const LINE = process.env.LINE || 'l2', START = +(process.env.START || 8), FRAMES = +(process.env.FRAMES || 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCENE_FN = `(async (scene, line, startIdx, nFrames) => {
  const a = window.__SH;
  window.requestAnimationFrame = () => 0;                 // 手动推帧，截图才确定
  const step = n => { for (let i = 0; i < n; i++) a.frame(1000 + i * 33); };
  const note = [];
  if (scene === 'home') { a.show('home'); step(2); }
  else if (scene === 'select') { a.show('select'); a.ui.syncSelect(); step(2); }
  else if (scene === 'help') { a.show('home'); a.ui.modal('help'); step(1); }
  else if (scene === 'settings') { a.show('home'); a.ui.modal('settings'); step(1); }
  else if (scene === 'game' || scene === 'game2' || scene === 'gamedim' || scene === 'gamenc') {
    if (a.ui && a.ui.setZen) a.ui.setZen(false);          // 场景互相独立，不带上一个场景的 zen
    a.setLine(line, false);
    a.startIdx = startIdx; a.legs = 3; a.mode = 'manual';
    a.begin();
    step(nFrames);
    if (scene === 'game2') {
      if (a.ui && a.ui.setZen) { a.ui.setZen(true); note.push('zen on'); }
      else note.push('no setZen');
      step(2);
    }
    if (scene !== 'gamedim') {
      /* 唤醒 HUD：uishot 从页面加载到截图超过 5 s（烘焙 + 推帧），闲置淡出会触发，
         不唤回的话拍到的全是 dim 态而不是默认态。gamedim 场景则故意拍 dim 态。 */
      window.dispatchEvent(new PointerEvent('pointermove'));
      note.push('awake');
    }
    if (scene === 'gamenc') { document.getElementById('gl').style.display = 'none'; note.push('canvas hidden'); }
  }
  else if (scene === 'pause') {
    a.setLine(line, false); a.startIdx = startIdx; a.legs = 3; a.mode = 'manual'; a.begin(); step(10);
    a.pause(); step(1);
  }
  else if (scene === 'result') {
    /* 结算页不跑真局：直接喂一份假汇总，只看版式（跑真局要几分钟，版式与数据无关）。
       先关掉上一个场景可能留下的弹层（pause/settings），否则会盖在结算页上。 */
    if (a.ui && a.ui.modal) a.ui.modal(null);
    a.show('result');
    a.ui.renderResult({ total: 91, grade: 'S', mode: 'manual', line: a.line,
      pax: { boarded: 812, alighted: 645, leftBehind: 37 }, depot: null,
      results: [
        { station: a.line.stations[startIdx + 1], err: 0.12, smooth: 96, pax: 100, off: 210, on: 260, load: 87, grade: 'SS', color: '#76e6ff' },
        { station: a.line.stations[startIdx + 2], err: -0.34, smooth: 92, pax: 98, off: 180, on: 240, load: 91, grade: 'S', color: '#9ce8ff' },
        { station: a.line.stations[startIdx + 3], err: 1.62, smooth: 88, pax: 96, off: 255, on: 112, load: 76, grade: 'B', color: '#f6da67' },
      ] });
    step(1);
  }
  else return '未知场景 ' + scene;
  /* 让 CSS 过渡走完（DOM 截图不需要 rAF，但要等一拍） */
  await new Promise(r => setTimeout(r, 450));
  const hud = document.getElementById('screen-game');
  return { scene, note: note.join(','), cls: hud ? hud.className : '' };
})`;

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'serve.js'), String(PORT_S)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT_S}/index.html`); if (r.ok) break; } catch (e) { }
    await sleep(200);
  }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'uishot-'));
  /* SwiftShader 软渲染下 Page.captureScreenshot 会把 WebGL 层以叠加方式混进截图，
     让不透明 DOM 面板上"透出"亮部内容（本次 TCMS 鬼影的来源）——那是截图伪影，
     不是真渲染。GPU=1 用真实 GPU 复核时这个鬼影必须消失，否则才是真 bug。 */
  const gl = process.env.GPU ? [] : ['--use-angle=swiftshader'];
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT_D,
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions', '--mute-audio',
    ...gl, '--force-device-scale-factor=1', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
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
  await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    const r = await call('Runtime.evaluate', { expression: '!!(window.__SH && window.__SH.line)', returnByValue: true });
    up = !!(r.result && r.result.value); if (!up) await sleep(300);
  }
  if (!up) { console.error('✗ 页面 30 秒没起来（__SH 未就绪）'); cleanup(); process.exit(1); }
  console.log('页面就绪：' + ver.Browser);
  /* 与 dev/shot.js 同一条纪律：取证时把自适应分辨率钉死，否则整页截图的像素预算
     会在跑的过程中自己变（对拍就失去意义）。`UIAUTO=1` 反过来保留产品默认档 ——
     拍"自动档开关长什么样、HUD 上生效档写没写"这类**界面证据**要用它。 */
  if (process.env.UIAUTO !== '1') {
    await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.r.setResAuto(false); a.resetDrs(); return true;})()' });
  }
  let bad = 0;
  for (const j of jobs) {
    const r = await call('Runtime.evaluate', {
      expression: '(' + SCENE_FN + ')(' + JSON.stringify(j.scene) + ',' + JSON.stringify(LINE) + ',' + START + ',' + FRAMES + ')',
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) { bad++; console.log('✗ ' + j.name + ': ' + r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || '')); continue; }
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    const p = path.join(__dirname, '..', 'shots', j.name + '.png');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    const v = r.result.value;
    console.log('✓ ' + j.name + ' → shots/' + j.name + '.png' + (v && v.note ? '  (' + v.note + ')' : '') + (v && v.cls ? '  [' + v.cls + ']' : ''));
  }
  ws.close(); cleanup();
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
