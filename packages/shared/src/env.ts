/**
 * What kind of thing a configuration variable is, so a deployment that needs it can say
 * what to do: ask for it, generate it, or say an outside account is needed.
 *
 * - `AUTO_GENERATABLE_VALUE`: a secret the application only uses to sign its own sessions or
 *   tokens. Any random value works for a local run, so DevLaunch makes one (never shown).
 * - `EXTERNAL_SERVICE_REQUIRED`: a key for someone else's service — Stripe, OpenAI, AWS…
 *   Only the user can get one. Never invented.
 * - `REQUIRED_SECRET`: another secret (password, token, key) the user must supply.
 * - `REQUIRED_CONFIGURATION`: a setting with no default and no secret in it.
 * - `OPTIONAL_CONFIGURATION`: the repository supplies a default.
 */
export type EnvVarKind =
  | 'AUTO_GENERATABLE_VALUE'
  | 'EXTERNAL_SERVICE_REQUIRED'
  | 'REQUIRED_SECRET'
  | 'REQUIRED_CONFIGURATION'
  | 'OPTIONAL_CONFIGURATION';

/** Secrets an application uses only to sign its own things. Exact names, never a pattern. */
const SELF_SIGNING = new Set([
  'SECRET', 'SECRET_KEY', 'APP_SECRET', 'APP_KEY', 'SESSION_SECRET', 'SESSION_KEY', 'COOKIE_SECRET',
  'JWT_SECRET', 'JWT_SECRET_KEY', 'JWT_KEY', 'JWT_REFRESH_SECRET', 'JWT_ACCESS_SECRET', 'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET', 'TOKEN_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET', 'BETTER_AUTH_SECRET',
  'DJANGO_SECRET_KEY', 'FLASK_SECRET_KEY', 'ENCRYPTION_KEY', 'SIGNING_SECRET', 'CSRF_SECRET',
]);

/** Prefixes of other companies' services. */
const EXTERNAL_PREFIXES = [
  'STRIPE_', 'OPENAI_', 'ANTHROPIC_', 'GROQ_', 'GEMINI_', 'GOOGLE_', 'AWS_', 'AZURE_', 'GCP_', 'FIREBASE_',
  'SUPABASE_', 'SENDGRID_', 'TWILIO_', 'MAILGUN_', 'RESEND_', 'POSTMARK_', 'CLOUDINARY_', 'PAYPAL_',
  'SLACK_', 'DISCORD_', 'GITHUB_', 'MAPBOX_', 'ALGOLIA_', 'SENTRY_', 'PUSHER_', 'AUTH0_', 'CLERK_',
  'HUGGINGFACE_', 'HF_', 'OPENROUTER_', 'REPLICATE_', 'PINECONE_', 'RAZORPAY_', 'SHOPIFY_', 'VERCEL_',
];

const SECRET_WORDS = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?)(?:_|$)|_KEY$/;

/**
 * Whether a variable's value is a secret, by what its name says: a key, a token, a
 * password, or a secret DevLaunch generates. Which service it belongs to is not enough —
 * `AWS_REGION` is an outside service's setting and nobody's secret.
 */
export function isSecretKey(key: string): boolean {
  const k = key.toUpperCase();
  return SELF_SIGNING.has(k) || SECRET_WORDS.test(k);
}

export function classifyEnvVar(key: string, hasDefault = false): EnvVarKind {
  const k = key.toUpperCase();
  if (hasDefault) return 'OPTIONAL_CONFIGURATION';
  if (SELF_SIGNING.has(k)) return 'AUTO_GENERATABLE_VALUE';
  if (EXTERNAL_PREFIXES.some((p) => k.startsWith(p))) return 'EXTERNAL_SERVICE_REQUIRED';
  if (SECRET_WORDS.test(k)) return 'REQUIRED_SECRET';
  return 'REQUIRED_CONFIGURATION';
}
