// The API, under /api, as the nginx in front expects.
const http = require('node:http');
const PORT = Number(process.env.PORT || 8000);
http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ from: 'backend', method: req.method, path: req.url, body }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`backend listening on http://0.0.0.0:${PORT}`));
