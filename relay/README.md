# DevLaunch AI relay

Gives AI help to people who use DevLaunch without a Groq key of their own, using **your** key —
which stays here, in Cloudflare's secret storage, and is never sent to anyone's computer.

It accepts only DevLaunch's requests: one path, one model, a capped answer, JSON only. Each
person (by internet address) gets `PER_PERSON_DAILY` requests a day (40), and everyone together
`EVERYONE_DAILY` (2000), so your Groq allowance cannot be drained. When a limit is reached,
DevLaunch tells the person to add their own free key.

Cloudflare's free plan is enough.

## Deploy (once)

1. Make a free account at <https://dash.cloudflare.com/sign-up>.
2. In this folder:

   ```bash
   cd relay
   npx wrangler login
   npx wrangler secret put GROQ_API_KEY      # paste your Groq key when asked
   npx wrangler secret put SALT              # type any long random text
   npx wrangler deploy
   ```

   `wrangler deploy` prints the relay's address, like
   `https://devlaunch-ai-relay.<your-name>.workers.dev`.
3. Check it: open that address in a browser — it should say `"ok": true`.
4. Tell DevLaunch where it is: set `relayUrl` in `apps/backend/src/config/index.ts` to that
   address followed by `/v1/chat/completions`, and commit. Every DevLaunch installed or updated
   after that uses it when its person has no key of their own.

## Change the limits

Edit `PER_PERSON_DAILY` and `EVERYONE_DAILY` in `wrangler.toml`, then `npx wrangler deploy`.

## Change or remove your key

`npx wrangler secret put GROQ_API_KEY` replaces it; `npx wrangler secret delete GROQ_API_KEY`
turns the relay off (it then answers that it has no key, and DevLaunch carries on without AI).
