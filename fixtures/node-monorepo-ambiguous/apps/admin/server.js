const http = require('node:http');
const PORT = Number(process.env.PORT || 3000);
http.createServer((_q, s) => s.end('admin')).listen(PORT, '0.0.0.0', () =>
  console.log('admin listening on 0.0.0.0:' + PORT));
