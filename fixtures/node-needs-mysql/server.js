// Answers only once it has read MySQL's own greeting from the database it was given.
//
// A MySQL server speaks first: on connect it sends a handshake packet whose payload
// starts with protocol version 10 followed by the server version string. Reading that is
// proof the database is up and reachable, without a driver. As in fastify/demo, the
// database is provisioned by DevLaunch and named by MYSQL_URL.
const http = require('node:http');
const net = require('node:net');

const target = new URL(process.env.MYSQL_URL || 'mysql://root@localhost:3306/app');
const port = Number(process.env.PORT || 3000);

function greeting() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port || 3306), target.hostname);
    socket.setTimeout(5000, () => reject(new Error('no greeting')));
    socket.once('error', reject);
    socket.once('data', (chunk) => {
      socket.destroy();
      // 4-byte packet header, then protocol version 10, then a NUL-terminated version.
      if (chunk[4] !== 10) return reject(new Error(`not a MySQL greeting (${chunk[4]})`));
      resolve(chunk.subarray(5, chunk.indexOf(0, 5)).toString('latin1'));
    });
  });
}

greeting().then(
  (version) => {
    console.log(`MySQL ${version} answered at ${target.host}`);
    http.createServer((_q, r) => r.end(`mysql ${version}\n`)).listen(port, '0.0.0.0');
  },
  (err) => {
    console.error(`Error: could not reach MySQL at ${target.host}: ${err.message}`);
    process.exit(1);
  },
);
