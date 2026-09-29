#!/usr/bin/env node
// A stand-in for the vite CLI, reproducing how its argument parser (cac) treats `--`:
// everything after it is a positional argument, not an option. Vite binds 127.0.0.1
// unless told otherwise, so `vite dev -- --host 0.0.0.0` serves on loopback — and pnpm,
// unlike npm, forwards the `--` in `pnpm run dev -- --host 0.0.0.0` to the script.
const http = require('node:http');

const argv = process.argv.slice(2);
const end = argv.indexOf('--');
const options = end === -1 ? argv : argv.slice(0, end);
const flag = (name, fallback) => {
  const i = options.indexOf(name);
  return i === -1 ? fallback : options[i + 1];
};

const host = flag('--host', '127.0.0.1');
const port = Number(flag('--port', 5173));
http
  .createServer((_req, res) => res.end('vite fixture\n'))
  .listen(port, host, () => console.log(`  ➜  Local:   http://${host}:${port}/`));
