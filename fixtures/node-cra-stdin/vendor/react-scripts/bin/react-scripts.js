#!/usr/bin/env node
// A stand-in for react-scripts, reproducing exactly one behaviour of the real
// scripts/start.js (react-scripts >= 3.4.1):
//
//   if (isInteractive || process.env.CI !== 'true') {
//     process.stdin.on('end', function () { devServer.close(); process.exit(); });
//   }
//
// A container has no stdin, so it is at end-of-file the moment the process starts, and
// the dev server shuts itself down with exit 0 right after "Starting the development
// server...". CI=true is the variable that switches the handler off.
const http = require('node:http');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const server = http.createServer((_req, res) => res.end('cra fixture\n'));

server.listen(port, host, () => console.log(`Compiled successfully! http://${host}:${port}`));
console.log('Starting the development server...');

if (process.env.CI !== 'true') {
  process.stdin.on('end', () => {
    server.close();
    process.exit();
  });
  process.stdin.resume();
}
