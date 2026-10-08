// The DevLaunch AI relay's logic, kept apart from Cloudflare's runtime so it can be tested
// anywhere: DevLaunch's own suite runs it with a stand-in for the counter and for Groq.
//
// It forwards one kind of request — DevLaunch asking a model to plan or repair a run — to
// Groq, using the maintainer's key, which lives only in this Worker's secrets. Everything
// that would let it be used for anything else is refused or fixed in place: one path, one
// model, a capped answer, JSON only, a size limit, a daily allowance per person and for
// everyone together.

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_BODY = 64 * 1024;
const MAX_PROMPT_CHARS = 60_000;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

const refuse = (status, message) => json(status, { error: { message } });

/** The day a limit counts towards, in UTC. */
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** A person, as far as a relay can tell: their address, hashed so it is never stored. */
export async function personOf(request, salt = '') {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Handle one request.
 * `counter.take(person, day, perPerson, everyone)` → `{ ok: true } | { ok: false, scope: 'person' | 'everyone' }`.
 */
export async function handle(request, env, counter, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') {
    return json(200, { service: 'DevLaunch AI relay', ok: Boolean(env.GROQ_API_KEY) });
  }
  if (url.pathname !== '/v1/chat/completions') return refuse(404, 'Not found.');
  if (request.method !== 'POST') return refuse(405, 'POST only.');
  if (!env.GROQ_API_KEY) return refuse(503, 'This relay has no Groq key configured.');

  const raw = await request.text();
  if (raw.length > MAX_BODY) return refuse(413, 'Request too large.');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, 'Not JSON.');
  }

  // A system message and a user message, as DevLaunch sends — nothing more.
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const valid =
    messages.length >= 1 &&
    messages.length <= 4 &&
    messages.every((m) => (m?.role === 'system' || m?.role === 'user') && typeof m.content === 'string');
  if (!valid) return refuse(400, 'Expected DevLaunch\'s system and user messages.');
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_PROMPT_CHARS) return refuse(413, 'Prompt too long.');

  const perPerson = Number(env.PER_PERSON_DAILY ?? 40);
  const everyone = Number(env.EVERYONE_DAILY ?? 2000);
  const taken = await counter.take(await personOf(request, env.SALT ?? ''), today(now), perPerson, everyone);
  if (!taken.ok) {
    return json(
      429,
      {
        error: {
          message:
            taken.scope === 'person'
              ? `DevLaunch's shared AI help allows ${perPerson} requests a day per person, and you have used them. Add your own free Groq key in the DevLaunch dashboard to keep going (console.groq.com).`
              : "DevLaunch's shared AI help has reached today's overall limit. Add your own free Groq key in the DevLaunch dashboard to keep going (console.groq.com).",
        },
      },
      { 'x-devlaunch-limit': taken.scope },
    );
  }

  // Fixed here, whatever was asked: the one model, a capped answer, JSON only.
  const forward = {
    model: env.MODEL ?? 'openai/gpt-oss-120b',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: Math.min(Math.max(Number(body.temperature ?? 0.1) || 0.1, 0), 1),
    max_tokens: Math.min(Number(body.max_tokens ?? 1200) || 1200, 1500),
    response_format: { type: 'json_object' },
  };
  let res;
  try {
    res = await fetchImpl(GROQ, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify(forward),
    });
  } catch {
    return refuse(502, 'Could not reach Groq.');
  }
  // Groq's answer as it is, with only the headers a client needs (never anything that
  // could carry the key — Groq sends none, and none is added).
  const headers = { 'content-type': res.headers.get('content-type') ?? 'application/json' };
  const retry = res.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  return new Response(await res.text(), { status: res.status, headers });
}

/** An in-memory counter with the same contract as the Durable Object, for tests. */
export function memoryCounter() {
  const days = new Map();
  return {
    async take(person, day, perPerson, everyone) {
      const d = days.get(day) ?? { total: 0, people: new Map() };
      days.set(day, d);
      const mine = d.people.get(person) ?? 0;
      if (mine >= perPerson) return { ok: false, scope: 'person' };
      if (d.total >= everyone) return { ok: false, scope: 'everyone' };
      d.people.set(person, mine + 1);
      d.total += 1;
      return { ok: true };
    },
  };
}
