// What webpack 4 does on its first compile — hash with md4 — and what stops
// ahfarmer/calculator (react-scripts 3) on any Node from 17: OpenSSL 3 no longer offers
// md4, and Node throws `error:0308010C:digital envelope routines::unsupported`.
const { createHash } = require('node:crypto');
console.log('Starting the development server...');
createHash('md4').update('module').digest('hex');
require('node:http').createServer((_q, r) => r.end('compiled\n')).listen(Number(process.env.PORT || 3000), '0.0.0.0');
