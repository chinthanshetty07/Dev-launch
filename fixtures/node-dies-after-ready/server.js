// Serves normally, then dies of its own accord.
//
// The scenario readiness alone cannot catch: every phase succeeded, the application
// answered a real request, and it fell over afterwards. Without a liveness check the
// session goes on reporting READY and handing out a URL that answers nothing.
const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// How long to stay up after the first request it answers. Counted from that request, not
// from start: a fixed lifetime from start raced readiness, and on a slower machine (CI, with
// many tests at once) the fixture died before readiness had seen it at all.
const LIFETIME_MS = Number(process.env.FIXTURE_LIFETIME_MS || 3000);
const EXIT_CODE = Number(process.env.FIXTURE_EXIT_CODE || 3);

let dying = false;
const server = http.createServer((req, res) => {
  if (!dying) {
    dying = true;
    setTimeout(() => {
      // Written before exiting so the failure has a piece of evidence to quote.
      console.error('fixture is exiting on purpose after serving traffic');
      process.exit(EXIT_CODE);
    }, LIFETIME_MS);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, fixture: 'node-dies-after-ready', url: req.url }));
});

server.listen(PORT, HOST, () => {
  console.log(`fixture listening on http://${HOST}:${PORT}`);
});
