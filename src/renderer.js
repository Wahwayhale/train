/* ============================================================================
 * renderer.js — WebGL 渲染器
 *
 * 相对南京版的画质差距主要来自三处，都在这里：
 *   1. 真正的半球环境光 + 方向光 + Blinn 高光（南京版只有两个固定方向光）
 *   2. 高度雾（贴地雾），让城市与隧道有空气感
 *   3. 离屏合成 + 高光溢出(bloom) + 胶片色调映射 + 暗角 + 颗粒
 *      —— 这一步是"看起来贵"的主要原因，成本只有三次全屏 pass
 * ==========================================================================*/
(function (global) {
'use strict';
const SH = global.SH;
const { clamp, m4perspective, m4lookAt, m4mul, mat4, m3normalFromM4 } = SH;
const IDENT = mat4();
const IDENT_NORMAL = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
let _nm = new Float32Array(9);

/* 全局错误可见化：WebGL 失败时把原因显示在屏幕上，而不是白屏 */
function fatal(title, detail) {
  const d = document.getElementById('fatal') || (function () {
    const e = document.createElement('div'); e.id = 'fatal';
    e.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0a0f14;color:#e8f2f7;padding:32px;font:14px/1.7 system-ui;overflow:auto';
    document.body && document.body.appendChild(e); return e;
  })();
  d.innerHTML = '<h2 style="font-size:18px;margin:0 0 12px">' + title + '</h2><pre style="white-space:pre-wrap;color:#9fd0e4;font-size:12px">' + detail + '</pre>';
  d.style.display = 'block';
}
SH.fatal = fatal;

function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    fatal('着色器编译失败 · ' + name, log + '\n\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    throw new Error(name + ': ' + log);
  }
  return s;
}
function program(gl, vs, fs, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + '/vert'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + '/frag'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { fatal('着色器链接失败 · ' + name, gl.getProgramInfoLog(p)); throw new Error(gl.getProgramInfoLog(p)); }
  return p;
}

/* ------------------------------------------------------------------ 着色器 */
const SCENE_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aUv;
attribute vec4 aCol;      // rgb + 自发光(归一化)
/* 实例基（aI0/aI1/aI2 = 基向量的三列，aI3 = 平移），uInst>0.5 时启用。
   普通批次不启用 aI 数组（通用 attrib 值），分支直接跳过 —— 一份 shader
   同时服务"逐实例矩阵"与"实例化"两条通道。
   组合方式是**列向量的线性组合**（p = right*x + up*y + fwd*z + pos），不是点乘：
   写成 dot(aI0.xyz, aPos) 等于把旋转取逆（Rᵀ·p），直线正对镜头时看不出来，
   一到弯道上车就歪着走。判据：node dev/inst-check.js（与逐实例回退做像素 A/B）。 */
attribute vec4 aI0, aI1, aI2, aI3;
/* 实例色（第 135 条）：rgb = 乘进顶点色的系数，a = 这一批吃不吃色。
   a 由**批次材质**决定（材质表里的 tint）—— 一辆车里"该跟着涂装变的"只有车漆，
   玻璃、灯、轮胎、深色饰条都不许被染。不实例化时走 uTint（WebGL1 回退逐次 draw）。
   两边的 a 默认都是 0：通用属性默认值 (0,0,0,1) 会把车染黑，所以判据是
   "a > 0.5 才乘"，而不是"有值就乘"。 */
attribute vec4 aIT;
uniform mat4 uM, uVP;
uniform mat3 uN;
uniform float uInst;
uniform vec4 uTint;
varying vec3 vW, vN;
varying vec2 vUv;
varying vec4 vC;
void main(){
  vec3 p = aPos, n = aNrm;
  if (uInst > 0.5) {
    p = aI0.xyz * aPos.x + aI1.xyz * aPos.y + aI2.xyz * aPos.z + aI3.xyz;
    n = aI0.xyz * aNrm.x + aI1.xyz * aNrm.y + aI2.xyz * aNrm.z;
  }
  vec4 w = uM * vec4(p, 1.0);
  vW = w.xyz;
  vN = normalize(uN * n);
  vUv = aUv;
  vC = aCol;
  if (uInst > 0.5) { if (aIT.a > 0.5) vC = vec4(aCol.rgb * aIT.rgb, aCol.a); }
  else if (uTint.a > 0.5) vC = vec4(aCol.rgb * uTint.rgb, aCol.a);
  gl_Position = uVP * w;
}`;

const SCENE_FS = `
precision highp float;
varying vec3 vW, vN;
varying vec2 vUv;
varying vec4 vC;
uniform sampler2D uTex;
/* 法线贴图（第二张贴图单元）。`uNrm` = 起伏强度，0 = 这个材质没有法线图。
   为什么值得单独开一路：这个场景"读起来平"的最大来源不是三角形不够，
   而是每个面都按**完全平整的平面**算光照 —— 一块 1024² 的花岗岩贴图再细，
   高光与半球环境光仍然均匀铺在整块板上，近看就是"印了花纹的板子"。
   法线图不动几何、不加三角形，只让法向随贴图起伏，是这一档最省的解法。 */
uniform sampler2D uTexN;
uniform float uNrm;
uniform vec3 uEye, uSunDir, uSunCol, uSkyCol, uGndCol, uFogCol, uSkyHor;
uniform vec2 uFog;        // x 密度, y 高度衰减
uniform vec2 uFade;       // 细节贴图退化的起止距离（米）：近于 x 全细节，远于 y 只剩 12%
uniform vec3 uFog2;       // 第二层雾色（天空/地面）
uniform vec4 uMat;        // x 贴图模式 0无 1乘细节 2替换, y 高光强度, z 高光锐度, w 透明
uniform float uTime, uEmiBoost, uWave, uCut, uWet;
uniform vec2 uUvScale;

/* value noise：水面噪声梯度（D2）用。与 SKY_FS 里那对是同一组常数。 */
float h21s(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vno(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21s(i),h21s(i+vec2(1,0)),f.x), mix(h21s(i+vec2(0,1)),h21s(i+vec2(1,1)),f.x), f.y);
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vW);
  /* 双面着色：把法向扳到朝向观察者的一侧。
     烘焙出来的几何里有相当一部分表面是"从法向的反面被看到的"——隧道衬砌最典型：
     它的绕序必须朝隧道内侧才看得见（否则整个被背面剔除），而截面给的 nx/ny 是
     朝岩体那一侧。以前这些面的半球环境光、日照、高光、菲涅尔全部按背光面算，
     明暗是拧着的。绕序不能改（一改这些面就直接消失），所以在着色阶段对齐。
     test-wind.js 把这个比例按材质量出来并做了棘轮，防止继续恶化。 */
  if (dot(N, V) < 0.0) N = -N;
  vec3 base = vC.rgb * 2.0;   // 顶点色存的是 0..2 折半，见 mesh.js vtx 的注释

  // ---- 水面波动：扰动法向，不是扰动 UV
  // 只把 UV 抖一下的话，高光与菲涅尔仍然按"完全平整的镜面"算，
  // 于是整片江面变成一块死板的灰板，从高架上看下去像农田。
  // 真正让水面读起来是水的，是法向抖动把日光的镜面高光打碎成粼粼波光。
  float dist = length(vW - uEye);
  if (uWave > 0.0) {
    /* 九列**方向波**（每列有自己的传播方向、波数、速度），梯度相加得到法向。
       原来是 sin(x·a)+sin(y·b) 这种轴对齐正弦的叠加：两个方向互相干涉，
       在屏幕上织出规则的菱形网格，跨江截图里江面像一整片塑料蛋托。
       方向散布到整个圆周、波长互不成简单整数比之后，干涉不再周期性对齐。

       衰减按 **1/(1+d·k²·0.006)**，不是统一系数。上一版用 1/(1+d·k·0.004)，
       最高波数只有 0.785（λ=8 m），在 50 m 处几乎不衰减 —— 于是近处江面全是
       十几米一个的软包，实测截图下半屏像一片湿沙地，而不是一条江。
       k² 让短波收得极快（λ=1.5 m 的波在 30 m 外就只剩 24%），长涌几乎不衰减
       （λ=130 m 在 800 m 外仍保留大半），近细远粗这个层次才是"水"。 */
    vec2 p = vW.xz;
    vec2 sl = vec2(0.0);
    float kk, ph, at;
    kk = 0.484; ph = dot(p, vec2( 0.707,  0.707)) * kk + uTime * 1.15;
    at = 0.055 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.707,  0.707) * at * cos(ph);
    kk = 0.299; ph = dot(p, vec2(-0.500,  0.866)) * kk - uTime * 0.83;
    at = 0.045 / (1.0 + dist * kk * kk * 0.006); sl += vec2(-0.500,  0.866) * at * cos(ph);
    kk = 0.785; ph = dot(p, vec2( 0.940, -0.342)) * kk + uTime * 1.70;
    at = 0.030 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.940, -0.342) * at * cos(ph);
    kk = 0.170; ph = dot(p, vec2( 0.259,  0.966)) * kk + uTime * 0.60;
    at = 0.060 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.259,  0.966) * at * cos(ph);
    kk = 0.698; ph = dot(p, vec2(-0.866, -0.500)) * kk - uTime * 1.40;
    at = 0.026 / (1.0 + dist * kk * kk * 0.006); sl += vec2(-0.866, -0.500) * at * cos(ph);
    kk = 0.048; ph = dot(p, vec2( 0.643,  0.766)) * kk + uTime * 0.35;
    at = 0.085 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.643,  0.766) * at * cos(ph);
    /* 近场细波：只在 1~3 m 波长上工作，管住 80 m 以内的画面 */
    kk = 1.700; ph = dot(p, vec2(-0.342, -0.940)) * kk + uTime * 2.30;
    at = 0.030 / (1.0 + dist * kk * kk * 0.006); sl += vec2(-0.342, -0.940) * at * cos(ph);
    kk = 2.600; ph = dot(p, vec2( 0.866, -0.500)) * kk - uTime * 3.10;
    at = 0.022 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.866, -0.500) * at * cos(ph);
    kk = 4.200; ph = dot(p, vec2( 0.500,  0.866)) * kk + uTime * 4.20;
    at = 0.016 / (1.0 + dist * kk * kk * 0.006); sl += vec2( 0.500,  0.866) * at * cos(ph);
    /* 噪声梯度（诚实清单 D2）：方向波再散布也是**正弦的**，30~300 m 的过渡带
       仍读得出一丝"绸缎"感。两层 value-noise 的中心差分给出不规则的碎波梯度，
       幅度随距离收窄——近处只是把波峰打毛，远处叠出成片的碎光。
       黄浦江是浑水，"绝对平整"与"规则波纹"之间的这一层随机才是它的质感。 */
    float hE = 0.35;
    vec2 np1 = p * 0.10 + vec2(uTime * 0.31, -uTime * 0.17);
    float n10 = vno(np1);
    sl += vec2(vno(np1 + vec2(hE, 0.0)) - n10, vno(np1 + vec2(0.0, hE)) - n10) / hE
      * (0.55 / (1.0 + dist * 0.012)) * 0.085;
    vec2 np2 = p * 0.36 + vec2(-uTime * 0.8, uTime * 0.5);
    float n20 = vno(np2);
    sl += vec2(vno(np2 + vec2(hE, 0.0)) - n20, vno(np2 + vec2(0.0, hE)) - n20) / hE
      * (0.30 / (1.0 + dist * 0.05)) * 0.05;
    N = normalize(N + vec3(-sl.x * uWave, 0.0, -sl.y * uWave));
  }

  // ---- 贴图 ----
  vec2 uv = vUv * uUvScale;
  /* ---- 法线贴图：用屏幕空间导数现场构 TBN（不需要顶点切空间）----
     这是"没有预计算切线"时的标准做法：从世界位置与 UV 的导数里解出
     切向与副切向，再投影掉法向分量。代价是每个像素多两张贴图采样 +
     几个导数，收益是**整片场景的浮雕感**。 */
  if (uNrm > 0.0) {
    vec3 tN = texture2D(uTexN, uv).xyz * 2.0 - 1.0;
    vec3 dp1 = dFdx(vW), dp2 = dFdy(vW);
    vec2 du1 = dFdx(uv), du2 = dFdy(uv);
    vec3 T = dp1 * du2.y - dp2 * du1.y;
    vec3 B = dp2 * du1.x - dp1 * du2.x;
    T = normalize(T - N * dot(N, T));
    B = normalize(B - N * dot(N, B) - T * dot(T, B));
    N = normalize(mat3(T, B, N) * vec3(tN.xy * uNrm, tN.z));
  }
  vec4 tx = vec4(1.0);
  if (uMat.x > 0.5) {
    vec2 wv = uv;
    if (uWave > 0.0) wv += vec2(sin(vW.z*0.6+uTime*1.3)*0.012, cos(vW.x*0.8+uTime*0.9)*0.008) * uWave;
    tx = texture2D(uTex, wv);
    /* ---- 模式 3：真乘（反照率 = 顶点色 x 贴图）----
       BVE/OpenBVE 列车模型的口径：贴图是灰度细节图，颜色来自每个子网格的
       SetColor，两者相乘才是最终反照率。模式 1 做不到这件事 —— 它是
       mix(1.0, tx, 0.85)，即"绕 1.0 的细节调制"，对平均亮度 0.7 的贴图
       会把整车压成中灰；模式 2（整张替换）则把 SetColor 整个丢掉，
       1 号线列车第一版就是这么变成"一片灰白"的。
       （注意：这段是 JS 模板串，注释里不许出现反引号。） */
    if (uMat.x > 2.5) { base *= tx.rgb; if (tx.a < 0.02) discard; }
    else if (uMat.x > 1.5) { base = tx.rgb; if (tx.a < 0.02) discard; }
    else {
      /* 远处把细节贴图向平均色收回。512 的窗格图到了几百米外，即使有三线性
         过滤也只剩一片高频噪点，楼体看起来像蒙了电视雪花；离得越远越应该
         退化成"一个有明暗的盒子 + 窗的自发光"，画面立刻干净。
         **但退化距离必须按材质给**：航拍地面的街区是 50 m 尺度的结构，
         按楼窗那套 90 m 起衰减，几百米外整片地面就变成一块纯色渐变——
         "城市浮在沙漠上"就是这么来的。uFade = [起, 止]，由材质表给。 */
      float keep = clamp(1.0 - (dist - uFade.x) / max(1.0, uFade.y - uFade.x), 0.12, 1.0);
      base *= mix(vec3(1.0), tx.rgb, 0.85 * keep);
    }
  }
  if (uCut > 0.0 && fract(vUv.x * 0.5 + vUv.y * 0.5) < uCut) discard;

  // ---- 半球环境光：上天下地，法向决定比例 ----
  float hemi = N.y * 0.5 + 0.5;
  vec3 amb = mix(uGndCol, uSkyCol, hemi);
  /* 再加一圈**地平线暖光**。原来只有"上蓝下灰"两档，垂直立面拿到的是
     mix(天顶蓝, 地面灰) = 一团冷紫灰，于是黄昏的外滩石墙、港区桥吊、
     陆家嘴楼群全部像蒙了雾玻璃（实测截图整屏饱和度只剩一成）。
     真实黄昏里立面是被整圈橙色地平线照亮的，这才是"蓝调时刻"的含义。
     band 只作用在接近垂直的法向上，朝上/朝下的面保持原来的两档。 */
  float band = pow(clamp(1.0 - abs(N.y), 0.0, 1.0), 1.4);
  amb = mix(amb, uSkyHor, band * 0.62);

  // ---- 太阳 ----
  float ndl = max(dot(N, uSunDir), 0.0);
  // 让背光面不至于死黑：加一条柔和的补光
  float wrap = max(0.0, (dot(N, uSunDir) + 0.35) / 1.35);
  /* 雨天（uWet）：湿表面反照率被水膜压暗——干沥青/干砖吸光，湿了之后一部分
     光走镜面反射走了，漫反射分量随之减少。uWet=0 时这一行是恒等变换，
     不动任何既有标定。 */
  base *= 1.0 - 0.30 * uWet;
  vec3 lit = base * (amb + uSunCol * (ndl * 0.85 + wrap * 0.28));

  // ---- 高光 ----
  vec3 H = normalize(uSunDir + V);
  /* 湿表面：高光更亮（有效 spec 上抬）也更锐（shin 上抬）。
     与上一行一样，uWet=0 时退回原值。 */
  float wetSpec = uMat.y * (1.0 + 2.4 * uWet);
  float wetShin = max(4.0, uMat.z * (1.0 + 1.6 * uWet));
  float spec = pow(max(dot(N, H), 0.0), wetShin) * wetSpec * (0.35 + 0.65 * ndl);
  lit += uSunCol * spec;

  // ---- 玻璃/金属/水面边缘反射：掠射角反射天空与地平线暖色
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  /* 反射的是**地平线**而不是天顶：黄昏的江面本质上是一面镜子，
     镜子里占绝大部分角度的正是那条橙色地平线（水面在掠射角上占满画面，
     原来混的是偏蓝的 uSkyCol，于是江面读起来像一块灰紫塑料）。
     雨天湿地面在掠射角上多还一层灰天反射——柏油路面的"水光"就是这个。 */
  lit += mix(uSkyCol, uSkyHor, 0.5) * fres * (uMat.y * 0.70 + uWet * 0.85);

  // ---- 自发光（顶点烘焙的灯光）----
  lit += base * vC.a * uEmiBoost;

  // ---- 高度雾 ----
  float hf = exp(-max(0.0, vW.y + 2.0) * uFog.y);          // 越低雾越浓
  float f = 1.0 - exp(-pow(dist * uFog.x, 2.0) * (0.55 + 0.45 * hf));
  vec3 fogC = mix(uFogCol, uFog2, clamp(vW.y * 0.02 + 0.5, 0.0, 1.0));
  vec3 col = mix(lit, fogC, clamp(f, 0.0, 0.96));

  gl_FragColor = vec4(col, uMat.w * (uMat.x > 1.5 ? tx.a : 1.0));
}`;

/* 天空穹顶：由视线方向直接算，不需要几何体。
 * 有地平线渐变、日盘与日晕、低空云层、以及夜景的城市天光反射。 */
const SKY_FS = `
precision highp float;
varying vec2 vT;
uniform vec3 uRight, uUp, uFwd, uSunDir, uSunCol, uHorizon, uZenith, uGroundCol, uFogCol, uHaze;
uniform vec2 uTan;         // tan(fov/2)*aspect, tan(fov/2)
uniform float uNight, uTime;

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
}
void main(){
  vec2 ndc = vT*2.0-1.0;
  vec3 d = normalize(uFwd + uRight*ndc.x*uTan.x + uUp*ndc.y*uTan.y);
  float up = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(up, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, t);
  // 地平线以下：先接到雾色，再往下才是城市地面反光。
  // 原来一步混到 uGroundCol，于是"跟随相机的远景地面"在 3000 m 外的边缘
  // 会留一条硬线：平面那侧是雾色，天空这侧还是橙色地平线，两种颜色对撞，
  // 画面上就是"世界到这条线为止"。先经过雾色，边缘就化开了。
  col = mix(col, uFogCol, smoothstep(0.0, -0.055, up));
  col = mix(col, uGroundCol, smoothstep(-0.055, -0.30, up));
  // 日盘 + 日晕
  float sd = max(0.0, dot(d, uSunDir));
  col += uSunCol * pow(sd, 900.0) * 5.0;
  col += uSunCol * pow(sd, 7.0) * 0.30;
  col += uSunCol * pow(sd, 1.6) * 0.07;
  // 低空云层：只在靠近地平线的带里
  float band = smoothstep(0.30, 0.03, abs(up - 0.09));
  vec2 cp = d.xz / max(0.12, abs(d.y) + 0.28);
  float c = vnoise(cp*2.2 + vec2(uTime*0.006, 0.0))*0.6 + vnoise(cp*5.1)*0.4;
  c = smoothstep(0.42, 0.78, c) * band;
  col = mix(col, mix(uHorizon, vec3(1.0,0.86,0.74), 0.42) * (0.55 + 0.75*sd), c*0.55*(1.0-uNight*0.62));
  // 夜景城市天光：地平线一圈橙黄
  col += vec3(0.30,0.19,0.10) * uNight * pow(clamp(1.0-abs(up)*3.4,0.0,1.0), 2.6) * 0.55;
  col += uHaze * pow(clamp(1.0-abs(up)*2.2,0.0,1.0), 3.0);
  // 抖动去色带
  col += (h21(vT*1024.0 + uTime) - 0.5) * 0.006;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

/* 后处理：亮度提取 + 模糊 + 合成 */
const FS_QUAD_VS = `attribute vec2 aP; varying vec2 vT; void main(){ vT = aP*0.5+0.5; gl_Position=vec4(aP,0.0,1.0); }`;

const BRIGHT_FS = `
precision mediump float; varying vec2 vT; uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh;
void main(){
  vec3 s = texture2D(uSrc, vT).rgb;
  // 4  taps 降采样
  s += texture2D(uSrc, vT + uTexel*vec2( 1.0, 1.0)).rgb;
  s += texture2D(uSrc, vT + uTexel*vec2(-1.0, 1.0)).rgb;
  s += texture2D(uSrc, vT + uTexel*vec2( 1.0,-1.0)).rgb;
  s *= 0.25;
  float l = dot(s, vec3(0.2126,0.7152,0.0722));
  gl_FragColor = vec4(s * smoothstep(uThresh, uThresh + 0.55, l), 1.0);
}`;

const BLUR_FS = `
precision mediump float; varying vec2 vT; uniform sampler2D uSrc; uniform vec2 uDir;
void main(){
  vec2 t = uDir;
  vec3 c = texture2D(uSrc, vT).rgb * 0.2270270;
  c += (texture2D(uSrc, vT + t*1.3846153).rgb + texture2D(uSrc, vT - t*1.3846153).rgb) * 0.3162162;
  c += (texture2D(uSrc, vT + t*3.2307692).rgb + texture2D(uSrc, vT - t*3.2307692).rgb) * 0.0702702;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `
precision highp float;
varying vec2 vT;
uniform sampler2D uSrc, uBloom;
uniform vec2 uRes;
uniform float uTime, uBloomAmt, uExposure, uVig, uGrain, uAberr, uFade, uDesat;
uniform float uRain, uRainCab, uSharp;
uniform vec3 uTint;

vec3 aces(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
float rh21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
/* 一层雨丝：屏幕按 cell 划格，每格一条竖长的亮线，落速带风斜。
   t 直接用秒（外层已乘过 60 的 uTime 在这里除回去用 —— 落速必须是
   "米/秒"量级的直觉值，跟 uTime 的频率解耦）。 */
float rainLayer(vec2 uv, float t, float cells, float speed, float slant, float th){
  vec2 p = uv; p.x += p.y * slant;
  vec2 g = vec2(p.x * cells, p.y * cells * 0.11 + t * speed);
  vec2 id = floor(g), f = fract(g);
  float rnd = rh21(id);
  float on = step(th, rnd);
  float x = abs(f.x - (0.25 + 0.5 * rh21(id + 7.0)));
  float line = smoothstep(0.055, 0.0, x) * on;
  float flick = 0.45 + 0.55 * rh21(id + 13.0);
  return line * flick;
}
/* 驾驶室挡风玻璃上的水珠：格子中心一颗圆珠，亮度缓慢呼吸 + 一部分珠子
   在"下滑"（y 随时间掉一格）。雨停（uRainCab→0）即消失。 */
float droplets(vec2 uv, float t, float cells){
  vec2 g = uv * cells;
  vec2 id = floor(g), f = fract(g) - 0.5;
  float rnd = rh21(id);
  vec2 off = vec2(rh21(id + 3.0), rh21(id + 5.0)) - 0.5;
  float slide = step(0.72, rnd);
  off.y = fract(off.y - t * 0.06 * slide) - 0.5;
  float d = length((f - off * 0.62) * vec2(1.0, 1.0));
  float bead = smoothstep(0.12 + 0.08 * rnd, 0.015, d);
  return bead * (0.35 + 0.65 * rh21(id + 11.0));
}
void main(){
  vec2 uv = vT;
  vec2 d = uv - 0.5;
  float r2 = dot(d,d);
  // 色散：越靠边越明显，模拟广角镜头。量级必须很小（UV 的千分之几）
  vec2 off = d * uAberr * r2;
  vec3 col;
  col.r = texture2D(uSrc, uv + off).r;
  col.g = texture2D(uSrc, uv).g;
  col.b = texture2D(uSrc, uv - off).b;

  /* 非整数放大补偿（unsharp）。输出像素预算低于窗口物理像素时，浏览器要把画布
     拉大到屏幕，双线性放大吃掉的就是细线条 —— 远景细楼群、接触网、司机台屏的
     小字最先软掉。这里在**合成已经要读的那张纹理**上多取四个邻居，按通道各锐
     一次（不碰色相，避免镶边），代价是 4 次采样、只发生在已经便宜了的低预算档。
     原生档 uSharp=0，一个像素都不动 —— 那时糊不是这里的事。
     限幅是必要的：不夹的话高对比边缘（隧道灯带、站台白线）会振铃出一圈白边。 */
  if (uSharp > 0.001) {
    vec2 px = 1.0 / uRes;
    vec3 nb = (texture2D(uSrc, uv + vec2(px.x, 0.0)).rgb + texture2D(uSrc, uv - vec2(px.x, 0.0)).rgb
             + texture2D(uSrc, uv + vec2(0.0, px.y)).rgb + texture2D(uSrc, uv - vec2(0.0, px.y)).rgb) * 0.25;
    col += clamp((col - nb) * uSharp, -0.075, 0.075);
  }

  col += texture2D(uBloom, uv).rgb * uBloomAmt;
  col *= uExposure;
  /* ACES 是**线性光**的曲线，而场景着色器交出来的是已经按显示量级调好的值
     （SCENE_FS 末尾没有 linear→sRGB 那一步）。把显示参考值直接喂进 ACES，
     0.1~0.5 整段被抬 1.4~1.6 倍，再乘上原来那句 pow(0.925) 提亮中间调 ——
     实测同一块沥青路面：高清档平均亮度 101、暗部像素占比 3.9%，
     流畅档（不走后期链）68 / 75.6%。钢轨、道床、车道标线就是被这一抬
     "抬"成一片浅灰的：玩家看到的不是"更电影"，而是"切换画质之后铁轨和
     道路莫名其妙没了"。
     正解是把曲线搬回它假设的空间：解码到线性 → ACES → 编码回显示。
     曝光与 bloom 仍在显示空间叠加，保持既有标定不动。 */
  col = aces(pow(clamp(col, 0.0, 1.0), vec3(2.2)));
  col = pow(col, vec3(1.0 / 2.2));
  col *= uTint;

  /* 雨丝两层：远层密而细（速度慢、视差小），近层疏而宽（落得快）。
     风斜固定 0.12 —— 阵风变向是下一轮的事，先让"有雨"成立。
     量级是实拍校准的：第一版 96/52 格、亮度 0.20/0.34，实拍读起来是
     "一笼白色栅栏"压在整幅画面上，不是雨。收细收疏再压暗之后才是雨丝。 */
  if (uRain > 0.001) {
    float t = uTime * 0.0166667;
    vec3 rc = vec3(0.58, 0.66, 0.74);
    /* 驾驶室机位：雨丝只该出现在**透过玻璃看到的那一带**。
       屏幕空间不知道玻璃在哪，按 cab 机位的默认构图给一个软遮罩
       （台面以下没有雨、A 柱外收掉）；水珠层同理，且量级更小。 */
    float cabMask = 1.0;
    if (uRainCab > 0.5) {
      float mv = smoothstep(0.34, 0.46, uv.y) * (1.0 - smoothstep(0.86, 0.97, uv.y));
      float mh = smoothstep(0.06, 0.16, uv.x) * (1.0 - smoothstep(0.84, 0.94, uv.x));
      cabMask = mv * mh;
    }
    float s1 = rainLayer(uv + vec2(0.13, 0.0), t, 64.0, 13.0, 0.12, 0.50);
    float s2 = rainLayer(uv, t, 36.0, 20.0, 0.12, 0.62);
    col += rc * (s1 * 0.11 + s2 * 0.18) * uRain * cabMask;
    col += rc * droplets(uv, t, 34.0) * 0.085 * uRainCab * uRain;
  }

  // 暗角
  col *= 1.0 - uVig * smoothstep(0.18, 0.82, r2 * 1.35);
  // 去色（用于隧道内冷调）
  float l = dot(col, vec3(0.2126,0.7152,0.0722));
  col = mix(col, vec3(l), uDesat);
  // 胶片颗粒
  float n = fract(sin(dot(uv * uRes + uTime, vec2(12.9898,78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;
  col *= uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ 材质表 */
/* mode: 0 不用贴图 / 1 贴图作为细节乘算 / 2 贴图作为反照率(带 alpha)
 * fade: [起, 止] 细节贴图向平均色退化的距离（米）——按"这张图上的结构有多大"给：
 *   窗格 1~2 m 的结构 300 m 外就该糊掉；航拍地面的 50 m 街区 3 km 外仍然读得出来。
 *   给错了不会报错，只会让远景变成纯色板（"城市浮在沙漠上"那次就是给错了）。 */
const DETAIL_FADE = [300, 1200];
const MATERIALS = {
  concrete:   { tex: 'concrete',  mode: 1, spec: .06, shin: 24, alpha: 1, wet: 1 },
  /* 洞口门框专用材质：与 `concrete` 同一张贴图、同一个观感，**单独成批只为让判据有排他把手**。
     以前门框与桥台、墩身、道床共用 `concrete`，于是"把门框整个撤掉"判据照样绿
     （实测中央带里仍有 4.8% 的 concrete 来自别处，而门槛 1.5%）——
     见 HANDOFF §7.11 与 README 第 83 条。名字要读得出"这是门框"，不要图省事复用大材质。 */
  portal:     { tex: 'concrete',  mode: 1, spec: .06, shin: 24, alpha: 1, wet: 1 },
  concreteD:  { tex: 'concreteD', mode: 1, spec: .05, shin: 18, alpha: 1, wet: 1 },
  segment:    { tex: 'segment',   mode: 1, spec: .10, shin: 30, alpha: 1 },
  metal:      { tex: 'metal',     mode: 1, spec: .42, shin: 90, alpha: 1 },
  steel:      { tex: 'metal',     mode: 1, spec: .60, shin: 150, alpha: 1 },
  /* 钢轨：**专属贴图**（不再是 metal）—— V 沿截面周长走，轨头那一带画成被车轮
     磨亮的银白面、轨腰轨底发暗。高光仍是最亮的一族（轨头本来就该反光）。 */
  rail:       { tex: 'rail',      mode: 1, spec: .85, shin: 220, alpha: 1 },
  granite:    { tex: 'granite',   mode: 1, spec: .28, shin: 70, alpha: 1, wet: 1 },
  tiles:      { tex: 'tiles',     mode: 1, spec: .18, shin: 60, alpha: 1, wet: 1 },
  asphalt:    { tex: 'asphalt',   mode: 1, spec: .05, shin: 12, alpha: 1, wet: 1 },
  aerial:     { tex: 'aerial',    mode: 1, spec: .03, shin: 8,  alpha: 1, fade: [1200, 4200], wet: 1 },
  ballast:    { tex: 'ballast',   mode: 1, spec: .05, shin: 10, alpha: 1, wet: 1 },
  paint:      { tex: null,        mode: 0, spec: .22, shin: 48, alpha: 1 },
  /* 车壳专用族（第 131 条建，第 135 条改口径）：街面/桥面的车以前借用全局 `paint`
     （spec .22 / shin 48，那是路面标线的档次），所以"车漆高光"根本没法单独调 ——
     调 `paint` 会同时把全城的标线、色带、店招一起改掉。
     **`tint: 1` 是这一族存在的另一半意义**：只有它吃"按实例给的涂装色"，
     所以一辆车的几何里"该跟着涂装变的"（侧围、顶盖、引擎盖、后视镜）走这一族，
     而**深色饰条（格栅、门缝、下裙板、路牌、前脸）必须走 `carTrim`** ——
     它们跟着染色就不是那辆车了。第 131 条把 paint 与 metal 合成一族是错的：
     合并省下的批次是假的（网格数没变，只是换了个名字，实测 draw call 319/320 没动），
     而它把"该染的"和"不许染的"混进了同一个桶。 */
  carShell:   { tex: null,        mode: 0, spec: .46, shin: 130, alpha: 1, tint: 1 },
  carTrim:    { tex: null,        mode: 0, spec: .30, shin: 70,  alpha: 1 },
  /* ---- 1 号线列车：**用户给的 BVE 模型贴图**（assets/l1train/*.png）----
     都是 `mode: 2`（整张替换反照率）—— 这是照片，颜色已经烤在贴图里，
     再乘一遍顶点色（车体漆色）会把它染成另一条线的颜色。
     UV 由 `train.js` 按模型自己的 `SetTextureCoordinates` 直接写：
     侧面 u=(z+22.4)/22.4、v=(3.37−y)/2.55（v 从图像上方算，与 BVE 一致）。 */
  l1Side:     { tex: 'l1_side',   mode: 2, spec: .38, shin: 96,  alpha: 1 },
  l1Front:    { tex: 'l1_front',  mode: 2, spec: .38, shin: 96,  alpha: 1 },
  l1Roof:     { tex: 'l1_roof',   mode: 2, spec: .14, shin: 30,  alpha: 1 },
  l1Bogie:    { tex: 'l1_bogie',  mode: 2, spec: .22, shin: 40,  alpha: 1 },
  l1Wheel:    { tex: 'l1_wheel',  mode: 2, spec: .30, shin: 60,  alpha: 1 },
  l1Ac:       { tex: 'l1_ac',     mode: 2, spec: .16, shin: 34,  alpha: 1 },
  body:       { tex: 'paint',     mode: 1, spec: .55, shin: 110, alpha: 1 },
  glass:      { tex: null,        mode: 0, spec: .85, shin: 200, alpha: 1 },
  /* 车厢车窗：**半透**。
     这一条不是为了好看，是为了"从站台看见车厢里"。以前 window 是不透明的，
     车壳又是连续扫掠的闭壳 —— 玻璃后面 8 mm 就是侧壁，于是整节车在站台上
     只是一条黑带。现在车壳按窗带剖开（Geo.shellSplit）、玻璃半透且不写深度，
     客室才能透出来。alpha 取 0.46：既能读出车内灯带与吊环，又保留足够的
     天光反射，玻璃不会变成"贴在车侧的一块透明片"。
     cullOff：从内侧看车窗也必须画得出来（司室侧窗、车门玻璃都是这一材质）。 */
  /* 车厢车窗：**半透**。车壳按窗带剖开（Geo.shellSplit）之后，玻璃后面是真有一间
     客室，所以它必须允许看穿。
     alpha 曾经取 0.46 —— 实拍站台机位才发现那等于没开：黄昏天光下玻璃那张
     天光反射很亮，而客室在地下段的自发光远低于它，合成之后仍然是"一条黑带"，
     玩家读不出任何车内信息（唯一能看见的是乘客的头顶）。
     现在按"玻璃只保留**边缘与掠射角**的高光、正对时几乎完全让位给客室"来做：
       · mode 从 2（整张贴图当反照率）改成 1（贴图当细节乘算），
         于是基色仍然是顶点色（车体漆色/客室透出来的颜色），贴图只贡献纹路；
       · alpha 降到 0.16，正对车窗时客室占 84%；
       · 高光与掠射反射把"玻璃感"补回来（shin 140、spec 0.55 不变），
         所以斜看车窗仍然读得出那是一块玻璃，而不是一个洞。 */
  window:     { tex: 'window',    mode: 1, spec: .58, shin: 150, alpha: .16, blend: true, cullOff: true },
  bldgWin:    { tex: 'bldgWin',   mode: 1, spec: .10, shin: 26, alpha: 1, fade: [220, 900] },
  bldgWin2:   { tex: 'bldgWin2',  mode: 1, spec: .10, shin: 26, alpha: 1, fade: [220, 900] },
  bldgWin3:   { tex: 'bldgWin3',  mode: 1, spec: .10, shin: 26, alpha: 1, fade: [220, 900] },
  brick:      { tex: 'brick',     mode: 1, spec: .06, shin: 16, alpha: 1, wet: 1 },
  roof:       { tex: 'asphalt',   mode: 1, spec: .07, shin: 16, alpha: 1, wet: 1 },
  rubber:     { tex: null,        mode: 0, spec: .04, shin: 8,  alpha: 1 },
  foliage:    { tex: 'noise',     mode: 1, spec: .05, shin: 12, alpha: 1, wet: 0.6 },
  /* 水面 alpha 从 .82 提到 .94：这块平面是**盖在远景地面上方 2 m** 的，
     半透明就等于把下面那片灰紫航拍地面混进来，江面和地面的色差被抹平——
     实测把水批次隐藏后整屏下半部的平均像素差只有 3.1（满量程 765），
     也就是“河在那里，但看不出来”。黄昏江面本来就该比街面暗得多，
     不需要靠透出来透气。 */
  water:      { tex: 'water',     mode: 1, spec: .95, shin: 260, alpha: .94, wave: 1 },
  sign:       { tex: 'sign',      mode: 2, spec: .10, shin: 30, alpha: 1 },
  /* 司机台 TCMS 屏专用一张**独立小纹理**。它不能待在站牌图集里：图集是 4096²，
     屏要按 4 Hz 刷新，走图集就等于每次重传 64 MB。 */
  cab:        { tex: 'cab',       mode: 2, spec: .10, shin: 30, alpha: 1 },
  /* 站台信息屏：独立的实时纹理（下一班倒计时）。
     与 cab / gauge 同族 —— 都是"按状态刷新"的小屏，共用站牌图集就意味着
     要么屏永远不变、要么每帧重传 4096²。 */
  ptd:        { tex: 'ptd',       mode: 2, spec: .06, shin: 20, alpha: 1, emiBoost: 2.6 },
  /* 司机台两只圆表（速度 / 缸压）共用一张 512×256 实时纹理，左右各一半。
     表针是机械的，必须跟着列车状态走，所以和 TCMS 同样的独立纹理待遇。 */
  gauge:      { tex: 'gauge',     mode: 2, spec: .10, shin: 30, alpha: 1 },
  beam:       { tex: null,        mode: 0, spec: 0,   shin: 8,  alpha: .13, blend: true, additive: true, cullOff: true },
  emissive:   { tex: null,        mode: 0, spec: .00, shin: 8,  alpha: 1 },
  light:      { tex: null,        mode: 0, spec: .00, shin: 8,  alpha: 1, emiBoost: 2.2 },
  glassSoft:  { tex: null,        mode: 0, spec: .28, shin: 150, alpha: .20, blend: true, cullOff: true },
  /* 屏蔽门玻璃：alpha 从 .30 提到 .52。
     .30 是从"车厢车窗"那个量级抄来的，但屏蔽门后面贴着的不是亮的客室而是
     一列浅色车体，30% 的深色染色在黄昏光线下几乎读不出来 —— 站台机位里
     整排屏蔽门只剩立柱和一道横梁，玻璃"不见了"。真实半高/全高屏蔽门的
     玻璃带明显的绿灰底色与不锈钢框，框已经单独建模，这里把底色提上来。 */
  screenDoor: { tex: 'glass',     mode: 0, spec: .80, shin: 190, alpha: .38, blend: true, cullOff: true },
};
SH.MATERIALS = MATERIALS;

/**
 * 注册一批 `bve:<贴图名>` 材质 —— **BVE 列车模型**（用户给的 1 号线列车）用。
 *
 * 为什么要动态注册：材质表是写死的常量表，而 BVE 模型的贴图是**外部图片**
 * （`assets/l1train/*.png`，26 张），贴图名来自模型自己的 `LoadTexture`。
 * 不注册的话 `MATERIALS[b.mat]` 会落到 `MATERIALS.concrete` 兜底，
 * 整列车变成一坨混凝土灰（`renderer.js` 的 `m = MATERIALS[b.mat] || MATERIALS.concrete`）。
 * 全部走 `mode: 2`（整张替换反照率）—— 照片的颜色已经烤在贴图里。
 */
function registerBveMats(names) {
  for (const n of names) {
    const key = 'bve:' + String(n).toLowerCase();
    if (MATERIALS[key]) continue;
    /* 无贴图的子网格（模型里 16 处，多是玻璃与内衬）：走**顶点色**（mode 0）
       而不是去要一张不存在的图 —— 否则会落到 1×1 占位色，整车多出十几块灰。
       有贴图的走 **mode 3（真乘）**：模型的贴图是灰度细节图，颜色在 `SetColor` 里。 */
    MATERIALS[key] = (String(n).toLowerCase() === 'none')
      ? { tex: null, mode: 0, spec: .50, shin: 130, alpha: 1 }
      : { tex: 'bve_' + String(n).replace(/\.[a-z0-9]+$/i, '').toLowerCase(),
          mode: 3, spec: .34, shin: 80, alpha: 1 };
  }
}
SH.registerBveMats = registerBveMats;

function extractFrustumPlanes(m) {
  const planes = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    p[0] /= l; p[1] /= l; p[2] /= l; p[3] /= l;
  }
  return planes;
}

/* ------------------------------------------------------------------ 渲染器 */
/** 输出像素预算档位（0 = 不封顶，按设备像素原生出）。
 *  这是"跑不跑得动"的旋钮，与 `quality`（特效链 = 观感旋钮）互不牵连。
 *  1080p 取 2.07 M：实测本机 2.38 M 像素即可锁死 144Hz，留 13 % 余量。 */
SH.RES_TIERS = { native: 0, q2600: 2.6e6, q1080: 2.07e6, q720: 0.92e6 };

/* ---- 自适应分辨率（DRS）：像素预算的"档位序 + 自动策略" ----
   为什么和 RES_TIERS 写在一起：`哪一档更贵`与`该降哪一档`是同一件事的两半，
   分成两处就会各改各的（这条项目在"两个旋钮互相不认识"上栽过三次）。

   玩家手上原本只有**手动**两档旋钮：画质（特效链）与分辨率（像素预算）。
   跑不动的时候没有人替他让步 —— 目标里"帧率拉满"缺的正是这一半。

   为什么策略必须是**纯函数**：判据要在离线跑闭环（合成帧历史 → 看收敛与节奏），
   真 GPU 上的帧间隔没法在 CI 里复现。样本由 `game.frame()` 的 0.5 s 统计窗口喂，
   与 HUD 上那块地勤仪表同一份 —— 另起一套计时就会出现"HUD 说 60fps 而 DRS 在降档"。

   三处口径上的硬规定，都有判据按字面钉着（`test-env.js` H 段）：
   ① **理想拍 = 刷屏周期 × (被限帧器对半跳拍 ? 2 : 1)**。vsync 下"锁在整拍"就是
      上限，看不出余量；而本项目在 >110 Hz 的屏上**故意**一半一拍（见 game.frame
      的稳帧限制器），所以 144 Hz 屏上 13.8 ms 是"锁住了"而不是"掉帧"。阈值读
      同一个 `skipMs` —— 改了限帧忘了改这里，判据立刻红。
   ② **只在降不下去时才试回去**：每次降档记下"这一档跑不动"，之后不许再往上探，
      直到稳定满 `retryS` 秒（场景负荷是会变的：出隧道就该爬回去）。没有这道隔离，
      "降 2 秒 → 爬 6 秒 → 再降"就是玩家看到的画质呼吸。
   ③ **玩家选的那一档是上限，不是目标**：自动档永远不许把画面推得比玩家选的更贵。 */
SH.RES_ORDER = ['q720', 'q1080', 'q2600', 'native'];
SH.RES_NAME = { q720: '720p', q1080: '1080p', q2600: '2.5K', native: '原生' };
SH.DRS = {
  skipMs: 9.2,    // 快于这个出画间隔就整拍跳过（稳帧限制器的阈值，两处必须同值）
  starve: 1.35,   // 出画间隔 > 理想拍 × 1.35 = GPU 赶不上
  lock: 1.06,     // 出画间隔 ≤ 理想拍 × 1.06 = 锁住了
  lowS: 2.0,      // 连续赶不上多少秒才降一档
  highS: 6.0,     // 连续锁住多少秒才试升一档
  coolS: 2.5,     // 换挡后的冷却：换档要重建 FBO，头几帧本来就慢
  retryS: 45,     // 稳定多久之后允许再试一次曾经失败的档
  /* 第二把尺的门槛：GPU 自己报的时间 ≥ 理想拍 × 这个比例才算"欠在像素上"。
     低于它 = 场景/CPU 欠的，降分辨率买不到帧。0.62 是量级判断（留一半余量给
     提交与同步的开销），不是某份规范里的数 —— 判据 ⑪⑫ 钉的是它的行为。 */
  gpuShare: 0.62,
};
SH.drsIdealMs = raf => raf * (raf < SH.DRS.skipMs ? 2 : 1);
/** 刷屏周期的**独立测量**（9b①）：rAF 派发间隔的中位在重负荷下自己也会被拉长 ——
 *  拿 33 ms 当"刷屏"，DRS 就把 30fps 误判成"锁住了"（尺被被测物拽着走）。
 *  派发间隔有一条物理下限 = 刷屏周期（rAF 至多一拍一次），所以取**最小支撑箱**：
 *  0.5 ms 一箱，只认撑得住（≥6%）的箱里最小的那个。111h 踩过的坑（裸最小值被
 *  一两次亚帧抖动读成"屏 156 Hz"这种不存在的东西）由支撑率挡住：抖动落箱只有
 *  一两个样本，不够格。持续重负荷下整窗都是长帧，读数 = 负荷节奏（与中位同宽，
 *  不会更糟）；样本不足返回 0 —— 调用方回退派发中位，行为与旧版逐字一致。
 *  `hist` 是已预滤（3..40 ms）的派发间隔滑窗。 */
SH.refreshFloor = hist => {
  if (!hist || hist.length < 48) return 0;
  const bins = new Map();
  for (const ms of hist) {
    const b = Math.round(ms * 2) / 2;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  const need = Math.max(3, Math.ceil(hist.length * 0.06));
  const ok = [...bins.keys()].filter(b => bins.get(b) >= need).sort((a, b) => a - b);
  return ok.length ? ok[0] : 0;
};
/** 往下找**第一档真的少画像素的**：像素预算只是封顶，窗口本来比预算小的时候
 *  降档一个像素也省不下来。返回 -1 = 一档都买不到（瓶颈不在像素上，别装模作样）。 */
SH.drsTarget = (npx, from) => {
  for (let i = from - 1; i >= 0; i--) {
    const b = SH.RES_TIERS[SH.RES_ORDER[i]];
    if (b && b < npx * 0.99) return i;
  }
  return -1;
};
SH.drsNew = cap => ({ tier: cap, cap, fail: Infinity, low: 0, good: 0, cool: 0, age: 0,
  /* 第二把尺的状态：gpu = 最近一次读到的 GPU 毫秒；gpuAt = 上一次降档时的毫秒（对账用）；
     cpu = 累计的"慢但不是像素欠的"秒数（到 `DRS.lowS` 就不许再降）。 */
  gpu: 0, gpuAt: 0, cpu: 0, cpuAt: 0, hot: 0, pxAt: 0, pxTo: 0 });
/** 喂一个窗口样本（出画间隔中位 / 刷屏周期 / 这个窗口的秒数 / **当前窗口的设备像素**）。
 *  `fail` 是"已知跑不动的最低档"，比它贵的档一律不再上探，直到 `age` 攒满 retryS。
 *  `cap` 与 `fail` 是**两件事**，不能合成一个数：cap 是"玩家只允许到这一档"，
 *  fail 是"这一档（及更贵的）实测跑不动"。第一版把 fail 初始化成 cap+1 来
 *  充当上限，于是 `st.tier < st.cap` 变成死代码 —— 负控 `drsnocap`（撤掉上限
 *  那半句）跑出 rc=0、零红字才被抓出来：两个都拦的东西只该留一个能解释的。 */
/** 这一档在这个窗口上**真的会画多少像素**（窗口与预算取小的那个；native 档 = 窗口本身）。
 *  `drsTarget` 用它保证"降档必须少画像素"，`drsStep` 的对账用它保证
 *  "少画的像素要换来按比例少花的 GPU 时间"。 */
SH.drsDrawn = (npx, i) => {
  const b = SH.RES_TIERS[SH.RES_ORDER[i]] || 0, n = npx > 0 ? npx : 0;
  return b > 0 ? (n > 0 ? Math.min(n, b) : b) : n;
};
SH.drsStep = (st, cadenceMs, rafMs, sec, npx, gpuMs) => {
  const D = SH.DRS, id = SH.drsIdealMs(rafMs);
  if (!(id > 0) || !(sec > 0)) return st;                 // 没量到刷屏周期就别乱动
  st.age += sec;
  if (st.cool > 0) { st.cool -= sec; st.low = 0; st.good = 0; return st; }
  /* 第二把尺：GPU 自己报的毫秒。出画间隔只能说"这一帧没赶上"，说不出欠在谁身上 ——
     欠在像素上就该降档，欠在场景上降了也白降（还白改三次 FBO，把玩家那块画面按成 720p）。
     `gpuMs` 没给（扩展缺失 / 还没收到第一个样本）⇒ `pixelBound` 恒真，
     行为与"只有一把尺"的旧版逐字一致 —— 这条回退本身有判据（test-env ⑬）。 */
  const known = gpuMs > 0 && isFinite(gpuMs);
  if (known) st.gpu = gpuMs;
  /* 退闩分两种来源（第一版只写了一条"毫秒数回到门槛就退"，被⑫当场判死：
     平表 12 ms 既触发对账又满足退闩，于是每降一档立刻解锁，对账形同没有）：
     ① 因"GPU 不忙"闩上的 —— 定义翻转（GPU 重新吃满）就立刻退，没什么好犹豫；
     ② 因"降档买不到时间"闩上的 —— 要**比那次失败时再高一半**并且持续几秒才退，
       否则一次误判就把降档这条路永久关死了。 */
  if (st.cpu >= D.lowS) {
    if (st.cpuAt > 0) {
      if (known && gpuMs >= st.cpuAt * 1.5) { st.hot += sec; if (st.hot >= D.lowS) { st.cpu = 0; st.hot = 0; st.cpuAt = 0; } }
      else st.hot = 0;
    } else if (!known || gpuMs >= id * D.gpuShare) { st.cpu = 0; st.hot = 0; }
  }
  const pixelBound = st.cpu >= D.lowS ? false : (!known || gpuMs >= id * D.gpuShare);
  /* 对账（"省下来"必须配"该给的都给了"那一族）：**只有像素确实少画了四分之一以上**
     才有资格说"时间没跟着降"（native→q2600 只差 0.5%，噪声就能推翻任何判据 —— 第一版
     用固定"时间必须掉 5%"，把一次正常降档判成买不到时间）。门槛按线性预测算，
     并且允许一截固定开销：实测时间必须比"预测值 + 六成预测降幅"还差才算。 */
  if (known && st.gpuAt > 0 && st.pxAt > 0 && st.pxTo > 0 && st.pxTo < st.pxAt * 0.75) {
    const want = st.gpuAt * st.pxTo / st.pxAt;
    if (gpuMs > want + 0.6 * (st.gpuAt - want)) { st.cpu = D.lowS; st.cpuAt = gpuMs; st.gpuAt = 0; }
  }
  if (cadenceMs > id * D.starve) { st.low += sec; st.good = 0; }
  else if (cadenceMs <= id * D.lock) { st.good += sec; st.low = 0; }
  else { st.low = 0; st.good = 0; }                       // 中间带：既不算掉帧也不算锁拍
  if (st.low >= D.lowS && st.tier > 0) {
    if (!pixelBound) { st.low = D.lowS; st.cpu += sec; }  // 瓶颈不在像素：一档都不许降
    else {
      /* 降档必须**真的少画像素**（`npx` 没给就退回单步降）。这一条是被真机测量逼出来的：
         DPR=0.5 那一趟窗口只有 0.28 M 像素、瓶颈在场景，而旧写法照样一路降到地板 ——
         白改三次 FBO、还偷偷把玩家的意图改成了 720p。 */
      const to = npx > 0 ? SH.drsTarget(npx, st.tier) : st.tier - 1;
      if (to >= 0) {
        st.fail = Math.min(st.fail, st.tier);
        st.gpuAt = known ? gpuMs : 0;
        st.pxAt = SH.drsDrawn(npx, st.tier); st.pxTo = SH.drsDrawn(npx, to);
        st.tier = to; st.low = 0; st.good = 0; st.cool = D.coolS; st.age = 0;
        st.cpu = 0; st.cpuAt = 0; st.hot = 0;
      } else st.low = 0;                                  // 一档都买不到：不装模作样
    }
  } else if (st.good >= D.highS) {
    if (st.age > D.retryS) st.fail = Infinity;            // 稳定够了，允许重探
    if (st.tier < st.cap && st.tier + 1 < st.fail) {
      st.tier++; st.low = 0; st.good = 0; st.cool = D.coolS;
    } else st.good = 0;                                   // 没有可探的上档：不再攒
  }
  return st;
};

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opt = { antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true };
    /* WebGL2 优先（原生 VAO、原生 uint 索引，ESSL 1.00 shader 原样可跑），
       取不到再回退 WebGL1 —— 本项目的全部现有管线在这两套上下文里行为一致。
       vaoExt 在 GL2 下是一个"把原生 VAO 包成 OES 方法名"的垫片：
       upload/draw/dropTag 里的 createVertexArrayOES 等调用点因此一行不用改。 */
    let gl = canvas.getContext('webgl2', opt);
    if (gl) {
      this.gl2 = true;
      this.vaoExt = {
        createVertexArrayOES: () => gl.createVertexArray(),
        bindVertexArrayOES: v => gl.bindVertexArray(v),
        deleteVertexArrayOES: v => gl.deleteVertexArray(v),
      };
      this.extUint = true;                       // GL2 原生支持 32 位索引
    } else {
      gl = canvas.getContext('webgl', opt) || canvas.getContext('experimental-webgl', opt);
      this.vaoExt = gl ? (gl.getExtension('OES_vertex_array_object') || gl.getExtension('MOZ_OES_vertex_array_object') || gl.getExtension('WEBKIT_OES_vertex_array_object')) : null;
      this.extUint = gl ? gl.getExtension('OES_element_index_uint') : null;
    }
    this.api = gl ? (this.gl2 ? 'WebGL2' : 'WebGL1') : null;
    if (!gl) { fatal('无法初始化 WebGL', '你的浏览器或显卡驱动未启用 WebGL/WebGL2。\n请尝试：\n· 更换 Chrome / Edge\n· 在设置中开启"使用硬件加速模式"\n· 更新显卡驱动'); throw new Error('no webgl'); }
    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.02, 0.04, 0.06, 1);

    this.prog = program(gl, SCENE_VS, SCENE_FS, 'scene');
    const L = n => gl.getUniformLocation(this.prog, n);
    this.u = { aP: gl.getAttribLocation(this.prog, 'aPos'), aN: gl.getAttribLocation(this.prog, 'aNrm'), aU: gl.getAttribLocation(this.prog, 'aUv'), aC: gl.getAttribLocation(this.prog, 'aCol'),
      aI0: gl.getAttribLocation(this.prog, 'aI0'), aI1: gl.getAttribLocation(this.prog, 'aI1'), aI2: gl.getAttribLocation(this.prog, 'aI2'), aI3: gl.getAttribLocation(this.prog, 'aI3'),
      aIT: gl.getAttribLocation(this.prog, 'aIT'), inst: L('uInst'), tint: L('uTint'),
      M: L('uM'), VP: L('uVP'), N: L('uN'), eye: L('uEye'), sunDir: L('uSunDir'), sunCol: L('uSunCol'), sky: L('uSkyCol'), gnd: L('uGndCol'),
      fog: L('uFogCol'), fog2: L('uFog2'), fogP: L('uFog'), fade: L('uFade'), tex: L('uTex'), mat: L('uMat'), time: L('uTime'), emi: L('uEmiBoost'), wave: L('uWave'), cut: L('uCut'), uvS: L('uUvScale'), skyH: L('uSkyHor'), wet: L('uWet') };

    this.pgSky = program(gl, FS_QUAD_VS, SKY_FS, 'sky');
    this.pgBright = program(gl, FS_QUAD_VS, BRIGHT_FS, 'bright');
    this.pgBlur = program(gl, FS_QUAD_VS, BLUR_FS, 'blur');
    this.pgComp = program(gl, FS_QUAD_VS, COMPOSITE_FS, 'composite');
    this._quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.textures = {};
    this.batches = [];
    this.quality = 'high';
    this.resTier = 'q1080';     // 默认 1080p 预算：满刷屏优先，想要原生清晰度可在设置里拉
    this.resAuto = true;        // 自动档（DRS）默认开：上限仍是玩家选的这一档，
                                // 所以它只在"这台机器连上限都锁不住"时才会动手，
                                // 锁得住时一次都不改（判据②按字面钉住这条）。
    this._effTier = 'q1080';    // 真正生效的那一档（自动时由策略摆，手动时=上限）
    this._up = 1;
    this.post = true;
    this.time = 0;
    this.stats = { draws: 0, tris: 0 };
    /* GPU 时间查询：DRS 的第二把尺（见 `SH.DRS.gpuShare`）。只走 WebGL2 那个扩展 ——
       GL1 的 `EXT_disjoint_timer_query` 是 queryObjectEXT/getQueryObjectEXT 另一套 API，
       为它多开一条分支不值；拿不到就是"第二把尺不存在"，策略自动退回旧口径。 */
    this.qExt = this.gl2 ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') || null) : null;
    this.gpuMs = 0; this._gpuHist = []; this._q = null; this._qOpen = false;
    /* 分 pass（9b② 的后半笔）：世界 pass 的毫秒一直有账（上面那条，begin→end 前半段），
       后期链从来没有 —— "世界贵还是后期贵"之前只能靠三角形数与像素数猜。
       这里给后期链一条**自己的**查询：begin 在 end() 的 post 早退之后（low 档 / 无 post
       根本没有后期工作，不开空查询），end 在 composite 提交完。同一个 target 不许两个
       活动查询，所以两条严格顺序：世界收尾 → 后期开表 → 后期收尾。 */
    this.gpuPostMs = 0; this._gpuPostHist = []; this._qPost = null; this._qPostOpen = false;
    this.env = null;
    this._curM = null;
    this._curTex = null;
    this._curBlend = false;
    this._curBlendFunc = -1;
    this._curDepthMask = true;
    this._curCullOff = false;
    this.resize();
  }

  /* ------------------------------------------------------------ 资源上传 */
  /**
   * 从**图片文件**上传一张贴图（1 号线的列车模型贴图走这条）。
   *
   * 与 `texFromCanvas` 分开写的理由：这条是**异步**的 —— 图片解码完成前材质
   * 也得能绑到一个合法的 GL 纹理（否则 draw 里 `bindTexture(null)` 会把上一张
   * 贴图带进来）。所以先建 1×1 的占位色，`onload` 之后再复用**同一个** GL 对象
   * 覆盖（与 texFromCanvas 的"同名复用"是同一条纪律）。
   * 离线判据（Node）没有 `Image`，直接返回、只留占位 —— 几何判据不受影响。
   */
  texFromImage(name, url, repeat) {
    const gl = this.gl;
    if (!this.textures[name]) {
      const t = gl.createTexture(); this.textures[name] = t;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([196, 198, 202, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    }
    if (typeof Image === 'undefined') return;
    const img = new Image();
    img.onload = () => { try { this.texFromCanvas(name, img, !!repeat, true); } catch (e) { /* 保持占位 */ } };
    img.src = url;
  }

  texFromCanvas(name, canvas, repeat, mipmap) {
    const gl = this.gl;
    /* 同名纹理必须**复用同一个 GL 对象**。原来每次调用都 createTexture() 再覆盖
       this.textures[name]，旧的既不 delete 也不解绑 —— 站牌图集现在要在烘焙后
       重传（4096² 一张 = 64 MB），一局跑下来会泄漏几百 MB 直到显存耗尽。 */
    let t = this.textures[name];
    if (!t) t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    this._curTex = t;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const isPow2 = n => (n & (n - 1)) === 0 && n > 0;
    const isDynamic = (name === 'gauge' || name === 'cab' || name === 'ptd');
    const wantMip = (mipmap != null ? mipmap : !isDynamic) && isPow2(canvas.width) && isPow2(canvas.height);
    if (wantMip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      if (aniso) { const mx = Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)); gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, mx); }
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.textures[name] = t;
    return t;
  }

  /** 把 Builder.finish() 的几何数组变成可绘制批次 */
  upload(meshes, tag) {
    const gl = this.gl, out = [];
    const vaoExt = this.vaoExt, u = this.u;
    for (const m of meshes) {
      const mk = (target, data, type) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
      const col = new Uint8Array(m.verts * 4);
      for (let i = 0; i < m.verts; i++) { col[i * 4] = m.col[i * 3]; col[i * 4 + 1] = m.col[i * 3 + 1]; col[i * 4 + 2] = m.col[i * 3 + 2]; col[i * 4 + 3] = m.emi[i]; }
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const pos = m.pos;
      if (pos && pos.length) {
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], y = pos[i + 1], z = pos[i + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
      const b = {
        mat: m.mat, tag: tag || 'world',
        /* 这一批吃不吃"按实例给的涂装色"—— 唯一出处是材质表的 `tint` 标志，
           别在调用点按材质名硬判（那等于第二份真值，改材质名就悄悄失配）。 */
        tint: MATERIALS[m.mat] && MATERIALS[m.mat].tint ? 1 : 0,
        pb: mk(gl.ARRAY_BUFFER, m.pos, gl.FLOAT), nb: mk(gl.ARRAY_BUFFER, m.nrm, gl.FLOAT),
        ub: mk(gl.ARRAY_BUFFER, m.uv, gl.FLOAT), cb: mk(gl.ARRAY_BUFFER, col, gl.UNSIGNED_BYTE),
        ib: mk(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.UNSIGNED_SHORT),
        count: m.count, type: gl.UNSIGNED_SHORT,
        bbox: isFinite(minX) ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null,
      };
      if (vaoExt && u) {
        b.vao = vaoExt.createVertexArrayOES();
        vaoExt.bindVertexArrayOES(b.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.pb); gl.enableVertexAttribArray(u.aP); gl.vertexAttribPointer(u.aP, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.nb); gl.enableVertexAttribArray(u.aN); gl.vertexAttribPointer(u.aN, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.ub); gl.enableVertexAttribArray(u.aU); gl.vertexAttribPointer(u.aU, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.cb); gl.enableVertexAttribArray(u.aC); gl.vertexAttribPointer(u.aC, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ib);
        vaoExt.bindVertexArrayOES(null);
      }
      out.push(b);
    }
    (this.batches = this.batches || []).push(...out);
    return out;
  }
  /** 实例化绘制：mats = 每实例一个列主序 mat4（与 m4basis 输出同约定）。
   *  GL2：aI0..aI3 以 divisor 1 顶点属性进 shader（顶点里做基变换），
   *       一份几何 × N 个实例 = 1 次 draw call —— AI 车中段车/街面车流
   *       以前是"每实例每批次"一次 draw，同几何同材质被无谓地重复提交。
   *  `tints`（第 135 条，可省）= 3n 的扁平 rgb：同一份几何按实例染色，
   *       于是"涂装"不再需要一份几何 —— 变体表从 (车型 × 涂装) 塌回车型。
   *       只有材质标了 `tint` 的批次会乘它（`b.tint`），其余批次 a 给 0。
   *  GL1 回退：逐实例走普通 draw，颜色经 `uTint` 送进同一分支（行为一致，只是没有省）。
   *  注意：实例化期间 uM 必须是单位阵（顶点里已经变换到世界系）。 */
  drawInstanced(b, mats, ov, tints) {
    const gl = this.gl, u = this.u;
    const n = mats.length;
    if (!n) return;
    if (!this.gl2 || !u.inst) {
      for (let i = 0; i < n; i++) {
        const o = tints && b.tint ? { tint: [tints[i * 3], tints[i * 3 + 1], tints[i * 3 + 2]] } : ov;
        this.draw(b, mats[i], o);
      }
      return;
    }
    if (!this.instBuf) { this.instBuf = gl.createBuffer(); this._instCap = 0; }
    const STR = 20;                       // 16 矩阵 + 4 颜色（vec4）
    const data = new Float32Array(n * STR);
    for (let i = 0; i < n; i++) {
      const m = mats, off = i * STR;
      if (m.length === 16 * n) {   // 已是拍平的一整块
        for (let k = 0; k < 16; k++) data[off + k] = m[i * 16 + k];
      } else for (let k = 0; k < 16; k++) data[off + k] = m[i][k];
      data[off + 3] = 0; data[off + 7] = 0; data[off + 11] = 0; data[off + 15] = 1;
      data[off + 16] = tints && b.tint ? tints[i * 3] : 1;
      data[off + 17] = tints && b.tint ? tints[i * 3 + 1] : 1;
      data[off + 18] = tints && b.tint ? tints[i * 3 + 2] : 1;
      data[off + 19] = tints && b.tint ? 1 : 0;
    }
    if (this._instCap < n * STR) { gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf); gl.bufferData(gl.ARRAY_BUFFER, n * STR * 4, gl.DYNAMIC_DRAW); this._instCap = n * STR; }
    this.vaoExt.bindVertexArrayOES(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    if (data.length < this._instCap) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    else gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const attrs = [u.aI0, u.aI1, u.aI2, u.aI3, u.aIT];
    for (let k = 0; k < 5; k++) {
      gl.enableVertexAttribArray(attrs[k]);
      gl.vertexAttribPointer(attrs[k], 4, gl.FLOAT, false, STR * 4, k * 16);
      gl.vertexAttribDivisor(attrs[k], 1);
    }
    // 标准四属性：VAO 已解绑，手工走一遍 upload 同款的绑定
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pb); gl.enableVertexAttribArray(u.aP); gl.vertexAttribPointer(u.aP, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nb); gl.enableVertexAttribArray(u.aN); gl.vertexAttribPointer(u.aN, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.ub); gl.enableVertexAttribArray(u.aU); gl.vertexAttribPointer(u.aU, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.cb); gl.enableVertexAttribArray(u.aC); gl.vertexAttribPointer(u.aC, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ib);
    gl.uniform1f(u.inst, 1);
    gl.uniformMatrix4fv(u.M, false, IDENT);
    _nm = m3normalFromM4(IDENT, _nm); gl.uniformMatrix3fv(u.N, false, _nm);
    this._curM = null;
    /* 实例数必须一路传到 drawElementsInstanced：以前这里漏传 n，`_drawBatch`
       按 `nInst || 1` 提交，于是一组 48 个实例只画第 1 个 —— 而 draw call 数
       照降、三角形统计照按 1 个算，perf 表看起来是"优化成功"。
       判据：node dev/inst-check.js（JS 请求实例数 ↔ GL 实画实例数逐帧对账）。 */
    this._drawBatch(b, ov, n);
    for (let k = 0; k < 5; k++) gl.vertexAttribDivisor(attrs[k], 0);
    /* uInst 与 _curM 一样是**通道状态**：进来时置 1，出去必须归 0。
       漏了它，之后每一批普通绘制都会在 shader 里再走一遍实例基变换
       （aI 读到 instBuf 的第 0 个矩阵），等于把整个场景乘两遍矩阵。 */
    gl.uniform1f(u.inst, 0);
    this._curM = null;
  }

  /** 删除某个 tag 的全部批次（重建世界时用） */
  dropTag(tag) {
    const gl = this.gl, vaoExt = this.vaoExt;
    this.batches = this.batches.filter(b => {
      if (b.tag !== tag) return true;
      if (b.vao && vaoExt) vaoExt.deleteVertexArrayOES(b.vao);
      gl.deleteBuffer(b.pb); gl.deleteBuffer(b.nb); gl.deleteBuffer(b.ub); gl.deleteBuffer(b.cb); gl.deleteBuffer(b.ib);
      return false;
    });
  }

  resize() {
    /* 画质与分辨率是**两个旋钮**。以前 `quality` 一个字符串同时决定 dpr 上限和
       后期链开关，于是"想要高清特效"就必须接受 2560×1452 的填充率 —— 玩家没有
       "1080p 但要高清"这个选项，而它恰恰是内存显卡上唯一能锁满刷屏的组合。 */
    const cw = Math.max(1, this.canvas.clientWidth || 1), ch = Math.max(1, this.canvas.clientHeight || 1);
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    let w = Math.max(1, Math.floor(cw * dpr)), h = Math.max(1, Math.floor(ch * dpr));
    this._native = w * h;
    const budget = SH.RES_TIERS[this.resAuto ? this._effTier : this.resTier] || 0;
    /* 按**总像素**封顶，不按倍数：倍数不绑定绝对成本 —— 同一个"1.35 倍"在
       1280×720 的窗口上是 1.7 M 像素、在 4K 全屏上是 15 M 像素，后者必要死。
       实测本机（Radeon 780M）：3.72 M 像素 → 118fps 且帧间隔 6.4~14.5 ms 乱跳；
       2.38 M → 144fps 锁死（帧 6.7~7.1）。所以 1080p 是满帧地板，2.6 M 是够用线。 */
    if (budget && w * h > budget) {
      const k = Math.sqrt(budget / (w * h));
      w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k));
    }
    this._up = this._native / (w * h);          // 合成时按这个比例补锐度
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.w = w; this.h = h; this.dpr = dpr; this.aspect = w / h;
    if (this.sceneFbo) { this._destroyFbo(this.sceneFbo); this.sceneFbo = null; }
    if (this.bloomA) { this._destroyFbo(this.bloomA); this._destroyFbo(this.bloomB); this.bloomA = this.bloomB = null; }
  }
  setQuality(q) { this.quality = q; this.resize(); }
  /** 输出像素预算档位：只改分辨率，不碰特效链 */
  /* 玩家改上限 = 生效档也从这一档重新开始找（自动档只会往下让，不会偷偷更贵）。 */
  setRes(t) { if (SH.RES_TIERS[t] == null) t = 'q1080'; this.resTier = t; this._effTier = t; this.resize(); }
  /** 自动档开关：关掉立刻回到玩家选的那一档（不许留下一个"偷偷在跑"的生效档）。 */
  setResAuto(on) {
    this.resAuto = !!on;
    this._effTier = this.resTier;
    this.resize();
  }
  /** 自动档换挡的唯一入口（由 `game.frame()` 里的 DRS 策略调用）。
   *  只吃档名不吃预算数字，且只在真的换了时重建 FBO 并返回 true —— 返回值就是
   *  "要不要告诉玩家画面变了"，别让调用点自己猜。 */
  setResEff(t) {
    if (!this.resAuto || SH.RES_TIERS[t] == null || t === this._effTier) return false;
    this._effTier = t; this.resize(); return true;
  }

  _makeFbo(w, h, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = filter || gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, rb, w, h };
  }
  _destroyFbo(o) { if (!o) return; const gl = this.gl; gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fb); gl.deleteRenderbuffer(o.rb); }

  boxInFrustum(min, max, margin) {
    if (!this.frustumPlanes) return true;
    const planes = this.frustumPlanes;
    margin = margin == null ? 15 : margin;
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      const px = p[0] > 0 ? max[0] : min[0];
      const py = p[1] > 0 ? max[1] : min[1];
      const pz = p[2] > 0 ? max[2] : min[2];
      if (p[0] * px + p[1] * py + p[2] * pz + p[3] < -margin) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ 帧 */
  /** 一条 GPU 查询的三个口径（没完成不读 / disjoint 丢样本 / 读完删查询）。
   *  返回 null = 还没完成（查询留在原地，下帧再问，不许删）；返回 {ms:null} = disjoint
   *  （样本丢掉但查询已删）；返回 {ms} = 好数。hist 与暴露字段的归属由调用方管 ——
   *  世界账（_pollGpu）与后期账（_pollGpuPost）是两本账，混了就谁也说不清。 */
  _pollQ(q) {
    const gl = this.gl, e = this.qExt;
    if (!e || !q) return null;
    if (!gl.getQueryParameter(q, e.RESULT_AVAILABLE_EXT)) return null;
    const ms = gl.getQueryParameter(q, e.GPU_TIME_DISJOINT_EXT) ? null
      : gl.getQueryParameter(q, e.QUERY_TIME_ELAPSED_EXT) / 1e6;
    gl.deleteQuery(q);
    return { ms };
  }
  /** 收一个已完成的 GPU 时间样本（世界 pass；没有就什么都不做）。
   *  取最近 30 个样本的**中位数**：单次查询会被驱动合并/延迟，中位数才稳。 */
  _pollGpu() {
    if (this._qOpen) return;
    const r = this._pollQ(this._q);
    if (r === null) return;
    this._q = null;
    if (r.ms != null) {
      const h = this._gpuHist;
      h.push(r.ms);
      if (h.length > 30) h.shift();
      this.gpuMs = h.slice().sort((a, b) => a - b)[(h.length / 2) | 0] || 0;
    }
  }
  /** 后期链的账（与世界账同一套三口径，各自独立成账 —— 混账就是没有分 pass）。 */
  _pollGpuPost() {
    if (this._qPostOpen) return;
    const r = this._pollQ(this._qPost);
    if (r === null) return;
    this._qPost = null;
    if (r.ms != null) {
      const h = this._gpuPostHist;
      h.push(r.ms);
      if (h.length > 30) h.shift();
      this.gpuPostMs = h.slice().sort((a, b) => a - b)[(h.length / 2) | 0] || 0;
    }
  }
  begin(cam, env, dt) {
    const gl = this.gl;
    /* 先收上一帧的读数，再开这一帧的查询。begin/end 必须成对：
       漏 endQuery 会让下一次 beginQuery 直接 INVALID_OPERATION，
       整条计时通道从此静默废掉（而 `gpuMs` 永远停在最后一个好样本上 —— 最难查的那种）。 */
    this._pollGpu();
    this._pollGpuPost();
    if (this.qExt && !this._qOpen) {
      const q = gl.createQuery();
      if (q) { this._q = q; gl.beginQuery(this.qExt.TIME_ELAPSED_EXT, q); this._qOpen = true; }
    }
    if (this.vaoExt) this.vaoExt.bindVertexArrayOES(null);
    this._curM = null;
    this._curTex = null;
    this._curBlend = false;
    this._curBlendFunc = -1;
    this._curDepthMask = true;
    this._curCullOff = false;
    this.time += (dt == null ? 1 / 60 : dt);
    this.env = env;
    this.stats.draws = 0; this.stats.tris = 0;
    this.vp = m4mul(m4perspective(cam.fov * SH.DEG, this.aspect, cam.near || 0.12, cam.far || 1400), m4lookAt(cam.eye, cam.target, cam.up || [0, 1, 0]));
    this.frustumPlanes = extractFrustumPlanes(this.vp);
    this.eye = cam.eye;
    if (this.post && this.quality !== 'low') {
      if (!this.sceneFbo || this.sceneFbo.w !== this.w) { this._destroyFbo(this.sceneFbo); this.sceneFbo = this._makeFbo(this.w, this.h); }
      const bw = Math.max(1, this.w >> 2), bh = Math.max(1, this.h >> 2);
      if (!this.bloomA || this.bloomA.w !== bw) { this._destroyFbo(this.bloomA); this._destroyFbo(this.bloomB); this.bloomA = this._makeFbo(bw, bh); this.bloomB = this._makeFbo(bw, bh); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo.fb);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, this.w, this.h);
    const c = env.skyHorizon || [0.5, 0.6, 0.7];
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._drawSky(cam, env);
    gl.useProgram(this.prog);
    if (!this.vaoExt) {
      gl.enableVertexAttribArray(this.u.aP); gl.enableVertexAttribArray(this.u.aN);
      gl.enableVertexAttribArray(this.u.aU); gl.enableVertexAttribArray(this.u.aC);
    }
    gl.uniformMatrix4fv(this.u.VP, false, this.vp);
    gl.uniform3fv(this.u.eye, new Float32Array(cam.eye));
    gl.uniform3fv(this.u.sunDir, new Float32Array(env.sunDir));
    gl.uniform3fv(this.u.sunCol, new Float32Array(env.sunCol));
    gl.uniform3fv(this.u.sky, new Float32Array(env.skyCol));
    gl.uniform3fv(this.u.skyH, new Float32Array(env.skyHorizon || env.fogCol));
    gl.uniform3fv(this.u.gnd, new Float32Array(env.gndCol));
    gl.uniform3fv(this.u.fog, new Float32Array(env.fogCol));
    gl.uniform3fv(this.u.fog2, new Float32Array(env.fog2 || env.fogCol));
    gl.uniform2fv(this.u.fogP, new Float32Array([env.fogDensity, env.fogHeightFalloff == null ? 0.05 : env.fogHeightFalloff]));
    gl.uniform1f(this.u.time, this.time);
    gl.uniform1f(this.u.emi, env.emiBoost == null ? 1 : env.emiBoost);
    /* 雨天（D4）：全局湿度 0..1。draw() 再按材质的 wet 标志乘下去 ——
       只有"会被雨淋的表面"（沥青、砖石、地面）有这个标志，玻璃/金属/自发光
       不参与。env.wet 由 game.envFor 按"相机所在地有多露天"给：隧道里不湿。 */
    this.wetAmt = env.wet == null ? 0 : env.wet;
    gl.uniform1f(this.u.wet, this.wetAmt);
    gl.uniform2fv(this.u.uvS, new Float32Array([1, 1]));
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(this.u.tex, 0);
  }

  _drawSky(cam, env) {
    const gl = this.gl, pg = this.pgSky, L = n => gl.getUniformLocation(pg, n);
    let f = [cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1; f = [f[0] / fl, f[1] / fl, f[2] / fl];
    const up0 = cam.up || [0, 1, 0];
    let r = [up0[1] * f[2] - up0[2] * f[1], up0[2] * f[0] - up0[0] * f[2], up0[0] * f[1] - up0[1] * f[0]];
    const rl = Math.hypot(r[0], r[1], r[2]) || 1; r = [r[0] / rl, r[1] / rl, r[2] / rl];
    const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    const th = Math.tan((cam.fov || 60) * Math.PI / 360);
    gl.useProgram(pg);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    this._quadBind(pg, 'aP');
    gl.uniform3fv(L('uRight'), new Float32Array(r));
    gl.uniform3fv(L('uUp'), new Float32Array(u));
    gl.uniform3fv(L('uFwd'), new Float32Array(f));
    gl.uniform3fv(L('uSunDir'), new Float32Array(env.sunDir));
    gl.uniform3fv(L('uSunCol'), new Float32Array(env.sunCol));
    gl.uniform3fv(L('uHorizon'), new Float32Array(env.skyHorizon || env.fogCol));
    gl.uniform3fv(L('uZenith'), new Float32Array(env.skyZenith || [0.12, 0.20, 0.36]));
    gl.uniform3fv(L('uGroundCol'), new Float32Array(env.gndCol));
    gl.uniform3fv(L('uFogCol'), new Float32Array(env.fogCol));
    gl.uniform3fv(L('uHaze'), new Float32Array(env.haze || [0.0, 0.0, 0.0]));
    gl.uniform2f(L('uTan'), th * this.aspect, th);
    gl.uniform1f(L('uNight'), env.night == null ? 0.35 : env.night);
    gl.uniform1f(L('uTime'), this.time);
    /* 全屏三角形只用到位置属性。主程序启用了 4 个属性槽（aPos/aNrm/aUv/aCol），
       画天空时那三个非位置槽要么指向已被 dropTag 删掉的 buffer、要么根本没绑过，
       WebGL 就每帧报 "no buffer is bound to enabled attribute"。
       画之前把主程序多余的槽关掉，begin() 里画世界之前会重新开。 */
    const uu = this.u || {};
    for (const k of [uu.aN, uu.aU, uu.aC]) if (k > 0) gl.disableVertexAttribArray(k);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (const k of [uu.aN, uu.aU, uu.aC]) if (k > 0) gl.enableVertexAttribArray(k);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.CULL_FACE);
  }

  /**
   * @param b  批次
   * @param M  模型矩阵
   * @param ov 覆盖参数 {alpha, emi, cut, wave, tint}
   */
  draw(b, M, ov) {
    const gl = this.gl, u = this.u, m = MATERIALS[b.mat] || MATERIALS.concrete;
    ov = ov || {};
    /* 非实例化通道的按批次染色（WebGL1 回退与"逐辆画"的那几条路径走这里）。
       `a` 为 0 时 shader 整条分支跳过 —— 每一批都必须显式写，
       漏写等于让上一批的颜色留在这批上。 */
    gl.uniform4f(u.tint, ov.tint ? ov.tint[0] : 1, ov.tint ? ov.tint[1] : 1,
      ov.tint ? ov.tint[2] : 1, ov.tint && b.tint ? 1 : 0);
    if (this.vaoExt && b.vao) {
      this.vaoExt.bindVertexArrayOES(b.vao);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pb); gl.vertexAttribPointer(u.aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.nb); gl.vertexAttribPointer(u.aN, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.ub); gl.vertexAttribPointer(u.aU, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.cb); gl.vertexAttribPointer(u.aC, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ib);
    }
    const modelM = M || IDENT;
    if (modelM !== this._curM) {
      this._curM = modelM;
      gl.uniformMatrix4fv(u.M, false, modelM);
      if (modelM === IDENT) {
        gl.uniformMatrix3fv(u.N, false, IDENT_NORMAL);
      } else {
        _nm = m3normalFromM4(modelM, _nm);
        gl.uniformMatrix3fv(u.N, false, _nm);
      }
    }
    this._drawBatch(b, ov, 1);
  }

  /** 材质状态 + 提交（draw 与 drawInstanced 共用；nInst 只影响三角形计数）。
   *  抽出来的原因：实例化通道的"绑定与矩阵"完全不同（aI 属性 + 单位阵），
   *  但材质状态机是同一台 —— 不拆开就会有两份必然漂移的状态机。 */
  _drawBatch(b, ov, nInst) {
    const gl = this.gl, u = this.u, m = MATERIALS[b.mat] || MATERIALS.concrete;
    ov = ov || {};
    const texName = ov.tex != null ? ov.tex : m.tex;
    let mode = m.mode;
    const texObj = (texName && this.textures[texName]) ? this.textures[texName] : (this.textures.white || null);
    if (texObj !== this._curTex) {
      gl.bindTexture(gl.TEXTURE_2D, texObj);
      this._curTex = texObj;
    }
    if (texName && this.textures[texName]) mode = ov.mode != null ? ov.mode : m.mode;
    else mode = 0;
    gl.uniform4f(u.mat, mode, ov.spec != null ? ov.spec : m.spec, m.shin, ov.alpha != null ? ov.alpha : m.alpha);
    const fd = m.fade || DETAIL_FADE;
    gl.uniform2f(u.fade, fd[0], fd[1]);
    gl.uniform1f(u.wave, m.wave || 0);
    gl.uniform1f(u.wet, (m.wet || 0) * (this.wetAmt || 0));
    gl.uniform1f(u.cut, ov.cut || 0);
    gl.uniform1f(u.emi, (m.emiBoost || 1) * (ov.emi == null ? 1 : ov.emi));
    if (m.blend) {
      if (!this._curBlend) { gl.enable(gl.BLEND); this._curBlend = true; }
      const funcKey = m.additive ? 1 : 0;
      if (this._curBlendFunc !== funcKey) {
        gl.blendFunc(gl.SRC_ALPHA, m.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        this._curBlendFunc = funcKey;
      }
      if (this._curDepthMask !== false) { gl.depthMask(false); this._curDepthMask = false; }
    } else {
      if (this._curBlend) { gl.disable(gl.BLEND); this._curBlend = false; this._curBlendFunc = -1; }
      if (this._curDepthMask !== true) { gl.depthMask(true); this._curDepthMask = true; }
    }
    const cullOff = !!m.cullOff;
    if (this._curCullOff !== cullOff) {
      if (cullOff) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      this._curCullOff = cullOff;
    }
    gl.drawElementsInstanced ? gl.drawElementsInstanced(gl.TRIANGLES, b.count, b.type, 0, nInst || 1)
                             : gl.drawElements(gl.TRIANGLES, b.count, b.type, 0);
    this.stats.draws++; this.stats.tris += b.count / 3 * (nInst || 1);
  }

  end(post) {
    const gl = this.gl;
    if (this.vaoExt) this.vaoExt.bindVertexArrayOES(null);
    const uu = this.u || {};
    for (const k of [uu.aN, uu.aU, uu.aC]) if (k > 0) gl.disableVertexAttribArray(k);
    gl.depthMask(true); gl.disable(gl.BLEND);
    this._curBlend = false; this._curBlendFunc = -1; this._curDepthMask = true; this._curTex = null; this._curM = null;
    /* 帧的 GPU 工作到这里全部提交完了（后期链在 end() 的后半段，也在同一帧里）。
       必须在 post 的早退**之前**收尾：`quality==='low'` 那条 return 会跳过 endQuery，
       下一次 beginQuery 就 INVALID_OPERATION —— 判"什么时候该降档"的那把尺从此报废。 */
    if (this.qExt && this._qOpen) { gl.endQuery(this.qExt.TIME_ELAPSED_EXT); this._qOpen = false; }
    const p = post || this.env && this.env.post || {};
    if (!this.post || this.quality === 'low' || !this.sceneFbo) return;
    /* 后期链开自己的表：在 post 早退**之后**（没有后期工作就不开空查询），
       在 composite 提交完之后收尾 —— 与世界的表严格顺序，不嵌套。 */
    if (this.qExt && !this._qPostOpen) {
      const qp = gl.createQuery();
      if (qp) { this._qPost = qp; gl.beginQuery(this.qExt.TIME_ELAPSED_EXT, qp); this._qPostOpen = true; }
    }

    // ---- bright pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.pgBright);
    this._quadBind(this.pgBright, 'aP');
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.tex);
    gl.uniform1i(gl.getUniformLocation(this.pgBright, 'uSrc'), 0);
    gl.uniform2f(gl.getUniformLocation(this.pgBright, 'uTexel'), 1 / this.w, 1 / this.h);
    gl.uniform1f(gl.getUniformLocation(this.pgBright, 'uThresh'), p.bloomThresh == null ? 0.62 : p.bloomThresh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- 两次方向模糊
    gl.useProgram(this.pgBlur); this._quadBind(this.pgBlur, 'aP');
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fb);
      gl.viewport(0, 0, this.bloomB.w, this.bloomB.h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
      gl.uniform1i(gl.getUniformLocation(this.pgBlur, 'uSrc'), 0);
      gl.uniform2f(gl.getUniformLocation(this.pgBlur, 'uDir'), (1 + i) / this.bloomA.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
      gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
      gl.uniform1i(gl.getUniformLocation(this.pgBlur, 'uSrc'), 0);
      gl.uniform2f(gl.getUniformLocation(this.pgBlur, 'uDir'), 0, (1 + i) / this.bloomA.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pgComp); this._quadBind(this.pgComp, 'aP');
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.tex);
    gl.uniform1i(gl.getUniformLocation(this.pgComp, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
    gl.uniform1i(gl.getUniformLocation(this.pgComp, 'uBloom'), 1);
    gl.uniform2f(gl.getUniformLocation(this.pgComp, 'uRes'), this.w, this.h);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uTime'), this.time * 60);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uBloomAmt'), p.bloom == null ? 0.62 : p.bloom);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uExposure'), p.exposure == null ? 1.06 : p.exposure);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uVig'), p.vignette == null ? 0.34 : p.vignette);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uGrain'), p.grain == null ? 0.028 : p.grain);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uAberr'), p.aberr == null ? 0.0045 : p.aberr);
    /* 放大倍数的平方根决定补多少：浏览器吃掉的是线性细节，而 _up 是面积比。
       原生档（_up=1）给 0 —— 那时不该动任何一个像素。 */
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uSharp'),
      this._up > 1.02 ? Math.min(0.9, (Math.sqrt(this._up) - 1) * 1.3) : 0);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uFade'), p.fade == null ? 1 : p.fade);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uDesat'), p.desat == null ? 0 : p.desat);
    /* 雨丝（D4）：uRain 全局雨量（0..1）；uRainCab 只在驾驶室机位给 1 ——
       挡风玻璃水珠层只该出现在驾驶室视角。 */
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uRain'), this.rainAmt || 0);
    gl.uniform1f(gl.getUniformLocation(this.pgComp, 'uRainCab'), (this.cabView && this.rainAmt) || 0);
    gl.uniform3f(gl.getUniformLocation(this.pgComp, 'uTint'), p.tint ? p.tint[0] : 1, p.tint ? p.tint[1] : 1, p.tint ? p.tint[2] : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.qExt && this._qPostOpen) { gl.endQuery(this.qExt.TIME_ELAPSED_EXT); this._qPostOpen = false; }
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
  }
  _quadBind(pg, name) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(pg, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }
  /** 全屏覆盖色（转场淡入淡出用） */
  fade(alpha) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, alpha); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
  }
}

SH.Renderer = Renderer;

/* --------------------------------------------------------- 环境预设（时刻） */
SH.ENVS = {
  dawn:    { sunDir: [-0.4, 0.16, 0.9], sunCol: [1.00, 0.72, 0.52], skyCol: [0.44, 0.50, 0.62], gndCol: [0.16, 0.15, 0.16], skyHorizon: [0.86, 0.62, 0.52], skyZenith: [0.20, 0.28, 0.46], fogCol: [0.52, 0.48, 0.52], fog2: [0.30, 0.32, 0.42], fogDensity: 0.0022, fogHeightFalloff: 0.03, emiBoost: 1.25, night: 0.22 },
  day:     { sunDir: [-0.35, 0.78, 0.5], sunCol: [1.05, 1.00, 0.92], skyCol: [0.52, 0.62, 0.76], gndCol: [0.20, 0.20, 0.19], skyHorizon: [0.72, 0.80, 0.88], skyZenith: [0.16, 0.36, 0.70], fogCol: [0.62, 0.70, 0.78], fog2: [0.44, 0.52, 0.60], fogDensity: 0.0016, fogHeightFalloff: 0.022, emiBoost: 1.0, night: 0.0 },
  /* 黄昏蓝调时刻：默认。天空从橙红地平线过渡到深蓝，城市灯已亮但天未黑——最上镜 */
  dusk:    { sunDir: [-0.72, 0.11, 0.68], sunCol: [1.15, 0.62, 0.34], skyCol: [0.46, 0.50, 0.66], gndCol: [0.20, 0.18, 0.20], skyHorizon: [0.94, 0.48, 0.27], skyZenith: [0.07, 0.11, 0.28], fogCol: [0.44, 0.34, 0.38], fog2: [0.15, 0.17, 0.30], haze: [0.18, 0.08, 0.02], fogDensity: 0.0019, fogHeightFalloff: 0.026, emiBoost: 1.55, night: 0.60 },
  night:   { sunDir: [-0.3, 0.42, 0.85], sunCol: [0.16, 0.20, 0.34], skyCol: [0.075, 0.095, 0.16], gndCol: [0.035, 0.04, 0.06], skyHorizon: [0.13, 0.14, 0.24], skyZenith: [0.012, 0.02, 0.05], fogCol: [0.085, 0.10, 0.155], fog2: [0.05, 0.06, 0.10], haze: [0.14, 0.08, 0.03], fogDensity: 0.0026, fogHeightFalloff: 0.03, emiBoost: 2.1, night: 1.0 },
  /* 隧道：环境光压到很低，让灯带成为主导——这样才有"地下"的明暗节奏，
     而不是一根均匀发光的灰水泥管。 */
  tunnel:  { sunDir: [0, 1, 0], sunCol: [0.055, 0.06, 0.075], skyCol: [0.085, 0.098, 0.125], gndCol: [0.032, 0.036, 0.046], skyHorizon: [0.03, 0.045, 0.06], skyZenith: [0.01, 0.015, 0.03], fogCol: [0.030, 0.042, 0.055], fog2: [0.016, 0.024, 0.033], fogDensity: 0.0118, fogHeightFalloff: 0.10, emiBoost: 2.05, night: 0.9 },
};

/* ------------------------------------------------- 天光：钟点 → 环境（单点）
 *
 * 为什么要这一层：在此之前 `App.envFor()` 恒取 `ENVS.dusk`，于是**不管玩家
 * 选几点钟，外面永远是黄昏** —— 上面四档 dawn/day/night 写了却从来没人调用，
 * 是四个死配置。"时间是死的"里最刺眼的一条。
 *
 * 锚点取上海的天光节律（春秋分前后量级）：0 点夜 → 5 点拂晓 → 7:30 白天 →
 * 17 点白天 → 19 点黄昏 → 21 点夜 → 24 点夜。四档之间**逐通道线性插值**，
 * 所以 6 点钟是"拂晓与白天之间"的天色，而不是从 dawn 跳到 day。
 *
 * 口径写在注释里、由 `test-env.js` 钉住三件事：① 深夜的太阳亮度必须显著低于
 * 正午；② 同一钟点重复调用结果一致（确定性）；③ 一天 24 小时首尾相接
 * （23:59 与 00:01 的颜色几乎相等）——第三条挡的是"锚点表被改出断层"。
 * 抽成单点的意义与 `SH.timetable`/`SH.nextTrain` 同源：**时刻只有一个真值**。
 */
/* 锚点（钟点 → 预设）。夜必须**覆盖** 20:30~04:30，而不是从 21:00 直接线性爬向
   05:00 的拂晓 —— 那样凌晨 2 点会被插值成"四成拂晓"，天色发灰。
   这是第一版实测出来的（2:00 的太阳亮度 0.43，是正午的 43%，而它该是最深的夜）。 */
SH.ENV_ANCHORS = [
  [0, 'night'], [4.5, 'night'], [6.5, 'dawn'], [8, 'day'],
  [16.5, 'day'], [18.5, 'dusk'], [20.5, 'night'], [24, 'night'],
];
/** 某钟点的环境。缺失的通道按 0 处理（只有 dusk/night 带 haze，dawn/day 不带，
 *  不补零会得到 NaN 雾色，而 NaN 会让整段场景套上浓雾——第 51 条那一族）。 */
SH.envAt = function (hour) {
  const h = ((hour % 24) + 24) % 24;
  const A = SH.ENV_ANCHORS;
  let i = 0;
  while (i < A.length - 2 && h > A[i + 1][0]) i++;
  const a = A[i], b = A[i + 1];
  const t = b[0] === a[0] ? 0 : SH.clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
  const E0 = SH.ENVS[a[1]], E1 = SH.ENVS[b[1]];
  const v3 = k => { const p = E0[k] || [0, 0, 0], q = E1[k] || [0, 0, 0]; return [0, 1, 2].map(j => p[j] * (1 - t) + q[j] * t); };
  const sc = k => (E0[k] || 0) * (1 - t) + (E1[k] || 0) * t;
  return {
    sunDir: v3('sunDir'), sunCol: v3('sunCol'), skyCol: v3('skyCol'), gndCol: v3('gndCol'),
    skyHorizon: v3('skyHorizon'), skyZenith: v3('skyZenith'),
    fogCol: v3('fogCol'), fog2: v3('fog2'), haze: v3('haze'),
    fogDensity: sc('fogDensity'), fogHeightFalloff: sc('fogHeightFalloff'),
    emiBoost: sc('emiBoost'), night: sc('night'),
    /* 当前区间与区间内比例：HUD 与判据直接读，不必各自再推一遍 */
    from: a[1], to: b[1], t: t, hour: h,
  };
};

/* --------------------------------------------------------- 雨天对天光的调制（单点）
 *
 * 雨不是"把天色调暗一点"：雨云天的太阳是**漫射光**——没有方向性的亮斑，
 * 整个天穹是一盏均匀的灰灯；湿的地面把反照率压暗、把镜面反射抬亮；
 * 雨雾让远处先糊掉。全部写在这里，由 test-env 的雨天判据钉住。
 * 返回**新对象**，不改传入的 T —— envFor 还要拿原值做插值基准。
 */
SH.RAIN = {
  sunK: 0.24,          // 太阳亮度倍率（漫射化）
  sunSat: 0.30,        // 太阳去饱和比例（雨云下没有橙色夕照）
  skyDesat: 0.62,      // 天空向灰收的比例
  skyTint: [1.02, 1.06, 1.14],   // 灰不等于无色：雨天的天光偏冷
  skyK: 0.84,          // 阴天的天空亮度：灰不是"同样亮的另一种颜色"，
                       // 乌云天的漫射光整体比晴天的半球光暗一档（实拍 173→~150）
  fogMul: 1.85,        // 雨雾（能见度显著收窄）
  emiMul: 1.18,        // 灰天里人工灯更"亮出来"
  gndMul: 0.80,        // 湿地面更暗（干土吸光，湿土镜面）
};
SH.envRainy = function (T) {
  const R = SH.RAIN;
  const grey = (c, k) => {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return [0, 1, 2].map(j => (c[j] * (1 - k) + l * R.skyTint[j] * k));
  };
  const sunL = 0.2126 * T.sunCol[0] + 0.7152 * T.sunCol[1] + 0.0722 * T.sunCol[2];
  const sunG = [sunL, sunL * 1.02, sunL * 1.08];       // 漫射日光几乎是白的
  const k = v => v * R.skyK;
  return Object.assign({}, T, {
    sunCol: T.sunCol.map((v, j) => (v * (1 - R.sunSat) + sunG[j] * R.sunSat) * R.sunK),
    skyCol: grey(T.skyCol, R.skyDesat).map(k),
    skyHorizon: grey(T.skyHorizon, R.skyDesat).map(k),
    skyZenith: grey(T.skyZenith, R.skyDesat).map(k),
    fogCol: grey(T.fogCol, R.skyDesat * 0.7).map(k),
    fog2: grey(T.fog2, R.skyDesat * 0.7).map(k),
    gndCol: T.gndCol.map(v => v * R.gndMul),
    fogDensity: T.fogDensity * R.fogMul,
    emiBoost: T.emiBoost * R.emiMul,
    rainy: true,
  });
};

})(typeof window !== 'undefined' ? window : globalThis);
