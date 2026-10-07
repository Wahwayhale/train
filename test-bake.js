/* 无头烘焙测试：把渲染器打桩，验证世界与列车建模全流程不崩、不出 NaN */
global.window = global;
global.document = { createElement: () => ({ width:0, height:0, getContext: () => ({ fillStyle:'', createLinearGradient:()=>({addColorStop(){}}), createRadialGradient:()=>({addColorStop(){}}), beginPath(){},arc(){},fill(){},rect(){},clip(){},save(){},restore(){},translate(){},fillRect(){},clearRect(){},drawImage(){},fillText(){},strokeText(){},measureText:()=>({width:10}),strokeStyle:'',lineWidth:1,font:'',textAlign:'',textBaseline:'',moveTo(){},lineTo(){},stroke(){},ellipse(){},putImageData(){},createImageData:()=>({data:new Uint8Array(4)}), getImageData:()=>({data:new Uint8Array(4)}) }), style:{setProperty(){}} }), addEventListener(){}, querySelectorAll:()=>[], getElementById:()=>null };
global.localStorage = { getItem:()=>null, setItem:()=>{} };
global.matchMedia = () => ({matches:false});
global.performance = require('perf_hooks').performance;
const files = ['core','mesh','renderer','textures','align','world','train','physics', 'pax','audio'];
for (const f of files) require('./src/'+f+'.js');
require('./data/shanghai.js');
const SH = global.SH;
const V = SH.V3;   // 面积法要向量运算（窗带遮挡判据）
/* 一节车的网格集合。`part[key]` 现在**不保证是一维数组** ——
   `part.pax` 是"三档 × 网格数组"的二级结构（车内乘客按满载率分档），
   所以凡是"把这节车的所有网格都过一遍"的地方都必须展平。
   以前这里是 `for (const m of part[key])`，新加一批二级结构就当场炸成
   `m.pos undefined` —— 症状是"某个字段名不认识了"，而不是"多了一类几何"。 */
const meshesOf = part => { const out = []; for (const k of Object.keys(part)) for (const m of part[k]) out.push(...(Array.isArray(m) ? m : [m])); return out; };
/* dev/negctl.js 的两条负控从这里注回缺陷本体（车壳退回闭壳 / 客室不建）。
   注入点必须在**模块加载之前**：Geo.shellSplit 与 buildCarInterior 都是在
   require('./src/…') 时就被定义的对象方法，事后改 SH.__x 已经晚了一步。 */
if (process.env.NEG === 'noslot') SH.__negslot = true;
if (process.env.NEG === 'noinner') SH.__noinner = true;

// 打桩渲染器
const fakeR = {
  textures:{sign:null},
  batches:[],
  upload(meshes, tag){ for(const m of meshes){ for(let i=0;i<m.pos.length;i++) if(!isFinite(m.pos[i])) throw new Error('NaN pos in '+m.mat);
      for(let i=0;i<m.idx.length;i++) if(m.idx[i]>=m.verts) throw new Error('idx OOB in '+m.mat); }
    this.batches.push(...meshes.map(m=>({mat:m.mat,tag,count:m.count,verts:m.verts}))); return meshes.map(m=>({mat:m.mat,tag,count:m.count})); },
  dropTag(tag){ this.batches = this.batches.filter(b=>b.tag!==tag); },
  texFromCanvas(){ return {}; },
  draw(){}, begin(){}, end(){},
};

const gsrc = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = (name) => { const i = gsrc.indexOf('class ' + name); let d = 0; for (let k = gsrc.indexOf('{', i); k < gsrc.length; k++) { if (gsrc[k] === '{') d++; else if (gsrc[k] === '}') { d--; if (!d) return gsrc.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {}, semi: {}, auto: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');
/* SH.train.view（车门位置的工具集）定义在 game.js 里。上一版这里是 `require('./src/game.js')`，
   我删手工构造那段时把它一起删了，于是"门 N"这一列静默变成 0 —— 一个印着数字、
   但不再测量任何东西的诊断，和空指标是同一类错误。现在显式 require，并在下面断言门数 > 0。 */
try { require('./src/game.js'); } catch (e) { console.log('⚠ game.js 未能加载：', e.message); }

let fails = 0, facStations = 0;
const lineFilter = process.argv[2];
for (const id of Object.keys(SH.LINES)) {
  const def = SH.LINES[id];
  if (lineFilter && id !== lineFilter && def.name !== lineFilter) continue;
  try {
    const t0 = performance.now();
    const line = new LineRuntime(def);

    const sign = new SH.textures.SignAtlas(2048);
    const w = new (class extends SH.WorldBuilder {})( { al:line.al, color:def.color, stations:def.stations, sign, night:0.62, profile:line.profile } );
    w.ambient=[0.26,0.29,0.36]; w.sun={dir:[-0.5,0.4,0.76],col:[0.8,0.55,0.36]}; w._installLight();
    const s0 = 0, s1 = line.al.total;
    const t1 = performance.now();
    /* 几何序列只有一份实现：SH.WorldBuilder.buildRuns。
       这里以前自己复刻了一遍 if/else 分类器（第四份复刻），结果是"游戏侧新加的几何
       永远进不了烘焙判据"—— 磁浮轨道梁就是这样：游戏里已经没有钢轨了，这个测试却
       还在按老逻辑给磁浮铺钢轨并报告一切正常。 */
    SH.WorldBuilder.buildRuns(w, line, s0, s1, null);
    const dv = SH.depotZones(line.al).length;
    if (dv !== 2) { fails++; console.log(`${def.name} FAIL: 停车基地只有 ${dv} 处，两端各一处才对`); }
    /* 磁浮的"轨道"是 T 形梁 + 长定子，全线不该有一根钢轨或一块枕木道床；
       反过来地铁线必须有钢轨，否则这条判据就只是"没画东西"的同义词。 */
    {
      const bk = w.b.buckets, tri = m => Math.round(((bk.get(m) || { idx: [] }).idx.length) / 3);
      const rail = tri('rail'), ballast = tri('ballast'), steel = tri('steel');
      if (def.maglev) {
        if (rail || ballast) { fails++; console.log(`${def.name} FAIL: 磁浮线上出现钢轨 ${rail} / 道床 ${ballast} 个三角形（长定子轨道梁才是对的）`); }
        if (steel < 20000) { fails++; console.log(`${def.name} FAIL: 磁浮定子段只有 ${steel} 个三角形，太稀，看着就是一根光梁`); }
      } else if (SH.STOCK[def.stock] && SH.STOCK[def.stock].rubber) {
        /* 浦江线是胶轮 APM：行车道 + 导向轨，全线不该有钢轨，也不该有枕木道床。
           与磁浮同一条纪律 —— "另一种线路构造物"必须被反向钉住，
           否则退回钢轨也照样绿。 */
        if (rail || ballast) { fails++; console.log(`${def.name} FAIL: 胶轮 APM 线上出现钢轨 ${rail} / 道床 ${ballast} 个三角形（行车道 + 导向轨才是对的）`); }
        if (steel < 400) { fails++; console.log(`${def.name} FAIL: 导向轨/接触轨只有 ${steel} 个三角形，看着就是一块光板`); }
      } else if (rail < 1000) { fails++; console.log(`${def.name} FAIL: 地铁线钢轨只有 ${rail} 个三角形`); }
    }
    /* 供电对账（逐米审计 dev/audit-track.js 抓出的回归，钉成单元判据）：
       ① track(..., {noSupply:true}) 必须一个第三轨三角形都不铺 —— 以前这个
          口子只写在注释里，track() 根本不读，'oh' 线的高架段同时长出接触网
          （viaduct 铺的）与第三轨（这里铺的），16 号线铺出两份第三轨；
       ② catenary(..., {bare:true}) 只许有导线（steel），不许有门架支柱 ——
          高架车站的支柱立在 lat ±2.42 会插进站台，所以站内挂裸线。 */
    if (!def.maglev && !(SH.STOCK[def.stock] && SH.STOCK[def.stock].rubber)) {
      let a = 0;
      while (a < line.al.total - 120 && !line.isElevated(a)) a += 60;   // 优先找一段高架；找不到就用隧道段
      const z0 = a + 120;
      /* 第三轨带：mat concrete、横向 ±(0.75+0.62)=±1.37、轨面上 0.04~0.28。
         把 concrete 顶点投回轨道坐标数带内的个数 —— noSupply 失效时这段
         120 m 会多出约 300 个第三轨顶点。轨道与裸线分开烘焙：
         track() 默认还铺信号机柱（lat ±2.42 的 metal），混在一起会把
         信号柱误计成接触网门架。 */
      const fr0 = line.al.frame(a);
      const probe = ms => { let inBand = 0, portal = 0, wire = 0, slab = 0;
        for (const m of ms) { const P = m.pos;
          for (let i = 0; i < P.length; i += 3) {
            const dx = P[i] - fr0.p[0], dy = P[i + 1] - fr0.p[1], dz = P[i + 2] - fr0.p[2];
            const fwd = dx * fr0.f[0] + dy * fr0.f[1] + dz * fr0.f[2];
            if (fwd < -5 || fwd > 125) continue;
            const lat = Math.abs(dx * fr0.r[0] + dy * fr0.r[1] + dz * fr0.r[2]);
            const y = dx * fr0.u[0] + dy * fr0.u[1] + dz * fr0.u[2];
            if (m.mat === 'concrete' && Math.abs(lat - 1.37) < 0.45 && y > -0.05 && y < 0.40) inBand++;
            if (m.mat === 'metal' && Math.abs(lat - 2.42) < 0.3) portal++;      // 门架支柱/悬臂梁
            if (m.mat === 'steel' && y > 4.5) wire++;
            if (m.mat === 'concreteD' && lat < 1.2 && y > -0.34 && y < -0.06) slab++;  // 道床板体

          } }
        return { inBand, portal, wire, slab }; };
      const w2 = new SH.WorldBuilder({ al: line.al, color: def.color, stations: line.stations, sign, night: 0.62, profile: line.profile });
      w2.track(a, z0, { step: 4, ballast: false, noSupply: true, signage: false });
      const m2 = w2.b.finish();          // finish() 只许调一次：桶会被清空
      const r2 = probe(m2);
      const w3 = new SH.WorldBuilder({ al: line.al, color: def.color, stations: line.stations, sign, night: 0.62, profile: line.profile });
      w3.catenary(a, z0, { bare: true });
      const r3 = probe(w3.b.finish());
      if (r2.inBand > 0) { fails++; console.log(`${def.name} FAIL: track(noSupply) 仍铺了 ${r2.inBand} 个第三轨带顶点（noSupply 被无视，高架双份供电回归）`); }
      if (r3.portal > 0) { fails++; console.log(`${def.name} FAIL: 裸接触网带了 ${r3.portal} 个门架顶点（支柱会插进高架站台）`); }
      if (r3.wire < 40) { fails++; console.log(`${def.name} FAIL: 裸接触网没有导线（轨上 4.5 m 以上的 steel 顶点只有 ${r3.wire} 个）`); }
      /* 道床板按**逐帧局部采样**量：窗口里若有曲线/坡度，固定在 fr0 上的
         横向与高度带在 120 m 外会漂出几米 —— 顶点明明在板上也会被滤掉。
         沿窗口取 12 个采样帧，每个帧数"轨面下 0.4~0 m、半径 2 m 内的
         concreteD 顶点"：道床板四角每帧都在，排水缝（每 6.5 m 一道、
         高度 −0.04~−0.02）只在个别帧出现。 */
      {
        let have = 0;
        const CD = [];
        for (const m of m2) if (m.mat === 'concreteD') CD.push(m.pos);
        for (let k = 0; k < 12; k++) {
          const fq = line.al.frame(a + 5 + k * 10);
          const cp = line.al.world(fq, 0, -0.2);
          let n = 0;
          for (const P of CD) for (let i = 0; i < P.length; i += 3) {
            const ddx = P[i] - cp[0], ddy = P[i + 1] - cp[1], ddz = P[i + 2] - cp[2];
            if (ddx * ddx + ddy * ddy + ddz * ddz < 4.0) n++;
          }
          if (n >= 3) have++;
        }
        if (have < 10) { fails++; console.log(`${def.name} FAIL: 道床板 12 帧采样只有 ${have} 帧在位（轨下没有连续板，轨道读成路面标线）`); }
      }
    }
    const defRubber = !!(SH.STOCK[def.stock] && SH.STOCK[def.stock].rubber);
    const meshes = w.b.finish();
    const t2 = performance.now();
    const verts = meshes.reduce((t,m)=>t+m.verts,0), tris = meshes.reduce((t,m)=>t+m.count/3,0);
    // 列车
    const tv = new SH.train.TrainView(line.profile, {});
    /* 走行部必须与线路类型一致：磁浮没有轮子，车体两侧要伸出**抱臂**夹住轨道梁翼板
       （顶点落在梁翼那一圈：y < −0.15 且横向 1.0~2.4 m）；地铁则不许有抱臂。
       这条同时兜住"profile 里读不到 maglev 标志"那一类静默失效。 */
    {
      let arms = 0;
      for (const part of [tv.head, tv.mid]) for (const m of meshesOf(part))
        for (let i = 0; i < m.pos.length; i += 3)
          if (m.pos[i + 1] < -0.15 && Math.abs(m.pos[i]) > 1.0 && Math.abs(m.pos[i]) < 2.4) arms++;
      if (def.maglev) {
        if (!line.profile.maglev) { fails++; console.log(`${def.name} FAIL: profile.maglev 没传下去（构造顺序改了？）—— 磁浮会退回地铁的方箱断面与灰腰带`); }
        if (arms < 40) { fails++; console.log(`${def.name} FAIL: 磁浮抱臂只有 ${arms} 个顶点，车图像是飘在轨道梁上方`); }
      } else if (arms > 0) { fails++; console.log(`${def.name} FAIL: 地铁线上长出 ${arms} 个磁浮抱臂顶点`); }
      /* 胶轮 APM：承重胎必须**压在行车道上**（横向 = APM.laneLat、轴心高 = 2×胎半径以内），
         水平导向轮必须**夹住导向轨**（|横向| 在 guideOut 与 rollerLat 之间、贴地）。
         两侧坐标读同一张 `SH.APM` 表 —— 轨道改了车没改，这条就会红：
         顶点数、绕序、烘焙全都正常，但胎压在空气上、轮夹着空气跑。 */
      {
        const A = SH.APM;
        let tyres = 0, rollers = 0;
        /* 只看**材质是 paint 的那批**：钢轮的轮盘/轮毂是 'steel'、构架是 'metal'，
           而胶胎是深色橡胶（paint）。第一版没按材质分带，5/6/8 号线（C 型车，
           轮对横向 ±1.04 m）被压扁球的 x 端点误命中 232 个"胶轮" ——
           与 `tiles` 那次的教训同族：**按位置统计必须同时按材质分带**。 */
        for (const part of [tv.head, tv.mid]) for (const m of meshesOf(part)) {
          if (m.mat !== 'paint') continue;
          for (let i = 0; i < m.pos.length; i += 3) {
            const y = m.pos[i + 1], ax = Math.abs(m.pos[i]);
            if (Math.abs(ax - A.laneLat) < 0.02 && y > 0.02 && y < 2 * A.tyreR) tyres++;
            if (ax > A.guideOut && ax <= A.rollerLat + 0.10 && y < 0.20) rollers++;
          }
        }
        if (defRubber) {
          if (tyres < 40) { fails++; console.log(`${def.name} FAIL: 承重胎只有 ${tyres} 个顶点落在行车道上（胎没压着道 = 悬浮在轨道上方）`); }
          if (rollers < 12) { fails++; console.log(`${def.name} FAIL: 水平导向轮只有 ${rollers} 个顶点，夹不住 ±${A.guideLat} m 的导向轨`); }
        } else if (tyres || rollers) {
          fails++; console.log(`${def.name} FAIL: 钢轨线上长出 ${tyres} 个胶轮 / ${rollers} 个导向轮顶点`);
        }
      }
      /* APM 车站是**半高安全门**（浦江线全线高架小站，门柱 1.5 m + 顶扶手梁），
         全高屏蔽门的 2.56 m 门柱与 2.62 m 门楣装在 3.2 m 高的胶轮车旁边就是穿帮。
         量法：把世界顶点投回站台所在里程的轨道坐标，数横向 1.9~2.3 m 带上
         高于 2.0 m 的 metal —— 那是全高门框/门楣会落到的地方。 */
      if (defRubber) {
        const st0 = line.al.stationS[Math.min(1, line.al.stationS.length - 1)];
        const fr = line.al.frame(st0);
        let hi = 0, gate = 0;
        for (const m of meshes) {
          if (m.mat !== 'metal') continue;
          for (let i = 0; i < m.pos.length; i += 3) {
            const dx = m.pos[i] - fr.p[0], dzz = m.pos[i + 2] - fr.p[2];
            const fwd = dx * fr.f[0] + dzz * fr.f[2];
            if (Math.abs(fwd) > 100) continue;
            const lat = Math.abs(dx * fr.r[0] + dzz * fr.r[2]);
            if (lat < 1.9 || lat > 2.3) continue;
            const hgt = m.pos[i + 1] - fr.p[1];
            if (hgt > 2.0) hi++; else if (hgt > 0.4) gate++;
          }
        }
        if (hi) { fails++; console.log(`${def.name} FAIL: 站台门带上还有 ${hi} 个高于 2.0 m 的 metal 顶点（APM 是半高安全门，全高门框/门楣是穿帮）`); }
        if (gate < 60) { fails++; console.log(`${def.name} FAIL: 半高安全门带上只有 ${gate} 个 metal 顶点（门柱没建出来）`); }
      }
      /* 走廊楼群（71/96 车道）与远景盒体城市（240 m 起）之间的**低空档带**
         （118~132 m、高 ≤8 m 的厂房/物流园）：没了它，从 40~80 m 的观景机位
         看过去是一圈只有贴图的平地（第 89 条）。有高架段的线必须有这批楼。 */
      if (def.elevated && def.elevated.length) {
        const strip = (w.cityLots || []).filter(l => l.dist >= 118 && l.dist <= 132 && l.h <= 8.5);
        if (!strip.length) { fails++; console.log(`${def.name} FAIL: 走廊与远景之间的低空档带（118~132 m、≤8 m）一栋楼都没有 —— 从低机位看是一圈贴图平地`); }
      }
      /* 车窗必须是**真的开口**，而客室必须在里面 —— 这一对是"从站台能看见车厢"的全部。
         量法（量结果不量写法）：
           ① 窗带高度上、**朝侧面**的不透明车体面积必须远小于窗带总面积。
              用面积而不是顶点数：门框竖梃、窗带竖框这些本来就该在窗位上，
              它们占的是几厘米宽的竖条；而"侧壁没开"是一整面 1.02 m × 全车的板。
              按顶点数判会把正的门框判成缺陷（这正是判据自己量错对象的典型）。
           ② 客室批次必须存在，长条座与扶手/吊环必须有顶点。
         任何一条都能被"车壳退回封闭扫掠"这条变异打红。 */
      {
        const W = SH.CARWIN, p = line.profile;
        const yLo = p.floorY + W.lo, yHi = p.floorY + W.hi;
        /* 门框与竖框允许的宽度：它们合起来最多吃掉窗带的 1/5。
              判据给的是"窗带还剩多少"，不是"有没有一根框" —— 前者与构图有关，
              后者与真车构造有关，两件事混在一条断言里就会出现"框做对了反而报红"。 */
        let band = 0, solid = 0;
        for (const part of [tv.head, tv.mid]) {
          const L = part === tv.head ? p.headLen : p.midLen;
          const usable = part === tv.head ? (L - 4.6 - 1.4) : (L * 0.86);
          for (const m of part.body) {
            if (m.mat === 'window' || m.mat === 'glassSoft') continue;
            for (let t = 0; t < m.idx.length; t += 3) {
              const i0 = m.idx[t] * 3, i1 = m.idx[t + 1] * 3, i2 = m.idx[t + 2] * 3;
              const y0 = m.pos[i0 + 1], y1 = m.pos[i1 + 1], y2 = m.pos[i2 + 1];
              if (y0 < yLo || y1 < yLo || y2 < yLo || y0 > yHi || y1 > yHi || y2 > yHi) continue;
              const nx = m.nrm[t], ny = m.nrm[t + 1], nz = m.nrm[t + 2];
              if (Math.abs(nx) < 0.72) continue;                    // 只要朝侧面的
              /* 该三角形横向跨度落在车体侧面带内（不在端头/车顶区域） */
              const xa = Math.abs(m.pos[i0]), xb = Math.abs(m.pos[i1]), xc = Math.abs(m.pos[i2]);
              if (Math.max(xa, xb, xc) < p.width / 2 - 0.10) continue;
              if (Math.min(xa, xb, xc) > p.width / 2 + 0.06) continue;
              const a = V.sub([m.pos[i1], m.pos[i1 + 1], m.pos[i1 + 2]], [m.pos[i0], m.pos[i0 + 1], m.pos[i0 + 2]]);
              const b = V.sub([m.pos[i2], m.pos[i2 + 1], m.pos[i2 + 2]], [m.pos[i0], m.pos[i0 + 1], m.pos[i0 + 2]]);
              solid += 0.5 * Math.hypot(...V.cross(a, b));
            }
          }
          band += usable * W.h * 2;
        }
        if (!(band > 0)) { fails++; console.log(`${def.name} FAIL: 窗带面积算成 0（车长/窗带常数不一致）`); }
        else if (solid > band * 0.22) {
          fails++;
          console.log(`${def.name} FAIL: 窗带高度上 ${(100 * solid / band).toFixed(0)}% 被不透明车体挡住 —— 侧壁没开窗，透过玻璃看到的还是墙（门槛 22%）`);
        }
        let seats = 0, rails = 0;
        for (const part of [tv.head.inner, tv.mid.inner]) {
          if (!part) { fails++; console.log(`${def.name} FAIL: 客室批次没建出来（buildCarInterior 没接上）`); break; }
          for (const m of part) for (let i = 0; i < m.pos.length; i += 3) {
            const rel = m.pos[i + 1] - p.floorY, ax = Math.abs(m.pos[i]);
            if (rel > W.seat - 0.10 && rel < W.seat + 0.12 && ax > p.width / 2 - 0.62) seats++;
            if (rel > W.rail - 0.09 && rel < W.rail + 0.09) rails++;
          }
        }
        if (seats < 200) { fails++; console.log(`${def.name} FAIL: 客室纵向长条座只有 ${seats} 个顶点（车厢是空的）`); }
        if (rails < 60) { fails++; console.log(`${def.name} FAIL: 客室扶手/吊环只有 ${rails} 个顶点 —— 没有吊环就没有"上海地铁"的剪影`); }
      }
      /* 车门两片叶必须**各向一侧滑开**（第 112 条）。
         量的是几何本身：对每一扇门（中心 dz、净宽 doorW），
           ① 静止时叶 A 完全在门心左侧、叶 B 完全在右侧（合成一扇关着的门）；
           ② 开门平移 off=0.72 之后，A 的右端退到门洞左沿之外、B 的左端退到门洞右沿之外
              —— 门洞**整幅**让开。
         这两条一起才排得掉"两片叶拿同一个矩阵、门只开一半"那个缺陷：
         单看 ①（静止）永远是绿的，单看"门开了没有"（叶位移了）也是绿的。 */
      {
        const p = line.profile, off = SH.train.doorSlide(p), half = p.doorW / 2;
        let dzAll = 0, leafA = 0, leafB = 0, badRest = 0, badOpen = 0;
        for (const kind of ['mid', 'head']) {
          const part = kind === 'mid' ? tv.mid : tv.head;
          const L = kind === 'mid' ? p.midLen : p.headLen;
          for (const dz of SH.train.doorZs(p, L, kind)) {
            dzAll++;
            let aMax = -1e9, aMin = 1e9, bMax = -1e9, bMin = 1e9, na = 0, nb = 0;
            const scan = (meshes, acc) => {
              for (const m of meshes) for (let i = 0; i < m.pos.length; i += 3) {
                /* 只取门页（外挂在车体外侧 ±(width/2+0.016) 一带），门框在 body 里不受影响 */
                if (Math.abs(Math.abs(m.pos[i]) - (p.width / 2 + 0.016)) > 0.05) continue;
                const z = m.pos[i + 2];
                if (z < dz - p.doorW || z > dz + p.doorW) continue;
                acc(z);
              }
            };
            scan(part.doorsA, z => { aMin = Math.min(aMin, z); aMax = Math.max(aMax, z); na++; });
            scan(part.doorsB, z => { bMin = Math.min(bMin, z); bMax = Math.max(bMax, z); nb++; });
            if (!na || !nb) continue;
            leafA += na; leafB += nb;
            /* 静止：叶 A 全在门心左侧、叶 B 全在右侧，两片合起来盖住整个门洞 */
            if (!(aMax < dz + 0.02 && bMin > dz - 0.02 && aMin <= dz - half + 0.06 && bMax >= dz + half - 0.06)) badRest++;
            /* 开门：两片叶各自退到门洞之外（整幅让开） */
            if (!(aMax - off <= dz - half + 1e-6 && bMin + off >= dz + half - 1e-6)) badOpen++;
          }
        }
        if (!dzAll || !leafA || !leafB) {
          fails++;
          console.log(`${def.name} FAIL: 车门两片叶没有分成 doorsA/doorsB 两批（A ${leafA} 顶点 / B ${leafB} 顶点）—— 一个批次一个矩阵，两片叶往相反方向走就必须分两批`);
        } else if (badRest) {
          fails++;
          console.log(`${def.name} FAIL: ${badRest} 扇门静止时两片叶不是"左半 + 右半"（叶 A 越过门心或叶 B 越过门心）`);
        } else if (badOpen) {
          fails++;
          console.log(`${def.name} FAIL: ${badOpen} 扇门开门后门洞没有整幅让开（叶 A 仍盖着左半 / 叶 B 仍盖着右半）—— 两片叶拿了同一个平移方向`);
        }
      }
      /* 绘制路径烟测与单侧开门断言：
         开门时（open = 1），仅站台侧门叶滑开（变换矩阵位移量 |M[14]| > 0.1），
         非站台侧门叶保持静止闭合（M[14] === 0），门提示灯仅开门侧被绘制。 */
      {
        const calls = [];
        const recordR = Object.assign({}, fakeR, {
          draw(b, M, opt) { calls.push({ b, M, opt }); }
        });
        const TVw = new SH.TrainView(recordR);
        TVw.setLine(line, sign, null);
        const sh = line.al.stationS[Math.min(2, line.al.stationS.length - 1)] + SH.STOP_MARK;
        for (const op of [0, 1]) {
          TVw.draw(sh, op, { notch: 3, lamps: null, fill: 0.8, doorsOpen: op > 0, wiper: 0, fix: null });
          TVw.drawExternal(sh, op, 0.8, false, 1);
          TVw.drawExternalOpp(sh, op, 0.8, false, 1);
        }
        // 单侧开门专项断言：以中间车（ci = 1）单独绘制验证
        calls.length = 0;
        const side = line.stationSide(0);
        TVw._drawCar(1, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 1, 0.5, 1, 0, side);
        const platOpenA = side < 0 ? TVw.doorALB[1] : TVw.doorARB[1];
        const platOpenB = side < 0 ? TVw.doorBLB[1] : TVw.doorBRB[1];
        const nonPlatA = side < 0 ? TVw.doorARB[1] : TVw.doorALB[1];
        const nonPlatB = side < 0 ? TVw.doorBRB[1] : TVw.doorBLB[1];
        const nonPlatLamps = side < 0 ? TVw.doorLampRB[1] : TVw.doorLampLB[1];

        let badPlat = 0, badNonPlat = 0;
        for (const c of calls) {
          if (platOpenA.includes(c.b) || platOpenB.includes(c.b)) {
            if (Math.abs(c.M[14]) < 0.1) badPlat++;
          }
          if (nonPlatA.includes(c.b) || nonPlatB.includes(c.b)) {
            if (Math.abs(c.M[14]) > 1e-4) badNonPlat++;
          }
          if (nonPlatLamps && nonPlatLamps.includes(c.b)) {
            badNonPlat++;
          }
        }
        if (badPlat > 0 || badNonPlat > 0) {
          fails++;
          console.log(`${def.name} FAIL: 车门未实现单侧开门（站台侧未滑开 ${badPlat} 批 / 非站台侧未闭合 ${badNonPlat} 批，开门侧 side=${side}）`);
        }
      }
      /* 车体与客室都**自带一套人工光**，这件事必须机器可查。
         判据来自一次真实教训：车壳与客室都是 `train.js` 直接产出的烘焙几何，
         不进世界光照网格；隧道环境光只有 0.085，于是浅灰色车皮被压成纯黑 ——
         **画面上整列车是一条黑影，只有那条自带 `emi` 的线路色腰带读得出来**。
         而"站台上一列亮着的车"恰恰是玩家对这个项目最直接的第一印象。
         量法：顶点的 emi 通道（已按 0..2.5 打包）。量的是"有没有被照亮"，
         不量"照得够不够亮" —— 后者的门槛随渲染管线变，前者不会。
         负控：把 carShellLight 退回恒 0。 */
      {
        let shell0 = 0, shellN = 0, inner0 = 0, innerN = 0, innerSum = 0;
        for (const part of [tv.head, tv.mid]) {
          for (const m of part.body) { if (m.mat !== 'body') continue; for (const e of m.emi) { shellN++; if (e < 8) shell0++; } }
          for (const m of part.inner) for (const e of m.emi) { innerN++; innerSum += e; if (e < 8) inner0++; }
        }
        /* 车皮：几乎每个顶点都要有灯（裙板以下允许暗，但不许整片没有） */
        if (shellN < 400 || shell0 > shellN * 0.10)
          { fails++; console.log(`${def.name} FAIL: 车皮只有 ${shell0}/${shellN} 个顶点拿到人工光 —— 隧道里整列车是一条黑影`); }
        /* 客室：客室必须比车皮亮得多（真实客室 300+ lux 对隧道 0.085 环境光） */
        if (innerN < 400 || inner0 > innerN * 0.10)
          { fails++; console.log(`${def.name} FAIL: 客室只有 ${inner0}/${innerN} 个顶点拿到人工光 —— 隔着车窗看不见车厢`); }
        const mi = innerSum / Math.max(1, innerN);
        if (mi < 40) { fails++; console.log(`${def.name} FAIL: 客室平均自发光只有 ${mi.toFixed(1)}（门槛 40）—— 窗后面是黑的`); }
      }
      /* ---- 车内乘客（第 97 条）----
       * 车窗开成真的洞之后，"车里有没有人"是玩家一眼就读得到的东西，
       * 而它同时是"挤不上车"那条规则的画面兑现。所以判据量三件几何事实，
       * 不是"代码里有没有写 buildCarPax"：
       *  ① 三档都必须真的有人，而且**逐档变多**（一档比一档少 = 档位是装饰）；
       *  ② 站着的人不许站在门区里，也不许穿过内衬面 —— 这两件事在画面上
       *     都是"人卡在奇怪的位置"，而车门是关着的，看不出来；
       *  ③ L1 全是坐的（真实车厢是有座先坐），L3 必须有站着的。
       * 站的/坐的判据是**最低顶点的离地高**：坐着的是座面高，站着的贴地板。 */
      {
        const lay = SH.train.carLayout(line.profile, 'mid');
        const fy = line.profile.floorY, seatY = fy + 0.40;   // WIN.seat 附近
        const inner = lay.innerX;
        let prev = 0, standing3 = 0, badSpot = 0, spot = '';
        for (const lv of [1, 2, 3]) {
          let tris = 0, minY = 9;
          for (const m of (SH.train.buildCarPax(line.profile, 'mid', lv))) {
            tris += m.count / 3;
            for (let i = 1; i < m.pos.length; i += 3) minY = Math.min(minY, m.pos[i]);
            /* 站在地板上的那一批：最低顶点落在地板上方 6 cm 以内 */
            for (let i = 0; i < m.pos.length; i += 3) {
              if (m.pos[i + 1] > fy + 0.06) continue;
              const x = m.pos[i], z = m.pos[i + 2];
              if (lv === 3) standing3++;
              /* 不许穿出内衬面：内衬在 ±innerX，判据留 8 cm 余量 ——
                 人的肩宽有 0.40 m，贴着墙站既不真实也会与内衬共面。 */
              if (Math.abs(x) > inner - 0.08) { badSpot++; if (!spot) spot = `横向 ${x.toFixed(2)} 超过内衬 ${(inner - 0.08).toFixed(2)}`; }
              /* 门区就是门叶滑开的那一段：人站在那里会被门切过去。
                 判据按**门区本身**判，不加余量 —— 加了余量就把"门边站着的人"
                 （真实车厢里最常见的那一群）也判成违规了。 */
              if (lay.zone.some(q => z > q[0] - 0.04 && z < q[1] + 0.04)) { badSpot++; if (!spot) spot = `z=${z.toFixed(2)} 站在门区里`; }
            }
          }
          if (tris <= prev) {
            fails++;
            console.log(`${def.name} FAIL: 车内乘客第 ${lv} 档只有 ${tris} 个三角形（不上一档 ${prev}）—— 满载率变了而车里的人数没变`);
          }
          if (lv === 1 && minY < seatY) {
            fails++;
            console.log(`${def.name} FAIL: 车内乘客第 1 档出现了站姿（最低顶点 ${minY.toFixed(2)} m，座面 ${seatY.toFixed(2)} m）—— 有座先坐`);
          }
          prev = tris;
        }
        if (standing3 < 60) { fails++; console.log(`${def.name} FAIL: 第 3 档只有 ${standing3} 个站姿顶点 —— 超员车厢也得站满通道`); }
        if (badSpot) { fails++; console.log(`${def.name} FAIL: 车内乘客里有 ${badSpot} 个顶点卡在门区或穿出内衬面（如 ${spot}）`); }
      }
    }
    const t3 = performance.now();
    const cars = [tv.head, ...Array(Math.max(0,line.stock.cars-2)).fill(tv.mid), tv.head];
    const t4 = performance.now();
    /* 站台信息屏：这一站必须真的挂一块屏。
     * 判据量的是"烘焙里有没有 ptd 批次 + 它的材质是不是 ptd"，而不是
     * "代码里有没有写 screen()" —— 屏不出现的原因可以是批次没上传、
     * 标签没进 dropTag 列表、或者 idx 取到 null，三者都不抛错。 */
    {
      const ptd = (w.ptdBatches || []);
      if (!ptd.length) { fails++; console.log(`${def.name} FAIL: 这一段没有站台信息屏（ptdBatches 为空）`); }
      else {
        let face = 0;
        for (const o of ptd) for (const m of o.mesh) if (m.mat === 'ptd') face += m.count / 3;
        /* 每站两块（双面），每面屏面是 2 个三角形 ⇒ 至少 4 个 */
        if (face < 4) { fails++; console.log(`${def.name} FAIL: 站台屏只有 ${face} 个三角形（屏面没建出来）`); }
        if (ptd.some(o => o.idx == null)) { fails++; console.log(`${def.name} FAIL: 有站台屏没带上站序（idx=null）—— 屏会贴错站的倒计时`); }
      }
    }
    /* ---- 站厅侧设施：闸机组 / 售票机 / 时钟 / 出入口导向 / 长椅 / 垃圾桶 ----
     * 判据量**两件**事，缺一不可：
     *   ① 每个**地下站**这一带各有多少件（按站量，不按全线总量 ——
     *      按总量的话，站少的车永远达不到按站算出来的门槛，判据就废了）；
     *   ② 每条登记的位置上，烘焙出来的顶点里真的有、且材质对得上。
     * 只有 ① 等于"代码说自己建了"：站台屏那批"重置累积数组"就是这样
     * 几何照建、批次数为零、没有任何判据报红（README 第 93 条）。
     * 只有 ② 则 `facilities.push` 和真正的 box 摆位可以各写各的。 */
    {
      const fac = w.facilities || [];
      /* `staff` = 站务员（第 105 条）：站台两端各一名，制服 + 帽 + 信号旗。
         它是"这条线有人在管"最直接的证据，与倒计时屏同族 —— 而人群是随机深色
         剪影，混在里面认不出来，所以站务员靠**制服色**区分，不靠数量。 */
      const KINDS = ['gate', 'tvm', 'clock', 'exitSign', 'bench', 'bin', 'staff'];
      const MIN = { gate: 5, tvm: 3, clock: 2, exitSign: 1, bench: 3, bin: 2, staff: 2 };
      /* B2b：**露天站也在覆盖范围内**（16 号线 / 浦江线 / 磁浮 是全线高架化，
         3/5/6/8/10/11/13/17 也有露天站）。以前只查地下站，"高架化线路一座都没有"
         这笔账挂在诚实清单上 —— 现在设施几何在两种站上共用同一套，判据也共用同一套。 */
      const under = [], opens = [], sites = [];
      for (let i = 1; i < line.stations.length - 1; i++) {
        (line.isElevated(line.al.stationS[i]) ? opens : under).push(i);
        sites.push(i);
      }
      if (!sites.length) console.log(`  ${def.name} 中间站为空，站厅侧设施判据跳过（磁浮只有首末站）`);
      facStations += sites.length;
      const siteKind = i => line.isElevated(line.al.stationS[i]) ? '露天' : '地下';
      for (const i of sites) {
        const ss = line.al.stationS[i];
        const near = fac.filter(o => Math.abs(o.s - ss) < 130);
        for (const k of KINDS) {
          const n = near.filter(o => o.kind === k).length;
          if (n < MIN[k]) {
            fails++;
            console.log(`${def.name} FAIL: ${line.stations[i]} 站（${siteKind(i)}）一带只有 ${n} 件 ${k}（应 ≥ ${MIN[k]}）—— 站台上没有"这地方在运行"的证据`);
          }
        }
      }
      /* 记录 ↔ 几何：先给每个站划一块世界 AABB（只框站区，不框全线），
         再把顶点按 8 m 粗网格塞进去。**格子里不能限量** —— 限量会让格子先被
         别的几何填满、设施自己的顶点被丢掉，于是"记录有、几何没有"会伪装成
         "几何在别的格子里"。所以这里只索引站区（几十万顶点），格子不设上限。
         AABB 要按**全部**车站划（含首末站）：`under` 为了避开端点站只取中间站，
         而设施记录里首末站也有 —— 拿 `under` 划框，首末站那 16 件设施就会
         一律报"只有登记没有几何"，而它们的几何明明在那儿。 */
      const ZC = 256, zg = new Map();
      for (let si = 0; si < line.al.stationS.length; si++) {
        const ss = line.al.stationS[si];
        let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
        for (let sSample = Math.max(0, ss - 150); sSample <= Math.min(line.al.total, ss + 45); sSample += 20) {
          const fr = line.al.frame(sSample);
          for (const sgn of [-1, 1]) {
            const q = line.al.world(fr, sgn * 20, 0);
            bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); bz0 = Math.min(bz0, q[2]); bz1 = Math.max(bz1, q[2]);
          }
        }
        for (let cx = Math.floor(bx0 / ZC); cx <= Math.floor(bx1 / ZC); cx++)
          for (let cz = Math.floor(bz0 / ZC); cz <= Math.floor(bz1 / ZC); cz++) {
            const k2 = cx + ':' + cz;
            let arr = zg.get(k2); if (!arr) zg.set(k2, arr = []);
            arr.push([bx0, bx1, bz0, bz1]);
          }
      }
      const CELL = 8, grid = new Map();
      /* 通道分段核量的宽度：产品的灯带是每 6 m 一道，8 m 一段就要求"每段必有灯"，
         段宽再大就成了对稀疏几何的让步，再小就成了对摆位相位的苛求。 */
      const BIN = 8;
      const inZone = (x, z) => {
        const arr = zg.get(Math.floor(x / ZC) + ':' + Math.floor(z / ZC));
        if (!arr) return false;
        for (const b of arr) if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]) return true;
        return false;
      };
      /* ---- 换乘通道的视野要单独开，而且要按产品的声称开 ----
         站区 AABB 只框到轨道横向 ±20 m，而一条 70~210 秒的换乘通道能伸到
         40~210 m —— 框外的顶点根本不入库，于是"记录有、几何没有"报的是
         判据自己的视野缺陷。框也不能按几何划（那等于让被检的东西自己划范围），
         所以横向距离取 `SH.transferPlan(name, meta).total` + 起点横移：
         产品声称走多远，判据就看到多远，声称多少验多少。 */
      const planLat = si => {
        const nm = line.stations[si], meta = SH.INTER_META && SH.INTER_META[nm];
        if (!meta || meta.type !== 'in') return 0;
        const tot = (SH.transferPlan(nm, meta) || {}).total || 0;
        if (!(tot > 0)) return 0;
        const L0 = line.isElevated(line.al.stationS[si]) ? SH.STATION_X.rail + 1.98 : 11.0;
        return L0 + tot + 6;
      };
      const CZC = 256, czg = new Map();
      for (let si = 0; si < line.al.stationS.length; si++) {
        const reach = planLat(si);
        if (!reach) continue;
        const ss = line.al.stationS[si];
        let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
        for (let sSample = Math.max(0, ss - 150); sSample <= Math.min(line.al.total, ss + 45 + reach); sSample += 20) {
          const fr = line.al.frame(sSample);
          for (const sgn of [-1, 1]) {
            const q = line.al.world(fr, sgn * reach, 0);
            bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); bz0 = Math.min(bz0, q[2]); bz1 = Math.max(bz1, q[2]);
          }
        }
        for (let cx = Math.floor(bx0 / CZC); cx <= Math.floor(bx1 / CZC); cx++)
          for (let cz = Math.floor(bz0 / CZC); cz <= Math.floor(bz1 / CZC); cz++) {
            const k2 = cx + ':' + cz;
            let arr = czg.get(k2); if (!arr) czg.set(k2, arr = []);
            arr.push([bx0, bx1, bz0, bz1]);
          }
      }
      const inCZone = (x, z) => {
        const arr = czg.get(Math.floor(x / CZC) + ':' + Math.floor(z / CZC));
        if (!arr) return false;
        for (const b of arr) if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]) return true;
        return false;
      };
      /* 通道调色板：只把这几类材质收进通道格，城市楼体（facade/glass/roof）
         不进 —— 框放宽到两百米后若什么都收，格子里就装满了与通道无关的顶点。 */
      const CMAT = new Set(['granite', 'tiles', 'metal', 'sign', 'emissive']);
      const cgrid = new Map();
      for (const m of meshes) {
        if (!CMAT.has(m.mat)) continue;
        for (let i = 0; i < m.pos.length; i += 3) {
          if (!inCZone(m.pos[i], m.pos[i + 2])) continue;
          const k = Math.floor(m.pos[i] / CELL) + ':' + Math.floor(m.pos[i + 2] / CELL);
          let a = cgrid.get(k); if (!a) cgrid.set(k, a = []);
          a.push(m.pos[i], m.pos[i + 1], m.pos[i + 2], m.mat);
        }
      }
      let cVert = 0; for (const a of cgrid.values()) cVert += a.length / 4;
      let nLeg = 0; for (const o of fac) if (o.w0) nLeg++;
      if (nLeg && !cVert) {
        fails++;
        console.log(`${def.name} FAIL: 登记了 ${nLeg} 条通道腿，但加宽后的通道格里一个顶点都没有 —— 判据在这一线上是瞎的，不许当作通过`);
      }
      for (const m of meshes) {
        if (m.mat === 'sky' || m.mat === 'ground') continue;
        for (let i = 0; i < m.pos.length; i += 3) {
          if (!inZone(m.pos[i], m.pos[i + 2])) continue;
          const k = Math.floor(m.pos[i] / CELL) + ':' + Math.floor(m.pos[i + 2] / CELL);
          let a = grid.get(k); if (!a) grid.set(k, a = []);
          a.push(m.pos[i], m.pos[i + 1], m.pos[i + 2], m.mat);
        }
      }
      const RAD = { gate: 1.3, tvm: 1.0, clock: 0.9, exitSign: 1.9, bench: 1.2, bin: 0.7, staff: 1.4, transferPassage: 2.5, transferShared: 2.2 };
      let hollow = 0, sample = '';
      for (const o of fac) {
        /* 通道腿是一条十几米长的扫掠盒，顶点只在八个角上，记录点却悬在走廊
           正中央 —— 按"离点多远"量永远量不到。改成量**到轴线的垂距**：
           顶点必须落在通道自己的横断面外廓内（半宽 + 门套壁厚 0.8 m），
           并且沿轴要铺开（覆盖声称长度的一半以上），否则"只立了门口两根柱子、
           通道本体是空的"照样过。 */
        if (o.w0 && o.w1) {
          const ax = o.w1[0] - o.w0[0], ay = o.w1[1] - o.w0[1], az = o.w1[2] - o.w0[2];
          const L = Math.sqrt(ax * ax + ay * ay + az * az);
          if (!(L > 1)) { hollow++; if (!sample) sample = `${o.kind}@${o.station}：腿长 ${L.toFixed(2)} m，退化`; continue; }
          const ux = ax / L, uy = ay / L, uz = az / L;
          const R = o.halfW + 0.8, R2 = R * R;
          const seen = new Set();
          let hit = 0; const bins = new Set(), nBin = Math.ceil(L / BIN);
          for (let t = 0; t <= L + 0.01; t += 3) {
            const k = Math.min(1, t / L);
            const px = o.w0[0] + ax * k, py = o.w0[1] + ay * k, pz = o.w0[2] + az * k;
            const gx = Math.floor(px / CELL), gz = Math.floor(pz / CELL);
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
              const key = (gx + a) + ':' + (gz + b), arr = cgrid.get(key);
              if (!arr) continue;
              for (let i = 0; i < arr.length; i += 4) {
                if (o.mats.indexOf(arr[i + 3]) < 0) continue;
                const idk = key + '#' + i;
                if (seen.has(idk)) continue;
                const dx = arr[i] - px, dy = arr[i + 1] - py, dz = arr[i + 2] - pz;
                if (dx * dx + dy * dy + dz * dz > R2) continue;
                seen.add(idk); hit++;
                const al0 = (arr[i] - o.w0[0]) * ux + (arr[i + 1] - o.w0[1]) * uy + (arr[i + 2] - o.w0[2]) * uz;
                const bi = Math.floor(al0 / BIN);
                if (bi >= 0 && bi < nBin) bins.add(bi);
              }
            }
          }
          /* 「首尾都有顶点」不够：下一腿的门头柱就站在这一腿的尽端，
             光靠首尾能把一条只建了 6.8 m 的假通道判成满分（负控第一版就是这么漏的）。
             所以按 8 m 分段要求**铺满**：产品的灯带是每 6 m 一道，真铺满的腿
             每段必然有顶点；只修了门口、本体空着的腿会在中段交出白卷。 */
          if (hit < 6 || bins.size < nBin * 0.7) {
            hollow++;
            if (!sample) sample = `${o.kind}@${o.station}：轴上核到 ${hit} 个顶点、${bins.size}/${nBin} 段有几何（声称 ${L.toFixed(1)} m）`;
          }
          continue;
        }
        const f = line.al.frame(o.s), c = line.al.world(f, o.lat, o.dy);
        const r2 = RAD[o.kind] * RAD[o.kind];
        let hit = 0;
        const gx = Math.floor(c[0] / CELL), gz = Math.floor(c[2] / CELL);
        for (let a = -1; a <= 1 && hit < 4; a++) for (let b = -1; b <= 1 && hit < 4; b++) {
          const arr = grid.get((gx + a) + ':' + (gz + b));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i += 4) {
            if (o.mats.indexOf(arr[i + 3]) < 0) continue;
            const dx = arr[i] - c[0], dy = arr[i + 1] - c[1], dz = arr[i + 2] - c[2];
            if (dx * dx + dy * dy + dz * dz < r2 && ++hit >= 4) break;
          }
        }
        if (hit < 4) { hollow++; if (!sample) sample = `${o.kind}@s${o.s.toFixed(0)}/横${o.lat.toFixed(2)}`; }
      }
      if (hollow) {
        fails++;
        console.log(`${def.name} FAIL: ${hollow} 件设施只有登记没有几何（如 ${sample}）—— 记录与烘焙出来的顶点脱钩`);
      }
      /* 把通道判据实际量到的东西打出来：一条"永远 0 条腿"的判据和一条没有的判据
         是同一件事，只有把数量印在日志里，下次它变成 0 才看得见。 */
      if (nLeg) console.log(`  ${def.name} 换乘通道判据：${nLeg} 条腿，通道格里 ${cVert} 个顶点`);
      /* ---- 站台外侧必须是浅色面砖，不是箱涵的深色混凝土（第 98 条）----
       * 这一条只看**材质**，不看亮度 —— 亮度随渲染管线变（环境光、自发光、
       * 曝光全都动过），材质不会。真实上海地下站站台外侧是一整面浅色面砖，
       * 而原来只有对面那侧贴了砖，站台外侧直接是 `concrete` 深色内壁，
       * 实拍平均亮度 70/255、暗部 47.7%。
       * 判据量的是"那个面上有没有浅色砖"，判据自己从站台轨道坐标里
       * 反查世界顶点 —— 站序、站台侧、箱涵半宽都取产品那一份常量。 */
      /* B 第 2 层：墙位随站型 —— 侧式 ±11.0，岛式走廊侧墙在 14.3（WALLN）。 */
      const wallAt = (ln, i) => (SH.platType(ln.stations[i]) === 'island' ? 14.3 : SH.STATION_X.boxW) * (ln.stationSide(i) || 1);
      for (const i of under.slice(0, 6)) {
        const ss = line.al.stationS[i], sd = line.stationSide(i) || 1;
        const boxW = Math.abs(wallAt(line, i));   // 转正后的墙横向（latS 按绝对横向比较）
        const fr = line.al.frame(ss);
        /* 带取 [10.4, 10.95] m：**把箱涵混凝土内壁（横向 11.0）排除在外**。
           原来取到 11.5 时那面墙的两圈顶点（dy −0.85 与 5.55）正好都落在
           门外，量到的 26 个顶点全是踢脚 —— 判据量到了别的东西。 */
        let tilesV = 0, tilesHigh = 0;
        for (const m of meshes) {
          if (m.mat !== 'tiles') continue;
          for (let k = 0; k < m.pos.length; k += 3) {
            const dx = m.pos[k] - fr.p[0], dy = m.pos[k + 1] - fr.p[1], dz = m.pos[k + 2] - fr.p[2];
            const latS = sd * (dx * fr.r[0] + dz * fr.r[2]);
            if (latS < boxW - 0.6 || latS > boxW - 0.05) continue;
            const h = dy * fr.u[1] + dx * fr.u[0] + dz * fr.u[2];
            if (h < -0.3 || h > 5.0) continue;
            if (Math.abs(dx * fr.f[0] + dz * fr.f[2]) > 60) continue;
            tilesV++; if (h > 1.0) tilesHigh++;
          }
        }
        /* 墙是**竖向扫掠**：整面只有上下两圈顶点（dy 0.0 与 4.4），
           所以"顶点够不够"这条判据量的是扫掠环数，不是面积 ——
           门槛按实测（120 m 站台 ≈ 31 环 × 2）定 40。
           踢脚是另一条扫掠，落在同一条带里，所以另要求"高于 1 m 的那圈"也在。 */
        if (tilesV < 40 || tilesHigh < 20) {
          fails++;
          console.log(`${def.name} FAIL: ${line.stations[i]} 站站台外侧那面墙（横向 ${(boxW - 0.6).toFixed(2)}~${(boxW - 0.05).toFixed(2)} m）只有 ${tilesV} 个面砖顶点、其中离地 1 m 以上 ${tilesHigh} 个 —— 站厅该是浅色面砖，不是箱涵的深色内壁`);
        }
      }
    }
    const dz = SH.train.view ? SH.train.view.DoorZs(500, line.profile) : [];
    /* 诊断也要能报红：门数=0 说明车门定位这一路根本没跑起来（不是"这条线没门"）。 */
    if (!dz.length) { fails++; console.log(`${def.name} FAIL: 500 m 里数出 0 个车门（DoorZs 或 SH.train.view 断了）`); }
    console.log(`${def.name.padEnd(7)} ${def.stations.length}站 al=${line.al.total.toFixed(0)}m  烘焙 ${verts}v/${tris.toFixed(0)}t/${meshes.length}批  ${(t2-t1).toFixed(0)}ms  车 ${(t4-t3).toFixed(0)}ms  门${dz.length}  ${isFinite(verts)?'':'BAD'}`);
  } catch (e) { fails++; console.log(`${def.name} FAIL: ${e.message}\n   ${e.stack.split('\n')[1]||''}`); }
}
/* 覆盖面本身也要钉住：16 号线 / 浦江线 / 磁浮是**全线高架化**的，
   站厅侧设施判据对它们无样本可查 —— 这是事实而不是缺陷，所以逐线只打印说明。
   但如果哪天判据在几乎所有线上都无样本（`under` 取错、站型判定坏了），
   它会变成"永远绿的空指标"，所以这里按**全线合计的站数**兜一道。 */
if (!lineFilter && facStations < 40) { fails++; console.log(`FAIL: 站厅侧设施判据只覆盖到 ${facStations} 个站（应 ≥ 40）—— 判据在绝大多数线上无样本，等于没测`); }
console.log(fails? `\n${fails} 条线路失败` : '\n全部线路烘焙通过');
console.log(`  站厅侧设施判据覆盖 ${facStations} 个站（地下 + 露天，B2b）`);

/* ======================= 站牌图集预算与唯一性 =======================
 * 全线站牌**共用一张图集**（以前 bake() 每次自起一张临时图集，牌子画进临时图集、
 * rect 也按临时图集算，而 GPU 拿到的永远是另一张 —— 于是每一块站牌都采样到图集
 * 左上角那块，全线所有车站的站牌都写着同一个站名）。
 * 共用一张就有两个必须成立的事：
 *   1. 最长的那条线的所有牌子塞得下，塞不下时 SignAtlas 会把键记进 overflowed
 *      并返回 fallback —— 宁可空牌，也不能错牌；
 *   2. 每块牌子的 rect 互不相同。
 * 尺寸从源码正则读，生产改了这里自动跟着判，不会出现"测试按老尺寸打勾"的假绿。 */
{
  const fs = require('fs');
  const src = ['src/world.js', 'src/game.js'].map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const size = {};
  for (const m of src.matchAll(/sign\.add\('(\w+):'[^\n]*?,\s*(\d+)\s*,\s*(\d+)\s*,/g)) if (!size[m[1]]) size[m[1]] = [+m[2], +m[3]];
  for (const m of src.matchAll(/sign\.add\('ad:'[^\n]*?,\s*(\d+)\s*,\s*(\d+)\s*,/g)) if (!size.ad) size.ad = [+m[1], +m[2]];
  const need = ['plate', 'big', 'ad'];
  const missing = need.filter(k => !size[k]);
  if (missing.length) { fails++; console.log('✗ 站牌尺寸未能从源码解析：' + missing.join(',') + '（改写法了？判据要一起改）'); }
  else {
    const S = SH.textures.SignAtlas.bestSize({ getParameter: () => 4096, MAX_TEXTURE_SIZE: 1 });
    let worst = null;
    for (const id of Object.keys(SH.LINES)) {
      const L = SH.LINES[id];
      const at = new SH.textures.SignAtlas(S);
      at.add('tcms', 320, 200, () => {});
      at.add('dest:' + id, 420, 96, () => {});
      L.stations.forEach((n, i) => {
        at.add('plate:' + n, size.plate[0], size.plate[1], () => {});
        at.add('big:' + n, size.big[0], size.big[1], () => {});
        at.add('ad:' + (SH.hash32(n, i) % 97), size.ad[0], size.ad[1], () => {});
        if (SH.INTER[n]) at.add('way:' + n, size.way[0], size.way[1], () => {});
      });
      const seen = new Map(); let dup = 0;
      for (const [k, r] of at.rects) {
        const key = r.join(',');
        if (seen.has(key) && seen.get(key) !== 'tcms' && seen.get(key) !== 'dest:' + id) dup++;
        else seen.set(key, k);
      }
      const rec = { name: L.name, n: L.stations.length, over: at.overflowed.length, dup };
      if (!worst || rec.n > worst.n) worst = rec;
      if (at.overflowed.length || dup) {
        fails++;
        console.log(`✗ ${L.name} 站牌图集：越界 ${at.overflowed.length} 块（${at.overflowed.slice(0, 4).join(',')}）、重号 ${dup} 块`);
      }
    }
    if (!fails && worst) console.log(`✓ 站牌图集：最长线 ${worst.name} ${worst.n} 站在 ${S}² 图集内全部放得下且互不重号`);
    /* 反向验证：图集缩到装不下时必须报越界，否则上面那条断言是摆设。 */
    const probe = new SH.textures.SignAtlas(256);
    probe.add('plate:x', size.plate[0], size.plate[1], () => {});
    probe.add('plate:y', size.plate[0], size.plate[1], () => {});
    if (!probe.overflowed.length) { fails++; console.log('✗ SignAtlas 越界保护失效：256² 里塞两块站牌没有记 overflowed'); }
  }
}
/* 重烘不许挪家具：同一段路用两个不同的烘焙窗口各烘一次（窗口边界是车动才动的），
 * 重叠区里的树与车道虚线必须逐根落在同一个里程上。
 * 以前 city() 里两个循环的起点写成窗口起点 a（虚线 a+4、树 a），
 * 于是长直段（比窗口还长、永远被钳）每次重烘整体平移几米 ——
 * 开车时路旁的树和虚线在眼前滑动，树形/缺株那种"按里程取种子"的细节也跟着变。 */
{
  const id = 'l3', def = SH.LINES[id], line = new LineRuntime(def);
  const gather = (w0, w1) => {
    const wb = new (class extends SH.WorldBuilder {})( { al: line.al, color: def.color, stations: def.stations,
      sign: new SH.textures.SignAtlas(2048), night: 0.62, profile: line.profile } );
    wb.ambient = [0.26, 0.29, 0.36]; wb.sun = { dir: [-0.5, 0.4, 0.76], col: [0.8, 0.55, 0.36] }; wb._installLight();
    /* 量**树心**而不是量顶点：'foliage' 材质同时被行道树和绿化带条带用，
       条带是扫掠面、它的顶点相位本来就跟着烘焙窗口走，拿顶点比会一片假红。
       行道树是 city() 里唯一用球体的东西，包一层 sphere 就能精确取到树心。 */
    const raw = SH.Builder.prototype.sphere, rawBox = SH.Builder.prototype.box, centres = [], dashes = [];
    SH.Builder.prototype.sphere = function (c, r, o) { if (o && o.mat === 'foliage') centres.push([c[0], c[2]]); return raw.apply(this, arguments); };
    /* 车道虚线的指纹：0.15 × 0.02 × 3.0 的扁盒，尺寸唯一，不会和建筑/标线撞上。
       比"源码里不许出现窗口起点"这种 lint 好 —— 那条会误伤 depot()（它的 a 是
       绝对里程的基地边界，不是窗口），而且它只保证写法、不保证结果。 */
    SH.Builder.prototype.box = function (c, sz, col, o) {
      if (sz && Math.abs(sz[1] - 0.02) < 1e-9 && Math.abs(sz[2] - 3.0) < 1e-9) dashes.push([c[0], c[2]]);
      return rawBox.apply(this, arguments);
    };
    SH.WorldBuilder.buildRuns(wb, line, w0, w1, null);
    SH.Builder.prototype.sphere = raw; SH.Builder.prototype.box = rawBox;
    const q = p => (Math.round(p[0] * 10) / 10) + ',' + (Math.round(p[1] * 10) / 10);
    return {
      trees: centres.filter(p => p[1] > 1160 && p[1] < 2440 && Math.abs(p[0]) < 200).map(q).sort(),
      dashes: dashes.filter(p => p[1] > 1160 && p[1] < 2440 && Math.abs(p[0]) < 60).map(q).sort(),
    };
  };
  const A = gather(1000, 2600), B = gather(1137, 2737);
  const cmp = (name, ka, kb) => {
    const sa = new Set(ka), sb = new Set(kb);
    const onlyA = [...sa].filter(v => !sb.has(v)), onlyB = [...sb].filter(v => !sa.has(v));
    if (onlyA.length + onlyB.length > 2) {
      fails++;
      console.log(`✗ 重烘挪家具：${name} 在窗口 [1000,2600] 与 [1137,2737] 下有 ${onlyA.length}/${onlyB.length} 个落点不一致` +
        `（例：${onlyA.slice(0, 2).join(' ')} vs ${onlyB.slice(0, 2).join(' ')}）—— 烘焙窗口的边界渗进了摆放相位`);
    } else console.log(`✓ 重烘不挪家具：${name} ${sa.size} 个落点在两个窗口下一一对齐（相位钉在绝对里程上）`);
  };
  cmp('行道树', A.trees, B.trees);
  cmp('车道虚线', A.dashes, B.dashes);
}

/* 司机室两只手柄必须**在绘制时**真的随级位转。
 * 以前 train.js 的注释写着"手柄本体运行时按级位画"，而代码里根本没有第二处画手柄
 * 的地方 —— 手柄被烘焙进 cab 批次一次成型，HUD 那只电子手柄动、3D 这两只钉死。
 * 所以这里量的是 draw() 交给每只手柄的矩阵，不是 leverAngle 的数值表：
 * 只有前者能证明接线在（数值表对而没人调用，正是上一版的状况）。 */
{
  const TV = eval('(' + grab('TrainView') + ')');
  const line = new LineRuntime(SH.LINES.l2);
  const rec = {
    calls: [],
    upload(meshes) { return meshes.map(m => ({ mat: m.mat, verts: m.verts })); },
    dropTag() {}, draw(b, M, ov) { this.calls.push([b, M, ov]); },
    texFromCanvas() { return {}; }, begin() {}, end() {},
  };
  const tv = new TV(rec);
  tv.setLine(line, { add: (k, w, h) => [0, 0, w, h] }, null);
  const levers = tv.levB || [];
  if (levers.length !== 2) {
    fails++; console.log(`✗ 司机室手柄批次 ${levers.length} 个（应为 2：主控 + 制动，各自成批才能独立转）`);
  } else {
    const s0 = line.al.stationS[0];
    const at = (nz, which) => {
      rec.calls.length = 0;
      tv.draw(s0, 0, { notch: nz, lamps: {} });
      const o = levers.find(x => x.which === which);
      const hit = rec.calls.filter(c => c[0] === o.b[0]);
      return hit.length ? { M: hit[hit.length - 1][1], pivot: o.pivot, M0: tv.M0 } : null;
    };
    const eq = (a, b) => !!a && !!b && a.M.every((v, i) => Math.abs(v - b.M[i]) < 1e-9);
    const errs = [];
    const mP4 = at(4, 'master'), mN = at(0, 'master'), mB6 = at(-6, 'master');
    const bP4 = at(4, 'brake'), bN = at(0, 'brake'), bB6 = at(-6, 'brake');
    if (!mP4 || !mN || !mB6 || !bP4 || !bN || !bB6) errs.push('手柄批次没有被 draw() 画出来');
    else {
      /* 双柄分工：主控只管牵引侧，制动手柄只管制动侧。
         两只都跟着同一根轴动 = 过弯时它们会互相穿进对方。 */
      if (eq(mP4, mN)) errs.push('主控手柄在 P4 与 N 之间没动 —— 级位没接到 3D 手柄');
      if (!eq(mN, mB6)) errs.push('主控手柄在制动区也跟着动 —— 两只手柄会撞在一起');
      if (!eq(bP4, bN)) errs.push('制动手柄在牵引区动了 —— 它不该管牵引');
      if (eq(bB6, bN)) errs.push('制动手柄在 B6 与 N 之间没动');
      for (const [tag, o, nz] of [['master', mP4, 4], ['brake', bB6, -6]]) {
        const want = SH.m4mul(o.M0, SH.m4trs(o.pivot, [1, 1, 1], 0, SH.leverAngle(tag, nz), 0));
        if (!o.M.every((v, i) => Math.abs(v - want[i]) < 1e-9))
          errs.push(`${tag} 手柄的矩阵不是 车体矩阵·平移到铰点·绕局部x转 leverAngle() —— 转的基准或铰点不对`);
      }
      /* 几何必须以**铰点**为原点：否则"转"是绕车中心甩，手柄会插进台面。
         finish() 返回的是分片后的**数组**，包围盒要跨片合并。 */
      for (const o of tv.tv.levers) {
        let ylo = 1e9, yhi = -1e9, xhi = 0, zhi = 0, n = 0;
        for (const m of [].concat(o.mesh)) {
          for (let i = 0; i < m.pos.length; i += 3) {
            ylo = Math.min(ylo, m.pos[i + 1]); yhi = Math.max(yhi, m.pos[i + 1]);
            xhi = Math.max(xhi, Math.abs(m.pos[i])); zhi = Math.max(zhi, Math.abs(m.pos[i + 2])); n++;
          }
        }
        if (!n) { errs.push(`${o.which} 手柄没有顶点`); continue; }
        if (ylo < -0.05 || yhi > 0.5 || xhi > 0.2 || zhi > 0.35)
          errs.push(`${o.which} 手柄几何不是绕铰点建的（局部包围盒 x±${xhi.toFixed(2)} y ${ylo.toFixed(2)}~${yhi.toFixed(2)} z±${zhi.toFixed(2)}）`);
      }
    }
    if (errs.length) { fails++; console.log('✗ 司机室手柄：' + errs.join('；')); }
    else console.log('✓ 司机室手柄：两只各自成批、随级位分区转动（主控管牵引、制动手柄管制动），矩阵 = 车体·铰点平移·leverAngle 转角');
    /* ---- 指示灯：cab 里最后一处静态摆件 ----
     * 以前那五行写在 buildCabInterior 里，`emi: i === 3 ? 0.12 : 1.5` ——
     * 亮灭是**写死的数组**，与车门/牵引/制动/ATO 无关，面板在说"一切正常"
     * 而它什么都没看。量两层：状态推导（`SH.cabLampState` 的真值表）
     * 与绘制接线（每盏灯拿到的 `{emi:}` 覆盖确实是按灯给的）。 */
    const lampB = tv.lampB || [];
    const lerrs = [];
    if (lampB.length !== 5) lerrs.push(`指示灯单独成批 ${lampB.length} 盏（应为 5：车门/牵引/制动/ATO/紧急）`);
    else {
      const S = (o) => SH.cabLampState(Object.assign({ mode: 'manual', phase: 'running' }, o));
      const run = S({ tr: { doors: false, notch: 3, trac: 0.8, brk: 0, eb: false, atp: 0 } });
      const brk = S({ tr: { doors: false, notch: -5, trac: 0, brk: 0.7, eb: false, atp: 0 } });
      const odo = S({ tr: { doors: true, notch: 0, trac: 0, brk: 0, eb: false, atp: 0 } });
      const eb = S({ tr: { doors: false, notch: -9, trac: 0, brk: 1.2, eb: true, atp: 2 } });
      const auto = S({ mode: 'auto', tr: { doors: false, notch: 2, trac: 0.5, brk: 0, eb: false, atp: 0 } });
      const want = [
        ['牵引中：trac 亮 / 制动与门与紧急灭', run, { trac: 1, brk: 0, doors: 0, eb: 0, ato: 0 }],
        ['常用制动：brk 亮、trac 灭', brk, { brk: 1, trac: 0, eb: 0 }],
        ['开门：doors 亮、牵引必须灭（开门牵引用不了）', odo, { doors: 1, trac: 0, brk: 0 }],
        ['紧急制动：eb 亮', eb, { eb: 1, brk: 1 }],
        ['ATO 接管：ato 亮', auto, { ato: 1, trac: 1 }],
      ];
      for (const [tag, got, exp] of want)
        for (const k of Object.keys(exp))
          if (!!got[k] !== !!exp[k]) lerrs.push(`${tag} —— ${k} 灯实际 ${got[k] ? '亮' : '灭'}`);
      const emiOf = (lamps) => {
        rec.calls.length = 0;
        tv.draw(s0, 0, { notch: 0, lamps });
        const m = {};
        for (const o of lampB) {
          const hit = rec.calls.filter(c => c[0] === o.b[0]);
          m[o.key] = hit.length ? ((hit[hit.length - 1][2] || {}).emi) : null;
        }
        return m;
      };
      const allOn = emiOf({ doors: 1, trac: 1, brk: 1, ato: 1, eb: 1 });
      const allOff = emiOf({});
      for (const o of lampB) {
        if (allOn[o.key] !== SH.train.LAMP_ON) lerrs.push(`${o.key} 灯亮档拿到 ${allOn[o.key]}（应为 SH.train.LAMP_ON）`);
        if (allOff[o.key] !== SH.train.LAMP_OFF) lerrs.push(`${o.key} 灯灭档拿到 ${allOff[o.key]}（应为 SH.train.LAMP_OFF）`);
      }
      if (SH.train.LAMP_ON <= SH.train.LAMP_OFF * 4)
        lerrs.push(`亮/灭两档只差 ${(SH.train.LAMP_ON / SH.train.LAMP_OFF).toFixed(1)} 倍（应 ≥4 倍）—— 玩家看不出灯有没有亮`);
    }
    if (lerrs.length) { fails++; console.log('✗ 司机室指示灯：' + lerrs.slice(0, 5).join('；') + (lerrs.length > 5 ? ` 等 ${lerrs.length} 条` : '')); }
    else console.log('✓ 司机室指示灯：5 盏各自成批，亮灭由 SH.cabLampState 从车门/牵引/制动/ATO/紧急推导，绘制时按批次覆盖 emi');
  }
}

/* 车尾不许是洞。`closed:true` 说的是**截面**闭合（管子是圆的），不是管子两端封口；
 * 头车前端故意不封（封了司机会看见自己车的墙），但尾端以前跟着一起不封 ——
 * 磁浮追尾机位实拍里，最后一节车的端面是一块能看穿的黑洞，而 12 个判据一个都不红：
 * 只有尾端那一个面在 chase/headon 之外根本看不见。
 * 所以这条判据**与机位无关**：数在 -headLen/2 处、法向朝后的三角形片数，
 * 同时断言鼻端仍然没有这种封闭面。 */
{
  const errs = [];
  for (const id of Object.keys(SH.LINES)) {
    const def = SH.LINES[id];
    const p = new LineRuntime(def).profile;
    const head = new SH.train.TrainView(p, {}).head;
    const HN = p.headLen / 2;
    let rear = 0, nose = 0;
    for (const m of [].concat(head.body)) {
      for (let i = 0; i + 2 < m.idx.length; i += 3) {
        const v0 = m.idx[i] * 3;
        const nz = m.nrm[v0 + 2];
        if (Math.abs(nz) < 0.9) continue;
        const zc = (m.pos[m.idx[i] * 3 + 2] + m.pos[m.idx[i + 1] * 3 + 2] + m.pos[m.idx[i + 2] * 3 + 2]) / 3;
        if (Math.abs(zc + HN) < 0.06 && nz < 0) rear++;
        else if (Math.abs(zc - HN) < 0.06 && nz > 0) nose++;
      }
    }
    if (rear < 8) errs.push(`${def.name} 尾端只有 ${rear} 片朝后的面（封一个圆角端面至少要 8 片）—— 车尾是个洞`);
    if (nose > 0) errs.push(`${def.name} 鼻端出现 ${nose} 片朝前的封闭面 —— 司机又会看见自己车的墙`);
  }
  if (errs.length) { fails++; console.log('✗ 车体端面：' + errs.join('；')); }
  else console.log('✓ 车体端面：20 条线头车尾端全部封顶、鼻端全部保持开放（"看不见的那个面"也要有判据）');
}

/* 司机室内饰必须自己带一套人工光。
 * 内饰是 buildCabInterior 直接产出的烘焙几何，不进世界的光照网格，
 * 所以以前没有任何一盏灯算到它头上：地下段天光 0.085，玩家默认视角里
 * 台面/侧墙/他正握着的那两只手柄是一团剪影。
 * 量的是**网格上的自发光通道**（着色器 `lit += base*emi*uEmiBoost`，加算，
 * 隧道 emiBoost 2.05）：覆盖率、手柄处亮度、以及不许洗成白板的封顶。 */
{
  const errs = [];
  let worstCover = 1, worstCoverAt = '', worstLever = 1, worstLeverAt = '', mx = 0, mxAt = '', worstClip = 0, worstClipAt = '';
  for (const id of Object.keys(SH.LINES)) {
    const p = new LineRuntime(SH.LINES[id]).profile;
    const tv = new SH.train.TrainView(p, {});
    const leverMeshes = tv.levers.map(o => [].concat(o.mesh)).flat();
    let n = 0, lit = 0, cn = 0, clip = 0;
    let ln = 0, lsum = 0;
    /* `_packRaw` 把 emi 存成 Uint8（0..2.5 折到 0..255），读回来要乘回去 ——
       第一版直接当浮点用，量到"峰值 202"这种荒唐数。
       统计范围限定在**司机的工作区**（车头往后 5 m）：诊断显示"暗"的顶点
       全部集中在 z = −HN+1.2 的客室通道门上，那是司机**背后**的隔墙，
       默认视角根本看不见它，把它算进"司机室是剪影"这条判据是量错了对象。 */
    const zMin = p.headLen / 2 - 5.0;
    /* 两个数各量各的样本，别搅在一起：
       覆盖率 = 司机工作区里的**内饰**顶点；手柄亮度 = **手柄**顶点。
       第一版把两批顶点合并算覆盖率，手柄球面的下侧（本来就照不到灯）
       把 100% 的内饰拉成 75%，看着像"内饰没灯"。 */
    for (const m of [].concat(tv.cab)) {
      for (let i = 0; i < m.verts; i++) {
        if (m.pos[i * 3 + 2] < zMin) continue;
        const e = m.emi[i] / 255 * 2.5;
        n++; if (e >= 0.12) lit++;
        /* 防晃眼要量**加算进画面的亮度**，不是自发光系数本身：
           着色器是 `lit += base * emi * uEmiBoost`，深灰台面 (base≈0.11) 拿到 emi 1.28
           只加 0.29，离过曝还远；反过来一块饱和红色的仪表指针 emi 1.28 就直接削白。
           只看 emi 会同时冤枉前者、放过后者。
           再一个要点：**过曝的面积**才是"晃眼"，不是过曝的峰值 ——
           一根 2 cm 的红色指针削白没人看得见，一整片台面糊白才是事故。
           灯具四周那一圈顶板本来就该最亮，所以只查司机视线里的壳。 */
        const lamp = m.mat === 'light' || m.mat === 'emissive';
        const base = Math.max(m.col[i * 3], m.col[i * 3 + 1], m.col[i * 3 + 2]) / 255 * 2;
        const add = base * e * 2.05;                       // 隧道 emiBoost
        if (!lamp && m.pos[i * 3 + 1] < p.roofY - 0.25) {
          cn++; if (add > 1.0) clip++;
          if (add > mx) { mx = add; mxAt = SH.LINES[id].name + '/' + m.mat; }
        }
      }
    }
    for (const m of leverMeshes) {
      for (let i = 0; i < m.verts; i++) { ln++; lsum += m.emi[i] / 255 * 2.5; }
    }
    const cover = n ? lit / n : 0, lever = ln ? lsum / ln : 0, clipF = cn ? clip / cn : 0;
    const name = SH.LINES[id].name;
    if (cover < worstCover) { worstCover = cover; worstCoverAt = name; }
    if (lever < worstLever) { worstLever = lever; worstLeverAt = name; }
    if (clipF > worstClip) { worstClip = clipF; worstClipAt = name; }
    if (cover < 0.90) errs.push(`${name} 内饰只有 ${(100 * cover).toFixed(0)}% 的顶点拿到人工光（应 ≥90%）—— 大部分司机室仍是剪影`);
    if (lever < 0.15) errs.push(`${name} 手柄平均自发光 ${lever.toFixed(2)}（应 ≥0.15）—— 玩家操作的那两只杆还是黑的`);
    if (clipF > 0.08) errs.push(`${name} 司机室壳上有 ${(100 * clipF).toFixed(0)}% 的顶点加算亮度超过 1.0（应 ≤8%）—— 大片过曝，司机会被自己的台面晃瞎`);
  }
  if (errs.length) { fails++; console.log('✗ 司机室照明：' + errs.slice(0, 4).join('；') + (errs.length > 4 ? ` 等 ${errs.length} 条` : '')); }
  else console.log(`✓ 司机室照明：20 条线内饰顶点覆盖率最低 ${(100 * worstCover).toFixed(0)}%（${worstCoverAt}）、手柄平均自发光 ${worstLever.toFixed(2)}（${worstLeverAt}）、过曝面积最大 ${(100 * worstClip).toFixed(1)}%（${worstClipAt}，峰值 ${mx.toFixed(2)} 在 ${mxAt}）`);
}

/* 对向站台的候乘人群（诚实清单 §7.2）：真烘焙 + 真客流模型的**顶点级对账**。
 * buildRuns 以 Flow 为 pax 传入后，对面站台上必须有按对向候乘比例的人群：
 * 人数 = waitingOpp/3.4（与 crowdInto 同一分母），量"人群带"（paint 材质、
 * up 0.9~2.3、side 转正后对向侧 lat 2.3~6.5 —— 站台板 0.42、黄线 0.44、
 * 门头梁 2.4+ 都落不进这个带，paint 顶点只来自人）里的顶点数。
 * test-pax 已经验过 crowdStationFar 的位置与对向候乘桶，这里补的是烘焙路径：
 * farPlatform 真的把对向候乘烘进**静态世界批次**（运行时重建不碰它，
 * 烘进 crowdB 会在第一次重建时整批消失）。 */
{
  const errs = [];
  const defB = SH.LINES.l2;
  const lineB = new LineRuntime(defB);
  /* **两种站型各挑一座代表站**：
     · 侧式站 —— `farPlatform`（对向站台板 + 对向候乘）只存在于侧式站上；
     · 地下岛式站 —— 岛式站没有对向站台，对向候乘烘在**岛的对向缘**。
     第 1 层把全部地下站判成岛式之后，"第一座地下站"就是岛式站，只挑它会让
     侧式那条分支（farPlatform 的顶点级对账）变成空转 —— 负控 `farpcrowd`
     就是这么哑掉的。两种各量一遍，两条分支都活着。 */
  const picks = [];
  for (let i = 0; i < lineB.stations.length; i++) {
    const s = lineB.al.stationS[i];
    if (lineB.depotAtS(s)) continue;
    const t = SH.platType(lineB.stations[i]);
    if (t === 'side' && !picks.some(p => p.t === 'side')) picks.push({ i, t });
    if (t === 'island' && !lineB.isElevated(s) && !picks.some(p => p.t === 'island')) picks.push({ i, t });
  }
  if (!picks.length) errs.push('l2 找不到侧式站 / 岛式站（对向人群无处可量）');
  for (const pk of picks) {
    const uiB = pk.i, isIsland = pk.t === 'island';
    const stB = SH.STOCK && SH.STOCK[defB.stock];
    const flowB = new SH.pax.Flow({ id: 'l2', stations: lineB.stations },
      { cars: stB ? stB.cars : 6, doors: stB ? stB.doors : 4, width: stB ? stB.width : 3.0, type: defB.stock }, 8);
    const signB = new SH.textures.SignAtlas(2048);
    const wbB = new (class extends SH.WorldBuilder {})( { al: lineB.al, color: defB.color, stations: defB.stations, sign: signB, night: 0.62, profile: lineB.profile } );
    wbB.sun = null; wbB._installLight();
    const ssB = lineB.al.stationS[uiB];
    SH.WorldBuilder.buildRuns(wbB, lineB, Math.max(0, ssB - 170), Math.min(lineB.al.total, ssB + 60), flowB);
    const waitingOpp = flowB.waitingAt(lineB.stations[uiB], uiB, -1);
    const people = Math.min(240, Math.round(waitingOpp / 3.4));
    const fB = lineB.al.frame(ssB), cB = fB.p, sideB = lineB.stationSide(uiB);
    /* 对向候乘的横向带 = 对向站台板那一段（基准读 `SH.farFrontOf(oppLatAt)`，
       与烘焙同一份 —— B 阶段口径后岛式站的对向板跟着加宽的股道搬出去了，
       这里硬写 −TRACK_OFFSET 就只量得到侧式站）。 */
    const FAR0 = SH.farFrontOf(SH.oppLatAt(lineB, ssB)), FARW = SH.STATION_X.width;
    let cnt = 0;
    for (const [mat, bk] of wbB.b.buckets) {
      if (mat !== 'paint') continue;
      for (let i = 0; i < bk.pos.length; i += 3) {
        const d = [bk.pos[i] - cB[0], bk.pos[i + 1] - cB[1], bk.pos[i + 2] - cB[2]];
        if (Math.abs(d[0] * fB.f[0] + d[1] * fB.f[1] + d[2] * fB.f[2]) > 170) continue;
        const lat = (d[0] * fB.r[0] + d[1] * fB.r[1] + d[2] * fB.r[2]) * sideB;
        const up = d[0] * fB.u[0] + d[1] * fB.u[1] + d[2] * fB.u[2];
        if (up > 0.9 && up < 2.3 && lat < -(FAR0 + 0.4) && lat > -(FAR0 + FARW + 0.6)) cnt++;
      }
    }
    if (isIsland) {
      /* B 第 3 层：判据按站型分叉，**一条断言两头钉** ——
         ① 老那条"对向板那一带"（−18.6~−14.6）必须**空**：岛式站没有对向站台，
            farPlatform 没随岛式关闭就会在这里留下人群；
         ② **岛的对向缘**（横向 = 岛中线外 0.2 m ~ 远缘内 0.55 m，即 −9.50~−6.25）
            必须有对向候乘 —— 人数与 `waitingOpp` 同源（÷3.4，与 crowdInto 同一分母）。
         两条缺一不可：只查 ① 会把"对向候乘整批没了"读成通过（第 2 层就是这个状态），
         只查 ② 会把"farPlatform 又铺了一条侧式站台"读成通过。 */
      const XB = SH.STATION_X;
      const FAR_A = XB.front + SH.ISLAND_W / 2 + 0.2, FAR_B = XB.front + SH.ISLAND_W - 0.55;
      let onIsl = 0, onCorr = 0;
      for (const [mat, bk] of wbB.b.buckets) {
        if (mat !== 'paint') continue;
        for (let i = 0; i < bk.pos.length; i += 3) {
          const d = [bk.pos[i] - cB[0], bk.pos[i + 1] - cB[1], bk.pos[i + 2] - cB[2]];
          if (Math.abs(d[0] * fB.f[0] + d[1] * fB.f[1] + d[2] * fB.f[2]) > 170) continue;
          const lat = (d[0] * fB.r[0] + d[1] * fB.r[1] + d[2] * fB.r[2]) * sideB;
          const up = d[0] * fB.u[0] + d[1] * fB.u[1] + d[2] * fB.u[2];
          if (up > 0.9 && up < 2.3 && lat < -FAR_A && lat > -FAR_B) onIsl++;
          /* 本侧候乘的**侧别**：岛式站在 board 那侧，走廊侧（lat 2~8、站台标高带）
             不该有站台候乘 —— 烘焙路径若还读 `side`，人整批站在正线对面的走廊里，
             而运行时重建读 `board`，开门那一刻人会原地跳到岛上。 */
          if (up > 0.9 && up < 2.3 && lat > 2.0 && lat < 8.0) onCorr++;
        }
      }
      if (cnt > 0) errs.push(`${lineB.stations[uiB]} 是岛式站，对向站台那一带却烘出了 ${cnt} 个候乘顶点 —— farPlatform 没随岛式关闭`);
      else if (onCorr > 200) errs.push(`${lineB.stations[uiB]} 是岛式站，本侧候乘却烘在走廊侧（lat 2~8 有 ${onCorr} 个 paint 顶点）—— 烘焙路径没读 board，开门时人会跳到岛上`);
      else if (onIsl < people * 8) errs.push(`${lineB.stations[uiB]} 是岛式站，岛的对向缘只有 ${onIsl} 个候乘顶点（候乘 ${waitingOpp} → ${people} 人，应为 ≥${people * 8}）—— 对向候乘没分到岛缘`);
      else console.log(`  岛式站：对向站台无人 ✓、对向候乘 ${onIsl} 顶点在岛的对向缘（候乘 ${waitingOpp} → ${people} 人）、走廊侧无本侧候乘 ✓`);
    } else if (cnt < people * 8) errs.push(`${lineB.stations[uiB]} 对向候乘人群顶点 ${cnt}，按候乘 ${waitingOpp} 人（→ ${people} 人 × 人均 ≥8 顶点）应为 ≥${people * 8} —— farPlatform 没把对向人群烘进静态批次`);
    else console.log(`  对向人群顶点 ${cnt}（候乘 ${waitingOpp} → ${people} 人）`);
  }
  if (errs.length) { fails++; console.log('✗ 对向站台人群：' + errs.join('；')); }
  else console.log('✓ 对向站台人群：地下站对向候乘按客流模型烘进静态世界批次（farPlatform，运行时重建不碰）');
}

process.exitCode = fails ? 1 : 0;
