// Stands in for Vite: serves a page, binds 0.0.0.0, never exits.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>fullstack fixture</title><div id="root"></div>');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`frontend listening on http://0.0.0.0:${PORT}`));
