/* inst-check 的逐线批跑口（§7.12 的欠账）：实例化通道的实景对账以前只有三条
 * 手点的路径（showcase 街面 / 行车对向 / 行车街面），20 来条线没有批量口 ——
 * "改了实例化之后每条线都验过"这句话就没法说。
 *
 * 做法：枚举 SH.LINES（与 dev/audit-track.js 同一口径：每条主线 + branch 支线，
 * 磁浮/浦江线按用户口径跳过），逐条 spawn 真 GPU 的 dev/inst-check.js（它自己
 * 起 serve 与无头 Chrome，每次 ~50 s），汇总每条的判据结果。
 *
 * 用法：
 *   node dev/inst-batch.js                     # 全部线 × showcase street @0.5
 *   node dev/inst-batch.js l1 l5#branch        # 只跑指定的几条
 *   VIEW=cab node dev/inst-batch.js            # 换机位；RUN=1 / OPP=1 / DOORS=0.5 原样透传
 *   MID=0.8 node dev/inst-batch.js             # 换取证里程
 *
 * 判据就是 inst-check 自己的（实例账 / 像素 A/B / 对照面 / 门玻璃 emi 账）：
 * 批跑口不发明新判据，只负责"每条线都被判过"并且汇总退出码。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

/* 与 audit-track 同一套离线加载：起一个最小 DOM 枚举 SH.LINES（含支线口径）。 */
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', measureText: () => ({ width: 10 }) }) }), addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({ matches: false });
for (const f of ['core', 'mesh', 'renderer', 'textures', 'align', 'world', 'train', 'physics', 'pax', 'audio'])
  require(path.join(__dirname, '../src/' + f + '.js'));
require(path.join(__dirname, '../data/shanghai.js'));
const SH = global.SH;

/* 用户口径：磁浮/胶轮无轮轨构造，不在逐线审计范围（与 audit-track 同一集合）。 */
const SKIP = new Set(['ml', 'ph']);

const jobs = [];
for (const id of Object.keys(SH.LINES)) {
  if (SKIP.has(id)) { console.log(`—— ${SH.LINES[id].name}：按口径跳过（磁浮/胶轮）`); continue; }
  jobs.push(id);
  if (SH.LINES[id].branch) jobs.push(id + '#branch');
}
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const list = only.length ? jobs.filter(j => only.some(o => j === o || j.startsWith(o + '#'))) : jobs;
if (!list.length) { console.error('✗ 没有匹配的线路：' + jobs.join(' ')); process.exit(1); }

const VIEW = process.env.VIEW || 'street';
const MID = process.env.MID || '0.5';
const t0 = Date.now();
const results = [];

(async () => {
  for (const id of list) {
    const label = `${id} @${MID} ${VIEW}`;
    process.stdout.write(`[${results.length + 1}/${list.length}] ${label} ... `);
    const r = await new Promise(res => {
      const p = spawn(process.execPath, [path.join(__dirname, 'inst-check.js'), id, MID, VIEW],
        { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('exit', rc => res({ rc, out, err }));
    });
    const ok = r.rc === 0;
    /* 摘两行关键账（实例账与 A/B）进汇总，全量输出在失败时整段打出来。 */
    const ledger = (r.out.match(/实例账：[^\n]*/) || [''])[0];
    const ab = (r.out.match(/A\/B（[^\n]*/) || [''])[0];
    results.push({ id, ok, ledger, ab });
    if (ok) console.log(`✓  ${ledger}`);
    else {
      console.log(`✗ rc=${r.rc}`);
      if (ab) console.log('    ' + ab);
      if (r.err.trim()) console.log(r.err.trim().split('\n').map(l => '    | ' + l).join('\n'));
    }
  }
  const bad = results.filter(r => !r.ok);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n${list.length} 条线跑完（${mins} min）：${results.length - bad.length} 绿 / ${bad.length} 红`
    + (bad.length ? ' —— ' + bad.map(r => r.id).join(' ') : ''));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
