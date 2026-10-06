require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT||3000);
