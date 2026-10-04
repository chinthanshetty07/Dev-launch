import { describe, it, expect } from 'vitest';
import { definitiveStartFailure } from '../services/failures/DefinitiveStart.js';

describe('lines after which an application will not come up by itself', () => {
  it('are a watcher or runtime saying it gave up', () => {
    expect(definitiveStartFailure(['[nodemon] starting `ts-node src/server.ts`', '[nodemon] app crashed - waiting for file changes before starting...'])).toMatch(/app crashed/);
    expect(definitiveStartFailure(['[ERROR] 12:00:01 ⨯ Unable to compile TypeScript:'])).toMatch(/Unable to compile/);
    expect(definitiveStartFailure(['Error: listen EADDRINUSE: address already in use :::3000'])).toMatch(/EADDRINUSE/);
  });

  it('are not an error an application logs and survives', () => {
    expect(definitiveStartFailure(['Error: connect ECONNREFUSED 127.0.0.1:5432', 'retrying in 5s', '[nodemon] restarting due to changes...'])).toBeUndefined();
  });
});
