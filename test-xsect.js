/** 高架站横断面判据（第 12 个离线自测）。
 *
 * 为什么单独一个文件：雨棚偏出站台外 3 m、站台板压住正线这两件事，我在两张俯瞰
 * 截图里都没看出来 —— 顶视图里"棚板"和"站台"都是长条带，偏了也只是两条并排的带子。
 * 唯一能回答"棚子罩没罩住站台、站台板有没有越过中心线"的办法，是把烘焙出来的
 * 三角形按材质取出来，投影到"距线路中心的横向距离"上量一遍。
 *
 * 判据（对每条线的 side=+1 与 side=−1 两类车站各测一处，两类都必须过）：
 *   ① 站台板整体在站台那一侧，且横向区间 = SH.STATION_X 给的那一段；
 *   ② 雨棚与站台板的横向重叠 ≥ 90% 站台宽（"棚罩台"）；
 *   ③ 站台面高度（+0.3~+0.7 m）的任何车站构件不得越过线路中心线（"台不压轨"）；
 *   ④ 护栏与灯带落在棚板范围之内。
 * 用法：node test-xsect.js [线路id,...]
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
const X = SH.STATION_X;
/** 限界内合法存在的材质：钢轨、扣件、道床板 */
/** 只查"站台那一侧的东西"越不越线：concrete 里有第三轨（横向 1.2~1.5 m、
    顶面 +0.40，本来就该在限界内）、桥墩、洞口、基地，全都不该报；
    站台板/黄线/盲道/门头梁/色带/屏蔽门框/护栏才是越线就是事故的那些。 */
const GAUGE_MUST_NOT = new Set(['granite', 'paint', 'glassSoft', 'metal']);

/** 建一个断面窗口（默认车站中心，可传任意里程 sC），返回"按 side 转正后
 *  的横向坐标"分材质统计 + 钢轨横向位置表 */
function section(line, si, sC) {
  const al = line.al, s = sC == null ? al.stationS[si] : sC, side = line.stationSide(si);
  const wb = new SH.WorldBuilder({ al, color: line.color, color2: line.color2, stations: line.stations,
    sign: new SH.textures.SignAtlas(1024), night: 0.62, profile: line.profile });
  wb.sun = null; wb._installLight();
  SH.WorldBuilder.buildRuns(wb, line, Math.max(0, s - 170), Math.min(al.total, s + 60), null);
  const f = al.frame(s), c = f.p, out = new Map(), railLats = [];
  /* 这一站有没有对向股道 —— 问**烘焙器自己**（buildRuns 把 `_oppLat` 挂上去就是它的答复），
     不在判据里再抄一份"磁浮/胶轮是单线"的式子：那两份迟早漂移。
     单线构造的线路（磁浮、浦江线 APM）对面那块镜像板不在本判据管辖内 ——
     它没有股道可"对向"，把它算成对向站台是判据越权。 */
  const hasOpp = !!wb._oppLat;
  /* 空档宽度 = 这一站对向股道的横向（`_oppLat` 与烘焙同一份，岛式站区会加宽）；
     岛式站台本来就在两股道之间，那一格由 B 阶段的判据负责。 */
  const gapW = hasOpp ? Math.abs(wb._oppLat(s)) : 0;
  const island = SH.platType(line.stations[si]) === 'island';
  let gapHit = 0;
  for (const [mat, b] of wb.b.buckets) {
    for (let i = 0; i < b.pos.length; i += 3) {
      const d = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
      if (Math.abs(d[0] * f.f[0] + d[1] * f.f[1] + d[2] * f.f[2]) > 16) continue;
      const lat = (d[0] * f.r[0] + d[1] * f.r[1] + d[2] * f.r[2]) * side;
      const up = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
      /* 量程 18：岛式站的箱涵远端墙在 board×(islandSpan+front+1.6) ≈ 15.75，
         原来卡在 14 会把它整个丢掉（"远端墙越过对向股道"那条断言就量不到）。 */
      if (Math.abs(lat) > 18) continue;
      /* 钢轨横向位置单独记录（第 108 条）：轨在 up −0.06，不落在任何高度带里，
         "对向轨在不在、两股道间空不空"量的是 rail 顶点的横向坐标。 */
      if (mat === 'rail') railLats.push(lat);
      /* 分高度带统计。不分带的话 tiles 会把地下站厅吊顶、墙面压顶条一起算进来，
         横向区间永远是 -10.9~+5.75，"雨棚罩住站台"这条就变成了一句永远成立的话
         （负控 noofcover 第一次就是这么绿的）。 */
      const band = up > 3.5 ? 'hi' : up > 0.2 && up < 0.9 ? 'lo'
        : (up > -0.25 && up < 0.25 ? 'dk' : null);
      if (!band) continue;
      /* ---- 两股道之间的空档（2026-10-06 新增）----
         旧检查只看 `|lat| < 1.90`（"站台板不许压住正线"），而**对向**那条股道在 −4：
         一块关于线路中心镜像过来的站台板摆在 −2.05~−5.55，内缘距对向轨中心正好
         1.95 m —— 差 5 cm，永远漏过去。实量结果：对向侧 granite 顶点 −2.05~−3.10、
         黄线 −2.40、屏蔽门柱 −2.06，而钢轨在 −3.14~−4.86，板子把整条对向股道埋了。
         正确的口径是"两条股道之间除了轨排那一族，什么都不许有"。 */
      if (band === 'lo' && hasOpp && !island && GAUGE_MUST_NOT.has(mat) && lat < -0.95 && lat > -gapW + 0.95) gapHit++;
      /* 分侧记账：一座站现在有**两座侧式站台**（本线一侧 + 对向一侧），
         不分侧的话 `granite|lo` 的横向区间永远是 −5.55~+5.55，
         "站台板应在 2.05~5.55"这条就量不到任何东西（实测第一版假红 15 处）。 */
      /* `lat` 已经被 side 转正过，所以"正"就是本线上车那一侧。原来写的是
         `Math.sign(lat) === side` —— 那是拿**转正后**的符号去比**转正前**的 side，
         side=−1 的车站两桶整个叫反。过去看不出来，是因为两座板关于线路中心
         等距（都是 2.05~5.55），比 lo/hi 时反不反都一样；对向板搬到股道外侧之后
         （6.05~9.55）这条立刻以"站台板横向 6.05~9.55，应为 2.05~5.55"的形式报红。 */
      const near = lat > 0;
      for (const which of (near ? ['near'] : ['far'])) {
        const key = mat + '|' + band + '|' + which;
        const r = out.get(key) || { lo: Infinity, hi: -Infinity, cross: 0 };
        r.lo = Math.min(r.lo, Math.abs(lat)); r.hi = Math.max(r.hi, Math.abs(lat));
        /* 真正的物理判据：站台面高度（+0.3~+0.75 m）不许有任何车站构件落在限界内。
           钢轨/道床自己算合法（它们本来就在中心线两侧），桥面外侧的护栏在横向 7.45 m，
           第一版把"任何负横向"都当成越线，于是每一处车站都假红 30 多条。 */
        if (up > 0.3 && up < 0.75 && Math.abs(lat) < 1.90 && GAUGE_MUST_NOT.has(mat)) r.cross++;
        out.set(key, r);
      }
      if (up > 0.3 && up < 0.75 && Math.abs(lat) < 1.90 && GAUGE_MUST_NOT.has(mat)) {
        const key = mat + '|' + band;
        const r = out.get(key) || { lo: Infinity, hi: -Infinity, cross: 0 };
        r.cross++; out.set(key, r);
      }
    }
  }
  return { side, out, railLats, gapHit, gapW, hasOpp };
}

let bad = 0, checked = 0;
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SH.LINES);
for (const id of ids) {
  const line = new LineRuntime(SH.LINES[id]);
  const pick = {};
  for (let i = 0; i < line.stations.length; i++) {
    const s = line.al.stationS[i];
    if (!line.isElevated(s) || !line.openness || line.openness(s) < 0.9) continue;
    const sd = line.stationSide(i);
    if (pick[sd] == null) pick[sd] = i;
  }
  const errs = [];
  for (const k of Object.keys(pick)) {
    const si = pick[k], S = section(line, si), out = S.out;
    const T0 = SH.TRACK_OFFSET, FARF = SH.farFrontOf(-T0);
    const plat = out.get('granite|lo|near'), ceil = out.get('tiles|hi|near') || out.get('tiles|hi|far');
    const farPlat = out.get('granite|lo|far');
    checked++;
    if (!plat) { errs.push(`${line.stations[si]}(side ${S.side}) 找不到站台板`); continue; }
    if (plat.lo < X.front - 0.15 || plat.hi > X.outer + 0.15)
      errs.push(`${line.stations[si]}(side ${S.side}) 站台板横向 ${plat.lo.toFixed(2)}~${plat.hi.toFixed(2)} m，应为 ${X.front}~${X.outer}`);
    /* 对向站台（第二座侧式站台）：轨道对面那一侧必须也有一条同尺寸的站台板。
       以前那一侧是一堵贴瓷片的墙 —— 从站台上望过去"轨道对面没有能上车的站台"，
       而上海地铁绝大多数站是双侧式或一岛一侧。 */
    /* 单线构造的线路（磁浮、浦江线 APM）对面没有股道 —— 对向那一侧的判据不适用。
       "有没有对向股道"问烘焙器自己（`S.hasOpp` = buildRuns 有没有挂上 `_oppLat`），
       不在判据里再抄一份"哪些车型算单线"的式子：那两份迟早漂移。 */
    if (!S.hasOpp) { /* 这一站的对面是隧道壁/桥面外侧，不比 */ }
    else if (!farPlat) errs.push(`${line.stations[si]}(side ${S.side}) 对向没有站台板（轨道对面是一堵墙）`);
    /* "两座站台对称"的正确含义**不是**"到线路中心等距"，而是"各自在自己的股道外侧、
       缘距都是同一个 front"。对向那条板的基准 = 对向股道横向 + front（`SH.farFrontOf`）；
       写成等距就是把 2026-10-06 那个镜像缺陷钉回原判据（板内缘 2.05 而基准应为 6.05）。 */
    else if (Math.abs(farPlat.lo - FARF) > 0.25 || Math.abs(farPlat.hi - (FARF + X.width)) > 0.25)
      errs.push(`${line.stations[si]} 对向站台不在对向股道（−${T0} m）的外侧：量到 ${farPlat.lo.toFixed(2)}~${farPlat.hi.toFixed(2)}，应为 ${FARF.toFixed(2)}~${(FARF + X.width).toFixed(2)} —— 关于线路中心镜像过来的板会正好埋掉对面那条股道`);
    /* 桥面必须罩住**两条**站台板（对向那条现在在 9.55 外，±7.6 的老桥面会让它悬空） */
    for (const [lbl, bk, plat2] of [['本侧', 'near', plat], S.hasOpp ? ['对向', 'far', farPlat] : null].filter(Boolean)) {
      if (!plat2) continue;
      const dk = out.get('concrete|dk|' + bk);
      if (!dk) errs.push(`${line.stations[si]} ${lbl}量不到桥面（concrete 在 −0.25~+0.25 这一带没有顶点）`);
      else if (dk.hi < plat2.hi + X.deckOver - 0.15)
        errs.push(`${line.stations[si]} ${lbl}桥面外沿只到 ${dk.hi.toFixed(2)}，站台板外缘 ${plat2.hi.toFixed(2)} + 挑檐 ${X.deckOver} = ${(plat2.hi + X.deckOver).toFixed(2)} —— 站台板伸出桥面外，底下没有承托`);
    }
    if (S.gapHit)
      errs.push(`${line.stations[si]} 两股道之间（${(-S.gapW + 0.95).toFixed(2)}~−0.95）有 ${S.gapHit} 个站台构件顶点 —— 那一格应该是空的（对向站台在对向股道外侧）`);
    if (ceil) {
      const cover = Math.min(ceil.hi, plat.hi) - Math.max(ceil.lo, plat.lo);
      if (cover < X.width * 0.9)
        errs.push(`${line.stations[si]}(side ${S.side}) 雨棚只罩住站台 ${cover.toFixed(2)} m / ${X.width} m`);
    } else errs.push(`${line.stations[si]} 没有雨棚/吊顶（tiles 材质缺失）`);
    for (const [k2, r] of out) if (r.cross)
      errs.push(`${line.stations[si]}(side ${S.side}) ${k2.split('|')[0]} 有 ${r.cross} 个顶点在站台面高度越过线路中心（台压轨）`);
  }
  if (errs.length) { bad += errs.length; console.log(`✗ ${line.name} ` + errs.slice(0, 4).join('\n  ✗ ')); }
  else console.log(`✓ ${line.name} 横断面：${Object.keys(pick).length} 类朝向（side ${Object.keys(pick).join(' / side ')}）站台 ${X.front}~${X.outer} m、雨棚全罩、无构件越中心线`);
}
console.log('—— 双线断面：对向股道（第 108 条）——');
{
  const errs = [];
  const T0 = SH.TRACK_OFFSET;
  if (T0 !== 4)
    errs.push(`线间距基线漂移：SH.TRACK_OFFSET = ${T0}，判据钉在 4 m（双线断面线间距）—— 改这个数是一次断面修订，几何与判据要一起改`);
  /* 全线恒边：对向股道必须沿全线保持同一个横向位置（−side × 4 m），
     连续的物理股道不许在站间"换轨"。逐站哈希（负控 oppside）会让
     有的站的对向轨压到站台底下 —— 这是地理事实，不是逐站装饰。 */
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    for (let i = 0; i < line.stations.length; i++)
      if (line.stationSide(i) !== line.stationSide(0)) {
        errs.push(`${line.name}：站 ${i}（${line.stations[i]}）的站台边 ${line.stationSide(i)} ≠ 全线 ${line.stationSide(0)} —— 站台边是逐站算的，连续物理股道不许换边`);
        break;
      }
  }
  /* 地下站箱内：正线钢轨在位、对向股道在位、两股道之间是空的。
     量的是按 side 转正后的横向坐标。B 阶段口径（§7.1）后**两种站型都合法**：
     侧式站对向轨恒在 −4±0.75；岛式站对向轨在站区加宽到 −islandSpan，判据按站型分别取。 */
  const line = new LineRuntime(SH.LINES.l2);
  let ui = -1;
  for (let i = 0; i < line.stations.length; i++) {
    const s = line.al.stationS[i];
    if (!line.isElevated(s) && !line.depotAtS(s)) { ui = i; break; }
  }
  if (ui < 0) errs.push('l2 找不到地下车站（对向断面无处可量）');
  else {
    const nm = line.stations[ui], styp = SH.platType(nm), ss = line.al.stationS[ui];
    const oppBase = styp === 'island' ? -SH.islandSpan() : -T0;   // 该站型的对向轨名义横向
    const sec = section(line, ui);
    const R = sec.railLats;
    if (!R.some(l => Math.abs(l) < 1.9))
      errs.push(`${nm} 地下站箱内没有正线钢轨（|lat|<1.9 无 rail 顶点）—— 站台底下是一段无轨区，司机进站时车轮悬空`);
    if (!R.some(l => Math.abs(l - oppBase) < 0.9))
      errs.push(`${nm} 地下站对向股道缺失（${oppBase}±0.75 无 rail 顶点，站型 ${styp}）—— 站台上看不到对面方向的车进站，"这是地铁"不成立`);
    const centers = styp === 'island' ? [-SH.islandSpan() - 0.75, -SH.islandSpan() + 0.75, -0.75, 0.75]
      : [-T0 - 0.75, -T0 + 0.75, -0.75, 0.75];
    for (const l of R)
      if (centers.every(w => Math.abs(l - w) >= 0.25)) {
        errs.push(`${nm} 地下站钢轨横向 ${l.toFixed(2)} m 不在任何一股道中心 ±0.75 上（站型 ${styp}）—— 四轨错开或股道漂移`);
        break;
      }
    /* 地下站同样量"两股道之间空不空"（2026-10-06 那个镜像缺陷最先就是在
       2 号线 蟠祥路 的地下断面上量出来的：granite −2.05~−3.10）。 */
    if (sec.gapHit)
      errs.push(`${nm} 地下站两股道之间（${(-sec.gapW + 0.95).toFixed(2)}~−0.95）有 ${sec.gapHit} 个站台构件顶点 —— 对向站台板埋掉了对面那条股道`);
    /* B 第 2 层：岛式站的**岛体**必须在两股道之间（缘口 2.05、岛宽 ISLAND_W），
       且旧的对向站台（farPlatform）整条消失 —— 岛式再铺一条侧式站台就是
       凭空造出第三座站体。一条断言两头钉：lo 钉岛近缘、hi 钉岛远缘。 */
    if (styp === 'island') {
      const fp = sec.out.get('granite|lo|far');
      if (!fp || Math.abs(fp.lo - X.front) > 0.25 || Math.abs(fp.hi - (X.front + SH.ISLAND_W)) > 0.25)
        errs.push(`${nm} 岛式站体不在位：岛板横向 ${fp ? fp.lo.toFixed(2) + '~' + fp.hi.toFixed(2) : '没有'}，应为 ${X.front}~${(X.front + SH.ISLAND_W).toFixed(2)}（岛宽 ${SH.ISLAND_W}，两缘各对一条股道；若 hi 到 14 以上 = farPlatform 没关）`);
      /* B 第 3 层：箱涵远端墙必须**越过对向股道** —— 岛的对向缘口外面是股道，
         不是墙。第 2 层把远端墙放在 board×10.65（岛背后 0.6 m），而对向股道在
         board×islandSpan=12.1：那条缘口的黄线/盲道/屏蔽门/门头梁全都在，
         却正对着一堵墙、对向车被挡在墙外（岛式站的**定义性画面**不成立）。
         量 hi 带（顶板/墙）concrete 的最远横向：远端墙在 10.65 时只到 10.65，
         越过股道后至少到 islandSpan+0.5。 */
      const ch = sec.out.get('concrete|hi|far');
      if (!ch || ch.hi < SH.islandSpan() + 1.5)
        errs.push(`${nm} 岛式站箱涵远端墙只到 ${ch ? ch.hi.toFixed(2) : '无'} m，没越过对向股道（${SH.islandSpan().toFixed(2)} m）—— 岛的对向缘口正对着一堵墙，对向车被挡在墙外`);
    }
    /* 常数探针 ×2，各守一条"横向是单点函数"的命：
       ① 岛式站：ISLAND_W +1 ⇒ 加宽跨度跟着走（span = W + 两道缘距）；
       ② 侧式站：TRACK_OFFSET +1 ⇒ 对向轨与对向站台板跟着搬。
       还揣着自己那份字面量的消费者，各自在这一步报红。 */
    const sw = SH.islandSpan();
    SH.ISLAND_W = SH.ISLAND_W + 1;
    let probe = null;
    try {
      probe = section(line, ui);
      const want = -(SH.ISLAND_W + 2 * X.front);
      if (!probe.railLats.some(l => Math.abs(l - want) < 0.9))
        errs.push(`探针(岛式+1)：对向轨没有跟着 SH.ISLAND_W 加宽（应有 ${want.toFixed(2)}±0.75 的轨）—— buildRuns 或 track() 揣着自己的字面量`);
    } finally { SH.ISLAND_W = SH.ISLAND_W - 1; }
    if (Math.abs(SH.islandSpan() - sw) > 1e-9) errs.push('ISLAND_W 探针没还原 —— 后面的判据量到一座假岛式站');
    /* 侧式探针挑一座天然侧式的站（B 口径后 = 高架站），要求对向股道在场 */
    let si2 = -1, sec2 = null;
    for (let i = 0; i < line.stations.length && si2 < 0; i++) {
      const s = line.al.stationS[i];
      if (!line.isElevated(s) || line.depotAtS(s)) continue;
      if (SH.platType(line.stations[i]) !== 'side') continue;
      const sc = section(line, i);
      if (sc.hasOpp) { si2 = i; sec2 = sc; }
    }
    if (si2 < 0) errs.push('l2 找不到有对向股道的侧式站（TRACK_OFFSET 探针无处可量）');
    else {
      SH.TRACK_OFFSET = T0 + 1;
      try {
        const probe2 = section(line, si2);
        if (!probe2.railLats.some(l => Math.abs(l + T0 + 1) < 0.9))
          errs.push(`探针(+1)：对向轨没有跟着 SH.TRACK_OFFSET 搬家 —— buildRuns 或 track() 揣着自己的字面量 4`);
        const fp = probe2.out.get('granite|lo|far');
        if (!fp || Math.abs(fp.lo - SH.farFrontOf(-(T0 + 1))) > 0.25)
          errs.push(`探针(+1)：对向站台板没跟着 SH.TRACK_OFFSET 搬家（量到 ${fp ? fp.lo.toFixed(2) : '没有'}，应为 ${SH.farFrontOf(-(T0 + 1)).toFixed(2)}）—— farPlatform 自己抄了一份缘距`);
      } finally { SH.TRACK_OFFSET = T0; }
    }
    /* 隧道区间（双洞）：本洞里只有自己的轨，看不见对向股道 */
    let sm = -1;
    for (let i = 0; i < line.stations.length - 1; i++) {
      const m = (line.al.stationS[i] + line.al.stationS[i + 1]) / 2;
      if (!line.isElevated(m) && !line.depotAtS(m) && line.nearStation(m).d > 140) { sm = m; break; }
    }
    if (sm < 0) errs.push('l2 找不到离站超 140 m 的地下隧道区间（双洞判据无处可量）');
    else {
      let ni = 0;
      for (let i = 1; i < line.stations.length; i++)
        if (Math.abs(line.al.stationS[i] - sm) < Math.abs(line.al.stationS[ni] - sm)) ni = i;
      const R3 = section(line, ni, sm).railLats;
      if (!R3.some(l => Math.abs(l) < 1.9))
        errs.push(`隧道区间（里程 ${sm.toFixed(0)}）没有正线钢轨 —— 断面窗口没盖住区间`);
      if (R3.some(l => Math.abs(l + T0) < 0.9))
        errs.push(`隧道区间（里程 ${sm.toFixed(0)}）里出现了对向股道 —— 双洞各自独立，本洞里看不见对向轨`);
    }
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 双线断面：全线恒边、地下站箱内有正线轨+对向轨（−${T0} m）且两股道间空、隧道无双轨、对向轨跟随 SH.TRACK_OFFSET 探针搬家`);
}
console.log('—— 岛式站台的线间距加宽（第 122 条：对向股道是逐里程的函数；B 阶段口径：地下站默认岛式）——');
{
  const errs = [];
  const line = new LineRuntime(SH.LINES.l2);
  const T0 = SH.TRACK_OFFSET, SPAN = SH.islandSpan();
  let ui = -1;
  for (let i = 0; i < line.stations.length; i++) {
    const s = line.al.stationS[i];
    if (!line.isElevated(s) && !line.depotAtS(s) && line.nearStation(s).d < 20) { ui = i; break; }
  }
  if (ui < 0) errs.push('l2 找不到岛式判据要用的地下车站');
  else {
    const side = line.stationSide(0), ss = line.al.stationS[ui], nm = line.stations[ui];
    if (SH.platType(nm) !== 'island')
      errs.push(`${nm} 是地下站却没判成岛式 —— B 口径（platTypeDefault）没生效，别在用 fixture 假岛式量几何`);
    else {
      /* ① 区间回归锁（B 口径拆法，§7.1）：**区间里程**逐米恒等于 −side×T0 ——
         "连续物理股道不许在站间漂移"这条原命题不变；变化只许发生在岛式站区的
         过渡段里，而且形状是钉死的（站心 = −side×SPAN，过渡段单调收回）。 */
      let drift = 0, worst = 0, worstS = null;
      const zones = line.stations
        .map((n, i) => ({ n, s: line.al.stationS[i], isl: SH.platType(n) === 'island' }))
        .filter(z => z.isl);
      const inZone = s => zones.some(z => Math.abs(s - z.s) <= SH.STATION_HALF + SH.ISLAND_TRANS);
      for (let s = 0; s < line.al.total; s += 25) {
        if (inZone(s)) continue;
        const e = Math.abs(SH.oppLatAt(line, s) + side * T0);
        if (e > 1e-9) { drift++; worst = Math.max(worst, e); worstS = s; }
      }
      if (drift) errs.push(`区间回归锁破：${drift} 个区间采样点的对向股道 ≠ −side×${T0}（最大偏 ${worst.toFixed(2)} m @ ${worstS}）—— 加宽泄漏到了不该动的里程`);
      /* ①b 岛式站区：**每一座**岛式站的站心都必须精确落在 −side×SPAN 上 ——
         少一站都不行，否则那座站的对向车进不了它该对的股道。 */
      let miss = 0;
      for (const z of zones) {
        const v = SH.oppLatAt(line, z.s);
        if (Math.abs(v + side * SPAN) > 1e-6) miss++;
      }
      if (miss) errs.push(`${miss}/${zones.length} 座岛式站的站心对向股道没落在 −side×${SPAN.toFixed(2)} —— 加宽只走了一部分站`);
      /* ② 加宽的量必须是"站台宽 + 两道缘距"，而且往**远离本线**那一侧加
         （岛式在两股道之间；往站台式那侧加宽会让对向轨穿进站台底下）。 */
      const c1 = SH.oppLatAt(line, ss);
      if (Math.abs(c1 + side * SPAN) > 1e-6)
        errs.push(`${nm} 岛式站心的对向股道在 ${c1.toFixed(2)} m，应为 −side×${SPAN.toFixed(2)} = ${(side > 0 ? -SPAN : SPAN).toFixed(2)} m（站台宽 ${SH.ISLAND_W} + 两道缘距 ${X.front}）`);
      if (Math.abs(c1) <= T0)
        errs.push(`${nm}：岛式加宽把对向股道拉到本线那一侧去了（|${c1.toFixed(2)}| ≤ ${T0}）—— 过渡段会穿越正线`);
      /* ③ 出了过渡段必须回到区间线间距，且过渡段逐米单调（不许来回抖、不许阶跃） */
      const out = ss + SH.STATION_HALF + SH.ISLAND_TRANS + 80;
      const c2 = SH.oppLatAt(line, out);
      if (Math.abs(c2 + side * T0) > 1e-6)
        errs.push(`${nm} 过渡段之外（+${(out - ss).toFixed(0)} m）对向股道是 ${c2.toFixed(2)} m，没回到 −side×${T0}`);
      let prev = null, rise = 0, jump = 0;
      for (let s = ss; s <= out; s += 1) {
        const v = Math.abs(SH.oppLatAt(line, s));          // 转正后应当从 SPAN 单调**收回**到 T0
        if (prev != null) {
          if (v > prev + 1e-9) rise++;                     // 离站越来越宽 = 对向车会左右摆
          if (prev - v > 0.25) jump++;                     // 每米最多收 0.25 m：8 m 落差摊在 80 m 过渡段里
        }
        prev = v;
      }
      if (rise) errs.push(`${nm} 过渡段有 ${rise} 处离站更远却更宽 —— 线间距在站区外来回抖`);
      if (jump) errs.push(`${nm} 过渡段有 ${jump} 处单米收回 >0.25 m —— 道床与轮轨在折角处不连续`);
      /* ④ 烘出来的钢轨真的搬家（不是只有那个函数在动）：站心 ±16 m 断面窗口里
         必须有 −SPAN±0.75 的轨，而且 −T0±0.75 那一族必须整个消失。 */
      const R = section(line, ui).railLats;
      if (!R.some(l => Math.abs(l + SPAN) < 0.9))
        errs.push(`${nm} 岛式站心断面里没有 −${SPAN.toFixed(2)}±0.75 的钢轨 —— 函数说加宽了，烘焙里对向轨还在老位置`);
      if (R.some(l => Math.abs(l + T0) < 0.9))
        errs.push(`${nm} 岛式站心断面里还有 −${T0} 处的对向轨 —— 加宽只进了一半（多半是第三轨或道床那一支没跟 LAT(s)）`);
      /* ⑤ 岛式两缘的缘距必须与侧式同一个 STATION_X.front：站台的近缘应落在
         −(SPAN − front) 那一带，即"轨道之间正好夹住一块 8 m 的台"。 */
      const nearEdge = SPAN - X.front, farEdge = X.front;
      if (!(Math.abs(nearEdge - farEdge - SH.ISLAND_W) < 1e-6))
        errs.push(`岛式断面自洽破：近缘 ${nearEdge.toFixed(2)} − 远缘 ${farEdge.toFixed(2)} ≠ 站台宽 ${SH.ISLAND_W}`);
      /* ⑥ 例外优先（B 口径的优先级契约）：PLAT_TYPE 显式钉 'side' 必须压过默认口径 ——
         逐站例外表就是为"有出知的例外站"留的口子，被默认档淹没它就死了。 */
      SH.PLAT_TYPE[nm] = 'side';
      try {
        const c3 = SH.oppLatAt(line, ss);
        if (Math.abs(c3 + side * T0) > 1e-6)
          errs.push(`${nm} 被 PLAT_TYPE 钉成侧式后对向股道仍在 ${c3.toFixed(2)} m —— 例外表没有压过默认口径`);
        if (SH.platType(nm) !== 'side') errs.push(`${nm} 钉了 'side' 却仍判岛式 —— 例外表读取路径断了`);
      } finally { delete SH.PLAT_TYPE[nm]; }
      if (SH.platType(nm) !== 'island') errs.push(`${nm} 的 fixture 站型没还原 —— 后面的判据会量到一座假侧式站`);
    }
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.slice(0, 6).join('\n  ✗ ')); }
  else console.log(`  ✓ 岛式接缝：区间逐米恒 −${T0}（区间回归锁）、l2 全部地下站站心加宽到 −${SPAN.toFixed(2)}（台宽 ${SH.ISLAND_W}+两道缘距 ${X.front}）、过渡段单调且每米 ≤0.25 m、断面里老位置的对向轨确实消失、例外表压过默认口径`);
}
console.log(bad ? `✗ ${bad} 项横断面断言未通过（共测 ${checked} 处车站）`
  : `✓ 横断面全部通过（${ids.length} 条线 ${checked} 处车站：站台不越中心线、雨棚罩住整块站台；双线断面对向股道在位）`);
process.exit(bad ? 1 : 0);
