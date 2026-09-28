# node-yarn-berry

Pins `"packageManager": "yarn@4.6.0"`. Exists for two facts that only appear together:

1. Yarn 1 refuses to run a project that pins a different Yarn, so the runner image has to
   enable corepack or nothing installs at all.
2. Yarn 2+ installs with no `node_modules` — resolution is Plug'n'Play — so `node
   server.js` cannot find `lodash` while `yarn node server.js` can.
