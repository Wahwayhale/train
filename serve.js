const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  /* 列车贴图（assets/l1train/*.png，来自用户给的 BVE 模型）—— 缺了这条
     浏览器会把 PNG 当 text/plain，Image 解码直接失败、贴图静默变占位色。 */
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
http.createServer((req, res) => {
  // 浏览器把 canvas 截图 POST 回来存盘，供离线查看
  if (req.url === '/save') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 40e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        const b64 = data.replace(/^data:image\/\w+;base64,/, '');
        const p = path.join(root, 'shots', (name || 'shot') + '.png');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(b64, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"bytes":' + fs.statSync(p).size + '}');
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end('404 ' + p); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}).listen(+(process.env.PORT || process.argv[2] || 8787), () => console.log('shmetro on http://127.0.0.1:' + (process.env.PORT || process.argv[2] || 8787)));
