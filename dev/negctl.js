/* 负控（negative control）：把每条红线对应的缺陷**真的注入一遍**，确认测试会报红。
 *
 * 为什么要有这个文件：上一轮翻出来的最贵缺陷是"空指标"——平稳评分惩罚阈值写在
 * 0.85 m/s³，而限幅器天花板是 0.75/1.05，那一项永远不触发，两种开法都拿 99 分。
 * 一个永远不会变绿的测试和一个永远不会变红的测试一样危险，而只有把缺陷注回去
 * 才知道这条红线到底在不在测量。
 *
 * 做法：复制 test-drive.js 到项目根目录（require 的 './src/…' 是相对**文件**解析的，
 * 放别处会找不到），只做 ASCII 字符串替换，用 utf8 读写；绝不用 heredoc 生成文件，
 * Windows 控制台是 GBK，中文注释会被写坏。跑完删掉副本。
 * **同一族的事故在 PowerShell 侧又发生了一次**（2026-10-02）：`(Get-Content -Raw)
 * .Replace() | Set-Content` 在 PS 5.1 下按系统 GBK 读、按 UTF-8 写，中文注释当场
 * 变成乱码，src/world.js 被毁到只能从备份重建。**任何"改源文件"的命令都不许走
 * 控制台重定向/Set-Content** —— 要改就改本文件（它有逐字节校验），或者用
 * 编辑工具。本条规矩是用一次真实事故换来的。
 * 其中 physband 那一例必须临时改 src/physics.js 本体（改副本没法验证"字面量出界"
 * 这条静态判据），所以有备份 + finally 还原 + 逐字节校验。 */
const fs = require('fs');
const cp = require('child_process');

const TMP = './test-drive.negtmp.js';
const orig = fs.readFileSync('./test-drive.js', 'utf8');
const INJECT = `const SH = global.SH;`;
const SRCLINE = `const src = require('fs').readFileSync('./src/game.js', 'utf8');`;

const muts = [
  {
    name: 'shape', why: '删掉 ATO 的需求整形（notch 直接跟着原始决策跳）',
    expect: ['需求整形'],
    patch: t => t.replace(INJECT, INJECT + `
if (process.env.NEG === 'shape') SH.physics.ATO.prototype._shape = function (dt, w) { return w; };`),
  },
  {
    name: 'jerkwt', why: '把平稳评分里的 jerk 顶格罚项权重清零',
    expect: ['平稳指标又变成空'],
    patch: t => t.replace(SRCLINE, `let src = require('fs').readFileSync('./src/game.js', 'utf8');
if (process.env.NEG === 'jerkwt') src = src.replace('dt * 2.6 : 0', '0 : 0');`),
  },
  {
    name: 'jcap1', why: '评分阈值系数 0.9 → 1.5（回到"阈值高于天花板"那个坑）',
    expect: ['空指标'],
    patch: t => t.replace(SRCLINE, `let src = require('fs').readFileSync('./src/game.js', 'utf8');
if (process.env.NEG === 'jcap1') src = src.replace('jCap * 0.9', 'jCap * 1.5');`),
  },
  {
    name: 'limiter', why: '运行时把 SH.JERK 改成 20（让"峰值不超限"永远成立）',
    expect: ['≠ physics.js 字面量'],
    patch: t => t.replace(INJECT, INJECT + `
if (process.env.NEG === 'limiter') SH.JERK = { up: 20, dn: 20, eb: 20 };`),
  },
  {
    /* 车壳退回**封闭扫掠**（窗洞那一步整个撤销）：判据必须量到"窗带高度上
       整面侧壁把光挡住了"。这条变异存在的意义是：如果哪天有人为了省三角形把
       shellSplit 换成一条闭合环，这条红线必须当场报红而不是让画面退回到
       "站台上一条黑带"这种没人会立刻发现的状态。 */
    name: 'noslot', why: '车壳退回封闭扫掠（侧壁不再开窗）',
    expect: ['侧壁没开窗'],
    script: './test-bake.js',
    disk: ['./src/mesh.js',
      "return { lower: dedupe(lower), upper: dedupe(upper), yLo: lo, yHi: hi, yA, yB };",
      "if (SH.__negslot) { const q = roundedProfile(w, y0, y1, rBot, rTop, seg, bulge); return { lower: q, upper: [], yLo: lo, yHi: hi, yA, yB }; }\n  return { lower: dedupe(lower), upper: dedupe(upper), yLo: lo, yHi: hi, yA, yB };"],
    patch: t => t,
  },
  {
    /* 客室（座椅/吊环/立杆）整批不建：这一条量的是"车窗后面真的有东西"，
       而不是"窗洞存在"。空客室与没有窗洞在画面上都是"黑带"，只有分开测才分得清。
       注在 mesh.js 上是不行的 —— buildCarInterior 在 train.js 里，得改 train.js。 */
    name: 'noinner', why: '客室几何整批不建（车窗后面是空的）',
    expect: ['车厢是空的'],
    script: './test-bake.js',
    disk: ['./src/train.js', 'function buildCarInterior(p, opt, kind, destRect) {',
      "function buildCarInterior(p, opt, kind, destRect) { if (SH.__noinner) return [];"],
    patch: t => t,
  },
  {
    /* 侧窗退回"一整条横铺 86% 车长"的玻璃带：这正是这一轮之前的真实状态，
       它从门洞底下穿过去 —— 门滑开之后门洞里还挡着一扇关着的窗。
       判据必须同时抓到"玻璃不是逐扇"与"玻璃压进门洞"。 */
    name: 'bandwin', why: '侧窗退回一整条玻璃带（横穿门洞）',
    expect: ['压进门洞', '玻璃 1 块'],
    script: './test-train.js',
    disk: ['./src/train.js', '    for (const [cz, w] of bays) {',
      '    for (const [cz, w] of [[0, L * 0.86]]) {'],
    patch: t => t,
  },
  {
    /* 贯通道退回单个橡皮盒子：0.30 m 的盒子跨不住 0.35 m 的车钩间隙，
       接头处是个敞开的黑洞，而且没有折棚褶、没有车钩、没有风管。 */
    name: 'nopleat', why: '贯通道退回单个盒子（跨不过间隙、无折棚无车钩）',
    expect: ['跨不住', '折棚只有', '没有任何车钩系部件'],
    script: './test-train.js',
    disk: ['./src/train.js', '  addGangway(body, p, -L / 2, -1);',
      "  body.box([0, p.floorY + 1.30, -L / 2 - 0.12], [p.width * 0.72, 2.05, 0.30], rgbOf('#1b2226'), { mat: 'rubber' });"],
    patch: t => t,
  },
  {
    /* 立柱与窗洞边界错开 0.4 m：数量还是对的，位置全是错的 ——
       这一条钉的是"立柱与窗洞出自同一份划分"，不是"立柱有几根"。 */
    name: 'mullindep', why: '立柱与窗洞边界脱钩（各错开 0.4 m）',
    expect: ['不在窗洞边界上'],
    script: './test-train.js',
    disk: ['./src/train.js', '    for (const dz of mullionZs(bays)) {',
      '    for (const dz of mullionZs(bays).map(z => z + 0.40)) {'],
    patch: t => t,
  },
  {
    /* 鼻型档案失效（所有车型共用 A 型鼻面）：这正是这一轮之前的状态 ——
       `noseLen = 4.6` 写死，磁浮的长鼻锥与 APM 的方头共用一张脸。 */
    name: 'nonose', why: '鼻型档案失效（全部共用 A 型鼻面）',
    expect: ['鼻长实测'],
    script: './test-train.js',
    disk: ['./src/train.js', 'const noseOf = p => NOSE[p.noseShape] || NOSE.A;',
      'const noseOf = () => NOSE.A;'],
    patch: t => t,
  },
  {
    /* 风挡不建：车头少了一整块最显眼的玻璃，但车壳、灯、鼻型全都对 ——
       所以这条必须单独量，不能指望鼻长/鼻尖那几条。 */
    name: 'norake', why: '风挡后倾不进几何（四型车共用一片竖直玻璃）',
    expect: ['风挡后倾实测'],
    script: './test-train.js',
    disk: ['./src/train.js', 'b.plate([0, (wTop + wBot) / 2, zPane - rk / 2], [p.width - 0.10, 0, 0], [0, wTop - wBot, -rk],',
      'b.plate([0, (wTop + wBot) / 2, zPane], [p.width - 0.10, 0, 0], [0, wTop - wBot, 0],'],
    patch: t => t,
  },
  {
    /* 中柱不建：A/C 型车的挡风玻璃是被中柱分成两块的，磁浮/APM 是一整块面罩。
       档案里写了 pillar 却不长出来，"分型"就只剩鼻长一个维度。 */
    name: 'nopillar', why: '风挡中柱不建（两块玻璃变一整块）',
    expect: ['量不到中柱'],
    script: './test-train.js',
    disk: ['./src/train.js', '  if (nose.screen.pillar > 0) {',
      '  if (0 && nose.screen.pillar > 0) {'],
    patch: t => t,
  },
  {
    /* 鼻尖下沉失效：`drop` 收进 scaleProfile 的参数列表却没人用，就是这一轮的
       原始缺陷（档案里 dropAmt 写了半天，鼻尖一点都不下沉）。注回去必须报红。 */
    name: 'nodrop', why: '鼻尖下沉不进公式（dropAmt 变成装饰）',
    expect: ['鼻尖顶高实测'],
    script: './test-train.js',
    disk: ['./src/train.js', '    y: (q.y > 2.2 ? q.y * yScale : q.y - (1 - yScale) * 0.2) - drop,',
      '    y: (q.y > 2.2 ? q.y * yScale : q.y - (1 - yScale) * 0.2),'],
    patch: t => t,
  },
  {
    /* 步态不进几何：`sw` 恒 0 → 腿不摆、手臂不反摆。 */
    name: 'nogait', why: 'person() 收到相位却不摆腿（滑行的人偶）',
    expect: ['应多出 ≥0.18 m 的迈步量', '必须反向'],
    script: './test-pax.js',
    disk: ['./src/world.js', '    const sw = Math.sin(ph);', '    const sw = 0;'],
    patch: t => t,
  },
  {
    /* 相位与"走了多远"脱钩：所有步行者共用一个固定相位。
       画面上是"整排人齐步走且脚步与位移对不上"。 */
    name: 'gaitfreeze', why: '下车相位与位移脱钩（固定 0.25）',
    expect: ['位移更远、相位也更大'],
    script: './test-pax.js',
    disk: ['./src/world.js', '        const gait = raw * walkT * walkV / SH.PAX_STEP;',
      '        const gait = 0.25;'],
    patch: t => t,
  },
  {
    /* 站着等车的人也被塞进相位：画面上是"整排队列原地踏步"。 */
    name: 'gaitstand', why: '候乘队列（没在走）也带步态',
    expect: ['原地站立、无相位'],
    script: './test-pax.js',
    disk: ['./src/world.js', '      if (band != null) q.gait = band * Math.abs(q.off - doorLat) / SH.PAX_STEP + i * 0.31;',
      '      q.gait = i * 0.31;'],
    patch: t => t,
  },
  {
    /* 站厅分层失效：人全留在站台上，第二层（第 116 条补出来的那块板）空无一人。 */
    name: 'nohall', why: '站厅分层失效（第二层永远没有人）',
    expect: ['站厅板上有几何', '站厅占'],
    script: './test-pax.js',
    disk: ['./src/world.js', '      const onHall = !!hall && lvlU < SH.PAX_SPLIT.hall;',
      '      const onHall = false;'],
    patch: t => t,
  },
  {
    /* 街面分层失效：人行道上一个人都没有（第 118 条补的第二层之外，
       街面出入口这一层同样会"永远空无一人"）。 */
    name: 'nostreet', why: '街面分层失效（人行道永远没人）',
    expect: ['街面有几何', '街面占'],
    script: './test-pax.js',
    disk: ['./src/world.js', '      const onStreet = !onHall && !!street && lvlU < SH.PAX_SPLIT.hall + SH.PAX_SPLIT.street;',
      '      const onStreet = false;'],
    patch: x => x,
  },
  {
    /* 人行道带伸进车行道：行人画到沥青上。判据拿 SH.ROAD.curb / 树线 / 楼线
       三个独立参照问，所以不会跟着 band 自己漂。 */
    name: 'streetroad', why: '人行道带伸进车行道（人站在沥青上）',
    expect: ['落在树线'],
    script: './test-pax.js',
    disk: ['./src/world.js', '      lat0: SH.STREET_WALK.tree + 0.9, lat1: SH.STREET_WALK.wall - 1.0,',
      '      lat0: SH.ROAD.curb - 6.0, lat1: SH.STREET_WALK.wall - 1.0,'],
    patch: x => x,
  },
  {
    /* 等车的人没被钉在候车亭上：画面上"站亭是布景"。 */
    name: 'busloose', why: '等车的人不跟候车亭同源',
    expect: ['离候车亭超过'],
    script: './test-pax.js',
    disk: ['./src/world.js', '          if (bside === side) { sdz = nb + (kw - 0.5) * 9;',
      '          if (bside === side) { sdz = sdz + 40;'],
    patch: x => x,
  },
  {
    /* 等车的人原地迈腿：与站台上"排队者不许有相位"同一条纪律，另一层。 */
    name: 'busstrut', why: '候车亭等车的人被塞进步态',
    expect: ['等车的站着'],
    script: './test-pax.js',
    disk: ['./src/world.js', '          gait: atBus ? undefined : sdz / SH.PAX_STEP + i * 0.29,',
      '          gait: sdz / SH.PAX_STEP + i * 0.29,'],
    patch: x => x,
  },
  {
    /* 调度器把调用口的 dt 当成一步积分（回到"内步长"之前的样子）：
       离线判据跑 0.5 s 一步，车队从 38.5 km/h 掉到 4 km/h，靠起点那列只挪 943 m。 */
    name: 'nodtfix', why: '积分步长不固定（判据量的不是玩家那套动力学）',
    expect: ['的车队均速'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '      const h = left > SIM_DT ? SIM_DT : left;', '      const h = left;'],
    patch: x => x,
  },
  {
    /* 屋顶形式不建：分区表里 roof 还在，楼顶上却只有女儿墙。 */
    name: 'norooform', why: '屋顶形式不进几何（十档共用的平屋顶）',
    expect: ['长出女儿墙的楼'],
    script: './test-scene.js',
    disk: ['./src/world.js', '  _zoneRoof(Z, rp, w, d, cy, sy, yaw, r1, r2) {',
      '  _zoneRoof(Z, rp, w, d, cy, sy, yaw, r1, r2) { return;'],
    patch: x => x,
  },
  {
    /* 人行道铺装不跟分区：pad 这一列又变回数据表上的字。 */
    name: 'nopadzone', why: '人行道铺装不跟分区换色',
    expect: ['人行道铺装平均色差', '铺装色对回分区表'],
    script: './test-scene.js',
    disk: ['./src/world.js', '      const sweepRun = (run, col) => {',
      "      const sweepRun = (run, col) => { col = '#99a1a7';"],
    patch: x => x,
  },
  {
    /* 站台机位站位净空（§7.10 那只"纸箱"= 一个长在镜头上的人，实测最近 0.82 m）。
       两条各打一个失效面：
       nocamclear —— 净空整个撤掉，人又挡回镜头；
       camdrop    —— 用"删人"实现净空：画面是干净了，但人数是停站时长的依据，
                     删一个就是谎报一个（顺带破前缀稳定性，重建时整片人重排）。 */
    name: 'nocamclear', why: '撤掉站台机位站位净空（人又长在镜头上）',
    expect: ['没人挡镜头'], script: './test-pax.js',
    disk: ['./src/world.js', '      if (cam && !onHall && !onStreet) {',
      '      if (false && !onHall && !onStreet) {'],
    patch: x => x,
  },
  {
    /* 门框专属材质（§7.11 的根治）。`portalnone` 撤的是整个洞口构造物，
       这条只把门框的材质改回大材质 `concrete` —— 几何一行没动，
       判据就该报"门框没了"：它测的必须是"门框这个东西"，不是"这个位置上有没有混凝土"。
       立柱与顶梁两处，必须 'all'。 */
    name: 'portalframe', why: '门框用回大材质 concrete（判据又变成"这附近有混凝土"）',
    expect: ['门框只占'], script: './test-shot.js',
    /* 锚点取两行共有的最短片段并标 'all'：立柱那行缩进 8 格、顶梁那行 6 格，
       按整行写只会命中一处，而**只剩顶梁也够过 1.5% 门槛**（实测 rc=0、零红字），
       这条负控就成了装饰。 */
    disk: ['./src/world.js', "mat: 'portal'", "mat: 'concrete'", 'all'],
    patch: x => x,
  },
  {
    /* 过街行人两条（§7.9 剩下的那半条 / README 第 125 条），各打一个失效面：
       nopedcross —— 行人整批不建（斑马线又只剩地上的漆）；
       pednoready —— **踏上斑马线前不核对剩余行人时间**：这是这一轮真写错的第一个
                     版本（只看"现在是绿灯"），实测 1.35% 的采样是"人在带上而灯已红"，
                     人会被留在车道中央等下一个周期。
       原本还想配一条"不看灯色随便走"，写完发现它是**死变异**：`SH.walkLeft > 0`
       本身就等价于"此刻在行人通行窗口内"，那行灯色判断比余量检查更弱，
       把它撤掉判据一点都不红（rc=0、零红字）—— 于是把那行冗余判断从源码里删了，
       只留一条能证伪的门控。 */
    name: 'nopedcross', why: '过街行人整批不建（斑马线又只剩地上的漆）',
    expect: ['每处斑马线至少两个人'], script: './test-street.js',
    disk: ['./src/street.js', '        if (!j.exit) continue;', '        if (true) continue;'],
    patch: x => x,
  },
  {
    name: 'pednoready', why: '踏上斑马线前不核对剩余行人时间（人走到一半被红灯留在车道中央）',
    expect: ['机动车红灯期间斑马线上没人'], script: './test-street.js',
    disk: ['./src/street.js', '        if (atEnd && SH.walkLeft(this.clock, p.j.i) < span / wv) continue;',
      '        if (atEnd && false) continue;'],
    patch: x => x,
  },
  {
    name: 'camdrop', why: '净空改成把挡镜头的人删掉（人数凭空少一个 = 谎报停站时长）',
    expect: ['净空不删人'], script: './test-pax.js',
    /* 变异必须落在**推之前**的位置上：写在推之后就是空变异（人被推出去了，
       删除条件永远不成立），第一版就是这么"报了红却没删人"，
       红字来自另一节，看着像命中其实没测到这条性质。 */
    disk: ['./src/world.js', '      if (cam && !onHall && !onStreet) {',
      '      if (cam && !onHall && !onStreet && Math.hypot(dz - cam.s, off - cam.lat) < cam.r) continue;\n      if (cam && !onHall && !onStreet) {'],
    patch: x => x,
  },
  {
    /* 街区类型不进楼高：分区表还在、判据的覆盖还在，但走廊照旧一种楼。 */
    name: 'nozoning', why: '分区不进楼高（街区类型学只是数据表上的字）',
    expect: ['分区进了楼高'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        const hb = low ? Z.hLo : [Math.min(Z.hHi[0], B.hHi[0]), Math.min(Z.hHi[1], B.hHi[1])];',
      '        const hb = low ? B.hLo : B.hHi;'],
    patch: x => x,
  },
  {
    /* 街区类型不进地块密度：沿街槽位回到固定 17 m。 */
    name: 'nogapzone', why: '分区不进地块密度（槽位固定 17 m）',
    expect: ['分区进了地块密度'],
    script: './test-scene.js',
    disk: ['./src/world.js', '      sCity += Z.gap;', '      sCity += 17;'],
    patch: x => x,
  },
  {
    /* 行道树不按分区换档：间距回到 21 m 一个值。 */
    name: 'notreezone', why: '行道树不跟分区换（间距/冠幅回到一档）',
    expect: ['分区进了树'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        sTree += TZ.pitch;', '        sTree += 21;'],
    patch: x => x,
  },
  {
    /* 高架快速路：桥面烘出来了，桥上一辆车都没有（"有高架没车流"那一半）。 */
    name: 'noelevcars', why: '高架桥面上的车不画',
    expect: ['高架车实例'],
    script: './test-street.js',
    disk: ['./src/street.js', '        if (c.deck && this.elev.blocked(c.s)) continue;', '        if (c.deck) continue;'],
    patch: x => x,
  },
  {
    /* 第 136 条：坡长回到独立常量 60 m ⇒ 9 m 落差 = 15% 纵坡（滑滑梯）。 */
    name: 'rampsteep', why: '落地段坡长写死 60 m（纵坡 15%，与口径脱钩）',
    expect: ['超过口径'],
    script: './test-street.js',
    disk: ['./src/core.js', 'SH.ELEV_WAY.ramp = Math.round(SH.ELEV_WAY.h / SH.ELEV_WAY.grade);', 'SH.ELEV_WAY.ramp = 60;'],
    patch: x => x,
  },
  {
    /* 第 136 条：坡长仍是派生式，但多算 20 m —— 两个数开始各说各话，
       "坡度改了坡长跟着变"这条承诺当场失效。 */
    name: 'rampderive', why: '坡长与坡度不再同源（派生式加了一段）',
    expect: ['各自为政'],
    script: './test-street.js',
    disk: ['./src/core.js', 'SH.ELEV_WAY.ramp = Math.round(SH.ELEV_WAY.h / SH.ELEV_WAY.grade);',
      'SH.ELEV_WAY.ramp = Math.round(SH.ELEV_WAY.h / SH.ELEV_WAY.grade) + 20;'],
    patch: x => x,
  },
  {
    /* 第 136 条：桥面斜着、车平着（实例矩阵只有 yaw 的那个旧世界）。 */
    name: 'nopitch', why: '车流不跟坡（坡上的车平着滑下坡）',
    expect: ['完全没有俯仰'],
    script: './test-street.js',
    disk: ['./src/street.js',
      '        const bf = c.deck ? SH.pitchBasis(q.r, q.u, q.f, this.elev.grade(c.s)) : [q.u, q.f];',
      '        const bf = [q.u, q.f];'],
    patch: x => x,
  },
  {
    /* 第 136 条：几何按 `foot` 横着挪到地面幅，车不跟 —— 坡上的车开出桥面。 */
    name: 'groundblend', why: '落地横向偏移只给几何用，车仍在桥面中心线上',
    expect: ['没被提交'],
    script: './test-street.js',
    disk: ['./src/street.js', '        const foot = c.deck ? this.elev.foot(c.s, c.cl) : 0;', '        const foot = 0;'],
    patch: x => x,
  },
  {
    /* 第 136 条：分幅方向回到 `ci === 0 ? 1 : -1` —— 与地面道路两套规则。 */
    name: 'deckdir', why: '高架两幅的行车方向与右侧通行相反',
    expect: ['右侧通行'],
    script: './test-street.js',
    disk: ['./src/street.js', '        const dir = SH.elevDir(eS, CW[ci]);', '        const dir = ci === 0 ? 1 : -1;'],
    patch: x => x,
  },
  {
    /* 第 136 条：把旧的"坡道尽头不画"请回来 —— 路还在、车没了。 */
    name: 'groundvanish', why: '车在落地段凭空蒸发（旧的 dh<0.4 剔除）',
    expect: ['路还在、车没了'],
    script: './test-street.js',
    disk: ['./src/street.js', '        if (c.deck && this.elev.blocked(c.s)) continue;',
      '        if (c.deck && this.elev.h(c.s) < 0.4) continue;'],
    patch: x => x,
  },
  {
    /* 第 136 条：桥下地面道路整段不建（高架落了地，地上没有路）。 */
    name: 'nogroundroad', why: '桥下地面道路不烘',
    expect: ['桥下地面道路'],
    script: './test-street.js',
    disk: ['./src/world.js', '            if (pc[1] - pc[0] < 20) continue;', '            if (true) continue;'],
    patch: x => x,
  },
  {
    /* 第 136 条：地面幅往线路中心挪 —— 立柱戳进行车道。 */
    name: 'roadunderpier', why: '桥下地面幅落在桥墩柱上（off 3.0 m）',
    expect: ['桥墩柱重叠'],
    script: './test-street.js',
    disk: ['./src/core.js', '  gp: { w: 7.0, lanes: [-1.75, 1.75], off: 7.5 },',
      '  gp: { w: 7.0, lanes: [-1.75, 1.75], off: 3.0 },'],
    patch: x => x,
  },
  {
    /* 第 137 条：装了第二把尺却不读它 —— 场景瓶颈照样一路降到底。 */
    name: 'gpuIgnore', why: 'DRS 不看 GPU 时间（第二把尺是装饰）',
    expect: ['降档买不到帧'],
    script: './test-env.js',
    disk: ['./src/renderer.js',
      '  const pixelBound = st.cpu >= D.lowS ? false : (!known || gpuMs >= id * D.gpuShare);',
      '  const pixelBound = true;'],
    patch: x => x,
  },
  {
    /* 第 137 条：门槛写成 9（永远"不算像素瓶颈"）—— 该降的也不降了。 */
    name: 'gpsthresh', why: 'gpuShare 门槛高到没有任何档算像素瓶颈',
    expect: ['把该降的也拦了'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  gpuShare: 0.62,', '  gpuShare: 9,'],
    patch: x => x,
  },
  {
    /* 第 137 条：只闩不退闩 —— 一次误判把降档永久关掉。 */
    name: 'gpnolatchout', why: '"瓶颈不在分辨率"那个闩没有退路',
    expect: ['闩没有退'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  if (st.cpu >= D.lowS) {\n    if (st.cpuAt > 0) {', '  if (false) {\n    if (st.cpuAt > 0) {'],
    patch: x => x,
  },
  {
    /* 第 137 条：降档没买到 GPU 时间还在继续降（"省下来"没配对账）。 */
    name: 'gpnobuy', why: '不做"降档必须买到 GPU 时间"的对账',
    expect: ['对账那条没起作用'],
    script: './test-env.js',
    disk: ['./src/renderer.js',
      '    if (gpuMs > want + 0.6 * (st.gpuAt - want)) { st.cpu = D.lowS; st.cpuAt = gpuMs; st.gpuAt = 0; }',
      '    if (false) { st.cpu = D.lowS; st.cpuAt = gpuMs; st.gpuAt = 0; }'],
    patch: x => x,
  },
  {
    /* 第 137 条：被抢占（disjoint）的毫秒数也喂进策略。（9b② 重锚：disjoint 判断
       抽进了共用的 _pollQ —— 变异改成"disjoint 也照读耗时"。） */
    name: 'gpdisjoint', why: 'disjoint 样本不丢弃',
    expect: ['被喂进了策略'],
    script: './test-env.js',
    disk: ['./src/renderer.js',
      `    const ms = gl.getQueryParameter(q, e.GPU_TIME_DISJOINT_EXT) ? null
      : gl.getQueryParameter(q, e.QUERY_TIME_ELAPSED_EXT) / 1e6;`,
      `    const ms = gl.getQueryParameter(q, e.QUERY_TIME_ELAPSED_EXT) / 1e6;`],
    patch: x => x,
  },
  {
    /* 第 137 条：beginQuery 没有配对的 endQuery —— 通道第一次用完就静默报废。
       （2026-10-08 expect 对齐：判据文案早已改成"写在早退的后面"——变异删掉
       世界 endQuery 后，文件里第一条 endQuery 变成后期链那条（在早退之后），
       判据报红的正是这句。旧 expect '不成对' 是文案改版前的化石。） */
    name: 'gqnoend', why: '不 endQuery',
    expect: ['写在后期链早退的'],
    script: './test-env.js',
    disk: ['./src/renderer.js',
      '    if (this.qExt && this._qOpen) { gl.endQuery(this.qExt.TIME_ELAPSED_EXT); this._qOpen = false; }',
      '    if (this.qExt && this._qOpen) { this._qOpen = false; }'],
    patch: x => x,
  },
  {
    /* 第 137 条：从不收读数 ⇒ gpuMs 永远 0 ⇒ 第二把尺等于不存在。 */
    name: 'gqnopoll', why: 'begin() 不收上一帧的 GPU 读数',
    expect: ['没有先收上一帧'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '    this._pollGpu();', '    /* 负控：不收读数 */'],
    patch: x => x,
  },
  {
    /* 第 137 条：策略侧写好了，运行时没把毫秒数传进去。 */
    name: 'gqnopass', why: 'game.js 不把 gpuMs 喂给 drsStep',
    expect: ['装了表没人读'],
    script: './test-env.js',
    disk: ['./src/game.js',
      'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);',
      'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native);'],
    patch: x => x,
  },
  {
    /* 9b②：后期链的样本灌进世界账 —— "世界 vs 后期各花多少"还是一笔糊涂账。 */
    name: 'gpmix', why: '后期链的账混进世界账',
    expect: ['混进了世界账'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '      const h = this._gpuPostHist;', '      const h = this._gpuHist;'],
    patch: x => x,
  },
  {
    /* 9b②：后期链根本不开自己的查询 —— 分 pass 只剩半本账。 */
    name: 'gpnoq', why: '后期链不开自己的 GPU 查询',
    expect: ['后期链的查询 begin/end 不成对'],
    script: './test-env.js',
    disk: ['./src/renderer.js',
      '      if (qp) { this._qPost = qp; gl.beginQuery(this.qExt.TIME_ELAPSED_EXT, qp); this._qPostOpen = true; }',
      '      /* 负控：后期链不开表 */'],
    patch: x => x,
  },
  {
    /* 9b①：估计器取成最慢的支撑箱 = rAF 中位的命 —— 负荷一上来尺又被拽长。 */
    name: 'refmed', why: '刷屏周期取成最慢的支撑箱',
    expect: ['尺自己也被拽长'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  const ok = [...bins.keys()].filter(b => bins.get(b) >= need).sort((a, b) => a - b);',
      '  const ok = [...bins.keys()].filter(b => bins.get(b) >= need).sort((a, b) => b - a);'],
    patch: x => x,
  },
  {
    /* 9b①：支撑率门槛撤到地板 —— 一两次亚帧抖动又读出"屏 156 Hz"（111h 的坑）。 */
    name: 'refjit', why: '刷屏周期的支撑率门槛被撤掉',
    expect: ['不存在的 156 Hz'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  const need = Math.max(3, Math.ceil(hist.length * 0.06));', '  const need = 3;'],
    patch: x => x,
  },
  {
    /* 9b①：独立读数量出来了却没喂给策略（还是 rAF 中位独尺，自欺照旧）。 */
    name: 'refdis', why: '独立量到的刷屏周期没喂给 DRS',
    expect: ['没把独立量到的刷屏周期喂给'],
    script: './test-env.js',
    disk: ['./src/game.js', 'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);',
      'SH.drsStep(this._drs, cadMed, raf, win, this.r._native, this.r.gpuMs);'],
    patch: x => x,
  },
  {
    /* 高架快速路：车流数据在、桥面几何整段没建。 */
    name: 'noelevdeck', why: '高架桥面/桥墩不建',
    expect: ['桥面登记', '桥面顶点'],
    script: './test-street.js',
    disk: ['./src/world.js', '        for (const g of ev.segs) {', '        for (const g of ev.segs.slice(0, 0)) {'],
    patch: x => x,
  },
  {
    /* 高架快速路：分区闸门失效，全线一律有高架（全有和全无一样，都是没分类）。 */
    name: 'elevignorezone', why: '高架不分街区，全线一律铺',
    expect: ['覆盖全线'],
    script: './test-street.js',
    disk: ['./src/core.js', '    if (!SH.SCENE_ZONES[z].elev) continue;', '    if (false) continue;'],
    patch: x => x,
  },
  {
    /* 地面路口：斑马线还在、灯却整个不立（"有人行横道却没灯"那一档）。 */
    name: 'nosignalgeo', why: '路口信号灯与停车线不建',
    expect: ['只烘出', '停车线：'],
    script: './test-street.js',
    disk: ['./src/world.js', '        this.trafficLight(j);', '        if (false) this.trafficLight(j);'],
    patch: x => x,
  },
  {
    /* 地面路口：灯照亮，车却完全不看灯。 */
    name: 'carsrunred', why: '车流不看信号灯（闯红灯）',
    expect: ['54 km/h 的一列空车'],
    script: './test-street.js',
    disk: ['./src/street.js', '          if (lamp !== \'green\' && dStop > -0.5) {',
      '          if (false && lamp !== \'green\' && dStop > -0.5) {'],
    patch: x => x,
  },
  {
    /* 地面路口：所有路口同相位（编号不参与）—— 全线同色是停电不是信号。 */
    name: 'samephase', why: '全线路口同相位',
    expect: ['前 12 个路口的灯色'],
    script: './test-street.js',
    /* 10-06 轮行人相位把方向偏移从 J.cycle/2 改成 J.green+J.amber —— 锚点跟着更新，
       变异语义不变（把 j*7 换成 0*7 = 编号不参与）。 */
    disk: ['./src/core.js', '  const t = (((clock + j * 7 + (side > 0 ? 0 : J.green + J.amber)) % J.cycle) + J.cycle) % J.cycle;',
      '  const t = (((clock + 0 * 7 + (side > 0 ? 0 : J.green + J.amber)) % J.cycle) + J.cycle) % J.cycle;'],
    patch: x => x,
  },
  {
    /* 地面路口：灯箱烘了、灯头从来没亮。 */
    name: 'nolampdraw', why: '信号灯的亮灯不画',
    expect: ['路口灯头实例'],
    script: './test-street.js',
    disk: ['./src/street.js', '    drawSignals(r, eye, night) {', '    drawSignals(r, eye, night) { this._signalsDrawn = 0; return;'],
    patch: x => x,
  },
  {
    /* 对向站台不建：轨道对面又变回一堵墙（上海地铁绝大多数站是双侧式/一岛一侧）。 */
    name: 'nofarplat', why: '对向站台不建（轨道对面是一堵墙）',
    expect: ['对向没有站台板'],
    script: './test-xsect.js',
    disk: ['./src/world.js', '    if (!island) this.farPlatform(s, side, opt, rect);', '    if (false) this.farPlatform(s, side, opt, rect);'],
    patch: x => x,
  },
  {
    /* 第 126 条：对向站台的基准退回"关于线路中心镜像" —— 那块板正好埋掉 −4 那条股道
       （2026-10-06 实量：granite −2.05~−3.10、黄线 −2.40、门柱 −2.06，钢轨在 −3.14~−4.86）。
       三条判据一起报红：对向板的横向、两股道之间的空档、线间距探针搬家。 */
    name: 'farpgap', why: '对向站台关于线路中心镜像（板子压住对向股道，两股道之间不是空的）',
    expect: ['对向站台不在对向股道', '两股道之间'],
    script: './test-xsect.js',
    disk: ['./src/world.js', 'SH.farFrontOf = lat => Math.abs(lat) + SH.STATION_X.front;',
      'SH.farFrontOf = () => SH.STATION_X.front;'],
    patch: t => t,
  },
  {
    /* 里程标与信号柱的边：不认 stationSide 而写死 +2.35/+2.42 时，side=−1 的线上它们
       就立在两股道之间（离对向轨中心 1.6 m，正对着对面那列车的风挡）。
       17 号线 徐盈路 有一根里程标正好落在断面窗口里 —— 这条判据最初就是这么撞上的。 */
    name: 'signside', why: '里程标/信号柱不分司机那一侧（站进两股道之间的限界）',
    expect: ['两股道之间'],
    script: './test-xsect.js',
    disk: ['./src/world.js', '    wb._side = line.stationSide(0);', '    wb._side = 1;'],
    patch: t => t,
  },
  {
    /* 第 127 条（高架车流跟驰与并线）三条，各打一个不同的失效面：
       decknocf —— 跟驰整个拆掉：快车穿过慢车，画面上是重叠的两辆车；
       decktele —— 并线不渐变：车"突然出现在另一条道上"（横向速度这条量得到）；
       deckjam  —— 跟驰曲线收敛到 0 而不是前车速度：穿模为 0、刹过车、并过线，
                   前四条全绿，而中位车速 13 m/s 是一条堵死的快速路。 */
    name: 'decknocf', why: '高架车不跟驰（同车道快车直接穿过前车）',
    expect: ['穿模'],
    script: './test-street.js',
    disk: ['./src/street.js', 'follow(c.next);', 'void c.next;'],
    patch: t => t,
  },
  {
    name: 'decktele', why: '高架车并线是瞬移（一步跳到目标车道）',
    expect: ['单帧横向跳变'],
    script: './test-street.js',
    disk: ['./src/street.js',
      '          else c.lat = c.cl + cur + (dd > 0 ? step : -step);',
      '          else c.lat = c.cl + want;'],
    patch: t => t,
  },
  {
    name: 'deckjam', why: '跟驰收敛到 0 而不是前车速度（快速路堵成停车场）',
    expect: ['堵成了停车场'],
    script: './test-street.js',
    disk: ['./src/street.js',
      '        let cap = lead.v + Math.sqrt(2 * this.brake * 0.8 * Math.max(0, dLead - want));',
      '        let cap = Math.sqrt(2 * this.brake * 0.8 * Math.max(0, dLead - want));'],
    patch: t => t,
  },
  {
    /* 第 128 条（车型剪影）三条，各打一个不同的失效面。这一族判据存在的理由就是
       "变体数 13 / draw call / 三角形数"全都正常而画面上车型分不出来 —— 所以负控
       必须打在**造型**上，不能打在数量上（数量那三条对下面三个变异全都无感）。 */
    name: 'vehflat', why: 'SUV / 厢式车退回轿车形状（剪影上是一辆车）',
    expect: ['车长分型不对'],
    script: './test-street.js',
    disk: ['./src/street.js', "    const van = kind === 'van', suv = kind === 'suv';",
      '    const van = false, suv = false;'],
    patch: t => t,
  },
  {
    name: 'nowheel', why: '轮子不建（车底下四颗黑球换成什么都没有）',
    /* expect 词条跟着第 131 条的红字原文改过一次：J 组那句"没有左右对称的轮子"
       在轮胎留在 steel、判据改量"成对 + 轴位"之后已经换成"找不到成对的轮子"。
       变异本身照样报红 6 条 —— 这是负控自己过期，不是红线失效（§6.1 那一族）。 */
    expect: ['找不到成对的轮子'],
    script: './test-street.js',
    disk: ['./src/street.js', '    const wheel = (x, z, r) => {',
      '    const wheel = (x, z, r) => { if (true) return;'],
    patch: t => t,
  },
  {
    name: 'vehglass', why: '公交侧窗带压到轿车高度（车窗线不再分车型）',
    expect: ['侧窗带高度'],
    script: './test-street.js',
    disk: ['./src/street.js',
      "      b.box([0, 1.55, 0], [W * 1.02, 0.85, L * 0.90], R('#1d242a'), { mat: 'glassSoft' });   // 侧窗带",
      "      b.box([0, 0.75, 0], [W * 1.02, 0.85, L * 0.90], R('#1d242a'), { mat: 'glassSoft' });   // 侧窗带"],
    patch: t => t,
  },
  {
    /* 第 129 条（交路级时段规则）三条：系数不分交路 / 配车基准查带后缀的 id /
       交路比例不按时段抽支线。三条各打一个失效面，且都是"看起来一切正常"的那类：
       高峰档逐字节不变，所以既有判据对它们完全无感。 */
    name: 'svcflat', why: '时段系数不分交路（主线与支线一起抽稀）',
    expect: ['交路系数没分家'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js',
      '  const branchX = svc === \'branch\' ? (base === 1.0 ? 1.0 : base >= 2.0 ? 1.45 : 1.15) : 1.0;',
      '  const branchX = 1.0;'],
    patch: t => t,
  },
  {
    name: 'svcbase', why: '配车头时按带 #branch 后缀的 id 查表（查不到退 4.0）',
    expect: ['配车头时基准'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js',
      '    this.headwayMin = (opt.headwayMin || HEADWAY[line.baseId] || HEADWAY[line.id] || 4) * this.density;',
      '    this.headwayMin = (opt.headwayMin || HEADWAY[line.id] || 4) * this.density;'],
    patch: t => t,
  },
  {
    name: 'ratfix', why: '交路比例不按时段给（平峰仍与高峰同比例）',
    expect: ['更偏主线'],
    script: './test-traffic.js',
    disk: ['./data/shanghai.js', '  const ratio = [r0[0] + boost, r0[1]];', '  const ratio = r0;'],
    patch: t => t,
  },
  {
    /* 第 130 条（分级推进省 CPU）三条，各打一个失效面：
       farstop    —— 远档干脆不推进：镜头转过去是一排停着的车；
       nocull     —— 那道门装反（传了相机反而不裁）：分级白分，时间没省；
       nearshort  —— 近档半径收到画程以下：远档的叠车跑到镜头前了。 */
    name: 'farstop', why: '远档车不推进（省 CPU 省到把车停下）',
    expect: ['远档车一帧走'],
    script: './test-street.js',
    disk: ['./src/street.js', '          c.s += c.baseV * dt * (c.deck ? c.dir : c.side);', '          c.s += 0;'],
    patch: t => t,
  },
  {
    name: 'nocull', why: '分级的门装反（传了相机里程反而不裁）',
    expect: ['分级没省到时间'],
    script: './test-street.js',
    disk: ['./src/street.js', '      const cull = camS == null ? null : (s) => {',
      '      const cull = camS != null ? null : (s) => {'],
    patch: t => t,
  },
  {
    name: 'nearshort', why: '近档半径小于画程三倍（远档的叠车会被画出来）',
    expect: ['不足画程'],
    script: './test-street.js',
    disk: ['./src/street.js', 'const NEAR_S = 1500;', 'const NEAR_S = 200;'],
    patch: t => t,
  },
  {
    /* 第 134 条：支线贯通率。三条各钉一个"没有它这条功能就不成立"的口径：
       折返车真的不进尾巴、平峰真的折返、高峰真的全贯通（与基线逐字节一致）。 */
    name: 'thrpass', why: '支线区间车不真的折返（越过分岔站开进尾巴）',
    expect: ['越过分岔站'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '        t.last = this.inter.forkIdx; t.dest = this.line.stations[t.last]; t.turn = true;', '        t.turn = true;'],
    patch: t => t,
  },
  {
    name: 'thrflat', why: '平峰也不放区间车（贯通率永远是 1，共线段加密无从谈起）',
    expect: ['没有一列折返'],
    script: './test-traffic.js',
    disk: ['./data/shanghai.js', '  return peak ? 0 : 3;', '  return 0;'],
    patch: t => t,
  },
  {
    name: 'thralways', why: '高峰也放区间车（默认基线被动过，且高峰把尾巴砍稀）',
    expect: ['高峰折返步长'],
    script: './test-traffic.js',
    disk: ['./data/shanghai.js', '  return peak ? 0 : 3;', '  return 3;'],
    patch: t => t,
  },
  {
    /* 第 135 条：按实例给涂装色。三条量通道结构（shader 分支、谁能吃色、a 的来源），
       两条量行为（数组没传、几何又按涂装烘回去）。 */
    name: 'tintoff', why: 'shader 不乘实例色（涂装还是只能靠烘几何）',
    expect: ['shader 少了一边'],
    script: './test-street.js',
    disk: ['./src/renderer.js', '  if (uInst > 0.5) { if (aIT.a > 0.5) vC = vec4(aCol.rgb * aIT.rgb, aCol.a); }', '  if (uInst > 0.5) { }'],
    patch: t => t,
  },
  {
    name: 'tinttrim', why: '深色饰条也吃涂装（格栅、门缝、裙板跟着漆走）',
    expect: ['carTrim 也标了 tint'],
    script: './test-street.js',
    disk: ['./src/renderer.js', '  carTrim:    { tex: null,        mode: 0, spec: .30, shin: 70,  alpha: 1 },',
      '  carTrim:    { tex: null,        mode: 0, spec: .30, shin: 70,  alpha: 1, tint: 1 },'],
    patch: t => t,
  },
  {
    name: 'tintall', why: '每一批都吃实例色（玻璃、灯、轮胎一起被染）',
    expect: ['实例色的 a 不是按批次标志给的'],
    script: './test-street.js',
    disk: ['./src/renderer.js', '      data[off + 19] = tints && b.tint ? 1 : 0;', '      data[off + 19] = 1;'],
    patch: t => t,
  },
  {
    name: 'tintnone', why: '街面车流没把每实例的色送进 drawInstanced',
    expect: ['实例色数组长度'],
    script: './test-street.js',
    disk: ['./src/street.js', "r.drawInstanced(b, g.mats, mat === 'light' ? ov : null, flat);", "r.drawInstanced(b, g.mats, mat === 'light' ? ov : null);"],
    patch: t => t,
  },
  {
    name: 'tintfixed', why: '涂装又回到"每档烘一份几何"（13 变体、批次翻倍）',
    expect: ['同一车型有多份几何', '车辆批次合计'],
    script: './test-street.js',
    disk: ['./src/street.js', "      for (const k of ['sedan', 'taxi', 'suv', 'van', 'bus']) push(k);",
      "      for (const k of ['sedan', 'sedan', 'taxi', 'sedan', 'sedan', 'sedan', 'sedan', 'suv', 'suv', 'van', 'van', 'bus', 'bus']) push(k);"],
    patch: t => t,
  },
  {
    /* 第 133 条：小交路（中途折返）。六条各钉一条"这件事没有它就不成立"的口径：
       行程边界、只切不增、类规则真的投、客流闸门真的乘上、折返后屏上的终点跟着改、
       登记表(svc)与真实行程真的同源。 */
    name: 'shortcross', why: '行程边界失效（小交路车一路跑到线路末端）',
    expect: ['越过折返点', '是小交路车**停靠的**'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '    return (t.last != null && t.last + 1 < S.length && t.s <= S[t.last]) ? t.last + 1 : S.length;', '    return S.length;'],
    patch: t => t,
  },
  {
    name: 'shortextra', why: '为小交路追加车底（配车数与实际铺车不一致）',
    expect: ['实际铺了'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '    for (let i = 0; i < this.n; i++) {', '    for (let i = 0; i < this.n + 2; i++) {'],
    patch: t => t,
  },
  {
    name: 'shortnone', why: '类规则不投小交路（"大小交路"这个词里只有"大"）',
    expect: ['没投小交路'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '    this.short = SH.shortTurn ? SH.shortTurn(line) : null;', '    this.short = null;'],
    patch: t => t,
  },
  {
    name: 'shortgate', why: 'AI 上客不看列车终点（把到不了的人装上小交路车）',
    expect: ['AI 上客没有按'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', 'const allow = Math.min(currentWait, Math.ceil(currentWait * (ps.gate == null ? 1 : ps.gate)));', 'const allow = currentWait;'],
    patch: t => t,
  },
  {
    name: 'shortdest', why: '折返后屏上仍写线路终点（目的地跟着行程改这一半没接上）',
    expect: ['目的地没跟着改'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', '            t.dest = this.line.stations[t.last == null ? this.line.stations.length - 1 : t.last];', '            t.dest = this.terminus;'],
    patch: t => t,
  },
  {
    name: 'shortsvc', why: '行程改了但不标交路（nShort 与真实车队两张皮）',
    expect: ['与按 svc 数出来的'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', "        t.svc = 'short';", "        t.svc = 'main';"],
    patch: t => t,
  },
  {
    /* 第 132 条：自适应分辨率（DRS）。策略是纯函数，判据在合成帧历史上跑闭环，
       所以变异要么让闭环不收敛（前五条），要么把"接线"拆掉（后六条 ——
       机制写好了但没人调用，是本项目栽过最多的一族）。 */
    name: 'drsnodrop', why: '自动档从不降档（跑不动的人永远留在原地）',
    expect: ['没降到地板'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  if (st.low >= D.lowS && st.tier > 0) {', '  if (false && st.low >= D.lowS && st.tier > 0) {'],
    patch: t => t,
  },
  {
    /* 只降不升 = 单程票：进一次隧道画质再也回不来，玩家看到的是"自动档有毒"。 */
    name: 'drsnoraise', why: '自动档只降不升（变轻了也不爬回上限）',
    expect: ['重探的门是不是关死了', '一次都没有上探'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '    if (st.tier < st.cap && st.tier + 1 < st.fail) {', '    if (false) {'],
    patch: t => t,
  },
  {
    name: 'drsnocap', why: '上探不看玩家上限（选了 1080p 会被顶到 2.5K）',
    expect: ['档位越过了玩家上限'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '    if (st.tier < st.cap && st.tier + 1 < st.fail) {', '    if (st.tier < st.cap + 1 && st.tier + 1 < st.fail) {'],
    patch: t => t,
  },
  {
    /* 这两条是**真机测量逼出来的**：DPR=0.5 那一趟窗口只有 0.28 M 像素、帧成本全在
       场景上，旧写法照样一路降到地板 —— 白改三次 FBO 还把玩家的"原生"改成了 720p。
       所以"降档"这个动作必须先问一句：它到底少画了多少像素。 */
    name: 'drsinert', why: '降档不问像素（窗口低于所有预算时照样一路降到底）',
    expect: ['一个像素也没省下来', '一步降到第一档买得到像素的'],
    script: './test-env.js',
    disk: ['./src/renderer.js', 'const to = npx > 0 ? SH.drsTarget(npx, st.tier) : st.tier - 1;', 'const to = st.tier - 1;'],
    patch: t => t,
  },
  {
    name: 'drsnoskip', why: '只肯看紧邻的下一档（1.5 M 窗口时一档都不肯降）',
    expect: ['一步降到第一档买得到像素的'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  for (let i = from - 1; i >= 0; i--) {', '  for (let i = from - 1; i === from - 1; i--) {'],
    patch: t => t,
  },
  {
    name: 'drsnopass', why: '调用点没把窗口像素传给策略（策略就退化成瞎降）',
    expect: ['DRS 没拿到窗口像素'],
    script: './test-env.js',
    disk: ['./src/game.js', 'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);', 'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win);'],
    patch: t => t,
  },
  {
    /* 这条是整组里最值钱的：vsync 下"锁在整拍"就是上限，看不出余量；
       而本项目在 >110 Hz 的屏上**故意**一半跳一拍。把这两个数混在一起，
       144 Hz 屏上每台机器都会被误判成"跑不动"而一路降到底。 */
    name: 'drsnorefresh', why: '理想拍不认限帧器的半拍（144 Hz 上把半拍当成掉帧）',
    expect: ['限帧器的半拍'],
    script: './test-env.js',
    disk: ['./src/renderer.js', 'SH.drsIdealMs = raf => raf * (raf < SH.DRS.skipMs ? 2 : 1);', 'SH.drsIdealMs = raf => raf * 1;'],
    patch: t => t,
  },
  {
    name: 'drsnoguard', why: '换挡没有冷却期（换档要重建 FBO，头几帧本来就慢）',
    expect: ['换挡间隔只有'],
    script: './test-env.js',
    disk: ['./src/renderer.js', '  if (st.cool > 0) { st.cool -= sec;', '  if (false) { st.cool -= sec;'],
    patch: t => t,
  },
  {
    name: 'drsnohook', why: 'DRS 策略写好了但没人喂样本（自动档是摆设）',
    expect: ['没有调用 SH.drsStep'],
    script: './test-env.js',
    disk: ['./src/game.js', 'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);', 'void cadMed;'],
    patch: t => t,
  },
  {
    /* 平均帧率会被一次重烘焙顶坑（300 ms 那一帧），那一帧不该把整局画质判掉；
       刷屏周期也要一起传进去，否则限帧那一半的口径就丢了。 */
    name: 'drsfps', why: 'DRS 吃平均帧率而不是出画间隔中位',
    expect: ['DRS 吃的不是出画间隔'],
    script: './test-env.js',
    disk: ['./src/game.js', 'SH.drsStep(this._drs, cadMed, this.refreshMs || raf, win, this.r._native, this.r.gpuMs);',
      'SH.drsStep(this._drs, 1000 / Math.max(1, this._fpsN / this._fpsT), this.refreshMs || raf, win, this.r._native, this.r.gpuMs);'],
    patch: t => t,
  },
  {
    name: 'drsskipconst', why: '限帧阈值退回裸的 0.0092（两个旋钮各改各的）',
    expect: ['还留着裸的 0.0092'],
    script: './test-env.js',
    disk: ['./src/game.js', 'if (rawDt > 0 && rawDt < SH.DRS.skipMs / 1000) return;', 'if (rawDt > 0 && rawDt < 0.0092) return;'],
    patch: t => t,
  },
  {
    name: 'drsmancap', why: 'resize 不按 resAuto 取生效档（策略改了状态而画面没改）',
    expect: ['没有按 resAuto 取生效档'],
    script: './test-env.js',
    disk: ['./src/renderer.js', 'SH.RES_TIERS[this.resAuto ? this._effTier : this.resTier]', 'SH.RES_TIERS[this.resTier]'],
    patch: t => t,
  },
  {
    name: 'drsnopersist', why: '自动档开关不写进存档（重启就忘掉）',
    expect: ['自动档开关没有写进存档'],
    script: './test-env.js',
    disk: ['./src/game.js', 'resAuto: !!this.r.resAuto,', 'resAutoX: !!this.r.resAuto,'],
    patch: t => t,
  },
  {
    name: 'drsnoresume', why: '开机不恢复自动档开关（设置里选了也没用）',
    expect: ['开机没有恢复自动档开关'],
    script: './test-env.js',
    disk: ['./src/game.js', 'this.r.setResAuto(this.settings.resAuto !== false);', 'void this.settings.resAuto;'],
    patch: t => t,
  },
  {
    name: 'drsdualtable', why: '开机恢复又自带一张档位表（RES_ORDER 改了悄悄失配）',
    expect: ['又自带了一张档位表'],
    script: './test-env.js',
    disk: ['./src/game.js', 'SH.RES_ORDER.indexOf(this.settings.res)', "['native', 'q2600', 'q1080', 'q720'].indexOf(this.settings.res)"],
    patch: t => t,
  },
  {
    name: 'drsnoauto', why: '设置面板没有自动档开关（玩家关不掉它）',
    expect: ['设置面板没有自动档开关'],
    script: './test-env.js',
    disk: ['./index.html', 'id="auto-seg"', 'id="auto-seg-off"'],
    patch: t => t,
  },
  {
    /* 第 131 条：车漆合并退回"借用全局 paint/metal"。这一条同时钉两件事 ——
       批次没省下来（族数超 4），而且车漆高光从此不能单独调（调 paint 会连着
       全城标线、色带、店招一起变）。 */
    name: 'carpaint', why: '车身退回全局 paint/metal（没有专属车漆族，批次也降不下来）',
    expect: ['还在用全局 paint/metal'],
    script: './test-street.js',
    /* 锚点跟着第 135 条改写过：以前是清空 `SHELL` 表，现在改名发生在 push() 里
       （paint → carShell 吃涂装、metal → carTrim 不吃），所以撤掉那一行改名。 */
    disk: ['./src/street.js', "          if (m.mat === 'paint') m.mat = 'carShell';", '          if (false) m.mat = 0;'],
    patch: t => t,
  },
  {
    /* 对向站台照建，但**不认对方线路**：色带与站名牌退回本线。
       3/4 号线同台对面换乘的三站于是画面上说假话 ——
       对面看着还是 3 号线，"过对面就是 4 号线"不成立。
       这一注同时掐掉色带、顶牌、量级三条，任一条不报红都说明判据是摆设。 */
    name: 'nofarpeer', why: '对向站台不挂对方线路身份（色带/顶牌退回本线）',
    expect: ['对方线路**的色带', '同量级', '对方线路的站名牌'],
    script: './test-transfer.js',
    disk: ['./src/world.js', '    opt.peer = SH.peerAtShared(opt.lineId, name);', '    opt.peer = null;'],
    patch: x => x,
  },
  {
    /* 高架快速路：桥面烘得比车流高 0.6 m —— 三处同源里任何一处漂了，
       车就变成在空气里跑。这条专门抓"几何与车流各算一套高度"。 */
    name: 'elevdrift', why: '桥面高度与车流高度不同源（车悬空 0.6 m）',
    expect: ['辆轮下'],
    script: './test-street.js',
    disk: ['./src/world.js', '                p: al.world(f.q, cl + ev.foot(f.s, cl), al.streetDy(f.s) + f.h + 0.02),',
      '                p: al.world(f.q, cl + ev.foot(f.s, cl), al.streetDy(f.s) + f.h + 0.62),'],
    patch: x => x,
  },
  {
    /* 里弄的门柱与过梁不建：洞口两侧不再有柱子、头顶不再有梁。
       型式表里 brick 的 `top` 写的就是过梁顶（2.71 m），所以这条会红在
       "实测最高构件"上 —— 型式表承诺的东西必须真在顶点里。 */
    name: 'nogateframe', why: '弄口门柱与过梁不建（只剩两处断口）',
    expect: ['实测最高构件'],
    script: './test-scene.js',
    disk: ['./src/world.js', "        if (type === 'brick') for (const c of gates) {",
      "        if (type === 'brick') for (const c of []) {"],
    patch: x => x,
  },
  {
    /* 分类退化成一档：径向兜底不再判，全部落"未分类"。
       覆盖类判据最容易假绿 —— 只要还返回一个键就算过了，所以这里数兜底。 */
    name: 'nonamezone', why: '地名学那一层失效（只剩径向兜底在分档）',
    expect: ['判据来源'],
    script: './test-scene.js',
    disk: ['./src/core.js', '  const named = SH.zoneOf(name);',
      '  const named = null; void SH.zoneOf;'],
    patch: x => x,
  },
  {
    /* 整条走廊不布灯：以前街面断面里就只有公交站亭，没有一根灯杆。 */
    name: 'nolamp', why: '路灯根本不建',
    expect: ['路灯登记'],
    script: './test-scene.js',
    disk: ['./src/world.js', '      while (sLamp <= z) {', '      while (false && sLamp <= z) {'],
    patch: x => x,
  },
  {
    /* 灯在，但不跟分区换间距：型式表里 24~55 m 那一列又变成装饰。 */
    name: 'nolampzone', why: '路灯不跟分区换间距（固定 30 m 一盏）',
    expect: ['灯距实测'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        sLamp += TZ.lamp.gap;', '        sLamp += 30;'],
    patch: x => x,
  },
  {
    /* 灯杆在、灯头登记也在，但灯具几何没建 —— "记了没建"那一族。 */
    name: 'noheadgeo', why: '灯头只登记不建（杆上有杆、头上无灯）',
    expect: ['灯头有发光面'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        for (const hp of heads) {', '        for (const hp of heads.slice(0, 0)) {'],
    patch: x => x,
  },
  {
    /* 围墙建了，但全上海一种墙：型式表 wall 那一列没进几何。 */
    name: 'nowallzone', why: '地块界型式不跟分区换（一律砖墙）',
    expect: ['地块界型式按分区换'],
    script: './test-scene.js',
    disk: ['./src/world.js', '      const flushWall = () => { wallRun(wr, wType, -1); wallRun(wr, wType, 1); };',
      "      const flushWall = () => { wallRun(wr, 'brick', -1); wallRun(wr, 'brick', 1); };"],
    patch: x => x,
  },
  {
    /* 墙段照样登记，扫掠却全部短路：判据必须能从"没有顶点"里发现。 */
    name: 'wallghost', why: '围墙只登记不建（幽灵墙）',
    expect: ['墙顶棱连续'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        const span = (fr2, x0, x1, ya, yb2, mat, col) => {',
      '        const span = (fr2, x0, x1, ya, yb2, mat, col) => { if (fr2.length) return;'],
    patch: x => x,
  },
  {
    /* 弄口的柱子还在、墙却整片连着长过去：门洞只是画上去的。 */
    name: 'nogatecut', why: '里弄口没真的挖断（墙连成一片）',
    expect: ['弄口真的断开'],
    script: './test-scene.js',
    disk: ['./src/world.js', '        const G = WF.gate, U = WF.unit, HALF = G ? 2.2 : 0;',
      '        const G = WF.gate, U = WF.unit, HALF = 0;'],
    patch: x => x,
  },
  {
    /* 底商那一层整个关掉：立面从街面到屋顶还是同一张窗贴图。 */
    name: 'noshop', why: '店招/雨棚/店面不建',
    expect: ['底商'],
    script: './test-scene.js',
    disk: ['./src/world.js', "        if (lane === CITY_BAND.lanes[0] && h > 6 && rand01('shop' + k, side) < shopP) {",
      '        if (false && lane === CITY_BAND.lanes[0] && h > 6) {'],
    patch: x => x,
  },
  {
    /* 树穴沉到街面以下 6 m：登记还在，画面上没有。 */
    name: 'nopitgeo', why: '树穴只登记不建（坑位是空的）',
    expect: ['树穴：'],
    script: './test-scene.js',
    disk: ['./src/world.js', '          this.b.box([p0[0], p0[1] - 0.10, p0[2]], [1.8, 0.10, 1.8], rgbOf(',
      '          this.b.box([p0[0], p0[1] - 6.10, p0[2]], [1.8, 0.10, 1.8], rgbOf('],
    patch: x => x,
  },
  {
    /* 站厅可行带越过箱涵壁：人会画到墙外面去。
       判据不能只拿 `hallBand` 自己给的上下限去量自己（那是自我确认），
       必须拿**箱涵壁**这个独立常量去问"带有没有出界"。
       注：这条取代了原计划的 halladd —— 那个变异要跨两行锚点，
       而 src/*.js 是 CRLF，`
` 写的跨行锚点永远找不到。 */
    name: 'hallwall', why: '站厅可行带越过箱涵壁（人画到墙外）',
    expect: ['越过箱涵壁'],
    script: './test-pax.js',
    disk: ['./src/world.js', 'lat1: STATION_X.boxW - 0.35 - 0.55,', 'lat1: STATION_X.boxW + 3.0,'],
    patch: t => t,
  },
  {
    /* 上车带又按整张名单取尾部：站在 2.95 m 板上的人被标成"正在登车"。 */
    name: 'bandhall', why: '上车带含站厅的人（有人从站厅登车）',
    expect: ['没有人能从站厅登车'],
    script: './test-pax.js',
    disk: ['./src/world.js', '    for (let i = 0; i < P.length; i++) if (!P[i].onHall && !P[i].onStreet && P[i].queuing) platQue.push(i);',
      '    for (let i = 0; i < P.length; i++) if (P[i].queuing) platQue.push(i);'],
    patch: t => t,
  },
  {
    /* 站台屏倒计时的方向反过来（按"刚开走的那一车"取最小）。
     * 这个缺陷在截图上完全看不出来：屏在亮、数字在跳，只是跳错了方向
     * （实测 20 分钟 148 次变大、0 次变小）。判据必须能抓住它，
     * 否则"站台屏"这一节只是一块会发光的板。 */
    name: 'ptddir', why: '站台屏倒计时方向反了（跟着刚开走的车）',
    /* 红字原文（test-traffic.js:697）是「…它已开过站心 N m，而**另有更近的车** —— 屏却说…」，
       这一节里根本没有「方向已反」这四个字 —— expect 写一个不存在的词，等于这条负控
       永远"不报红"，而它其实一直在报红（实测 rc=1、8 条红字）。**expect 必须逐字抄红字。** */
    expect: ['另有更近的车'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', 'let rel = (st - t.s) % total;', 'let rel = (t.s - st) % total;'],
    patch: t => t,
  },
  {
    /* 「到站」那一档恒假：`bd` 已折进 [0,total)，所以 `bd <= -1` 永不成立。
     * 与 ptddir 是两件独立的事：一个把方向搞反，一个把某一档显示废掉，
     * 而两者在画面上都表现为"屏上的字不太对"。 */
    name: 'ptdat', why: '「到站」那一档恒假（屏上永远不出现"到站"）',
    expect: ['一列车正停在本站'],
    script: './test-traffic.js',
    disk: ['./src/traffic.js', 'const at = best && bd <= 1;', 'const at = best && bd <= -1;'],
    patch: t => t,
  },
  {
    /* 车体人工光撤掉：这条测的是"隧道里整列车是一条黑影"这个缺陷。
       它与 noslot/noinner 是三件独立的事 —— 几何对了但没光，画面同样是一条黑带，
       而三者任何一个单独存在都会被另外两个的判据放过去。 */
    name: 'noshelllight', why: '车体外壳的人工光撤掉（隧道里车身读不出来）',
    expect: ['一条黑影'],
    script: './test-bake.js',
    disk: ['./src/train.js', "body.light(carShellLight(p));", "body.light(null);", 'all'],
    patch: t => t,
  },
  {
    /* 客室人工光撤掉：测"隔着车窗看不见车厢"。
       与 noshellsellight 分开是因为它们作用在不同批次上（body vs inner），
       而症状在画面上完全一样（窗后面是黑的）。 */
    name: 'noinnerlight', why: '客室的人工光撤掉（窗后面是黑的）',
    expect: ['隔着车窗看不见车厢'],
    script: './test-bake.js',
    /* 锚点必须唯一：`buildCarPax` 里也有一次 `b.light(carLightFn(p))`，
       所以只锚 `b.light(carLightFn(p));` 这一行会命中两处，harness 会拒绝执行
       （"锚点命中多处而未标 all"）—— 那正是它该做的事。 */
    disk: ['./src/train.js', 'b.light(carLightFn(p));            // 客室自己的人工光', 'b.light(null);            // 客室自己的人工光'],
    patch: t => t,
  },
  {
    name: 'physband', why: '把 physics.js 的字面量改成 up: 6.00（为了变绿而调数）',
    expect: ['舒适口径'],
    disk: ['./src/physics.js', 'const JERK = { up: 0.55', 'const JERK = { up: 6.00'],
    patch: t => t,
  },
  {
    name: 'noramp', why: '把需求的 jerk 斜坡改成一步到位（demand = tgtA）',
    expect: ['需求整形'],
    disk: ['./src/physics.js', 'this.demand += C(tgtA - this.demand, -SH.JERK.dn * dt, SH.JERK.up * dt);', 'this.demand = tgtA;'],
    patch: t => t,
  },
  {
    name: 'deadpin', why: '把 SH.dialDeg 写成常数（针焊死在 12 点方向）',
    expect: ['张角'],
    disk: ['./src/core.js', 'SH.dialDeg = f => -120 + clamp(f, 0, 1.15) * 240;', 'SH.dialDeg = f => -120;'],
    patch: t => t,
  },
  {
    name: 'platover', why: '站台板截面退回无符号（side=-1 的车站压到正线上）',
    expect: ['越过线路中心'], script: 'test-xsect.js', args: ['l3'],
    disk: ['./src/world.js', 'const prof = boardRect(pw, -1.0, 0.42);', 'const prof = Geo.rectProfile(0, -1.0, pw, 0.42);'],
    patch: t => t,
  },
  {
    name: 'noofcover', why: '雨棚外移到站台之外 3 m（俯瞰截图那个缺陷）',
    expect: ['雨棚只罩住站台'], script: 'test-xsect.js', args: ['l3'],
    disk: ['./src/world.js', 'canopyIn: PLAT_FRONT + 0.3,', 'canopyIn: PLAT_FRONT + 2.3,'],
    patch: t => t,
  },
  {
    /* ⚠ 2026-10-05 全量跑到这条 **不报红**，已定性，不是门槛要调：
       基线中心树冠 2.1%，把目标横向改成 60.5（与机位同侧同值，顺着树列看）只到
       7.0%，改成 57.9（当前树列实际横向）7.1%，而门槛是 12%。
       原因：上一轮给露天站出口加了 ±26 m 树净空区，机位正前方那一段本来就没有树，
       "顺着树列看"这个动作已经造不出当年那团糊住中心的树冠 —— 这是负控失效的
       第二种（机制再也碰不到，要重新构造）而不是第三种。
       要恢复它得连树一起变异（把净空区撤掉 + 机位顺树列），那是"两个缺陷叠一起"，
       与这条当初要抓的单一缺陷不是一回事。**没有把它调红**：调门槛 = 为了变绿改数。 */
    name: 'streettree', why: '让街面机位沿着树列往前看（树冠正对镜头）—— 2026-10-05 起不报红，见上',
    expect: ['街面机位画面中心'], script: 'test-shot.js',
    disk: ['./src/game.js', 'const t = al.world(al.frame(dz + 8), side * 30,', 'const t = al.world(al.frame(dz + 8), side * 60.5,'],
    patch: t => t,
  },
  {
    name: 'maglevorder', why: '把 this.maglev 的赋值挪回 profile 之后（读未赋值字段，静默退回地铁断面）',
    expect: ['构造顺序错'], script: 'test-drive.js',
    /* 锚点必须单行：这个仓库是 CRLF，跨行锚点在文件里永远找不到。 */
    disk: ['./src/game.js',
      '    this.screen = def.screen || this.stock.screen',
      '    this.profile = this._profile(); this.screen = def.screen || this.stock.screen'],
    patch: t => t,
  },
  {
    name: 'maglevarms', why: '拿掉 profile.maglev 这个标志（磁浮抱臂与管形断面全部消失）',
    expect: ['抱臂'], script: 'test-bake.js',
    disk: ['./src/game.js', 'maglev: this.maglev,', 'maglev: false,'],
    patch: t => t,
  },
  {
    name: 'winphase', why: '把行道树的摆放相位改回以烘焙窗口起点为准（车一动树就滑动）',
    expect: ['重烘挪家具'], script: 'test-bake.js',
    /* 10-06 轮锚点更新：树的摆放早已改走 `_phaseTo(0, a, step)`（绝对相位唯一实现，
       调用方一律从 0 起铺），旧锚点的 21 m 步长循环已删。变异等价：相位从**窗口
       起点**起算（p = a，while 不前进）—— 重烘窗口一挪树就跟着挪。 */
    disk: ['./src/world.js', '    let p = from;', '    let p = a;'],
    patch: t => t,
  },
  {
    name: 'curvenote', why: '曲线文案退回"直接印欠高允许速度"（269 km/h 那个坑）',
    expect: ['司机台曲线文案'], script: 'test-core.js',
    disk: ['./src/core.js', "+ (isFinite(limitKmh) && limitKmh < maxKmh ? ' 限速 ' + Math.round(limitKmh) : '')",
      "+ (' 限速 ' + Math.round(limitKmh))"],
    patch: t => t,
  },
  /* ---- 磁浮"速度/里程兑现真实口径"四条新红线，各配一个负控 ---- */
  {
    name: 'mkmileage', why: '磁浮站间距退回通用启发式（5200+哈希）—— 6.1 km 的线写着 29.088 km',
    expect: ['里程与文案必须同源'], script: 'test-core.js',
    disk: ['./data/shanghai.js', 'base: 29088, spread: 1,', 'base: 5200, spread: 2000,'],
    patch: t => t,
  },
  {
    name: 'tangentoff', why: '关掉高速线夹直线 —— 29 km 全程在弯里扭（直线只剩 0.9%）',
    expect: ['缺夹直线'], script: 'test-core.js',
    disk: ['./src/align.js', 'const tangent = (opts.vMax || 80) >= 160 ? Math.round(1.6 * (opts.vMax || 80)) : 0;',
      'const tangent = 0;'],
    patch: t => t,
  },
  {
    name: 'kneemetro', why: '磁浮沿用地铁的 42 km/h 恒功拐点（直线电机被当成旋转电机）',
    expect: ['兑现不了自己写的运营口径'], script: 'test-drive.js', args: ['ml'],
    disk: ['./src/physics.js', 'const knee = st.maglev ? 0.75 * (sp.maxKmh || 80) : 42;', 'const knee = 42;'],
    patch: t => t,
  },
  {
    name: 'adhmaglev', why: '给没有轮轨的磁浮照套 Weber 粘着上限',
    expect: ['兑现不了自己写的运营口径'], script: 'test-drive.js', args: ['ml'],
    disk: ['./src/physics.js', 'const mu = st.maglev ? Infinity',
      'const mu = st.maglev ? this.adhesion(vK, env.wet) * motored * 9.81'],
    patch: t => t,
  },
  {
    name: 'gapsdiverge', why: '_gaps 绕开 SH.lineGaps 自己算（丢掉官方里程标定 = 第二个真值复活）',
    /* 必须拿 l2 试：磁浮 spread=1，`h % 1` 恒为 0，任何偏差都看不出来。
       一条判据在"参数退化"的样本上永远绿，换一条参数正常的样本才有信号。
       第 77 条把站间距收成单一入口之后，这个变异体测的就是"入口被绕过"这条路。 */
    expect: ['第二个真值'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js', 'return SH.lineGaps(this.def, this.stations);',
      'return SH.synthGaps(this.stations, this.def.base, this.def.spread);'],
    patch: t => t,
  },
  {
    name: 'lampstatic', why: '指示灯退回"所有批次同一个亮度"（面板不再反映任何东西）',
    expect: ['司机室指示灯'], script: 'test-bake.js',
    disk: ['./src/game.js', 'const k = on[o.key] ? SH.train.LAMP_ON : SH.train.LAMP_OFF;', 'const k = SH.train.LAMP_ON;'],
    patch: t => t,
  },
  {
    name: 'lampstate', why: '紧急制动灯写死成灭（真值表错，而画面看起来"一切正常"）',
    expect: ['司机室指示灯'], script: 'test-bake.js',
    disk: ['./src/game.js', 'eb: !!(tr && (tr.eb || tr.atp >= 2)),', 'eb: false,'],
    patch: t => t,
  },
  {
    name: 'cabdark', why: '撤掉司机室自己那套人工光（内饰不进世界光照网格，地下段就是剪影）',
    expect: ['司机室照明'], script: 'test-bake.js',
    disk: ['./src/train.js', 'b.light(cabLightFn(p));', 'b.light(null);', 'all'],
    patch: t => t,
  },
  {
    name: 'glassgap', why: '挡风玻璃退回只覆盖 floorY+1.01~2.03（台面与玻璃之间空 0.55 m）',
    expect: ['cab'], script: 'test-shot.js', args: ['l1'],
    disk: ['./src/train.js',
      "b.plate([0, (wTop + wBot) / 2, zPane - rk / 2], [p.width - 0.10, 0, 0], [0, wTop - wBot, -rk], [0, 0, -1], rgbOf('#0a1015'), { mat: 'glassSoft', alpha: 0.20, uv: 1 });",
      "b.plate([0, p.floorY + 1.52, zPane - rk / 2], [p.width * 0.90, 0, 0], [0, 1.02, 0], [0, 0, -1], rgbOf('#0a1015'), { mat: 'glassSoft', alpha: 0.14, uv: 1 });"],
    patch: t => t,
  },
  {
    name: 'utocam', why: 'UTO 线把相机搬回仪表台前面（观景窗位置），手柄与 TCMS 屏全在身后',
    expect: ['cab'], script: 'test-shot.js', args: ['l15'],
    disk: ['./src/game.js', 'const ez = HN - 2.90;', 'const ez = HN - (line.uto ? 1.15 : 2.90);'],
    patch: t => t,
  },
  {
    name: 'tailopen', why: '把尾端封顶去掉（车头方向故意不封，尾端跟着不封就是洞）',
    expect: ['车尾是个洞'], script: 'test-bake.js',
    /* 锚点必须**单行**且唯一。原来写的是 `closed: true, capStart: true,`——
     那是几何拆成上下两段（第 91 条的 shellSplit）之前的写法，现在
     `closed: true,` 与 `capStart: true,` 落在两行上，跨行锚点在 CRLF 仓库里
     永远找不到，于是这条负控从"报红"退化成"锚点没找到"——
     **判据还在、负控已经不测它了**，而 harness 只把它算成一次失败，
     不算"红线失效"。 */
    disk: ['./src/train.js', 'capStart: true, capEnd: true,', 'capStart: false, capEnd: false,'],
    patch: t => t,
  },
  {
    name: 'leverflat', why: 'leverAngle 退回常数 0（手柄"存在但从不转"，正是修好之前的状态）',
    expect: ['司机室手柄'], script: 'test-bake.js',
    disk: ['./src/train.js', 'function leverAngle(which, notch) {', 'function leverAngle(which, notch) { return 0;'],
    patch: t => t,
  },
  {
    name: 'leversplit', why: '两只手柄都跟整根级位轴动（双柄分工被抹平，它们会互相穿进对方）',
    expect: ['司机室手柄'], script: 'test-bake.js',
    disk: ['./src/train.js', 'return clamp(notch, -8, 0) / 8 * 27 * d;', 'return (notch > 0 ? notch : 0) * 6 * d;'],
    patch: t => t,
  },
  /* ---- 信号机与闭塞同源（第 75 条）---- */
  {
    name: 'sigstatic', why: '信号显示写死绿灯（画面好看但说谎：占用与显示脱钩）',
    expect: ['红灯必须恰好对应'], script: 'test-traffic.js',
    disk: ['./src/traffic.js',
      'aspectAt(block, self) { return ASPECTS[Math.min(2, this.clearFrom(block, self))]; }',
      'aspectAt(block, self) { return ASPECTS[2]; }'],
    patch: t => t,
  },
  {
    name: 'sigspacing', why: '信号机退回装饰性的固定 260 m 间距（与闭塞分区脱钩）',
    expect: ['出站口', '分区入口'], script: 'test-traffic.js',
    disk: ['./src/world.js',
      'const B = SH.blocks(al, (this.cfg.stations && this.cfg.stations.length) || al.stationS.length);',
      'const B = []; for (let s = 0; s < al.total; s += 260) B.push([s, s + 260]);'],
    patch: t => t,
  },
  {
    name: 'sigcab', why: '机车信号不取"防护净空"那一档（绿灯承诺 1.5 km 而防护只给 55 m）',
    expect: ['承诺净空'], script: 'test-traffic.js',
    disk: ['./src/traffic.js', 'cab: ASPECTS[Math.min(sa.aspect.clear, byRoom)] };', 'cab: sa.aspect };'],
    patch: t => t,
  },
  {
    name: 'sigend', why: '把线路尽头当成空闲分区（blocks 表最后一条被丢掉，尽头没有车挡）',
    expect: ['尽头是车挡', '出站口'], script: 'test-traffic.js',
    disk: ['./src/align.js', 'if (i + 1 >= S.length) { out.push([lo0, hi0]); continue; }', 'if (i + 1 >= S.length) { continue; }'],
    patch: t => t,
  },
  {
    name: 'sigfrac', why: '分区起点偏离出站口（站中心+96 → +133，出站信号机不在站台末端）',
    expect: ['出站口'], script: 'test-traffic.js',
    disk: ['./src/align.js', 'const a = E[i];', 'const a = E[i] + 37;'],
    patch: t => t,
  },
  {
    name: 'sigdraw', why: '绘制循环不给信号透镜传 emi 覆盖（批次建了，灯永远不亮）',
    expect: ['绘制循环'], script: 'test-traffic.js',
    disk: ['./src/game.js',
      'if (b._sig) { this.r.draw(b, IDENT, { emi: sigEmi(b._sig) }); continue; }',
      'if (b._sig) { this.r.draw(b, IDENT); continue; }'],
    patch: t => t,
  },
  /* ---- 库区进路与调车信号（第 109 条，E3）---- */
  {
    name: 'routesig', why: '入库信号机的位置退回散抄的 from+16（进路表不再是唯一位置来源）',
    expect: ['入库信号机'], script: 'test-traffic.js',
    disk: ['./src/align.js', 'sigS: z.from + 6,', 'sigS: z.from + 16,'],
    patch: t => t,
  },
  {
    name: 'depotst', why: '入库信号机不看引道占用（库里常亮月白，被占也放行）',
    expect: ['占用'], script: 'test-traffic.js',
    disk: ['./src/game.js',
      "if (sg.kind === 'depotIn') a = disp.blockOccupied(sg.lo, sg.hi, null) ? 'stop' : 'shunt';",
      "if (sg.kind === 'depotIn') a = 'shunt';"],
    patch: t => t,
  },
  {
    name: 'shuntdes', why: '矮柱信号机不再按指定股道分派（全库蓝灯，进路指示消失）',
    expect: ['指定股道'], script: 'test-traffic.js',
    disk: ['./src/game.js',
      "else if (sg.kind === 'shunt') a = disp.shuntRoad() === sg.road ? 'shunt' : 'shuntStop';",
      "else if (sg.kind === 'shunt') a = 'shuntStop';"],
    patch: t => t,
  },
  {
    name: 'sigcap', why: 'aspectAt 的三显示天花板放宽到 3（库区月白会漫上正线）',
    expect: ['主线信号机'], script: 'test-traffic.js',
    disk: ['./src/traffic.js',
      'aspectAt(block, self) { return ASPECTS[Math.min(2, this.clearFrom(block, self))]; }',
      'aspectAt(block, self) { return ASPECTS[Math.min(3, this.clearFrom(block, self))]; }'],
    patch: t => t,
  },
  {
    name: 'moonglass', why: '月白透镜退回浅灰基色（#4c565e → #b8c4cc，灭灯也像亮着——ACES 把亮灭差压到 ~1.2×，浅灰基色连 bloom 阈值 0.62 都过了）',
    expect: ['暗玻璃'], script: 'test-traffic.js',
    disk: ['./src/world.js', "color: '#4c565e'", "color: '#b8c4cc'", 'all'],
    patch: t => t,
  },
  {
    name: 'moonglow', why: 'SIG_EMI.on 退回 0.5（暗玻璃基色下点不亮 bloom，亮灯退化成灰一点）',
    expect: ['亮灯不像灯'], script: 'test-traffic.js',
    disk: ['./src/align.js', 'SH.SIG_EMI = { on: 2.8, off: 0.03 };', 'SH.SIG_EMI = { on: 0.5, off: 0.03 };'],
    patch: t => t,
  },
  /* ---- 乘降可视化（第 110 条）---- */
  {
    name: 'noalight', why: '下车人流整段不画（车门开着，车里的人却永远不出来 —— 乘降可视化只做了一半）',
    expect: ['下车人流根本没被画出来'], script: 'test-pax.js',
    disk: ['./src/world.js', 'if (alight && alight.need > 0) {', 'if (false) {'],
    patch: t => t,
  },
  {
    name: 'alightrush', why: '下车节奏不看门的通过能力（固定 0.05 s 一个人往外冒 —— 密度是编的，不是模型的）',
    expect: ['下车节奏不跟门的通过能力走'], script: 'test-pax.js',
    disk: ['./src/world.js', 'const tIn = lag + (j * 3.4) / Math.max(1, alight.rate || 1);', 'const tIn = lag + j * 0.05;'],
    patch: t => t,
  },
  {
    name: 'boardflat', why: '上车带宽度写死 8（不看 dwellNeed —— "车厢挤、上得慢"在画面上消失）',
    expect: ['带不跟开门时长走'], script: 'test-pax.js',
    disk: ['./src/world.js', 'bandM = Math.max(1, Math.min(platQue.length, Math.round(k0 * 2.2 / Math.max(4, alight.dwellNeed))));', 'bandM = Math.max(1, Math.min(platQue.length, 8));'],
    patch: t => t,
  },
  /* ---- 驾驶室乘坐感与人物体型（第 111 条）---- */
  {
    name: 'shakeflat', why: '横移晃动从眼睛上拆掉（南京式乘坐感失效 —— 又只剩死板的固定机位）',
    expect: ['横移晃动没加在眼睛上'], script: 'test-drive.js',
    disk: ['./src/game.js', 'base[0] += f.r[0] * sh; base[2] += f.r[2] * sh;', 'base[0] += 0; base[2] += 0;'], patch: t => t,
  },
  {
    name: 'personnovar', why: '体型变体抽了签但没人画（裙装分支整段不执行 —— 人群又只剩一种轮廓）',
    expect: ['体型变体抽了签但没人画'], script: 'test-pax.js',
    disk: ['./src/world.js', '    if (q.skirt) {', '    if (false) {'], patch: t => t,
  },
  {
    name: 'cabfixoff', why: '补偿矩阵不计算（_cabFix 恒 null —— 仪表屏又跟着骑行运动一起抖）',
    expect: ['相机没算出 _cabFix'], script: 'test-drive.js',
    disk: ['./src/game.js', 'this._cabFix = SH.cabFixMatrix(still, cam);', 'this._cabFix = null;'], patch: t => t,
  },
  {
    name: 'cabfixskip', why: '司机室批次绘制不预乘补偿（矩阵算了没人用 —— 接线断在最后一厘米）',
    expect: ['司机室批次绘制没预乘 FIX'], script: 'test-drive.js',
    disk: ['./src/game.js', 'const MB = FIX ? m4mul(FIX, this.M0) : this.M0;', 'const MB = this.M0;'], patch: t => t,
  },
  /* ---- 停车标在站台端 + 丝滑发车（第 111-4 条）---- */
  {
    name: 'stopmark', why: '停车标退回站台中心（8A 的车尾又甩出站台 36 m，车头停在站台中间）',
    expect: ['SH.STOP_MARK'], script: 'test-drive.js',
    disk: ['./src/game.js', 'this.line.al.stationS[this.i0 + this.leg + 1] + SH.STOP_MARK', 'this.line.al.stationS[this.i0 + this.leg + 1]'], patch: t => t,
  },
  {
    name: 'departlag', why: '排队发车请求在关门后被吞（又要按第二次发车 —— 丝滑连接断开）',
    expect: ['发车请求被吞'], script: 'test-drive.js',
    disk: ['./src/game.js', 'if (dq) this.depart();', 'if (false) this.depart();'], patch: t => t,
  },
  /* ---- 1 号线真实报站音频（第 111-5 条）---- */
  {
    name: 'paclip', why: '发车报站不走真实音频（speakClip 通道没接上，1 号线退回系统语音合成）',
    expect: ['l1 发车报站没走真实音频'], script: 'test-drive.js',
    disk: ['./src/game.js', "this.speakClip(PA_CLIP.l1(stIdx, name, '下一站'), '列车启动，请站稳扶好。下一站，' + name + '。', '');", "this.speak('列车启动，请站稳扶好。下一站，' + name + '。', '');"], patch: t => t,
  },
  {
    name: 'paarrive', why: '到站报站不走真实音频（arriving 的 speakClip 没接上）',
    expect: ['l1 到站报站没走真实音频'], script: 'test-drive.js',
    disk: ['./src/game.js', "this.speakClip(PA_CLIP.l1(stIdx, name, '到站'), '列车已到达' + name + '站。', '');", "this.speak('列车已到达' + name + '站。', '');"], patch: t => t,
  },
  {
    name: 'paarrive250', why: '到站音频退回停稳才播（进站前 250 m 不播 —— 又晚了）',
    expect: ['到站音频没在进站前 250 m 触发'], script: 'test-drive.js',
    disk: ['./src/game.js', 'if (!this._arrived && d < 250) { this._arrived = true;', 'if (!this._arrived && d < 0) { this._arrived = true;'], patch: t => t,
  },
  {
    name: 'pabreach', why: '互斥闸失效（1 号线的欢迎/进站/开关门又漏出系统语音 —— 之前的音频没删干净）',
    expect: ['系统语音漏出'], script: 'test-drive.js',
    disk: ['./src/game.js', "function paMute(pa, line) { if (line && line.id === 'l1') {", "function paMute(pa, line) { if (line && line.id === 'never') {"], patch: t => t,
  },
  /* ---- 冒进信号与按信号停车（第 76 条）---- */
  {
    name: 'spaddetect', why: '删掉冒进信号检测（红灯变成纯装饰，冲过去什么都不发生）',
    expect: ['检测根本没接上', '取不到结算单子'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js', "if (a.key === 'stop') {", "if (false) {"],
    patch: t => t,
  },
  {
    name: 'siglimit', why: 'authority 里撤掉"占用分区入口"这道限界（只剩车尾距离，列车会停在分区内部）',
    expect: ['没有按信号停车', '一格一车'], script: 'test-traffic.js',
    disk: ['./src/traffic.js', 'if (sg.limit < best) { best = sg.limit; kind = \'signal\'; }', 'if (false) { best = sg.limit; kind = \'signal\'; }'],
    patch: t => t,
  },
  {
    name: 'sigstop', why: 'ATO 的停车目标不看红灯（自动模式自己冒进 —— 正是"信号机白做"的状态）',
    expect: ['整局冒进'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js',
      'const dSig = sigStop && sigStop.aspect.key === \'stop\' ? Math.max(0, sigStop.dist - 5) : Infinity;',
      'const dSig = Infinity;'],
    patch: t => t,
  },
  {
    name: 'spadscore', why: '冒进不扣分（检测到了但结算不认，事故与开得糙同价）',
    expect: ['结算分数没扣冒进'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js', '- rec.spad * 25 - SH.latePenalty(rec.late));', '- 0 * 25 - SH.latePenalty(rec.late));'],
    patch: t => t,
  },
  {
    name: 'kmscale', why: '把官方里程标定短路（各线退回 base+哈希 的量级近似）',
    expect: ['官方运营里程'], script: 'test-core.js',
    disk: ['./src/align.js', 'if (totalM && out.length) {', 'if (false && totalM && out.length) {'],
    patch: t => t,
  },
  /* ---- 图定运行图（第 78 条）---- */
  {
    name: 'schedflat', why: '时刻表退回"每站固定 90 s"（与逐段运行时分模型脱钩，长段永远早点）',
    expect: ['图定'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/traffic.js', 'out.push(out[i] + legSec(line.gaps[i], acc, brk, lim) + SCHED_DWELL);', 'out.push(out[i] + 90);'],
    patch: t => t,
  },
  {
    name: 'latenull', why: '晚点永远算成 0（司机台印"图点运行"，而它什么都没在看）',
    expect: ['图定'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js', 'rec.late = this.late = this.t - (this.sched[idx] - this.sched0);', 'rec.late = this.late = 0;'],
    patch: t => t,
  },
  {
    name: 'latepenalty', why: '正点扣分退回恒等于 0（晚点照记、分数照给 = 空指标）',
    expect: ['图定'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/traffic.js', 'function latePenalty(late) {', 'function latePenalty(late) { return 0;'],
    patch: t => t,
  },
  {
    name: 'shapenoload', why: 'ATO 的"级位→加速度"退回按空车算（物理知道车重，ATO 不知道）',
    expect: ['loadK', '更松的指令'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/physics.js', 'const loadK = 1 / C(ctx.load == null ? 1 : ctx.load, 0.72, 1.32);', 'const loadK = 1;'],
    patch: t => t,
  },
  {
    name: 'sighold', why: '按信号停车收得过保守（提前 900 m 就刹）—— 图定与调度不再兼容',
    expect: ['邻线列车全开'], script: 'test-drive.js', args: ['l2'],
    disk: ['./src/game.js', 'sigStop.dist - 5) : Infinity;', 'sigStop.dist - 900) : Infinity;'],
    patch: t => t,
  },
  /* ---- 开局车载由模型算（第 79 条）---- */
  {
    name: 'primenull', why: '开局车载退回"拍一个 45%"（不预跑走廊，玩家永远挤不上）',
    expect: ['沿走廊累积'], script: 'test-pax.js',
    disk: ['./src/pax.js', 'for (let i = 1; i <= i0; i++) this._serve(i, st[i]);', 'for (let i = 1; i <= 0; i++) this._serve(i, st[i]);'],
    patch: t => t,
  },
  {
    name: 'primedirty', why: '预跑的统计不清零（玩家还没接手的那半条线被算成他的成绩）',
    expect: ['预跑不得把统计留给玩家'], script: 'test-pax.js',
    disk: ['./src/pax.js', 'this.boarded = 0; this.alighted = 0; this.leftBehind = 0; this.log = [];', 'this.boarded = this.boarded;'],
    patch: t => t,
  },
{
    name: 'rubberoff', why: '胶轮转向架不分叉了（车退回钢轮，胎浮在行车道上方）',
    /* 必须 'all'：中间车与头车各有一处 `p.rubber` 分支，只改第一处的话
       头车仍然是胶轮、胎顶点照样过 40 —— 判据被"另一处没坏"糊过去。
       这正是锚点唯一性那条纪律的反面用例。 */
    expect: ['承重胎', '导向轮'], script: 'test-bake.js',
    disk: ['./src/train.js', 'p.rubber', 'false', 'all'],
    patch: t => t,
  },
  /* ---- 盾构洞口目视确认（README 欠账 ⑫）---- */
  {
    /* ⚠ 2026-10-05 全量跑到这条 **不报红**，问题在判据不在变异：
       只撤 s0/+1 一侧 → 最差门框 5.9%；把 574/575 两个洞口调用全撤 → 最差仍 4.8%，
       而 WALL_MIN = 1.5%。也就是说"门框在不在"根本没被这个量测住 —— 中央带里的
       `concrete` 不只来自门框（洞口位置附近还有别的混凝土构件），撤掉门框后视线
       还能看进管子里拿到别的面。test-shot 自己的注释说"证明门框真存在的必须是
       concrete —— 洞口这个位置上只有门框用它"，这条前提已经不成立。
       正解是给门框一个专属材质（或按横向/高度把带子收到只有门框那一圈），
       属于 README 第 83 条那一轮的活，**不在实例化这一轮里顺手改**。
       这里把 `why` 与实测一起写清楚，别让下一个读者以为 150 个全绿。 */
    name: 'portalnone', why: '洞口那圈端环与三块门框整个不建 —— 2026-10-05 起不报红，判据测不住（见上）',
    expect: ['门框没被建出来'], script: 'test-shot.js',
    disk: ['./src/world.js', 'this._tunnelPortal(s0, +1, R, yOff);', ';'],
    patch: t => t,
  },
  {
    name: 'tubewind', why: '管片内壁绕序翻面（从洞口往里看是背面剔除，黑洞变成"什么都没有"）',
    expect: ['管片内壁'], script: 'test-shot.js',
    disk: ['./src/world.js', "mat: 'segment', color: rgbOf('#8d949a'), closed: true, flip: true,",
      "mat: 'segment', color: rgbOf('#8d949a'), closed: true, flip: false,"],
    patch: t => t,
  },
  {
    name: 'crowdrail', why: '人群散布上限放开（人越过高架站的玻璃护栏，隔玻璃成半透明鬼影）',
    expect: ['越过玻璃护栏'], script: 'test-pax.js',
    disk: ['./src/world.js', 'Math.min(3.3, Math.max(0.4, offCap - platFront - 0.85))', '3.3'],
    patch: t => t,
  },
  {
    name: 'crowdyaw', why: '站台人群朝向退回世界轴对齐（排队的人不再面向屏蔽门）',
    expect: ['面向屏蔽门'], script: 'test-pax.js',
    /* 锚点必须带 `?` 前缀：staffInto（第 105 条）里也有一份同样的
       atan2 表达式，不带前缀会命中 2 处 —— harness 正确地拒绝执行，
       这条负控在 2026-10-03 的全量巡检里就是这么被抓出来的。 */
    disk: ['./src/world.js', '? Math.atan2(-side * fr.r[0], -side * fr.r[2])', '? 0'],
    patch: t => t,
  },
  {
    name: 'midlost', why: '低空档带被拿掉（走廊与远景之间又只剩贴图平地）',
    expect: ['低空档带'], script: 'test-bake.js',
    disk: ['./src/world.js', "if (rand01('midlo' + k2, side) < 0.52) continue;", "if (rand01('midlo' + k2, side) < 1.52) continue;"],
    patch: t => t,
  },
  {
    name: 'apmfullh', why: 'APM 站退回全高屏蔽门（2.56 m 门柱装在胶轮车旁边）',
    expect: ['半高安全门'], script: 'test-bake.js',
    disk: ['./src/world.js', 'apm ? 1.50 : 2.56', '2.56', 'all'],
    patch: t => t,
  },
  {
    name: 'sightclr', why: '视廊不打（city() 不再跳过视线穿过的楼群带，低机位被楼糊住）',
    expect: ['视廊'], script: 'test-facade.js',
    disk: ['./src/world.js',
      'if (clr && clr.some(c => c.side === side && ms >= c.s0 && ms <= c.s1)) continue;',
      ''],
    patch: t => t,
  },
  /* ---- 站台柱身倒计时屏：位置/大小/比例/与色环不打架（README 第 91~94 条）----
     这四条针对的是**同一个失败族**：屏建出来了、批次上传了、贴图也贴上去了，
     而玩家在站台上看不见、或者看见的是一行被拉变形的字。
     之前四次改挂点全都栽在这里，所以每一种失败方式都必须能报红。 */
  {
    name: 'ptdsmall', why: '屏缩到 0.80 m 宽（站台机位上只剩两个像素高）',
    expect: ['读不出下一班车'], script: 'test-shot.js',
    disk: ['./src/world.js', 'ptdY: 2.36, ptdW: 1.90,', 'ptdY: 2.36, ptdW: 0.80,'],
    patch: t => t,
  },
  {
    name: 'ptdbehind', why: '屏只挂在站台机位**背后** 106~132 m（几何照建，画面上什么都没有）',
    expect: ['视锥'], script: 'test-shot.js',
    disk: ['./src/world.js', 'const ptdSpan = dz => dz >= s - 20 && dz <= s + 26;', 'const ptdSpan = dz => dz >= s - 132 && dz <= s - 106;'],
    patch: t => t,
  },
  {
    name: 'ptdring', why: '柱面线路色环退回 2.60（色环穿过屏幕，绿带从屏里长出来）',
    expect: ['线路色环'], script: 'test-shot.js',
    disk: ['./src/world.js', 'pillarRing: 3.30,', 'pillarRing: 2.60,'],
    patch: t => t,
  },
  {
    name: 'ptdaspect', why: '屏高不再按 512×192 的比例算（屏上的字被拉成竖条）',
    expect: ['拉变形'], script: 'test-shot.js',
    disk: ['./src/world.js', 'PTD_H = PTD_W * 192 / 512', 'PTD_H = PTD_W * 0.62'],
    patch: t => t,
  },
  {
    /* ---- 站厅侧设施（第 96 条）：闸机组 / 售票机 / 时钟 / 导向 / 长椅 / 垃圾桶 ----
       两条负控分别打这两半判据：
       ① `nofacility` 整个设施循环不跑 —— 每站一件都没有（"代码里写了 facility"）；
       ② `facdrift` 只把**登记的横向**挪走 2.6 m、几何照旧 ——
          摆位改了而记录忘了改，两者在代码里都是"看起来对"的常数。 */
    name: 'nofacility', why: '站厅侧设施整块不建（站台只剩柱子和灯）',
    expect: ['站台上没有"这地方在运行"的证据'], script: 'test-bake.js',
    disk: ['./src/world.js', 'const stairDz = s + SH.PLATFORM_EXITS[i];', 'const stairDz = s + SH.PLATFORM_EXITS[i]; if (i >= 0) continue;'],
    patch: t => t,
  },
  {
    name: 'facdrift', why: '设施登记的横向挪走 2.6 m（摆位改了、记录忘了改）',
    expect: ['记录与烘焙出来的顶点脱钩'], script: 'test-bake.js',
    disk: ['./src/world.js', 'lat: side * gLat, dy: FL + GH / 2, mats:', 'lat: side * (gLat + 2.6), dy: FL + GH / 2, mats:'],
    patch: t => t,
  },
  {
    /* ---- 车内乘客与 AI 车载（第 97 条）----
       三条分别打三半：几何没建、人站在门区里（会被门叶切过去）、
       以及 AI 车不看时段（永远是空车 —— 而这与"画面里没人"症状完全一样，
       所以这一条只能靠"车载随时段升降"这个结果来量）。 */
    name: 'paxoff', why: '车内乘客整批不建（车窗后面是一间空亮的客室）',
    expect: ['车内乘客第 1 档只有'], script: 'test-bake.js',
    disk: ['./src/train.js', '  if (!(level >= 1)) return [];', '  if (!(level >= 1) || true) return [];'],
    patch: t => t,
  },
  {
    name: 'paxdoor', why: '站着的人被摆到门区里（门叶沿 z 滑开，会把人切过去）',
    expect: ['站在门区里'], script: 'test-bake.js',
    disk: ['./src/train.js', 'if (zone.some(q => z > q[0] - 0.30 && z < q[1] + 0.30)) continue;', ';'],
    patch: t => t,
  },
  {
    name: 'paxflat', why: 'AI 车车载写死 0（早高峰站台上开进来一列列空车）',
    expect: ['AI 车不看时段'], script: 'test-traffic.js',
    disk: ['./src/traffic.js', 'return C(r * t.loadJit * 0.62, 0, 1.25);', 'return 0;'],
    patch: t => t,
  },
  {
    name: 'paxcal', why: '车载系数退回 0.92（平峰也有 98% 满的车开进站，而单调性判据照样全绿）',
    expect: ['应落在'], script: 'test-traffic.js',
    disk: ['./src/traffic.js', 'return C(r * t.loadJit * 0.62, 0, 1.25);', 'return C(r * t.loadJit * 0.92, 0, 1.25);'],
    patch: t => t,
  },
  /* ---- 站台外侧的站厅墙（第 98 条）----
     判据量的是材质而不是亮度（亮度随曝光/自发光动，材质不会）。
     变异把站厅那面墙的材质从 `tiles` 换回 `concreteD` ——
     站台外侧于是退回箱涵那种深色混凝土，站台机位实拍暗部近半幅，
     而站体占比、天空占比这些构图判据一点都不会动。 */
  {
    name: 'darkwall', why: '站厅那面浅色面砖墙退回深色混凝土（站台外侧一片暗）',
    expect: ['站厅该是浅色面砖'], script: 'test-bake.js',
    disk: ['./src/world.js', "{ mat: 'tiles', color: rgbOf('#e6ebee'), closed: false, uvAlong: 1 / 1.2, vSpan: 4.4 / 1.2 }",
      "{ mat: 'concreteD', color: rgbOf('#e6ebee'), closed: false, uvAlong: 1 / 1.2, vSpan: 4.4 / 1.2 }"],
    patch: t => t,
  },
  {
    name: 'platshift', why: '把站台机位从黄线外推到站体以外的街面（站位 ×90），站体占比应塌',
    /* 红字原文（test-shot.js:730）是「站台机位全站体只占 X（应 ≥ Y）—— 相机没站在站里」，
       这一节里没有「站台机位进深比」这五个字（上一版按记忆写了词条，与 ptddir 同一种错：
       expect 必须从实跑红字里逐字抄）。
       **变异幅度也按灵敏度写进文档**（与 `sighold` 同一条纪律）：`side*40` 实测 31 条红字，
       但没有一条出自这条判据 —— 相机退到车行道里仍看得见站体盒，占比没掉过 BODY_MIN；
       退到 `side*90`（越过人行道 64 m、站到地块带上）才塌到阈值以下。
       所以这条钉的是"相机彻底站在站外"，钉不住 40 m 那一档的构图退化。 */
    expect: ['站台机位全站体只占'], script: 'test-shot.js', args: ['l11'],
    /* 站位已收成 `SH.PLAT_CAM`（§7.10 那一轮），所以这里改的是"调用点被推到站外"，
       不再是那个 3.5 的字面量 —— 上一次这个锚点被自己的重构弄断，靠预检档当场抓到。 */
    disk: ['./src/game.js', 'const e = al.world(fe, side * SH.PLAT_CAM.lat, SH.PLAT_CAM.eye);',
      'const e = al.world(fe, side * 90, SH.PLAT_CAM.eye);'],
    patch: t => t,
  },
  /* ---- 时刻与环境（第 99 条：时间是死的）----
     这一族四条分别打四半：天光退回恒为黄昏、时钟不前进、发车密度不随时段、
     收车时刻不生效。它们都是"代码里写了但没人调用 / 调用链断了"的形态，
     在画面上表现为"画面一直很好看但永远是同一张"，没有任何渲染判据看得见。 */
  {
    name: 'envdusk', why: 'envFor 退回恒取 ENVS.dusk（天光又变成死配置，选夜间也是黄昏）',
    expect: ['没有调用 SH.envAt', '恒为黄昏'], script: './test-env.js',
    disk: ['./src/game.js', 'let T = SH.envAt(this.hourNow);', 'let T = SH.ENVS.dusk;'],
    patch: t => t,
  },
  {
    name: 'flatclock', why: '时钟不随运行前进（"时间是死的"回到原样，天光永不变化）',
    expect: ['时钟没有随运行前进'], script: './test-env.js',
    disk: ['./src/game.js', 'if (this.running && dt > 0) this.clock += dt;', 'if (this.running && dt > 0) this.clock = this.clock;'],
    patch: t => t,
  },
  {
    name: 'ptdclock', why: '站台屏钟点退回调度器的 elapsed clock（屏上的钟与天光/收车不是同一条时间轴）',
    expect: ['站台屏钟点没有读 App 的钟'], script: './test-env.js',
    disk: ['./src/game.js', 'return this.clockText();', 'return String(Math.floor((this.traffic ? this.traffic.clock : 0) / 60));'],
    patch: t => t,
  },
  {
    name: 'headflat', why: '发车头时不再乘时段密度系数（夜里与早高峰一样密 —— 时段只影响客流不影响运力）',
    expect: ['夜/高峰头时比'], script: './test-env.js',
    disk: ['./src/traffic.js', 'this.headwayMin = (opt.headwayMin || HEADWAY[line.baseId] || HEADWAY[line.id] || 4) * this.density;', 'this.headwayMin = (opt.headwayMin || HEADWAY[line.baseId] || HEADWAY[line.id] || 4);'],
    patch: t => t,
  },
  {
    name: 'nodensity', why: '密度系数写成常数（深夜不再稀疏，`SH.headwayFactor` 变成装饰）',
    expect: ['夜 > 平峰 > 高峰'], script: './test-env.js',
    disk: ['./src/traffic.js', '(h >= 22 || h < 5) ? 2.0 : 1.3;', '(h >= 22 || h < 5) ? 1.0 : 1.3;'],
    patch: t => t,
  },
  {
    name: 'noservice', why: '末班之后照旧把车底投回正线（收车时刻只是个没人读的常数）',
    expect: ['末班之后折返车没有收车'], script: './test-env.js',
    disk: ['./src/traffic.js', "if (this.wallClock() >= SH.SERVICE.last) { t.state = 'stabled'; continue; }", "if (false) { t.state = 'stabled'; continue; }"],
    patch: t => t,
  },
  /* ---- 站台乘降可视化（第 101 条）----
     五条分别打五半：人群没从世界网格拆出来、拆出来但从不释放（漏 GPU 缓冲）、
     建了但从不更新、更新时"随机少人"而不是"门口那批人先上车"、
     以及每次重建整片人群重排（画面上是人原地闪烁）。
     它们的共同点是**截图上都看不出来**：站台上都有人、人数都在变，
     只有量"保留的是不是同一批人的前缀""被截掉的是谁"才分得清。 */
  {
    name: 'crowdrout', why: '人群没有从世界网格拆出来（`crowdB` 置空，它又烘死了）',
    expect: ['独立批次'], script: './test-pax.js',
    disk: ['./src/game.js', 'wb.crowdB = cb;', 'wb.crowdB = null;'],
    patch: t => t,
  },
  {
    name: 'crowdkeep', why: '重建前不释放旧的人群批次（每次重建漏一组 GPU 缓冲）',
    expect: ['释放旧的人群批次'], script: './test-pax.js',
    disk: ['./src/game.js', "this.r.dropTag('crowd');", "this.r.dropTag('crowdX');", 'all'],
    patch: t => t,
  },
  {
    name: 'crowdsync', why: '人群批次建了但从不更新（`syncCrowd` 调用被注释掉）',
    expect: ['每帧同步人群'], script: './test-pax.js',
    disk: ['./src/game.js', 'this.syncCrowd(dt);', '/* this.syncCrowd(dt); */'],
    patch: t => t,
  },
  {
    name: 'crowdorder', why: '排队者比例退回固定 62%（截掉的人与总体同分布，"随机少几个人"）',
    expect: ['先走的是门口那批人'], script: './test-pax.js',
    disk: ['./src/world.js', "const queuing = rand01('crowdq' + seed, i) < (0.42 + 0.58 * (i / 240));", 'const queuing = R() < 0.62;'],
    patch: t => t,
  },
  {
    name: 'crowdprefix', why: '发射前按"是否排队"排序（每次重建整片人群重排，人原地闪烁）',
    expect: ['同一批人的前缀'], script: './test-pax.js',
    disk: ['./src/world.js', 'for (let i = 0; i < P.length; i++) {', 'P.sort((a, z) => (a.queuing ? 1 : 0) - (z.queuing ? 1 : 0)); for (let i = 0; i < P.length; i++) {'],
    patch: t => t,
  },
  /* ---- 车门两片叶 / 乘降动线（第 112 条）---- */
  {
    name: 'doorleaf', why: '两片门叶塞回同一个 Builder（一个矩阵只能一个方向 —— 门只开一半、两片叠在一侧）',
    expect: ['没有分成 doorsA/doorsB 两批'], script: './test-bake.js',
    disk: ['./src/train.js',
      'const bb = side < 0 ? (dir < 0 ? doorsAL : doorsBL) : (dir < 0 ? doorsAR : doorsBR);',
      'const bb = side < 0 ? doorsAL : doorsAR;', 'all'],
    patch: t => t,
  },
  {
    name: 'doorshort', why: '门叶滑动量写死 0.72（1.4 m 的门够、浦江线 1.6 m 的门差 8 cm：门洞右沿仍压着一条门页）',
    expect: ['开门后门洞没有整幅让开'], script: './test-bake.js',
    disk: ['./src/train.js', 'const doorSlide = p => p.doorW / 2 + 0.02;', 'const doorSlide = p => 0.72;'],
    patch: t => t,
  },
  {
    name: 'doorprofile', why: '绘制路径取错车型档案（外层 TrainView 没有 this.p，门叶滑动量读到 undefined —— 离线判据全绿、一开浏览器就 TypeError）',
    expect: ["reading 'doorW'"], script: './test-bake.js',
    disk: ['./src/game.js', 'SH.train.doorSlide(this.profile)', 'SH.train.doorSlide(this.p)', 'all'],
    patch: t => t,
  },
  {
    name: 'exitsingle', why: '楼梯几何退回写死的 -70/+105（下车人流的终点与楼梯口各说各话 —— 单点化是假的）',
    expect: ['都从 SH.PLATFORM_EXITS 取里程'], script: './test-pax.js',
    disk: ['./src/world.js', 'const dz = s + SH.PLATFORM_EXITS[i];', 'const dz = s - 70 + i * 105;'],
    patch: t => t,
  },
  {
    name: 'exitend', why: '下车人流退回"走向站台端头"（人走到站台尽头凭空消失，那里既没有楼梯也没有出口）',
    expect: ['终点跟着搬', '步行者的终点集合'], script: './test-pax.js',
    disk: ['./src/world.js', 'const EX = (exits && exits.length) ? exits', 'const EX = false ? exits'],
    patch: t => t,
  },
  {
    name: 'noturn', why: '末段拐向梯段的升降整段不生效（人走到梯口但不上下楼，横向也不拐）',
    expect: ['走在通往出入口的最后一段', '转身朝向梯段'], script: './test-pax.js',
    /* 10-06 轮锚点更新：`ex.up || 1` 已修成 `ex.up == null ? 1 : ex.up`（显式 0 是
       有效值——对向站台没有梯段），末段升降这条变异跟着换到新行，语义不变。 */
    disk: ['./src/world.js', 'dy = k * 1.15 * (ex.up == null ? 1 : ex.up);', 'dy = 0;'],
    patch: t => t,
  },
  {
    name: 'walkkill', why: '下车人流过程立刻结束（门一关站台上的人又瞬间撤下 —— 第 112 条修的就是这个）',
    expect: ['时钟没有继续走'], script: './test-drive.js',
    disk: ['./src/game.js', 'return e.t > SH.egressSec(e.need, e.rate);', 'return true;'],
    patch: t => t,
  },
  {
    name: 'walknodist', why: '下车人流过程不按"列车把它甩远"结束（每次停站之后人群批次持续重建几十秒 —— CPU 白烧）',
    expect: ['甩出可视范围，下车人流过程还在'], script: './test-drive.js',
    disk: ['./src/game.js', 'if (ss != null && Math.abs(this.s - ss) > SH.EGRESS_KEEP) return true;', 'if (false) return true;'],
    patch: t => t,
  },
  /* ---- 换乘类型与走行时间（第 102 条）----
     四条分别打四半：共线判定放宽（把还接别的线的 5 站也抹成"同站台"）、
     出站换乘没标、客流系数不按类型给、报站措辞不按类型给。
     它们都是"数据/措辞错了一档"的形态 —— 站台照旧有人、屏照旧有字，看不出来。 */
  {
    name: 'xfershare', why: '共线判定放宽成"在共线段上就算同站台"（中山公园等 5 站的真换乘被抹掉）',
    expect: ['共线段上仍接别的线'], script: './test-transfer.js',
    disk: ['./data/shanghai.js',
      "const type = (shared.has(n) && ls.length === 2) ? 'shared' : (OUT[n] ? 'out' : 'in');",
      "const type = shared.has(n) ? 'shared' : (OUT[n] ? 'out' : 'in');"],
    patch: t => t,
  },
  {
    name: 'xferout', why: '浦东南路退回"站内换乘"（出站换乘当成站内换乘，走行时间差三分钟）',
    expect: ['浦东南路'], script: './test-transfer.js',
    disk: ['./data/shanghai.js', 'const OUT = { 浦东南路: 1, 金海路: 1 };', 'const OUT = { 金海路: 1 };'],
    patch: t => t,
  },
  {
    name: 'xferpax', why: '出站换乘的客流系数退回站内那一档（换乘意愿差一档这件事没有落到模型里）',
    expect: ['按类型给的'], script: './test-transfer.js',
    disk: ['./src/pax.js', '    : M.type === \'out\' ? 1.30 + 0.12 * (h % 3)', '    : M.type === \'out\' ? 1.55 + 0.25 * (h % 3)'],
    patch: t => t,
  },
  {
    name: 'xferann', why: '报站措辞不分类型（出站换乘也播"站内换乘"）',
    expect: ['出站换乘'], script: './test-transfer.js',
    disk: ['./src/game.js',
      "      const tag = !M ? '站内换乘' : M.type === 'out' ? '出站换乘' : M.type === 'shared' ? '同站台' : '站内换乘';",
      "      const tag = '站内换乘';"],
    patch: t => t,
  },
  /* ---- 运营信息（第 103 条）：站台屏拥挤度、停站时分随车载、司机台正点偏差 ---- */
  {
    name: 'ptdcrowd', why: '站台屏不报拥挤度（屏上只剩倒计时，站台没法判断该不该等这一班）',
    expect: ['应报'], script: './test-traffic.js',
    disk: ['./src/traffic.js',
      "const crowd = load == null ? '' : load >= 0.95 ? '很拥挤' : load >= 0.7 ? '较拥挤' : load >= 0.4 ? '一般' : '有座位';",
      "const crowd = '';"],
    patch: t => t,
  },
  {
    name: 'dwellload', why: '停站时分不随车载变（客流对站台作业时分没有影响）',
    expect: ['停站时分没有随车载'], script: './test-traffic.js',
    disk: ['./src/traffic.js',
      'return C(base + 4 * (crowd - 0.5) + (t.dwellJit || 0) + reg, 8, 128);',
      'return C(base + (t.dwellJit || 0) + reg, 8, 128);'],
    patch: t => t,
  },
  {
    name: 'hudlate', why: '司机台不显示正点偏差（司机在车上看不见自己早了还是晚了）',
    expect: ['正点偏差'], script: './test-traffic.js',
    disk: ['./src/game.js',
      "    set('led-clock', app.clockText() + (Math.abs(lateS) > 15 ? (lateS > 0 ? ' 晚点 +' + lateS + 's' : ' 早点 ' + lateS + 's') : ''));",
      "    set('led-clock', app.clockText());"],
    patch: t => t,
  },
  /* ---- 进站信号机（第 104 条）---- */
  {
    name: 'entrysig', why: '进站信号机整批不铺（全线只剩出站信号机，"进站"在信号上没有凭证）',
    expect: ['没有进站信号机'], script: './test-traffic.js',
    disk: ['./src/world.js', '      const s = al.stationS[i] - SH.STATION_HALF;', '      const s = -1e9;'],
    patch: t => t,
  },
  /* ---- 站务员（第 105 条）---- */
  {
    name: 'nostaff', why: '站务员整批不建（站台上没有人管，只剩随机剪影的人群）',
    expect: ['件 staff'], script: './test-bake.js',
    disk: ['./src/world.js', '      SH.WorldBuilder.staffInto(this.b, al, board, s, staff);', '      ;'],
    patch: t => t,
  },
  /* ---- 雨天（D4）与门区/车内分布（B3 / C5）/ 人群细节（D1）/ 高架站设施（B2b）----
     这一组对应 2026-10-03 那一轮：test-env 的 E/F 两组判据、test-pax 的 D1 组、
     test-bake 的 B2b 扩展覆盖。 */
  {
    name: 'norainenv', why: 'envFor 不再把天光交给 envRainy 调制（雨天天光死回晴天）',
    expect: ['envRainy'], script: './test-env.js',
    disk: ['./src/game.js', 'if (this.rain) T = SH.envRainy(T);', '      ;'],
    patch: t => t,
  },
  {
    name: 'nowetslip', why: '物理 env 不带 wet（湿轨黏着与制动距离和晴天完全一样）',
    expect: ['没有带 wet'], script: './test-env.js',
    disk: ['./src/game.js', 'wet: !!(this.app.settings && this.app.settings.rain) || !!this.app.rain,', 'wet: false,'],
    /* expect 写红字里真的会出现的那几个字：nowetslip 的红字是「没有带 wet」 */
    patch: t => t,
  },
  {
    name: 'nowsp', why: '制动不再被黏着限制（雨天紧急制动距离与干轨相同，防滑器形同虚设）',
    expect: ['制动距离'], script: './test-env.js',
    disk: ['./src/physics.js', 'const brakeAccel = Math.min(brakeAccelRaw, brakeAdh);', 'const brakeAccel = brakeAccelRaw;'],
    patch: t => t,
  },
  {
    name: 'norainsnd', why: '雨声增益算出来了却没送到增益节点（rainGain 是个空函数）',
    expect: ['雨声两层增益'], script: './test-env.js',
    disk: ['./src/audio.js', 'this.g.rainHiss.g.gain.setTargetAtTime(rg.hiss, now, 0.4);', '      ;'],
    patch: t => t,
  },
  {
    name: 'norainpax', why: '客流不再随雨天放大（天气与客流脱钩）',
    expect: ['雨天客流系数'], script: './test-env.js',
    disk: ['./src/pax.js', 'return rain ? f * RAIN_PAX : f;', 'return f;'],
    patch: t => t,
  },
  {
    name: 'wiperstatic', why: '雨刮画成静态矩阵（烘焙批次的老病：雨天雨刮纹丝不动）',
    expect: ['雨刮角'], script: './test-env.js',
    disk: ['./src/game.js', 'const MW = m4mul(MB, m4trs(o.pivot, [1, 1, 1], 0, 0, -o.side * wA));', 'const MW = MB;'],
    patch: t => t,
  },
  {
    name: 'doorlampdead', why: '车门提示灯"开到位"档不亮（亮灭与门状态脱钩）',
    expect: ['门灯'], script: './test-env.js',
    disk: ['./src/train.js', 'if (o > 0.85) return LAMP_ON;', 'if (o > 0.85) return LAMP_OFF;'],
    patch: t => t,
  },
  {
    name: 'paxflatcar', why: '各节车厢档位退回同一档（C5 的逐节分布没有生效）',
    expect: ['逐节分布没有生效'], script: './test-env.js',
    disk: ['./src/train.js', 'for (let i = 0; i < n; i++) out.push(Math.max(0, Math.min(3, Math.round(base + CAR_PAX_OFF[(i + rot) % 4]))));',
      'for (let i = 0; i < n; i++) out.push(base);'],
    patch: t => t,
  },
  {
    name: 'nofacopen', why: '露天站的闸机线被推到 1 km 外（高架化线路的站厅设施整体失踪）',
    expect: ['只有登记没有几何'], script: './test-bake.js',
    disk: ['./src/world.js', 'const FBack = open_ ? PLAT_FRONT + pw + 0.20 : STATION_X.mezzIn;', 'const FBack = open_ ? 1e9 : STATION_X.mezzIn;'],
    patch: t => t,
  },
  {
    name: 'crowdbare', why: '人群退回两块盒子（没有头发/手臂/手机的细节，剪影人群）',
    expect: ['人均'], script: './test-pax.js',
    disk: ['./src/world.js', "b.box([hr[0], hr[1], hr[2]], [0.185, 0.05, 0.195], rgbOf(q.hair), { mat: 'paint', yaw: q.yawJ });", '      ;'],
    patch: t => t,
  },
  {
    /* 分类器把站区尺度抄回字面量（不走 SH.STATION_HALF）。基线上它与真值恒等
       —— 红线必须用量测才能存在：常数探针（基线 96→126，幅度 30 m 超过分类器
       10 m 量化的 12 m 容差）下站区边缘搬不动即报红。
       这一条同时钉住 P4 的前置「分类器单点化」：以后双线断面改尺度时，
       不许有任何消费者还揣着 96 这份私有答案。 */
    name: 'halfcl', why: '分类器站区旁路单点常数（ns.d<96 抄回字面量）',
    expect: ['分类器站区'], script: './test-traffic.js',
    disk: ['./src/world.js', 'ns.d < SH.STATION_HALF', 'ns.d < 96'],
    patch: t => t,
  },
  {
    /* blocks 无视 stationSignals，自己按字面量抄一份整表：基线上与单点恒等（96），
       探针下分区边界与站区尺度脱钩。量的还是那根柱子 —— 出站信号机必须站在分区边界上。
       （只旁路 `a` 不旁路 `b` 是不成立的缺陷：上一段的 hi 仍会把 want 补上，判据不会红。
       负控必须整体换掉 E 这一份表才量得到"两份公式"这件事。） */
    name: 'halfblk', why: 'blocks 绕过 stationSignals 另算出站口（双源漂移）',
    expect: ['出站口'], script: './test-traffic.js',
    disk: ['./src/align.js', 'const E = SH.stationSignals(al);', 'const E = S.map(s => Math.min(s + 96, al.total));'],
    patch: t => t,
  },

  /* ---- 双线断面与对向车队（第 108 条）----
     几何三根（对向轨横向单点 / 箱内贯通 / 隧道不烘）+ 运行时四根
     （镜像里程 / 站侧恒定 / 种子分队 / 方向映射），各钉一根柱子。 */

  {
    /* 对向轨横向写死 4.0 而不走 oppLat：side=+1 的线对向轨压到正线外侧
       （U2 报红），side=−1 的线看起来"恰好正确"（U2/U3 都绿）—— 所以
       这条的红线只来自常数探针：SH.TRACK_OFFSET 改 +1 后对向轨必须跟着
       搬家，写死的字面量搬不动。探针红与站台边无关，全线通用。锚点命中
       3 处（高架区间 / 高架车站 / 地下箱体），必须 'all' —— 只改第一处，
       箱体断面的探针还在走 oppLat，抓不住。 */
    name: 'trackoff', why: '对向轨横向写死 4.0（不走 SH.TRACK_OFFSET 单点）',
    expect: ['搬家'], script: './test-xsect.js',
    disk: ['./src/world.js', 'lat: oppLat', 'lat: 4.0', 'all'],
    patch: t => t,
  },
  {
    /* 岛式接缝三条（第 122 条），各打一个不同的失效面：
       islandflat  —— 函数立了但加宽没进公式（岛式站形同虚设）；
       islandside  —— 往站台式那一侧加宽，对向轨会穿越本线/压进站台；
       islandall   —— 不看站型表就把所有站当岛式，**接缝反过来越权改了既有线间距**。
       第三条尤其重要：它钉的是"这一步不改产品"，没有它，谁都能把 20 条线的
       线间距静默加宽 8 m 而没人报红。 */
    name: 'islandflat', why: '岛式加宽算了但没进公式（站心对向轨还在区间线间距上）',
    expect: ['岛式站心'], script: './test-xsect.js',
    disk: ['./src/world.js', '  const wide = -side * SH.islandSpan();', '  const wide = base;'],
    patch: t => t,
  },
  {
    name: 'islandside', why: '岛式往站台式那一侧加宽（对向轨穿越本线、压进站台底下）',
    expect: ['岛式站心'], script: './test-xsect.js',
    disk: ['./src/world.js', '  const wide = -side * SH.islandSpan();', '  const wide = side * SH.islandSpan();'],
    patch: t => t,
  },
  {
    name: 'islandall', why: '不查站型表就把每一站都当岛式（接缝越权改掉既有线间距）',
    /* B 口径后重锚：judge 从"空表回归锁"升级为"区间回归锁" —— 加宽只许发生在
       岛式站区（按 platType 判），漏到区间/侧式站区即红。 */
    expect: ['加宽泄漏到了不该动的里程'], script: './test-xsect.js',
    disk: ['./src/world.js', "  if (!name || SH.platType(name) !== 'island') return base;",
      '  if (false) return base;'],
    patch: t => t,
  },
  {
    /* B 阶段第 1 步的口径负控：默认档被砍掉（一律侧式）—— 地下站没判成岛式，
       加宽整个消失。expect 命中两处：岛式判定与岛式站心加宽。 */
    name: 'islanddef', why: '地下站默认岛式的口径被砍（一律侧式，加宽整个消失）',
    expect: ['没判成岛式', '没落在'], script: './test-xsect.js',
    disk: ['./src/world.js',
      "  return f && f.lines > 0 && f.elev === 0 ? 'island' : 'side';",
      "  return 'side';"],
    patch: t => t,
  },
  {
    /* B 第 2 层：岛式站体不建（两股道之间空空如也，对向站台照旧）——
       "岛式"只剩线间距加宽，站台上还是看不见岛。 */
    name: 'islandnoplat', why: '岛式站体不建（加宽了但岛没长出来）',
    expect: ['岛式站体不在位'], script: './test-xsect.js',
    disk: ['./src/world.js', '    const prof = boardRect(pw, -1.0, 0.42);', '    const prof = boardRect(0.02, -1.0, 0.42);'],
    patch: t => t,
  },
  {
    /* B 第 2 层：farPlatform/对向人群对岛式没关 —— 凭空造出第三座站体，
       断面上 granite hi 顶到 14 以上，烘焙里对向侧还有人。 */
    name: 'islandfar', why: 'farPlatform 对岛式站不关闭',
    expect: ['farPlatform 没关', '没随岛式关闭'], script: './test-xsect.js',
    disk: ['./src/world.js', '    if (!island) this.farPlatform(s, side, opt, rect);', '    this.farPlatform(s, side, opt, rect);'],
    patch: t => t,
  },
  {
    /* B 第 2 层 ④：开门侧换边只做了一半 —— 还有调用点直读 stationSide，
       岛式站的门开在空的那一侧（站台在对面）。 */
    name: 'boardflip', why: '开门侧换边有漏网的 stationSide 直读',
    expect: ['开门侧必须全部走 boardSideAt'], script: './test-pax.js',
    disk: ['./src/game.js', 'const doorSide = this.line ? SH.boardSideAt(this.line, sHead) : 1;',
      'const doorSide = this.line ? this.line.stationSide(0) : 1;', 'all'],
    patch: t => t,
  },
  {
    /* 地下站箱内的引入段整段不铺：站台中心 ±80 m 内钢轨顶点为 0，司机
       进站时车轮悬空。U1 只认 ±16 m 断面窗里的正线钢轨 —— 隧道分支与
       出站分支的轨都停在站区外 ≥96 m，补不进窗里。 */
    name: 'oppinbox', why: '地下站箱内的引入段轨道整段不铺（站台中心 ±80 m 无轨）',
    expect: ['没有正线钢轨'], script: './test-xsect.js',
    disk: ['./src/world.js', 'else wb.track(Math.max(s0, ss - 235), z, {});', 'else ;'],
    patch: t => t,
  },
  {
    /* 隧道是双洞，本洞里看不见对面方向的车 —— 隧道分支烘对向轨等于把
       对向车画进本洞。T4 取离站 >140 m 的隧道中点断面，对向轨一进洞就
       落在量测窗里（measured −4±0.75）。 */
    name: 'opptune', why: '隧道区间（双洞）里照烘对向轨（本洞里看得见对向车）',
    expect: ['出现了对向股道'], script: './test-xsect.js',
    disk: ['./src/world.js', 'else wb.track(a, z, { step: 3 });',
      'else { wb.track(a, z, { step: 3 }); wb.track(a, z, { step: 3, ballast: false, catenary: false, lat: oppLat, signage: false }); }'],
    patch: t => t,
  },
  {
    /* 镜像站表必须换算成**代理里程**（u = total − s）且升序：降序实里程
       让 SH.blocks（len = b − a > 0 才建分区）塌成空表、_nextMark 的升序
       走表失效 —— 对向车永不停站。④ 只认"分区边界上站着出站信号机"，
       空表里什么都站不出来。 */
    name: 'oppmirror', why: '镜像站表不换算成代理里程（对向分区表塌成空表、永不停站）',
    expect: ['出站信号'], script: './test-traffic.js',
    disk: ['./src/game.js', 'stationS: al.stationS.slice().reverse().map(s => total - s),', 'stationS: al.stationS.slice(),'],
    patch: t => t,
  },
  {
    /* 站台边逐站哈希：连续的物理股道在站间"换轨"（对向轨横向位置逐段
       跳变），有的站的对向轨直接压到站台底下。U5 钉的是"一条线的站台
       恒在同一侧"这条地理事实。 */
    name: 'oppside', why: '站台边逐站哈希（连续物理股道在站间换轨，对向轨压到站台底下）',
    expect: ['不许换边'], script: './test-xsect.js',
    disk: ['./src/game.js', 'const h = hash32(this.id, 31);', 'const h = hash32(this.id + this.stations[i], 31);'],
    patch: t => t,
  },
  {
    /* loadJit 种子不分队：两队同序号车底的乘客偏置逐列完全相同，两队
       并排进站时人群一模一样 —— ② 用 seedTag 区分两队。 */
    name: 'oppseed', why: 'loadJit 种子不分队（两队同序号车底乘客偏置逐列相同）',
    expect: ['逐列相同'], script: './test-traffic.js',
    disk: ['./src/traffic.js', "'load' + (disp.line.seedTag || disp.line.id)", "'load' + disp.line.id"],
    patch: t => t,
  },
  {
    /* 镜像线形映射回正向（at(u) = al.at(u)）：对向车在"同一条线上顺向
       跑"—— 站序、坡度全错。③ 逐点核对 u ↔ total − u 的位置映射与坡度
       取反，u = 500 与 total − 500 两端必红。 */
    name: 'oppdir', why: '镜像线形映射回正向（at(u) = al.at(u)：对向车在同一条线上顺向跑）',
    expect: ['方向映射错了'], script: './test-traffic.js',
    disk: ['./src/game.js', 'const r = al.at(total - u);', 'const r = al.at(u);'],
    patch: t => t,
  },
  {
    /* 套跑交路扁平化（不按配比混跑，所有车均为 main）：共线段站台屏永远
       翻不出支线终点。② 断言主支线必须同时有车，且南京东路屏必须翻出航中路。 */
    name: 'interflat', why: '套跑交路扁平化（共线段全按主线跑，未按配比混跑）',
    expect: ['主支线未混跑'], script: './test-traffic.js',
    /* 10-06 轮锚点更新：套跑机制已从"一队内发 svc 标记 + 分岔口脱网"改成
       "两个交路各一个调度器、按 ratio 切开同一支车队"（第 121 条）。
       变异等价：linkInterline 直接不配对侧车队 —— 支线运力清零，混跑消失。 */
    disk: ['./src/traffic.js', '  if (!(share < 1)) return null;', '  if (true) return null;'],
    patch: t => t,
  },
  {
    /* 分岔站后漏滤支线（后方下行站台屏串线）：上海动物园屏上串出往航中路。
       ④ 断言分岔站后下行站 100% 隔离另一支线列车。 */
    name: 'interleak', why: '分岔站后漏滤支线列车（后方下行站台屏串线）',
    expect: ['支线车泄漏'], script: './test-traffic.js',
    /* 旧的 `t.svc !== line.svc → continue` 那道过滤早就不在了：套跑改造
       （第 121 条）之后"分岔后不并对侧车队"是由 nextTrain 的 onTrunk 闸门
       实现的。变异等价：让闸门恒开，干线屏就会把对侧车队的终点报出来。 */
    disk: ['./src/traffic.js',
      '  const onTrunk = !(inter && inter.forkIdx >= 0) || stationIdx <= inter.forkIdx;',
      '  const onTrunk = true;'],
    patch: t => t,
  },
  {
    /* 车门单侧开启退化为双侧开启（两边门页均滑开）：
       车站靠站时非站台侧（轨道/隧道侧）车门必须保持锁闭静止。
       断言：非站台侧门叶位移必须为 0，且非站台侧提示灯不点亮。 */
    name: 'bothdoors', why: '车门双侧开启（非站台侧车门也滑开）',
    expect: ['未实现单侧开门'], script: './test-bake.js', args: ['1号线'],
    disk: ['./src/game.js',
      'const MLA = doorSide < 0 ? Ma : M, MLB = doorSide < 0 ? Mb : M;',
      'const MLA = Ma, MLB = Mb;', 'all'],
    patch: t => t,
  },
  {
    /* 站内换乘车站漏建换乘通道 3D 几何：
       对于 SH.INTER_META 中 type === 'in' 的车站，未生成通道门洞、箱体、导向牌。
       断言：换乘站必须 100% 生成 transferPassage 设施与导向标识。 */
    name: 'notransfergeom', why: '站内换乘站漏建换乘通道 3D 几何',
    expect: ['全部生成 transferPassage 3D 换乘通道'], script: './test-transfer.js',
    disk: ['./src/world.js',
      "if (interMeta && interMeta.type === 'in' && interList.length > 0 && plan.legs.length) {",
      "if (false && interMeta && interMeta.type === 'in' && interList.length > 0 && plan.legs.length) {"],
    patch: t => t,
  },
  {
    /* AI 车站台客流闭环漏发下车事件 / 站台客流未闭环：
       AI 列车停站开门后未触发 onEgress 下车人流事件与上车带。
       断言：AI 列车停站必须派发 onEgress 且真实消耗站台候乘人数。 */
    name: 'noaipax', why: 'AI 列车停站未触发站台客流事件闭环',
    expect: ['未触发 onEgress 下车人流事件'], script: './test-traffic.js',
    disk: ['./src/traffic.js',
      'if (this.onEgress && wantOff > 0) {',
      'if (false && this.onEgress && wantOff > 0) {'],
    patch: t => t,
  },
  /* ---- 实例化通道（AI 车中段车 + renderer 的 GL 通道）----
     这一族判据在 test-env.js 的 G 节与渲染上下文红线里，两条腿：
     录制型 renderer 逐 (批次,矩阵) 对账 + 源码 lint。实景那一腿是 dev/inst-check.js。 */
  {
    name: 'instmat', why: '中段车实例矩阵全部退回首节车的矩阵（六节车叠在一处）',
    expect: ['实例矩阵没有逐车变化', '交出的 (批次,矩阵) 不一致'], script: './test-env.js',
    /* 9b 后重锚：矩阵列收进了 _drawMidInstanced 的调用点（AI 与玩家共用一个方法，
       矩阵各自在外面拼好传进去）。 */
    disk: ['./src/game.js', 'this._drawMidInstanced(mid, mid.map(i => ms[i])', 'this._drawMidInstanced(mid, mid.map(() => ms[0])'],
    patch: t => t,
  },
  {
    name: 'instpaxall', why: '乘客分档实例化退化成"只要有档就全车画"（人数凭空翻倍）',
    expect: ['交出的 (批次,矩阵) 不一致'], script: './test-env.js',
    disk: ['./src/game.js', 'for (let k = 0; k < midIdx.length; k++) if (lv[midIdx[k]] > j) mats.push(midMs[k]);',
      'for (let k = 0; k < midIdx.length; k++) if (lv[midIdx[k]] > 0) mats.push(midMs[k]);'],
    patch: t => t,
  },
  {
    name: 'instdoornotslide', why: '门页滑移没有并进每实例矩阵（门开着而门页不动）',
    expect: ['交出的 (批次,矩阵) 不一致'], script: './test-env.js',
    disk: ['./src/game.js',
      'const Ma = midMs.map(M => m4mul(M, OSa)), Mb = midMs.map(M => m4mul(M, OSb));',
      'const Ma = midMs, Mb = midMs;'],
    patch: t => t,
  },
  {
    name: 'instfastoff', why: '有 drawInstanced 却不走 fast path（这一轮优化整个静默失效）',
    expect: ['fast path 断了'], script: './test-env.js',
    disk: ['./src/game.js', 'if (this.r.drawInstanced && this.midCarB) {', 'if (false) {', 'all'],
    patch: t => t,
  },
  {
    name: 'instnobackend', why: '回退守卫被拆（GL1/桩渲染器下直接调用不存在的 drawInstanced）',
    expect: ['抛错'], script: './test-env.js',
    disk: ['./src/game.js', 'if (this.r.drawInstanced && this.midCarB) {', 'if (this.midCarB) {', 'all'],
    patch: t => t,
  },
  {
    name: 'rsshader', why: '实例基变换退回点乘（Rᵀ：直线看不出来，弯道上的车歪着走）',
    expect: ['点乘式实例变换', '列向量的线性组合'], script: './test-env.js',
    disk: ['./src/renderer.js',
      'p = aI0.xyz * aPos.x + aI1.xyz * aPos.y + aI2.xyz * aPos.z + aI3.xyz;',
      'p = vec3(dot(aI0.xyz, aPos), dot(aI1.xyz, aPos), dot(aI2.xyz, aPos)) + aI3.xyz;'],
    patch: t => t,
  },
  {
    name: 'rsbatch', why: '实例数没传给 _drawBatch（GL 只画第 1 个实例，draw 数却照降）',
    expect: ['没把实例数交给 _drawBatch'], script: './test-env.js',
    disk: ['./src/renderer.js', 'this._drawBatch(b, ov, n);', 'this._drawBatch(b, ov);'],
    patch: t => t,
  },
  {
    name: 'rsinst', why: '离开实例化通道不把 uInst 归 0（后续每批普通绘制被实例矩阵再乘一遍）',
    expect: ['没有把 uInst 归 0'], script: './test-env.js',
    disk: ['./src/renderer.js', 'gl.uniform1f(u.inst, 0);', ''],
    patch: t => t,
  },

  /* ---- 对向站台（诚实清单 §7.2）----
     派人 / 分桶 / 侧别 / 接线，四根柱子各配一条真改源码的负控。 */
  {
    /* farPlatform 的对向候乘烘进静态世界批次 —— 撤掉它，test-bake 的
       顶点级对账（paint 材质、对向侧人群带）直接量到 0。 */
    name: 'farpcrowd', why: '对向站台不烘候乘人群（对面站台空着）',
    expect: ['对向候乘人群顶点'], script: './test-bake.js',
    /* 锚点必须落在 farPlatform 自己的那次调用上：第 3 层给岛式站也加了一次
       `opt.crowdOpp` 判断，锚 `if (opt.crowdOpp != null) {` 会命中 2 处。 */
    disk: ['./src/world.js', 'SH.WorldBuilder.crowdInto(this.b, al, sg, PLAT_FRONT, s0, s1,',
      'if (0) SH.WorldBuilder.crowdInto(this.b, al, sg, PLAT_FRONT, s0, s1,'],
    patch: t => t,
  },
  {
    /* waitingAt 忽略方向参数：'#opp' 桶退化成正向桶 —— 对向车服务的还是
       本侧候乘，两侧人数永远相等。判据"两个数全等就是没换桶"当场报红。 */
    name: 'oppbucket', why: '对向候乘不换桶（waitingAt 忽略方向，两侧同人数）',
    expect: ['全等就是没换桶'], script: './test-pax.js',
    disk: ['./src/pax.js', "const key = dir < 0 ? name + '#opp' : name;", 'const key = name;'],
    patch: t => t,
  },
  {
    /* crowdStationFar 的 side 忘了取负：对向车在对面开门、下车人却从本侧
       门里走出来 —— 修掉前的真实缺陷。判据"不落在本侧站台（应为 0）"报红。 */
    name: 'farpside', why: '对向下车人流画到本侧站台（side 忘了取负）',
    expect: ['不落在本侧站台'], script: './test-pax.js',
    disk: ['./src/world.js', 'const side = -line.stationSide(i);', 'const side = line.stationSide(i);'],
    patch: t => t,
  },
  {
    /* onEgress 不给对向过程打标记：syncCrowd 分不清侧别，对向人流要么画错侧、
       要么不画。接线判据（源码 lint）报红。 */
    name: 'oppmark', why: '对向下车过程不打 opp 标记（syncCrowd 分不清侧别）',
    expect: ['打 opp 标记'], script: './test-pax.js',
    disk: ['./src/game.js', 'this.session.egress.push({ ...e, at, opp: isOpp });', 'this.session.egress.push({ ...e, at, opp: false });'],
    patch: t => t,
  },

  /* ---- 按图运行（诚实清单 §7.7）----
     晚点记账 / 压停站补偿 / 首班出车，三根柱子各配一条真改源码的负控。 */
  {
    /* 到站时刻不与图定链对账（t.late 恒 0）：晚点永远不会被记账，
       补偿与正点率全部变成死数据。判据"晚点没有记账"报红。 */
    name: 'nolate', why: '晚点不记账（t.late 恒 0，t.late 字段回到死字段状态）',
    expect: ['晚点没有记账'], script: './test-traffic.js',
    disk: ['./src/traffic.js', 't.late = C(this.clock - t.planArr, -45, 900);', 't.late = 0;'],
    patch: t => t,
  },
  {
    /* 撤掉压停站补偿：注入 2 分钟晚点后再也收不回来 —— 判据"末值应 ≤ 峰值−30"报红。 */
    name: 'norecov', why: '晚点补偿不生效（没有压停站赶点这一层）',
    expect: ['赶点没有生效'], script: './test-traffic.js',
    disk: ['./src/traffic.js', 'if (t.late > 20 && !t.reg) t.dwell = Math.max(12, t.dwell - Math.min(12, (t.late - 20) * 0.3));', ''],
    patch: t => t,
  },
  {
    /* 出场时刻不写：全部车底开局就在正线上（回到"一开局凭空满线"），
       判据"开局在场应恰好 1 列"报红。 */
    name: 'noexit', why: '首班出车不生效（车底不按运行图错峰出场）',
    expect: ['应恰好'], script: './test-traffic.js',
    disk: ['./src/traffic.js', 't.enterAt = SH.SERVICE.first + i * this.headwayMin * 60;', 't.enterAt = null;'],
    patch: t => t,
  },
  {
    /* 磁浮折返作业退回 90 s：两列车跑成 4.9 min 的实际头时，名义 8 min 是假的
       （§7.8 的原始缺陷状态）。判据"名义值是假的"报红。 */
    name: 'mllay', why: '磁浮折返不做长作业（端头实际头时 4.9 min，名义 8 min 不成立）',
    expect: ['名义值是假的'], script: './test-traffic.js',
    disk: ['./src/traffic.js', 'return Math.max(90, this.n * this.headwayMin * 60 - this.al.total / this.vAvg);', 'return 90;'],
    patch: t => t,
  },

  /* ---- 行人相位与汽车信号联动（§7.9）----
     联锁 / 过街时长，各配一条真改源码的负控。 */
  {
    /* walkLamp 恒 don't：行人灯变成贴在杆上的装饰，联动名存实亡。
       判据"行人通行 0 s"报红。 */
    name: 'nowalk', why: '行人灯恒禁行（相位联动不存在，行人灯是装饰）',
    expect: ['人还没过完街就变灯'], script: './test-street.js',
    disk: ['./src/core.js', "if (t < p0 || t >= 2 * p0) return 'dont';", "return 'dont';"],
    patch: t => t,
  },
  {
    /* 行人通行窗口压到机动车绿灯上：人车冲突 —— 联锁的安全属性被拆掉。
       判据"重叠 N 秒"报红。 */
    name: 'pedclash', why: '行人通行与机动车绿灯重叠（联锁的安全属性被拆掉）',
    expect: ['人车冲突'], script: './test-street.js',
    disk: ['./src/core.js', "if (t < p0 || t >= 2 * p0) return 'dont';", "if (t >= 2 * p0) return 'dont';"],
    patch: t => t,
  },
  /* ---- B 阶段第 3 层：岛式站付费区上岛 ---- */
  {
    /* 箱涵远端墙退回第 2 层的 board×10.65（"岛背后留 0.6 m"）——
       对向股道在 board×12.1，于是墙夹在岛的对向缘口与对向股道之间：
       那条缘口的黄线/盲道/屏蔽门/门头梁全在，却正对着一堵墙，
       对向车被挡在墙外（岛式站的**定义性画面**不成立）。
       判据：test-xsect 量 hi 带 concrete 的最远横向。 */
    name: 'islandwall', why: '岛式箱涵远端墙退回 10.65（夹在岛的对向缘口与对向股道之间）',
    expect: ['没越过对向股道'], script: './test-xsect.js',
    disk: ['./src/world.js', "const WALLF = island ? board * (SH.islandSpan() + PLAT_FRONT + 1.6) : -side * boxW;",
      "const WALLF = island ? board * 10.65 : -side * boxW;"],
    patch: t => t,
  },
  {
    /* 对向候乘不建（第 2 层的状态）：岛的对向缘空着，等对向车的人一个都没有。
       判据：test-bake 数岛的对向缘那一带的 paint 顶点。 */
    name: 'islcrowd', why: '岛式站的对向候乘不建（第 2 层的状态：对向缘空着）',
    expect: ['对向候乘没分到岛缘'], script: './test-bake.js',
    disk: ['./src/world.js', "SH.WorldBuilder.crowdInto(this.b, al, board, FAR0 - 0.85, s0, s1,",
      "if (0) SH.WorldBuilder.crowdInto(this.b, al, board, FAR0 - 0.85, s0, s1,"],
    patch: t => t,
  },
  {
    /* 付费区上岛整块不建：岛上方没有站厅板，梯体也没了。
       侧式那几条断言一个字都不看岛（probe 只量 lat>0），只有 test-mezz 的
       岛式那一节抓得到。 */
    name: 'islmezz', why: '岛式站付费区上岛整块不建（岛上没有站厅板与梯体）',
    expect: ['付费区没上岛'], script: './test-mezz.js',
    disk: ['./src/world.js', "if (island && !open) {", "if (false) {"],
    patch: t => t,
  },
  {
    /* 烘焙期本侧候乘退回 side（岛式站的人整批站在正线对面的走廊里）——
       而运行时重建读 board，开门那一刻人原地跳到岛上。 */
    name: 'crowdside', why: '烘焙期本侧候乘退回 side（岛式站候乘站在走廊侧）',
    expect: ['烘焙路径没读 board'], script: './test-bake.js',
    disk: ['./src/world.js', "this.crowd(s, board, PLAT_FRONT, s0, s1, opt.seed || 1,",
      "this.crowd(s, side, PLAT_FRONT, s0, s1, opt.seed || 1,", 'all'],
    patch: t => t,
  },
  /* ---- 贴图（第 19 个自测 test-tex）---- */
  {
    /* 站台花岗岩一个循环从 4×4 块板改成 3×3：缝的条数从 4 变 3。
       判据：test-tex ② 数一条板中心线上的局部极小（缝）。 */
    name: 'texflat', why: '花岗岩一个循环 4×4 块板改成 3×3（缝的条数不对）',
    expect: ['应为 4'], script: './test-tex.js',
    disk: ['./src/textures.js', "const S = 1024, N = 4, cell = S / N;", "const S = 1024, N = 3, cell = S / N;"],
    patch: t => t,
  },
  {
    /* 站台板 vSpan 退回 1：U 与 V 的"米/循环"差 15.7 倍（600 mm 方砖被拉成长条）。
       判据：test-tex ③ 从烘焙出来的网格量 UV 梯度。 */
    name: 'texvspan', why: '站台板 vSpan 退回 1（方砖被拉成长条）',
    expect: ['各向异性'], script: './test-tex.js',
    disk: ['./src/world.js', "uvAlong: 1 / 2.4, vSpan: (pw + 1.42) * 2 / 2.4 });", "uvAlong: 1 / 2.4, vSpan: 1 });"],
    patch: t => t,
  },
  {
    /* 釉面反光从"周期余弦"换成"从顶到底线性衰减"：平铺处相位对不上，
       接缝那道落差超过图内任何一条边。判据：test-tex ① 比平铺接缝与图内最大列/行差。
       （2026-10-08 expect 对齐：判据文案已改成"纵向不周期…平铺处会裂开"，
       旧 expect '不可平铺' 是文案改版前的化石。） */
    name: 'texseam', why: '釉面反光退回非周期（平铺处接不上）',
    expect: ['纵向不周期'], script: './test-tex.js',
    disk: ['./src/textures.js', "b += (0.5 + 0.5 * Math.cos(sy / TH * Math.PI * 2)) * 0.030;", "b += (j / S) * 0.30;"],
    patch: t => t,
  },
  {
    /* BVE 解析器整块返回空：1 号线列车会**静默**退回程序化车体 ——
       19 个套件里没有任何一条看得见（模型是浏览器里 fetch 下来的）。
       判据：test-train 的「BVE 列车模型」一节，它自己从磁盘读 CSV 量几何。 */
    name: 'bveempty', why: 'BVE 解析器返回空（1 号线列车静默退回程序化车体）',
    expect: ['子网格只有'], script: './test-train.js',
    disk: ['./src/bve.js', 'function parse(text) {', 'function parse(text) { return [];'],
    patch: t => t,
  },
  /* ---- A 轨 Phase A（2026-10-08）：test-gles.js 的五条负控 ----
     共同点：缺陷全是"静默"的 —— 离线套件不跑真 GL，着色器/后端面的退化
     在 19 个几何套件里一个像素都看不出来，只有 test-gles 的静态断言钉得住。 */
  {
    /* ESSL 3.00 的版本头必须在模板串第一个字符。丢了它 shader 按 1.00 解析，
       in/out 全是语法错 —— 但 SwiftShader 宽松翻译器未必立刻死给你看。 */
    name: 'gles100', why: 'SCENE_FS 摘掉 ES 3.00 版本头（着色器按 1.00 解析）',
    expect: ['版本头'], script: './test-gles.js',
    disk: ['./src/renderer.js', 'const SCENE_FS = `#version 300 es', 'const SCENE_FS = `'],
    patch: t => t,
  },
  {
    /* texture2D 在 ESSL 3.00 里是编译错（texture() 取代）—— 残留一处，
       真机启动即 fatal 覆盖层。 */
    name: 'gtex2d', why: 'SCENE_FS 的 texture( 写回 ESSL 1.00 的 texture2D(',
    expect: ['texture2D'], script: './test-gles.js',
    disk: ['./src/renderer.js', 'tx = texture(uTex, wv);', 'tx = texture2D(uTex, wv);'],
    patch: t => t,
  },
  {
    /* GL1 回退分支接回来一行 —— 决策（丢弃 WebGL1）被静默推翻。 */
    name: 'gvaogl1', why: "构造器接回 getContext('webgl',…) 回退（WebGL1 决策被推翻）",
    expect: ['WebGL1 痕迹残留'], script: './test-gles.js',
    disk: ['./src/renderer.js', "const gl = canvas.getContext('webgl2', opt);",
      "const gl = canvas.getContext('webgl2', opt) || canvas.getContext('webgl', opt);"],
    patch: t => t,
  },
  {
    /* 删掉 resolve：场景渲进 MSAA FBO 却没人把它搬回单采样纹理，
       后期链读到的是上一帧的残影/空纹理 —— 静默黑屏一族。 */
    name: 'gmsaa', why: '删掉 end() 里的 blitFramebuffer resolve（后期链读到空纹理）',
    expect: ['blitFramebuffer'], script: './test-gles.js',
    disk: ['./src/renderer.js', 'gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);', ''],
    patch: t => t,
  },
  {
    /* C 轨接口缺口 D1 复发：game.js 再把 .gl 递出去，WebGPU 后端
       SignAtlas 恒吃 2048 兜底，站牌图集容量少一半走 fallback 色。 */
    name: 'gbestsize', why: 'game.js 两处调用点退回 bestSize(this.r.gl)（C 轨缺口 D1 复发）',
    expect: ['bestSize 调用面'], script: './test-gles.js',
    disk: ['./src/game.js', 'bestSize(this.r.maxTexSize())', 'bestSize(this.r.gl)', 'all'],
    patch: t => t,
  },
  /* ---- A 轨 帧循环零分配（2026-10-08）：test-perf.js 的六条负控 ----
     这一族的缺陷全是"静默的性能退化"——把每帧分配塞回提交路径，画面照画、
     套件照绿，只有帧时分布会说话。所以每条都必须被 test-perf 抓住报红。 */
  {
    /* begin 又把 vec3 现算成 new Float32Array —— 每帧 ~10 个短命数组回来了。 */
    name: 'perfalloc', why: 'begin 的 uniform 上传退回每帧 new Float32Array（GC 压力回来了）',
    expect: ['begin 的方法体里出现 new Float32Array'], script: './test-perf.js',
    disk: ['./src/renderer.js', 'gl.uniform3fv(this.u.eye, _set3(_u3, cam.eye));',
      'gl.uniform3fv(this.u.eye, new Float32Array(cam.eye));'],
    patch: t => t,
  },
  {
    /* _drawSky 又把位置查询搬回帧内 —— 每帧 13 次按名查驱动字符串表。 */
    name: 'perfloc', why: '_drawSky 帧内重新调用 getUniformLocation（位置表缓存被绕过）',
    expect: ['_drawSky 的方法体里有 getUniformLocation'], script: './test-perf.js',
    disk: ['./src/renderer.js', 'gl.uniform3fv(L.uRight, r);',
      "gl.uniform3fv(gl.getUniformLocation(this.pgSky, 'uRight'), r);"],
    patch: t => t,
  },
  {
    /* draw 的覆盖参数兜底又每帧新建对象 —— 驾驶室档每帧几百次。 */
    name: 'perfempty', why: 'draw 的 ov 兜底退回 ov = ov || {}（每帧几百个短命对象）',
    expect: ['draw 的 ov = ov || {} 又回来了'], script: './test-perf.js',
    disk: ['./src/renderer.js', 'ov = ov || EMPTY;   // 149 条 perf/GC：每帧几百次 draw 的共享只读兜底（_drawBatch 只读不写）',
      'ov = ov || {};'],
    patch: t => t,
  },
  {
    /* 实例数据缓冲不再复用 —— 每组实例一次 KB 级分配（街面车流按组分批）。 */
    name: 'perfinst', why: 'drawInstanced 退回每调用 new Float32Array(n*STR)',
    expect: ['drawInstanced 又在每调用'], script: './test-perf.js',
    disk: ['./src/renderer.js', 'const data = this._instData.subarray(0, n * STR);',
      'const data = new Float32Array(n * STR);'],
    patch: t => t,
  },
  {
    /* envFor 的 envAt 分桶缓存失效 —— 天光每帧重算，~30 个数组/帧回来了。 */
    name: 'perfenv', why: 'envFor 每帧重算 envAt（分桶缓存被拆）',
    expect: ['envFor 的 envAt 分桶缓存'], script: './test-perf.js',
    disk: ['./src/game.js', 'if (!this._envT || this._envT.k !== kb)', 'if (true)'],
    patch: t => t,
  },
  {
    /* PERF 成对打点被拆 —— 子系统归因静默失效，帧循环里再塞大件没人看得见。 */
    name: 'perfpair', why: 'frame 循环缺 PERF.frameStart/close（?perf=1 归因失效）',
    expect: ['PERF.frameStart/close'], script: './test-perf.js',
    disk: ['./src/game.js', 'PERF.frameStart();', 'void 0;'],
    patch: t => t,
  },
];

/* 这个 harness 自己也要防"空跑"：第一版忘了把 `NEG` 传进子进程环境，
   四个注入变体跑的全是原始代码 → rc=0、零红字，看起来像"红线抓不住缺陷"，
   其实是变异根本没生效。所以下面几处都钉死：
   ① 注入必须真的改变了文本（锚点写错 = 静默 no-op）；
   ② 锚点命中多处而未标 'all' 时报错跳过 —— 变异只改第一处等于改了别的地方；
   ③ 子进程必须带上 NEG 环境变量；
   ④ 判据只在红字行里找（"平稳"这种词在正常输出里也有，会假命中）；
   ⑤ 结尾计数数的是"这一趟真跑了几个"，不是 muts.length。
   改磁盘的变异必须备份 + finally 还原 + 逐字节校验；**别 kill 正在跑它的进程**
   （被杀时 finally 不执行，源码会留在变异状态 —— 真实事故，见 README 第 82 条）。 */
const NL = String.fromCharCode(10);
/* 这个 harness 会**改磁盘上的源码**，所以它必须能从中断里自愈。
   真实事故：一次 `timeout 200 node dev/negctl.js` 把子进程杀掉，`finally` 里的还原
   没跑，于是 `b.light(null);` 留在 src/train.js 的三个位置上 —— 全部 20 条线的
   司机室人工光被悄悄撤掉，而下一个读者以为那是好代码。
   两道保险：① 每次运行前先还原任何残留的 .negctl-bak；
   ② 进程退出 / SIGINT / SIGTERM 时立刻还原当前正在变异的那个文件。
   **② 在 Windows 上是空头承诺**（实测：SIGINT 与 SIGTERM 各打断一次，钩子都没跑，
   两边都把源码留在了变异状态）—— Windows 杀进程走 TerminateProcess，用户代码没有
   机会执行。所以真正兜底的只有 ①，② 只在 POSIX 或正常退出（含未捕获异常）时生效。
   这条实测结论本身就是 ① 必须存在的原因：不能把源码的完整性押在钩子上。 */
const diskTargets = Array.from(new Set(muts.filter(m => m.disk).map(m => m.disk[0])));
for (const f of diskTargets) {
  const bak = f + '.negctl-bak';
  if (fs.existsSync(bak)) {
    fs.writeFileSync(f, fs.readFileSync(bak));
    fs.rmSync(bak);
    console.log('⚠ 发现上次中断留下的备份，已还原 ' + f + ' —— 它之前处于变异状态');
  }
}
let pending = null;
function restorePending() {
  if (!pending) return;
  try {
    fs.writeFileSync(pending.f, pending.bak);
    if (fs.existsSync(pending.bakName)) fs.rmSync(pending.bakName);
    console.log('⚠ 中断还原 ' + pending.f);
  } catch (e) { console.log('✗ 中断还原失败：' + pending.f + ' ' + e.message); }
  pending = null;
}
process.on('exit', restorePending);
for (const sig of ['SIGINT', 'SIGTERM']) { try { process.on(sig, restorePending); } catch (e) {} }

/* 全量跑一趟 45 分钟，而锚点写错是**静默 no-op** —— 变异没生效，判据照样绿，
   要等整趟跑完才知道。所以先给一个只核锚点的档：NEGCTL_ANCHORS=1 时一个测试脚本
   都不跑、也不碰磁盘，几秒钟把"锚点在不在、唯一不唯一"全部报出来。
   顺带把 expect 词条也在对应判据脚本里逐字找一遍：本轮 `ptddir` / `platshift` 两条
   就是被一个不存在的词条读成"负控失效"的（判据其实报了红）。
   注意两件事：① 红字是模板字符串（`${n} 件 ${k}`），逐字找不到只作**提醒**不作结论；
   ② 这一档读的是磁盘上的 `src/*.js`，**不要与全量同时跑**（那时文件正处在变异状态）。 */
if (process.env.NEGCTL_ANCHORS) {
  let bad = 0, warn = 0;
  const scriptText = {};
  for (const mu of muts) {
    const sc = mu.script || './test-drive.js';
    if (!(sc in scriptText)) { try { scriptText[sc] = fs.readFileSync(sc, 'utf8'); } catch (e) { scriptText[sc] = ''; } }
    const miss = (mu.expect || []).filter(k => !scriptText[sc].includes(k));
    if (miss.length) { warn++; console.log(`  ? ${mu.name.padEnd(13)} ${miss.map(s => `「${s}」`).join('')} 在 ${sc} 里逐字找不到（插值红字属正常，人工再判）`); }
    if (!mu.disk) {
      if (mu.patch(orig) === orig) { bad++; console.log(`✗ ${mu.name.padEnd(13)} 文本注入锚点没匹配上 —— 变异不会生效`); }
      continue;
    }
    const t = fs.readFileSync(mu.disk[0], 'utf8');
    const hits = t.split(mu.disk[1]).length - 1;
    if (hits < 1) { bad++; console.log(`✗ ${mu.name.padEnd(13)} ${mu.disk[0]} 锚点命中 0 —— 变异不会生效`); }
    else if (hits > 1 && mu.disk[3] !== 'all') { bad++; console.log(`✗ ${mu.name.padEnd(13)} ${mu.disk[0]} 锚点命中 ${hits} 处且未标 'all' —— 变异只会改第一处`); }
  }
  if (warn) console.log(NL + `以上 ${warn} 条的 expect 词条要人工对一眼红字原文`);
  console.log(bad ? NL + `✗ ${muts.length} 条变异里 ${bad} 条锚点有问题` : NL + `✓ ${muts.length} 条变异的锚点都在且唯一（或已标 all）`);
  process.exit(bad ? 1 : 0);
}

let fails = 0, ran = 0;
const only = process.argv.slice(2);
for (const mu of muts) {
  if (only.length && only.indexOf(mu.name) < 0) continue;
  ran++;
  const patched = mu.patch(orig);
  if (!mu.disk && patched === orig) {
    console.log(`✗ 负控 ${mu.name.padEnd(9)} 注入锚点没匹配上，变异根本没生效`);
    fails++; continue;
  }
  if (mu.file !== 'core') fs.writeFileSync(TMP, patched, 'utf8');
  let bk = null;
  if (mu.disk) {
    bk = fs.readFileSync(mu.disk[0]);
    const t = bk.toString('utf8');
    const hits = t.split(mu.disk[1]).length - 1;
    if (hits < 1) {                                       // 锚点写错就是静默 no-op
      console.log(`✗ 负控 ${mu.name.padEnd(9)} ${mu.disk[0]} 里的锚点没找到，变异没有生效`);
      fails++; try { fs.writeFileSync(mu.disk[0], bk); } catch (e) {}
      continue;
    }
    /* 锚点命中多处而变异只改第一处 = **静默改了别的地方**。
       `cabdark` 就是这么失效的：把 `b.light(cabLightFn(p))` 撤掉这条变异只替换
       第一个匹配，而那一处已经是指示灯排了 —— 内饰光根本没被撤，负控照样绿。 */
    if (hits > 1 && mu.disk[3] !== 'all') {
      console.log(`✗ 负控 ${mu.name.padEnd(9)} 锚点在 ${mu.disk[0]} 里命中 ${hits} 处且不唯一 —— 变异只会改第一处，等于改了别的地方；要么收紧锚点，要么标 'all'`);
      fails++; try { fs.writeFileSync(mu.disk[0], bk); } catch (e) {}
      continue;
    }
    /* 落盘变异**之前**先立还原日志：原稿逐字节抄进 .negctl-bak 并记下 pending。
       正常路径由 finally 删掉它；进程被 SIGKILL 时，它是下次启动扫描的还原来源。 */
    fs.writeFileSync(mu.disk[0] + '.negctl-bak', bk);
    pending = { f: mu.disk[0], bak: bk, bakName: mu.disk[0] + '.negctl-bak' };
    fs.writeFileSync(mu.disk[0], mu.disk[3] === 'all' ? t.split(mu.disk[1]).join(mu.disk[2]) : t.replace(mu.disk[1], mu.disk[2]), 'utf8');
  }
  let out = '', rc = 0;
  try {
    const args = mu.script ? [mu.script].concat(mu.args || []) : [TMP, 'l2', 'l3'];
    const r = cp.spawnSync(process.execPath, args,
      { encoding: 'utf8', timeout: 900000, env: Object.assign({}, process.env, { NEG: mu.name }) });
    out = (r.stdout || '') + (r.stderr || '');
    rc = r.status === null ? -1 : r.status;
  } finally {
    if (bk !== null) {
      fs.writeFileSync(mu.disk[0], bk);                     // 逐字节还原
      const now = fs.readFileSync(mu.disk[0]);
      if (!now.equals(bk)) { console.log('✗ ' + mu.name + ' 还原失败，' + mu.disk[0] + ' 与备份不一致！'); fails++; }
      fs.rmSync(mu.disk[0] + '.negctl-bak', { force: true });
      pending = null;
    }
  }
  /* 红字的方言不止一种：多数判据印 `✗`，但 test-bake.js 印 `FAIL:`。
     只认一种会让"针对另一种方言的负控"永远数到零红字 —— 判据确实报红了，
     负控却说没报，等于负控自己瞎。 */
  const reds = out.split(NL).filter(l => l.includes('✗') || l.includes('FAIL:'));
  const redTxt = reds.join(NL);
  const hit = mu.expect.filter(k => redTxt.includes(k));
  const ok = rc !== 0 && reds.length > 0 && hit.length > 0;
  if (!ok) fails++;
  console.log(`${ok ? '✓' : '✗'} 负控 ${mu.name.padEnd(11)} ${mu.why}`);
  console.log(`    rc=${rc} 红字 ${reds.length} 条；命中判据：${hit.join(' / ') || '（没有命中预期的那条）'}`);
  if (!ok) console.log('    ' + reds.slice(0, 3).map(l => l.trim()).join(NL + '    '));
}
fs.rmSync(TMP, { force: true });
console.log(fails ? NL + '✗ ' + ran + ' 个负控里有 ' + fails + ' 个未报红 —— 对应的红线是装饰性的'
                  : NL + '✓ ' + ran + ' 个负控全部按预期报红');
process.exit(fails ? 1 : 0);
