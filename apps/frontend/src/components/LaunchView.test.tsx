import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LaunchView, ReplacesRunning } from './LaunchView';

/**
 * Deploying a new repository stops the one that is running. Said before the click, so
 * nobody loses a running app by surprise.
 */
describe('<ReplacesRunning>', () => {
  it('says nothing when nothing is running', () => {
    expect(renderToStaticMarkup(<ReplacesRunning />)).toBe('');
  });

  it('names what will be stopped', () => {
    const html = renderToStaticMarkup(<ReplacesRunning running={{ repoUrl: 'https://github.com/mdn/todo-react' }} />);
    expect(html).toContain('mdn/todo-react');
    expect(html).toContain('stops');
  });
});

/**
 * Opened from the website's "Run on my computer" link: the repository is filled in, and
 * nothing runs until the person presses the button (any website can open such a link).
 */
describe('<LaunchView> opened from a link', () => {
  const render = (search: string) => {
    const g = globalThis as { window?: unknown };
    g.window = { location: { search } };
    try {
      let launched = 0;
      const html = renderToStaticMarkup(<LaunchView busy={false} onLaunch={() => launched++} onOpenSession={() => undefined} />);
      return { html, launched };
    } finally {
      delete g.window;
    }
  };

  it('fills in the repository and says nothing runs until the button is pressed', () => {
    const { html, launched } = render('?repo=https://github.com/mdn/todo-react');
    expect(html).toContain('value="https://github.com/mdn/todo-react"');
    expect(html).toContain('Filled in from a link');
    expect(launched).toBe(0);
  });

  it('fills in nothing from a link that is not a GitHub repository', () => {
    const { html } = render('?repo=https://evil.example/x/y');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('Filled in from a link');
  });

  it('starts a run only from the form\'s own submit, never on its own', () => {
    // A static render runs no effects, so this is checked in the source: every call that
    // starts a run is in a handler for the person's own action — the form's `submit`, or a
    // button's onClick — and none in an effect.
    const source = readFileSync(fileURLToPath(new URL('./LaunchView.tsx', import.meta.url)), 'utf8');
    const lines = source.split('\n');
    const submitStart = lines.findIndex((l) => l.includes('const submit'));
    const calls = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('onLaunch('));
    expect(calls.length).toBeGreaterThan(0);
    for (const { l, i } of calls) {
      const inSubmit = i > submitStart && i < submitStart + 6;
      expect(inSubmit || l.includes('onClick='), `line ${i + 1}: ${l.trim()}`).toBe(true);
    }
    for (let at = source.indexOf('useEffect('); at !== -1; at = source.indexOf('useEffect(', at + 1)) {
      const effect = source.slice(at, source.indexOf('}, [', at));
      expect(effect).not.toContain('onLaunch(');
    }
  });
});
