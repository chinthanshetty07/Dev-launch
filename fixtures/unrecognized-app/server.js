// Runnable, but not by any rule in the deterministic planner: there is no framework
// dependency and no dev/start/serve script. The fallback planner's job is to notice
// that `node server.js` works directly, since `npm run boot` is not an approved script.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);

http
  .createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true,"fixture":"unrecognized-app"}');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`unrecognized fixture listening on 0.0.0.0:${PORT}`));
