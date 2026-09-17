// Binds loopback deliberately. The server is completely healthy, yet Docker's port
// mapping cannot forward to it — the single most common real-world failure, and the
// reason PORT_BOUND_TO_LOCALHOST exists as its own class.
// HOST is ignored on purpose: this reproduces a framework that hardcodes localhost.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);

http
  .createServer((_req, res) => res.end('ok'))
  .listen(PORT, '127.0.0.1', () => {
    console.log(`bound to 127.0.0.1:${PORT} (unreachable from outside the container)`);
  });
