// Stands in for a React dev server: the page at /, and — like it — a 404 for anything it
// does not serve, which is what an /api call answered without the nginx in front.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/static/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>behind nginx</title><div id="root">page</div>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(`<pre>Cannot ${req.method} ${req.url}</pre>`);
  })
  .listen(PORT, '0.0.0.0', () => console.log(`frontend listening on http://0.0.0.0:${PORT}`));
