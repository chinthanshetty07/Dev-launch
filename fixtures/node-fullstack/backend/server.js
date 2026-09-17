// Zero dependencies at runtime despite the manifest: the manifest is what discovery
// reads, and installing express here would make the fixture slow and network-bound.
const http = require('node:http');
const PORT = process.env.PORT || 5000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'backend' }));
  })
  .listen(PORT, '0.0.0.0', () => console.log(`backend listening on http://0.0.0.0:${PORT}`));
