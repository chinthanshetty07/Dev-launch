import { describe, it, expect } from 'vitest';
import { RunPlanSchema } from '@devlaunch/shared';
import { HIDDEN, maskUrlPassword, publicPlan } from '../services/security/Redaction.js';

/**
 * Audit A-11: the key a person typed, the secrets DevLaunch generated and database
 * passwords were returned by `GET /api/sessions/:id` and printed in the Plan panel.
 */
const plan = RunPlanSchema.parse({
  runtime: { language: 'node', version: '20' },
  packageManager: 'npm', installCommand: null, buildCommand: null,
  startCommand: 'npm start', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
  environmentVariables: [
    { key: 'STRIPE_SECRET_KEY', value: 'sk_live_REAL', required: true },
    { key: 'OPENAI_API_KEY', value: 'sk-REAL', required: true },
    { key: 'JWT_SECRET', value: 'generated-0123456789abcdef', required: false },
    { key: 'DB_PASSWORD', value: 'hunter2', required: true },
    { key: 'DATABASE_URL', value: 'postgresql://postgres:pw-9f8e@postgres:5432/app', required: false },
    { key: 'AWS_REGION', value: 'us-east-1', required: false },
    { key: 'PORT', value: '3000', required: false },
    { key: 'UNSET', value: null, required: true },
  ],
});

describe('a plan as it leaves the server', () => {
  it('hides every secret and keeps the settings someone debugging needs', () => {
    const shown = Object.fromEntries(publicPlan(plan).environmentVariables.map((v) => [v.key, v.value]));
    expect(shown).toEqual({
      STRIPE_SECRET_KEY: HIDDEN,
      OPENAI_API_KEY: HIDDEN,
      JWT_SECRET: HIDDEN,
      DB_PASSWORD: HIDDEN,
      DATABASE_URL: 'postgresql://postgres:••••••@postgres:5432/app',
      AWS_REGION: 'us-east-1',
      PORT: '3000',
      UNSET: null,
    });
  });

  it('never changes the plan the run uses', () => {
    publicPlan(plan);
    expect(plan.environmentVariables[0]!.value).toBe('sk_live_REAL');
  });

  it('masks a password in any URL, and leaves one without credentials alone', () => {
    expect(maskUrlPassword('connect mongodb://root:s3cret@mongo:27017/x and redis://redis:6379')).toBe(
      'connect mongodb://root:••••••@mongo:27017/x and redis://redis:6379',
    );
  });
});
