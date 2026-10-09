import { describe, it, expect } from 'vitest';
import { BACKING_SPECS, dataPathsFor } from '../services/execution/BackingServices.js';

/** Postgres 18 keeps its data one level up; older versions, and other databases, as before. */
describe('where a database image keeps its data', () => {
  it('moves Postgres 18 and later to /var/lib/postgresql, and leaves the rest alone', () => {
    const pg = BACKING_SPECS.postgres;
    expect(dataPathsFor(pg, 'postgres:18')).toEqual(['/var/lib/postgresql', '/var/run/postgresql']);
    expect(dataPathsFor(pg, 'postgres:18.1-alpine')).toEqual(['/var/lib/postgresql', '/var/run/postgresql']);
    expect(dataPathsFor(pg, 'postgres:16')).toEqual(pg.dataPaths);
    expect(dataPathsFor(pg, 'postgres:latest')).toEqual(pg.dataPaths);
    expect(dataPathsFor(BACKING_SPECS.mysql, 'mysql:9')).toEqual(BACKING_SPECS.mysql.dataPaths);
  });
});
