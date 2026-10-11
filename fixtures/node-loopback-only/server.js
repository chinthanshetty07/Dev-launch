// Listens on loopback only, whatever HOST says: what Vite does when the flags that would
// move it never reach it (a `concurrently` dev script). Docker cannot forward to it.
require('node:http')
  .createServer((_q, r) => r.end('loopback only\n'))
  .listen(Number(process.env.PORT || 3000), '127.0.0.1');
