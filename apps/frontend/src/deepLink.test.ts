import { describe, it, expect } from 'vitest';
import { repoFromLink } from './deepLink';

describe('a repository handed over by a link', () => {
  it('takes a public GitHub repository URL', () => {
    expect(repoFromLink('?repo=https://github.com/mdn/todo-react')).toBe('https://github.com/mdn/todo-react');
    expect(repoFromLink('?repo=' + encodeURIComponent('https://github.com/mdn/todo-react.git'))).toBe('https://github.com/mdn/todo-react');
  });

  it('ignores anything that is not one', () => {
    for (const bad of [
      '',
      '?repo=',
      '?repo=https://gitlab.com/a/b',
      '?repo=http://github.com/a/b',
      '?repo=https://github.com.evil.example/a/b',
      '?repo=https://github.com/a',
      '?repo=https://github.com/a/b/../../c',
      '?repo=' + encodeURIComponent('https://github.com/a/b?x=1'),
      '?repo=' + encodeURIComponent('file:///etc/passwd'),
      '?repo=https://github.com/a/' + 'b'.repeat(300),
    ]) {
      expect(repoFromLink(bad), bad).toBeNull();
    }
  });
});
