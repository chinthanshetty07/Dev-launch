// The DevLaunch AI relay, as a Cloudflare Worker. See handler.js for what it does.
import { handle } from './handler.js';

export default {
  async fetch(request, env) {
    // One counter per day: every request that day goes through it, so the limits hold
    // exactly, with no two requests counting the same allowance.
    const counter = {
      async take(person, day, perPerson, everyone) {
        const stub = env.COUNTER.get(env.COUNTER.idFromName(day));
        const r = await stub.fetch('https://counter/take', {
          method: 'POST',
          body: JSON.stringify({ person, perPerson, everyone }),
        });
        return r.json();
      },
    };
    return handle(request, env, counter);
  },
};

/** A day's counts: per person, and for everyone. Kept by Cloudflare, gone with the day. */
export class DailyCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { person, perPerson, everyone } = await request.json();
    const total = (await this.state.storage.get('total')) ?? 0;
    const mine = (await this.state.storage.get(`p:${person}`)) ?? 0;
    if (mine >= perPerson) return Response.json({ ok: false, scope: 'person' });
    if (total >= everyone) return Response.json({ ok: false, scope: 'everyone' });
    await this.state.storage.put({ total: total + 1, [`p:${person}`]: mine + 1 });
    // Nothing is kept beyond two days.
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 2 * 86_400_000);
    return Response.json({ ok: true });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
