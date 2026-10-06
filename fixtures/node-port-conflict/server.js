// Two servers on one port: the second cannot bind, and the process dies with EADDRINUSE.
const http = require('http');
const port = Number(process.env.PORT || 3000);
http.createServer((q, r) => r.end('first')).listen(port, () => {
  console.log(`first server on ${port}`);
  http.createServer((q, r) => r.end('second')).listen(port);
});
