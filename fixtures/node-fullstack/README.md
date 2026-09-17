# node-fullstack

Two services and a database, with no root package.json — the ordinary shape of a web
project, and the one a single-service runner gets wrong. The frontend hardcodes
`http://localhost:5001` while the backend defaults to `5000`, which is the mismatch real
repositories ship.
