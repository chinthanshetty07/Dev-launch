import { describe, it, expect } from 'vitest';
import { normaliseRef, splitRepoInput } from '../services/git/GitManager.js';

describe('choosing a branch, tag or commit to clone', () => {
  it('accepts the shapes real refs take', () => {
    for (const ref of ['main', 'v3', 'release/2.0', 'feature/x_y-z', '1.2.3', 'd2c4bdf636dbea1beaada559252a9e9693ad446f']) {
      expect(normaliseRef(ref)).toBe(ref);
    }
  });

  it('refuses anything git could read as something other than a ref', () => {
    // Each of these is either an option, a range, a reflog expression or a shell
    // fragment. None is a name a person would give a branch.
    for (const ref of [
      '-b', '--upload-pack=sh', 'a..b', 'main@{1}', 'a b', 'main;x', '$(id)', 'a//b', 'x.lock', 'x/', 'x.', '',
      'a'.repeat(201),
    ]) {
      expect(() => normaliseRef(ref), ref).toThrow(/not a branch, tag or commit/);
    }
  });

  it('reads the ref out of the URL a person copied from their browser', () => {
    expect(splitRepoInput('https://github.com/nuxt/starter/tree/v3')).toEqual({
      repoUrl: 'https://github.com/nuxt/starter',
      ref: 'v3',
    });
    // Everything after /tree/ is the ref, slashes included — GitHub resolves it the same way.
    expect(splitRepoInput('https://github.com/o/r/tree/release/2.0/').ref).toBe('release/2.0');
  });

  it('leaves a URL with no /tree/ exactly as it was', () => {
    expect(splitRepoInput(' https://github.com/o/r ')).toEqual({ repoUrl: 'https://github.com/o/r' });
    expect(splitRepoInput('https://github.com/o/r.git')).toEqual({ repoUrl: 'https://github.com/o/r.git' });
  });

  it('refuses a /tree/ ref by the same rule as an explicit one', () => {
    expect(() => splitRepoInput('https://github.com/o/r/tree/--upload-pack=sh')).toThrow(/not a branch/);
    expect(() => splitRepoInput('https://github.com/o/r/tree/%E0%A4%A')).toThrow(/not a branch/);
  });
});
