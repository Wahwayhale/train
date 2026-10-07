# WebGPU 后端交接书（C 轨）

> 致接手 WebGPU 轨道的模型/工程师。本文写于 2026-10-07，基线 commit `8ea1c02`（tag `baseline-pre-webgpu`）。
> 文中行号均为该基线的行号，master 会随 A 轨道改动漂移——**行号过期时以 `git diff baseline-pre-webgpu` 为准，以本文的"事实"为准，不要盲信行号**。
> 本文自包含，但不是全部：项目还有一份总的交接书 `HANDOFF.md`（尤其 §2 架构地图、§5 踩过的坑、§9 用户偏好、§10 施工顺序），以及总视觉方案 `视觉升级方案.md`。**先读完这三份再动代码。**

---

## 0. 你的任务一句话

为本项目新增一个 WebGPU 渲染后端，与 WebGL2 后端并存，运行时按能力自动选择（WebGPU → WebGL2 回退），全程不破坏离线测试套件。项目已决定丢弃 WebGL1（覆盖率损失知情接受：iOS 15+ / 2017+ Android Chrome 一档，约 97%）。**WebGPU 在 iOS 上要 Safari 26+，所以 WebGL2 路径不是过渡品，是手机端的永久地板——你的后端必须是增量可选件，绝不是替换。**

另一条轨道（A 轨，由另一位工程师/模型负责）正在做：WebGL1 分支删除、shader 升 ES 3.00、原生 MSAA、法线贴图接线（详见 §9 协调规则）。

## 1. 项目速览

- 上海地铁驾驶模拟器：零依赖、无构建步骤、无模块系统的手写 WebGL。20 条线 512 站。
- 代码全在 `window.SH` 命名空间上串联，**index.html 的 script 加载顺序即依赖顺序**（core → mesh → renderer → textures → align → landmark → world → bve → train → physics → pax → traffic → street → audio → data/shanghai → game，见 index.html:174-189）。你新增脚本就插进这个顺序里，不许引入 import/export/打包器。
- 运行：`node serve.js` → http://127.0.0.1:8787（或直接双击 index.html）。Windows 10，cmd 默认 GBK——**任何 Node 脚本要打印中文，必须先 `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')`**（或等效办法），这是本机血的教训。
- 项目哲学：零 npm 依赖、纯手写。你的 WGSL 和 GLSL 一样放 JS 模板字符串里（参照 renderer.js 顶部的 `SCENE_VS` 等），**两份 shader 语言从此长期共存、人工维护镜像，不做代码生成/宏统一**——没有构建步骤，手写镜像就是本项目惯例。
- 静态世界离线烘焙成按材质分桶的大 mesh，运行时整窗 ~2km 静态世界只要 12-19 次 draw call；街面橱窗 ≤330、驾驶室 ≤560 是 draw call 红线（HANDOFF §5.5）。三角形 0.24-0.62M/帧很便宜，**瓶颈永远在批次不在顶点**。

## 2. 工程纪律（违反 = 白干，这条比代码本身重要）

1. **每条改动必须配一条"能报红的判据"+ 一个"真改源码的负控"**。判据进 test-*.js（离线跑、无浏览器无 GPU），负控注册进 `dev/negctl.js`（变异框架，现有 193 条变异；条数以实跑打印为准）。只改画面不进判据的改动，本项目不认。
2. **离线测试套件不碰真 GL**：`stub-dom.js` 把 DOM/Canvas 2D 全部打桩，判据全在几何/数值层。全套跑 `node runall.js`；单跑 `node test-*.js`。**你的 WebGPU 工作不得让任何一个现有测试变红**——renderer 换后端，测试桩根本感知不到，这是这个架构能成立的地基。你自己新增的判据走 `stub-webgpu.js` 方案（§7）。
3. **git 纪律**：仓库 2026-10-07 刚建（升级清单 0.1 拖欠项，刚清账）。你在 `webgpu` 分支上工作，从 master 分出，**每当 A 轨道在 master 落一个里程碑就 rebase 一次**。一个逻辑单元一个 commit，中文 commit message，写清满足哪条判据。绝不提交 `.negctl-bak`、`shots/`（已在 .gitignore）。
4. 负控有前科故事：曾有负控备份被 SIGKILL 打断留在源码里，negctl 启动扫描把它当残留变异。改完源码必须确认没有 `*.negctl-bak` / `*.negtmp.js` 残留。

## 3. 当前渲染架构（GL 侧事实，全部核实于基线）

### 3.1 渲染器与后端边界

- `SH.Renderer`（src/renderer.js:756 起，全文 1506 行）：构造时 `getContext('webgl2')` 优先，回退 `webgl`+扩展（**A 轨道正在删掉回退分支**）。`this.api` 记录 'WebGL2'/'WebGL1'，HUD 上有显示（game.js:2664）。
- GL 调用几乎全部封在 renderer.js 里。game.js 只有 **两处越界**：`SH.textures.SignAtlas.bestSize(this.r.gl)`（game.js:1791、2231）——A 轨道会把它包成能力查询方法。**你的 WebGPU 后端绝不能暴露 `.gl`**。
- textures.js 只用 Canvas 2D 生成贴图，上传走 renderer 的注册表，与 GL 无关（后端无关，你复用它的产物）。

### 3.2 顶点格式（WGSL 顶点状态的直接输入）

**分属性独立缓冲，不交错**（renderer.js:889-932 `upload()`）：

| 属性 | 缓冲 | 格式 | 说明 |
|---|---|---|---|
| aPos | pb | float32×3 | 位置 |
| aNrm | nb | float32×3 | 法线 |
| aUv | ub | float32×2 | UV |
| aCol | cb | uint8×4 归一化 | rgb=顶点色，a=**自发光强度**（0..2 折半存，shader 里 ×2 还原——见 mesh.js 与 SCENE_FS 的加算项） |
| 索引 | ib | uint16 | mesh 侧有分片保证不超 16 位（test-chunk.js 盯着），**不要动分片，直接用 uint16** |
| aI0-aI3 | 实例缓冲 | float32×4 ×4 | 列主序实例矩阵（drawInstanced 用，divisor 1） |
| aIT | 实例缓冲 | float32×4 | rgb=实例涂装色，a=是否吃色（**a>0.5 才乘，默认值陷阱见 shader 注释**） |

实例矩阵在**顶点里做基向量线性组合**（`p = aI0.xyz*x + aI1.xyz*y + aI2.xyz*z + aI3.xyz`），不是点乘——写成 dot 等于旋转取逆，直线正对镜头看不出、一弯道车就歪，**这是真踩过的坑**（SCENE_VS 注释 renderer.js:55-60，判据 dev/inst-check.js）。WGSL 移植时逐字保留这个数学。

### 3.3 材质与批次

- `MATERIALS` 表（renderer.js:469-566，约 35 条）：`tex`（贴图名）/`mode`（0 无贴图、1 细节乘算、2 整张替换反照率、3 BVE 真乘）/`spec`/`shin`（Blinn-Phong 双标量）/`alpha`/`wet`/`fade[起,止]`（细节贴图按米退化）/`blend`/`additive`/`cullOff`/`emiBoost`/`tint`（该材质吃不吃实例涂装）/`wave`（水面）。
- `upload(meshes, tag)` 返回批次句柄数组，字段：`mat, tag, tint, pb/nb/ub/cb/ib, count, bbox`。`this.batches` 是**公共数组**——game.js:2827 直接遍历它做逐批次视锥剔除（`b.bbox` + `boxInFrustum`）。`dropTag(tag)` 按标签整组销毁（world/train/crowd/psd/ptd 生命周期全靠它）。
- `draw(b, M, ov)`：M=模型矩阵；ov 覆盖项 `{tex, mode, spec, alpha, emi, cut}`。
- `drawInstanced(b, mats, ov, tints)`：一份几何 × N 实例 = 1 draw call（AI 车流/街面车）。**game.js 用特性探测 `if (this.r.drawInstanced && ...)`**（game.js:1089, 1117）——后端没有这个方法就自动走逐实例 draw 回退。**你的后端可以分阶段：先不实现 drawInstanced（游戏照样跑），后补。** 注意实例化期间 uM 必须是单位阵。

### 3.4 着色器（要移植的 ~410 行 GLSL）

六个：`SCENE_VS`（renderer.js:50）、`SCENE_FS`（:91，最重的一块 ~190 行：半球环境光+地平线暖光带、单太阳 Blinn-Phong+Fresnel 假反射、双层雾、细节退化、湿面、mode 0-3 贴图数学、顶点烘焙人工光加算 vC.a、屏幕导数 TBN 法线贴图分支——**分支里 uNrm/uTexN 现在是死代码，A 轨道正在接线，你的 WGSL 必须移植完整分支并支持 uNrm>0**）、`SKY_FS`（:280，程序化天空，44 行，自包含）、`FS_QUAD_VS`（:324）、`BRIGHT_FS`（:326）、`BLUR_FS`（:339）、`COMPOSITE_FS`（:349，色散/unsharp/bloom/曝光/ACES/色调/屏幕空间雨/暗角/去色/颗粒/fade）。

### 3.5 帧结构

`begin(cam, env, dt)`（:1130）→ 若干 `draw()`/`drawInstanced()` → `end(post)`（:1309）。场景渲进离屏 FBO（RGBA8+DEPTH16），然后 bright pass（阈值 0.62）→ 1/4 分辨率双向高斯模糊 ×2 迭代 → composite 全屏三角。渲染器内部状态：`rainAmt`（game.js:2698 写入）、`cabView`、`wetAmt`、`fade()`。

**GPU 计时已存在**：`gpuMs`/`gpuPostMs` 通过 timer query 轮询（`_pollQ/_pollGpu/_pollGpuPost` renderer.js:1094-1129），HUD 显示"GPU x.xms+后期"（game.js:2660）。DRS 自动降档（`SH.drsNew/drsStep`，game.js:2423, 2670-2677）吃这个数。**你的后端必须把这两个字段填上真值**（WebGPU `timestamp-query` 特性，需门控申请），否则 DRS 在 WebGPU 路径下失明。

### 3.6 纹理注册表

`texFromImage(name, url, repeat)`（异步，BVE 实拍贴图用）、`texFromCanvas(name, canvas, repeat, mipmap)`（同步，站牌图集/站台屏/驾驶室屏/圆表用，动态纹理压 mipmap）。`this.textures[name]` 存 GL 纹理对象，`_drawBatch` 里材质贴图缺失时回落 white。站牌图集 SignAtlas 2048-4096 动态更新（`sign.dirty → texFromCanvas` game.js:763）。**你的后端按同签名注册自己的纹理对象即可**，图集内容复用 canvas 产物。

## 4. 冻结的后端接口（实现这个契约，别的都是实现细节）

game.js 对渲染器的全部依赖（这是两轨不冲突的关键，A 轨道改 renderer.js 内部时也保证这个面不动）：

构造与属性：`new SH.Renderer(canvas)`（game.js:1723，**后端选择开关就装在这附近，见 §9**）；可读属性 `api, quality, resTier, resAuto, _effTier, _native, gpuMs, gpuPostMs, batches`；可写属性 `rainAmt, cabView`；特性探测 `drawInstanced`（方法存在性）。

方法：`upload(meshes, tag) → batch[]`、`dropTag(tag)`、`texFromImage`、`texFromCanvas`、`draw(b, M, ov)`、`drawInstanced(b, mats, ov, tints)`（可选）、`begin(cam, env, dt)`、`end(post)`、`fade(a)`、`setQuality(q)`、`setRes(t)`、`setResAuto(on)`、`setResEff(t)`、`resize()`、`boxInFrustum(min, max, margin)`（CPU 侧几何，与后端无关但挂在渲染器上）。

`cam` 形状：`{eye, ...}`；`env` 形状：`{sunDir, sunCol, skyCol, skyHorizon, gndCol, fogCol, fog2, fogDensity, fogHeightFalloff, emiBoost}`（见 begin() :1172-1183 逐项）。`post` 参数对象形状**自己读 end(:1309) 确认**，不要猜。

## 5. 施工计划（每阶段有独立验收，完成一阶段就 commit + rebase master）

**C0 脚手架 + 天空（证明管线通）**：设备初始化（requestAdapter→requestDevice，error scope + uncapturederror + device.lost → fatal() 模式沿用 renderer.js 的 fatal）、canvas 配置（`getPreferredCanvasFormat()`，bgra8unorm）、后端选择器（`navigator.gpu` 探测 → 失败静默回退 WebGL2 实例）、把 `SKY_FS` 移植成 WGSL 画全屏三角。
验收：支持的机器上 HUD 显示 WebGPU、天空与 GL 路径目视一致、`node runall.js` 全绿、chrome://gpu 无 uncaptured error。

**C1 场景 pass（大头，可再切两刀）**：C1a 先跑 mode 0 无贴图材质（顶点管线 + 光照块 + 雾 + 烘焙人工光）；C1b 补贴图四模式 + 纹理注册表 + 站牌图集动态更新 + wet/fade/cut/emissiveBoost。
验收：驾驶室/外景/站台五种视角全部正常、静态世界 12-19 个 render pass 内画完、`test-shot.js`（软件光栅化器，后端无关）全绿、真机截图对比 GL 路径。

**C2 后处理链 parity**：bright/blur×2/composite 全家 + fade + 雨丝/暗角/颗粒。色散与 unsharp 的默认参数与 GL 版一致。
验收：同一确定性种子（core.js 确定性随机 + 固定时间步）下双后端同帧截图 diff 在容差内（工具见 §7 末尾）；GPU 计时字段有真值。

**C3 实例化 + 增值**：drawInstanced（aI0-aI3/aIT 那套数学逐字移植）、timestamp-query 门控接入 DRS、MSAA 4x（multisampled texture + resolve，**这是 WebGPU 路径替代 FXAA 的正道**）、性能对账（同机 WebGPU vs WebGL2 帧耗时差 ≤20%）。

## 6. WebGPU 坑清单（具体到本项目，逐条都要有判据盯）

1. **NDC z 范围 0..1**：CPU 侧投影矩阵是共享的（core.js）。别改矩阵——在 WGSL 顶点阶段输出后做 `clip.z = clip.z*0.5 + clip.w*0.5`，一份矩阵两后端共用。判据：静态源检查这个模式存在；负控删掉它必须红。
2. **Y 方向**：WebGPU NDC 的 y 与 GL 同向，但帧缓冲/纹理坐标原点在左上、canvas 是 bgra8unorm。采样离屏场景纹理做后处理时翻转方向与 GL 相反——**别推理，用 C0 的天空 pass 实测定方向**。gl_FragCoord → `@builtin(position)`，原点差异影响屏幕空间效果（雨丝方向、驾驶室水珠位置），逐个核对。
3. **uniform → uniform buffer**：GL 是 ~25 个散装 uniform/批次；WebGPU 必须打包。建议：一个帧级 UBO（相机/环境/雾/时间，每帧写一次）+ 一个批次级 UBO 环形缓冲（mat/uvScale/fade/wet/emi/tint/cut，256 对齐 dynamic offset，按 560 draw 上限开槽）。**WGSL 的 vec3 在 uniform buffer 里按 16 字节对齐**——这是移植 SCENE_FS 时最容易静默错位的坑，判据里写死布局断言。
4. **管线缓存**：按状态簇（blend 正常/加法/cullOff/透明 × 实例化开/关 × 法线开/关）预建十几条 pipeline，键值缓存永不在帧内 createRenderPipeline。判据：桩记录整个帧循环里 createRenderPipeline 调用数 ≤ 簇数；负控：改成逐 draw 建管线必须红。
5. **纹理与绑定组**：每材质一张贴图 → 每贴图一个 bind group，按贴图名缓存；场景 UBO/纹理组分 group。Dynamic textures（站台屏 512×192 每帧重传）走 queue.writeTexture，保持"动态纹理压 mipmap"的既有行为。
6. **sRGB 口径**：现有链路是 gamma 空间全程直算、composite 里手动 pow2.2 进 ACES。**保持逐字节同口径，不许"顺手修正"成 srgb canvas 格式**——那会改变整个画面观感。改口径需要 A/B 截图证据单独立项。
7. **命令录制模型**：GL 后端是立即模式，draw() 当场生效；WebGPU 是录制模式——你的 draw() 内部记列表，end() 里建 encoder、录场景 pass + 后处理 pass、一次 submit。这个重构必须完全藏在接口后面，game.js 的调用顺序一个字不改。
8. **降级与容错**：requestAdapter 失败/设备丢失 → 无声回退或 fatal 覆盖层（沿用 renderer.js 的 fatal() 文案风格）。navigator.gpu 不存在是**正常路径**不是错误（iOS 26 以下全走这条）。判据：桩掉 navigator.gpu 时选择器必须返回 WebGL2 实例。
9. **timestamp-query 是可选特性**：adapter.features 里没有就跳过，gpuMs 填 0（game.js 已有 `gpuMs > 0` 的显示条件，天然兼容）。周期是纳秒，换算毫秒。
10. **resize/DRS**：resize() 时 reconfigure canvas；`_native/_effTier/setResEff` 语义与 GL 版一致，DRS 逻辑在 game.js/core.js 里是共享的，你只需让字段行为同构。

## 7. 离线测试策略（本项目测试哲学的延续）

真 GPU 的行为没法在 Node 里离线验证，但**结构和契约可以**。做 `stub-webgpu.js`（学 stub-dom.js 的思路）：假 GPUDevice/Queue/CommandEncoder/Pipeline，记录全部调用。然后 `test-gpu.js` 断言：

- 每个上传批次的顶点缓冲字节数 = 顶点数×12/12/8/4，索引 = count×2（负控：错 stride 必红）；
- 一帧内 createRenderPipeline ≤ 管线簇数、bind group 按贴图缓存无重复创建；
- WGSL 静态 lint：源码里不得残留 `texture2D(`、`varying`、`gl_`；每个 `@group(@binding)` 在布局里有对应项；
- z 重映射模式存在（§6.1）；uniform 环形缓冲在 560 draw 压力下不越界；
- 后端选择：无 navigator.gpu → WebGL2；有 → WebGPU。

真 GPU 视觉验证：`dev/shot.js` / `dev/uishot.js`（既有截图工具，先读它们怎么用）出 WebGPU/GL 双后端同种子截图，写 `dev/gpudiff.js` 做容差 diff。**每阶段的"目视一致"都要落到这个工具上，不许停留在"我看着差不多"。**

## 8. 不许碰的东西（避免与 A/B 轨冲突的硬边界）

**只许新建**：`src/renderer-webgpu.js`、`src/gpu-wgsl.js`（或并入前者）、`stub-webgpu.js`、`test-gpu.js`、`dev/gpudiff.js`。
**只许小改**：index.html（renderer.js 之后加 2 行 script）、game.js（仅 :1723 附近的渲染器构造点，包装成 `createRenderer(canvas)` 做后端选择，改动 ≤15 行）、runall.js（注册 test-gpu）、dev/negctl.js（注册你的负控）。
**禁止改动**：src/renderer.js（A 轨道整个 Phase A/B 期间独占——它会大改）、textures.js、mesh.js、world.js、train.js、physics.js。你需要共享的工具函数（矩阵、颜色）用 core.js（稳定），要往 core.js 加东西就在 commit message 里写明让 A 轨道知情。

冲突无法避免时（比如你发现接口本身有缺口）：在分支上开一个 `接口缺口` 主题的 commit 只改注释/文档说明诉求，**不要直接改 renderer.js**，让 A 轨道来落。

## 9. 双轨协调流程

- master = A 轨道（WebGL2 迁移 → 视觉方案第 1 批），`webgpu` 分支 = 你。
- A 轨道每落一个里程碑（预期：Phase A 删 GL1 + shader ES3.00、Phase B 法线贴图接线等四条），你 rebase 一次。**renderer.js 在 Phase A 会大改，这正是你的代码不许 import 它内部符号的原因**——你只依赖 §4 冻结接口 + core.js + mesh 数据格式。
- rebase 冲突预期高发点：index.html 的 script 列表（A 轨道可能也在加测试脚本行）、game.js 构造点。都小，手工解。
- 合入 master 的门槛：`node runall.js` 全绿 + `node dev/negctl.js` 全绿（含你新增的负控）+ gpudiff 容差内 + 真机（Chrome Windows）跑完一站零报错。

## 10. 已定决策（用户拍板过，不要重新谈）

- 丢弃 WebGL1；WebGL2 是地板；WebGPU 双后端**立即并行开工**（不是"以后再说"）。
- 视觉基准：桌面开满 + 手机靠 DRS/质量旋钮降档兜底。
- 素材路线：允许 CC0 照片贴图（ambientCG/PolyHaven，1 号线 BVE 实拍贴图已有先例），懒加载，首屏保持零依赖。这是视觉方案第 2 批的事，与 C 轨无直接冲突。
- 零构建、零 npm、手写镜像两份 shader——用户是零预算个人开发者，偏好自己动手、成本优先、风险知情后决策果断（详见 HANDOFF §9）。
- 性价比纪律：先光影后建模。"粗糙感"根因是光影层欠账（法线贴图死代码/无 MSAA/零阴影/假反射/零倒角），不是几何量不足——这是体检结论，别走回头路去堆建模。

## 11. 必读顺序（动手前）

1. 本文 → 2. `视觉升级方案.md`（总方案，知道 C 轨在全局的位置）→ 3. `HANDOFF.md` §1/§2/§5/§9/§10 → 4. `src/renderer.js` 全文精读 → 5. `src/game.js` 的 640-770（上传生命周期）、1089-1170（实例化）、1723 构造点、2760-2900（帧绘制循环）→ 6. `src/mesh.js`（mesh 数据格式与分片）→ 7. `dev/negctl.js` 头部（负控怎么注册）→ 8. 跑一遍 `node runall.js` 确认起点全绿（HANDOFF §6 的验证清单）。

祝顺利。这个项目的规矩看着重，但它让一个 1.1MB 源码的项目在没有任何框架的前提下维持了 193 个负控变异的可证伪性——请延续它。
