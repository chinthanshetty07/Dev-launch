// Zero dependencies on purpose: fixtures must be deterministic and work offline.
const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
// Binds 0.0.0.0, not localhost. Binding 127.0.0.1 here would make Docker's port
// mapping resolve to nothing — the failure mode PORT_BOUND_TO_LOCALHOST exists for.
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, fixture: 'node-http-basic', url: req.url }));
});

server.listen(PORT, HOST, () => {
  console.log(`fixture listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
