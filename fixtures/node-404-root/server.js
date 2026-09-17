// Answers 404 on / and 200 on /api. A great many real APIs behave exactly like this.
// It is READY — a server answered — even though the health hint will not match.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`404-root fixture listening on 0.0.0.0:${PORT}`));
