import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerificationPanel } from './VerificationPanel';
import { RunHeader } from './RunHeader';
import { InputGate } from './InputGate';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

describe('the end-to-end check, on the dashboard', () => {
  it('shows every check with what it saw, and says when it failed', () => {
    const t = text(renderToStaticMarkup(
      <VerificationPanel
        verification={{
          passed: false, durationMs: 2300,
          checks: [
            { name: 'web answers', kind: 'http', target: 'http://localhost:3000/', passed: true, detail: 'answered 200' },
            { name: 'api → postgres', kind: 'dependency', target: 'postgres:5432', passed: false, detail: 'api could not reach postgres:5432: ERR ECONNREFUSED' },
            { name: 'worker → postgres', kind: 'dependency', target: 'postgres:5432', passed: false, skipped: true, detail: 'no way to run a command inside this container' },
          ],
        }}
      />,
    ));
    expect(t).toMatch(/end-to-end check failed \(1\)/);
    expect(t).toMatch(/✓ web answers answered 200/);
    expect(t).toMatch(/✗ api → postgres api could not reach postgres:5432/);
    expect(t).toMatch(/– worker → postgres not run:/);
  });

  it('shows nothing when no check ran', () => {
    expect(renderToStaticMarkup(<VerificationPanel />)).toBe('');
  });
});

describe('the run header', () => {
  it('says which branch, commit and deployment this is', () => {
    const t = text(renderToStaticMarkup(
      <RunHeader state="READY" repoUrl="https://github.com/a/b" refName="main" commit="6b039787f39ca8" deploymentId="2c6b3996-1234" busy={false} onStop={() => {}} onNew={() => {}} />,
    ));
    expect(t).toMatch(/main @ 6b03978 · deploy 2c6b3996/);
  });
});

describe('the configuration form', () => {
  it('says what each variable is, and hides secrets as they are typed', () => {
    const html = renderToStaticMarkup(
      <InputGate
        pending={{ requiredEnv: [{ key: 'STRIPE_SECRET_KEY', hasDefault: false, kind: 'EXTERNAL_SERVICE_REQUIRED' }, { key: 'ADMIN_EMAIL', hasDefault: false, kind: 'REQUIRED_CONFIGURATION' }] }}
        busy={false}
        onSubmitEnv={() => {}}
        onChoose={() => {}}
      />,
    );
    expect(text(html)).toMatch(/STRIPE_SECRET_KEY a key from an outside service — only you can get it/);
    expect(text(html)).toMatch(/ADMIN_EMAIL a setting with no default/);
    expect(html.match(/type="password"/g)?.length).toBe(1);
  });
});
