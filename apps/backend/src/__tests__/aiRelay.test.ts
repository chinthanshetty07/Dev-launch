import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The relay is plain JavaScript for Cloudflare; its logic is tested here, with a stand-in
// for the day's counter and for Groq.
// @ts-expect-error -- untyped JavaScript module
import { handle, memoryCounter } from '../../../../relay/src/handler.js';
import { AISettings } from '../services/ai/AISettings.js';
import { AIUnavailable, GroqProvider } from '../services/ai/GroqProvider.js';

/**
 * AI help for people with no Groq key, through the maintainer's key — which must never
 * leave the relay — with limits so it cannot be drained; and a person's own key, which
 * always wins and is kept on their machine only.
 */

const KEY = 'gsk_' + 'M'.repeat(40);
const OWN = 'gsk_' + 'O'.repeat(40);
const env = { GROQ_API_KEY: KEY, PER_PERSON_DAILY: '2', EVERYONE_DAILY: '3', SALT: 's' };

const asked = (body: unknown, ip = '1.2.3.4', path = '/v1/chat/completions', method = 'POST') =>
  new Request(`https://relay.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
const plan = { messages: [{ role: 'system', content: 'plan' }, { role: 'user', content: 'repo' }], max_tokens: 99999, model: 'something-else', temperature: 7 };

describe('the relay', () => {
  it('forwards DevLaunch\'s request with the maintainer\'s key, fixing what it may ask for', async () => {
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const groq = async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response('{"choices":[{"message":{"content":"{}"}}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res = await handle(asked(plan), env, memoryCounter(), groq);
    expect(res.status).toBe(200);
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.body).toMatchObject({ model: 'openai/gpt-oss-120b', max_tokens: 1500, temperature: 1, response_format: { type: 'json_object' } });
    // The key is never in what comes back.
    expect(JSON.stringify([...res.headers]) + (await res.text())).not.toContain(KEY);
  });

  it('allows each person a daily number of requests, and everyone together a daily total', async () => {
    const counter = memoryCounter();
    const ok = async () => new Response('{}', { status: 200 });
    const go = (ip: string) => handle(asked(plan, ip), env, counter, ok);
    expect((await go('1.1.1.1')).status).toBe(200);
    expect((await go('1.1.1.1')).status).toBe(200);
    const third = await go('1.1.1.1');
    expect(third.status).toBe(429);
    expect(third.headers.get('x-devlaunch-limit')).toBe('person');
    expect(await third.text()).toMatch(/your own free Groq key/);
    expect((await go('2.2.2.2')).status).toBe(200);
    const over = await go('3.3.3.3');
    expect(over.status).toBe(429);
    expect(over.headers.get('x-devlaunch-limit')).toBe('everyone');
  });

  it('refuses anything that is not DevLaunch asking for a plan', async () => {
    const counter = memoryCounter();
    const never = async () => { throw new Error('Groq must not be called'); };
    expect((await handle(asked(plan, 'x', '/v1/embeddings'), env, counter, never)).status).toBe(404);
    expect((await handle(asked(undefined, 'x', '/v1/chat/completions', 'GET'), env, counter, never)).status).toBe(405);
    expect((await handle(asked({ messages: [{ role: 'assistant', content: 'x' }] }), env, counter, never)).status).toBe(400);
    expect((await handle(asked({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }), env, counter, never)).status).toBe(413);
    expect((await handle(asked(plan), { ...env, GROQ_API_KEY: '' }, counter, never)).status).toBe(503);
  });
});

describe('where DevLaunch sends its AI requests', () => {
  const settings = (e: NodeJS.ProcessEnv, relayUrl = 'https://relay.example/v1/chat/completions') =>
    new AISettings({ env: e, keyFile: join(mkdtempSync(join(tmpdir(), 'devlaunch-ai-')), 'groq-key'), relayUrl });

  it('uses the person\'s own key first, the relay without one, and nothing when neither', () => {
    expect(settings({ GROQ_API_KEY: OWN }).route()).toMatchObject({ source: 'own-key', key: OWN });
    expect(settings({}).route()).toEqual({ source: 'relay', url: 'https://relay.example/v1/chat/completions' });
    expect(settings({}, '').route()).toBeNull();
    expect(settings({ DEVLAUNCH_AI_RELAY_URL: 'off' }).route()).toBeNull();
  });

  it('keeps a pasted key — checked with Groq first — on this machine, readable by this user only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlaunch-ai-'));
    const file = join(dir, 'groq-key');
    let checkedWith = '';
    const groq = async (_url: string, init: RequestInit) => {
      checkedWith = (init.headers as Record<string, string>).authorization ?? '';
      return new Response('{}', { status: 200 });
    };
    const s = new AISettings({ env: {}, keyFile: file, relayUrl: '', fetchImpl: groq as typeof fetch });
    expect(await s.saveKey('not a key')).toMatchObject({ ok: false });
    expect(await s.saveKey(OWN)).toEqual({ ok: true });
    expect(checkedWith).toBe(`Bearer ${OWN}`);
    expect(readFileSync(file, 'utf8').trim()).toBe(OWN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(s.source()).toBe('own-key');
    const again = new AISettings({ env: {}, keyFile: file, relayUrl: '' });
    await again.load();
    expect(again.source()).toBe('own-key');
    await again.removeKey();
    expect(again.source()).toBe('off');
  });

  it('refuses a key Groq does not accept, and keeps nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'devlaunch-ai-')), 'groq-key');
    const s = new AISettings({ env: {}, keyFile: file, relayUrl: '', fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch });
    expect(await s.saveKey(OWN)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not accept/) });
    expect(() => statSync(file)).toThrow();
  });

  it('sends no key to the relay, and stops at its daily limit instead of retrying', async () => {
    let calls = 0;
    let auth: string | undefined;
    const relay = async (_url: string, init: RequestInit) => {
      calls++;
      auth = (init.headers as Record<string, string>).authorization;
      return new Response('{"error":{"message":"used them. Add your own free Groq key"}}', { status: 429, headers: { 'x-devlaunch-limit': 'person' } });
    };
    const provider = new GroqProvider({ settings: settings({}), fetchImpl: relay as typeof fetch, sleep: async () => undefined });
    const metadata = { root: '/repo', fileCount: 5, sizeBytes: 100, hasDockerfile: false, tsconfig: false, lockfiles: [], frameworkConfigs: [], envExample: [], warnings: [] };
    await expect(provider.generateRunPlan({ metadata: metadata as never, ruleBasedReason: 'x' })).rejects.toThrow(AIUnavailable);
    expect(calls).toBe(1);
    expect(auth).toBeUndefined();
  });
});
