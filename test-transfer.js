/* ============================================================================
 * test-transfer.js — 换乘类型与走行时间的离线判据（第 14 个自测）
 *
 * 为什么要有它：`SH.INTER` 是"同名即换乘"推导出来的，于是三件完全不同的事
 * 被抹平成一种：
 *   · 站内换乘（付费区内通道）—— 绝大多数；
 *   · 出站换乘（出闸→地面→再进闸，官方图上画两个圈）—— 2/14 号线的 浦东南路；
 *   · 共线同站台（3/4 号线 虹桥路/延安西路/宝山路）—— 根本不是换乘。
 * 前者的后果是**站台屏与报站说了假话**（"可换乘 4 号线"而那是同一条站台），
 * 后者的后果是这 3 站凭空多拿一份换乘客流。两者在画面上都完全看不出来 ——
 * 站台上照样有人、屏上照样有字，只有量"系数按类型给没给对"才分得清。
 *
 * 这一节量五组：
 *   A 覆盖面：每个换乘点都有类型与走行时间，类型只有三种取值；
 *   B 分类正确：出站换乘、纯共线、以及"共线段上还接别的线"的站各归其位；
 *   C 走行时间：共线 = 0、出站 > 站内、站内随换乘线路数不减、有上界；
 *   D 模型效应：客流系数真的按类型给（A/B 实测，不读源码里的常数）；
 *   E 接线：pax.js 读 INTER_META、报站按类型措辞、线路图不把共线站画成换乘站。
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
/* 报站文案定义在 game.js 里（`Object.assign(SH.audio.PA.prototype, {...})`），
   与 test-traffic 同样的处理：加载失败要让这一节报红，不能静默退化成"什么都没测"。 */
try { require('./src/game.js'); } catch (e) { console.log('⚠ game.js 未能加载：', e.message); }

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

console.log('—— A. 覆盖面 ——');
{
  const keys = Object.keys(SH.INTER);
  const meta = SH.INTER_META || {};
  const miss = keys.filter(n => !meta[n]);
  ok(keys.length >= 70 && !miss.length, `${keys.length} 个换乘点全部有类型与走行时间${miss.length ? '（缺：' + miss.slice(0, 4).join('/') + '）' : ''}`);
  const badType = keys.filter(n => !['in', 'out', 'shared'].includes(meta[n] && meta[n].type));
  ok(!badType.length, `类型只有 in/out/shared 三种取值${badType.length ? '（异常：' + badType.slice(0, 4).join('/') + '）' : ''}`);
  const badWalk = keys.filter(n => !(typeof meta[n].walkSec === 'number' && meta[n].walkSec >= 0 && meta[n].walkSec <= 400));
  ok(!badWalk.length, `走行时间都是 0~400 s 的有限数${badWalk.length ? '（异常：' + badWalk.slice(0, 4).join('/') + '）' : ''}`);
}

console.log('\n—— B. 分类正确 ——');
{
  const M = n => (SH.INTER_META[n] || {}).type;
  ok(M('浦东南路') === 'out', `浦东南路（2/14）是**出站换乘**（实得 ${M('浦东南路')}）—— 官方图上画的是两个圈，按站内换乘算就是说了假话`);
  const pure = ['虹桥路', '延安西路', '宝山路'];
  const badPure = pure.filter(n => M(n) !== 'shared');
  ok(!badPure.length, `恰好只接 3/4 号线的 ${pure.join('/')} 是**共线同站台**${badPure.length ? '（误判：' + badPure.join('/') + '）' : ''}`);
  /* 共线段上还接着别的线的站 —— 它们是**真换乘站**，不能因为"在共线段上"就抹掉 */
  const realX = ['中山公园', '金沙江路', '镇坪路', '曹杨路', '上海火车站'];
  const badReal = realX.filter(n => M(n) !== 'in');
  ok(!badReal.length, `共线段上仍接别的线的 ${realX.length} 站是真换乘站（不是 shared）${badReal.length ? '（误判：' + badReal.join('/') + '）' : ''}`);
  ok(M('世纪大道') === 'in' && M('人民广场') === 'in', '四线/三线枢纽（世纪大道、人民广场）是站内换乘');
}

console.log('\n—— C. 走行时间 ——');
{
  const meta = SH.INTER_META;
  const walk = n => meta[n].walkSec;
  ok(walk('虹桥路') === 0, `共线同站台走行时间 0 s（实得 ${walk('虹桥路')}）—— 它不用走路`);
  ok(walk('浦东南路') > walk('世纪大道'), `出站换乘（${walk('浦东南路')} s）比站内四线换乘（${walk('世纪大道')} s）更久 —— 要出闸再进闸`);
  /* 站内换乘随换乘线路数不减 */
  const byLines = {};
  for (const n in meta) { const k = meta[n].lines.length; if (meta[n].type === 'in') byLines[k] = Math.min(byLines[k] == null ? 1e9 : byLines[k], meta[n].walkSec); }
  const ks = Object.keys(byLines).map(Number).sort((a, b) => a - b);
  let mono = true;
  for (let i = 1; i < ks.length; i++) if (byLines[ks[i]] < byLines[ks[i - 1]]) mono = false;
  ok(mono, `站内换乘走行时间随换乘线路数不减（${ks.map(k => k + '线→' + byLines[k] + 's').join(' · ')}）`);
  const cap = Object.keys(meta).filter(n => meta[n].walkSec > 400);
  ok(!cap.length, `没有超过 400 s 的走行时间（最久 ${Math.max(...Object.keys(meta).map(n => meta[n].walkSec))} s）`);
}

console.log('\n—— D. 模型效应：客流系数真的按类型给 ——');
{
  /* A/B 实测：把 INTER_META 里那一项临时摘掉再算一遍，比值就是模型实际用的系数。
     直接读源码里的常数等于复述实现，量不出"它到底生效没有"。 */
  const dem = (name, hour) => SH.pax.demand('l2', name, 5, 30, hour).board;
  const demNo = (name, hour) => {
    const keep = SH.INTER_META[name]; delete SH.INTER_META[name];
    const v = dem(name, hour);
    if (keep) SH.INTER_META[name] = keep;
    return v;
  };
  const expCoef = name => {
    const M = SH.INTER_META[name];
    if (!M || M.type === 'shared') return 1;
    const hh = SH.hash32('l2>' + name, 977) % 3;
    return M.type === 'out' ? 1.30 + 0.12 * hh : 1.55 + 0.25 * hh;
  };
  for (const n of ['世纪大道', '浦东南路', '虹桥路', '南京东路']) {
    const ratio = dem(n, 8) / demNo(n, 8), e = expCoef(n);
    ok(Math.abs(ratio / e - 1) < 0.04, `${n.padEnd(5)} 客流系数实测 ${ratio.toFixed(3)} ≈ 按类型给的 ${e.toFixed(2)}（${(SH.INTER_META[n] || {}).type || '普通站'}）`);
  }
  ok(expCoef('浦东南路') < expCoef('世纪大道'), `出站换乘的加成（${expCoef('浦东南路').toFixed(2)}）低于站内换乘（${expCoef('世纪大道').toFixed(2)}）—— 换乘意愿差一档`);
}

console.log('\n—— E. 接线：类型必须真的被用上 ——');
{
  /* 剥注释再查：注释里出现的同一个字符串会假命中（第 100 条那次教训）。 */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const paxSrc = strip(require('fs').readFileSync('./src/pax.js', 'utf8'));
  ok(/SH\.INTER_META/.test(paxSrc), 'pax.js 的发送量读了 SH.INTER_META（换乘系数按类型给）');
  const gSrc = strip(require('fs').readFileSync('./src/game.js', 'utf8'));
  ok(/INTER_META/.test(gSrc), 'game.js 用了 INTER_META（报站措辞与线路图）');
  /* 报站文案：出站换乘与共线同站台必须说清楚。
     第 111-3 条后三段各司其职：换乘类型在**发车段**（departing，"下一站"）
     播，进站段只播"即将进站"短句 —— 断言跟着搬到 departing。 */
  let said = '';
  const pa = new SH.audio.PA({ ready: false });
  pa.onText = t => { said = t.zh; };
  if (typeof pa.departing !== 'function') { ok(false, 'PA 上没有 departing —— 报站文案没接上'); }
  else {
    pa.departing('浦东南路', { id: 'l2' });
    ok(/出站换乘/.test(said), `出站换乘站报「${said}」—— 必须点明要出闸再进闸`);
    pa.departing('虹桥路', { id: 'l3' });
    ok(/同站台/.test(said), `共线站报「${said}」—— 说"可换乘 4 号线"是把同一条站台说成两条线`);
    pa.departing('世纪大道', { id: 'l2' });
    ok(/站内换乘/.test(said), `站内换乘站报「${said}」`);
  }
  if (typeof pa.approaching === 'function') {
    pa.onText = t => { said = t.zh; };
    pa.approaching('世纪大道', { id: 'l2' }, 1, SH.INTER['世纪大道']);
    ok(/即将进站/.test(said) && !/下一站/.test(said), `进站段报「${said}」—— 短句，不再把"下一站"重复两遍`);
  }
}

console.log('\n—— F. 换乘通道 3D 几何（第 116 条） ——');
{
  /* 验证所有 type === 'in' 的站内换乘车站，在烘焙世界时均生成 transferPassage 3D 几何设施：
     ① 设施记录 kind === 'transferPassage'，含有 lines、mats 等关键字段；
     ② 导向牌图集已生成 'inter:' + name 对应的发光导向牌，文案含 '换乘' 与目标线名；
     ③ 非站内换乘站（shared 或普通站）不生成 transferPassage；
     ④ 通道设施坐标 (s, lat, dy) 在站台外侧且高度合理。 */
  Object.assign(global, SH);
  const gsrc = require('fs').readFileSync('./src/game.js', 'utf8');
  const grab = (name) => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
  const LineRuntime = eval('(' + grab('LineRuntime') + ')');
  const l1Def = SH.LINES.l1;
  const line1 = new LineRuntime(l1Def);
  const sign = new SH.textures.SignAtlas(4096);
  const wb = new SH.WorldBuilder({ al: line1.al, color: l1Def.color, stations: l1Def.stations, sign, profile: line1.profile });
  wb._installLight();
  SH.WorldBuilder.buildRuns(wb, line1, 0, line1.al.total);

  const facs = wb.facilities || [];
  const transfers = facs.filter(o => o.kind === 'transferPassage');

  const inStationsOnL1 = line1.stations.filter(name => {
    const m = SH.INTER_META[name];
    const other = (SH.INTER[name] || []).filter(x => x.id !== 'l1');
    return m && m.type === 'in' && other.length > 0;
  });

  /* 按站分组：一条通道可能有多段腿（主干 + 每支换乘线一段） */
  const byStation = new Map();
  for (const t of transfers) {
    const arr = byStation.get(t.station) || [];
    arr.push(t); byStation.set(t.station, arr);
  }
  const missing = inStationsOnL1.filter(n => !byStation.get(n));
  ok(missing.length === 0 && byStation.size === inStationsOnL1.length,
    `1号线 ${inStationsOnL1.length} 个站内换乘站全部生成 transferPassage 3D 换乘通道（实得 ${byStation.size} 站${missing.length ? '，缺：' + missing.join('/') : ''}）`);

  /* 通道长度必须跟着 walkSec 走 —— 这是这一节存在的原因。
     以前几何固定 6.8 m，而数据说这站要走 70~210 秒（≈80~240 m），
     文案在涨、几何一动不动。 */
  let lenBad = 0, legBad = 0;
  for (const name of inStationsOnL1) {
    const meta = SH.INTER_META[name], plan = SH.transferPlan(name, meta);
    const legs = byStation.get(name) || [];
    const sum = legs.reduce((a, t) => a + (t.len || 0), 0);
    if (Math.abs(sum - plan.total) > Math.max(1.5, plan.total * 0.02)) { lenBad++; continue; }
    const nOther = (SH.INTER[name] || []).filter(x => x.id !== 'l1').length;
    if (legs.length !== nOther + 1) legBad++;
  }
  ok(lenBad === 0, '每座换乘站的通道总长 = walkSec × 走行速度 − 站厅段 − 闸机段（逐站对账，实错 ' + lenBad + ' 站）');
  ok(legBad === 0, '腿数 = 1 主干 + 每条换乘线一支（实错 ' + legBad + ' 站）');
  /* 拿"三线站 vs 两线站"比，必须真的取两类各一座：
     第一版拿 人民广场(l1/l2/l8) 比 中山公园(l2/l3/l4)，两个都是三线站、
     算出来都是 98 m，那条 ">0.9" 的断言于是永远成立 —— 空指标。 */
  const threeN = inStationsOnL1.find(n => (SH.INTER[n] || []).length === 3);
  const twoN = inStationsOnL1.find(n => (SH.INTER[n] || []).length === 2);
  const pA = SH.transferPlan(threeN, SH.INTER_META[threeN]);
  const pB = SH.transferPlan(twoN, SH.INTER_META[twoN]);
  ok(pA.total > pB.total * 1.4,
    `三线站通道明显长于两线站：${threeN} ${pA.total.toFixed(0)} m vs ${twoN} ${pB.total.toFixed(0)} m`);
  const sharedSt = line1.stations.filter(n => SH.INTER_META[n] && SH.INTER_META[n].type === 'shared');
  const sharedFacs = facs.filter(o => o.kind === 'transferShared');
  ok(sharedSt.length === 0 || sharedFacs.length >= 1,
    `共线同站台站不建通道、改挂"同一站台"双面吊牌（1号线共线站 ${sharedSt.length} 座、吊牌 ${sharedFacs.length} 处）`);
  ok(!transfers.some(t => sharedSt.includes(t.station)), '共线同站台站没有生成换乘通道（那是走到对面，不是一条通道）');

  /* 一条腿只登记它自己那一支的目标线路（以前是一块牌写全部线路，
     于是走错方向也看不出来），所以"覆盖全部换乘线"要按**站**取并集来断言。 */
  const rmLines = (byStation.get('人民广场') || []).reduce((a, t) => a.concat(t.lines || []), []);
  ok(rmLines.includes('l2') && rmLines.includes('l8'),
    `人民广场各支通道合起来覆盖 l2 与 l8（实得 [${rmLines.join(',')}]）`);

  const lh = transfers.find(t => t.station === '莲花路');
  ok(!lh, '莲花路（非换乘站）不生成 transferPassage 换乘通道');

  const rmSigns = ['interline:人民广场:l2', 'interline:人民广场:l8', 'interend:人民广场']
    .filter(k => sign.rects.get(k));
  ok(rmSigns.length === 3, `人民广场每支通道各一块指名导向牌 + 尽端总牌（图集实得 ${rmSigns.length}/3）`);

  const allOutside = transfers.every(t => Math.abs(t.lat) > 8.0 && t.dy > 1.0);
  ok(allOutside, '换乘通道入口横向坐标全部位于站厅外侧（|lat| > 8.0m, dy > 1.0m）');
}

/* ---------- G 共线同站台：对面站台必须挂"另一条线"的身份 ----------
 * 3/4 号线在 虹桥路 / 延安西路 / 宝山路 是**同台对面换乘**（walkSec = 0）。
 * 站体那一侧现在有两座站台了，但如果对面那条色带与站名标仍写着本线，
 * 画面说的就是假话 —— "过对面站台"根本到不了另一条线。
 * 量法：烘一座 shared 站，看 paint 顶点里有没有**对方线路的颜色**（4 号线紫）
 * 与本线颜色（3 号线黄）各成一整条色带；缺一个就是身份没挂上。 */
{
  const shared = (SH.LINES.l3.stations || []).filter(n => SH.INTER_META[n] && SH.INTER_META[n].type === 'shared');
  ok(shared.length >= 3, `3 号线上共线同站台（shared）的站：${shared.join('/') || '无'}（应为 虹桥路/延安西路/宝山路）`);
  const def = SH.LINES.l3;
  const line = new LineRuntime(def);
  const px = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255);
  /* **顶点色是带光照烘过的**：`col × (烘焙光 + emi)`，那个系数逐顶点不同，
     拿原始十六进制直接比色必然全 0（第一版实测：本线 0/3、邻线 0/3，
     而画面上两条带都在）。但缩放是**各通道同比**的（emi 加算用的也是同一条色），
     所以归一到"三色之和 = 1"之后色相比例不变 —— 量的仍是那条带本身，不是程序的说法。
     实测 虹桥路：本线黄 #FFD100 → 0.55/0.45/0.00 共 196 个顶点，
     邻线紫 #5B2D8D → 0.33/0.16/0.51 共 200 个顶点，两条带同量级。 */
  const hue = c => { const t = c[0] + c[1] + c[2]; return t < 1e-6 ? null : c.map(v => v / t); };
  const near = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
  let recOk = 0, peerOk = 0, ownOk = 0, plateOk = 0;
  let minRatio = 1, detail = [];
  for (const nm of shared) {
    const si = def.stations.indexOf(nm), s = line.al.stationS[si];
    if (s == null) continue;
    const sign = new SH.textures.SignAtlas(2048);
    const wb = new SH.WorldBuilder({ al: line.al, color: def.color, stations: def.stations, sign, night: 0.62, profile: line.profile });
    wb.ambient = [0.26, 0.29, 0.36]; wb.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; wb._installLight();
    SH.WorldBuilder.buildRuns(wb, line, Math.max(0, s - 200), s + 200, null);
    if ((wb.farPlatforms || []).some(f => Math.abs(f.s - s) < 160)) recOk++;
    const peer = SH.peerAtShared('l3', nm);
    const tp = peer && hue(px(peer.color)), to = hue(px(def.color));
    /* 对面那块站名牌必须写**对方线路**的编号：图集里要有以 peer.id 结尾的那张牌。 */
    if (peer && sign.rects.get('plate:' + nm + ':' + peer.id)) plateOk++;
    let hp = 0, ho = 0;
    for (const m of wb.b.finish()) {
      if (m.mat !== 'paint' || !m.col) continue;
      let mx = 0;
      for (let i = 0; i + 2 < m.col.length; i += 3) mx = Math.max(mx, m.col[i], m.col[i + 1], m.col[i + 2]);
      const unit = mx > 1.5 ? 255 : 1;
      for (let i = 0; i + 2 < m.pos.length; i += 3) {
        /* 只数色带所在的高度窗（y ≈ 2.40~2.56），别把站台上别的油漆件算进来 */
        if (m.pos[i + 1] < 2.36 || m.pos[i + 1] > 2.60) continue;
        const h = hue([m.col[i] / unit, m.col[i + 1] / unit, m.col[i + 2] / unit]);
        if (near(h, tp)) hp++;
        if (near(h, to)) ho++;
      }
    }
    if (hp > 60) peerOk++;
    if (ho > 60) ownOk++;
    /* 对面那条带不能只是"沾了几滴颜色"：与本色带同量级才算真挂上了身份 */
    if (ho > 0) { const r = hp / ho; if (r < minRatio) { minRatio = r; detail = [nm, hp, ho]; } }
  }
  ok(recOk === shared.length && shared.length > 0, `共线站台的对向站台登记：${recOk}/${shared.length} 处`);
  ok(ownOk === shared.length, `本线色带在位：${ownOk}/${shared.length} 处（缺=烘不出自己那条线）`);
  ok(peerOk === shared.length, `对面站台挂的是**对方线路**的色带：${peerOk}/${shared.length} 处（缺=画面上"过对面"到不了另一条线）`);
  ok(minRatio >= 0.4, `对向色带与本侧色带同量级：最小 ${minRatio.toFixed(2)}（${detail.join('：')} 顶点 ${detail[1]}/${detail[2]}）—— 稀疏几滴不叫挂上身份`);
  ok(plateOk === shared.length, `对面站台挂的是对方线路的站名牌：${plateOk}/${shared.length} 处（缺=牌上还写着本线）`);
}

console.log(bad ? `\n✗ ${bad} 项判据未通过` : '\n✓ 换乘类型与走行时间及 3D 几何全部判据通过（分类正确、走行时间合理、客流系数按类型给、换乘通道 3D 几何闭环、共线站台挂对向线路身份）');
process.exitCode = bad ? 1 : 0;
