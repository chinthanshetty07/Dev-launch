// Binds where its own variable says, and loopback otherwise — the shape of
// jellydn/fastify-starter's `host: process.env.SERVER_HOSTNAME ?? '127.0.0.1'`. It reads
// no HOST, so the HOST DevLaunch sets changes nothing.
const http = require('node:http');

const server = http.createServer((_q, r) => r.end('bound where SERVER_HOSTNAME said\n'));
server.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.SERVER_HOSTNAME ?? '127.0.0.1',
});
