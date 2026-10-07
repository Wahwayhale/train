/* ============================================================================
 * test-tex.js — 程序化贴图的质量判据（第 19 个自测）
 *
 * 为什么单独一个文件：既有 18 个套件**全部只量几何**（顶点、绕序、横向区间），
 * 对贴图一个字都没说 —— 把 BUILDERS 里任何一张贴图换成 `() => cv(2, 2)`，
 * 18 个套件照样全绿。而"贴图精致"恰恰是能一眼看出来、却一条判据都盖不住的东西。
 *
 * 三条判据都是**结构**而不是口味：
 *   ① **可无缝平铺**：贴图在 x=0 与 x=S−1（平铺时相邻）的逐通道差，必须和
 *      "图内部相邻两列"的差在同一量级。这条是真的 —— 噪声用"网格取模 + 双线性"
 *      生成就是为了它；一旦有人把取模换成钳位（或换成逐像素随机），平铺处会裂开。
 *   ② **结构件数**：磨光花岗岩一个循环里恰好 4 条纵缝 / 4 条横缝（4×4 块板）。
 *      量的是"缝的条数"，所以"把 4 块改成 3 块"这种改法当场报红。
 *   ③ **UV 各向同性**（从**烘焙出来的网格**量，不是读源码）：站台板花岗岩顶面上
 *      "沿线路每米的 U 增量"与"横向每米的 V 增量"必须落在同一个米/循环上。
 *      旧版是 uvAlong=1/1.2 + vSpan=1 → 两个方向差 **15.7 倍**，600 mm 方砖被拉成
 *      顺着股道的长条（截图里地面就是一片条纹）。
 *
 * 反向验证（三条必须报红，见 dev/negctl.js 的 texwrap / texflat / texvspan）：
 *   texwrap   把 tileNoise 的取模换成钳位 → 全部贴图不再可平铺
 *   texflat   花岗岩一个循环 4 块板改成 3 块 → ② 报红
 *   texvspan  站台板 vSpan 退回 1 → ③ 报红
 * 用法：node test-tex.js
 * ==========================================================================*/
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
const srcTxt = require('fs').readFileSync('./src/game.js', 'utf8');
const grab = name => { const i = srcTxt.indexOf('class ' + name); let d = 0; for (let k = srcTxt.indexOf('{', i); k < srcTxt.length; k++) { if (srcTxt[k] === '{') d++; else if (srcTxt[k] === '}') { d--; if (!d) return srcTxt.slice(i, k + 1); } } };
Object.assign(global, { CAR_GAP: 0.35, MODES: { manual: {} }, Builder: SH.Builder, Geo: SH.Geo,
  ...Object.fromEntries(Object.keys(SH).map(k => [k, SH[k]])),
  C: SH.clamp, cross: SH.Geo.cross, norm3: SH.Geo.norm3 });
const LineRuntime = eval('(' + grab('LineRuntime') + ')');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  ✗ ' + msg); } return cond; };

/* ---------------------------------------------------------- ① 无缝平铺 */
console.log('—— 贴图质量（第 19 个自测）——');
console.log('① 精确周期（f(0,y) 必须等于 f(size,y)）—— 这张图能不能平铺');
{
  /* 只看画出来的那一张图判不出周期性：非周期项只要在接缝上恰好和图内某条强边
     一样陡，"比图内最大差"就放它过去。所以直接问**生成函数**本身 ——
     `SH.textures.lastPaint()` 是 `paint()` 留的诊断口。 */
  const names = Object.keys(SH.textures.BUILDERS).filter(n => n !== 'white');
  /* 车窗的 V 是"窗高"（一张贴图正好贴一扇窗，调用点从不沿 V 平铺），
     所以纵向不查它。 */
  const NO_V_TILE = { window: 1 };
  let tested = 0;
  for (const n of names) {
    const c = SH.textures.BUILDERS[n]();
    const lp = SH.textures.lastPaint();
    if (!lp.fn || lp.size !== c.width) { console.log(`  · ${n}（${c.width}²）不走 paint()，跳过周期检验`); continue; }
    const S = c.width, H = c.height;
    const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    let badX = 0, badY = 0;
    for (let k = 0; k < 8; k++) {
      const y = Math.floor((k + 0.5) * H / 8);
      if (diff(lp.fn(0, y, 0, y / H), lp.fn(S, y, 1, y / H)) > 0.5) badX++;
      const x = Math.floor((k + 0.5) * S / 8);
      if (!NO_V_TILE[n] && diff(lp.fn(x, 0, x / S, 0), lp.fn(x, H, x / S, 1)) > 0.5) badY++;
    }
    tested++;
    ok(badX === 0, `${n} 横向不周期：8 个采样里有 ${badX} 个 f(0,y) ≠ f(size,y) —— 平铺处会裂开一条缝`);
    ok(badY === 0, `${n} 纵向不周期：8 个采样里有 ${badY} 个 f(x,0) ≠ f(x,size) —— 平铺处会裂开一条缝`);
  }
  if (!fails) console.log(`  ✓ ${tested} 张贴图的生成函数在横/纵两个方向上都满足 f(0)=f(size)`);
}

/* ---------------------------------------------------------- ② 结构件数 */
console.log('② 结构件数（花岗岩一个循环恰好 4×4 块板）');
{
  const c = SH.textures.BUILDERS.granite();
  const S = c.width;
  const d = c.getContext('2d').getImageData(0, 0, S, S).data;
  const lum = (x, y) => { const o = (y * S + x) * 4; return d[o] + d[o + 1] + d[o + 2]; };
  /* 先做 7 px 环形滑动平均压掉矿物颗粒的噪声（缝有 4 px 宽，活得下来），
     再用"该行最小 + (最大−最小)×0.38"当阈值数暗谷 —— 不依赖某个绝对亮度。 */
  const smooth = (sample, N) => { const o = []; for (let k = 0; k < N; k++) { let s = 0; for (let t = -3; t <= 3; t++) s += sample(((k + t) % N + N) % N); o.push(s / 7); } return o; };
  /* 数**局部极小**（比 ±12 px 邻域都暗、且低于阈值）而不是数"暗区段"：
     段计数会被"缝正好跨在贴图边界上"这种情形多算一条。 */
  const runs = (sample, N) => {
    const a = smooth(sample, N); let mn = 1e9, mx = -1;
    for (const v of a) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const th = mn + (mx - mn) * 0.30;
    let n = 0;
    for (let k = 0; k < N; k++) {
      if (a[k] >= th) continue;
      let isMin = true;
      for (let t = -12; t <= 12; t++) if (t && a[((k + t) % N + N) % N] <= a[k] - 0.5) { isMin = false; break; }
      if (isMin) n++;
    }
    return n;
  };
  const rowJoints = runs(k => lum(k, 128), S);          // 沿 i 扫一行
  const colJoints = runs(k => lum(128, k), S);          // 沿 j 扫一列
  ok(rowJoints === 4, `花岗岩沿线路方向一个循环有 ${rowJoints} 条缝，应为 4（4×4 块板）—— 板数被改了`);
  ok(colJoints === 4, `花岗岩横向一个循环有 ${colJoints} 条缝，应为 4（4×4 块板）—— 板数被改了`);
  if (rowJoints === 4 && colJoints === 4) console.log('  ✓ 花岗岩：一个循环 4×4 块板（缝的条数量出来是 4/4）');
}

/* ---------------------------------------------- ③ 站台板 UV 各向同性（从网格量） */
console.log('③ 站台板花岗岩的 UV 各向同性（从烘焙出来的网格量，不读源码）');
{
  const line = new LineRuntime(SH.LINES.l1);
  let si = -1;
  for (let i = 1; i < line.stations.length - 1; i++)
    if (!line.isElevated(line.al.stationS[i]) && SH.platType(line.stations[i]) === 'island') { si = i; break; }
  ok(si >= 0, 'l1 找不到地下岛式站（站台板 UV 无处可量）');
  if (si >= 0) {
    const al = line.al, ss = al.stationS[si];
    const wb = new SH.WorldBuilder({ al, color: line.color, color2: line.color2, stations: line.stations,
      sign: new SH.textures.SignAtlas(1024), night: 0.62, profile: line.profile });
    wb.sun = null; wb._installLight();
    SH.WorldBuilder.buildRuns(wb, line, Math.max(0, ss - 170), Math.min(al.total, ss + 60), null);
    const b = wb.b.buckets.get('granite');
    ok(!!b, '烘焙里没有 granite 批次（站台板没铺？）');
    if (b) {
      const f = al.frame(ss), c = f.p, side = line.stationSide(si);
      /* 站台板**顶面**的顶点：法向朝上、标高 ≈ 0.42 */
      /* 只取**岛体板**（lat < −1.5）顶面的顶点：走廊地坪也是 granite、标高同样
         0.42，但它是**另一次 sweep**（V 从 0 重新起算），混进来会量到跨 sweep 的
         假 Δv。法向不用筛 —— 顶面的角点法向是"顶面与侧面的角平分线"（ny≈0.71），
         筛 ny>0.9 会把它们全丢掉（第一版就是这么量到 0 对的）。 */
      const T = [];
      for (let i = 0; i < b.pos.length; i += 3) {
        const d3 = [b.pos[i] - c[0], b.pos[i + 1] - c[1], b.pos[i + 2] - c[2]];
        const up = d3[0] * f.u[0] + d3[1] * f.u[1] + d3[2] * f.u[2];
        if (Math.abs(up - 0.42) > 0.05) continue;
        const along = d3[0] * f.f[0] + d3[1] * f.f[1] + d3[2] * f.f[2];
        const lat = (d3[0] * f.r[0] + d3[1] * f.r[1] + d3[2] * f.r[2]) * side;
        if (lat > -1.5 || lat < -11) continue;
        T.push({ along, lat, u: b.uv[i / 3 * 2], v: b.uv[i / 3 * 2 + 1] });
      }
      ok(T.length >= 8, `站台板顶面顶点只有 ${T.length} 个（法向朝上、标高 0.42）—— 量不到 UV`);
      if (T.length >= 8) {
        /* 沿线路：取两对"同 lat、不同 along"的点 → du/dalong */
        let du = 0, n1 = 0;
        const byLat = {};
        for (const q of T) { const k = q.lat.toFixed(2); (byLat[k] || (byLat[k] = [])).push(q); }
        for (const k in byLat) {
          const a = byLat[k].slice().sort((p, q) => p.along - q.along);
          for (let i = 1; i < a.length; i++) { const dl = a[i].along - a[i - 1].along, dU = a[i].u - a[i - 1].u; if (Math.abs(dl) > 1) { du += Math.abs(dU / dl); n1++; } }
        }
        /* 横向：取两对"同 along、不同 lat"的点 → dv/dlat */
        let dv = 0, n2 = 0;
        const byAl = {};
        for (const q of T) { const k = q.along.toFixed(2); (byAl[k] || (byAl[k] = [])).push(q); }
        for (const k in byAl) {
          const a = byAl[k].slice().sort((p, q) => p.lat - q.lat);
          for (let i = 1; i < a.length; i++) { const dl = a[i].lat - a[i - 1].lat, dV = a[i].v - a[i - 1].v; if (Math.abs(dl) > 0.5) { dv += Math.abs(dV / dl); n2++; } }
        }
        const gu = n1 ? du / n1 : 0, gv = n2 ? dv / n2 : 0;
        ok(gu > 0 && gv > 0, `量不到 UV 梯度（沿线路 ${n1} 对、横向 ${n2} 对）`);
        if (gu > 0 && gv > 0) {
          const r = Math.max(gu, gv) / Math.min(gu, gv);
          ok(r <= 1.25, `站台板 UV 各向异性 ${r.toFixed(2)}×（沿线路 ${gu.toFixed(3)} 循环/m、横向 ${gv.toFixed(3)} 循环/m）—— 方砖被拉成长条，uvAlong 与 vSpan 没落在同一个米/循环上`);
          ok(gu > 0.2 && gu < 1.0, `站台板 UV 尺度 ${gu.toFixed(3)} 循环/m 不在合理区间（0.2~1.0）—— 贴图在站台上被放大/缩小得不像 600 mm 砖`);
          if (r <= 1.25) console.log(`  ✓ 站台板：沿线路 ${gu.toFixed(3)} / 横向 ${gv.toFixed(3)} 循环/m（各向异性 ${r.toFixed(2)}×，600 mm 板 ≈ ${(1 / (gu * 4)).toFixed(2)} m）`);
        }
      }
    }
  }
}

console.log(fails ? `\n✗ ${fails} 条贴图判据未通过` : '\n✓ 贴图判据：可无缝平铺、结构件数、站台板 UV 各向同性');
process.exitCode = fails ? 1 : 0;
