/**
 * 观景机位"画面里到底是什么"——软件光栅化器。
 *
 * 为什么要有这个文件：跨江机位拍出来看不见江，前后调了水色、alpha、堤岸、
 * 河道弯曲，全部失败——因为**没有任何判据能回答"水占了几个像素"**。
 * 原来的构图检查拿地标包围盒的 8 个角投到屏幕上，取 max(宽,高)/2 当占比。
 * 对一条 2400 m 长、6 m 高的扁平水面，这个数永远是 100%（横向铺满画面），
 * 于是"江面只占最下面一条"的废镜头一直全绿。
 *
 * 这里改成真的算一遍：把整段世界的三角形按观景相机投影，做背面剔除
 * （规则与 GL 一致：绕序给出的几何法向朝向相机才可见）、近裁剪、
 * 透视正确的 1/w 深度插值，写进一张 240×135 的 z-buffer，
 * 最后统计**每个材质占了多少比例的像素**。
 * 这就是"画面上有没有它"的机器判据，不再靠肉眼试。
 *
 * 判据：
 *   · 跨江/跨河/滨水地标的**水面像素占比**必须 ≥ WATER_MIN，否则机位作废。
 *   · 地标自身的主体材质必须 ≥ HERO_MIN（防止"框住了 100% 却是一根火柴棍"）。
 *   · 天空占比必须在 [SKY_MIN, SKY_MAX]：整屏朝天或整屏朝地都是废构图。
 *
 * 用法：node test-shot.js [线路id,...]
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark', 'game']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
const VIEWSPOTS = SH.VIEWSPOTS, SHOT = SH.SHOT, LineRuntime = SH.LineRuntime, MATERIALS = SH.MATERIALS;
const C = SH.clamp;
if (!VIEWSPOTS || !SHOT || !LineRuntime) { console.log('✗ game.js 未导出 VIEWSPOTS / SHOT / LineRuntime'); process.exit(1); }

const W = 240, H = 135, ASPECT = W / H;
const NEAR = 0.6;
/* 水面占比下限按"水在不在脚下"分档：跨江/跨河是从桥上正对着 620 m 江面看，
   拍不到水就是机位废了；湖和港区的主体还有别的（环湖路、堆场、岸桥），
   江面本身也在 1 km 开外，所以门槛按实测能达到的水平给，不硬凑。 */
const WATER_MIN = { crossing: 0.16, creek: 0.16, river: 0.16, lake: 0.12, port: 0.03 };
const HERO_MIN = 0.03, SKY_MIN = 0.10, SKY_MAX = 0.62;
/** 沿街楼群外缘 88.8 m（SH.CITY_BAND.outside），地标再往里就要和它们穿插 */
const LAT_MIN = 100;
/** 近景遮挡占画面的上限。
    两条判据一起用，是因为单看绝对值分不开"好图"与"堵死的图"：
      · `clutter > 12%` —— 绝对上限；
      · `主体 < 10% 且遮挡 > 10%` —— 前景比主体还吃画面。
    反向验证：`SHOT_TUNE='bund.h=26'`（把外滩机位从 96 m 降到 26 m，掉进街谷）
    实测遮挡 11.7%、主体 7.0% —— 绝对值差 0.3 个点放不倒它，
    第二条判据放倒 ✓；而淀山湖（遮挡 10.5% / 主体 18.7%）、跨江
    （7.6% / 9.5%）、上赛场（9.5% / 4.3%）这些正常构图都不误伤。 */
const CLUTTER_MAX = 0.12;
const CLUTTER_VS_HERO = [0.10, 0.10];     // [主体下限, 遮挡下限]
/** 铺地类材质：它们是"地"，不是"挡"。算进边缘遮挡会把每个机位都判成废镜头。
    rubber 是烘焙的落地投影（平面阴影），它当然也贴在地上。 */
const GROUND_MATS = { aerial: 1, asphalt: 1, foliage: 1, ballast: 1, light: 1, rubber: 1 };
/** 水面/主体材质：主体按地标类型给，因为"桥"是钢塔、"城堡"是砖、"港区"是彩色集装箱 */
const WATER_MATS = { water: 1 };
const HERO = {
  crossing: { steel: 1, concrete: 1 }, bridge: { steel: 1, concrete: 1 },
  /* 苏州河的主体是"河岸城市立面"：驳岸（granite/concrete）、滨河路、
     以及 `creek()` 特意排在两岸的沿江住宅（bldgWin*），还有下游那座公路桥
     （steel）。以前只算 steel+concrete，量出来 3.0% 正好卡在判据线上 ——
     那是判据漏项，不是构图问题：改成"沿河看"实测更差（水面 23.8%→16.0%、
     主体 3.0%→1.4%），已回退，见 game.js SHOT.creek 的注释。 */
  creek: { steel: 1, concrete: 1, granite: 1, bldgWin: 1, bldgWin2: 1, bldgWin3: 1 },
  river: { water: 1, granite: 1, concrete: 1 }, lake: { water: 1 },
  port: { paint: 1, steel: 1 }, lujiazui: { glass: 1, bldgWin: 1, bldgWin2: 1, bldgWin3: 1 },
  /* 天际线是三档窗格贴图混排的，只算 bldgWin 会把主体低报三倍 */
  skyline: { bldgWin: 1, bldgWin2: 1, bldgWin3: 1 },
  /* 外滩是石砌的万国建筑群，主体材质是 brick/paint，不是窗格楼 */
  bund: { brick: 1, paint: 1 }, disney: { brick: 1, paint: 1 }, disney: { brick: 1, paint: 1 },
  airport: { bldgWin2: 1, metal: 1 }, stadium: { concrete: 1, metal: 1 },
  expo: { paint: 1 }, circuit: { concrete: 1 }, zoo: { foliage: 1 },
};

let fail = 0;
const bad = m => { fail++; console.log('  ✗ ' + m); };

/* 现场调参：`SHOT_TUNE='bund.h=26,creek.h=40'` 直接覆盖构图表。
   两个用途：调构图时不用改文件；以及**验证判据本身有没有牙**——
   把已知是废镜头的参数喂进去，测试必须报红，否则那条断言是摆设。 */
(process.env.SHOT_TUNE || '').split(',').forEach(kv => {
  const m = kv.match(/^\s*(\w+)\.(\w+)\s*=\s*(-?[\d.]+)\s*$/); if (!m) return;
  if (!SHOT[m[1]]) { console.log('  调参忽略：没有构图 ' + m[1]); return; }
  SHOT[m[1]][m[2]] = parseFloat(m[3]);
  console.log('  调参 ' + m[1] + '.' + m[2] + ' := ' + m[3]);
});

/* ============================================================== 烘焙一段世界 */
function bakeWindow(line, id, s0, s1) {
  const al = line.al;
  s0 = Math.max(0, s0); s1 = Math.min(al.total, s1);
  const wb = new SH.WorldBuilder({
    al, color: line.color, color2: line.color2, stations: line.stations,
    sign: new SH.textures.SignAtlas(2048), night: 0.62, profile: line.profile,
    waterRanges: line.waterRanges(),
    sightClear: SH.sightCorridors(line),
  });
  wb.sun = null; wb._installLight();
  const b = wb.b;
  const placed = [];
  for (const sp of (VIEWSPOTS[id] || [])) {
    const ss = line.stationSAt(sp.i);
    if (ss == null || ss < s0 - 40 || ss > s1 + 40 || !line.isElevated(ss)) continue;
    const rec = SH.landmarks.place(b, al, ss, sp.side == null ? 1 : sp.side, sp.dist == null ? 900 : sp.dist, sp.kind);
    if (rec) placed.push(Object.assign({}, rec, { name: sp.kind }));
  }
  /* 与 game.js bake() 同一顺序：先摆地标，再按地标占位挖出远景盒体城市 */
  for (const lm of placed) if (lm.bbox) wb.noBuild.push({
    x0: lm.bbox.min[0], x1: lm.bbox.max[0], z0: lm.bbox.min[2], z1: lm.bbox.max[2] });
  /* 几何序列只有一份实现。这里原来是第五份复刻的分类器（自己判 station/viaduct/tunnel
     再逐个 wb.xxx），而且它调 `wb.station(...)` 时**没传 open、没传站名与编号** ——
     于是这个测试里的露天站永远没有雨棚、站牌是空白，街面机位量到的不是产品。 */
  SH.WorldBuilder.buildRuns(wb, line, s0, s1, null);
  wb.farCity(s0, s1);
  /* 站台倒计时屏是**单独成批**的（不进 wb.b，因为它要按秒换实时贴图）。
     光栅化要把它算进去，否则站台机位画面里那块屏是空的 ——
     判据会去量"屏占了多少像素"，而屏根本没进场景。 */
  const meshes = b.finish();
  for (const o of (wb.ptdBatches || [])) meshes.push(...o.mesh);
  return { meshes, placed, wb };
}

/* ============================================================ 相机与投影 */
function makeCam(eye, target, fov, up) {
  let z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  const zl = Math.hypot(z[0], z[1], z[2]) || 1; z = [z[0] / zl, z[1] / zl, z[2] / zl];
  let x, y;
  if (up) {
    /* 驾驶室机位的"上"是**带着超高倾斜的车体上方向**，不是世界铅垂。
       按世界 up 算会把整幅画面滚掉一个超高角，量到的就不是产品看到的东西。 */
    x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1; x = [x[0] / xl, x[1] / xl, x[2] / xl];
  } else {
    x = [z[2], 0, -z[0]];                       // = norm(cross(worldUp, z))
    const xl = Math.hypot(x[0], x[2]) || 1; x = [x[0] / xl, 0, x[2] / xl];
  }
  y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { eye, z, x, y, tan: Math.tan(fov * Math.PI / 360) };
}

/** 观景机位：直接调 game.js 里那一份实现（SH.scenicShot），测试不再自己抄，
    否则游戏改了构图规则、测试还在按老规则打勾。列车冻结在地标里程 = 截图工况。 */
function shotCam(line, lm) {
  const q = SH.scenicShot(line, lm, lm.s, 0);
  if (!q) return null;
  return { cam: makeCam(q.eye, q.look, q.fov), eye: q.eye, look: q.look, sh: q.sh, h: q.h };
}

/* ============================================================== 光栅化 */
function render(cam, meshes, groundY, groundC, edgeLimit) {
  const zb = new Float64Array(W * H).fill(Infinity);
  const mb = new Int16Array(W * H).fill(-1);
  const names = []; const indexOf = new Map();
  let nearClip = 0, culled = 0;  /* 逐材质漏斗：三角形有多少个 → 死在哪一步（背面/近裁剪/出画）→ 最后赢下多少像素。
     "水占 0%"这种结论必须能当场分清是**没画**还是**被挡**，否则又只能靠猜。 */
  const stat = new Map();
  const S = k => { let s = stat.get(k); if (!s) stat.set(k, s = { tris: 0, back: 0, near: 0, off: 0, pix: 0 }); s.tris++; return s; };
  for (const g of meshes) {
    const m = MATERIALS[g.mat] || {};
    const noCull = !!(m.cullOff || m.blend);
    let gi = indexOf.get(g.mat);
    if (gi == null) { gi = names.length; names.push(g.mat); indexOf.set(g.mat, gi); }
    const P = g.pos, X = g.idx;
    if (process.env.SHOT_TRIS === g.mat) {
      let a0 = [1e9, 1e9, 1e9], a1 = [-1e9, -1e9, -1e9];
      for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; c++) { a0[c] = Math.min(a0[c], P[i + c]); a1[c] = Math.max(a1[c], P[i + c]); }
      console.log(`      mesh ${g.mat} verts ${g.verts} tris ${X.length / 3} bbox (${a0.map(v => v.toFixed(0)).join(',')}) .. (${a1.map(v => v.toFixed(0)).join(',')})`);
    }
    for (let t = 0; t + 2 < X.length; t += 3) {
      const a = X[t] * 3, b = X[t + 1] * 3, c = X[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const bx = P[b], by = P[b + 1], bz = P[b + 2];
      const cx = P[c], cy = P[c + 1], cz = P[c + 2];
      /* 几何法向（右手定则，与 test-wind.js 同一约定）：朝向相机才看得见 */
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const cenx = (ax + bx + cx) / 3, ceny = (ay + by + cy) / 3, cenz = (az + bz + cz) / 3;
      const facing = nx * (cam.eye[0] - cenx) + ny * (cam.eye[1] - ceny) + nz * (cam.eye[2] - cenz);
      const area3 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
      if (area3 < 1e-6) continue;                              // 退化三角形
      const st = S(g.mat);
      if (!noCull && facing <= 0) { st.back++; culled++; continue; }
      /* 近平面裁剪必须**真的裁**，不能"有一个顶点在后面就丢掉整个三角形"。
         水面就是反例：每一块水四边形沿轨道方向横跨整条 620 m 江面，
         而相机就在江面上方——按老写法它所有顶点里总有一个在身后，
         于是 156 个水三角形被砍掉 148 个，测出来"水面占 0 像素"，
         而这不过是测试自己的 bug。裁剪后多边形最多 4 个顶点，扇形再切一次。 */
      const vp = [];                                   // {vx, vy, w}
      for (let i = 0; i < 3; i++) {
        const vx = i === 0 ? ax : i === 1 ? bx : cx;
        const vy = i === 0 ? ay : i === 1 ? by : cy;
        const vz = i === 0 ? az : i === 1 ? bz : cz;
        const dx = vx - cam.eye[0], dy = vy - cam.eye[1], dz = vz - cam.eye[2];
        vp.push({ x: dx * cam.x[0] + dy * cam.x[1] + dz * cam.x[2],
          y: dx * cam.y[0] + dy * cam.y[1] + dz * cam.y[2],
          w: -(dx * cam.z[0] + dy * cam.z[1] + dz * cam.z[2]) });
      }
      let poly = vp, clipped = false;
      if (process.env.SHOT_TRIS && g.mat === process.env.SHOT_TRIS && (st.tot2 = (st.tot2 || 0) + 1) <= 4) {
        console.log(`      ${g.mat} tri#${st.tot2} world (${ax.toFixed(0)},${ay.toFixed(0)},${az.toFixed(0)}) (${bx.toFixed(0)},${by.toFixed(0)},${bz.toFixed(0)}) (${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)})`);
        console.log(`        w ${vp.map(q => q.w.toFixed(1)).join(' / ')}  px ${''}${vp.map(q => ((q.x / Math.max(q.w, 1e-6)) / (cam.tan * ASPECT) * 0.5 + 0.5) * W | 0).join(' / ')}`);
      }
      const outp = [];
      for (let i = 0; i < poly.length; i++) {
        const A = poly[i], B = poly[(i + 1) % poly.length];
        const ain = A.w >= NEAR, bin = B.w >= NEAR;
        if (ain) outp.push(A);
        if (ain !== bin) {
          const t = (NEAR - A.w) / (B.w - A.w);
          outp.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, w: NEAR });
          clipped = true;
        }
      }
      poly = outp;
      if (poly.length < 3) { st.near++; nearClip++; continue; }
      if (clipped) st.clip = (st.clip || 0) + 1;
      const PP = [];
      for (const q of poly) {
        const iv = 1 / q.w;
        /* 屏幕坐标 y 轴向下，NDC y 轴向上 —— 少这个负号会把整张画面上下颠倒。
           占比统计和左右边缘判据看不出问题（它们与朝向无关），但字符地图
           一打出来就是反的：水面跑到天上、天际线挂在下面。 */
        PP.push([(q.x * iv / (cam.tan * ASPECT) * 0.5 + 0.5) * W,
          (0.5 - q.y * iv / cam.tan * 0.5) * H, iv]);
        st.bx0 = Math.min(st.bx0 === undefined ? 1e9 : st.bx0, PP[PP.length - 1][0]);
        st.bx1 = Math.max(st.bx1 === undefined ? -1e9 : st.bx1, PP[PP.length - 1][0]);
        st.by0 = Math.min(st.by0 === undefined ? 1e9 : st.by0, PP[PP.length - 1][1]);
        st.by1 = Math.max(st.by1 === undefined ? -1e9 : st.by1, PP[PP.length - 1][1]);
      }
      let anyOn = false;
      for (let i = 1; i + 1 < PP.length; i++) {
        const x0 = PP[0][0], y0 = PP[0][1], x1 = PP[i][0], y1 = PP[i][1], x2 = PP[i + 1][0], y2 = PP[i + 1][1];
        const i0 = PP[0][2], i1 = PP[i][2], i2 = PP[i + 1][2];
        let minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        let miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
        if (minx > maxx || miny > maxy) continue;
        anyOn = true;
        const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (Math.abs(d) < 1e-9) continue;
        const idd = 1 / d;
        for (let py = miny; py <= maxy; py++) {
          const qy = py + 0.5;
          for (let pxx = minx; pxx <= maxx; pxx++) {
            const qx = pxx + 0.5;
            const w0 = ((y1 - y2) * (qx - x2) + (x2 - x1) * (qy - y2)) * idd;
            const w1 = ((y2 - y0) * (qx - x2) + (x0 - x2) * (qy - y2)) * idd;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const iw = w0 * i0 + w1 * i1 + w2 * i2;
            const zz = 1 / iw;
            const k = py * W + pxx;
            if (zz < zb[k]) { zb[k] = zz; mb[k] = gi; }
          }
        }
      }
      if (!anyOn) { st.off++; continue; }
    }
  }
  /* 未被任何几何覆盖的像素：先看远景地面平面（它是全场最低的面），否则就是天空 */
  const R = 3000;
  let sky = 0, grnd = 0;
  for (let py = 0; py < H; py++) {
    const ny = (0.5 - (py + 0.5) / H) * 2 * cam.tan;
    for (let pxx = 0; pxx < W; pxx++) {
      const k = py * W + pxx;
      if (mb[k] >= 0) continue;
      const nxx = ((pxx + 0.5) / W - 0.5) * 2 * cam.tan * ASPECT;
      let dx = cam.x[0] * nxx + cam.y[0] * ny + cam.z[0] * -1;
      let dy = cam.x[1] * nxx + cam.y[1] * ny + cam.z[1] * -1;
      let dz = cam.x[2] * nxx + cam.y[2] * ny + cam.z[2] * -1;
      if (Math.abs(dy) < 1e-9) { sky++; continue; }
      const tt = (groundY - cam.eye[1]) / dy;
      if (tt > 0 && Math.hypot(cam.eye[0] + dx * tt - groundC[0], cam.eye[2] + dz * tt - groundC[2]) < R) grnd++;
      else sky++;
    }
  }
  const total = W * H, hist = [];
  for (const [name, i] of indexOf) {
    let n = 0; for (let k = 0; k < total; k++) if (mb[k] === i) n++;
    if (n) hist.push([name, n / total]);
  }
  /* 前景遮挡：**只看画面左右两条边缘**，并且"近"的尺度按主体距离给
     （比主体近到 0.6 倍以内的才算挡）。
     为什么不能简单地"数 90 m 内的像素"：跨河机位本来就骑在桥上，
     接触网杆、栏杆、桥面都在正下方十几米处，那种"近"是构图的一部分，
     按中心区域数会把四个跨河机位全部误判成废镜头。
     而真正的失败模式是**街谷**：相机掉进沿街楼群里，两侧边缘被别人的
     立面糊满（外滩机位试到 26 m 高时实测边缘遮挡 25%，同一点位 96 m 高是 0%），
     那种东西只出现在边缘，不出现在脚下。 */
  const lo = Math.round(W * 0.22), hi = W - lo;
  let edge = 0, blocked = 0;
  for (let py = 0; py < H; py++) for (let pxx = 0; pxx < W; pxx++) {
    if (pxx >= lo && pxx < hi) continue;
    const k = py * W + pxx;
    if (mb[k] < 0) continue;
    /* 地面本身不算"遮挡"。补了 ±950 m 的烘焙外圈地面之后，画面下半屏全是
       aerial —— 它比地标近，但挡住视线的从来不是地，是立面。 */
    if (GROUND_MATS[names[mb[k]]]) continue;
    edge++;
    if (zb[k] < edgeLimit) blocked++;
  }
  hist.sort((a, b) => b[1] - a[1]);
  hist.push(['sky', sky / total], ['farGround', grnd / total]);
  for (const [name, i] of indexOf) { const s = stat.get(name); if (s) s.pix = 0; }
  for (let k = 0; k < total; k++) if (mb[k] >= 0) { const s = stat.get(names[mb[k]]); if (s) s.pix++; }
  return { hist, nearClip, culled, stat, edgeShare: blocked / total, mb, zb, names, cam };
}

function fmt(r) { return `${(r * 100).toFixed(1)}%`; }
function pick(hist, pred) { let s = 0; for (const [m, v] of hist) if (pred(m)) s += v; return s; }

/* ================================================================== 主流程 */
const LIDS = (process.argv[2] || 'l5,l6,l3,l16,ml').split(',');
for (const id of LIDS) {
  if (!SH.LINES[id]) { bad(`无此线路 ${id}`); continue; }
  const line = new LineRuntime(SH.LINES[id]);
  const spots = (VIEWSPOTS[id] || []).filter(sp => SHOT[sp.kind] && (SHOT[sp.kind].mode === 'cross' || HERO[sp.kind]));
  if (!spots.length) { console.log(`${id}: 无可检地标的观景点`); continue; }
  console.log(`\n—— ${id} (${SH.LINES[id].name}) ——  光栅化 ${W}×${H}`);
  for (const sp of spots) {
    const ss = line.stationSAt(sp.i);
    if (ss == null || !line.isElevated(ss)) continue;
    const d = bakeWindow(line, id, ss - 1700, ss + 1700);
    const lm = d.placed.find(r => r.kind === sp.kind && Math.abs(r.s - ss) < 30);
    if (!lm) { bad(`${id} ${sp.kind}@${Math.round(ss)}：地标没被烘焙出来`); continue; }
    /* 河中央不许有东西。跨江/跨河窗口中央、线路中心两侧 12 m 以内，任何构件都
       不许"从梁底一直扎到水面以下"。
       抓的是两类实测踩过的刺：① 高架桥墩一路打到江心 —— 那一段的荷载本来由
       斜拉桥自己的塔与索承担，世界却按每 26 m 一根的固定间距铺墩，观景截图里
       桥下就是一排棕色板子插在水里，比桥塔还抢眼；② 索面的横向锚固面落在梁外
       —— 加劲梁从 24 m 收窄到 15 m 时索还挂在 ±8 m，每根索的下端探出梁边。
       这两类在占比判据里完全隐形（只占画面零点几个百分点），必须单独钉。

       判据取**三角形跨不跨过"梁底→水面"这段空气**，而不是"顶点在水面以下"：
       水是不透明的，沉在水下的部分从桥面上根本看不见；刺眼的是露在空气里的那一截。
       按顶点判还会把自家防汛墙（本来就要扎进河床）全线报红。 */
    if (SHOT[sp.kind].mode === 'cross') {
      const ws = (line.waterRanges() || []).filter(r => Math.abs((r[0] + r[1]) / 2 - lm.s) < 400);
      if (ws.length) {
        const FS = [];
        for (let s = lm.s - 420; s <= lm.s + 420; s += 25) FS.push(line.al.frame(C(s, 0, line.al.total)));
        /* 只查河床中央：crossing 的水面半宽最小 223 m、creek 最小 30 m，
           岸壁都在那之外，所以把检查带收在 220 / 28 m 就只剩"河中央的东西"。 */
        const inner = sp.kind === 'creek' ? 28 : 220;
        const dY = parseFloat(process.env.WATERCHK) || 0;
        let viol = 0, ex = [];
        for (const m of d.meshes) {
          if (m.mat === 'water' || m.mat === 'rubber') continue;
          const P = m.pos, X = m.idx;
          let vi;
          const info = i => {
            if (vi === undefined) vi = new Array(m.verts);
            if (vi[i] !== undefined) return vi[i];
            const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
            if ((x - lm.origin[0]) ** 2 + (z - lm.origin[2]) ** 2 > 430 * 430) return (vi[i] = null);
            let bd = 1e18, bf = null;
            for (const fr of FS) { const dd = (fr.p[0] - x) ** 2 + (fr.p[2] - z) ** 2; if (dd < bd) { bd = dd; bf = fr; } }
            if (!bf || bd > 420 * 420) return (vi[i] = null);
            return (vi[i] = { y, s: bf.s, rail: bf.p[1], surf: bf.p[1] - 10.2 + dY,
              lat: Math.abs((x - bf.p[0]) * bf.r[0] + (z - bf.p[2]) * bf.r[2]) });
          };
          for (let t = 0; t + 2 < X.length; t += 3) {
            const A = info(X[t]), B = info(X[t + 1]), Cc = info(X[t + 2]);
            if (!A || !B || !Cc) continue;
            if (A.lat > 12 || B.lat > 12 || Cc.lat > 12) continue;
            if (Math.abs(A.s - lm.s) > inner || Math.abs(B.s - lm.s) > inner || Math.abs(Cc.s - lm.s) > inner) continue;
            const lo = Math.min(A.y, B.y, Cc.y), hi = Math.max(A.y, B.y, Cc.y);
            if (hi < A.rail - 7 || lo > A.surf + 0.2) continue;
            viol++;
            if (process.env.SHOT_WHO && viol <= 2) {
              for (let q = t - 12; q <= t + 12; q += 3) {
                if (q < 0 || q + 2 >= X.length) continue;
                const v = [X[q], X[q + 1], X[q + 2]].map(i => `(${P[i * 3].toFixed(1)},${P[i * 3 + 1].toFixed(1)},${P[i * 3 + 2].toFixed(1)})`);
                console.log(`        ${m.mat} tri@${q} ${v.join(' ')}`);
              }
            }
            if (ex.length < 3) ex.push(`${m.mat} 跨 ${lo.toFixed(1)}~${hi.toFixed(1)}（水面 ${A.surf.toFixed(1)}，梁底 ${(A.rail - 7).toFixed(1)}）横向 ${A.lat.toFixed(1)} m 里程≈${Math.round(A.s)}`);
          }
        }
        if (viol) bad(`${id} ${sp.kind}: ${viol} 个三角形从梁底扎到水面以下 —— ${ex.join(' ; ')}`);
      }
    }
    const sc = shotCam(line, lm);
    const gf = line.al.frame(lm.s);
    const t0 = Date.now();
    const subjDist = Math.hypot(lm.origin[0] - sc.eye[0], lm.origin[1] - sc.eye[1], lm.origin[2] - sc.eye[2]);
    /* 远景地面高度必须与 game.js 一致：groundY(s) − 12.2（沿线 ±600 m 平滑后的
       轨面高），不是相机脚下那一点的真实轨面。 */
    const R = render(sc.cam, d.meshes, line.al.groundY(lm.s) - 11.3, gf.p, Math.max(60, subjDist * 0.6));
    const { hist, nearClip, stat, edgeShare } = R;
    /* PIX=0.7,0.9;0.5,0.5  PIXKIND=crossing
       截图上认不出"那根立在水里的东西是什么"。这里按归一化屏幕坐标反查
       深度缓冲：给出赢下这个像素的材质、相机距离、以及命中点的世界坐标，
       拿着世界坐标就能在源码里对上具体是哪一段几何。 */
    if (process.env.PIX === 'map') {
      /* 把画面打成字符地图：每个字符 = 该 6×5 像素块里赢下最多像素的材质。
         截图只能看出"水里有个怪东西"，看不出它是谁；有了这张图就能直接
         按行列报出坐标去几何源码里对。 */
      const BL = 6, BT = 5, legend = new Map();
      const SY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let rows = '';
      for (let by = 0; by < H; by += BT) {
        let row = '';
        for (let bx = 0; bx < W; bx += BL) {
          const cnt = new Map();
          for (let py = by; py < Math.min(H, by + BT); py++) for (let pxx = bx; pxx < Math.min(W, bx + BL); pxx++) {
            const k = py * W + pxx, nm = R.mb[k] < 0 ? '.' : R.names[R.mb[k]];
            cnt.set(nm, (cnt.get(nm) || 0) + 1);
          }
          let best = '.', bn = 0;
          for (const [nm, c] of cnt) if (c > bn) { bn = c; best = nm; }
          if (!legend.has(best)) legend.set(best, SY[legend.size % SY.length]);
          row += legend.get(best);
        }
        rows += row + '\n';
      }
      console.log('    ' + [...legend].map(([n, s]) => `${s}=${n}`).join(' '));
      console.log(rows.split('\n').map(r => '    |' + r + '|').join('\n'));
    }
    if (process.env.PIX && process.env.PIX !== 'map' && (!process.env.PIXKIND || process.env.PIXKIND === sp.kind)) {
      const cm = R.cam;
      for (const pt of process.env.PIX.split(';')) {
        const q = pt.split(',').map(Number);
        const pxx = Math.round(q[0] * (W - 1)), py = Math.round(q[1] * (H - 1)), k = py * W + pxx;
        const nm = R.mb[k] < 0 ? '（未命中几何：天空/远景地面）' : R.names[R.mb[k]];
        const nxx = ((pxx + 0.5) / W - 0.5) * 2 * cm.tan * ASPECT;
        const ny = (0.5 - (py + 0.5) / H) * 2 * cm.tan;
        const dir = [0, 1, 2].map(i => cm.x[i] * nxx + cm.y[i] * ny - cm.z[i]);
        const dd = R.zb[k] === Infinity ? -1 : R.zb[k];
        const wp = [0, 1, 2].map(i => cm.eye[i] + dir[i] * dd);
        console.log(`    PIX ${q[0]},${q[1]} → ${nm}  距离 ${dd < 0 ? '—' : dd.toFixed(0) + ' m'}  世界 (${wp.map(v => v.toFixed(0)).join(', ')})`);
      }
    }
    if (process.env.SHOT_DIAG) {
      console.log(`    eye (${sc.eye.map(v => v.toFixed(0)).join(', ')}) → look (${sc.look.map(v => v.toFixed(0)).join(', ')})`);
      for (const m of process.env.SHOT_DIAG.split(',')) {
        const s = stat.get(m);
        if (!s) { console.log(`    [${m}] 这段世界里根本没有该材质的三角形`); continue; }
        console.log(`    [${m}] 三角 ${s.tris} → 背面剔除 ${s.back} · 近裁后不足三面 ${s.near} · 出画 ${s.off} → 赢下像素 ${s.pix}` + (s.clip ? ` · 被近平面裁过 ${s.clip}` : ''));
        if (s.bx1 !== undefined) console.log(`         投影像素范围 x ${s.bx0.toFixed(0)}~${s.bx1.toFixed(0)} · y ${s.by0.toFixed(0)}~${s.by1.toFixed(0)}（画面 ${W}×${H}）`);
      }
    }
    const water = pick(hist, m => WATER_MATS[m]);
    const heroM = HERO[sp.kind] || {};
    const hero = pick(hist, m => heroM[m]);
    const sky = pick(hist, m => m === 'sky');
    const top = hist.slice(0, 5).map(([m, v]) => `${m} ${fmt(v)}`).join(' · ');
    const wmin = WATER_MIN[sp.kind];
    const isWaterSpot = wmin != null;
    const okW = !isWaterSpot || water >= wmin;
    const okH = hero >= HERO_MIN;
    const okS = sky >= SKY_MIN && sky <= SKY_MAX;
    /* 横向净距：地标被搬近以后不能插进沿街楼群（楼群外缘 88.8 m）。
       跨江/跨河类的主体就是"横穿线路"，minLat 天然接近 0，不计。 */
    const okL = lm.cross || lm.minLat >= LAT_MIN;
    console.log(`  ${sp.kind.padEnd(9)} 水 ${fmt(water)} 主体 ${fmt(hero)} 天空 ${fmt(sky)} 边缘遮挡 ${fmt(edgeShare)} 横向净距 ${lm.minLat.toFixed(0)} m  [${top}]  ${Date.now() - t0}ms`);
    if (edgeShare > CLUTTER_MAX || (hero < CLUTTER_VS_HERO[0] && edgeShare > CLUTTER_VS_HERO[1])) {
      bad(`${id} ${sp.kind}: 画面边缘 ${fmt(edgeShare)} 被比主体更近的东西糊住（主体只有 ${fmt(hero)}）—— 相机掉进街谷里了`);
    }
    if (!okL) bad(`${id} ${sp.kind}: 地标最近点只在线路外侧 ${lm.minLat.toFixed(0)} m（应 ≥ ${LAT_MIN}）—— 会插进沿街楼群`);
    if (!okW) bad(`${id} ${sp.kind}: 水面只占画面 ${fmt(water)}（应 ≥ ${fmt(wmin)}）—— 江在那里但看不见`);
    if (!okH) bad(`${id} ${sp.kind}: 地标主体只占画面 ${fmt(hero)}（应 ≥ ${fmt(HERO_MIN)}）—— 框住了却小得像火柴棍`);
    if (!okS) bad(`${id} ${sp.kind}: 天空占 ${fmt(sky)}，构图朝天或朝地（应在 ${fmt(SKY_MIN)}~${fmt(SKY_MAX)}）`);
  }
}
/* ============================================================ 街面机位
 * 上面那套量的是"观景机位里的地标"。街面机位（行人站在街上看高架站出入口）
 * 以前**没有任何像素判据** —— 所以"一团树冠糊在镜头上"这件事，只有我主动去
 * 截图才会发现（README 第 67 条）。现在把它钉成两条：
 * ① 画面中心 1/3 里 foliage 不许超过 12% —— 树可以当上下边缘的前景，
 *    但不许站在行人与出入口之间；
 * ② 站体本身（站台面/雨棚/屏蔽门/轨道结构）在全画面 ≥ 3% —— 否则"中心很干净"
 *    只是因为画面里全是天空和马路，判据又变成一个不测量任何东西的分数。 */
{
  const STATION_MATS = ['granite', 'tiles', 'glassSoft', 'steel', 'metal'];
  let n = 0, worstF = 0, worstAt = '', minHero = 1, minHeroAt = '';
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    const elev = [];
    for (let i = 0; i < line.stations.length; i++) if (line.isElevated(line.al.stationS[i])) elev.push(i);
    if (!elev.length) continue;
    const step = Math.max(1, Math.ceil(elev.length / 2));
    for (const i of elev.filter((_, k) => k % step === 0).slice(0, 2)) {
      const ss = line.al.stationS[i];
      const q = SH.streetShot(line, ss);
      const d = bakeWindow(line, id, ss - 460, ss + 460);
      const R = render(makeCam(q.eye, q.target, q.fov), d.meshes,
        line.al.groundY(ss) - 11.3, line.al.frame(ss).p, 1e9);
      const nameOf = k => R.names[R.mb[k]];
      let cTot = 0, cFol = 0;
      for (let y = Math.floor(H / 3); y < Math.ceil(H * 2 / 3); y++)
        for (let x = Math.floor(W / 3); x < Math.ceil(W * 2 / 3); x++) {
          const nm = nameOf(y * W + x); cTot++;
          if (nm === 'foliage') cFol++;
        }
      const cf = cFol / cTot, hs = pick(R.hist, m => STATION_MATS.indexOf(m) >= 0);
      n++;
      if (cf > worstF) { worstF = cf; worstAt = `${line.name} ${line.stations[i]}`; }
      if (hs < minHero) { minHero = hs; minHeroAt = `${line.name} ${line.stations[i]}`; }
      if (cf > 0.12) bad(`${line.name} ${line.stations[i]}: 街面机位画面中心 ${fmt(cf)} 是树冠（应 ≤ 12%）—— 相机站在树坑里，出入口被糊住`);
      if (hs < 0.03) bad(`${line.name} ${line.stations[i]}: 街面机位全站体只占 ${fmt(hs)}（应 ≥ 3%）—— 中心干净是因为画面里根本没有站`);
    }
  }
  console.log(`  街面机位 ${n} 处：中心树冠最差 ${fmt(worstF)}（${worstAt}）、站体占比最低 ${fmt(minHero)}（${minHeroAt}）`);
}

/* ============================================================ 盾构洞口
 * 端环与门框在 `WorldBuilder._tunnelPortal()` 里已经建出来了，但**从来没有一个机位
 * 把洞口框进画面**（README 欠账 ⑫）—— "它到底像不像一个隧道口"一直靠想象。
 * 这里量三件事，全是像素（画面中央 40%×40% 那条带）：
 * ① 有没有管片内壁 `segment` —— 管子是开口的，看得进去才叫洞口；被端环封死、
 *    被外壁挡住、或者根本没框进画面，这一项都是零；
 * ② 门框（`portal`，专属材质）与端环/外壁（`concreteD`）各占多少 —— 框住了但小得像火柴棍；
 * ③ 天空占多少 —— "隧道口悬在半空"（高架端头直接接一段管子）的表现就是环周全是天。
 * 机位：洞口**外侧**沿里程退 20 m、横移 14 m、轨面上方 6 m，看向洞口中心。
 * 只挑邻段是高架或基地的隧道端头 —— 夹在两座车站之间的洞口被站体挡住，量不到产品。 */
{
  /* 门槛按 2026-10-02 实测留余量：门框 3.8~4.7%、端环+外壁 40~52%、内壁 ≥3.7%、天空 0%。
     门框用**专属材质 `portal`**（贴图与 concrete 同一张，观感不变）：以前它和桥台、
     墩身、道床共用 `concrete`，于是"把门框整个撤掉"这条负控测不住 —— 中央带里的
     concrete 还有一堆来自别处（实测撤干净仍 4.8%，门槛 1.5%）。
     `concreteD` 仍然只证明"洞口在画面里"（它是端环 + 粗外壁 + 道床三合一）。 */
  const SEG_MIN = 0.02, WALL_MIN = 0.015, RING_MIN = 0.20, SKY_MAX = 0.45;
  const WALL = { portal: 1 }, RING = { concreteD: 1 };
  let n = 0, minSeg = 1, minSegAt = '', minWall = 1, minWallAt = '', minRing = 1, maxSky = 0, maxSkyAt = '';
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    const al = line.al, runs = SH.WorldBuilder.runsOf(line, 0, al.total);
    let best = null;
    for (let k = 0; k < runs.length; k++) {
      if (runs[k].kind !== 'tunnel') continue;
      const len = runs[k].s1 - runs[k].s0;
      /* 洞口落在 buildRuns 的引入段端点上（a = r.s0 − 22 / z = r.s1 + 22），
         判据必须按**同一套端点**算，否则机位对准的是空气。 */
      for (const e of [{ nb: runs[k - 1], s: Math.max(0, runs[k].s0 - 22), into: 1 },
                       { nb: runs[k + 1], s: Math.min(al.total, runs[k].s1 + 22), into: -1 }]) {
        if (!e.nb || e.nb.kind === 'tunnel' || e.nb.kind === 'station') continue;
        /* 优先"出洞即高架"那一头：隧道端头接基地的洞口埋在地面库里，画面平淡；
           接高架的那一头才是车迷会专门去拍的"管子从桥台里冒出来"。 */
        const rank = (e.nb.kind === 'viaduct' ? 1e9 : 0) + len;
        if (!best || rank > best.rank) best = { s: e.s, into: e.into, len, nb: e.nb.kind, rank };
      }
    }
    if (!best) continue;
    const d = bakeWindow(line, id, best.s - 420, best.s + 420);
    const frE = al.frame(Math.max(0, Math.min(al.total, best.s - best.into * 20)));
    const eye = al.world(frE, 14, 6), look = al.world(al.frame(best.s), 0, 0);
    const R = render(makeCam(eye, look, 50), d.meshes, al.groundY(best.s) - 11.3, frE.p, 1e9);
    const nameOf = q => R.names[R.mb[q]];
    let tot = 0, seg = 0, wall = 0, ring = 0, sky = 0;
    for (let y = Math.floor(H * 0.3); y < Math.ceil(H * 0.7); y++)
      for (let x = Math.floor(W * 0.3); x < Math.ceil(W * 0.7); x++) {
        const nm = nameOf(y * W + x); tot++;
        if (nm === 'segment') seg++; else if (WALL[nm]) wall++; else if (RING[nm]) ring++; else if (nm === 'sky') sky++;
      }
    const p = v => (v / tot * 100).toFixed(1) + '%';
    const segF = seg / tot, wallF = wall / tot, ringF = ring / tot, skyF = sky / tot;
    n++;
    if (segF < minSeg) { minSeg = segF; minSegAt = `${line.name} s≈${Math.round(best.s)}`; }
    if (wallF < minWall) { minWall = wallF; minWallAt = `${line.name} s≈${Math.round(best.s)}`; }
    if (ringF < minRing) minRing = ringF;
    if (skyF > maxSky) { maxSky = skyF; maxSkyAt = `${line.name} s≈${Math.round(best.s)}`; }
    if (process.env.PORTAL_DIAG) console.log(`    洞口 ${line.name} s≈${Math.round(best.s)} 邻段 ${best.nb}：${[...R.hist].slice(0, 6).map(([m, v]) => `${m} ${fmt(v)}`).join(' · ')}`);
    if (segF < SEG_MIN) bad(`${line.name} 洞口 s≈${Math.round(best.s)}：中央带里看不到管片内壁（${p(segF)}，应 ≥ ${p(SEG_MIN)}）—— 洞口没被框住、或者被堵成一面墙`);
    if (wallF < WALL_MIN) bad(`${line.name} 洞口 s≈${Math.round(best.s)}：中央带里门框只占 ${p(wallF)}（应 ≥ ${p(WALL_MIN)}）—— 洞口的门框没被建出来或在画面外`);
    if (ringF < RING_MIN) bad(`${line.name} 洞口 s≈${Math.round(best.s)}：中央带里端环/外壁只占 ${p(ringF)}（应 ≥ ${p(RING_MIN)}）—— 根本没框住洞口`);
    if (skyF > SKY_MAX) bad(`${line.name} 洞口 s≈${Math.round(best.s)}：中央带 ${p(skyF)} 是天空（应 ≤ ${p(SKY_MAX)}）—— 隧道口悬在半空，四周没有土`);
  }
  if (!n) bad('一条隧道端头都没找到 —— 洞口判据是个不测量任何东西的空壳');
  console.log(`  盾构洞口 ${n} 处：内壁可见最差 ${fmt(minSeg)}（${minSegAt}）、门框最低 ${fmt(minWall)}（${minWallAt}）、端环/外壁最低 ${fmt(minRing)}、天空最高 ${fmt(maxSky)}（${maxSkyAt}）`);
}

/* ============================================================ 站台机位
 * 玩家按 V 就切得到的机位，以前只在高架站被看过一眼（而那一眼是相机埋进设施里），
 * 地下站从没量过。这里每条线按站型各量一处（地下 + 高架），量三件事：
 * ① 站体（站台面/雨棚/屏蔽门/吊顶/站名牌）占全画面多少 —— "画面很干净"如果
 *    是因为里面根本没有站，和街面机位那条判据同一个道理；
 * ② 近距遮挡：命中距离 < 3 m 的像素占比 —— 抓"相机怼进一件站厅设施"；
 * ③ 天空占比：地下站该是 0（站体包住了），露天/高架站不该接近满幅。
 * 机位不自己算，调 `SH.platformShot` —— 抄一份相机就是第二个真值。
 * `s` 取**整数站序里程**：里程标定之后平均站距 2~3 km，插值 0.2 就是离站台半公里。 */
{
  const BODY = { granite: 1, tiles: 1, glassSoft: 1, roof: 1, metal: 1, paint: 1 };
  const NEAR_M = 3.0, BODY_MIN = 0.05;
  /* 站台面横向范围只从世界几何那一份取（`SH.STATION_X`），不另抄数：
     相机位、近距像素横向分桶、以及站台尺寸都拿它当基准。 */
  const SX = SH.STATION_X;
  let n = 0, minBody = 1, minBodyAt = '', maxNear = 0, maxNearAt = '', maxSkyUnder = 0, maxSkyUnderAt = '', minLatAll = 9, minLatAt = '';
  let minPtdFrac = 9, minPtdAt = '', minPtdCount = 9, minPtdCountAt = '';
  for (const id of Object.keys(SH.LINES)) {
    const line = new LineRuntime(SH.LINES[id]);
    const spots = [];
    /* `PLAT_STATION=<站序>`：诊断默认取"第一个地下站 + 第一个高架站"。
       而 dev/shot.js 的截图用的是自己指定的站序（截图里看到的柱子、屏，
       要在这里反查材质就必须能选同一站）—— 两边站序不一致时，
       PLAT_PIX 报出来的材质会对不上画面，而症状是"诊断在撒谎"。 */
    const only = process.env.PLAT_STATION != null && process.env.PLAT_STATION !== '' ? parseInt(process.env.PLAT_STATION) : null;
    for (const want of [false, true]) {
      if (only != null) {
        const ss2 = line.al.stationS[only];
        if (ss2 != null) spots.push({ ss: ss2, name: line.stations[only], elev: !!line.isElevated(ss2) });
        continue;
      }
      for (let i = 1; i < line.stations.length - 1; i++) {
        const ss = line.al.stationS[i];
        if (!!line.isElevated(ss) === want) { spots.push({ ss, name: line.stations[i], elev: want }); break; }
      }
    }
    for (const sp of spots) {
      const d = bakeWindow(line, id, sp.ss - 420, sp.ss + 420);
      const q = SH.platformShot(line, sp.ss, null);
      const R = render(makeCam(q.eye, q.target, q.fov), d.meshes,
        line.al.groundY(sp.ss) - 11.3, line.al.frame(sp.ss).p, 1e9);
      const fe = line.al.frame(line.nearStation(sp.ss).s - 26);   // 与 SH.platformShot 同一处横向基准
      let near = 0;
      for (let k = 0; k < R.zb.length; k++) if (R.zb[k] < NEAR_M) near++;
      let minLat = 9;
      const cm = R.cam;
      for (let k = 0; k < R.zb.length; k++) if (R.zb[k] < NEAR_M) {
        const pxx = k % W, py = (k / W) | 0;
        const nxx = ((pxx + 0.5) / W - 0.5) * 2 * cm.tan * ASPECT;
        const ny = (0.5 - (py + 0.5) / H) * 2 * cm.tan;
        const dx = cm.x[0] * nxx + cm.y[0] * ny - cm.z[0];
        const dy = cm.x[1] * nxx + cm.y[1] * ny - cm.z[1];
        const dz = cm.x[2] * nxx + cm.y[2] * ny - cm.z[2];
        const w = [0, 1, 2].map(i => cm.eye[i] + [dx, dy, dz][i] * R.zb[k]);
        const lt = Math.abs((w[0] - fe.p[0]) * fe.r[0] + (w[2] - fe.p[2]) * fe.r[2]);
        if (lt < minLat) minLat = lt;
      }
      const nf = near / (W * H), bf = pick(R.hist, m => BODY[m]), sf = pick(R.hist, m => m === 'sky');
      n++;
      if (bf < minBody) { minBody = bf; minBodyAt = `${line.name} ${sp.name}`; }
      if (nf > maxNear) { maxNear = nf; maxNearAt = `${line.name} ${sp.name}`; }
      if (!sp.elev && sf > maxSkyUnder) { maxSkyUnder = sf; maxSkyUnderAt = `${line.name} ${sp.name}`; }
      if (near && minLat < minLatAll) { minLatAll = minLat; minLatAt = `${line.name} ${sp.name}`; }
      if (process.env.PLATFORM_DIAG || sf > 0.45) console.log(`    站台 ${line.name} ${sp.name} ${sp.elev ? '高架' : '地下'}：站体 ${fmt(bf)} 天空 ${fmt(sf)}`);
      /* 观景机位那套 PIX=map 打的是地标，站台机位没有取证口 ——
         而"近距 15~32%"到底是谁挡的，只能靠图说话。这里给三样：
         材质字符地图（每格 6×5 像素取多数）、近距掩码（谁在 3 m 内）、
         以及**近距像素各自的材质分布**（最后这个直接答"身旁那片是什么"）。 */
      if (process.env.PLAT_DIAG === id || process.env.PLAT_DIAG === 'all') {
        const BL = 6, BT = 5, legend = new Map(), nearMat = new Map();
        const SY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (let k = 0; k < R.zb.length; k++) if (R.zb[k] < NEAR_M) {
          const nm = R.mb[k] < 0 ? '（空）' : R.names[R.mb[k]];
          nearMat.set(nm, (nearMat.get(nm) || 0) + 1);
        }
        let mrows = '', nrows = '';
        for (let by = 0; by < H; by += BT) {
          let mr = '', nr = '';
          for (let bx = 0; bx < W; bx += BL) {
            const cnt = new Map(); let nk = 0, tot = 0;
            for (let py = by; py < Math.min(H, by + BT); py++) for (let pxx = bx; pxx < Math.min(W, bx + BL); pxx++) {
              const k = py * W + pxx, nm = R.mb[k] < 0 ? '.' : R.names[R.mb[k]];
              cnt.set(nm, (cnt.get(nm) || 0) + 1); tot++;
              if (R.zb[k] < NEAR_M) nk++;
            }
            let best = '.', bn = 0;
            for (const [nm, c] of cnt) if (c > bn) { bn = c; best = nm; }
            if (!legend.has(best)) legend.set(best, SY[legend.size % SY.length]);
            mr += legend.get(best);
            nr += nk * 2 > tot ? '#' : nk > 0 ? '+' : '.';
          }
          mrows += mr + '\n'; nrows += nr + '\n';
        }
        console.log(`    ── ${line.name} ${sp.name} ${sp.elev ? '高架' : '地下'} 取证 ──`);
        /* 近距像素各自的**世界横向位置**：按 |横向| 打印（站台距线路中心
           ${SX.front}~${SX.outer} m；side=-1 的车站打在负侧，绝对值才和注释对得上）。
           把近距像素按横向分桶，就能直接回答"身旁那片到底是什么" ——
           若落在站台面之外（< front 或 > outer），那是插进站台边缘的东西，才是真缺陷。 */
        const buck = new Map();
        /* 近距像素按**材质**分桶，并给出每种的横向/高度范围与相机距离范围。
           回答的不是"近不近"，而是"近的是什么东西、在哪儿"。 */
        for (let k = 0; k < R.zb.length; k++) {
          if (!(R.zb[k] < NEAR_M)) continue;
          const pxx = k % W, py = (k / W) | 0;
          const nxx = ((pxx + 0.5) / W - 0.5) * 2 * cm.tan * ASPECT;
          const ny = (0.5 - (py + 0.5) / H) * 2 * cm.tan;
          const dx = cm.x[0] * nxx + cm.y[0] * ny - cm.z[0];
          const dy = cm.x[1] * nxx + cm.y[1] * ny - cm.z[1];
          const dz = cm.x[2] * nxx + cm.y[2] * ny - cm.z[2];
          const w = [0, 1, 2].map(i => cm.eye[i] + [dx, dy, dz][i] * R.zb[k]);
          const lt = Math.abs((w[0] - fe.p[0]) * fe.r[0] + (w[2] - fe.p[2]) * fe.r[2]);
          const nm = R.mb[k] < 0 ? '（空）' : R.names[R.mb[k]];
          const b = buck.get(nm) || { n: 0, lo: 9, hi: -9, y0: 9, y1: -9, d0: 9, d1: 0 };
          b.n++;
          b.lo = Math.min(b.lo, lt); b.hi = Math.max(b.hi, lt);
          b.y0 = Math.min(b.y0, w[1] - fe.p[1]); b.y1 = Math.max(b.y1, w[1] - fe.p[1]);
          b.d0 = Math.min(b.d0, R.zb[k]); b.d1 = Math.max(b.d1, R.zb[k]);
          buck.set(nm, b);
        }
        console.log(`    近距分布（横向取站台侧、站台面 ${SX.front}~${SX.outer} m；高度/距离以轨面与相机为 0）：`);
        for (const [nm, b] of [...buck].sort((a, b) => b[1].n - a[1].n))
          console.log(`      ${nm.padEnd(10)} ${fmt(b.n / near)}  横向 ${b.lo.toFixed(1)}~${b.hi.toFixed(1)}  高 ${b.y0.toFixed(1)}~${b.y1.toFixed(1)}  距 ${b.d0.toFixed(1)}~${b.d1.toFixed(1)}`);
        console.log(`    近距像素共 ${near}（${fmt(nf)}）的材质分布：` +
          [...nearMat].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${fmt(c / near)}`).join(' · '));
        console.log('    材质地图 ' + [...legend].map(([n, s]) => `${s}=${n}`).join(' '));
        console.log(mrows.split('\n').slice(0, -1).map(r => '    |' + r + '|').join('\n'));
        console.log(`    近距掩码（# = 过半像素 <${NEAR_M} m）`);
        console.log(nrows.split('\n').slice(0, -1).map(r => '    |' + r + '|').join('\n'));
        /* PLAT_PIX='0.08,0.02;0.9,0.5'  按归一化屏幕坐标反查：谁赢下这个像素、
           多远、世界坐标在哪（横向/高度/纵向都印出来，直接对上源码里的几何）。 */
        if (process.env.PLAT_PIX) {
          const latOf = (x, y, z) => [
            (x - fe.p[0]) * fe.r[0] + (z - fe.p[2]) * fe.r[2],
            (x - fe.p[0]) * fe.f[0] + (z - fe.p[2]) * fe.f[2],
            y - fe.p[1]];
          const el = latOf(cm.eye[0], cm.eye[1], cm.eye[2]);
          console.log(`    相机：世界 (${cm.eye.map(v => v.toFixed(1)).join(', ')}) · 站台侧横向 ${Math.abs(el[0]).toFixed(2)} m · 轨面以上 ${el[2].toFixed(2)} m · 站中心前 ${el[1].toFixed(0)} m`);
          for (const pt of process.env.PLAT_PIX.split(';')) {
            const q2 = pt.split(',').map(Number);
            const pxx = Math.round(q2[0] * (W - 1)), py = Math.round(q2[1] * (H - 1)), k = py * W + pxx;
            const nxx = ((pxx + 0.5) / W - 0.5) * 2 * cm.tan * ASPECT;
            const ny = (0.5 - (py + 0.5) / H) * 2 * cm.tan;
            const dir = [0, 1, 2].map(i => cm.x[i] * nxx + cm.y[i] * ny - cm.z[i]);
            const dd = R.zb[k];
            const nm = R.mb[k] < 0 ? '（未命中几何）' : R.names[R.mb[k]];
            if (dd === Infinity) { console.log(`    PIX ${pt} → ${nm}`); continue; }
            const w = [0, 1, 2].map(i => cm.eye[i] + dir[i] * dd);
            const lw = latOf(w[0], w[1], w[2]);
            console.log(`    PIX ${pt} → ${nm} 距 ${dd.toFixed(1)} m；命中点 横向 ${Math.abs(lw[0]).toFixed(2)} m · 轨面以上 ${lw[2].toFixed(2)} m · 站中心前 ${(-lw[1]).toFixed(0)} m`);
          }
        }
      }
      /* 只钉"站体在不在画面里"这一条 —— 它是能讲清的规则：人站在站台上，站体就该
         吃掉画面的一大块（实测 31 处全部 36~61%）。
         **近距遮挡已经取证完毕，内容是站台自己的东西，不构成缺陷**：近距像素全部
         落在站台面（|横向| 2.1~5.8 m）与高度 0.4~3.9 m 之间，对回源码是屏蔽门框、
         门头梁、站台板顶面、黄线/盲道/线路色带、吊顶板与柱础；高架站多一层
         glassSoft 是站台外侧玻璃栏板。没有灯箱、没有楼梯插进站台边缘。所以这条
         量既不改成"只算 1.5 m 之外"也不设阈值，**只保留诊断打印**（PLATFORM_DIAG）。
         地下站看见的 12~15% 天空同理，是顺着站台望向两端洞口看到的街面。 */
      if (bf < BODY_MIN) bad(`${line.name} ${sp.name}：站台机位全站体只占 ${fmt(bf)}（应 ≥ ${fmt(BODY_MIN)}）—— 相机没站在站里`);

      /* ---- 柱身倒计时屏（'ptd'）：量它**在站台机位画面里有多大** ----
       * 这条判据换过四次挂点，每一次都是被"看不见"逼出来的（详见 world.js 的注释）：
       * 吊在柱间被立柱压住、"吸附到柱中点"被 continue 跳光、吊在 3.6 m 高只剩几个像素。
       * 那些版本里"屏建出来了"全部成立 —— 几何在、批次在、贴图在，
       * 只有一条判据量得到后果：**它在视锥里吗、它张角多大**。
       * 量法用相机基向量把每块屏的中心与高度投到画面里，
       * 与光栅分辨率无关（240×135 下"18 px"是没有意义的门槛）。 */
      {
        const list = (d.wb.ptdBatches || []).filter(o => o.s != null);
        const where = `${line.name} ${sp.name}`;
        if (list.length < 3) bad(`${where}：这一段只挂了 ${list.length} 块站台倒计时屏（应 ≥ 3）—— 站台上隔几根柱子就有一块，不是孤零零一块`);
        if (list.length) {
          const cm2 = R.cam;
          let frac = 0, inside = 0;
          for (const o of list) {
            const c = line.al.world(line.al.frame(o.s), o.lat, o.dy);
            const dd = [c[0] - cm2.eye[0], c[1] - cm2.eye[1], c[2] - cm2.eye[2]];
            /* makeCam 的 z 是 `normalize(eye − target)`，也就是**朝后**的：
               视线深度要取 −dot(d, z)。照字面写 dot(d, z) 会把每一块屏都判成
               "在相机背后"，于是一条判据永远红 —— 而且红得很有道理。 */
            const zc = -(dd[0] * cm2.z[0] + dd[1] * cm2.z[1] + dd[2] * cm2.z[2]);
            if (zc <= 0.2) continue;                       // 在相机背后
            const xc = dd[0] * cm2.x[0] + dd[1] * cm2.x[1] + dd[2] * cm2.x[2];
            const yc = dd[0] * cm2.y[0] + dd[1] * cm2.y[1] + dd[2] * cm2.y[2];
            if (Math.abs(xc / zc) < cm2.tan * ASPECT && Math.abs(yc / zc) < cm2.tan) inside++;
            /* 屏高占画面高度的比例：h/zc 归一化到半幅 tan，再除 2 */
            frac = Math.max(frac, (o.h / zc) / cm2.tan / 2);
          }
          if (!inside) bad(`${where}：站台倒计时屏一块都不在站台机位的视锥里`);
          if (frac < 0.035) bad(`${where}：站台倒计时屏最大只占画面高度的 ${fmt(frac)}（应 ≥ 3.5%）—— 挂在高处或太远，读不出下一班车`);
          /* 屏面比例必须与实时纹理 512×192 一致，否则一行字被拉成竖条 */
          for (const o of list) {
            if (Math.abs(o.w / o.h - 512 / 192) > 0.02) {
              bad(`${where}：站台倒计时屏 ${o.w.toFixed(2)}×${o.h.toFixed(2)} m，比例 ${(o.w / o.h).toFixed(2)} ≠ 贴图 512/192 = 2.67 —— 屏上的字被拉变形`);
              break;
            }
          }
          /* 屏顶必须在柱面线路色环下沿之下：两者原来是 2.82 与 2.75，重叠 7 cm，
             画面上是"绿带从屏幕里穿出来"。两个标高都取自 SH.STATION_X，判据量的是冲突。 */
          for (const o of list) {
            if (o.dy + o.h / 2 > SX.pillarRing - 0.15 - 0.03) {
              bad(`${where}：站台倒计时屏顶 ${(o.dy + o.h / 2).toFixed(2)} m 撞进柱面线路色环（下沿 ${(SX.pillarRing - 0.15).toFixed(2)} m）`);
              break;
            }
          }
          if (frac < minPtdFrac) { minPtdFrac = frac; minPtdAt = where; }
          if (list.length < minPtdCount) { minPtdCount = list.length; minPtdCountAt = where; }
        }
      }
    }
  }
  if (n < 20 && only == null) bad(`站台机位只量到 ${n} 处（20 条线 × 地下/高架各一处）—— 有线路两类站型凑不齐，判据覆盖面不足`);
  console.log(`  站台机位 ${n} 处：站体占比最低 ${fmt(minBody)}（${minBodyAt}）、近距遮挡最高 ${fmt(maxNear)}（${maxNearAt}）、地下站天空最高 ${fmt(maxSkyUnder)}（${maxSkyUnderAt}）、近距最近横向 ${minLatAll.toFixed(1)} m（${minLatAt}）、倒计时屏最小张角 ${fmt(minPtdFrac)}（${minPtdAt}）、最少块数 ${minPtdCount}（${minPtdCountAt}）`);
}

/* 驾驶室第一视角 —— 玩家默认看到、却是唯一一个没有任何像素判据的机位。
 * README 第 70、71 条的三件事（手柄不转、玻璃与台面之间空 0.55 m、车尾是个洞）
 * 全藏在这个盲区里，12 个判据一个都不红。
 * 量法刻意**与材质名无关**：司机室的壁就在眼睛前 1~3 m，外面的世界在 5 m 开外，
 * 所以"该有壁的地方是不是壁"直接就是"这些像素命中的距离是多少"。
 * 列车几何不自己搬：用录制型 renderer 走产品自己的 `TrainView.draw()`，
 * 它交给 GL 什么矩阵，这里就把同样的网格放到同样的位置。 */
{
  const m3n = SH.m3normalFromM4;
  const probe = (id, sHead) => {
    const line = new LineRuntime(SH.LINES[id]);
    const rec = [];
    const rr = {
      cabView: true, beamOn: 0, textures: { sign: null },
      upload(meshes) { return meshes.map(m => ({ mat: m.mat, mesh: m })); },
      dropTag() {}, texFromCanvas() { return {}; },
      draw(b, M) { if (b && b.mesh) rec.push([b.mesh, M]); },
    };
    const tv = new SH.TrainView(rr);
    tv.setLine(line, { add: () => [0, 0, 420, 96] }, [0, 0, 480, 300]);
    rec.length = 0;
    tv.draw(sHead, 0, 4);
    const wb = new SH.Builder();
    for (const [mesh, M] of rec) wb.merge(mesh, M, m3n(M));
    const d = bakeWindow(line, id, sHead - 300, sHead + 700);
    const q = SH.cabShot(line, sHead, {});
    const R = render(makeCam(q.eye, q.target, q.fov, q.up), d.meshes.concat(wb.finish()),
      line.al.groundY(sHead) - 11.3, line.al.frame(sHead).p, 1e9);
    const near = (x0, x1, y0, y1, lim) => {
      let tot = 0, hit = 0;
      for (let y = Math.floor(H * y0); y < Math.ceil(H * y1); y++)
        for (let x = Math.floor(W * x0); x < Math.ceil(W * x1); x++) {
          const k = y * W + x, z = R.zb[k];
          /* 空格子（Infinity）必须算"没命中"。以前 `continue` 跳过它们，
             于是"这一带根本没几何"和"这一带全是司机室的壁"给出同一个 100% ——
             占比类判据的经典空指标。 */
          tot++; if (z !== Infinity && z < lim) hit++;
        }
      return tot ? hit / tot : -1;
    };
    const cabShare = pick(R.hist, m => m === 'cab');
    /* 台面以上、车顶以下这一条带必须是**隔着挡风玻璃看出去**。
       这正是"玻璃下沿 floorY+1.01、台面顶 floorY+0.46，中间空 0.55 m"那个洞的
       直接测量 —— 有洞的那一段会露出外面的世界而不是 glassSoft。 */
    const matIn = (x0, x1, y0, y1, names) => {
      let tot = 0, hit = 0;
      for (let y = Math.floor(H * y0); y < Math.ceil(H * y1); y++)
        for (let x = Math.floor(W * x0); x < Math.ceil(W * x1); x++) {
          const g = R.mb[y * W + x]; tot++;
          if (g !== undefined && g >= 0 && names.indexOf(R.names[g]) >= 0) hit++;
        }
      return tot ? hit / tot : -1;
    };
    const r2 = {
      line: line.name,
      sides: Math.min(near(0, 0.12, 0.50, 0.85, 2.2), near(0.88, 1, 0.50, 0.85, 2.2)),
      bottom: near(0.15, 0.85, 0.86, 1, 2.2),
      glass: matIn(0.25, 0.75, 0.30, 0.72, ['glassSoft', 'window']),
      /* 前向带必须一路量到**台面远缘**（约 y=0.78）为止：
         "台面顶与玻璃下沿之间那 0.55 m 的缝"投影在 y 0.58~0.76，
         第一版只量到 0.62，负控 `glassgap` 直接把缺陷注回去却一条都不红 ——
         判据量错了地方，比没有判据更糟（它会给假绿）。 */
      front: near(0.22, 0.78, 0.12, 0.76, 3.0),
      cabShare,
    };
    let sTot = 0; const cnt = {};
    for (let y = Math.floor(H * 0.5); y < Math.ceil(H * 0.85); y++)
      for (const x of [...Array(Math.floor(W * 0.12)).keys(), ...Array(Math.floor(W * 0.12)).keys().map(i => W - 1 - i)]) {
        const g = R.mb[y * W + x]; if (g === undefined || g < 0) continue;
        sTot++; const nm = R.names[g]; cnt[nm] = (cnt[nm] || 0) + 1;
      }
    r2.sideMats = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => k + ' ' + (100 * v / sTot).toFixed(0) + '%').join('/');
    if (process.env.CAMAP) {
      const gx = 28, gy = 12, x0 = 0.18, x1 = 0.82, y0 = 0.08, y1 = 0.66;
      for (let j = 0; j < gy; j++) {
        let row = '';
        for (let i = 0; i < gx; i++) {
          const x = Math.floor(W * (x0 + (x1 - x0) * i / gx)), y = Math.floor(H * (y0 + (y1 - y0) * j / gy));
          const z = R.zb[y * W + x];
          row += z === Infinity ? ' ' : (z < 3.0 ? '.' : (R.names[R.mb[y * W + x]] || '?')[0]);
        }
        console.log('    |' + row + '|');
      }
    }
    if (process.env.CABLEAK) {
      let xs = [], ys = [], leak = {};
      for (let y = Math.floor(H * 0.12); y < Math.ceil(H * 0.62); y++)
        for (let x = Math.floor(W * 0.22); x < Math.ceil(W * 0.78); x++) {
          const k = y * W + x, z = R.zb[k];
          if (z !== Infinity && z < 3.0) continue;
          const nm = (z === Infinity ? '空' : '远') + ':' + (z === Infinity ? '-' : R.names[R.mb[k]] || '?');
          leak[nm] = (leak[nm] || 0) + 1; xs.push(x); ys.push(y);
        }
      const q = (a, p) => a.length ? (Math.max(...a) - Math.min(...a)) / W : -1;
      console.log(`    [leak ${r2.line}] 漏点数 ${xs.length}  横向跨度 ${(Math.max(...xs) - Math.min(...xs)) / W}  纵向 ${(Math.max(...ys) - Math.min(...ys)) / H}  x ${Math.min(...xs) / W}~${Math.max(...xs) / W}  y ${Math.min(...ys) / H}~${Math.max(...ys) / H}`);
      console.log('    材质 ' + Object.entries(leak).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + ' ' + v).join(', '));
    }
    return r2;
  };
  /* 门槛按实测给：侧壁 100%、台面 93.5~100%、挡风玻璃 40~54%、TCMS 3.6~3.7%。
     挡风玻璃只要求 ≥30% —— 这条带本来就跨"玻璃上沿到车顶"，不是整条都该是玻璃。 */
  let n = 0, worstBottom = 1, worstBottomAt = '', worstFront = 1, worstFrontAt = '';
  for (const id of Object.keys(SH.LINES)) {
    const L = new LineRuntime(SH.LINES[id]);
    const S = L.al.stationS, s = S[0] + (S[S.length - 1] - S[0]) * 0.5;
    const r = probe(id, s);
    n++;
    if (r.bottom < worstBottom) { worstBottom = r.bottom; worstBottomAt = r.line; }
    if (r.front < worstFront) { worstFront = r.front; worstFrontAt = r.line; }
    if (r.sides < 0.95) bad(`cab ${r.line}: 侧壁只有 ${fmt(r.sides)} 的像素落在司机室自身几何上（应 ≥95%）—— 驾驶室没有围住视野，侧带材质 ${r.sideMats}`);
    if (r.bottom < 0.85) bad(`cab ${r.line}: 台面只有 ${fmt(r.bottom)} 在近处（应 ≥85%）—— 相机跑到仪表台前面去了，手柄/圆表都在身后`);
    /* 门槛 0.85 不是"越严越好"：剩下的 10~14% 是**单像素接缝**（玻璃与 A 柱、
       顶棚与玻璃上沿这些几何交界处的采样缝），ASCII 图里整个前向带是密实的 `.`。
       真正的缺陷（台面与玻璃之间空 0.55 m）在这里量到的是远低于 0.85 的数，
       负控 `glassgap` / `utocam` 都必须报红 —— 门槛只要**还能抓住真缺陷**就够了，
       再收紧就是给采样噪声发奖。 */
    if (r.front < 0.85) bad(`cab ${r.line}: 前向带只有 ${fmt(r.front)} 接在 3 m 以内的司机室几何上（应 ≥85%）—— 车体上有缝直接看见外面，侧带材质 ${r.sideMats}`);
    if (r.glass < 0.35) bad(`cab ${r.line}: 台面与车顶之间只有 ${fmt(r.glass)} 是挡风玻璃（应 ≥35%）—— 玻璃没接住这条带，司机在仪表台高度直接看见外面`);
    if (r.cabShare < 0.02) bad(`cab ${r.line}: TCMS 屏只占画面 ${fmt(r.cabShare)}（应 ≥2%）—— 那块会变的屏玩家看不见`);
  }
  console.log(`  驾驶室机位 ${n} 条线：台面最差 ${fmt(worstBottom)}（${worstBottomAt}）、前向接住最差 ${fmt(worstFront)}（${worstFrontAt}）`);
}

console.log(fail ? `\n合计问题 ${fail}` : '\n✓ 每个观景机位的画面内容都达标');
process.exitCode = fail ? 1 : 0;
