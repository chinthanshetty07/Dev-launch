// Serves a stylesheet from a git submodule — as gothinkster/angular-realworld-example-app
// bundles realworld/assets/theme/styles.css. DevLaunch clones without submodules, so the
// file is not there, and the failure names the file rather than the reason.
const { readFileSync } = require('node:fs');
const css = readFileSync(require('node:path').join(__dirname, 'realworld/assets/theme/styles.css'), 'utf8');
require('node:http').createServer((_q, r) => r.end(css)).listen(Number(process.env.PORT || 3000), '0.0.0.0');
