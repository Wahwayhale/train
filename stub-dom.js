/* Node 下给 canvas/2D context 打桩，让几何与贴图代码能离线跑。
 *
 * 2D 的**绘制**调用仍然是空的（离线判据不看牌子画出来长什么样），
 * 但 **createImageData / putImageData / getImageData 是真的像素缓冲** ——
 * 程序化贴图（`textures.js` 的 `paint()`）走的正是这三条。以前这三条也是空的，
 * 于是"量贴图内容"的判据拿到的是**全 0 的图**：`test-tex` 的"可无缝平铺"
 * 第一版就是一条永远绿的判据（2026-10-07 抓出来的，同一族"空指标"）。
 * 只有把像素缓冲做成真的，离线套件才量得到贴图。 */
function ctx2d(c) {
  const store = () => {
    const n = Math.max(1, c._w * c._h * 4);
    if (!c._d || c._d.length !== n) c._d = new Uint8ClampedArray(n);
    return c._d;
  };
  return { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    beginPath() {}, closePath() {}, arc() {}, arcTo() {}, ellipse() {}, rect() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, clip() {}, fillRect() {}, clearRect() {}, drawImage() {},
    fillText() {}, strokeText() {}, measureText: () => ({ width: 10 }), setTransform() {}, transform() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    createImageData: (w, h) => ({ width: w | 0, height: h | 0, data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)) }),
    putImageData(img, dx, dy) {
      const W = c._w, H = c._h, D = store(), w = img.width, h = img.height;
      for (let y = 0; y < h; y++) {
        const yy = (dy | 0) + y; if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < w; x++) {
          const xx = (dx | 0) + x; if (xx < 0 || xx >= W) continue;
          const s = (y * w + x) * 4, t = (yy * W + xx) * 4;
          D[t] = img.data[s]; D[t + 1] = img.data[s + 1]; D[t + 2] = img.data[s + 2]; D[t + 3] = img.data[s + 3];
        }
      }
    },
    getImageData(x, y, w, h) {
      const W = c._w, H = c._h, D = store();
      const out = new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4));
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const sx = (x | 0) + xx, sy = (y | 0) + yy;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        const s = (sy * W + sx) * 4, t = (yy * w + xx) * 4;
        out[t] = D[s]; out[t + 1] = D[s + 1]; out[t + 2] = D[s + 2]; out[t + 3] = D[s + 3];
      }
      return { width: w | 0, height: h | 0, data: out };
    } };
}
function canvas() {
  const c = { _w: 0, _h: 0, _d: null, style: { setProperty() {} }, toDataURL: () => '', addEventListener() {} };
  Object.defineProperty(c, 'width', { get: () => c._w, set: v => { c._w = v | 0; c._d = null; } });
  Object.defineProperty(c, 'height', { get: () => c._h, set: v => { c._h = v | 0; c._d = null; } });
  c.getContext = () => ctx2d(c);
  return c;
}
global.window = global;
global.document = { createElement: t => t === 'canvas' ? canvas() : {style: {setProperty() {}}, getContext: () => ctx2d({ _w: 0, _h: 0, _d: null }), appendChild() {}, remove() {}},
  addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
  body: {appendChild() {}, contains: () => true}, documentElement: {style: {setProperty() {}}}, readyState: 'complete' };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.matchMedia = () => ({matches: false});
global.navigator = { clipboard: {} };
global.performance = require('perf_hooks').performance;
global.requestAnimationFrame = () => 0;
