import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where DevLaunch's AI help comes from, decided at every call.
 *
 * Three answers, in order:
 *
 * 1. **The person's own Groq key** — `GROQ_API_KEY` in the environment or `.env`, or one
 *    pasted into the dashboard (kept in `~/.devlaunch/groq-key`, readable by this user
 *    only). Theirs to spend; no limit but Groq's.
 * 2. **The DevLaunch AI relay** — a small service its maintainer runs (`relay/`), which
 *    holds the maintainer's key and forwards requests with a daily limit per person. The
 *    key never leaves the relay: a key shipped inside an open-source tool is a public key,
 *    found by scanners within hours and spent by strangers.
 * 3. **Off.** Rules plan what they recognise; nothing else changes.
 *
 * Decided per call rather than at startup, so a key pasted into the dashboard works at once.
 */

export type AISource = 'own-key' | 'relay' | 'off';

/** What a Groq key looks like. Anything else is refused before it is tried. */
export const GROQ_KEY = /^gsk_[A-Za-z0-9]{20,100}$/;

export interface AIRoute {
  source: Exclude<AISource, 'off'>;
  url: string;
  /** The person's own key; absent for the relay, which adds its own. */
  key?: string;
}

const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = 'https://api.groq.com/openai/v1/models';

export class AISettings {
  private savedKey: string | undefined;

  constructor(
    private readonly opts: {
      env?: NodeJS.ProcessEnv;
      /** Where a pasted key is kept. */
      keyFile?: string;
      /** The relay's address, or '' for none. */
      relayUrl?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  get keyFile(): string {
    const dir = this.env.DEVLAUNCH_STATE_DIR?.trim() || join(homedir(), '.devlaunch');
    return this.opts.keyFile ?? join(dir, 'groq-key');
  }

  /** The relay's chat endpoint: `DEVLAUNCH_AI_RELAY_URL`, or the built-in one; `off` turns it off. */
  get relayUrl(): string {
    const configured = this.env.DEVLAUNCH_AI_RELAY_URL?.trim();
    const url = configured === undefined || configured === '' ? (this.opts.relayUrl ?? '') : configured;
    return url === 'off' ? '' : url;
  }

  /** Read a key pasted in an earlier run. Never throws: no file is simply no key. */
  async load(): Promise<void> {
    const raw = await readFile(this.keyFile, 'utf8').catch(() => '');
    const key = raw.trim();
    this.savedKey = GROQ_KEY.test(key) ? key : undefined;
  }

  private ownKey(): string | undefined {
    return this.env.GROQ_API_KEY?.trim() || this.savedKey;
  }

  source(): AISource {
    if (this.ownKey()) return 'own-key';
    if (this.relayUrl) return 'relay';
    return 'off';
  }

  /** Where the next request goes, or null when AI help is off. */
  route(): AIRoute | null {
    const key = this.ownKey();
    if (key) return { source: 'own-key', url: GROQ_CHAT, key };
    if (this.relayUrl) return { source: 'relay', url: this.relayUrl };
    return null;
  }

  /** Whether the key in use came from the dashboard (and so can be removed there). */
  hasSavedKey(): boolean {
    return Boolean(this.savedKey) && !this.env.GROQ_API_KEY?.trim();
  }

  /**
   * Keep a key pasted into the dashboard — after checking it is one, and that Groq accepts
   * it. Kept in a file only this user can read; never returned, logged or sent anywhere
   * but Groq.
   */
  async saveKey(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const k = key.trim();
    if (!GROQ_KEY.test(k)) return { ok: false, reason: 'That does not look like a Groq key. It starts with gsk_.' };
    const res = await (this.opts.fetchImpl ?? fetch)(GROQ_MODELS, {
      headers: { authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) return { ok: false, reason: 'Could not reach Groq to check the key. Check your internet connection and try again.' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Groq did not accept that key. Copy it again from console.groq.com.' };
    if (!res.ok) return { ok: false, reason: `Groq answered ${res.status} when checking the key. Try again in a minute.` };
    await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    await writeFile(this.keyFile, `${k}\n`, { mode: 0o600 });
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    this.savedKey = k;
    return { ok: true };
  }

  async removeKey(): Promise<void> {
    await rm(this.keyFile, { force: true });
    this.savedKey = undefined;
  }
}
