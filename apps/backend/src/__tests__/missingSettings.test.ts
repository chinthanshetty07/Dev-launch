import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectPlan } from '@devlaunch/shared';
import { missingSettingsFromCrash, projectFrames } from '../services/failures/MissingSettings.js';
import { withCrashAnswers } from '../services/session/SessionManager.js';

/**
 * A crash on a setting nobody gave the app. From `fullstack-superdev/MERN-ECommerce-Project`:
 * its payment controller builds a Razorpay client from RAZORPAY_API_KEY when the file loads,
 * the project ships no .env.example, and the run ended on a stack trace into the library.
 */

// That run's output, as it printed it.
const CRASH = `/workspace/node_modules/razorpay/dist/razorpay.js:33
      throw new Error('\`key_id\` is mandatory');
      ^
Error: \`key_id\` is mandatory
    at new Razorpay (/workspace/node_modules/razorpay/dist/razorpay.js:33:13)
    at Object.<anonymous> (/workspace/controller/paymentController.js:14:18)
    at Module._compile (node:internal/modules/cjs/loader:1521:14)
    at Object.<anonymous> (/workspace/routes/paymentRoute.js:2:43)
    at Object.<anonymous> (/workspace/index.js:12:22)
    at node:internal/main/run_main_module:28:49
Node.js v20.20.2`;

// The file's opening, as the repository has it.
const CONTROLLER = `const Razorpay = require('razorpay');
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Cart = require('../models/Cart');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config()


let productInfo = {};
let userData = {};
let userInfo;
let totalAmount;
const instance = new Razorpay({
  key_id: process.env.RAZORPAY_API_KEY,
  key_secret: process.env.RAZORPAY_API_SECRET,
});
const checkout = async (req, res) => {
  const mail = process.env.EMAIL;
`;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'devlaunch-crash-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe('the settings a crash was about', () => {
  it('reads the project\'s own frames, innermost first, past the library', () => {
    expect(projectFrames(CRASH)).toEqual([
      { file: 'controller/paymentController.js', line: 14 },
      { file: 'routes/paymentRoute.js', line: 2 },
      { file: 'index.js', line: 12 },
    ]);
    // Python lists the innermost frame last.
    const py = 'Traceback (most recent call last):\n  File "/workspace/app.py", line 3, in <module>\n    from pay import client\n  File "/workspace/pay.py", line 7, in <module>\n    client = stripe.Client(os.environ["STRIPE_KEY"])\nKeyError: \'STRIPE_KEY\'';
    expect(projectFrames(py)[0]).toEqual({ file: 'pay.py', line: 7 });
  });

  it('names the unset settings on the lines where the app stopped, and only those', async () => {
    const root = repo({ 'controller/paymentController.js': CONTROLLER });
    const found = await missingSettingsFromCrash({ logs: CRASH, dirs: [root], isSet: () => false });
    expect(found).toEqual({
      keys: ['RAZORPAY_API_KEY', 'RAZORPAY_API_SECRET'],
      file: 'controller/paymentController.js',
      line: 14,
      error: 'Error: `key_id` is mandatory',
    });
    // EMAIL is read further down, not where it stopped.
    expect(found?.keys).not.toContain('EMAIL');
  });

  it('asks only for what was not set, and nothing when everything there was', async () => {
    const root = repo({ 'controller/paymentController.js': CONTROLLER });
    const someSet = await missingSettingsFromCrash({ logs: CRASH, dirs: [root], isSet: (k) => k === 'RAZORPAY_API_KEY' });
    expect(someSet?.keys).toEqual(['RAZORPAY_API_SECRET']);
    expect(await missingSettingsFromCrash({ logs: CRASH, dirs: [root], isSet: () => true })).toBeNull();
  });

  it('says nothing about a crash with no setting where it stopped', async () => {
    const root = repo({ 'controller/paymentController.js': 'const a = 1;\n'.repeat(30) });
    expect(await missingSettingsFromCrash({ logs: CRASH, dirs: [root], isSet: () => false })).toBeNull();
    expect(await missingSettingsFromCrash({ logs: 'Error: listen EADDRINUSE', dirs: [root], isSet: () => false })).toBeNull();
  });

  it('finds the file in the service\'s own folder when the service is not at the root', async () => {
    const root = repo({ 'backend/controller/paymentController.js': CONTROLLER });
    const found = await missingSettingsFromCrash({ logs: CRASH, dirs: [join(root, 'backend'), root], isSet: () => false });
    expect(found?.keys).toEqual(['RAZORPAY_API_KEY', 'RAZORPAY_API_SECRET']);
  });
});

describe('answers to the crash question', () => {
  const project = {
    services: [
      { name: 'client', environmentVariables: [] },
      { name: 'server', environmentVariables: [{ key: 'RAZORPAY_API_KEY', value: null, required: false }] },
    ],
  } as unknown as ProjectPlan;
  const pending = {
    requiredEnv: [
      { key: 'RAZORPAY_API_KEY', hasDefault: false, service: 'server' },
      { key: 'RAZORPAY_API_SECRET', hasDefault: false, service: 'server' },
    ],
    crash: { file: 'controller/paymentController.js', line: 14, error: '' },
  };

  it('go to the service that stopped, replacing what it carried; a blank is not an answer', () => {
    const out = withCrashAnswers(project, pending, { RAZORPAY_API_KEY: 'rzp_test_1', RAZORPAY_API_SECRET: '' });
    expect(out.services[1]!.environmentVariables).toEqual([{ key: 'RAZORPAY_API_KEY', value: 'rzp_test_1', required: true }]);
    expect(out.services[0]!.environmentVariables).toEqual([]);
    // Not a crash question: left to the declared-settings routing.
    expect(withCrashAnswers(project, { requiredEnv: pending.requiredEnv }, { RAZORPAY_API_KEY: 'x' })).toBe(project);
  });
});
