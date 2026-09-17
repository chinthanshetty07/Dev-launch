// Listens only after a delay, so readiness must actually retry with backoff rather
// than making one attempt and giving up.
const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);
const DELAY = Number(process.env.START_DELAY_MS || 4000);

console.log(`will start listening in ${DELAY}ms`);
setTimeout(() => {
  http
    .createServer((_req, res) => res.end('ok'))
    .listen(PORT, '0.0.0.0', () => console.log(`slow start listening on 0.0.0.0:${PORT}`));
}, DELAY);
