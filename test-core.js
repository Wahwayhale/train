global.window = global; global.document = { createElement: () => ({ getContext: () => null, width:0, height:0 }) };

/* 第一道闸：把每个源文件单独编译一遍（不执行）。
   浏览器里一个文件语法挂了 = 整个模块不存在，页面只是不动，控制台常常什么也没有。
   实际踩过：renderer.js 里重复声明了一个 const u，结果 window.__SH 从来没被建出来，
   截图全是 "NO APP"，找了半天以为是自己脚本的问题。
   vm.Script 只编译不运行，正好当这道闸。 */
/* 注意变量名：这个文件后面有 `const path = al.frames(...)`，所以这里不能用 path/fs 这种短名。 */
const nodeVm = require('vm'), nodeFs = require('fs'), nodePath = require('path');
let syntaxBad = 0, syntaxN = 0;
for (const dir of ['src', 'data']) for (const f of (nodeFs.readdirSync(dir) || [])) {
  if (!f.endsWith('.js')) continue;
  const p = nodePath.join(dir, f); syntaxN++;
  try { new nodeVm.Script(nodeFs.readFileSync(p, 'utf8'), { filename: p }); }
  catch (e) { syntaxBad++; console.log('✗ 语法错误 ' + p + '：' + e.message); }
}
console.log(syntaxBad ? `✗ ${syntaxBad}/${syntaxN} 个源文件语法不过` : `✓ ${syntaxN} 个源文件语法编译通过`);

require('./src/core.js'); require('./src/mesh.js'); require('./src/align.js');
const SH = global.SH;
const stations = ['莘庄','外环路','莲花路','锦江乐园','上海南站','漕宝路','上海体育馆','徐家汇','衡山路','人民广场','黄陂南路','陕西南路','常熟路','衡山路2'];
const gaps = SH.synthGaps(stations, 1150, 620, 1);
const al = SH.buildLineAlignment(stations, gaps, 12345);
console.log('线路总长', al.total.toFixed(0), 'm | 站数', al.stationS.length, '| 期望', stations.length);
let bad = 0, nan = 0;
for (let i = 0; i < al.stationS.length; i++) {
  const s = al.stationS[i];
  const st = al.at(s);
  if ([st.x,st.y,st.z,st.th,st.grade,st.cant].some(v=>!isFinite(v))) { nan++; console.log('NaN at station',i); }
  // 站台区必须是直线
  let kmax = 0;
  for (let d = -SH.PLAT.PRE; d <= SH.PLAT.POST; d += 4) kmax = Math.max(kmax, Math.abs(al.at(s+d).k));
  if (kmax > 1e-9) { bad++; console.log('  站台非直线! 站'+i+' '+stations[i]+' k='+kmax.toExponential(1)); }
  // 站心坡度应为 0
  const g = al.at(s).grade*1000;
  if (Math.abs(g) > 0.01) console.log('  站台有坡度 站'+i+' g='+g.toFixed(2)+'‰');
}
console.log('站台直线违规', bad, '| NaN', nan);
// 站间距是否达标
let gerr = [];
for (let i=0;i<gaps.length;i++) gerr.push(+(al.stationS[i+1]-al.stationS[i]-gaps[i]).toFixed(1));
console.log('站间距误差 max', Math.max(...gerr.map(Math.abs)), 'm');
// 曲线统计
let radii=[]; for(let s=0;s<al.total;s+=3){const st=al.at(s); if(st.k) radii.push(1/Math.abs(st.k));}
radii.sort((a,b)=>a-b);
console.log('曲线数量段', radii.length, '| 最小半径', radii[0]?radii[0].toFixed(0):'-', 'm | 曲线限速', radii[0]?(Math.sqrt(0.16*9.81*radii[0])*3.6).toFixed(0):'-','km/h');
// 连续性：相邻里程位置差应≈步长
let maxJump=0;
for(let s=0;s<al.total-10;s+=7){const a=al.at(s),b=al.at(s+10);const d=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);maxJump=Math.max(maxJump,Math.abs(d-10));}
console.log('中线连续性最大误差', maxJump.toFixed(4), 'm (应≈0)');
// frame 正交性
const fr = al.frame(al.total*0.4);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
console.log('frame 正交检查 r·f', dot(fr.r,fr.f).toExponential(1), 'u·f', dot(fr.u,fr.f).toExponential(1), '|r|', Math.hypot(...fr.r).toFixed(5));
// 几何烘焙
const b = new SH.Builder();
b.box([0,0,0],[2,3,4],[0.6,0.6,0.65],{mat:'concrete'});
const path = al.frames(1000, 1060, 4);
b.sweep(path, SH.Geo.circleProfile(2.7, 18), {mat:'segment', color:[0.55,0.57,0.6], closed:true, uvAlong:1/6, flip:true});
const out = b.finish();
console.log('烘焙批次', out.map(g=>g.mat+':'+g.verts+'v/'+g.count/3+'t').join(' '));
const allpos = out.flatMap(g=>Array.from(g.pos));
console.log('坐标有限性', allpos.every(isFinite) ? 'OK' : 'FAIL', '| 顶点总数', out.reduce((t,g)=>t+g.verts,0));

/* ============================ 全部真实线路的线形体检 ============================
 * 单条合成线跑通不代表 20 条真数据都跑通：站数从 2（磁浮）到 43（15 号线）跨度很大，
 * 任何一条出现 NaN 里程、站序倒退、或总长被压成几十米，整条线就没法开。
 */
require('./data/shanghai.js');
const LINES = SH.LINES;
let fails = 0;
/* ---------------- 站表卫生 ----------------
 * 站名是这个项目里唯一一处"错了也不会红"的数据：10 个自测曾经在全网站表大量
 * 编造的情况下照样全绿（1 号线尾部挂着 2/9 号线的站、15 号线 43 站里只有 17 站
 * 存在）。更糟的是当时为了让"同名即换乘"的推导不报错，我造了 东明路2 /
 * 国际客运中心2 / 南京西路2 / 人民广场2 这种带数字尾巴的假站名 —— 它们既不在
 * 任何一张图上，也不会有任何测试去查。这里把能机器判定的几条钉死。 */
const dataErrs = [];
/** 假站名的两种长相：数字尾巴（为了让同名换乘推导不报错而造的占位名）、
 *  混进拉丁字母。真图上两者都不存在。 */
const nameBad = n => /\d$/.test(n) ? '以数字结尾' : (/[A-Za-z]/.test(n) ? '混进拉丁字母' : '');
/* 反向验证：判据必须证明它会报红，否则等于没写。 */
for (const [n, want] of [['东明路2', 1], ['南京西路2', 1], ['浦东1号2号航站楼', 0], ['蟠祥路·国家会计学院', 0], ['Shenzhen', 1]]) {
  const got = !!nameBad(n);
  if (got !== !!want) { console.log(`  ✗ 站名判据反向验证失败：「${n}」判成 ${got ? '假' : '真'}，应为 ${want ? '假' : '真'}`); fails++; }
}
let entries = 0;
for (const id of Object.keys(LINES)) {
  const L = LINES[id], seen = Object.create(null);
  entries += L.stations.length;
  L.stations.forEach((n, i) => {
    const bad = nameBad(n);
    if (bad) dataErrs.push(`${L.name} ${n}：站名${bad}，是占位假站名（真图里没有这种站）`);
    if (seen[n] && !(L.loop && i === L.stations.length - 1 && n === L.stations[0]))
      dataErrs.push(`${L.name} ${n}：同线重名（会造出假换乘）`);
    seen[n] = 1;
  });
  for (const r of L.elevated || []) {
    if (!(r[0] <= r[1])) dataErrs.push(`${L.name} elevated [${r}] 起止反向，这段高架会静默变回隧道`);
    if (r[0] < 0 || r[1] > L.stations.length - 1) dataErrs.push(`${L.name} elevated [${r}] 越界`);
  }
}
if (entries < 480) dataErrs.push(`站表总条目 ${entries}，比 D202512 版口径（491）少了一截，怀疑有线路被截短`);
const nInter = Object.keys(SH.INTER).length;
if (nInter < 60) dataErrs.push(`换乘站只有 ${nInter} 个（D202512 口径 74），站名大概被改坏了`);
/* 地理表与特色表必须说同一件事：数据的 crossings 与 SH.STATION_FEATURES 的
   跨水条目要一一对应（VIEWSPOTS 是它的纯派生，查源头等价于查 VIEWSPOTS）。
   两处各写一半，就会有一处静默失效 —— 10 号线那处跨河曾因为观景点按
   "由北往南"书写、站表反排而悄悄没被约束住。 */
{
  const feats = (SH.STATION_FEATURES || []).filter(f => f.kind === 'crossing' || f.kind === 'creek');
  const nData = Object.values(LINES).reduce((n, L) => n + (L.crossings || []).length, 0);
  if (feats.length !== nData) dataErrs.push(`一站一特色表里有 ${feats.length} 个跨水条目，数据 crossings 只声明了 ${nData} 处 —— 两处漂移了`);
  for (const L of Object.values(LINES)) for (const p of (L.crossings || []))
    if (!feats.some(f => Array.isArray(f.at) && f.at[0] === p[0] && f.at[1] === p[1]))
      dataErrs.push(`${L.name} crossings ${p[0]}/${p[1]} 在特色表里找不到对应跨水条目`);
}
for (const e of dataErrs) console.log('  ✗ ' + e);
if (dataErrs.length) fails += dataErrs.length;
else console.log(`站表卫生 OK：${entries} 个站表条目、${nInter} 个换乘点、无占位假站名、高架区间方向正确`);
/* 交路变体：支线站表 = 主线切到分岔站 + 支线站序。
   线形判据必须逐交路各跑一遍，否则支线那条尾巴从来没被任何判据看过。 */
const variants = [];
/* 已知"不做里程标定"的线，写死在这里而不是留成静默的空白：
   l5 / l10 / l11 的官方值把支线算在一起（37.376 / 46.311 / 82.386 km），
   而这里的主线交路只有其中一段，按总长缩放会让主线虚长；ml 用 base/spread 精确落位。
   新增一条线又没标定、也没进这张表 → 判据直接报红。 */
const NO_KM = ['l5', 'l10', 'l11', 'ml'];
for (const id of Object.keys(LINES)) {
  const L = LINES[id];
  variants.push(Object.assign({ id: id }, L));
  if (!L.branch) continue;
  const at = L.stations.indexOf(L.branch.at);
  const bs = L.stations.slice(0, at + 1).concat(L.branch.stations);
  variants.push(Object.assign({}, L, { id: id + '#branch', name: L.name + ' 支线', stations: bs,
    crossings: (L.crossings || []).filter(p => bs.indexOf(p[0]) >= 0 && bs.indexOf(p[1]) >= 0) }));
}
for (const L of variants) {
  const id = L.id;
  const gaps = SH.lineGaps(L, L.stations);
  /* 跨水点必须一起交进去：这条判据量的就是"大桥有没有落在直平段上"，
     不给它 cross，测出来的线形与游戏里那条根本不是同一条。 */
  const xIdx = (L.crossings || []).map(p => {
    const a = L.stations.indexOf(p[0]), b = L.stations.indexOf(p[1]);
    return { a, b, wide: p[2] !== 'creek' };
  });
  /* seed 与站间距都必须取自游戏同一处定义（SH.lineSeed / SH.synthGaps）。
     以前这里写死 7：判据量的是一条"看着像但随机弯位不同"的线。 */
  const al = SH.buildLineAlignment(L.stations, gaps, SH.lineSeed(id.split('#')[0]),
    { vMax: L.maxKmh || 80, cross: xIdx.map(c => Math.min(c.a, c.b)) });
  const errs = [];
  /* ---------- 两条行车专业判据 ----------
   * ① 未被平衡横向加速度的**时间变化率** ≤ 0.45 m/s³。
   *    这是"拐弯抽搐"的真身：曲率没有缓和段就是阶跃，v²/R 一瞬间全加上。
   *    速度取该里程曲线自己允许的连续速度（不是 limitAt —— 那里面有
   *    "进站 78 m 内 40"的台阶，拿它当 v(s) 量到的是限速阶跃的导数）。
   * ② 跨江/跨河点两侧 ±210 m 必须直线 + 水平：桥塔、加劲梁、水面都是
   *    刚性水平件，线路在桥上带坡进弯，桥面就与水面拧着。 */
  const runKmh = L.runKmh || Math.min(L.maxKmh || 80, SH.RUN_LIMIT_KMH);
  {
    const G = 9.81, st2 = s => {
      const k = al.at(s), v = Math.min(runKmh, al.curveLimitKmh(s)) / 3.6;
      return v * v * k.k - G * Math.sin(k.cant);
    };
    let rate = 0, at = 0;
    for (let s = 4; s < al.total - 4; s += 4) {
      const v = Math.min(runKmh, al.curveLimitKmh(s)) / 3.6;
      const d = Math.abs(st2(s + 4) - st2(s - 4)) / 8 * v;
      if (d > rate) { rate = d; at = s; }
    }
    if (rate > 0.45) errs.push(`横向加速度变化率 ${rate.toFixed(2)} m/s³ @${Math.round(at)}（舒适上限 0.45）—— 缓和曲线长度不够`);
  }
  /* 司机台那句曲线信息必须说人话。实测踩到的坑：2 号线一段直线上印出
     "曲线限速 269 km/h" —— curveLimitKmh 是欠高允许速度，直线给 Infinity、
     大半径曲线给一个比设计速度高 3 倍的数，直接写在屏上就是假仪表。 */
  {
    const mx = L.maxKmh || 80;
    let note0 = null;
    for (let s = 10; s < al.total - 10; s += 10) {
      const k = al.at(s).k, note = SH.curveNote(k, al.curveLimitKmh(s), mx);
      const m = note.match(/限速 (\d+)/);
      if (/Infinity|NaN/.test(note)) { note0 = note + ' @' + Math.round(s); break; }
      if (m && +m[1] > mx) { note0 = '「' + note + '」超过本线设计速度 ' + mx + ' @' + Math.round(s); break; }
      if (!k && note !== '直线') { note0 = '直线上印成「' + note + '」 @' + Math.round(s); break; }
    }
    if (note0) errs.push('司机台曲线文案：' + note0);
  }
  for (const c of xIdx) {
    if (c.a < 0 || c.b < 0) { errs.push(`crossings：没有车站「${c.a < 0 ? (L.crossings[xIdx.indexOf(c)][0]) : (L.crossings[xIdx.indexOf(c)][1])}」`); continue; }
    if (Math.abs(c.a - c.b) !== 1) { errs.push(`crossings：${L.stations[c.a]} / ${L.stations[c.b]} 不是相邻两站`); continue; }
    const mid = (al.stationS[Math.min(c.a, c.b)] + al.stationS[Math.max(c.a, c.b)]) / 2;
    let mg = 0, mk = 0;
    for (let d = -210; d <= 210; d += 6) {
      const t = al.at(mid + d);
      mg = Math.max(mg, Math.abs(t.grade * 1000)); mk = Math.max(mk, Math.abs(t.k));
    }
    if (mg > 0.5 || mk > 1e-9)
      errs.push(`跨水点 ${L.stations[c.a]}/${L.stations[c.b]} 上还有坡 ${mg.toFixed(1)}‰ 或曲率 1/${mk > 1e-9 ? (1 / mk).toFixed(0) : '∞'} —— 大桥必须在直平段上`);
  }
  if (!isFinite(al.total) || al.total < 400) errs.push('总长异常 ' + al.total);
  if (al.stationS.length !== L.stations.length) errs.push('站数不符 ' + al.stationS.length + '!=' + L.stations.length);
  for (let i = 0; i < al.stationS.length; i++) {
    const s = al.stationS[i];
    if (!isFinite(s)) { errs.push('站' + i + ' 里程 NaN'); continue; }
    if (i && !(s > al.stationS[i - 1])) errs.push('站' + i + ' 里程不倒挂/不递增');
    const st = al.at(s);
    if (![st.x, st.y, st.z, st.th, st.grade, st.cant].every(isFinite)) errs.push('站' + i + ' 状态 NaN');
    let kmax = 0, kAt = 0;
    /* 取样往里收 1 m：平面元素是半开区间 [s0, s0+len)，正好落在元素边界上的
       那一点会被算给前一个元素，于是"站台前的第一个点"读到了上一段曲线的 k。
       这不是线形违规（那 1 m 已经在直线上），但窗口内部真的出现曲线时必须报错。 */
    for (let d = -SH.PLAT.PRE + 1; d <= SH.PLAT.POST - 1; d += 4) {
      const k = Math.abs(al.at(s + d).k);
      if (k > kmax) { kmax = k; kAt = d; }
    }
    if (kmax > 1e-9) errs.push('站' + i + ' 站台不在直线上 (d=' + kAt + ' k=' + kmax.toExponential(1) + ')');
    if (Math.abs(al.at(s).grade) > 1e-4) errs.push('站' + i + ' 站台有坡度');
  }
  /* 数据侧的公里数必须和几何对得上。三个来源各自独立：
       `L.km`   —— 带出处的官方运营里程（data/shanghai.js 的标定表）
       `_note`  —— 写给玩家看的那句文案
       `al`     —— 真正生成出来的收入段长度
     磁浮当年就是 `_note` 写「450 s 跑完 29.088 km」而几何只有 6126 m —— 一条被自己
     文案打脸的线，且没有任何判据会发现。任何一侧改动都会在这里报红。 */
  {
    const got = al.stationS[al.stationS.length - 1] - al.stationS[0];
    const baseId = id.split('#')[0];     // 支线交路的 id 是 'l5#branch'，不标定名单按主线记
    if (L.km) {
      const want = L.km * 1000;
      if (Math.abs(got - want) / want > 0.005)
        errs.push(`官方运营里程「${L.km} km」而几何是 ${(got / 1000).toFixed(3)} km（差 ${((got - want) / want * 100).toFixed(1)}%）—— 标定被绕过：多半是有地方没走 SH.lineGaps`);
    } else if (NO_KM.indexOf(baseId) < 0) {
      errs.push('这条线没有运营里程标定，也不在"已知不标定"的名单里（l5/l10/l11 含支线、ml 单跨距精确落位）');
    }
    const m = /([\d.]+)\s*km(?!\s*\/)/.exec(L._note || '');
    if (m) {
      const want = parseFloat(m[1]) * 1000;
      if (Math.abs(got - want) / want > 0.005)
        errs.push(`_note 写「${m[1]} km」而几何是 ${(got / 1000).toFixed(3)} km（差 ${((got - want) / want * 100).toFixed(1)}%）—— 里程与文案必须同源`);
      if (L.km && Math.abs(want - L.km * 1000) > 1)
        errs.push(`_note 的「${m[1]} km」与标定表的 ${L.km} km 打架 —— 两个数都得有出处`);
    }
  }
  /* 高速线必须有长直。曲线是首尾相接铺的（夹直线=0）时，磁浮 29 km 收入段
     直线只占 0.9% —— 一条 430 km/h 设计的线全程在 S 弯里扭，而它出名的恰恰
     是那段可以放开跑的长直。市域/高速口径下 300 km/h 的最小夹直线是 500 m 级。 */
  {
    const mx = L.maxKmh || 80;
    if (mx >= 160) {
      const a0 = al.stationS[0], a1 = al.stationS[al.stationS.length - 1];
      let str = 0, tot = 0;
      for (let s = a0; s < a1; s += 5) { tot += 5; if (!al.at(s).k) str += 5; }
      const share = str / tot;
      if (share < 0.15)
        errs.push(`设计速度 ${mx} km/h 的线，收入段直线只占 ${(share * 100).toFixed(1)}%（应 ≥15%）—— 缺夹直线`);
    }
  }
  let gmax = 0;
  for (let s = 0; s < al.total; s += 20) gmax = Math.max(gmax, Math.abs(al.at(s).grade));
  if (gmax > 0.035) errs.push('最大坡度 ' + (gmax * 1000).toFixed(1) + '‰ 超过 35‰');
  /* 纵断面必须留在基准面附近。上海是三角洲平原，全线地面高差只有几米；
     而整个世界的高程基准都挂在轨面上（街面 = 轨面−10.9、远景地面 = 轨面−12.2、
     地标锚点 = 轨面−12、水面 = 轨面−10.2）。轨面一旦沿线累积爬升几十米，
     列车脚下的远景地面就比远处地标高几十米，水面/湖泊会被整个埋掉。
     曾经实测 5 号线爬到 143 m 幅度，淀山湖因此看不见。 */
  let ymn = 1e9, ymx = -1e9;
  for (let s = 0; s <= al.total; s += 25) { const y = al.at(s).y; if (y < ymn) ymn = y; if (y > ymx) ymx = y; }
  if (ymx - ymn > 30) errs.push('纵断面漂移 ' + (ymx - ymn).toFixed(1) + ' m（' + ymn.toFixed(1) + '~' + ymx.toFixed(1) + '），超过 30 m 上限');
  /* 超高必须沿里程连续渐变 —— 这条钉的是"拐弯瞬间车抽搐一下"。
     cant 是相机与车体侧倾的唯一来源（frame() 拿它旋转 r/u），所以它在每米里的
     变化量就是玩家看到的滚转角速度。真实线路靠缓和曲线把超高铺在几十米内，
     按 40 km/h~80 km/h 算，舒适的滚转率上限约合每米 0.06°。
     原来 `cant = p.k ? atan(k·vEq²/g) : 0` 是曲率的阶跃函数，直线进圆曲线
     第一米就跳满 1.5°~2°，正好是玩家描述的那个"抽搐"。 */
  let cJump = 0, cAt = 0, cPrev = al.at(0).cant;
  for (let s = 2; s <= al.total - 2; s += 2) {
    const c = al.at(s).cant;
    const d = Math.abs(c - cPrev) / 2;                 // 每米变化（rad/m）
    if (d > cJump) { cJump = d; cAt = s; }
    cPrev = c;
  }
  /* 阈值 0.62°/m 是**当前实测最差值往上取整的棘轮**，不是设计目标。
     设计目标按铁路缓和曲线规范约合 0.05°/m（实车 40 km/h 下滚转率 ≤2°/s）。
     现在的 0.45~0.55°/m 全部来自**反向曲线（S 弯）**：超高从 −6° 直接换到 +6°，
     45 m 的平均窗只能把它摊开，摊不到规范量级。
     要真正达标必须在 `_plan` 生成阶段插入真实的缓和曲线段（曲率线性过渡），
     而不是在 `at()` 里事后平均 —— 记在这里，别把它当成"已经修好了"。 */
  if (cJump * 180 / Math.PI > 0.62) {
    errs.push('超高跳变 ' + (cJump * 180 / Math.PI).toFixed(2) + '°/m @ s=' + cAt.toFixed(0) + '（棘轮上限 0.62，设计规范 0.05）');
  }
  // 站间距要落在合成参数给出的量级内（磁浮这种 2 站线允许很大）
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  for (let i = 0; i < gaps.length; i++) {
    const real = al.stationS[i + 1] - al.stationS[i];
    if (Math.abs(real - gaps[i]) > 1) errs.push('站间距 ' + i + ' 偏差 ' + (real - gaps[i]).toFixed(1) + ' m');
  }
  const tag = (L.name || id).padEnd(6);
  if (errs.length) { fails++; console.log(tag, '✗', errs.slice(0, 4).join(' ; '), '(共', errs.length, '项)'); }
  else console.log(tag, '✓', (al.total / 1000).toFixed(1) + ' km', al.stationS.length + ' 站',
    '平均站间距 ' + Math.round(mean) + ' m', '最大坡度 ' + (gmax * 1000).toFixed(1) + '‰');
}
console.log(fails ? `\n✗ ${fails} 条线路线形不合格` : '\n✓ 全部 ' + variants.length + ' 条线路/交路线形合格');
/* 退出码必须把第一道语法闸也算进来。以前只反映线形，于是"语法不过"印在第一行、
   进程仍然返回 0 —— 而我批量跑测试的习惯是 `tail -1` + `&&`，正好把它吞掉：
   renderer.js 里一个写在 GLSL 注释中的反引号提前终结了模板字符串，
   整套测试全绿、页面却根本建不出来。 */
process.exitCode = (syntaxBad || fails) ? 1 : 0;
