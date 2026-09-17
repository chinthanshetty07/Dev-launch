// Starts, stays alive, and never opens a socket. Proves that "the process is running"
// is not the same fact as "the application is ready".
console.log('process started but will never listen');
setInterval(() => {}, 1 << 30);
