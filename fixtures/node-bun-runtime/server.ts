// Written for the Bun runtime, as patelharsh9797/bun-hono-app's server is: `Bun.serve`
// does not exist under Node, and nothing DevLaunch can plan runs it.
Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: () => new Response('bun\n') });
