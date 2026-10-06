require('http').createServer((q,r)=>r.end('<h1>page</h1>')).listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('frontend up'));
