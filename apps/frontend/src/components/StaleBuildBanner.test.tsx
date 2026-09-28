import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaleBuildBanner } from './StaleBuildBanner';

/**
 * The failure that produced no error. A development server ran for five days while a
 * fix landed twenty-nine minutes after it started; every launch afterwards was served
 * by the old code, with the same panels and the same confidence as a real failure.
 */
const stale = {
  running: 'cbf945f0000000000000000000000000000000aa',
  head: '43a77d60000000000000000000000000000000bb',
  stale: true,
  startedAt: 1,
};

describe('<StaleBuildBanner>', () => {
  it('says nothing when the backend is current', () => {
    // Which is almost always, so anything short of silence here is noise that trains
    // somebody to ignore the one time it matters.
    expect(renderToStaticMarkup(<StaleBuildBanner />)).toBe('');
    expect(renderToStaticMarkup(<StaleBuildBanner build={{ ...stale, stale: false }} />)).toBe('');
  });

  it('names both commits, so it can be checked rather than believed', () => {
    const html = renderToStaticMarkup(<StaleBuildBanner build={stale} />);
    expect(html).toContain('cbf945f');
    expect(html).toContain('43a77d6');
  });

  it('says what it means for the results on the page', () => {
    // The whole problem was that nothing looked wrong. A banner saying only "out of
    // date" invites carrying on; what this has to convey is that the diagnosis below
    // it may be answering a question that is already fixed.
    const html = renderToStaticMarkup(<StaleBuildBanner build={stale} />);
    expect(html).toMatch(/planned and diagnosed by the version before/i);
    expect(html).toMatch(/Restart it before\s+trusting a result/i);
  });
});
