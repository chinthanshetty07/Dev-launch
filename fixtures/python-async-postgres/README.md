# python-async-postgres

A single-service API that needs a Postgres it does not contain, reached through an
**async** driver. Both halves matter, and each one was a defect:

- Provisioning lived in the multi-service path only, so a lone API like this started
  with no database and no connection string at all.
- A connection string without the driver in its scheme sends SQLAlchemy to psycopg2,
  which raises `the asyncio extension requires an async driver to be used` against a
  database that is running and perfectly reachable.

The app refuses to answer until a real query succeeds, so a green health check here is
evidence of an actual round trip rather than of a process that merely started.
