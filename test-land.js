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
