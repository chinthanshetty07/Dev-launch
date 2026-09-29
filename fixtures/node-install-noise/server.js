// Never reached: `node --env-file=.env` exits first, because the repository ships only
// .env.example — as fastify/demo does, whose README says to copy it.
require('node:http').createServer((_q, r) => r.end('ok\n')).listen(Number(process.env.PORT || 3000), '0.0.0.0');
