# node-ts-type-error

A TypeScript server with one type error that does not matter at run time, started with
ts-node. ts-node refuses it (`TSError: Unable to compile TypeScript`); DevLaunch says so,
and retries once with `TS_NODE_TRANSPILE_ONLY=true`, after which it serves.
