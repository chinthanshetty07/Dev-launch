// Reproduces the shape of a Postgres connection failure without needing a driver.
const net = require('node:net');

const sock = net.createConnection({ host: '127.0.0.1', port: 5432 });
sock.on('error', (err) => {
  console.error(`Database connection failed: ${err.code} 127.0.0.1:5432`);
  process.exit(1);
});
sock.setTimeout(5000, () => {
  console.error('Database connection failed: ETIMEDOUT 127.0.0.1:5432');
  process.exit(1);
});
