/**
 * 绕序检查：三角形的**几何朝向**（由顶点顺序按右手定则给出）必须和
 * 它的**着色法向**同侧。
 *
 * 为什么这条不变量值一个独立文件：GL 默认 frontFace(CCW) + cullFace(BACK)，
 * 绕序反了的三角形不是"光照错了"，而是**整个被剔除掉**——它不会报错、
 * 不会变黑，只是从那个方向彻底消失。这类 bug 的表现极其难猜：
 *   · 盒子的顶面和底面曾经都是朝内翻的（立面是对的，所以平时看不出来）
 *   · 跟随相机的远景地面从来没被画出来过 → 所有"楼悬在半空、地上什么都没有"
 *   · 两点截面的街面要靠 sweep 的 flip 才看得见
 * 全是同一个根因的四种症状。逐三角形一比就全部现形。
 *
 * 用法：node test-wind.js [线路id,...]
 */
require('./stub-dom.js');
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio', 'landmark', 'game']) require('./src/' + f + '.js');
require('./data/shanghai.js');
const SH = global.SH;
const VIEWSPOTS = SH.VIEWSPOTS, LineRuntime = SH.LineRuntime;
if (!LineRuntime) { console.log('✗ game.js 未导出 LineRuntime'); process.exit(1); }

const EXEMPT = m => { const d = SH.MATERIALS[m]; return !!(d && (d.cullOff || d.blend)); };

/** 三角形的几何朝向与着色法向是否同侧（false = 这一面会被背面剔除掉） */
function agrees(P, N, a, b, c) {
  const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
  const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
  const gx = e1[1] * e2[2] - e1[2] * e2[1], gy = e1[2] * e2[0] - e1[0] * e2[2], gz = e1[0] * e2[1] - e1[1] * e2[0];
  const gl2 = Math.hypot(gx, gy, gz);
  if (gl2 < 1e-6) return null;                       // 退化，不计
  const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-6) return null;
  return (gx * nx + gy * ny + gz * nz) >= 0;
}

/* ------------------ 调用点归因：把"反向三角形"报到具体是哪一行代码造的 ------------------
 * 光有材质统计没法修——`paint` 有 15 万个反向三角形，但它是二十个不同构件凑出来的。
 * 这里把 Builder 的每个几何方法包一层，只检查本次调用新增的那批索引，
 * 再从调用栈里取出 world.js / landmark.js / train.js 的行号。
 * 于是报告直接指向"哪个构件的截面法向或 flip 写错了"。 */
const perSite = new Map();
(function installAttribution() {
  const names = ['sweep', 'box', 'plate', 'panel', 'cylY', 'cylZ', 'loft', 'quadPts', 'ringStack', 'sphere', 'strut', 'merge'];
  for (const nm of names) {
    const orig = SH.Builder.prototype[nm];
    if (!orig) continue;
    SH.Builder.prototype[nm] = function (...args) {
      const st = (new Error().stack || '').split('\n').slice(1);
      const hit = st.filter(l => /(world|landmark|train|game)\.js/.test(l))[0] || '?';
      const m = hit.match(/at ([\w$]*) \(([^()/]+):(\d+):/) || hit.match(/([^()/]+):(\d+):/);
      const where = m ? ((m[1] || '?') + ' @ ' + (m[2] || '?') + ':' + (m[3] || '?')) : hit.trim().slice(-46);
      const before = new Map();
      for (const [k, b2] of this.buckets.entries()) before.set(k, b2.idx.length);
      const r = orig.apply(this, args);
      for (const [k, b2] of this.buckets.entries()) {
        const from = before.get(k) || 0;
        if (b2.idx.length === from || EXEMPT(k)) continue;
        const P = b2.pos, N = b2.nrm, X = b2.idx;
        let bad = 0, n = 0;
        for (let t = from; t + 2 < X.length; t += 3) {
          const ok = agrees(P, N, X[t], X[t + 1], X[t + 2]);
          if (ok === null) continue;
          n++; if (!ok) bad++;
        }
        if (bad) {
          const key = k + ' · ' + nm + ' · ' + where;
          const v = perSite.get(key) || [0, 0];
          v[0] += bad; v[1] += n; perSite.set(key, v);
        }
      }
      return r;
    };
  }
})();

function scan(batches, tag, per) {
  for (const g of batches) {
    if (EXEMPT(g.mat)) continue;                 // 双面材质不参与检查
    const P = g.pos, N = g.nrm, X = g.idx;
    for (let t = 0; t + 2 < X.length; t += 3) {
      const a = X[t], b = X[t + 1], c = X[t + 2];
      const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const gx = e1[1] * e2[2] - e1[2] * e2[1], gy = e1[2] * e2[0] - e1[0] * e2[2], gz = e1[0] * e2[1] - e1[1] * e2[0];
      const gl2 = Math.hypot(gx, gy, gz);
      if (gl2 < 1e-6) continue;                  // 退化三角形，朝向无意义
      let nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-6) continue;
      const d = (gx * nx + gy * ny + gz * nz) / (gl2 * nl);
      const r = per.get(g.mat) || { n: 0, bad: 0, worst: 2, at: null };
      r.n++;
      if (d < 0) {
        r.bad++;
        if (d < r.worst) { r.worst = d; r.at = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]]; }
      }
      per.set(g.mat, r);
    }
  }
}

const ids = (process.argv[2] || 'l3,l6,l17,ml,l1').split(',');
const per = new Map();
for (const id of ids) {
  if (!SH.LINES[id]) { console.log('无此线路 ' + id); continue; }
  const line = new LineRuntime(SH.LINES[id]);
  const al = line.al;
  const wb = new SH.WorldBuilder({
    al, color: line.color, color2: line.color2, stations: line.stations,
    sign: new SH.textures.SignAtlas(512), night: 0.62, profile: line.profile,
  });
  wb.sun = null; wb._installLight();
  const b = wb.b;
  // 远景地面（game.js 的 World._makeGround 同款几何）单独烘一份一起查
  {
    const g = new SH.Builder(), S = 1400, N = 14, cell = (S * 2) / N;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = -S + cell * (i + 0.5), z = -S + cell * (j + 0.5);
      g.plate([x, 0, z], [cell, 0, 0], [0, 0, cell], [0, 1, 0], SH.rgbOf('#b9c3cc'), { mat: 'aerial', uv: 1 / 400, uv0: [x / 400, z / 400], emi: 0.16 });
    }
    scan(g.finish(), 'ground', per);
  }
  /* 几何序列用 SH.WorldBuilder.buildRuns —— 与游戏侧 bake 同一份实现。
     以前这里自己复刻了一遍 if/else，结果"只改 game.js 的新几何"永远不会
     被这条判据看到（停车基地那一次就是这么漏的）。 */
  SH.WorldBuilder.buildRuns(wb, line, 0, al.total, null);
  for (const sp of (VIEWSPOTS[id] || [])) {
    const ss = line.stationSAt(sp.i);
    if (ss == null || !line.isElevated(ss)) continue;
    SH.landmarks.place(b, al, ss, sp.side == null ? 1 : sp.side, sp.dist == null ? 900 : sp.dist, sp.kind);
  }
  scan(b.finish(), id, per);
}

const rank = [...per.entries()].sort((x, y) => (y[1].bad / Math.max(1, y[1].n)) - (x[1].bad / Math.max(1, x[1].n)));
let tot = 0, bad = 0;
console.log('材质            三角形      绕序反了      比例   最反的那个三角形位置');
for (const [m, r] of rank) {
  tot += r.n; bad += r.bad;
  if (!r.bad) continue;
  console.log(`  ${m.padEnd(12)} ${r.n.toLocaleString().padStart(9)} ${r.bad.toLocaleString().padStart(9)} ${(100 * r.bad / r.n).toFixed(1).padStart(6)}%  dot=${r.worst.toFixed(2)} @ (${r.at ? r.at.map(v => v.toFixed(0)).join(',') : '-'})`);
}
const clean = rank.filter(([, r]) => r.bad).length;
console.log(`\n共 ${tot.toLocaleString()} 个三角形，绕序与法向相反的 ${bad.toLocaleString()} 个，涉及 ${clean} 种材质`);

/* ---------------- 棘轮：这些数字只许降、不许升 ----------------
 * 剩下的反向三角形几乎全部来自 sweep 家族（隧道衬砌、轨道、站台、幕墙竖梃）：
 * 它们的绕序天生朝"看得到的一侧"，而截面给的 nx/ny 指向背面——
 * 改绕序会让这些面直接被剔除（整条隧道消失），所以正确的修法是逐处把
 * 截面法向翻过来，那是个要一个画面一个画面验的独立工程。
 * 在那之前：着色器已经把法向扳向观察者（renderer.js 的双面着色），
 * 实时光照不再拧着；而这张表保证"反向面积"不会因为随手新增几何而变大。 */
const DEFAULT_IDS = 'l3,l6,l17,ml,l1';
/* 2026-10-01：基线清空。修完 隧道衬砌法向 / 盒体顶底面绕序 / plate 与 panel 绕序跟随法向 /
 * 街面标线与绿化带的对称截面 / 薄板截面逐段法向 / cutCover 断面 / lakeDisc 扇形顺序 /
 * ringStack 与 cylY 的筒身绕序 / m3normalFromM4 抄错成逆矩阵（不是逆转置）
 * 之后，4,772,770 个三角形里反向数 = 0。
 * 历史轨迹：1,462,004 → 485,707 → 190,123 → 44,395 → 12,648 → 300 → 0。
 * 现在任何一处反向都会直接失败——包括新加的几何。 */
const BASELINE = {};
/* 这些必须是 0：修好的、且没有理由再退回去的几何 */
const ZERO = ['aerial', 'roof', 'brick', 'rubber', 'ballast', 'segment', 'foliage', 'granite', 'tiles', 'sign', 'paint', 'concrete', 'concreteD', 'portal', 'steel', 'metal', 'glass', 'water', 'bldgWin', 'bldgWin2', 'bldgWin3', 'light'];
let rc = 0;
if ((process.argv[2] || DEFAULT_IDS) !== DEFAULT_IDS) {
  console.log('（指定了线路子集，跳过棘轮比对，只做测量）');
} else {
  for (const [m, want] of Object.entries(BASELINE)) {
    const got = (per.get(m) || { bad: 0 }).bad;
    if (got > want) { rc = 1; console.log(`✗ ${m} 反向三角形 ${got} > 基线 ${want}（新增了几何绕序反了）`); }
  }
  for (const m of ZERO) {
    const got = (per.get(m) || { bad: 0 }).bad;
    if (got) { rc = 1; console.log(`✗ ${m} 有 ${got} 个反向三角形——这类几何必须绕序与法向一致`); }
  }
  const seen = new Set(per.keys());
  for (const m of seen) {
    const got = (per.get(m) || { bad: 0 }).bad;
    if (got && !(m in BASELINE)) { rc = 1; console.log(`✗ 新材质 ${m} 出现 ${got} 个反向三角形，要么修绕序要么显式登记基线`); }
  }
}
if (!bad) console.log('✓ 所有会参与背面剔除的几何，绕序都与着色法向同侧');
else console.log(rc ? '✗ 绕序棘轮被突破' : `✓ 绕序债务未扩大（仍有 ${bad.toLocaleString()} 个反向三角形待逐处修）`);

/* 反向三角形按"哪个调用点造的"归因——材质统计只能证明有没有变坏，
   这一张表才指得出下一步该改哪一行。 */
if (perSite.size) {
  console.log('\n反向三角形来源 Top10（材质 · 生成方法 · 调用点）：');
  [...perSite.entries()].sort((x, y) => y[1][0] - x[1][0]).slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${String(v[0]).padStart(7)} / ${String(v[1]).padStart(8)}  ${k.replace(/\\.*?(world|landmark|train|game)\.js/, '$1.js')}`));
}
process.exitCode = rc;
