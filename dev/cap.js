/* 截图回传工具（只在开发时用，index.html 不引用它）。
   用法：页面加载后执行
     await new Promise(r => { const s = document.createElement('script');
       s.src = '/dev/cap.js?' + Math.random(); s.onload = r; document.head.appendChild(s); });
   然后 window.__cap(线路, 里程插值, 视角, 文件名, 可选裁剪框) 会把 PNG POST 到 /save。

   三个坑，都是踩过才知道的：
   1) 页面在后台时 requestAnimationFrame 不触发，所以这里自己关掉 rAF、手动调
      frame() 若干次；不这么做截图永远是空白或上一帧。
   2) canvas 没有 preserveDrawingBuffer，必须在**同一个 JS 任务里**、任何 await
      之前把 toDataURL() 取出来，否则合成器一清屏就什么都没有了。
   3) 画布尺寸跟着 CSS 走，浏览器窗口窄就是竖屏（实测 878×1085），
      和 test-shot.js 的 240×135（16:9）对不上，两边看到的不是同一片画面。
      所以这里强制把画布临时改成 1400×788 再截。 */
(function () {
  const a = window.__SH;
  if (!a) { console.error('cap: 没有 window.__SH'); return; }
  window.__cap = function (lineId, mid, view, name, box) {
    const c = a.canvas, st = c.getAttribute('style') || '';
    c.setAttribute('style', 'position:fixed;left:0;top:0;z-index:99999;width:1400px;height:788px');
    a.r.resize();
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = function () { return 0; };
    a.setLine(lineId, false);
    const S = a.line.al.stationS, i0 = Math.floor(mid);
    a.running = false; a.session = null;
    a.showcase = { s: S[i0] + (S[Math.min(i0 + 1, S.length - 1)] - S[i0]) * (mid - i0), t: 0 };
    a.bakeShowcase();
    a.view = view;
    for (let i = 0; i < 5; i++) a.frame(1000 + i * 33);
    const url = c.toDataURL('image/png');          /* ← 必须在任何 await 之前 */
    c.setAttribute('style', st); a.r.resize();
    window.requestAnimationFrame = origRaf;
    origRaf(function (t) { a.frame(t); });
    return new Promise(function (res) {
      const im = new Image();
      im.onload = function () {
        const b = box || [0, 0, 1, 1], sc = box ? 2 : 1;
        const sx = Math.round(b[0] * im.width), sy = Math.round(b[1] * im.height);
        const sw = Math.round((b[2] - b[0]) * im.width), sh = Math.round((b[3] - b[1]) * im.height);
        const cc = document.createElement('canvas');
        cc.width = sw * sc; cc.height = sh * sc;
        const x = cc.getContext('2d');
        x.imageSmoothingEnabled = false;
        x.drawImage(im, sx, sy, sw, sh, 0, 0, sw * sc, sh * sc);
        fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name, data: cc.toDataURL('image/png') }) })
          .then(r => r.text()).then(t => res(name + ' ' + im.width + 'x' + im.height + ' ' + t))
          .catch(e => res(name + ' ERR ' + e));
      };
      im.src = url;
    });
  };
  /* 逐材质屏蔽：把某个材质整个不画，看画面哪里变了——"水里那根杆子是什么"
     这种问题用眼睛看不出来，用减法一次就定位到材质。 */
  window.__hide = function (lineId, mid, view, name, mats, box) {
    const a2 = window.__SH, od = a2.r.draw;
    const set = {}; for (const m of mats) set[m] = 1;
    a2.r.draw = function (b, M) { if (!set[b.mat]) od.call(this, b, M); };
    return window.__cap(lineId, mid, view, name, box).then(function (r) {
      a2.r.draw = od; return r;
    });
  };
})();
