import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RewritePanel } from './RewritePanel';

/**
 * Editing someone's repository to make it run is a real liberty. The only thing that
 * makes it a reasonable one is that the change is small, explained, and impossible to
 * miss — so this panel is not a disclosure, and it says where the edit landed.
 */
const rewrite = {
  file: 'frontend/vite.config.js',
  from: 'http://localhost:8000',
  to: 'http://api:8000',
  reason: 'the dev server resolves this inside its own container',
};

describe('<RewritePanel>', () => {
  it('renders nothing when nothing was changed', () => {
    // Which is the default, and the common case.
    expect(renderToStaticMarkup(<RewritePanel />)).toBe('');
    expect(renderToStaticMarkup(<RewritePanel rewrites={[]} />)).toBe('');
  });

  it('shows the file, both sides of the change, and the reason', () => {
    const html = renderToStaticMarkup(<RewritePanel rewrites={[rewrite]} />);
    expect(html).toContain('frontend/vite.config.js');
    expect(html).toContain('http://localhost:8000');
    expect(html).toContain('http://api:8000');
    expect(html).toContain('resolves this inside its own container');
  });

  it('says the user\'s own checkout was not touched', () => {
    // The single most important sentence on the panel: somebody seeing "edited" needs to
    // know it did not happen to the files they are working in.
    const html = renderToStaticMarkup(<RewritePanel rewrites={[rewrite]} />);
    expect(html).toMatch(/checkout is untouched/i);
  });

  it('names the flag, so it can be turned back off', () => {
    const html = renderToStaticMarkup(<RewritePanel rewrites={[rewrite]} />);
    expect(html).toContain('DEVLAUNCH_REWRITE_SOURCE');
  });

  it('counts the edits, so none is hidden behind the first', () => {
    const html = renderToStaticMarkup(
      <RewritePanel rewrites={[rewrite, { ...rewrite, file: 'database.py' }]} />,
    );
    expect(html).toContain('(2)');
    expect(html).toContain('database.py');
  });
});
