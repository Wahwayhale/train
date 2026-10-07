/* ============================================================================
 * test-env.js — "时间是活的"这一族的离线判据（第 13 个自测）
 *
 * 为什么要有它：在此之前 `App.envFor()` 恒取 `SH.ENVS.dusk`，`ENVS.dawn/day/night`
 * 三个预设写了却从来没人调用；`hour` 只是一个静态整数，不改变天光、不改变发车
 * 密度、没有首末班。整条"时间轴"是死的，而**没有任何判据看得见它** ——
 * 画面永远黄昏、屏永远 00:0x，测试照样全绿。
 *
 * 这里量四组东西，全部量**结果**不量写法：
 *   A. 天光曲线（`SH.envAt`）：深夜必须显著暗于正午、同一钟点可复现、
 *      一天首尾相接无断层、日出与日落两个方向单调。
 *   B. 发车密度（`SH.headwayFactor` + `Dispatcher`）：高峰系数为 1，
 *      夜间在役车底少于平峰、平峰少于高峰（间隔反过来）。
 *   C. 首末班（`SH.SERVICE` + `Dispatcher.wallClock`）：过末班后不再投入车底、
 *      屏报收车；运营时段内不许误收车。
 *   D. 接线 lint：game.js 必须真的读 `SH.envAt`、必须让时钟前进 ——
 *      这三条挡的是"机制写好了但没人调用"（`SH.ENVS.dawn` 那一族）。
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'traffic']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;

const src = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = name => { const i = src.indexOf('class ' + name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])) });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
/* 雨刮判据用：量的是 game.js 产品类交给 GL 的矩阵，所以得拿产品那份 TrainView，
   不能拿 train.js 那个纯建模的（它不知道雨刮这个参数）。 */
const GameTrainView = eval('(' + grab('TrainView') + ')');

let bad = 0;
const fail = m => { bad++; console.log('  ✗ ' + m); };
/** 相对亮度（Rec.709 权重）：判"天黑没黑"要量人眼看得见的东西，不是某一个通道。 */
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const chans = e => [e.sunCol, e.skyCol, e.gndCol, e.skyHorizon, e.skyZenith, e.fogCol, e.fog2, e.haze];

console.log('—— A. 天光曲线（SH.envAt：钟点 → 环境）——');
{
  const errs = [];
  const night = SH.envAt(2), noon = SH.envAt(13), dawn = SH.envAt(6), dusk = SH.envAt(19);
  const ln = lum(night.sunCol), lo = lum(noon.sunCol);
  if (!(ln < lo * 0.35)) errs.push(`凌晨 2 点的太阳亮度 ${ln.toFixed(3)} 不是正午 ${lo.toFixed(3)} 的 0.35 倍以下 —— 夜里不够黑`);
  if (!(lum(night.gndCol) < lum(noon.gndCol) * 0.35)) errs.push('夜里的地面反照没有显著低于正午 —— 地面不跟着天黑');
  if (!(night.night > 0.85 && noon.night < 0.05)) errs.push(`夜/昼的 night 系数 ${night.night.toFixed(2)} / ${noon.night.toFixed(2)} 不在 0.85~1 / 0~0.05 —— 夜景强度是死的`);
  /* 确定性：同一钟点必须给出逐通道相同的结果（回归可复现的前提） */
  const a1 = SH.envAt(7.4), a2 = SH.envAt(7.4);
  if (chans(a1).some((c, i) => c.some((v, j) => v !== chans(a2)[i][j]))) errs.push('同一钟点两次调用结果不同 —— envAt 不是确定性的');
  /* 首尾相接：23:59 与 00:01 必须几乎一样（锚点表被改出断层就会在这里露馅） */
  const end = SH.envAt(23.983), start = SH.envAt(0.017);
  const dmax = Math.max(...chans(end).map((c, i) => Math.max(...c.map((v, j) => Math.abs(v - chans(start)[i][j])))));
  if (dmax > 0.02) errs.push(`23:59 与 00:01 的天色差到 ${dmax.toFixed(3)} —— 一天的首尾接不上（锚点表有断层）`);
  /* 两个方向单调：04:00→09:00 天在亮，17:00→21:00 天在暗 */
  const rise = [4, 5, 6, 7, 8, 9].map(h => lum(SH.envAt(h).sunCol));
  const fall = [17, 18, 19, 20, 21].map(h => lum(SH.envAt(h).sunCol));
  for (let i = 1; i < rise.length; i++) if (rise[i] < rise[i - 1] - 1e-9) { errs.push(`日出方向不单调：${[4,5,6,7,8,9][i]} 点比前一点更暗`); break; }
  for (let i = 1; i < fall.length; i++) if (fall[i] > fall[i - 1] + 1e-9) { errs.push(`日落方向不单调：${[17,18,19,20,21][i]} 点比前一点更亮`); break; }
  if (!(lum(dawn.sunCol) > ln && lum(dusk.sunCol) < lo && lum(dusk.sunCol) > ln)) errs.push('拂晓/黄昏没有落在夜与昼之间 —— 锚点插值方向反了');
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 天光：夜 ${ln.toFixed(2)} → 拂晓 ${lum(dawn.sunCol).toFixed(2)} → 昼 ${lo.toFixed(2)} → 黄昏 ${lum(dusk.sunCol).toFixed(2)}，可复现、首尾相接、双向单调`);
}

console.log('\n—— B. 发车密度随时段（配车按高峰配，在役车底随时段缩）——');
{
  const errs = [];
  if (SH.headwayFactor(8) !== 1.0 || SH.headwayFactor(18) !== 1.0) errs.push('高峰系数不是 1.0 —— 与既有标定不再一致，全部基线会被推动');
  if (!(SH.headwayFactor(2) > SH.headwayFactor(13) && SH.headwayFactor(13) > SH.headwayFactor(8))) errs.push('密度系数不是"夜 > 平峰 > 高峰" —— 时段表方向反了');
  for (const id of ['l1', 'l9', 'l16']) {
    const L = new LineRuntime(SH.LINES[id]);
    const dP = new SH.traffic.Dispatcher(L, { hour: 8 });
    const dM = new SH.traffic.Dispatcher(L, { hour: 13 });
    const dN = new SH.traffic.Dispatcher(L, { hour: 2 });
    /* 头时严格随时段：2.0 / 1.3 / 1.0 倍 */
    if (Math.abs(dN.headwayMin / dP.headwayMin - 2.0) > 1e-9) errs.push(`${L.name}：夜/高峰头时比 ${(dN.headwayMin / dP.headwayMin).toFixed(3)} ≠ 2.0`);
    if (Math.abs(dM.headwayMin / dP.headwayMin - 1.3) > 1e-9) errs.push(`${L.name}：平峰/高峰头时比 ${(dM.headwayMin / dP.headwayMin).toFixed(3)} ≠ 1.3`);
    /* 在役车底与间隔：夜里车少、间隔大 */
    if (!(dN.n < dM.n && dM.n < dP.n)) errs.push(`${L.name}：在役列数没有随时段递减（夜 ${dN.n} / 平 ${dM.n} / 峰 ${dP.n}）`);
    if (!(dN.spacing > dM.spacing * 1.2 && dM.spacing > dP.spacing * 1.1)) errs.push(`${L.name}：铺满全线的间隔没有随时段拉开（夜 ${Math.round(dN.spacing)} / 平 ${Math.round(dM.spacing)} / 峰 ${Math.round(dP.spacing)} m）`);
    if (errs.length) break;
    console.log(`  ${L.name.padEnd(5)} 头时 ${dP.headwayMin.toFixed(1)} → ${dM.headwayMin.toFixed(1)} → ${dN.headwayMin.toFixed(1)} min · 在役 ${dP.n} → ${dM.n} → ${dN.n} 列 · 间隔 ${Math.round(dP.spacing)} → ${Math.round(dM.spacing)} → ${Math.round(dN.spacing)} m`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 发车密度：高峰 1.0 / 平峰 1.3 / 夜间 2.0，在役车底与间隔随时段同向变化');
}

console.log('\n—— C. 首末班与收车（SH.SERVICE + Dispatcher.wallClock）——');
{
  const errs = [];
  const L = new LineRuntime(SH.LINES.l1);
  /* ① 运营时段内不许误收车：默认 dayT0 = 首班 05:30，跑 10 分钟 */
  {
    const d = new SH.traffic.Dispatcher(L, {});
    for (let k = 0; k < 600; k++) d.update(0.5);
    if (SH.lastTrainAt(L, 3, d.wallClock()) != null) errs.push('运营时段内屏就报"已收车"');
    if (d.trains.some(t => t.state === 'stabled')) errs.push('运营时段内就有车底被收车');
  }
  /* ② 过末班后不再投入车底：把 dayT0 摆到末班之后 */
  {
    const d = new SH.traffic.Dispatcher(L, { dayT0: SH.SERVICE.last + 10 });
    const t = d.trains[0];
    t.state = 'turnback'; t.dwell = 0.4; t.open = 1; t.s = L.al.total - 20;
    for (let k = 0; k < 40; k++) d.update(0.5);
    if (t.state !== 'stabled') errs.push(`末班之后折返车没有收车（state=${t.state}）—— 收车时刻没有真的起作用`);
    if (SH.lastTrainAt(L, 3, d.wallClock()) == null) errs.push('过末班之后屏不报"已收车"');
  }
  /* ③ 时间轴本身：wallClock 必须真的随 clock 前进，且从 dayT0 起算 */
  {
    const d = new SH.traffic.Dispatcher(L, { dayT0: 7 * 3600 });
    const w0 = d.wallClock();
    for (let k = 0; k < 120; k++) d.update(0.5);
    const w1 = d.wallClock();
    if (Math.abs(w0 - 7 * 3600) > 1e-6) errs.push(`wallClock 起点 ${w0} ≠ dayT0 7:00`);
    if (!(w1 > w0 + 50)) errs.push(`wallClock 没有随 clock 前进（${w0} → ${w1}）`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 首末班：末班 ${new Date(SH.SERVICE.last * 1000).toISOString().slice(11, 16)} 之后不再投入车底、屏报收车；运营时段内不误收车；wallClock 与 dayT0 同轴`);
}

console.log('\n—— D. 接线 lint：机制必须真的被调用（ENVS.dawn 那一族的教训）——');
{
  const errs = [];
  /* 必须**剥掉注释**再查：这些 lint 量的是一行代码在不在，而注释里出现的
     同一个字符串（比如解释"以前写死 SH.ENVS.dusk"）会假命中。
     第一版没剥，结果这条 lint 被自己的注释判红 —— 判据量错了对象。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (!/SH\.envAt\(/.test(code)) errs.push('game.js 的 envFor 没有调用 SH.envAt —— 天光又变成死配置');
  if (/SH\.ENVS\.dusk/.test(code)) errs.push('game.js 里仍有写死的 SH.ENVS.dusk —— 天光又回到"恒为黄昏"');
  if (!/this\.clock\s*\+=/.test(code)) errs.push('game.js 的时钟没有随运行前进 —— "时间是死的"');
  if (!/_ptdClock\(\)\s*\{[^}]*clockText/.test(code)) errs.push('站台屏钟点没有读 App 的钟（与天光/收车不是同一条时间轴）');
  if (!/dayT0/.test(code)) errs.push('game.js 建调度器时没有传 dayT0 —— 屏上的钟点与玩家选的时刻对不上');
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 接线：envFor 读 envAt、时钟前进、站台屏读 App 钟、调度器带 dayT0');
}

console.log('\n—— E. 雨天（D4：天光调制 / 湿轨物理 / 雨声 / 客流联动）——');
{
  const errs = [];
  /* ① envRainy 单点：太阳漫射化、雨雾抬浓、天空向灰收；不改入参、同钟点可复现 */
  {
    const dry = SH.envAt(13), wet1 = SH.envRainy(dry), wet2 = SH.envRainy(SH.envAt(13));
    const lum2 = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (!(lum2(wet1.sunCol) < lum2(dry.sunCol) * 0.4)) errs.push(`雨天的太阳亮度 ${lum2(wet1.sunCol).toFixed(2)} 没有压到晴天的 0.4 倍以下 —— 雨云天还有直射日光`);
    if (!(wet1.fogDensity > dry.fogDensity * 1.4)) errs.push(`雨雾 ${wet1.fogDensity} 没有比晴天浓 1.4 倍以上`);
    /* 天空去饱和：雨天 max-min 通道差必须比晴天小（灰 ≠ 只是变暗） */
    const spread = c => Math.max(...c) - Math.min(...c);
    if (!(spread(wet1.skyCol) < spread(dry.skyCol))) errs.push('雨天的天空饱和度没有比晴天低 —— 只是变暗不是变灰');
    if (JSON.stringify(dry.sunCol) !== JSON.stringify(SH.envAt(13).sunCol)) errs.push('envRainy 改动了传入的环境对象 —— envFor 的插值基准被污染');
    if (JSON.stringify(wet1.sunCol) !== JSON.stringify(wet2.sunCol)) errs.push('同一钟点两次 envRainy 结果不同 —— 雨天调制不可复现');
  }
  /* ② 湿轨物理：adhesion 下降 → 同挡牵引被削；B7 从 60 km/h 的制动距离变长 */
  {
    const Lmu = new LineRuntime(SH.LINES.l1);
    const dryMu = new SH.physics.Train(Lmu.spec).adhesion(40, false), wetMu = new SH.physics.Train(Lmu.spec).adhesion(40, true);
    if (!(wetMu < dryMu * 0.75)) errs.push(`湿轨黏着 ${wetMu.toFixed(3)} 没有比干轨 ${dryMu.toFixed(3)} 低 25% 以上 —— 物理侧的 wet 参数没起作用`);
    /* 从 60 km/h 起 EB：EB 需求 1.2 m/s² 干轨够不着黏着极限（1.31），
       湿轨极限 0.97 会被削 —— 差别必须出现在"需求 > 极限"的工况上，
       用 B7 这种本来就低于极限的级位量不出差别。 */
    const stopDist = wet => {
      const L = new LineRuntime(SH.LINES.l1);
      const tr = new SH.physics.Train({ perf: L.perf, stock: L.stock, maxKmh: L.maxKmh });
      tr.s = 5000; tr.setNotch(4);
      for (let k = 0; k < 60 * 30 && tr.kmh < 60; k++) tr.update(1 / 60, { limitKmh: 70, wet });
      if (tr.kmh < 59) errs.push(`测试自身：60 km/h 没加速到位（${tr.kmh.toFixed(1)}）`);
      tr.setNotch(-9); tr.eb = true;
      let d0 = tr.s;
      for (let k = 0; k < 60 * 60 && tr.kmh > 0.5; k++) tr.update(1 / 60, { limitKmh: 70, wet });
      return tr.s - d0;
    };
    const dDry = stopDist(false), dWet = stopDist(true);
    if (!(dWet > dDry * 1.05)) errs.push(`湿轨制动距离 ${dWet.toFixed(0)} m 没有比干轨 ${dDry.toFixed(0)} m 长 5% 以上 —— 雨天刹车"没有手感差别"`);
    if (!(dWet < dDry * 1.9)) errs.push(`湿轨制动距离 ${dWet.toFixed(0)} m 超过干轨的 1.9 倍 —— 黏着被压过头了`);
  }
  /* ③ 雨声：增益随雨量单调升；隧道里衰减 ≥70% */
  {
    const g0 = SH.audio.rainGain(0, 0), g1 = SH.audio.rainGain(1, 0), gT = SH.audio.rainGain(1, 1);
    if (g0.hiss !== 0 || g0.body !== 0) errs.push('雨量为 0 时雨声增益不是 0 —— 晴天在下雨');
    if (!(g1.hiss > g0.hiss && g1.body > g0.body)) errs.push('雨声增益没有随雨量上升');
    if (!(gT.hiss < g1.hiss * 0.3)) errs.push(`隧道里雨声衰减不足（${(gT.hiss / g1.hiss).toFixed(2)}）—— 管片隔音形同虚设`);
  }
  /* ④ 客流联动：雨天的发送量必须恰好放大 RAIN_PAX（Flow A/B 实测） */
  {
    const ratio = h => SH.pax.rushFactor(h, true) / SH.pax.rushFactor(h, false);
    for (const h of [8, 13, 18, 23]) if (Math.abs(ratio(h) - 1.08) > 1e-9) errs.push(`${h} 点的雨天客流系数 ${ratio(h).toFixed(3)} ≠ 1.08 —— 客流与天气脱钩了`);
    const L2 = SH.LINES.l2, st = { cars: L2.stock.cars, doors: L2.stock.doors, width: L2.stock.width, type: L2.stock.type };
    const dry = new SH.pax.Flow({ id: 'l2', stations: L2.stations }, st, 8, false);
    const wet = new SH.pax.Flow({ id: 'l2', stations: L2.stations }, st, 8, true);
    const rd = dry.waitingAt(L2.stations[3], 3), rw = wet.waitingAt(L2.stations[3], 3);
    if (Math.abs(rw / rd - 1.08) > 0.02) errs.push(`雨天候乘人数比 ${ (rw / rd).toFixed(3) } 偏离 1.08 超过 2% —— Flow 没走同一个放大系数`);
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 雨天：天光漫射化 + 雨雾 ×${SH.RAIN.fogMul}、雨声随雨量单调且隧道衰减、客流 ×${(SH.pax.rushFactor(8, true) / SH.pax.rushFactor(8, false)).toFixed(2)}、湿轨黏着下降且制动距离变长 —— 全部同源`);
}

console.log('\n—— F. 门区与车内分布（B3：门灯与蜂鸣同轴 / C5：逐节车厢档位 / 雨刮）——');
{
  const errs = [];
  /* ① doorLampK 三档：开到位常亮、关门随蜂鸣闪、关死熄灭但灯座还在 */
  {
    const { doorLampK, LAMP_ON, LAMP_OFF } = SH.train;
    if (doorLampK(1, false, 0) !== LAMP_ON) errs.push('门全开时门灯不是常亮 —— 乘客找不到门在哪');
    if (doorLampK(0, false, 0) !== LAMP_OFF || LAMP_OFF <= 0) errs.push('门关死时门灯没有回到灭档（且灭档必须是 >0 的灯座）');
    const f0 = doorLampK(0.5, true, 0), f1 = doorLampK(0.5, true, SH.DOOR_BEEP);
    if (!(f0 === LAMP_ON && f1 === LAMP_OFF)) errs.push('关门相位门灯不随 SH.DOOR_BEEP 闪 —— 灯与蜂鸣是两套假设备');
  }
  /* ② 逐节车厢档位（C5）：均值贴住整车档位、同一列车可复现、不同列车错开 */
  {
    for (const fill of [0.03, 0.2, 0.6, 0.95, 1.2]) {
      const base = SH.train.paxLevel(fill);
      const lv = SH.train.paxLevels(fill, 6, 0);
      const mean = lv.reduce((a, b) => a + b, 0) / lv.length;
      if (Math.abs(mean - base) > 0.5) errs.push(`fill=${fill} 各节档位均值 ${mean.toFixed(2)} 偏离整车档位 ${base} 超过 0.5 —— 人数凭空多了/少了`);
      if (lv.some(v => v < 0 || v > 3)) errs.push(`fill=${fill} 出现越界档位 ${lv}`);
    }
    const a = SH.train.paxLevels(0.6, 6, 0), b = SH.train.paxLevels(0.6, 6, 0);
    if (JSON.stringify(a) !== JSON.stringify(b)) errs.push('同一列车两次求档位结果不同 —— 乘客每帧换车厢');
    for (const f of [0.5, 0.6]) if (new Set(SH.train.paxLevels(f, 6, 0)).size < 2) errs.push(`fill=${f} 各节车厢档位完全一致 —— C5 的逐节分布没有生效`);
  }
  /* ③ 雨刮：draw(wiper=θ) 与 draw(wiper=0) 的矩阵必须不同（写了没做那一族的判据）。
     用录制型 renderer 走产品自己的 draw()：它交给 GL 什么矩阵，判据就量什么。 */
  {
    const L = new LineRuntime(SH.LINES.l5);
    const mats = new Set();
    const fakeR = {
      draw(b, M, ov) { mats.add((b && b._k) + '|' + Array.from(M || []).join(',')); },
      upload(ms, tag) { return (Array.isArray(ms) ? ms : [ms]).map((m, i) => ({ mat: m && m.mat, _k: (tag || 't') + i })); },
      dropTag() {},
    };
    const view = new GameTrainView(fakeR);
    view.setLine(L, null, null);
    view.draw(300, 0, { fill: 0.6, wiper: 0 });
    const a0 = [...mats]; mats.clear();
    view.draw(300, 0, { fill: 0.6, wiper: 0.4 });
    if (a0.join('|') === [...mats].join('|')) errs.push('雨刮角 0.4 与 0 画出的矩阵完全相同 —— 雨刮不会摆（"写了没做"的最新形态）');
  }
  /* ④ 接线 lint（剥注释再查）：雨要接进天光/物理/声音/设置，屏蔽门灯要画出来 */
  {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (!/SH\.envRainy\(T\)/.test(code)) errs.push('envFor 没有调 SH.envRainy —— 雨天的天光调制没接线');
    if (!/wet:\s*!/.test(code)) errs.push('Session 的物理 env 没有带 wet —— 湿轨物理没接线');
    if (!/rain:\s*!!this\.rain/.test(code)) errs.push('saveSettings 没有持久化 rain —— 天气选择跨局丢失');
    if (!/setRain/.test(code)) errs.push('App 没有把天气送进 audio.setRain —— 雨声没接线');
    if (!/psdlampG/.test(code) || !/psdlampA/.test(code)) errs.push('屏蔽门状态灯的两批没有建 —— 门头灯是装饰');
    if (!/isOpen\(g\.i\)/.test(code)) errs.push('屏蔽门灯的 emi 没有按站状态给 —— 永远亮或永远灭');
    if (!/doorLampK\(open/.test(code)) errs.push('车门提示灯没有走 doorLampK —— 亮度与门状态脱钩');
    const audioSrc = require('fs').readFileSync('./src/audio.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (!/i \* SH\.DOOR_BEEP/.test(audioSrc)) errs.push('关门蜂鸣没有落在 SH.DOOR_BEEP 时间轴上 —— 与门灯不同步');
    if (!/rainHiss\.g\.gain\.setTargetAtTime\(rg\.hiss/.test(audioSrc)) errs.push('雨声两层增益没有真的送到增益节点 —— rainGain 是个空函数');
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 门区：门灯三档与蜂鸣同轴、屏蔽门双灯按站给状态；C5 逐节档位贴住整车均值；雨刮画的是会动的矩阵；雨的四处接线齐全');
}

/* ---- G. 实例化通道对账（AI 车队中段车） ----
 * 为什么这条必须在**离线**判据里：dev/inst-check.js 量的是真 GPU 的画面，
 * 而"实例数没传到 GL""实例矩阵全是单位阵""回退分支断了"这三类错，
 * 在无 GPU 的 runall 里全是静默的。录制型 renderer 把产品自己的 drawExternal
 * 交给 GL 的每一条 (批次, 矩阵) 记账出来，两条通道逐条对账 —— 量的是结果。
 * 与雨刮那条同源（第 70 条）：判据不许自己再推一遍矩阵。 */
console.log('\n—— G. 实例化通道（AI 车中段车：省的是 draw，不是车）——');
{
  const errs = [];
  const L = new LineRuntime(SH.LINES.l1);
  const carsN = L.profile.cars;
  const mkRec = withInst => {
    const ev = [];
    let seq = 0;
    const key = m => 'k' + (seq++) + '/' + ((m && m.mat) || '?');
    const r = {
      ev,
      upload(ms) { return (Array.isArray(ms) ? ms : [ms]).map(m => ({ mat: m && m.mat, _k: key(m) })); },
      dropTag() {},
      draw(b, M, ov) { ev.push(b._k + '|' + Array.from(M || []).map(x => x.toFixed(6)).join(',') + '|' + (ov && ov.emi != null ? +ov.emi.toFixed(4) : '')); },
    };
    if (withInst) r.drawInstanced = (b, mats, ov) => { for (const M of mats) r.draw(b, M, ov); };
    r.stats = { drawCalls: 0 };
    return r;
  };
  const mkView = withInst => {
    const r = mkRec(withInst);
    const nD = r.draw.bind(r), nI = withInst ? r.drawInstanced.bind(r) : null;
    /* draw 次数要按**真实渲染器**的口径数：recorder 的 drawInstanced 会展开成
       逐实例 r.draw 来记矩阵账，那些不能算成 draw call，否则两条通道永远一样多。 */
    let nd = 0, ni = 0, inInst = 0, maxInst = 0;
    r.draw = (b, M, ov) => { if (!inInst) nd++; return nD(b, M, ov); };
    if (withInst) r.drawInstanced = (b, mats, ov) => {
      ni++; inInst++;
      if (mats.length > maxInst) maxInst = mats.length;
      try { nI(b, mats, ov); } finally { inInst--; }
    };
    const v = new GameTrainView(r);
    v.setLine(L, null, null);
    v.counts = () => ({ nd, ni, maxInst });
    return v;
  };
  const sorted = ev => ev.slice().sort().join('\n');
  /* 样本必须**能暴露**分档：中间车若全同档，"按档分组"这条就无从验证 */
  const LOAD = 0.6, SEED = 3;
  const lvMid = SH.train.paxLevels(LOAD, carsN, SEED).slice(1, carsN - 1);
  if (new Set(lvMid).size < 2) errs.push(`样本退化：中间车档位 ${lvMid} 全同 —— 换 LOAD 再测，否则分档判据是空的`);
  for (const [name, fn, open, closing] of [
    ['drawExternal 关门', 'drawExternal', 0, false],
    ['drawExternal 开门', 'drawExternal', 0.62, true],
    ['drawExternalOpp 对向', 'drawExternalOpp', 0.35, false],
  ]) {
    const vi = mkView(true), vf = mkView(false);
    vi.now = vf.now = 1.7;
    let crash = '';
    try { vi[fn](900, open, LOAD, closing, SEED); } catch (e) { crash = '实例化路径抛错 ' + e.message; }
    try { vf[fn](900, open, LOAD, closing, SEED); } catch (e) { crash += (crash ? ' / ' : '') + '逐车通道抛错 ' + e.message; }
    if (crash) { errs.push(`${name}：${crash}`); continue; }
    const ci = vi.counts(), cf = vf.counts();
    if (sorted(vi.r.ev) !== sorted(vf.r.ev)) {
      const A = sorted(vi.r.ev).split('\n'), B = sorted(vf.r.ev).split('\n');
      let k = 0; while (k < A.length && k < B.length && A[k] === B[k]) k++;
      errs.push(`${name}：实例化与逐车两条通道交出的 (批次,矩阵) 不一致（共 ${A.length} vs ${B.length} 条，第 ${k} 条起分叉）`
        + `\n      实例化 ${String(A[k]).slice(0, 120)}\n      逐车   ${String(B[k]).slice(0, 120)}`);
    }
    if (!ci.ni) errs.push(`${name}：r.drawInstanced 在场却一次都没调 —— fast path 断了（省不到任何 draw）`);
    if (ci.maxInst < carsN - 2) errs.push(`${name}：单次实例化的实例数峰值 ${ci.maxInst} < 中间车数 ${carsN - 2} —— 中段车没有被归并`);
    if (ci.nd + ci.ni >= cf.nd) errs.push(`${name}：实例化通道 draw 次数 ${ci.nd + ci.ni} 不比逐车 ${cf.nd} 少 —— 这一轮优化没有兑现`);
    /* 单位阵注入是这条通道最典型的失效：中段车共用一个矩阵 = 六节车叠在一处。
       关门时每节车一个矩阵，所以"不同矩阵的个数"下限就是编组节数。 */
    const ms = new Set(vi.r.ev.map(x => x.split('|')[1]));
    if (vi.r.ev.length && ms.size < carsN) errs.push(`${name}：整列车只出现 ${ms.size} 个矩阵（应 ≥ 编组 ${carsN} 个）—— 实例矩阵没有逐车变化（单位阵/漏乘）`);
  }
  /* 回退结构：GL1 / 桩渲染器（没有 drawInstanced）必须仍画满整列车 */
  {
    const vf = mkView(false);
    vf.now = 0;
    try {
      vf.drawExternal(900, 0, LOAD, false, SEED);
    } catch (e) {
      errs.push('回退结构：没有 r.drawInstanced 时逐车路径抛错 ' + e.message + ' —— 守卫断了，GL1 与桩渲染器下整列车一批都不画');
    }
    const perCar = vf.r.ev.length / carsN;
    if (!Number.isFinite(perCar) || perCar < 6) errs.push(`回退路径每节车只画了 ${perCar.toFixed(1)} 批 —— 逐车循环被实例化分支吃掉了一半`);
    if (!/if \(this\.r\.drawInstanced && this\.midCarB\)/.test(src)) errs.push('drawExternal/Opp 没有按 r.drawInstanced 与 midCarB 双重守卫回退 —— 桩渲染器或 GL1 下会炸或空画');
  }
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 实例化：三条绘制路径（关门/开门/对向）与逐车通道逐矩阵一致，实例数覆盖全部中间车，draw 真的少了，缺 drawInstanced 时仍画满整列车');
}

/* 渲染上下文红线：WebGL2 必须是第一优先（原生 VAO/uint 索引），WebGL1 回退   必须保留（老设备兼容），且 GL2 路径要有"原生 VAO 包 OES 方法名"的垫片 ——
   缺一条，upload/draw/dropTag 的五处 VAO 调用点就会有一处静默失效。 */
{
  const rs = require('fs').readFileSync('src/renderer.js', 'utf8');
  const i2 = rs.indexOf("getContext('webgl2'"), i1 = rs.indexOf("getContext('webgl'");
  if (i2 < 0) { console.log('✗ renderer.js 没有请求 WebGL2 上下文'); bad++; }
  else if (i1 >= 0 && i1 < i2) { console.log('✗ renderer.js 的 WebGL1 回退排在 WebGL2 之前'); bad++; }
  if (rs.indexOf('createVertexArrayOES: () => gl.createVertexArray()') < 0)
    { console.log('✗ WebGL2 路径缺少原生 VAO → OES 方法名垫片'); bad++; }
  if (rs.indexOf("this.api = gl ? (this.gl2 ? 'WebGL2' : 'WebGL1')") < 0)
    { console.log('✗ 渲染器没有暴露 api 标识（HUD 无法显示当前上下文）'); bad++; }
  if (i2 >= 0 && (i1 < 0 || i1 > i2)) console.log('  ✓ 渲染上下文：WebGL2 优先 + WebGL1 回退 + VAO 垫片在位');
}
/* 实例化通道的三条源码红线。为什么是 lint 而不是纯数值：这三处都在 GL 调用与
   shader 里，**离线没有 GL 上下文**，能量的只有"这一轮的修复还在不在"；
   它们真正画成什么由 dev/inst-check.js 在真 GPU 上对账（实例数 + 像素 A/B + 对照面）。
   三层缺一不可：只有 lint 会"改了写法就红/常数字没人看"，只有 GPU 判据 runall 抓不到。 */
{
  const rs = require('fs').readFileSync('src/renderer.js', 'utf8');
  const errs = [];
  if (rs.indexOf('aI0.xyz * aPos.x + aI1.xyz * aPos.y + aI2.xyz * aPos.z + aI3.xyz') < 0)
    errs.push('实例基变换不是"列向量的线性组合" —— 写成 dot(aI0.xyz, aPos) 等于把旋转取逆（Rᵀ），弯道上的车会歪着走');
  if (/dot\(\s*aI0\.xyz\s*,\s*aPos\s*\)/.test(rs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')))
    errs.push('shader 里又出现 dot(aI0.xyz, aPos) 的点乘式实例变换');
  if (rs.indexOf('this._drawBatch(b, ov, n);') < 0)
    errs.push('drawInstanced 没把实例数交给 _drawBatch —— GL 只会画第 1 个实例，而 draw call 数看起来"优化成功"');
  if (rs.indexOf('gl.uniform1f(u.inst, 0);') < 0)
    errs.push('离开实例化通道时没有把 uInst 归 0 —— 之后每一批普通绘制都被实例矩阵再乘一遍');
  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log('  ✓ 实例化通道三条源码红线在位（列线性组合 / 实例数下传 / uInst 复位）；实景对账跑 node dev/inst-check.js');
}
/* ---- H. 自适应分辨率（DRS：跑不动自己降，跑得动才爬回来） ----
   为什么这一族需要判据：以前画质只有**两个手动旋钮**，玩家机器跑不动时没有任何
   东西会自己让步 —— 而"掉帧"这件事在 vsync 下**测不出余量**（锁在整拍上就是
   锁在整拍上，GPU 到底是 8 ms 还是 16 ms 看不出来），所以策略写歪了也没有直觉
   能纠正。这里不量常量，量**闭环行为**：给一个被控对象（帧成本随像素数上升 +
   出画间隔只能取整拍），跑几十秒合成历史，检查收敛结果与节奏。

   被控对象里那条"限帧器会把 >110 Hz 的屏对半跳拍"是**故意**的：判据必须比
   "误把限帧当成 GPU 不够"更聪明，否则 144 Hz 屏上永远锁不住高档。
   ==========================================================================*/
{
  const ORD = SH.RES_ORDER, D = SH.DRS;
  const errs = [];

  if (!Array.isArray(ORD)) errs.push('SH.RES_ORDER 不存在');
  else {
    const NAT0 = 3.72e6;                         // native 的预算是 0 = "不裁"，这里按本机窗口算成本
    const px = t => SH.RES_TIERS[t] || NAT0;
    for (const t of Object.keys(SH.RES_TIERS)) if (ORD.indexOf(t) < 0) errs.push(`档位表里的 ${t} 不在 SH.RES_ORDER 里`);
    for (const t of ORD) if (SH.RES_TIERS[t] == null) errs.push(`SH.RES_ORDER 里的 ${t} 在 SH.RES_TIERS 没有像素预算`);
    for (let i = 1; i < ORD.length; i++) if (!(px(ORD[i]) > px(ORD[i - 1]))) errs.push(`档位序不对：${ORD[i]} 不比 ${ORD[i - 1]} 贵`);
    for (const t of ORD) if (!SH.RES_NAME || !SH.RES_NAME[t]) errs.push(`档位 ${t} 没有面向玩家的名称（HUD 与设置里要写的是同一个名字）`);
  }

  const NAT = 3.72e6;                              // 本机取证窗口 2560×1452（HANDOFF §5.5 那组数）
  const pxOf = i => SH.RES_TIERS[ORD[i]] || NAT;
  const ideal = raf => SH.drsIdealMs(raf);
  /* vsync：出画间隔只能是刷屏周期的整数拍，且不会快过限帧器允许的那一拍 */
  const cadence = (gpuMs, raf) => Math.max(ideal(raf), Math.ceil(gpuMs / raf) * raf);
  const cost = i => pxOf(i) / NAT;                // 相对原生档的像素成本（填充率瓶颈就按这个走）

  /* 合成一段帧历史：每 50 ms 出一拍，帧成本由 gpuFn(档, 时刻) 给（负荷可以随时间变），
     查表得成本 → 得本拍的出画间隔 → 喂给策略。返回换挡序列与最终档。 */
  const run = (cap, raf, gpuFn, secs, npx, gmsFn) => {
    const st = SH.drsNew(ORD.indexOf(cap));
    const seen = [], dt = 0.05, secAt = new Array(ORD.length).fill(0);
    let minTier = st.tier;
    for (let t = 0; t < secs; t += dt) {
      const b = st.tier;
      SH.drsStep(st, cadence(gpuFn(st.tier, t), raf), raf, dt, npx == null ? NAT : npx,
        gmsFn ? gmsFn(st.tier, t) : 0);
      secAt[st.tier] += dt;
      if (st.tier < minTier) minTier = st.tier;
      if (st.tier !== b) seen.push({ t: +t.toFixed(2), from: ORD[b], to: ORD[st.tier], gap: 0 });
    }
    for (let i = 1; i < seen.length; i++) seen[i].gap = +(seen[i].t - seen[i - 1].t).toFixed(2);
    return { st, seen, secAt, minTier, final: ORD[st.tier], fidx: st.tier };
  };
  const fixed = tbl => (i) => tbl[i];

  if (!errs.length) {
    /* 负荷表按"这一档锁不锁得住拍"写，不按"帧率好不好看"：60 Hz（拍 16.7 ms）上
       一帧 15 ms 是**锁得住**的（出画间隔就是 16.7 ms）。第一版把"弱 GPU"写成
       15/24/45 ms，判据当场指出策略根本没降到位 —— 那张表才是错的，策略是对的。 */
    const WEAK = [15, 20, 28, 40], STRONG = [4, 5, 6, 7];
    /* ① 弱 GPU：除了最低档全部锁不住拍 ⇒ 必须一路降到底并且**停在那里**。
          换挡次数既要有下界（真降到了地板）也要有上界（不是在抖），
          相邻两次换挡必须隔开至少一个冷却期。 */
    const r1 = run('native', 16.7, fixed(WEAK), 120);
    /* 先验负荷表自己：地板档必须锁得住、其余档必须锁不住。这条不是走过场 ——
       第一版的"弱 GPU"表把 1080p 写成 15 ms（60 Hz 上其实锁得住），于是
       "没降到底"这条红的到底是策略还是表，谁也说不清。 */
    if (cadence(WEAK[0], 16.7) > ideal(16.7) * 1.01) errs.push('负荷表写错了：连地板档自己都锁不住拍');
    for (let i = 1; i < WEAK.length; i++)
      if (cadence(WEAK[i], 16.7) <= ideal(16.7) * 1.01) errs.push(`负荷表写错了：${ORD[i]} 其实锁得住拍，不该被算进"弱 GPU"`);
    if (r1.minTier !== 0) errs.push(`弱 GPU 全程最低只到 ${ORD[r1.minTier]}，没降到地板`);
    /* "停得住"量的是**在地板档待了多少时间**，不是最后一秒停在哪 ——
       隔离期到点会有一次合法的重探，掐着表看末态就是把时序巧合当断言。 */
    const floorFrac = r1.secAt[0] / 120;
    if (floorFrac < 0.7) errs.push(`弱 GPU 在地板档只待了 ${(floorFrac * 100).toFixed(0)}% 的时间（应 ≥70%）—— 其余时间在来回翻`);
    if (r1.seen.length < 3) errs.push(`弱 GPU 只换了 ${r1.seen.length} 次档就到地板（原生→2.5K→1080p→720p 应该至少 3 次）`);
    if (r1.seen.length > 3 * ORD.length) errs.push(`弱 GPU 换挡 ${r1.seen.length} 次，超过 3×档位数的界 —— 在抖`);
    for (const s of r1.seen) if (s.gap && s.gap < D.coolS) errs.push(`换挡间隔只有 ${s.gap} s（冷却 ${D.coolS} s）：${s.from}→${s.to}`);

    /* ② 强 GPU：原生档也锁得住 ⇒ **一次都不许动**。
          这一条抓的是"误差判据写反"或"看见高帧率就降档"那一族死法。 */
    const r2 = run('native', 16.7, fixed(STRONG), 120);
    if (r2.seen.length) errs.push(`强 GPU 却被换了 ${r2.seen.length} 次档（${r2.seen.map(s => s.from + '→' + s.to).join(' ')}）—— 跑得动时不许让步`);

    /* ③ 限帧陷阱：144 Hz（拍 6.9 ms）上出画间隔天生是 13.8 ms（>110 Hz 对半跳拍），
          GPU 只有 10 ms 也量出 13.8 —— 必须认得这是**锁住了**而不是掉帧。 */
    const r3 = run('native', 6.94, fixed([4, 6, 8, 10]), 120);
    if (r3.seen.length) errs.push(`144 Hz 屏上把限帧器的半拍当成 GPU 跑不动，降了 ${r3.seen.length} 次档到 ${r3.final}`);

    /* ④ 上限：玩家把上限设在 1080p，那么无论多有劲都不许越过 cap。 */
    const r4 = run('q1080', 16.7, fixed(STRONG), 120);
    if (r4.final !== 'q1080') errs.push(`上限 1080p 却停在 ${r4.final}`);
    if (r4.st.tier > ORD.indexOf('q1080')) errs.push('档位越过了玩家上限');

    /* ⑤ 场景变重：前 60 s 轻（锁在原生档）、之后变重 ⇒ 必须降到底，而且这一段里
          **一次上探都不许发生**（隔离期还没到，重负荷是真实的不是抖动）。
          窗口收在 110 s：retryS=45 s 的那次重探刚好落在窗口之外 —— 再长就变成
          拿时序巧合当断言了。 */
    const r5 = run('native', 16.7, (i, t) => (t < 60 ? STRONG : WEAK)[i], 110);
    if (r5.seen.length && r5.seen[0].t < 55) errs.push(`负荷前 60 s 是轻的，却在 ${r5.seen[0].t} s 就降了档`);
    if (r5.minTier !== 0) errs.push(`变重 50 s 后最低只到 ${ORD[r5.minTier]}，没降到位`);
    if (r5.seen.some(s => ORD.indexOf(s.to) > ORD.indexOf(s.from)))
      errs.push(`变重后的换挡序列里有爬档（${r5.seen.map(s => s.from + '→' + s.to).join(' ')}）—— 重探隔离期没生效`);
    if (r5.seen.length > 3) errs.push(`场景变重后换了 ${r5.seen.length} 次档（到地板只要 3 次）—— 玩家看到的就是画质呼吸`);

    /* ⑥ 恢复：先重（掉到 q720）后轻 ⇒ 稳定一段时间后必须**逐档爬回上限**。
          不然自动档就是一条单程票：进一次隧道，画质再也回不来。 */
    const r6 = run('native', 16.7, (i, t) => (t < 60 ? WEAK : STRONG)[i], 210);
    if (r6.final !== 'native') errs.push(`重负荷 60 s 转轻负荷 150 s 后只爬回 ${r6.final}，没回到上限 native —— 重探的门是不是关死了`);

    /* ⑧⑨ **降档必须真的少画像素**（这一族是直接量出来的：DPR=0.5 那一趟窗口只有
          0.28 M 像素、帧成本全在场景上，而旧写法照样一路降到地板 —— 白改三次 FBO，
          还把玩家的"原生"偷偷改成了 720p。像素预算只是封顶，所以窗口比预算小的时候
          降档一个像素也省不下来，此时正确的动作是**什么都不做**）。 */
    const ANYWAY = [20, 28, 40, 55];              // 连地板档都锁不住拍（瓶颈不在像素上）
    const r8 = run('native', 16.7, fixed(ANYWAY), 120, 0.28e6);
    if (r8.seen.length) errs.push(`窗口 0.28 M 像素（低于所有预算档）时被降了 ${r8.seen.length} 次档 —— 这些降档一个像素也没省下来`);
    const r9 = run('native', 16.7, fixed(ANYWAY), 120, 1.5e6);
    if (r9.seen.length !== 1 || r9.final !== 'q720')
      errs.push(`窗口 1.5 M 像素时应当**一步降到第一档买得到像素的**（q720），实际序列 ${r9.seen.map(s => s.from + '→' + s.to).join(' ') || '（没降）'}`);

    /* ⑩ `SH.drsTarget` 自己：窗口大于所有预算时它就是"降一档"（不许一步到底，
          阶梯是故意的 —— 每次换挡都要重建 FBO）。 */
    for (let from = 1; from < ORD.length; from++) {
      const to = SH.drsTarget(NAT, from);
      if (to !== from - 1) errs.push(`窗口 3.72 M 像素时从 ${ORD[from]} 应当只降一档，drsTarget 给了 ${to}`);
    }
    if (SH.drsTarget(0.28e6, ORD.length - 1) !== -1) errs.push('窗口低于所有预算时 drsTarget 应当返回 -1（一档都买不到）');
    if (SH.drsTarget(NAT, 0) !== -1) errs.push('已经在地板上了，drsTarget 不许再往下');
    /* ⑪ 第二把尺：**慢而欠在场景上** ⇒ 一档都不许降。
          这张负荷表故意用①那一套 WEAK（每一档都锁不住拍），所以只看第一把尺
          必然一路降到地板 —— 两条判据（①降到底 / ⑪一档不降）放在一起，
          才说明拦住它的是 gpuMs，而不是"负荷表本来就轻"。 */
    {
      const rCpu = run('native', 16.7, fixed(WEAK), 120, NAT, () => 2.0);
      if (rCpu.seen.length) errs.push(`GPU 每帧只花 2.0 ms（拍 16.7 ms）而帧仍慢，还是降了 ${rCpu.seen.length} 次档（${rCpu.seen.map(s => s.to).join('→')}）—— 降档买不到帧，它什么也没买到`);
      if (!(rCpu.st.cpu >= SH.DRS.lowS)) errs.push('判成"瓶颈不在分辨率"这件事没有留痕（st.cpu = ' + rCpu.st.cpu + '）—— HUD 上那句提示会是假的');
      /* 同一张表、把 GPU 时间换成"确实吃满"，就必须照旧降到底（排除"是表太轻"）。
         毫秒表 = 6 + 30×像素比：地板档也仍在门槛之上 —— 否则"降到地板之后 GPU 就不忙了"
         是真结论，判据不该为此报红（第一版就是这么写错的）。 */
      const rPix = run('native', 16.7, fixed(WEAK), 120, NAT, i => 6 + 30 * cost(i));
      if (rPix.minTier !== 0) errs.push(`像素确实吃满时没降到底（最低 ${rPix.final}）—— 第二把尺把该降的也拦了`);
      /* 不看末态的 cpu：到了地板之后 GPU 自然不再吃满，那一瞬间的判定本来就该翻成
         "这一档不是像素欠的"（这正是第二把尺要说的话）。要看的是**该降的时候降得早不早**。 */
      if (!(rPix.seen[0] && rPix.seen[0].t < 10)) errs.push(`像素吃满的机器第一次降档发生在 ${rPix.seen[0] ? rPix.seen[0].t : 'never'} s（> 10 s）—— 第二把尺把它当成场景瓶颈拦了一会儿`);
      /* 退闩：先按场景瓶颈拦 60 s，再让 GPU 吃满 —— 必须重新开始降档。
         没有这一步，一次误判就是永久的"再也不降"。 */
      const rUn = run('native', 16.7, fixed(WEAK), 150, NAT, (i, t) => (t < 60 ? 2.0 : 6 + 30 * cost(i)));
      if (!rUn.seen.length) errs.push('GPU 时间后来吃满了却仍一次都没降档 —— "瓶颈不在分辨率"那个闩没有退');
    }
    /* ⑫ 降档必须**买到 GPU 时间**：像素确实少了（drsTarget 保证过）而毫秒数不动
          ⇒ 这一档不是像素欠的 ⇒ 停止继续降。这条是"省下来必须配该给的都给了"那一族。 */
    {
      const rFlat = run('native', 16.7, fixed(WEAK), 200, NAT, () => 12);
      if (rFlat.seen.length > 2) errs.push(`降档没买到 GPU 时间（毫秒表是平的 12 ms）却降了 ${rFlat.seen.length} 次 —— 对账那条没起作用`);
      if (rFlat.seen.length < 1) errs.push('毫秒吃满（12 ms > 门槛）时一次都不降 —— 平表这条把该降的第一次也拦了');
      if (rFlat.st.cpu < SH.DRS.lowS) errs.push(`平表（像素少了而时间不动）没被判成"买不到时间"（st.cpu = ${rFlat.st.cpu}）`);
    }
    /* ⑬ 扩展缺失（gpuMs 给 0）⇒ 行为与"只有一把尺"的旧版逐字相同。
          回退不许改口径，否则老设备上等于换了一个策略而没人知道。 */
    {
      const a = run('native', 16.7, fixed(WEAK), 120);
      const b = run('native', 16.7, fixed(WEAK), 120, null, () => 0);
      if (a.seen.length !== b.seen.length || a.final !== b.final)
        errs.push(`不给 GPU 时间读数时行为变了：${a.seen.length} 次/${a.final} vs ${b.seen.length} 次/${b.final} —— 回退路径必须与旧口径一致`);
    }
    /* ⑭ 读数的另一端：`_pollGpu` 的三条口径（没完成不读、disjoint 丢样本、读完删查询）。
          用假 gl 直接驱动原型上的方法 —— 真机没有这个扩展时，这段仍然是证据。 */
    {
      const P = SH.Renderer && SH.Renderer.prototype;
      if (!P || typeof P._pollGpu !== 'function') errs.push('SH.Renderer.prototype._pollGpu 不存在（GPU 时间这条通道没有可读的一端）');
      else {
        const mk = (avail, disjoint, ns) => {
          const calls = [];
          /* 挂到原型上：_pollGpu 走共用的 _pollQ（两条账同一套三口径），
             裸对象没有这条原型链就等于测了个假方法。 */
          const ctx = Object.assign(Object.create(P), {
            gl: { getQueryParameter: (q, p) => { calls.push(p); return p === 'AV' ? avail : p === 'DIS' ? disjoint : ns; },
              deleteQuery: () => calls.push('DEL') },
            qExt: { RESULT_AVAILABLE_EXT: 'AV', GPU_TIME_DISJOINT_EXT: 'DIS', QUERY_TIME_ELAPSED_EXT: 'T' },
            _q: { fake: 1 }, _qOpen: false, _gpuHist: [], gpuMs: 0,
            _qPost: null, _qPostOpen: false, _gpuPostHist: [], gpuPostMs: 0,
          });
          P._pollGpu.call(ctx);
          return { ctx, calls };
        };
        const g = mk(true, false, 8.4e6);
        if (!(g.ctx.gpuMs > 8 && g.ctx.gpuMs < 9)) errs.push(`正常样本没进 gpuMs（读到 ${g.ctx.gpuMs}，应 ≈8.4 ms）`);
        if (g.ctx._q !== null || g.calls.indexOf('DEL') < 0) errs.push('读完没 deleteQuery —— 查询对象每帧泄漏一个，驱动迟早不给新的');
        const d = mk(true, true, 99e6);
        if (d.ctx.gpuMs !== 0 || d.ctx._gpuHist.length !== 0) errs.push('disjoint（GPU 被抢占）的样本被喂进了策略 —— 拿被抢占的毫秒判"这档跑不动"会白降一档');
        const p = mk(false, false, 5e6);
        if (p.ctx.gpuMs !== 0 || p.ctx._q === null) errs.push('查询还没完成就被读了（或误删了未完成的查询）—— getQueryParameter 在未完成时是阻塞/无意义的');
        const none = Object.assign(Object.create(P), {
          gl: { getQueryParameter: () => { throw new Error('碰了 gl'); }, deleteQuery: () => {} },
          qExt: null, _q: { fake: 1 }, _qOpen: false, _gpuHist: [], gpuMs: 0,
          _qPost: null, _qPostOpen: false, _gpuPostHist: [], gpuPostMs: 0 });
        let threw = 0;
        try { P._pollGpu.call(none); } catch (e) { threw = 1; }
        if (threw || none.gpuMs !== 0) errs.push('扩展不存在时 _pollGpu 不是一条直路（要么抛了要么仍在读 gl —— 回退路径必须干净）');
      }
    }
    /* ⑮ 分 pass 的另一本账（9b②）：`_pollGpuPost` 与世界账同一套三口径，且**不混账**
          —— 后期样本进 gpuPostMs 不进 gpuMs，两条账互不串。混账的分 pass 等于没分。 */
    {
      const P = SH.Renderer && SH.Renderer.prototype;
      if (typeof P._pollGpuPost !== 'function') errs.push('SH.Renderer.prototype._pollGpuPost 不存在（后期链没有自己的读数端）');
      else {
        const mkPost = (avail, disjoint, ns) => {
          const calls = [];
          const ctx = Object.assign(Object.create(P), {
            gl: { getQueryParameter: (q, p) => { calls.push(p); return p === 'AV' ? avail : p === 'DIS' ? disjoint : ns; },
              deleteQuery: () => calls.push('DEL') },
            qExt: { RESULT_AVAILABLE_EXT: 'AV', GPU_TIME_DISJOINT_EXT: 'DIS', QUERY_TIME_ELAPSED_EXT: 'T' },
            _q: null, _qOpen: false, _gpuHist: [], gpuMs: 0,
            _qPost: { fake: 1 }, _qPostOpen: false, _gpuPostHist: [], gpuPostMs: 0,
          });
          P._pollGpuPost.call(ctx);
          return { ctx, calls };
        };
        const g = mkPost(true, false, 2.1e6);
        if (!(g.ctx.gpuPostMs > 2 && g.ctx.gpuPostMs < 2.2)) errs.push(`正常后期样本没进 gpuPostMs（读到 ${g.ctx.gpuPostMs}）—— 后期链的毫秒没有账`);
        if (g.ctx.gpuMs !== 0 || g.ctx._gpuHist.length !== 0) errs.push('后期样本混进了世界账 —— "世界 vs 后期各花多少"还是一笔糊涂账');
        if (g.ctx._qPost !== null || g.calls.indexOf('DEL') < 0) errs.push('后期账读完没 deleteQuery —— 查询对象每帧泄漏一个');
        const d = mkPost(true, true, 99e6);
        if (d.ctx.gpuPostMs !== 0 || d.ctx._gpuPostHist.length !== 0) errs.push('disjoint 的后期样本被收进了账 —— 与世界账同一套口径，丢了才对');
        const p2 = mkPost(false, false, 2e6);
        if (p2.ctx.gpuPostMs !== 0 || p2.ctx._qPost === null) errs.push('后期查询没完成就被读/删了');
      }
    }
    /* ⑮b 刷屏周期的独立测量（9b①）：中位在重负荷下被拉长会把 30fps 判成"锁拍"
          （尺被被测物拽走）；裸最小值会被一两次亚帧抖动读成"屏 156 Hz"（111h）。
          最小支撑箱两头都挡：物理下限挡前者，支撑率挡后者。 */
    {
      const rf = SH.refreshFloor;
      if (typeof rf !== 'function') errs.push('SH.refreshFloor 不存在 —— 刷屏周期仍是 rAF 派发中位独尺，重负荷下 DRS 会自欺');
      else {
        const seq = a => { const h = []; for (let i = 0; i < 600; i++) h.push(a[i % a.length]); return h; };
        const mix = rf(seq([16.7, 16.9, 33.3, 33.4, 16.8]));
        if (mix < 16.4 || mix > 16.6) errs.push(`有下限样本时刷屏周期读成 ${mix} —— 负荷一上来尺自己也被拽长，DRS 会把 30fps 判成锁拍`);
        const jitter = []; for (let i = 0; i < 600; i++) jitter.push(i % 97 === 0 ? 6.5 : 6.9 + (i % 3) * 0.05);
        const jv = rf(jitter);
        if (jv < 6.8 || jv > 7.1) errs.push(`亚帧抖动没被支撑率挡住（读到 ${jv}）—— 又是"不存在的 156 Hz"`);
        const slow = rf(seq([33.2, 33.4, 33.3]));
        if (slow < 33) errs.push(`全程长帧时读数 ${slow} —— 没量到下限就得承认没量到，不许编一个 60 出来`);
        if (rf([16.7, 16.9, 16.8]) !== 0) errs.push('样本不足时不给 0 —— 调用方没法回退到派发中位');
      }
    }
    /* ⑦ 有界性与界：任意波动负荷下档下标永远落在 [0, cap] 内，且**同一档被第二次
          上探的间隔**不小于重探隔离期 —— 这条挡的是玩家看到的"画质来回呼吸"。 */
    const dt = 0.05, load = (i, t, k) => 4 + k * (1 + 0.5 * Math.sin(t / 6) + 0.3 * Math.sin(t / 1.7)) * cost(i);
    for (const cap of ['q720', 'q1080', 'native']) {
      const ci = ORD.indexOf(cap);
      for (const k of [9, 13, 19]) {
        const st = SH.drsNew(ci);
        for (let t = 0; t < 300; t += dt) {
          SH.drsStep(st, cadence(load(st.tier, t, k), 16.7), 16.7, dt, NAT);
          if (st.tier < 0 || st.tier > ci) { errs.push(`上限 ${cap}、负荷系数 ${k} 下波动越界：tier=${st.tier}`); break; }
        }
      }
    }
    /* 同一档被**上探**的间隔：只数往上走的那一步。往下退是安全阀，退得越快越好，
       给它加隔离期等于让掉帧多持续几秒 —— 需要隔离的是"再去试那档更贵的"。 */
    {
      const st = SH.drsNew(ORD.length - 1), times = [];
      for (let t = 0; t < 600; t += dt) {
        const b = st.tier;
        SH.drsStep(st, cadence(load(st.tier, t, 13), 16.7), 16.7, dt, NAT);
        if (st.tier > b) times.push({ t, to: st.tier });
      }
      for (let i = 1; i < times.length; i++) {
        for (let j = 0; j < i; j++) {
          if (times[j].to !== times[i].to) continue;
          const gap = times[i].t - times[j].t;
          if (gap < D.retryS * 0.9) {
            errs.push(`同一档 ${ORD[times[i].to]} 在 ${gap.toFixed(1)} s 内被第二次上探（重探界 ${D.retryS} s）—— 画面上就是画质来回呼吸`);
            i = times.length; break;
          }
        }
      }
      if (!times.length) errs.push('波动负荷下一次都没有上探 —— 自动档只降不升，那就是一条单程票');
    }
  }

  /* 接线 lint：策略写得再对，没人喂样本、或者喂的样本不是**出画间隔**而是"fps"，
     自动档就是个摆设。四道门各挡一种"写了但没接"。 */
  {
    const gs = require('fs').readFileSync('src/game.js', 'utf8');
    const rs2 = require('fs').readFileSync('src/renderer.js', 'utf8');
    /* 第二把尺的四道"写了但没接"的门（GPU 时间这条通道最容易只装表不接线） */
    if (!/drsStep\(this\._drs[^;]*gpuMs[^;]*\)/.test(gs)) errs.push('game.js 没把 `r.gpuMs` 喂给 drsStep —— 第二把尺装了表没人读');
    if (!/EXT_disjoint_timer_query_webgl2/.test(rs2)) errs.push('没申请 EXT_disjoint_timer_query_webgl2');
    if (!/GPU_TIME_DISJOINT_EXT/.test(rs2)) errs.push('没读 GPU_TIME_DISJOINT_EXT —— 被抢占的毫秒会混进策略');
    if (!/beginQuery\(this\.qExt\.TIME_ELAPSED_EXT/.test(rs2) || !/endQuery\(this\.qExt\.TIME_ELAPSED_EXT/.test(rs2))
      errs.push('GPU 时间查询 begin/end 不成对（漏 endQuery 之后每次 beginQuery 都 INVALID_OPERATION，通道静默报废）');
    if (!/this\._pollGpu\(\)/.test(rs2.slice(rs2.indexOf('begin(cam, env, dt)')).slice(0, 900)))
      errs.push('begin() 里没有先收上一帧的读数（gpuMs 会永远停在 0）');
    {
      const iEnd = rs2.indexOf('gl.endQuery(this.qExt.TIME_ELAPSED_EXT)');
      const iRet = rs2.indexOf('if (!this.post || this.quality === \'low\' || !this.sceneFbo) return;');
      if (!(iEnd > 0 && iRet > 0 && iEnd < iRet))
        errs.push('endQuery 写在后期链早退的**后面** —— 低画质档一开就再也不会 endQuery，整条计时通道静默报废');
    }
    if (!/瓶颈不在分辨率/.test(gs)) errs.push('判出"瓶颈不在分辨率"之后 HUD 上没有这一句 —— 玩家只会看到"画质怎么不动"');
    const ix = require('fs').readFileSync('index.html', 'utf8');
    if (!/SH\.drsStep\(/.test(gs)) errs.push('game.js 没有调用 SH.drsStep —— 自适应策略没人喂样本');
    if (!/SH\.drsStep\(this\._drs, cadMed/.test(gs)) errs.push('DRS 吃的不是出画间隔的**中位**（平均帧率会被一次重烘焙顶坑，那一下不该把整局画质判掉）');
    if (!/SH\.drsStep\([^)]*_native/.test(gs)) errs.push('DRS 没拿到窗口像素 —— 不知道画布有多大，就无从判断"这一档到底买不买得到像素"');
    if (!/SH\.drsNew\(/.test(gs)) errs.push('game.js 没有建立 SH.drsNew 状态');
    if (!/SH\.DRS\.skipMs/.test(gs)) errs.push('game.js 的限帧阈值没有读 SH.DRS.skipMs（两处常数迟早各改各的）');
    if (/rawDt < 0\.0092/.test(gs)) errs.push('game.js 还留着裸的 0.0092 限帧阈值');
    if (!/this\.resAuto \? this\._effTier : this\.resTier/.test(rs2)) errs.push('renderer.resize() 没有按 resAuto 取生效档 —— 自动档改了状态而画面没改');
    if (!/id="auto-seg"/.test(ix)) errs.push('设置面板没有自动档开关');
    if (!/resAuto:\s*!!this\.r\.resAuto/.test(gs)) errs.push('自动档开关没有写进存档（重启就忘掉）');
    if (!/setResAuto\(this\.settings\.resAuto/.test(gs)) errs.push('开机没有恢复自动档开关');
    if (!/SH\.RES_ORDER\.indexOf\(this\.settings\.res\)/.test(gs)) errs.push('开机恢复分辨率时又自带了一张档位表（改了 RES_ORDER 就悄悄失配）');
    /* 9b①② 的四道门：刷屏周期独立读数要真的喂进策略；后期链的查询要真的开、
       真的收、真的有自己的账 —— 分 pass 最容易只装表不接线。 */
    if (!/drsStep\(this\._drs[^;]*refreshMs \|\| raf[^;]*\)/.test(gs))
      errs.push('game.js 没把独立量到的刷屏周期喂给 drsStep（refreshMs || raf）—— 重负荷下尺又被 rAF 中位拽走了');
    if (!/SH\.refreshFloor/.test(rs2)) errs.push('renderer.js 没有 SH.refreshFloor —— 刷屏周期没有独立测量');
    if (!/gpuPostMs/.test(gs)) errs.push('HUD 没显示后期链毫秒 —— 分 pass 装了表没人读');
    if (!/gl\.beginQuery\(this\.qExt\.TIME_ELAPSED_EXT, qp\); this\._qPostOpen = true/.test(rs2)
      || !/this\._qPostOpen\) \{ gl\.endQuery\(this\.qExt\.TIME_ELAPSED_EXT\); this\._qPostOpen = false; \}/.test(rs2))
      errs.push('后期链的查询 begin/end 不成对 —— 与世界账同一个坑（INVALID_OPERATION 之后通道静默报废）');
  }

  if (errs.length) { bad += errs.length; console.log('  ✗ ' + errs.join('\n  ✗ ')); }
  else console.log(`  ✓ 自适应分辨率：弱 GPU 降到底并停住、强 GPU 一次不动、144 Hz 的半拍不被误判掉帧、不越玩家上限、变轻后逐档爬回、同档上探间隔 ≥ ${D.retryS} s（换挡次数与重探都有界）；降档必须真的少画像素（窗口低于所有预算时一动不动、1.5 M 窗口一步降到第一档买得到的、3.72 M 窗口只许逐档下台阶）；接线门在位；分 pass 两本账与刷屏周期独立测量都在（⑮）`);
}
console.log(bad ? `\n✗ ${bad} 项判据未通过` : '\n✓ 时刻与环境全部判据通过（天光随时段、发车密度随时段、首末班收车、雨天、门区与车内分布、自适应分辨率）');
process.exitCode = bad ? 1 : 0;
