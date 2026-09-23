// A tiny API. The frontend beside it reaches this through its dev server's proxy.
const http = require('node:http');

const port = Number(process.env.PORT) || 5001;
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, from: 'backend', path: req.url }));
  })
  .listen(port, '0.0.0.0', () => console.log(`api listening on ${port}`));
