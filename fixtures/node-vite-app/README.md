# node-vite-app

Vite detection: lockfile → npm, `engines.node`, a framework config file.

It also *runs*. The tsconfig.json here was a zero-byte file for a long time, which no
test noticed because no test ever started it — planning and measuring a repository
never parse it. The first run that did start it died with
`tsconfig.json:1:0: ERROR: Unexpected end of file in JSON`, and there was no page to
serve either, so a fixture for the happy path could not have reached it.
