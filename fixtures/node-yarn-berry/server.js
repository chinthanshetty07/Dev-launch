// A project whose manifest pins Yarn 4.
//
// Yarn 1 — the version every node image ships — reads `packageManager`, refuses to run,
// and prints a paragraph about corepack. That is where a real repository died, twice
// over, before installing a single dependency.
//
// It depends on lodash rather than nothing, because Yarn 2+ installs without a
// node_modules directory: resolution comes from a generated .pnp.cjs, and a dependency
// is the only thing that proves the install actually took.
const http = require('node:http');
const { VERSION } = require('lodash');

const port = Number(process.env.PORT) || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, resolvedThroughPnP: VERSION }));
  })
  .listen(port, '0.0.0.0', () => console.log(`listening on http://0.0.0.0:${port}`));
