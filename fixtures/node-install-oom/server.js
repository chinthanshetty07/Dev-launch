require('node:http').createServer((_q, r) => r.end('installed\n')).listen(Number(process.env.PORT || 3000), '0.0.0.0');
