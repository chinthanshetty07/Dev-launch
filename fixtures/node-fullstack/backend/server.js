// Connects to its database before serving, the way a real backend does.
//
// No driver is installed on purpose — the fixture must stay offline and fast — but the
// connection is real: it reads the injected variable, resolves the hostname, and opens a
// socket. An unprovisioned database, an uninjected variable, or a wrong hostname each
// fail here exactly as they would with mongoose.
const http = require('node:http');
const net = require('node:net');

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
// Declared in .env.example with no value, so a person has to supply it. Refusing to
// start without it is what makes the gate's absence visible rather than silent.
const APP_SECRET = process.env.APP_SECRET;

function connectToDatabase() {
  return new Promise((resolve, reject) => {
    if (!APP_SECRET) return reject(new Error('APP_SECRET is not set'));
    if (!MONGODB_URI) return reject(new Error('MONGODB_URI is not set'));
    const { hostname, port } = new URL(MONGODB_URI.replace(/^mongodb:/, 'http:'));
    const socket = net.connect(Number(port || 27017), hostname);
    socket.setTimeout(5000);
    socket.on('connect', () => { socket.end(); resolve(`${hostname}:${port}`); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('error', reject);
  });
}

connectToDatabase().then(
  (where) => {
    console.log(`database connected at ${where}`);
    http
      .createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'backend', database: where, secret: APP_SECRET }));
      })
      .listen(PORT, '0.0.0.0', () => console.log(`backend listening on http://0.0.0.0:${PORT}`));
  },
  (err) => {
    // Exactly what the real repository did: refuse to serve without its database.
    console.error(`database connection error: ${err.message}`);
    process.exit(1);
  },
);
