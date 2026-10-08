/* dev/shot.js — 无头浏览器截图取证：把"只有人肉开浏览器才能看"的那一类问题
 * 变成一条命令。
 *
 * 为什么要有它：黄昏曝光、信号实景、材质颜色这类问题，离线判据（test-shot.js
 * 的光栅化器）只管"哪个材质占了多少像素"，不管光——光在 shader 里。以前要看
 * 这些只能人肉开 serve.js + 浏览器 + dev/cap.js，而这个环节一断，"画面上对不对"
 * 就又回到靠猜。现在 dev/shot.js 用 CDP 驱一个无头 Chrome/Edge，把页面跑起来、
 * 调 cap.js 同一套流程截图，顺手把亮度直方图算出来 —— 截图与量化一次到位。
 *
 * 用法：
 *   node dev/shot.js <名称> <线路> <站间插值> <视角> [再来一组...]
 *   例：node dev/shot.js sig-l2 l2 8.5 platform
 *   视角：cab / chase / headon / platform / scenic / street / top（与游戏 V 键同一组），
 *   或 `free`：配合 FREECAM='s,lat,dy,目标s,目标lat,目标dy[,fov]' 按轨道坐标摆相机
 *   （取证用：把相机停到信号机正前方 25 m 这种游戏内机位给不了的位置）。
 *   环境变量 CROP='x0,y0,x1,y1'（归一化）：亮度统计只算这块区域（整帧照样存），
 *   用来量"那根柱子到底有多白"这类局部问题。
 *   环境变量 HIDE='paint,glassSoft'：这些材质整批不画（减法取证）。
 *   环境变量 OCC=分区号：把一列 AI 车塞进那个分区（行车证据：这架信号机就该红）。
 *   环境变量 OPP=1：showcase 现建正/对向两支车队并解锁外车绘制（对向车进站取证）。
 *   环境变量 DOORS='<0..1>'：车门开度。FILL='<0..1.3>'：展示列车的车载
 *   （车内乘客档位 —— 车窗开成真的洞之后，"车里有没有人"能从站台一眼读出来）。
 *   TRAINS='<里程>'：单独钉住展示列车的车头位置（与 FREECAM 的相机里程解耦，
 *   否则"把相机停在第 3 节车旁边"这件事摆不出来 —— 车会跟着相机跑）。
 *   DWELL=<秒>：把站台摆到"开门第 N 秒"（B4 乘降可视化 —— 下车人流按门的
 *   通过能力从车里走出来，几何走 syncCrowd 的同一条生产代码）。
 *   PEDT=<秒>：把**街面仿真**推到第 N 秒再拍（过街行人取证 —— 行人灯是绝对时钟
 *   的函数，不推时钟就永远拍在 t=0，那一刻所有人都还在路缘等）。
 *
 * 实现约束（每一条都是踩过的坑）：
 *   · serve.js 与 Chrome 都由这个脚本拉起并回收，不留端口占用；
 *   · canvas 没有 preserveDrawingBuffer：toDataURL 必须在同一个 JS 任务里取
 *     （cap.js 的坑 ②），所以页面内那段是一整个 async 函数、先取图再 await；
 *   · 亮度统计在页面里算（OffscreenCanvas 读像素），不搬 PNG 回 Node 再解 ——
 *     搬一次是 2 MB 的 base64，没必要。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('✗ 找不到 Chrome/Edge'); process.exit(1); }

const args = process.argv.slice(2);
const isPerf = args[0] === 'perf';
if (isPerf ? (args.length < 4 || (args.length - 1) % 3) : (args.length < 4 || args.length % 4)) {
  console.error('用法：node dev/shot.js <名称> <线路> <站间插值> <视角> [再来一组...]');
  console.error('或  ：node dev/shot.js perf <线路> <站间插值> <视角> [再来一组...]（帧预算测量）');
  process.exit(1);
}
const jobs = [];
if (isPerf) jobs.push({ name: 'perf' });
for (let i = isPerf ? 1 : 0; i < args.length; i += (isPerf ? 3 : 4))
  jobs.push(isPerf
    ? { name: 'perf', line: args[i], mid: parseFloat(args[i + 1]), view: args[i + 2] }
    : { name: args[i], line: args[i + 1], mid: parseFloat(args[i + 2]), view: args[i + 3] });

const PORT_S = 8879, PORT_D = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 页面内执行的截取函数：先 toDataURL（同任务），再算亮度直方图，再 POST /save。
 * ⚠ PAGE_FN 本身是一个**反引号模板串**，所以这段页面代码里**不许出现反引号**
 *   （模板串会当场被截断，报错位置指向后面某一行，看起来完全无关）。
 *   全部用单引号 + 加号拼接。 */
const PAGE_FN = `(async (line, mid, view, name, crop, hide, free, occ, doors, fill, trainS, opp, dwell, alt, pedt) => {
  const a = window.__SH; const c = a.canvas;
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;width:1400px;height:788px';
  a.r.resize();
  const origRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0;
  /* 异步资源就绪闸：1 号线列车的 BVE 模型（CSV + 26 张贴图）是 fetch 下来的，
     不等它就直接 setLine/bake，截出来的是"程序化车体"那一帧。 */
  if (a.bveReady) { try { await a.bveReady; } catch (e) {} }
  a.setLine(line, false);
  const S = a.line.al.stationS, i0 = Math.floor(mid);
  a.running = false; a.session = null;
  a.showcase = { s: S[i0] + (S[Math.min(i0 + 1, S.length - 1)] - S[i0]) * (mid - i0), t: 0 };
  a.bakeShowcase(); a.view = view;
  /* 减法取证：HIDE='paint,glassSoft' 时把这些材质整批不画 —— "那团鬼影是什么"
     用排除法一次定位（cap.js 的 __hide 同款，这里并进主流程）。 */
  if (hide && hide.length) {
    const set = {}; for (const m of hide) set[m] = 1;
    const od = a.r.draw.bind(a.r);
    a.r.draw = (b, M, o) => { if (!set[b.mat]) od(b, M, o); };
  }
  /* 自由机位：FREECAM='s,lat,dy,目标s,目标lat,目标dy[,fov]'。取证位必须按
     轨道坐标摆 —— 游戏内的固定机位给不了"信号机正前方 25 m"这种位置。
     **相机的里程与列车的里程要能分开**：FREECAM 的第一个数原本同时当两者，
     于是"把相机停在第 3 节车旁边"这件事根本摆不出来（车会跟着相机跑）。
     TRAINS='<里程>' 单独钉住车头位置，两者各司其职。 */
  if (view === 'free' && free) {
    const al = a.line.al;
    const fr = al.frame(free[0]), ft = al.frame(free[3]);
    const eye = al.world(fr, free[1], free[2]), look = al.world(ft, free[4], free[5]);
    const fov = free[6] || 55;
    a.camera = () => ({ eye, target: look, fov, near: 0.15, far: 1200 });
    a.showcase = { s: free[0], t: 0 }; a.bakeShowcase();
    if (trainS != null) { a.showcase = { s: trainS, t: 0 }; a.bakeShowcase(); }
  }
  /* 行车证据：showcase 没有调度器（begin() 才建），按需现建一个 ——
     不然"绿灯"的含义是"没有调度器"，不是"前方出清"，那是两种完全不同的话。
     OCC=-1 只建调度器不占分区（绿），OCC=k 再把一列 AI 车塞进分区 k（红）。 */
  let aspect = null;
  if (occ != null) {
    if (!a.traffic) { a.traffic = new window.SH.traffic.Dispatcher(a.line); a.traffic.reset(0); }
    const d = a.traffic;
    if (occ >= 0 && d.trains.length) {
      const t = d.trains[0], b = d.blocks[occ];
      t.s = b[0] + (b[1] - b[0]) / 2; t.tr.s = t.s; t.tr.v = 0;
    }
    aspect = d.aspectAt(Math.max(0, occ)).key;
  }
  /* OPP=1：对向车队取证（第 108 条 P4 感知验证）。showcase 没有 begin()，
     a.opp 永远不存在，而 draw() 的外车整块还被 running=false 挡住 —— 不加
     这个开关，"站台上看到对向车进站"这件事根本截不了图。按 begin() 的同一份
     配方现建两支车队：正向按真实里程，对向按镜像里程 reset(total − showcase.s)；
     playerS 一律归 null —— 玩家在另一条股道上，镜像位置进了占用表会把整队
     对向车扣在"玩家的镜像点"后面。正向车队撒到取景半径（2200 m）之外：本判据
     只验对向车，同向车进不进画面是另一件事。最后把 running 只为截帧翻上去 ——
     frame() 里所有 session 分支都是 running && session 双重判，session 保持
     null 时翻 running 只解锁"外车可见"这一段，其余行为与 showcase 完全一致。 */
  if (opp) {
    if (!a.traffic) { a.traffic = new window.SH.traffic.Dispatcher(a.line); a.traffic.reset(0); }
    a.traffic.playerS = null;
    const al = a.line.al, total = al.total, sc = a.showcase.s;
    a.traffic.trains.forEach((t, i) => { t.s = (sc + 2600 + i * 500) % total; t.tr.s = t.s; t.tr.v = 0; });
    if (!a.opp) {
      a.opp = new window.SH.traffic.Dispatcher(a.line.mirror(), { hour: a.hour, dayT0: a.clock || 0, rain: a.rain });
      a.opp.reset(total - sc);
      a.opp.playerS = null;
    }
    /* 钉一列对向车在站内对向股道上：drawExternalOpp 车头在 total − u 端、
       车体向真实里程增大方向排 —— 车头钉在 ss − 80，整列 8A（≈187 m）正好
       全落在箱体（ss ± 118）内的对向轨上，从站台看就是"对面方向的车进站"。
       其余对向车同样撒出取景半径，免得第二列叠进箱体穿帮。 */
    a.opp.trains.forEach((t, i) => {
      if (!i) { t.s = total - sc + 80; } else { t.s = (total - sc + 2600 + i * 500) % total; }
      t.tr.s = t.s; t.tr.v = 0;
    });
    a.running = true;
    /* 接线自证：对向车画没画出来，截图只给"看不见"一个症状。这里把
       车队存不存在 / 最近一列离眼多远 / 过没过 oppVisible 分开报 ——
       车队没建、车在取景半径外、股道没烘三种失效画面上一模一样。 */
    const cam0 = a.camera ? a.camera() : null;
    let od = '[对] 车队 ' + a.opp.trains.length + ' 列';
    if (cam0 && cam0.eye) {
      let best = null;
      for (const t of a.opp.trains) {
        const sr = total - t.s;
        if (!a.line.oppVisible(sr)) continue;
        const p = al.world(al.frame(sr), a.line.oppLatAt(sr), 0);
        const dist = Math.hypot(p[0] - cam0.eye[0], p[1] - cam0.eye[1], p[2] - cam0.eye[2]);
        if (!best || dist < best.dist) best = { sr, dist };
      }
      od += best ? ' · 最近对向车 real-s ' + best.sr.toFixed(0) + ' · 距眼 ' + best.dist.toFixed(0) + ' m'
                 : ' · 取景内无过 oppVisible 的对向车';
    }
    window.__oppDiag = od;
  }
  /* ALT=1：套跑取证。showcase 没有 begin()，所以 app.traffic / app.alt 都不存在，
     而画面里的外车整块被 running && traffic 挡着。这里按 begin() 的同一份配方
     现建两队（主线 + 支线，配车按 SH.interlineMeta.ratio 切开、互为 peer），
     再把 running 只为截帧翻上去 —— session 保持 null，其余行为与 showcase 一致。
     没有这个开关，"共线段上同时跑着两个交路"这件事根本拍不到。 */
  if (alt && window.SH.traffic && window.SH.interlineMeta) {
    const a2 = window.__SH;
    const im = window.SH.interlineMeta(a2.line);
    if (im && im.forkIdx >= 0) {
      if (!a2.traffic) { a2.traffic = new window.SH.traffic.Dispatcher(a2.line); a2.traffic.reset(a2.showcase.s); }
      a2.traffic.playerS = null;
      const key = a2.line.svc === 'main' ? a2.line.baseId + '#branch' : a2.line.baseId;
      const other = a2.lines[key];
      if (other) {
        a2.alt = window.SH.traffic.linkInterline(a2.traffic, other, { atS: null });
        /* 把一列对侧车钉到相机前方：判据要拍的是"共线段上两交路并存"，
           不是运气 —— 车队自己排布时它可能整局都在队伍后面。 */
        if (a2.alt) {
          const bt = a2.alt.trains[0];
          bt.s = a2.showcase.s + 320; bt.tr.s = bt.s; bt.tr.v = 0; bt.state = 'run';
          a2.alt.trains.slice(1).forEach((t, i) => { t.s = (a2.showcase.s + 2600 + i * 900) % other.al.total; t.tr.s = t.s; });
        }
        a2.running = true;
        window.__altDiag = '[套] 本队 ' + a2.line.svc + ' ' + a2.traffic.n + ' 列 · 对侧 '
          + (a2.alt ? a2.alt.line.svc + ' ' + a2.alt.n + ' 列（钉在相机前 ' + Math.round(a2.alt.trains[0].s - a2.showcase.s) + ' m）' : '未配出')
          + ' · 分岔站 ' + im.fork + ' @' + Math.round(a2.traffic.forkS);
      }
    } else { window.__altDiag = '[套] ' + a2.line.id + ' 没有支线'; }
  }
  /* DOORS=<0..1>：把列车车门开到指定开度再截图。站台视角默认是关门的，
     而"客室"这件事只有在门开或者从窗外斜看时才成立 —— 没有这个开关，
     拍站台永远拍不到车门与客室的对位。 */
  if (doors != null) { a.showcaseDoor = doors; }
  /* FILL=<0..1.3>：把展示列车的车载钉住。**车窗开成真的洞之后，
     "车里有没有人"成了能从站台一眼读出来的东西**，而 showcase 模式
     没有客流模型（车载恒为 0），拍出来的永远是空车 —— 没有这个开关
     就永远验不了"客室里的人"。取值就是 paxLevel 的门槛。 */
  if (fill != null) a.showcaseFill = fill;
  /* DWELL=<秒>：把站台摆到"开门第 N 秒"（B4 乘降可视化取证）。
     showcase 没有 begin()，没有会话与逐站客流 —— 但乘降可视化的几何走的
     是**同一段生产代码**：真实 Flow 从线路起点推到本站（primeTo，车载状态
     是模型算出来的）、beginStation 记下开门那一刻的需求，visual() 给出
     need/rate/dwellNeed/wait0，再按 syncCrowd 的同一条路径 dropTag+重建
     crowd 批次。诊断把模型量一并报出来 —— "画面上没有下车的人"有三种
     完全不同的原因（需求为 0 / 批次没重建 / 机位没对着走行带），截图只给
     第一种症状，这里把三者分开报。 */
  if (dwell != null) {
    const line = a.line, al = line.al;
    let i0 = 0;
    for (let k = 1; k < al.stationS.length; k++)
      if (Math.abs(al.stationS[k] - a.showcase.s) < Math.abs(al.stationS[i0] - a.showcase.s)) i0 = k;
    const stName = line.stations[i0];
    const flow = new window.SH.pax.Flow(line, line.stock, a.hour, a.rain);
    /* 玩家的车次是"从上一站开过来"：primeTo(i0) 会把到 i0 的人在预跑里
       就放完（alightNeed(i0) 恒 0）—— 必须 primeTo(i0-1)，让车带着
       到 i0 下车的人进站，与运行时 openDoors→beginStation 的时序一致。 */
    flow.primeTo(Math.max(1, i0 - 1)); flow.beginStation(i0, stName);
    const v = flow.visual(i0, stName); v.dwell = dwell;
    const waitNow = flow.waitingAt(stName, i0);
    a.r.dropTag('crowd');
    const cb = new window.SH.Builder();
    const lg = a.district && a.district.crowd ? a.district.crowd.lg : null;
    window.SH.WorldBuilder.crowdStation(cb, line, lg, i0, waitNow, null, v);
    a.r.upload(cb.finish(), 'crowd');
    window.__crowdDiag = '[乘] ' + stName + ' · 下' + v.need + ' · 候乘' + Math.round(waitNow)
      + ' · rate ' + v.rate.toFixed(1) + '/s · dwellNeed ' + v.dwellNeed.toFixed(1) + 's · dwell ' + dwell + 's'
      + (a.district && a.district.crowd ? ' · 批次已重建' : ' · 无 crowd 容器');
  }
  for (let i = 0; i < 5; i++) a.frame(1000 + i * 33);
  /* 站台屏的接线自证。**必须 return 而不是 console.log** ——
     页面里的 console 不会回到 Node 侧的控制台，这个诊断口本身会静默失效
     （而"诊断口静默失效"正是本项目栽过的那一类坑）。
     "屏建了却看不见"有三类完全不同的原因（几何不在视锥 / 批次没上传 /
     贴图没传），截图只给出"看不见"这一个症状，这里把三者分开报。 */
  {
    const d = a.district;
    const nb = d && d.ptd ? d.ptd.reduce((x, g) => x + g.b.length, 0) : 0;
    const sz = a.ptdCv ? (a.ptdCv.width + '×' + a.ptdCv.height) : '无';
    /* 最近的一块屏：里程/横向/标高/尺寸 + 它到眼位的距离与横向张角。
       "屏建了却看不见"里最难查的一种是"屏在相机背后 40 m"—— 只报批次数看不出这个。 */
    const cam = a.camera ? a.camera() : null;
    let near = '—';
    if (d && d.ptd && d.ptd.length && cam) {
      const al = a.line.al, e = cam.eye;
      let best = null;
      for (const g of d.ptd) {
        if (g.lat == null) continue;
        const c = al.world(al.frame(g.s), g.lat, g.dy);
        const dist = Math.hypot(c[0] - e[0], c[1] - e[1], c[2] - e[2]);
        if (!best || dist < best.dist) best = { g, c, dist };
      }
      if (best) near = 's' + best.g.s.toFixed(0) + ' lat' + best.g.lat.toFixed(2) + ' dy' + best.g.dy.toFixed(2)
        + ' ' + best.g.w.toFixed(2) + '×' + best.g.h.toFixed(2) + 'm 距 ' + best.dist.toFixed(1) + 'm'
        + ' 张角 ' + (2 * Math.atan(best.g.h / 2 / best.dist) * 180 / Math.PI).toFixed(2) + '°';
    }
    window.__ptdDiag = '[屏] 线路 ' + a.line.id + ' · 批次 ' + nb + ' · 画布 ' + sz + ' · 贴图 ' + (a.r.textures['ptd'] ? '已上传' : '未上传')
      + ' · 站序 ' + a.ptdIdx + ' · 当前站 ' + (a.line.stations[a.ptdIdx] || '?')
      + ' · 内容「' + (a.ptdInfo ? a.ptdInfo.line1 + ' ' + a.ptdInfo.line2 : '—') + '」'
      + ' · 最近 ' + near;
  }
  /* 车内乘客的接线自证。**车窗开成真的洞之后，车里有没有人能从站台一眼读出来**，
     而"档位算对了、批次没上传"这类失效在画面上只表现为"车厢是空的"，
     和"真的没人"完全一样 —— 这里把批次与算出的档位一起报出来。
     FILL 没接上时这一项恒为"档位0 批次0/0/0"，一眼看得出是开关没生效。 */
  {
    const tv = a.trainView, lv = window.SH.train.paxLevel(a.showcaseFill || 0);
    const nb2 = tv && tv.paxB && tv.paxB[0] ? tv.paxB[0].map(g => g.length).join('/') : '无';
    window.__carDiag = '[客] 车载 ' + (a.showcaseFill == null ? '未定' : a.showcaseFill.toFixed(2)) + ' → 档位 ' + lv
      + ' · 0 号车批次 ' + nb2 + ' · 内饰 ' + (tv && tv.innerB && tv.innerB[0] ? tv.innerB[0].length : '无');
  }
  /* 街面车流的接线自证：**"路面上没有车"有两种完全不同的原因**（一辆都没提交 /
     提交了但被别的东西按深度盖住），截图只给"看不见"这一个症状。这里把
     请求实例数与实提交数一起报出来，两边对不上就是没画，对得上就是被盖住。 */
  {
    /* PEDT=<秒>：把街面仿真推到第 N 秒再拍（过街行人取证，§7.9 剩下的那半条）。
       行人灯是**绝对时钟**的函数，不推时钟就永远拍在 t=0 —— 那一刻所有人都还在
       路缘等，画面上"没人过街"，而这与"人根本没建"、"灯不在这头"是三种不同的病。
       所以诊断把 时钟 / 行人总数 / 正在带上的 / 斑马线处数 一起报出来。 */
    const s = a.street;
    if (s && pedt != null) for (let k = 0; k * 0.5 < pedt; k++) s.update(0.5);
    window.__streetDiag = s ? '[车] 应提交 ' + s._expect + ' · 实提交 ' + s._drawn
      + ' · 变体 ' + s.variants.length + ' · 车总数 ' + s.cars.length + ' · gpu ' + (s.gpu ? '已上传' : '未上传')
      + (pedt != null ? ' · [人] 时钟 ' + s.clock.toFixed(0) + ' s · 过街行人 ' + s.peds.length
        + ' · 正在带上 ' + s.peds.filter(p => p.u > 0.001 && p.u < 0.999).length
        + ' · 斑马线 ' + s.jx.filter(j => j.exit).length + ' 处' + (s._pedsDrawn != null ? ' · 提交 ' + s._pedsDrawn : '') : '')
      : '[车] app.street 不存在';
  }
  const url = c.toDataURL('image/png');
  const im = await createImageBitmap(await (await fetch(url)).blob());
  const cc = new OffscreenCanvas(im.width, im.height);
  const x = cc.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  const bx = crop ? Math.round(crop[0] * im.width) : 0, by = crop ? Math.round(crop[1] * im.height) : 0;
  const bw = crop ? Math.round((crop[2] - crop[0]) * im.width) : im.width;
  const bh = crop ? Math.round((crop[3] - crop[1]) * im.height) : im.height;
  const d = x.getImageData(bx, by, bw, bh).data;
  const n = bw * bh, hist = new Array(16).fill(0);
  let sum = 0, over = 0, sR = 0, sG = 0, sB = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; hist[Math.min(15, l >> 4)]++;
    if (l > 250) over++;
    sR += d[i]; sG += d[i + 1]; sB += d[i + 2];
  }
  const save = await fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data: url }) }).then(r => r.text()).catch(e => 'ERR ' + e);
  /* 有 CROP 时顺手存一张放大裁切（最近邻，看材质细节用） */
  if (crop) {
    const zc = new OffscreenCanvas(bw * 2, bh * 2);
    const zx = zc.getContext('2d'); zx.imageSmoothingEnabled = false;
    zx.drawImage(im, bx, by, bw, bh, 0, 0, bw * 2, bh * 2);
    const zb = await zc.convertToBlob();
    const zurl = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(zb); });
    await fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name + '-zoom', data: zurl }) }).catch(() => { });
  }
  if (typeof aspect === 'string') {
    /* 行车证据：画面归画面，调度器说它该是什么颜色也一并打出来 —— 两边对不上就是撒谎 */
    return { name, w: im.width, h: im.height, meanLuma: +(sum / n).toFixed(1), blown: +(100 * over / n).toFixed(2),
      dark: +(100 * hist.slice(0, 4).reduce((a, b) => a + b, 0) / n).toFixed(1), save, aspect, diag: (window.__ptdDiag || '') + ' ' + (window.__carDiag || '') + ' ' + (window.__oppDiag || '') + ' ' + (window.__crowdDiag || '') + ' ' + (window.__streetDiag || '') + ' ' + (window.__altDiag || '') };
  }
  return { name, w: im.width, h: im.height, meanLuma: +(sum / n).toFixed(1), blown: +(100 * over / n).toFixed(2),
      dark: +(100 * hist.slice(0, 4).reduce((a, b) => a + b, 0) / n).toFixed(1), save, diag: (window.__ptdDiag || '') + ' ' + (window.__carDiag || '') + ' ' + (window.__oppDiag || '') + ' ' + (window.__crowdDiag || '') + ' ' + (window.__streetDiag || '') + ' ' + (window.__altDiag || '') };
})`;

async function main() {
  /* ---- serve.js ---- */
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'serve.js'), String(PORT_S)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT_S}/index.html`); if (r.ok) break; } catch (e) { }
    await sleep(200);
  }
  /* ---- 无头 Chrome ---- */
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  /* DPR=<倍数>：按玩家的设备缩放取证。175% 屏（本机）上 dpr=1.75，画布的物理
     像素 3.4 M 超过 1080p 预算 → 触发降采样 + uSharp 补锐，而**场景 FBO 没有
     MSAA**（只有直接画进 drawing buffer 的 low 档才有）。细线条（钢轨、车道标线）
     在 dpr=1 的对拍里根本复现不出来，所以这一档必须能摆。 */
  const dprArg = process.env.DPR != null && process.env.DPR !== '' ? parseFloat(process.env.DPR) : 1;
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT_D,
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions', '--mute-audio',
    '--use-angle=swiftshader', '--window-size=1440,900',
    '--force-device-scale-factor=' + (isFinite(dprArg) && dprArg > 0 ? dprArg : 1), 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) { } try { srv.kill(); } catch (e) { } };
  process.on('exit', cleanup);
  let ver = null;
  for (let i = 0; i < 75 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT_D}/json/version`)).json(); } catch (e) { await sleep(200); }
  }
  if (!ver) { console.error('✗ Chrome 远程调试端口 60 秒没起来'); cleanup(); process.exit(1); }
  /* 开页：新版 Chrome 的 /json/new 要 PUT */
  const tgt = await (await fetch(`http://127.0.0.1:${PORT_D}/json/new?` + encodeURIComponent(`http://127.0.0.1:${PORT_S}/index.html`), { method: 'PUT' })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  /* 等游戏起来（__SH 是 DOMContentLoaded 之后建的） */
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    const r = await call('Runtime.evaluate', { expression: '!!(window.__SH && window.__SH.line)', returnByValue: true });
    up = !!(r.result && r.result.value); if (!up) await sleep(300);
  }
  if (!up) { console.error('✗ 页面 30 秒没起来（__SH 未就绪）'); cleanup(); process.exit(1); }
  const api = (await call('Runtime.evaluate', { expression: 'window.__SH.r && window.__SH.r.api', returnByValue: true })).result.value;
  /* drawing buffer 的深度位数：画质两档用的是**两块不同的深度缓冲**
     （非 low 先渲进 sceneFbo，其 renderbuffer 格式由 _makeFbo 决定；low 直接
     画进 drawing buffer）。不打印这个数，"切换画质后贴地几何被啃掉"只能靠看图猜。 */
  const dbits = (await call('Runtime.evaluate', { expression: '(()=>{const g=window.__SH.r.gl; let fbo=-1; const s=window.__SH.r.sceneFbo; if(s){g.bindRenderbuffer(g.RENDERBUFFER,s.rb); fbo=g.getParameter(g.RENDERBUFFER_DEPTH_SIZE);} return g.getParameter(g.DEPTH_BITS) + "/" + fbo;})()', returnByValue: true })).result.value;
  console.log(`页面就绪：${ver.Browser} · ${api} · 深度 ${dbits}（drawing buffer / sceneFbo），线路 ${(await call('Runtime.evaluate', { expression: 'window.__SH.line.id', returnByValue: true })).result.value}`);
  /* 取证时把自动档**钉死**（与 `rainSnap` 同一族纪律）：DRS 默认开，而它只看真实
     帧时序 —— 无头跑只有几十帧，一旦让它换挡，两张同机位的截图就不是同一个像素
     预算了，对拍立刻失去意义。`DRSWATCH=` 那条分支反过来显式打开它。
     不锁这一档的代价是"证据自己会漂"，比多一行代码贵得多。 */
  await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.r.setResAuto(false); a.resetDrs(); return true;})()' });
  /* HOUR=<0..23>：把"现在几点"摆到这一刻再截图 —— 天光（envFor）、HUD 钟点、
     站台屏钟点都读 `App.clock`，所以只改这一个数就能取证"昼夜真的随时段变"。
     没有它就没法目视对比（游戏里选时段要人点界面，而截图是无头的）。 */
  const hourArg = process.env.HOUR != null && process.env.HOUR !== '' ? parseInt(process.env.HOUR, 10) : null;
  if (hourArg != null && isFinite(hourArg)) {
    const r0 = await call('Runtime.evaluate', { expression: `(()=>{const a=window.__SH; a.hour=${hourArg}; a.clock=${hourArg}*3600; if(a.settings) a.settings.hour=${hourArg}; return a.hourNow.toFixed(2);})()`, returnByValue: true });
    console.log(`时段摆到 ${hourArg}:00（hourNow=${r0.result.value}）`);
  }
  /* RAIN=1：把天气摆到"雨"再截图 —— 天光（envRainy）、湿地面（uWet）、
     雨丝（uRain）、雨刮（App.frame 只在雨天推进相位）全部由 app.rain 驱动，
     所以取证开关只需要置这一个布尔。 */
  if (process.env.RAIN === '1') {
    const r1 = await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.rain=true; if(a.settings) a.settings.rain=true; a.rainSnap=1; a.wiperT=0.4; return true;})()', returnByValue: true });
    console.log('天气摆到 雨（rain=true）' + (r1.result.value ? '' : ' ✗'));
  }
  /* QUALITY=low|medium|high：把画质旋钮摆到这一档再截图。
     这个旋钮在代码里**只有一处画面差别**：非 low 时场景先渲进 sceneFbo、
     再由后期链合成；low 时直接画进 drawing buffer。两条路的深度缓冲格式与
     抗锯齿都不是同一个东西，所以"切换画质之后某类几何没了"只能同一机位
     两档对拍才看得出来（截图本身给不出"是哪一档"）。 */
  if (process.env.QUALITY) {
    const qArg = JSON.stringify(process.env.QUALITY);
    const rq = await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.r.setQuality(' + qArg + '); if(a.settings) a.settings.quality=' + qArg + '; return a.r.quality + "/" + (a.r.resAuto ? "自动·" : "") + (a.r.resAuto ? a.r._effTier : a.r.resTier) + "(上限 " + a.r.resTier + ")/" + a.r.w + "x" + a.r.h;})()', returnByValue: true });
    console.log('画质摆到 ' + process.env.QUALITY + '（生效 ' + (rq.result && rq.result.value) + '）');
  }
  /* MSAA=<n>：覆盖多重采样数再截图（Phase A 取证开关）。
     用途①：MSAA=0 做"架构迁移像素不变"对拍 —— 关掉这一个变量，其余管线与
     基线逐字节同路，diff 必须为 0；用途②：同机位 0x/4x 各拍一张看边缘。
     注意必须放在 QUALITY **之后**：setQuality 会按档位重写 r.msaa（4/2/0）。 */
  if (process.env.MSAA != null && process.env.MSAA !== '') {
    const mArg = JSON.stringify(parseInt(process.env.MSAA, 10));
    const rm = await call('Runtime.evaluate', { expression: '(()=>{const a=window.__SH; a.r.msaa=' + mArg + '; return a.r.msaa;})()', returnByValue: true });
    console.log('MSAA 摆到 ' + (rm.result && rm.result.value) + 'x（下一帧 begin 时生效）');
  }
  /* ---- PERF 模式：不截图，逐"线路·mid·视角"量帧预算 ----
   * 用法：node dev/shot.js perf l1 0.5 cab [再来一组...]（第一组名固定写 perf）。
   * 页面真实 rAF 跑 60 帧，采样 r.stats.draws/tris 的均值与峰值、
   * 地勤采样器（_cpuArr）的帧 CPU 中位数。SwiftShader 下绝对帧率无意义，
   * 但 draw call 与三角形数是精确值 —— 优化前后的对账基准。
   * PERF_RUN=1：跑真实行车局（begin()，含 AI 车队与重烘焙）而不是 showcase。
   * 实现约束：页面函数用**字符串拼接**构造（与 PAGE_FN 同一条纪律 ——
   * 外层再套模板插值会把 ${} 双重求值，当场语法错）。 */
  if (isPerf) {
    const runMode = process.env.PERF_RUN === '1';
    /* 帧预算红线：draw call 上限钉在源码里，而不是"跑完人眼扫一遍数字"。
       上限取法：实测值 + 约 15% 余量（够场景间波动，但一次"AI 车退回逐车绘制"
       = +310 draws 会当场越线）。行车实测 480/442，showcase 292/282/179。
       PERFCAP=<n> 覆盖，PERFCAP=0 关掉（只量不判）。
       反向验证：PERFCAP=400 时行车那两条必须报红。 */
    const capEnv = process.env.PERFCAP;
    const capOf = () => (capEnv != null && capEnv !== '' ? parseInt(capEnv, 10)
      : (runMode ? 560 : 330));
    let perfBad = 0;
    for (const j of jobs.slice(1)) {   // 第 0 组只是 perf 标记
      const fn = '(async () => {' +
        'const a = window.__SH;' +
        'a.setLine(' + JSON.stringify(j.line) + ', false);' +
        'a.running = false; a.session = null; a.traffic = null;' +
        (runMode
          ? 'a.hour = 8.5; a.clock = 8.5 * 3600;' +
            'a.startIdx = ' + Math.max(0, Math.floor(j.mid)) + '; a.view = ' + JSON.stringify(j.view) + ';' +
            'a.begin(); a.running = true;'
          : 'const S = a.line.al.stationS, i0 = Math.floor(' + j.mid + ');' +
            'a.showcase = { s: S[i0] + (S[Math.min(i0 + 1, S.length - 1)] - S[i0]) * (' + j.mid + ' - i0), t: 0 };' +
            'a.bakeShowcase(); a.view = ' + JSON.stringify(j.view) + ';') +
        'await new Promise(res => setTimeout(res, 900));' +
        'const draws = [], tris = [];' +
        'await new Promise(res => { let n = 0; const f = () => { draws.push(a.r.stats.draws); tris.push(a.r.stats.tris); if (++n < 60) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });' +
        'const cpu = (a._cpuArr || []).slice().sort(function (x, y) { return x - y; });' +
        'return { draws: (draws.reduce(function (x, y) { return x + y; }, 0) / draws.length).toFixed(0),' +
        'drawsMax: Math.max.apply(null, draws),' +
        'tris: (tris.reduce(function (x, y) { return x + y; }, 0) / tris.length / 1e6).toFixed(2) + "M",' +
        'trisMax: (Math.max.apply(null, tris) / 1e6).toFixed(2) + "M",' +
        'cpu: cpu.length ? cpu[Math.floor(cpu.length / 2)].toFixed(2) : "-" };})()';
      const r = await call('Runtime.evaluate', { expression: fn, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) { console.log('✗ perf ' + j.line + '@' + j.mid + ' ' + j.view + ': ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text)); continue; }
      const v = r.result.value;
      const cap = capOf();
      const over = cap > 0 && +v.draws > cap;
      if (over) perfBad++;
      console.log(`${over ? '✗' : '✓'} PERF ${j.line}@${j.mid} ${j.view}${runMode ? '（行车）' : ''}: draws 均/峰 ${v.draws}/${v.drawsMax}`
        + (cap > 0 ? `（上限 ${cap}${over ? ' —— 越线 ' + (+v.draws - cap) : ''}）` : '')
        + `  tris ${v.tris}/${v.trisMax}  帧CPU中位 ${v.cpu} ms`);
    }
    ws.close(); cleanup(); process.exit(perfBad ? 1 : 0);
  }
  /* ---- DRSWATCH=<秒>：自适应分辨率（DRS）的真闭环取证 ----
   * 用法：DPR=3 RES=native DRSWATCH=40 node dev/shot.js drs l1 0.5 street
   * 离线判据（test-env H 段）量的是**合成**帧历史，这一档量的是真回路：
   * 页面用真实 rAF 跑 N 秒，把 `a._drsLog`（换挡留痕）、最终 drawing buffer
   * 尺寸与 HUD 那块地勤仪表一起打出来。
   * 无头 Chrome 跑 SwiftShader，像素一多就爬 —— 正好是"这台机器锁不住这一档"
   * 的那个条件，所以这里是**真测出来的**降档，不是喂给它的假样本。
   * 反向对照：同一台机器上 DPR 调小（像素少到能锁拍）就应当一次都不换档。 */
  if (process.env.DRSWATCH) {
    const secs = Math.max(2, parseFloat(process.env.DRSWATCH) || 20);
    const setup = '(()=>{const a=window.__SH;' +
      (process.env.RES ? 'a.r.setRes(' + JSON.stringify(process.env.RES) + ');' : '') +
      'a.r.setResAuto(' + (process.env.AUTO === '0' ? 'false' : 'true') + ');' +
      'a.resetDrs(); a._drsLog=[]; return {cap:a.r.resTier, auto:a.r.resAuto, px:a.r.w+"x"+a.r.h};})()';
    const s0 = await call('Runtime.evaluate', { expression: setup, returnByValue: true });
    console.log('DRS 起点：' + JSON.stringify(s0.result.value) + '，跑 ' + secs + ' s 真帧…');
    await new Promise(r => setTimeout(r, secs * 1000));
    const rr = await call('Runtime.evaluate', {
      expression: '(()=>{const a=window.__SH; return {log:a._drsLog||[], eff:a.r._effTier, cap:a.r.resTier,' +
        ' gpuExt:!!a.r.qExt, gpuMs:+(a.r.gpuMs||0).toFixed(2), cpu:+((a._drs&&a._drs.cpu)||0).toFixed(2),' +
        ' q:!!a.r._q, qOpen:!!a.r._qOpen, hist:(a.r._gpuHist||[]).length,' +
        ' drs:JSON.stringify({tier:a._drs.tier,low:a._drs.low,good:a._drs.good,cool:a._drs.cool,age:a._drs.age,cap:a._drs.cap,fail:a._drs.fail}),' +
        ' px:a.r.w+"x"+a.r.h, hud:(document.getElementById("hud-perf")||{}).textContent||""};})()',
      returnByValue: true });
    const v = rr.result.value || {};
    console.log('DRS 换挡留痕 ' + JSON.stringify(v.log));
    console.log('第二把尺：扩展 ' + (v.gpuExt ? '有' : '无（策略退回"只有出画间隔"）') +
      ' · GPU 毫秒 ' + v.gpuMs + ' · 查询在飞 ' + (v.q ? '是' : '否') + '/未收 ' + (v.qOpen ? '是' : '否') +
      ' · 样本 ' + v.hist + ' 个 · "瓶颈不在分辨率"累计 ' + v.cpu + ' s');
    console.log('策略状态 ' + v.drs);
    console.log('DRS 终点：生效 ' + v.eff + ' / 上限 ' + v.cap + ' · drawing buffer ' + v.px);
    console.log('HUD：' + v.hud);
    ws.close(); cleanup(); process.exit(0);
  }
  /* ---- 逐组截图 ---- */
  const crop = (process.env.CROP || '').split(',').map(Number);
  const cropArg = crop.length === 4 && crop.every(isFinite) ? crop : null;
  const hideArg = (process.env.HIDE || '').split(',').filter(Boolean);
  const freeArg = (process.env.FREECAM || '').split(',').map(Number);
  const occArg = process.env.OCC != null && process.env.OCC !== '' ? parseInt(process.env.OCC) : null;
  /* DOORS=<0..1>：车门开度。站台机位默认关门，而客室只门开或从窗外斜看时才成立。 */
  const doorsArg = process.env.DOORS != null && process.env.DOORS !== '' ? parseFloat(process.env.DOORS) : null;
  /* FILL=<0..1.3>：展示列车的车载（车内乘客档位）。见 PAGE_FN 里的说明。 */
  const fillArg = process.env.FILL != null && process.env.FILL !== '' ? parseFloat(process.env.FILL) : null;
  /* TRAINS=<里程>：单独钉住展示列车的车头位置（与 FREECAM 的相机里程解耦）。 */
  const trainSArg = process.env.TRAINS != null && process.env.TRAINS !== '' ? parseFloat(process.env.TRAINS) : null;
  /* OPP=1：showcase 现建对向车队并解锁外车绘制（第 108 条 P4 感知验证）。
     为什么 showcase 下"对向车进站"原本永远截不到 —— 见 PAGE_FN 内 OPP 块说明。 */
  const oppArg = process.env.OPP === '1';
  /* ALT=1：套跑取证（共线段上两个交路并存）。见 PAGE_FN 内 ALT 块。 */
  const altArg = process.env.ALT === '1';
  /* DWELL=<秒>：开门第 N 秒的乘降可视化（B4）。见 PAGE_FN 内 DWELL 块说明。 */
  const dwellArg = process.env.DWELL != null && process.env.DWELL !== '' ? parseFloat(process.env.DWELL) : null;
  const pedtArg = process.env.PEDT != null && process.env.PEDT !== '' ? parseFloat(process.env.PEDT) : null;
  let bad = 0;
  for (const j of jobs) {
    const r = await call('Runtime.evaluate', {
      expression: `(${PAGE_FN})(${JSON.stringify(j.line)}, ${j.mid}, ${JSON.stringify(j.view)}, ${JSON.stringify(j.name)}, ${JSON.stringify(cropArg)}, ${JSON.stringify(hideArg.length ? hideArg : null)}, ${JSON.stringify(freeArg.length >= 6 ? freeArg : null)}, ${JSON.stringify(occArg)}, ${JSON.stringify(doorsArg)}, ${JSON.stringify(fillArg)}, ${JSON.stringify(trainSArg)}, ${JSON.stringify(oppArg)}, ${JSON.stringify(dwellArg)}, ${JSON.stringify(altArg)}, ${JSON.stringify(pedtArg)})`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) { bad++; console.log(`✗ ${j.name}: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`); continue; }
    const v = r.result.value;
    console.log(`✓ ${v.name}  ${v.w}×${v.h}  平均亮度 ${v.meanLuma}  过曝 ${v.blown}%  暗部 ${v.dark}%${v.aspect ? '  调度器显示=' + v.aspect : ''}${v.diag ? '  ' + v.diag : ''}  → ${v.save}`);
  }
  ws.close(); cleanup();
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
