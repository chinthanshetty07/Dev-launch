import { describe, it, expect, afterEach, vi } from 'vitest';
import { api, ConflictError, GoneError } from './api';

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));

describe('how the dashboard reads an error', () => {
  it('knows a run the server no longer has (A-14)', async () => {
    answer(404, { error: 'No such session.' });
    await expect(api.get('x')).rejects.toBeInstanceOf(GoneError);
  });

  it('shows the message of a structured error, not "[object Object]"', async () => {
    answer(421, { error: { code: 'HOST_NOT_ALLOWED', message: 'DevLaunch answers requests addressed to this machine.' } });
    await expect(api.get('x')).rejects.toThrow('DevLaunch answers requests addressed to this machine.');
    answer(409, { error: { code: 'CONFLICT', message: 'A restart of this run is already in progress.' } });
    await expect(api.restart('x')).rejects.toBeInstanceOf(ConflictError);
  });
});
