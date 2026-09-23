# node-proxy-frontend

A frontend whose Vite config proxies `/api` to `http://localhost:5001`, beside the API it
means. Exercises the one thing a project can get wrong that still reaches READY: the dev
server resolves that target inside its own container, where `localhost` is the frontend.

With `DEVLAUNCH_REWRITE_SOURCE` unset the run succeeds and the page's requests fail, and
the planning warnings name the file and the replacement. With it set, `vite.config.js` is
repointed at the backend's network alias in the clone DevLaunch runs from.
