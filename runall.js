// 批跑全部离线自测：同时看退出码与红字行（缺一个都可能把崩溃读成通过）。
// 用法: node runall.js [只跑某几个（空格分隔的名字前缀）]
const { spawnSync } = require('child_process'), path = require('path');
const fs = require('fs'), vm = require('vm');
// 语法闸（判据）：src/ data/ 根目录任何一个 .js 语法错，先点名报红再退出——
// 基线事故（renderer.js 模板串里的反引号）当时的症状是 0/19 全崩、没有任何一行
// 告诉你病根在哪个文件。着色器模板串里不许出现反引号（规矩写在 renderer.js 自己的注释里）。
// C 轨在 webgpu 分支另有同族负控 gsrcsyntax，合流后二者共存不冲突。
{
  const bad = [];
  for (const d of ['src', 'data', '.']) {
    const base = path.join(__dirname, d);
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base)) {
      if (!f.endsWith('.js') || !fs.statSync(path.join(base, f)).isFile()) continue;
      try { new vm.Script(fs.readFileSync(path.join(base, f), 'utf8'), { filename: f }); }
      catch (e) { bad.push((d === '.' ? '' : d + '/') + f + ' — ' + String(e.message).split('\n')[0]); }
    }
  }
  if (bad.length) {
    for (const b of bad) console.log('FAIL 语法闸  ' + b);
    process.exit(1);
  }
}
const SUITE = [
  ['test-core.js', '线形几何'],
  ['test-traffic.js', '调度/信号'],
  ['test-bake.js', '烘焙'],
  ['test-chunk.js', '分片'],
  ['test-land.js', '地标限界'],
  ['test-pax.js', '客流'],
  ['test-facade.js', '立面/通视'],
  ['test-shot.js', '像素构图'],
  ['test-wind.js', '绕序'],
  ['test-wedge.js', '超大面片'],
  ['test-drive.js', '整局驾驶'],
  ['test-xsect.js', '高架横断面'],
  ['test-env.js', '时刻/环境'],
  ['test-transfer.js', '换乘类型'],
  ['test-street.js', '街面车流/公交'],
  ['test-mezz.js', '站厅层/楼扶梯'],
  ['test-train.js', '列车车窗/贯通道'],
  ['test-scene.js', '街区类型学'],
  ['test-tex.js', '贴图质量'],
];
const only = process.argv.slice(2);
let bad = 0, t0 = Date.now();
for (const [f, name] of SUITE) {
  if (only.length && !only.some(o => f.startsWith(o))) continue;
  const s = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    encoding: 'utf8', maxBuffer: 512e6, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split(/\r?\n/).filter(l => /✗|FAIL:|Error|错误|Traceback/.test(l));
  const ok = r.status === 0 && red.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${f.padEnd(18)} ${name.padEnd(12)} ${((Date.now() - s) / 1000).toFixed(1)}s`);
  if (!ok) {
    if (r.status !== 0) console.log(`     rc=${r.status}  ${String(r.signal || '')}`);
    for (const l of red.slice(0, 24)) console.log('     | ' + l.slice(0, 200));
    if (red.length > 24) console.log(`     | ... 另有 ${red.length - 24} 行`);
    if (!red.length) console.log('     | (无红字 —— 输出尾部)\n' + out.split(/\r?\n/).slice(-12).join('\n     | '));
  }
}
console.log(`\n${SUITE.length - bad}/${SUITE.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(bad ? 1 : 0);
