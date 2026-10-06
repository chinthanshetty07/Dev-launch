import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplacesRunning } from './LaunchView';

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
