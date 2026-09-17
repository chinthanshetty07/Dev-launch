// Stands in for Vite: serves a page, binds 0.0.0.0, never exits. It also reports the
// configuration it was given, so a test can assert the wiring arrived.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.VITE_API_URL || 'http://localhost:5001';

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>fullstack fixture</title><div id="root" data-api="${API_URL}"></div>`);
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`frontend listening on http://0.0.0.0:${PORT}`);
    console.log(`frontend will call ${API_URL}`);
  });
