/* dev/gradecheck.js — 后期链的像素对账（第 15 个判据，走真实 GL 不走光栅化器）
 *
 * 为什么要有它：`quality` 这个旋钮在代码里**只有一处画面差别** —— 非 low 时场景
 * 先渲进 sceneFbo、再走 bloom/曝光/ACES/暗角合成，low 时直接画进 drawing buffer。
 * 而 14 条离线判据里没有任何一条看得见这条链：test-shot.js 是自己的 CPU 光栅化器，
 * 它量的永远是"着色器交出来的东西"，后期链怎么改它都不红。
 *
 * 于是出过一次实打实的事故（2026-10-05 用户报"切换画质后铁轨和道路莫名其妙没了"）：
 * 合成把 ACES 直接喂在**显示参考值**上（场景着色器末尾没有 linear→sRGB），
 * 0.1~0.5 整段被抬 1.4~1.6 倍，再叠一句 pow(0.925) 提亮中间调。实测同一块沥青路面
 * 高清档平均亮度 101 / 暗部占比 3.9%，流畅档 68 / 75.6% —— 钢轨、道床、车道标线
 * 被整体抬成一片浅灰。曲线本身"看起来更亮更电影"，只有两档对拍才看得出它把
 * 画面里的内容抬没了。
 *
 * 判据形式：**量两档的差，不量绝对值**。同一机位同一时刻分别按 high / low 出一帧，
 * 全幅平均亮度与暗部像素占比的差必须落在噪声以内。实测（DPR=1.75，全幅）：
 *   修复后   亮度差 7.7 / 0.1 / 9.6，暗部占比差 0.6 / 0.1 / 0.3 个百分点
 *            （残差 = 暗角与 bloom 的正常风格量）
 *   注回事故写法（整文件回退）亮度差 19.3，暗部占比差 24.3 个百分点
 * 门槛 12 / 20 卡在两组之间：报红侧余量只有 4.3pp，因为**再放宽就抓不住这次的真错**。
 * 也就是说这条判据是故意的 —— 谁把 bloom/暗角调到让两档画面差出 20 个百分点的暗部，
 * 它会红，而那正是"后期链动了内容"的定义。
 *
 * 反向验证（已实测）：把 src/renderer.js 整文件回退到事故版本，本脚本
 * `l3 12.2 chase` 报红（亮度差 19.3、暗部差 24.3pp），换回修复版逐字节校验一致。
 *
 * 用法：node dev/gradecheck.js            （默认跑 3 个机位）
 *       node dev/gradecheck.js l3 12.2 chase   （自己指定一组，可多组）
 * 依赖 dev/shot.js 拉起无头 Chrome，一轮约 1~2 分钟。
 */
'use strict';
const { spawnSync } = require('child_process'), path = require('path');

const ARGS = process.argv.slice(2);
const JOBS = ARGS.length ? [] : [['l3', '12.2', 'chase'], ['l3', '5.0', 'cab'], ['l1', '0.5', 'platform']];
for (let i = 0; i + 2 < ARGS.length + 1 && ARGS[i]; i += 3) JOBS.push([ARGS[i], ARGS[i + 1], ARGS[i + 2]]);

const MAX_MEAN_GAP = 12;      // 全幅平均亮度允许差（暗角 + 趾部的正常风格量级）
const MAX_DARK_GAP = 20;      // 暗部像素占比允许差（百分点）

/** 跑一次 dev/shot.js，从输出行里取出（全幅）平均亮度与暗部占比 */
function shot(quality, line, mid, view) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'shot.js'), 'gc-' + quality, line, mid, view], {
    encoding: 'utf8', maxBuffer: 64e6,
    env: { ...process.env, QUALITY: quality, DPR: '1.75', CROP: '' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/平均亮度 ([\d.]+)\s+过曝 ([\d.]+)%\s+暗部 ([\d.]+)%/);
  if (!m) return { err: '没读到统计行：\n' + out.split(/\r?\n/).slice(-6).join('\n') };
  return { mean: +m[1], dark: +m[3] };
}

let bad = 0;
for (const [line, mid, view] of JOBS) {
  const H = shot('high', line, mid, view), L = shot('low', line, mid, view);
  if (H.err || L.err) { console.log(`✗ ${line} ${mid} ${view} 截图失败：${H.err || L.err}`); bad++; continue; }
  const dm = Math.abs(H.mean - L.mean), dd = Math.abs(H.dark - L.dark);
  const ok = dm <= MAX_MEAN_GAP && dd <= MAX_DARK_GAP;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${line} ${mid} ${view}  亮度 high/low ${H.mean.toFixed(1)}/${L.mean.toFixed(1)}（差 ${dm.toFixed(1)} ≤ ${MAX_MEAN_GAP}）`
    + `  暗部 ${H.dark.toFixed(1)}%/${L.dark.toFixed(1)}%（差 ${dd.toFixed(1)}pp ≤ ${MAX_DARK_GAP}）`);
}
console.log(bad ? `\n${bad}/${JOBS.length} 个机位两档画面分叉 —— 后期链动了内容，不是动了风格` : `\n${JOBS.length}/${JOBS.length} 通过：画质两档的画面统计一致`);
process.exit(bad ? 1 : 0);
