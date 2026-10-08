/* ============================================================================
 * test-nrm.js — 法线贴图管线接线的判据（第 22 个自测，视觉方案 1.1 / Phase B）
 *
 * 背景（体检结论第 1 条，"粗糙感"最大单笔欠账）：SCENE_FS 有完整的屏幕导数
 * TBN 分支，textures.js 生成并上传了 12 张法线图（<名>N）—— 但 uniform
 * 定位表没有 uNrm/uTexN、_drawBatch 只绑 TEXTURE0。分支恒不执行，
 * **所有表面按绝对平面算光照，近看全是"印了花纹的平板"**。
 * 这一套件钉住接线真的发生了，且按材质分派正确。
 *
 * 判据分组（负控见 dev/negctl.js：nrmloc / nrmbind / nrmzero / nrmgen）：
 *   ① 静态：uniform 定位表有 texN/nrm；SCENE_FS 的分支在场（dFdx + uTexN）；
 *      _drawBatch 有 TEXTURE1 绑定与切回 TEXTURE0；
 *   ② 行为（假 gl 逐批次记账）：NRM_STRENGTH 清单里的材质，批次真的在
 *      TEXTURE1 绑了 <名>N 且 uniform1f(uNrm) > 0；
 *   ③ 行为：清单外材质（paint/metal 以外的 mode 0、bldgWin 等）uNrm 恒 0、
 *      TEXTURE1 不脏绑（一次都不绑）；
 *   ④ 行为：材质表 nrm 覆写优先于清单值（granite 覆写 9.9 → 量到 9.9），
 *      nrm:0 单杀（concrete 覆写 0 → 量到 0，TEXTURE1 不绑）；
 *   ⑤ 行为：纹理缺失时静默退 0 不绑 null（离线判据不跑 buildAll 的工况）；
 *   ⑥ 静态：textures.js 的 NRM_STRENGTH 被 SH.textures 导出
 *      （生成与消费同一份表 —— renderer 读不到它就是第二份真值）。
 * 用法：node test-nrm.js
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures']) require('./src/' + f + '.js');
const fs = require('fs');
const SH = global.SH;
const rSrc = fs.readFileSync('./src/renderer.js', 'utf8');
const tSrc = fs.readFileSync('./src/textures.js', 'utf8');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { console.log('✗ ' + msg); bad++; } };

/* ---------- ① 静态判据 ---------- */
{
  ok(/texN: L\('uTexN'\), nrm: L\('uNrm'\)/.test(rSrc), '① uniform 定位表缺 texN/nrm（uNrm 还是拿不到 —— 法线分支零像素参与，接线被拆）');
  const mFS = rSrc.match(/const SCENE_FS = `([\s\S]*?)`;/);
  const fs2 = mFS ? mFS[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') : '';
  ok(/dFdx\(/.test(fs2), '① SCENE_FS 的 dFdx 导数分支丢了（TBN 构造没了）');
  ok(/texture\(uTexN/.test(fs2), '① SCENE_FS 不再采样 uTexN（法线图白传）');
  const iB = rSrc.indexOf('gl.bindTexture(gl.TEXTURE_2D, texN)');
  ok(iB >= 0, '① _drawBatch 缺 TEXTURE1 的法线图绑定');
  ok(rSrc.includes('gl.activeTexture(gl.TEXTURE0);'), '① 绑完法线图必须切回 TEXTURE0（漫反射贴图的绑定永远在 0 号单元，漏切会把下一张 albedo 绑进 1 号）');
  ok(/uniform1i\(this\.u\.texN, 1\)/.test(rSrc), '① begin 缺 uTexN 的采样器指向（TEXTURE1 的 sampler uniform 没被写过）');
  ok(/nrm:\s+法线贴图强度覆写/.test(rSrc), '① MATERIALS 表头缺 nrm 字段说明（覆写口径没有登记在案）');
  ok(rSrc.includes('this._curTexN'), '① _drawBatch 缺法线贴图的脏追踪（_curTexN —— 每批次重复 bindTexture 就是把省下的成本又交回去）');
}

/* ---------- ②③④⑤ 行为判据：假 gl 记账 ---------- */
{
  let locId = 1;
  const gl = {
    _tex1: [], _nrm: [], _unit: 0, _locCalls: 0, _locMap: {},
    TEXTURE0: 33984, TEXTURE1: 33985, TEXTURE_2D: 3553,
    MAX_SAMPLES: 8, MAX_TEXTURE_SIZE: 4096,
    getUniformLocation(p, n) { gl._locCalls++; const k = n; if (!(k in gl._locMap)) gl._locMap[k] = locId++; return gl._locMap[k]; },
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
    /* 记账面：TEXTURE 单元上的绑定 + uNrm 的标量写（nrm 的 location id 在构造后可查）。
       单元号按 GL 常量的**数值**记账（TEXTURE1=33985）：假 gl 没有枚举表，
       renderer 传的是 gl.TEXTURE1 的值 —— 判据与产品的单元口径一致。 */
    activeTexture(u) { gl._unit = u === undefined ? 0 : u; },
    bindTexture(t, o) { if (gl._unit === 33985) gl._tex1.push(o); },
    uniform1f(loc, v) { if (loc === gl._locMap.uNrm) gl._nrm.push(v); },
    uniform3fv() {}, uniform2fv() {}, uniform4fv() {}, uniformMatrix4fv() {}, uniformMatrix3fv() {},
    uniform1i() {}, uniform2f() {}, uniform3f() {}, uniform4f() {},
  };
  const noop = new Proxy(gl, { get(t, k) { if (typeof k === 'symbol') return undefined; if (k in t) return t[k]; return () => {}; } });
  const canvas = { clientWidth: 320, clientHeight: 200, width: 0, height: 0, style: {}, getContext: () => noop, addEventListener() {} };
  const r = new SH.Renderer(canvas);

  /* 材质面：把 NRM_STRENGTH 全家 + 清单外代表都过一遍。
     纹理注册表预填：albedo 与 <名>N 都给一个可识别的对象（模拟 buildAll 跑过）。 */
  const NS = SH.textures.NRM_STRENGTH;
  ok(!!NS && typeof NS.granite === 'number', '⑥ SH.textures.NRM_STRENGTH 未导出 —— renderer 读不到清单（生成与消费两份真值）');
  ok(!/const NRM_STRENGTH\s*=/.test(rSrc.replace(/\/\*[\s\S]*?\*\//g, '')), '⑥ renderer.js 里出现第二份 NRM_STRENGTH —— 清单只许 textures.js 一处');
  let _k = 0;
  for (const k of Object.keys(NS)) { _k++; r.textures[k] = { _k }; r.textures[k + 'N'] = { _k: k + 'N' }; }
  for (const k of ['bldgWin', 'bldgWin2', 'bldgWin3', 'sign', 'water', 'window', 'aerial']) { _k++; r.textures[k] = { _k }; }
  r.textures.white = { _k: 'white' };

  const cam = { eye: [1, 2, 3], target: [12, 2, 3], fov: 60, near: 0.1, far: 100, up: [0, 1, 0] };
  const env = { sunDir: [0, 1, 0], sunCol: [1, 1, 1], skyCol: [.5, .6, .7], skyHorizon: [.9, .5, .3], skyZenith: [.1, .2, .4],
    gndCol: [.2, .2, .2], fogCol: [.4, .4, .5], fog2: [.2, .2, .3], night: 0.3, fogDensity: 0.002,
    fogHeightFalloff: 0.03, emiBoost: 1.2, wet: 0, post: {} };
  const mkBatch = mat => ({ mat, tint: 0, vao: {}, pb: {}, nb: {}, ub: {}, cb: {}, ib: {}, count: 3, type: 0x1403, bbox: null });

  const runFrame = mats => {
    gl._tex1.length = 0; gl._nrm.length = 0; gl._unit = 0;
    r._curTexN = null; r._curNrm = -1;   // 复位脏追踪：让每一帧从冷态开始记
    r.begin(cam, env, 1 / 60);
    for (const m of mats) r.draw(mkBatch(m));
    /* 记账只收世界 pass —— end() 后半段的 composite 会合法地把 bloom 纹理
       绑上 TEXTURE1（uBloom 采样器），那不是"脏绑"；收账后再放行 end()。 */
    const tex1 = gl._tex1.slice(), nrm = gl._nrm.slice();
    r.end({});
    gl._tex1.length = 0; gl._tex1.push(...tex1);
    gl._nrm.length = 0; gl._nrm.push(...nrm);
  };

  /* ② 清单材质：uNrm > 0 且 TEXTURE1 绑到了 <名>N */
  const probe2 = ['granite', 'tiles', 'concrete', 'segment', 'ballast', 'asphalt', 'brick', 'metal', 'rail', 'concreteD'];
  runFrame(probe2);
  ok(gl._nrm.filter(v => v > 0).length >= 8, '② 清单材质一个都没点亮 uNrm（' + gl._nrm.join(',') + '）—— TEXTURE1 接线没生效');
  const boundNames = gl._tex1.map(o => o._k);
  ok(boundNames.some(n => /N$/.test(n)), '② TEXTURE1 一次都没绑到 <名>N（法线图生成上传了却没人消费）');
  /* nrmgen 的落点：判据预填的注册表必须与 NRM_STRENGTH 逐键同步 —— buildAll
     的生成行被拆掉时，真实注册表不再有这些键，而判据的"模拟 buildAll"若不同步
     就永远测不到生成端。把生成端口径也钉一份（读 textures.js 的生成行源码）。 */
  const genLine = "if (NRM_STRENGTH[n]) renderer.texFromCanvas(n + 'N', normalFromCanvas(c, NRM_STRENGTH[n]), true);";
  ok(tSrc.includes(genLine), '② buildAll 的 <名>N 生成行不见了 —— 法线图不再被生成/上传（消费端再对也是空转）');
  for (const m of ['granite', 'tiles', 'concrete', 'ballast']) {
    ok(r.textures[m + 'N'] != null, '② 纹理注册表缺 ' + m + 'N（buildAll 的生成清单与判据不同步）');
  }

  /* ③ 清单外材质：恒 0，且 TEXTURE1 一次都不绑（脏追踪不许被其它批次触发） */
  runFrame(['paint', 'glass', 'bldgWin', 'sign', 'water', 'carShell']);
  ok(gl._nrm.every(v => v === 0), '③ 清单外材质把 uNrm 写成了 ' + JSON.stringify(gl._nrm) + '（>0 的项会让无图材质采到别人的法线图）');
  ok(gl._tex1.length === 0, '③ 清单外批次脏绑了 TEXTURE1 ' + gl._tex1.length + ' 次（uNrm=0 时根本不需要切单元）');

  /* ④ 覆写优先：granite→9.9 量到 9.9；concrete→0 量到 0 且不绑 TEXTURE1 */
  const g0 = SH.MATERIALS.granite.nrm, c0 = SH.MATERIALS.concrete.nrm;
  SH.MATERIALS.granite.nrm = 9.9; SH.MATERIALS.concrete.nrm = 0;
  runFrame(['granite', 'concrete']);
  SH.MATERIALS.granite.nrm = g0; SH.MATERIALS.concrete.nrm = c0;
  ok(gl._nrm.includes(9.9), '④ 材质表 nrm 覆写没生效（granite→9.9 量到 ' + JSON.stringify(gl._nrm) + '）—— 缺省值与覆写抢位');
  ok(!gl._tex1.some(o => o._k === 'concreteN'), '④ nrm:0 单杀失败 —— concrete 的法线图仍被绑上（覆写为 0 必须同时不绑）');

  /* ⑤ 纹理缺失静默退 0：清掉全部 <名>N 再画清单材质。
     这一条同时是 nrmgen 负控的落点 —— buildAll 不再生成 <名>N 时，
     浏览器里的真实工况就是"消费端在场、注册表是空的"，必须静默退 0 而不是
     按 nrmK>0 的口径让采样器读一个不存在的绑定。nrmgen 变异下 ② 的断言
     **不会**红（判据自己预填了注册表模拟 buildAll），⑤ 的"缺图退 0"就是
     对"生成端被人拆掉"这一缺陷的正面判据：删掉生成行后 ⑤ 仍绿是**对的**
     （renderer 端缺图退 0 正确），所以 nrmgen 的红字钉在 ② 的注册表同步
     断言上（判据预填清单与 NRM_STRENGTH 必须逐键同步）。 */
  const saved = {};
  for (const k of Object.keys(NS)) { saved[k + 'N'] = r.textures[k + 'N']; delete r.textures[k + 'N']; }
  runFrame(['granite', 'tiles', 'ballast']);
  for (const k of Object.keys(saved)) r.textures[k] = saved[k];
  ok(gl._nrm.every(v => v === 0), '⑤ 纹理缺失时 uNrm 没退 0（' + JSON.stringify(gl._nrm) + '）—— 缺图批次会按平面法线之外的口径采样');
  ok(gl._tex1.every(o => o != null), '⑤ 纹理缺失时 bindTexture 收到 null（GL_INVALID_OPERATION 一族）');
}

if (bad) { console.log('✗ test-nrm ' + bad + ' 条红线'); process.exit(1); }
console.log('✓ test-nrm 法线贴图接线全绿（①定位表/着色器/绑定 ②清单材质点亮 ③清单外恒零不脏绑 ④覆写优先 ⑤缺图静默退 0 ⑥清单单点导出）');
