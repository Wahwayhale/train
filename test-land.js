require('./stub-dom.js');
for (const f of ['core','mesh','renderer','textures','align','world','train','landmark']) require('./src/'+f+'.js');
require('./data/shanghai.js');
const SH=global.SH;
const stations=['A','B','C','D','E'], gaps=[1800,1800,1800,1800];
const al=SH.buildLineAlignment(stations,gaps,7);
const kinds=Object.keys(SH.landmarks.BUILDERS);
console.log('地标类型:', kinds.join(' '));
for(const k of kinds){
  try{
    const b=new SH.Builder(); b._installLight&&b._installLight();
    const ok=SH.landmarks.place(b, al, 2200, 1, 1000, k);
    const g=b.finish();
    const v=g.reduce((t,x)=>t+x.verts,0), tr=g.reduce((t,x)=>t+x.count/3,0);
    let bad=0; for(const m of g) for(let i=0;i<m.pos.length;i++) if(!isFinite(m.pos[i])) bad++;
    console.log(`${k.padEnd(10)} placed=${ok}  ${v}v / ${tr}t / ${g.length}批  ${bad?'NaN!!'+bad:''}  y:[${Math.min(...g.flatMap(m=>Array.from({length:m.verts},(_,i)=>m.pos[i*3+1]))).toFixed(0)}, ${Math.max(...g.flatMap(m=>Array.from({length:m.verts},(_,i)=>m.pos[i*3+1]))).toFixed(0)}]`);
  }catch(e){ console.log(`${k} FAIL ${e.message}`); }
}

/* ================= 侵入检测：地标不许压到线路上 =================
 * 港区那次翻车（观景相机开进了一面贴着镜头的铁皮墙）说明：光看顶点数、
 * 看不看得到，都不足以证明地标放对了位置。真正的不变量是——
 * 除"跨江/跨河"这类天生要横穿线路的构件外，任何地标几何都不得出现在
 * 轨面高度、且距线路中心 12 m 以内。
 */
const CROSS = SH.landmarks.CROSS_KINDS;
let viol = 0;
for (const k of kinds) {
  const b = new SH.Builder();
  const rec = SH.landmarks.place(b, al, 2200, 1, 700, k);
  if (!rec) { console.log(k, '放置失败'); continue; }
  const S = [];
  for (let s = 2200 - 1600; s <= 2200 + 1600; s += 20) S.push(al.frame(s));
  let minLat = Infinity, atP = null;
  for (const m of b.finish()) {
    const P = m.pos;
    for (let i = 0; i < m.verts; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      let best = null, bd = Infinity;
      for (const fr of S) { const d = (fr.p[0] - x) ** 2 + (fr.p[2] - z) ** 2; if (d < bd) { bd = d; best = fr; } }
      if (!best) continue;
      const dy = (x - best.p[0]) * best.u[0] + (y - best.p[1]) * best.u[1] + (z - best.p[2]) * best.u[2];
      if (dy < -3) continue;                       // 轨面以下的（水面、桥下）不算侵入
      const lat = (x - best.p[0]) * best.r[0] + (y - best.p[1]) * best.r[1] + (z - best.p[2]) * best.r[2];
      if (Math.abs(lat) < minLat) { minLat = Math.abs(lat); atP = [x, y, z, dy]; }
    }
  }
  const need = CROSS[k] ? -1 : 12;
  const ok = minLat >= need;
  if (!ok) viol++;
  console.log(`${k.padEnd(10)} ${CROSS[k] ? '跨线类(允许横穿)' : '侧景类'}  最近横向距离 ${minLat.toFixed(1)} m  ${ok ? '✓' : '✗ 侵入线路'}`);
}
console.log(viol ? `\n✗ ${viol} 个地标侵入线路` : '\n✓ 无地标侵入线路限界');

/* ================== 楼体不得互相穿插 ==================
 * 高架两侧的城市以前是**世界轴对齐**的盒子，而槽位只有 17 m、边长最大 24 m，
 * 曲线上相邻两栋必然重叠 —— 画面上不是"两栋楼"，而是斜视角下看起来
 * 扭成蝴蝶结的**一栋**。这种缺陷靠截图很难发现（它看起来像建模风格），
 * 所以让生成器自己记下 footprint，测试用 OBB 分离轴直接判。
 */
console.log('\n【楼体互穿检查】');
(function cityOverlap() {
  /* 用本文件已有的合成线路，不引入 game.js：city() 只需要 al 与 cfg。
     多换几个种子，覆盖直线段与曲线段。 */
  let badTot = 0, lotTot = 0;
  for (const seed of [11, 202, 3003, 41, 707]) {
    const wb = new SH.WorldBuilder({
      al, color: '#f00', color2: '#00f', stations,
      sign: new SH.textures.SignAtlas(256), night: 0.62,
    });
    wb.sun = null; wb._installLight();
    wb.city(0, al.total, seed);
    wb.farCity(0, al.total);          // 远景盒体城市也要一起判交（它同样登记 cityLots）
    wb.b.finish();
    const lots = wb.cityLots;
    lotTot += lots.length;
    // 分离轴：两个旋转矩形在 xz 平面上是否相交（留 0.6 m 余量，贴在一起也算穿）
    const corners = L => {
      const c = Math.cos(L.yaw), s2 = Math.sin(L.yaw);
      const ax = [c, s2], az = [-s2, c];            // 局部 x / z 在世界 xz 的朝向
      const pts = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) pts.push([
        L.x + ax[0] * L.hw * sx + az[0] * L.hd * sz,
        L.z + ax[1] * L.hw * sx + az[1] * L.hd * sz]);
      return { pts, axes: [ax, az] };
    };
    const pre = lots.map(corners);
    let bad = 0;
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) {
        const dx = lots[i].x - lots[j].x, dz = lots[i].z - lots[j].z;
        if (dx * dx + dz * dz > 1600) continue;      // 40 m 外不可能相交
        const A = pre[i], B = pre[j];
        let sep = false;
        for (const box of [A, B]) for (const ax of box.axes) {
          let minA = 1e9, maxA = -1e9, minB = 1e9, maxB = -1e9;
          for (const p of A.pts) { const t = p[0] * ax[0] + p[1] * ax[1]; if (t < minA) minA = t; if (t > maxA) maxA = t; }
          for (const p of B.pts) { const t = p[0] * ax[0] + p[1] * ax[1]; if (t < minB) minB = t; if (t > maxB) maxB = t; }
          if (maxA < minB + 0.6 || maxB < minA + 0.6) { sep = true; break; }
        }
        if (!sep) {
          bad++;
          if (bad <= 2) console.log(`  ✗ seed=${seed} 两栋楼穿插：(${lots[i].x.toFixed(0)},${lots[i].z.toFixed(0)}) 与 (${lots[j].x.toFixed(0)},lots[j].z) 尺寸 ${lots[i].hw * 2}×${lots[i].hd * 2}`.replace('lots[j].z', lots[j].z.toFixed(0)));
        }
      }
    }
    badTot += bad;
    console.log(`  seed ${String(seed).padEnd(5)} ${String(lots.length).padStart(4)} 栋楼，重叠 ${bad} 对 ${bad ? '✗' : '✓'}`);
  }
  console.log(badTot ? `
✗ 共 ${badTot} 对楼体互相穿插（合计 ${lotTot} 栋）` : `
✓ ${lotTot} 栋楼两两不穿插`);
  if (badTot) process.exitCode = 1;
})();

/* ================= 影向随太阳（视觉方案 1.3 / Phase B）=================
 * 以前 SHADOW_DIR 写死黄昏：白天开一局，太阳挂在天上，楼影却仍往黄昏方向倒 ——
 * 影与光是拧着的，而既有判据全绿（谁也没量过影与太阳的夹角）。
 * 判据分两层，全部量**烘焙出来的几何**（顶点位移方向），不读源码常量：
 *   ① 单点：SH.shadowDirOf(太阳) 与旧口径 SH.SHADOW_DIR_DUSK 在 dusk 输入下
 *      逐分量一致（缺省档 = 旧口径，既有判据与基线零扰动的依据）；
 *   ② 几何：同一 synthetic 线路烘两个世界（dusk 与 day 的太阳方位差 ~90°），
 *      各取若干"同源落影块对"（_shadow 的 rubber 面 + 桥面投影带），量每对
 *      块心连线在 xz 平面的方向 —— 它必须与两档 shadowDirOf 的差向量同向
 *      （夹角 < 30°）。量几何而不是量 cfg，是因为"cfg 传了但 _shadow 没读"
 *      恰恰是这一族缺陷的静默形态。
 */
(function shadowDir() {
  const errs = [];
  /* ① 单点 + 缺省一致性 */
  const duskDir = SH.shadowDirOf(SH.ENVS.dusk.sunDir);
  const D0 = SH.SHADOW_DIR_DUSK;
  if (!duskDir || Math.hypot(duskDir[0], duskDir[1]) < 0.999 || Math.hypot(duskDir[0], duskDir[1]) > 1.001)
    errs.push('shadowDirOf 不返回单位向量（' + duskDir + '）');
  if (Math.abs(duskDir[0] - D0[0]) > 1e-9 || Math.abs(duskDir[1] - D0[1]) > 1e-9)
    errs.push('缺省档口径漂移：shadowDirOf(dusk) ≠ SHADOW_DIR_DUSK —— 既有基线会被无谓推动');
  const nightDir = SH.shadowDirOf(SH.ENVS.night.sunDir);
  if (nightDir[0] === duskDir[0] && nightDir[1] === duskDir[1])
    errs.push('不同太阳给同一个影向 —— 单点在恒等返回');

  /* ② 几何量向：烘两档，量落影块对的位移方向 */
  const bakeShadowCenters = sunDir => {
    const wb = new SH.WorldBuilder({
      al, color: '#f00', color2: '#00f', stations,
      sign: new SH.textures.SignAtlas(256), night: 0.62, sunDir,
    });
    wb.sun = null; wb._installLight();
    wb.city(0, al.total, 42);          // 沿街楼群（_shadow 的主消费者）
    const g = wb.b.finish();
    /* rubber 面片：_shadow 的每一片落影都是 faces:[2] 的 0.02 m 薄盒 ——
       取"每 4 个顶点一个块"的近似（box 面），块心 = 顶点均值。 */
    const centers = [];
    for (const m of g) {
      if (m.mat !== 'rubber') continue;
      const P = m.pos;
      for (let i = 0; i + 3 < m.verts; i += 4) {
        let x = 0, z = 0;
        for (let k = 0; k < 4; k++) { x += P[(i + k) * 3]; z += P[(i + k) * 3 + 2]; }
        centers.push([x / 4, z / 4]);
      }
    }
    return centers;
  };
  const cDusk = bakeShadowCenters(SH.ENVS.dusk.sunDir);
  const cDawn = bakeShadowCenters(SH.ENVS.dawn.sunDir);
  if (cDusk.length < 8 || cDusk.length !== cDawn.length)
    errs.push('落影块数量异常（dusk ' + cDusk.length + ' / dawn ' + cDawn.length + '）—— 两档烘焙不同构，量向没法做');
  else {
    /* 成对块心的位移方向：dusk→dawn 的移动必须与两档影向的差同向。
       块按生成顺序一一对应（同源 footprint、同 steps），排序稳定。
       选 dusk↔dawn（影向差 0.32）而不是 dusk↔day（0.20）—— ENVS 四档的
       太阳方位都集中在西半边（投影口的历史口径），分辨力取最大的一对。 */
    const sd = SH.shadowDirOf(SH.ENVS.dusk.sunDir), sy = SH.shadowDirOf(SH.ENVS.dawn.sunDir);
    const dxT = sy[0] - sd[0], dzT = sy[1] - sd[1];
    const tLen = Math.hypot(dxT, dzT);
    if (tLen < 0.25) errs.push('两档太阳的影向差太小（' + tLen.toFixed(3) + '）—— 判据没有分辨力');
    else {
      let aligned = 0, total = 0, cosSum = 0, blocks = cDusk.length;
      for (let i = 0; i < cDusk.length; i++) {
        const dx = cDawn[i][0] - cDusk[i][0], dz = cDawn[i][1] - cDusk[i][1];
        const l = Math.hypot(dx, dz);
        if (l < 0.5) continue;                     // 位移接近零的块不参与统计
        total++;
        const cos = (dx * dxT + dz * dzT) / (l * tLen);
        cosSum += cos;
        if (cos > Math.cos(Math.PI / 6)) aligned++; // 夹角 < 30°
      }
      if (total < 8) errs.push('可统计的位移块只有 ' + total + ' 个（应 ≥8 —— 量向判据样本不足）');
      /* 移动占比：影向真的跟随太阳时，几乎所有落影块都会挪位（实测 5289/5293）。
         影向写死时只剩零头在动（别的 rubber 几何在两档间的噪声位错）——
         这条把"方向对但其实是别的几何在动"的假绿挡掉。 */
      else if (total < blocks * 0.5) errs.push(`落影块只有 ${total}/${blocks} 个在动（应过半）—— 影向没跟着太阳走，移动的是别的几何`);
      else if (aligned < total * 0.8) errs.push('落影块的位移只有 ' + aligned + '/' + total + ' 与影向差同向（<30°）—— 影没有跟着太阳走');
      else console.log(`  ✓ 影向随太阳：${total}/${blocks} 块落影位移均值 cos ${(cosSum / total).toFixed(3)}（同向占比 ${(aligned / total * 100) | 0}%），dusk→dawn 的影向差 ${(tLen).toFixed(2)}`);
    }
  }
  if (errs.length) { for (const e of errs) console.log('  ✗ ' + e); process.exitCode = 1; }
  else console.log('  ✓ 影向单点：单位向量 · 缺省档与旧口径逐分量一致 · 夜/昏不同向');
})();
