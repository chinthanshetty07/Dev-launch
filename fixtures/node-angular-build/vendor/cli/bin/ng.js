#!/usr/bin/env node
// A stand-in for `ng serve`, reproducing how the real CLI validates options: against the
// schema of the builder angular.json names for the serve target. `disableHostCheck` is in
// @angular-devkit/build-angular's dev-server schema (through v20) and has never been in
// @angular/build's (v18 to v21) — measured from the published packages. The real CLI then
// fails before serving anything:
//
//   Error: Unknown argument: disable-host-check
const http = require('node:http');
const { readFileSync } = require('node:fs');

const project = Object.values(JSON.parse(readFileSync('angular.json', 'utf8')).projects)[0];
const builder = project.architect.serve.builder;
const known = ['--host', '--port', ...(builder.startsWith('@angular/build:') ? [] : ['--disable-host-check'])];

const [command, ...argv] = process.argv.slice(2);
if (command !== 'serve') process.exit(1);
for (const arg of argv.filter((a) => a.startsWith('--'))) {
  if (!known.includes(arg)) {
    console.error(`Error: Unknown argument: ${arg.slice(2)}`);
    process.exit(1);
  }
}
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const host = flag('--host', '127.0.0.1');
const port = Number(flag('--port', 4200));
http.createServer((_req, res) => res.end('angular fixture\n')).listen(port, host, () => {
  console.log(`  ➜  Local:   http://${host}:${port}/`);
});
