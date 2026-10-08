/* ============================================================================
 * test-perf.js — 帧循环零分配 / 提交路径零查询的判据（第 21 个自测）
 *
 * 背景（README 第 149 条）："cpu 延迟大、帧率频繁波动"的主源不是某个慢函数，
 * 而是每帧分配的 GC 压力 —— draw 的 `ov||{}`（驾驶室档每帧最多 ~500 个短命
 * 对象）+ begin/_drawSky 每帧 ~25 个 Float32Array + envFor 每帧 ~30 个数组
 * + 24 次每帧 getUniformLocation。144fps 合计 ≈ 8 万次分配/秒，周期性
 * minor GC 就是波动。修法是结构性的（scratch 复用 / EMPTY 兜底 / 构造期
 * 位置表 / envAt 分桶缓存），本套件把它们钉死。
 *
 * 判据分组（负控见 dev/negctl.js：perfalloc / perfloc / perfempty /
 * perfinst / perfenv / perfmark）：
 *   ⓪ 行为：假 gl 逐帧记录 —— 构造完成后的整帧里 getUniformLocation = 0 次
 *      （位置表只许构造期取）；
 *   ① 行为：连续两帧，第二帧 uniform3fv/2fv 收到的 typed 数组**零新身份**
 *      （scratch 复用被绕过 = 又在每帧 new）。矩阵 uniform（vp/M，每帧 3 个
 *      数组，m4mul 的产物）**知情豁免**——修它要动 core.js 的矩阵 API，量级
 *      上不划算，注释里记账；
 *   ② 静态：begin/_drawSky/end 方法体内无 new Float32Array / 无
 *      getUniformLocation；draw/_drawBatch 无 `ov = ov || {}`；drawInstanced
 *      复用 _instData；
 *   ③ 静态：game.js 的 envFor 有分桶缓存（_envT.k !== kb）且体内无 .map(/
 *      Object.assign(；frame 循环 PERF.mark 打点 ≥6 处 + frameStart/close
 *      成对 + ?perf=1 开关 + HUD top(3)；IDENT 不再每帧 mat4()；
 *   ⑦ 行为：PERF.on=false 时 mark/frameStart/close 不累积不抛错（关闭零成本）。
 * 用法：node test-perf.js
 * ==========================================================================*/
require('./stub-dom.js');
/* SH.FRAME_PERF（帧归因，非车辆性能档案 SH.PERF——两者别混）定义在 game.js，
   静态 lint 也读 game.js，所以必须把整条链装载 —— 与 test-tex/test-scene 同规。 */
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'landmark', 'world', 'bve',
  'train', 'physics', 'pax', 'traffic', 'street', 'audio']) require('./src/' + f + '.js');
require('./data/shanghai.js');
require('./src/game.js');
const fs = require('fs');
const SH = global.SH;
const rSrc = fs.readFileSync('./src/renderer.js', 'utf8');
const gSrc = fs.readFileSync('./src/game.js', 'utf8');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { console.log('✗ ' + msg); bad++; } };
/* 类方法体提取：按花括号配对截取（这些方法体内没有嵌套花括号字面量）。 */
const methodBody = (src, sig) => {
  const i = src.indexOf('  ' + sig);
  if (i < 0) return null;
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(j, k + 1); }
  }
  return null;
};

/* ---------- ⓪① 行为判据：假 gl 记录两帧 ---------- */
{
  let locId = 1;
  const base = {
    _locCalls: 0, _uniBufs: [], _noop: () => {},
    MAX_SAMPLES: 8, MAX_TEXTURE_SIZE: 4096,
    getUniformLocation() { base._locCalls++; return locId++; },
    getAttribLocation() { return locId++; },
    getShaderParameter() { return true; },
    getProgramParameter() { return true; },
    getShaderInfoLog() { return ''; },
    getProgramInfoLog() { return ''; },
    getParameter() { return 8; },
    getExtension() { return null; },
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    createVertexArray: () => ({}), createQuery: () => ({}),
    /* 只记录向量 uniform 的 typed 数组身份（标量 uniform 传数字，无所谓） */
    uniform3fv(loc, v) { if (v && v.buffer) base._uniBufs.push(v); },
    uniform2fv(loc, v) { if (v && v.buffer) base._uniBufs.push(v); },
    uniform4fv(loc, v) { if (v && v.buffer) base._uniBufs.push(v); },
    uniformMatrix4fv() {}, uniformMatrix3fv() {},
    uniform1f() {}, uniform2f() {}, uniform3f() {}, uniform4f() {}, uniform1i() {},
  };
  /* 其余 GL 调用（enable、bind 系列、tex 系列、draw 系列、blit 系列…）一律 no-op：
     行为判据只关心位置查询与向量 uniform 的身份，别的走个过场。 */
  const gl = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      return t._noop;
    },
  });
  const canvas = { clientWidth: 320, clientHeight: 200, width: 0, height: 0, style: {},
    getContext: () => gl, addEventListener() {} };
  const r = new SH.Renderer(canvas);
  const cam = { eye: [1, 2, 3], target: [12, 2, 3], fov: 60, near: 0.1, far: 100, up: [0, 1, 0] };
  const env = {
    sunDir: [0, 1, 0], sunCol: [1, 1, 1], skyCol: [0.5, 0.6, 0.7], skyHorizon: [0.9, 0.5, 0.3],
    skyZenith: [0.1, 0.2, 0.4], gndCol: [0.2, 0.2, 0.2], fogCol: [0.4, 0.4, 0.5], fog2: [0.2, 0.2, 0.3],
    haze: [0.1, 0.05, 0.02], night: 0.3, fogDensity: 0.002, fogHeightFalloff: 0.03,
    emiBoost: 1.2, wet: 0, post: {},
  };
  const batch = { mat: 'concrete', tint: 0, vao: {}, pb: {}, nb: {}, ub: {}, cb: {}, ib: {}, count: 3, type: 0x1403, bbox: null };
  const frame = () => { r.begin(cam, env, 1 / 60); r.draw(batch); r.end({}); };
  frame();                                    // 预热帧（FBO/MSAA 惰性建在这一帧）
  gl._locCalls = 0; gl._uniBufs.length = 0;
  frame();                                    // 帧 A：收集身份基线
  const seen = new Set(gl._uniBufs);
  gl._locCalls = 0; gl._uniBufs.length = 0;
  frame();                                    // 帧 B：与 A 逐身份比对
  ok(gl._locCalls === 0, '⓪ 帧内仍有 ' + gl._locCalls + ' 次 getUniformLocation —— 位置表退回每帧按名查询（构造期取齐被绕过）');
  const fresh = gl._uniBufs.filter(x => !seen.has(x));
  ok(fresh.length === 0, '① 帧内 uniform 上传出现 ' + fresh.length + ' 个新分配的缓冲 —— scratch 复用被绕过（应为零；矩阵 vp/M 的每帧 3 个数组是知情豁免项）');

  /* ---------- ⑦ PERF 关闭零成本 ---------- */
  SH.FRAME_PERF.on = false;
  SH.FRAME_PERF.acc = null;
  for (let i = 0; i < 1000; i++) { SH.FRAME_PERF.mark('x'); SH.FRAME_PERF.frameStart(); SH.FRAME_PERF.close(); }
  ok(SH.FRAME_PERF.acc === null && SH.FRAME_PERF.n === 0, '⑦ PERF 关闭时 mark/frameStart 不该累积（开关失效=常驻开销回来了）');
}

/* ---------- ② renderer.js 提交路径静态判据 ---------- */
{
  const bodies = {
    begin: methodBody(rSrc, 'begin(cam, env, dt)'),
    _drawSky: methodBody(rSrc, '_drawSky(cam, env)'),
    end: methodBody(rSrc, 'end(post)'),
    draw: methodBody(rSrc, 'draw(b, M, ov)'),
    _drawBatch: methodBody(rSrc, '_drawBatch(b, ov, nInst)'),
    drawInstanced: methodBody(rSrc, 'drawInstanced(b, mats, ov, tints)'),
  };
  for (const k of Object.keys(bodies)) ok(!!bodies[k], '② 方法体提取失败: ' + k + '（签名变了？判据要一起改）');
  if (bodies.begin) ok(!bodies.begin.includes('new Float32Array'), '② begin 的方法体里出现 new Float32Array（每帧 ~10 个短命数组回来了）');
  if (bodies._drawSky) {
    ok(!bodies._drawSky.includes('new Float32Array'), '② _drawSky 的方法体里出现 new Float32Array（每帧 ~14 个短命数组回来了）');
    ok(!bodies._drawSky.includes('getUniformLocation'), '② _drawSky 的方法体里有 getUniformLocation（应走构造期位置表 this.uSky）');
  }
  if (bodies.end) ok(!bodies.end.includes('getUniformLocation'), '② end 的方法体里有 getUniformLocation（应走 this.uBright/uBlur/uComp）');
  if (bodies.draw) ok(!bodies.draw.includes('ov = ov || {}'), '② draw 的 ov = ov || {} 又回来了（每帧几百个短命对象）');
  if (bodies._drawBatch) ok(!bodies._drawBatch.includes('ov = ov || {}'), '② _drawBatch 的 ov = ov || {} 又回来了');
  if (bodies.drawInstanced) {
    ok(bodies.drawInstanced.includes('_instData'), '② drawInstanced 未复用 _instData（每组实例一次 KB 级分配回来了）');
    ok(!bodies.drawInstanced.includes('new Float32Array(n * STR)'), '② drawInstanced 又在每调用 new Float32Array(n*STR)');
  }
  ok(rSrc.includes('const EMPTY'), '② renderer.js 缺 const EMPTY（共享只读兜底）');
  ok(rSrc.includes('const _set3'), '② renderer.js 缺 _set3 scratch 通道');
  ok(rSrc.includes('progLocs'), '② renderer.js 缺 progLocs 位置表工具');
}

/* ---------- ③ game.js 帧循环静态判据 ---------- */
{
  const envFor = methodBody(gSrc, 'envFor(s)');
  const frame = methodBody(gSrc, 'frame(t)');
  ok(!!envFor, '③ envFor 方法体提取失败');
  ok(!!frame, '③ frame 方法体提取失败');
  if (envFor) {
    /* 剥掉注释再查 token —— envFor 的说明性注释里就写着"每帧 5 个 .map()"，
       不排除注释会自己把自己判红（与 shader 模板串里的反引号同族坑）。 */
    const envCode = envFor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok(envCode.includes('this._envT.k !== kb'), '③ envFor 的 envAt 分桶缓存（_envT.k !== kb）不见了 —— envAt 又变成每帧调用');
    ok(!envCode.includes('.map('), '③ envFor 体内还有 .map( —— 每帧 5+ 个新数组回来了');
    ok(!envCode.includes('Object.assign('), '③ envFor 体内还有 Object.assign( —— 每帧一个新对象回来了');
  }
  if (frame) {
    const marks = (frame.match(/PERF\.mark\(/g) || []).length;
    ok(marks >= 6, '③ frame 循环的 PERF.mark 打点只有 ' + marks + ' 处（应 ≥6：子系统归因失效）');
    ok(frame.includes('PERF.frameStart()') && frame.includes('PERF.close()'), '③ frame 循环缺 PERF.frameStart/close 成对打点');
    ok(!frame.includes('const IDENT = mat4()'), '③ frame 里又出现 const IDENT = mat4()（应走模块级 IDENT_M）');
  }
  ok(gSrc.includes('const IDENT_M'), '③ game.js 缺模块级 IDENT_M');
  ok(gSrc.includes('perf=1') && gSrc.includes('PERF.window()'), '③ ?perf=1 开关或 PERF 窗口重置不见了');
  ok(gSrc.includes('PERF.top(3)'), '③ HUD 的 PERF.top(3) 归因行不见了');
}

if (bad) { console.log('✗ test-perf ' + bad + ' 条红线'); process.exit(1); }
console.log('✓ test-perf 帧循环零分配全绿（⓪零查询 · ①零新缓冲 · ②提交路径 · ③envFor/PERF · ⑦关闭零成本）');
