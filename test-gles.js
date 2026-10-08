/* ============================================================================
 * test-gles.js — ESSL 3.00 / WebGL2-only / MSAA / 后端能力面的判据（第 20 个自测）
 *
 * 为什么单独一个文件：A 轨 Phase A 是"像素不变的架构迁移"，但离线套件
 * **不跑真 GL** —— 迁移有没有真的发生（版本头、旧语法残留、GL1 回退分支、
 * MSAA 调用、能力查询），只有对源码文本的静态断言能钉住。真机像素 parity
 * 由 dev/shot.js 的 MSAA=0 前后对拍兜底（一次性迁移闸门，不进常驻判据）。
 *
 * 判据分组（每组都能单独报红，负控见 dev/negctl.js）：
 *   ① 七个着色器逐个：`#version 300 es` 必须是**第一个字符**（GLSL 规定版本
 *      指令前不许有任何字符，包括空白 —— JS 模板串开头那个换行就够炸）；
 *   ② 剥掉注释后的着色器正文里不许有 ESSL 1.00 语法（texture2D / varying /
 *      attribute / gl_FragColor）—— 残留任何一个，ESSL 3.00 编译器当场报错，
 *      产品启动即 fatal（2026-10-07 反引号事故的同族症状）；
 *   ③ SCENE_FS 的法线贴图分支：dFdx/dFdy 的 GL_OES_standard_derivatives 守卫
 *      必须已摘（ES 3.00 里导数是核心能力；守卫是 ESSL 1.00 时代 Chrome 154
 *      编译不过的补丁，见 shader 内注释存档）；
 *   ④ renderer.js 里 WebGL1 的全部痕迹清零：experimental-webgl /
 *      OES_vertex_array_object / OES_element_index_uint / this.gl2 /
 *      this.vaoExt / createVertexArrayOES 一族；
 *   ⑤ MSAA 管线在场：renderbufferStorageMultisample + MAX_SAMPLES 钳制 +
 *      gl.blitFramebuffer resolve，且 resolve 在世界计时 endQuery **之前**
 *      （resolve 是场景像素的真实成本，不进 gpuMs 就等于从 DRS 账本上抹掉）；
 *      档位映射 high=4x / medium=2x / low=0 必须存在；
 *   ⑥ 能力查询：maxTexSize() 方法在场，game.js 两处 SignAtlas 调用点吃数字
 *      而不是 .gl（C 轨接口缺口 D1 —— WebGPU 后端没有 .gl）；
 *   ⑦ 运行时面：maxTexSize 在 prototype 上、bestSize 按数字夹取
 *      （8192→4096 / 2048→2048 / 缺省→2048）；
 *   ⑧ 冻结接口在场：A 轨动手术不许弄丢 C 轨（WebGPU交接书 §4）的契约面。
 *
 * 反向验证（必须报红，见 dev/negctl.js）：
 *   gles100    SCENE_FS 摘掉版本头                 → ①红
 *   gtex2d     SCENE_FS 的 texture( 写回 texture2D( → ②红
 *   gvaogl1    构造器接回 getContext('webgl',…) 回退 → ④红
 *   gmsaa      删掉 end() 里的 blitFramebuffer 调用  → ⑤红
 *   gbestsize  game.js 两处调用点退回 bestSize(this.r.gl) → ⑥红
 * 用法：node test-gles.js
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'renderer', 'textures']) require('./src/' + f + '.js');
const fs = require('fs');
const SH = global.SH;
/* 负控钩子：negctl 以 disk 落盘变异 + 本脚本重读源文件的方式工作，
   这三行 const 是它的锚点（照抄 test-drive.js 的 SRCLINE 模式，别改写法）。 */
const rSrc = fs.readFileSync('./src/renderer.js', 'utf8');
const gSrc = fs.readFileSync('./src/game.js', 'utf8');
const tSrc = fs.readFileSync('./src/textures.js', 'utf8');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { console.log('✗ ' + msg); bad++; } };

/* ---- ①②③ 着色器：版本头 + 旧语法 + 导数守卫 ---- */
const SHADERS = ['SCENE_VS', 'SCENE_FS', 'SKY_FS', 'FS_QUAD_VS', 'BRIGHT_FS', 'BLUR_FS', 'COMPOSITE_FS'];
/* 模板串里不许有反引号（renderer.js:212 的老规矩），所以非贪婪到收尾反引号是安全的 */
const stripGlsl = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const bodies = {};
for (const n of SHADERS) {
  const m = rSrc.match(new RegExp('const ' + n + ' = `([\\s\\S]*?)`;'));
  ok(!!m, '着色器源串找不到: ' + n + '（提取正则或常量名变了？）');
  if (!m) continue;
  const src = m[1];
  bodies[n] = stripGlsl(src);
  ok(src.startsWith('#version 300 es'), 'ES3.00 版本头缺失: ' + n + '（#version 300 es 必须是模板串的第一个字符，前面不许有换行）');
  for (const tok of ['texture2D', 'varying', 'attribute', 'gl_FragColor']) {
    ok(!new RegExp('\\b' + tok + '\\b').test(bodies[n]), 'ESSL 1.00 语法残留 ' + tok + ': 在 ' + n + '（ESSL 3.00 编译器会当场拒绝）');
  }
}
for (const n of ['SCENE_FS', 'SKY_FS', 'BRIGHT_FS', 'BLUR_FS', 'COMPOSITE_FS']) {
  ok(bodies[n] && /out vec4 oCol;/.test(bodies[n]), '片元输出缺失: ' + n + '（ES 3.00 必须声明 out，gl_FragColor 已废除）');
}
ok(bodies.SCENE_FS && !/GL_OES_standard_derivatives|#extension/.test(bodies.SCENE_FS),
  '导数守卫未摘: SCENE_FS 里还有 GL_OES_standard_derivatives / #extension（ES 3.00 导数是核心能力，守卫已过时）');
ok(bodies.SCENE_FS && /dFdx\(/.test(bodies.SCENE_FS), '导数分支丢了: SCENE_FS 的 dFdx（法线贴图 TBN 分支必须在场，哪怕 uNrm 暂时恒 0）');

/* ---- ④ WebGL1 痕迹清零 ---- */
for (const tok of ["experimental-webgl", "OES_vertex_array_object", "OES_element_index_uint",
  "createVertexArrayOES", "bindVertexArrayOES", "deleteVertexArrayOES",
  "this.gl2", "this.vaoExt", "this.extUint", "getContext('webgl',"]) {
  ok(!rSrc.includes(tok), 'WebGL1 痕迹残留: ' + tok + '（Phase A 已决策丢弃 WebGL1，回退分支必须整段不存在）');
}
ok(rSrc.includes("canvas.getContext('webgl2', opt)"), 'WebGL2 入口缺失: 构造器必须只走 getContext(\'webgl2\')');
ok(/this\.api = 'WebGL2'/.test(rSrc), 'api 口径错误: WebGL2-only 后 api 恒为 WebGL2');

/* ---- ⑤ MSAA ---- */
ok(rSrc.includes('renderbufferStorageMultisample'), 'MSAA 缺失: renderbufferStorageMultisample 不在场');
ok(rSrc.includes('gl.getParameter(gl.MAX_SAMPLES)'), 'MSAA 缺失: MAX_SAMPLES 钳制不在场（软件光栅器报低值时必须退化而不是画进 incomplete FBO）');
const iBlit = rSrc.indexOf('gl.blitFramebuffer(');
ok(iBlit >= 0, 'MSAA resolve 缺失: end() 里找不到 gl.blitFramebuffer（场景渲染进了 MSAA FBO 却没人把它搬回单采样纹理，后期链读到的是空纹理）');
const iEndQ = rSrc.indexOf('endQuery(this.qExt.TIME_ELAPSED_EXT)');
ok(iBlit >= 0 && iEndQ >= 0 && iBlit < iEndQ,
  'MSAA resolve 记账错位: blit 必须在世界计时的 endQuery 之前（否则 resolve 的 GPU 成本没进 gpuMs，DRS 第二把尺失明）');
ok(/this\.msaa = q === 'high' \? 4 : q === 'medium' \? 2 : 0;/.test(rSrc),
  'MSAA 档位映射缺失: high=4x / medium=2x / low=0');

/* ---- ⑥ 能力查询（C 轨缺口 D1） ---- */
ok(/maxTexSize\(\)\s*\{/.test(rSrc), '能力查询缺失: Renderer.maxTexSize() 方法不在场');
const callHits = (gSrc.match(/bestSize\(this\.r\.maxTexSize\(\)\)/g) || []).length;
ok(callHits === 2, 'bestSize 调用面: game.js 应有且仅有 2 处 maxTexSize()（实测 ' + callHits + ' 处）');
ok(!gSrc.includes('bestSize(this.r.gl)'), 'bestSize 调用面: game.js 仍把 .gl 递出去（C 轨缺口 D1 复发 —— WebGPU 后端没有 .gl，图集容量会掉一半）');
ok(!tSrc.includes('getParameter'), 'bestSize 实现面: textures.js 不该再碰 getParameter（bestSize 吃数字，不是 GL 上下文）');

/* ---- ⑦ 运行时面 ---- */
ok(typeof SH.Renderer.prototype.maxTexSize === 'function', '运行时: maxTexSize 不在 Renderer.prototype 上');
ok(SH.textures.SignAtlas.bestSize(8192) === 4096, '运行时: bestSize(8192) 应夹到 4096');
ok(SH.textures.SignAtlas.bestSize(2048) === 2048, '运行时: bestSize(2048) 应原样 2048');
ok(SH.textures.SignAtlas.bestSize() === 2048, '运行时: bestSize() 缺省应回落 2048');

/* ---- ⑧ 冻结接口在场（WebGPU交接书 §4 的契约面） ---- */
for (const m of ['upload(', 'dropTag(', 'draw(', 'drawInstanced(', 'begin(', 'end(',
  'texFromImage(', 'texFromCanvas(', 'fade(', 'setQuality(', 'setRes(', 'setResAuto(',
  'setResEff(', 'resize(', 'boxInFrustum(', 'maxTexSize(']) {
  ok(rSrc.includes(m), '冻结接口缺失: ' + m + '（C 轨 WebGPU 后端按这份契约对拍，A 轨动手术不许弄丢）');
}

if (bad) { console.log('✗ test-gles ' + bad + ' 条红线'); process.exit(1); }
console.log('✓ test-gles 着色器/后端全绿（ES 3.00 ×7 · GL1 清零 · MSAA · 能力查询 · 冻结接口）');
