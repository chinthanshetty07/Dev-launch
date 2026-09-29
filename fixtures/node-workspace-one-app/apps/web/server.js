// The one runnable package of a workspace, depending on a sibling through `workspace:*`
// — which only a workspace-aware install at the root can resolve. dan5py/turborepo-shadcn-ui
// is this shape: apps/docs importing packages/ui.
const { greeting } = require('@fixture/greeting');
require('node:http')
  .createServer((_q, r) => r.end(`${greeting()}\n`))
  .listen(Number(process.env.PORT || 3000), '0.0.0.0');
