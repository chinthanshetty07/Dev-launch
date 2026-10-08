import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputGate } from './InputGate';

/**
 * The question after a crash on a setting nobody gave the app
 * (fullstack-superdev/MERN-ECommerce-Project: a Razorpay client built from RAZORPAY_API_KEY).
 */
const render = (pending: Parameters<typeof InputGate>[0]['pending']) =>
  renderToStaticMarkup(<InputGate pending={pending} busy={false} onSubmitEnv={() => {}} onChoose={() => {}} />);

describe('<InputGate> after a crash', () => {
  const crash = {
    requiredEnv: [
      { key: 'RAZORPAY_API_KEY', hasDefault: false, kind: 'EXTERNAL_SERVICE_REQUIRED' as const },
      { key: 'RAZORPAY_API_SECRET', hasDefault: false, kind: 'REQUIRED_SECRET' as const },
    ],
    crash: { file: 'controller/paymentController.js', line: 14, error: 'Error: `key_id` is mandatory' },
  };

  it('says where the app stopped, which settings, and the error; and offers to start without them', () => {
    const html = render(crash);
    expect(html).toContain('The app needs some settings to start');
    expect(html).toContain('<code>controller/paymentController.js</code> line 14');
    expect(html.replace(/<\/?span>/g, '')).toContain('<code>RAZORPAY_API_KEY</code> and <code>RAZORPAY_API_SECRET</code>');
    expect(html).toContain('Error: `key_id` is mandatory');
    expect(html).toContain('type="password"');
    expect(html).toContain('Start without the missing ones');
    // Not the .env.example wording: nothing declared these.
    expect(html).not.toContain('.env.example');
  });

  it('keeps the .env.example question as it was', () => {
    const html = render({ requiredEnv: crash.requiredEnv });
    expect(html).toContain('Configuration required');
    expect(html).not.toContain('Start without');
  });
});
