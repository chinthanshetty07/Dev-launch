// A start that runs and never listens, saying why in words no signature knows.
console.log('Waiting for the job queue before opening the HTTP port');
setInterval(() => {}, 1 << 30);
