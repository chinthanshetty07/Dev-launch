# node-nodemon-crash

The `node-ts-type-error` server, run under nodemon. ts-node refuses the type error and
nodemon then waits for a file change — the container stays up with nothing listening.
DevLaunch must end the wait on `[nodemon] app crashed` rather than poll for the whole
readiness budget, then retry with type checking off.
