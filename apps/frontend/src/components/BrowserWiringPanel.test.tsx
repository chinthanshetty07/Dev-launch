import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserWiringPanel } from './BrowserWiringPanel';

/**
 * Taken from a real run. `ecom_app` reached READY in six seconds with both URLs live,
 * and every request its page made was refused because the server's CORS allowlist names
 * the port Vite uses by default and the frontend was published on 57206.
 */
const problem = {
  service: 'server',
  file: 'index.js',
  expected: 'http://localhost:5173',
  actual: 'http://localhost:57206',
  problem:
    'server accepts browser requests only from http://localhost:5173, and client is ' +
    'served from http://localhost:57206. Every request the page makes will be refused ' +
    'by CORS, which in the browser looks the same as the API being down.',
};

describe('<BrowserWiringPanel>', () => {
  it('renders nothing when the project is wired up', () => {
    // The common case, and the one where a warning would be noise.
    expect(renderToStaticMarkup(<BrowserWiringPanel />)).toBe('');
    expect(renderToStaticMarkup(<BrowserWiringPanel problems={[]} />)).toBe('');
  });

  it('names the file and both addresses', () => {
    // The remedy is always a line in the repository, so the line has to be findable —
    // and knowing only one of the two addresses is not enough to change it.
    const html = renderToStaticMarkup(<BrowserWiringPanel problems={[problem]} />);
    expect(html).toContain('index.js');
    expect(html).toContain('server');
    // Labelled and side by side, not only mentioned inside the sentence. Reading two
    // long localhost URLs out of a paragraph and spotting which digits differ is the
    // work this panel exists to do for somebody.
    expect(html).toMatch(/written\s*<\/span>http:\/\/localhost:5173/);
    expect(html).toMatch(/actual\S*\s*<\/span>http:\/\/localhost:57206/);
  });

  it('says the services really are running, so the URL above is not doubted', () => {
    // This sits under a green result. Without this sentence it reads as a contradiction,
    // and somebody goes looking for a broken container that does not exist.
    const html = renderToStaticMarkup(<BrowserWiringPanel problems={[problem]} />);
    expect(html).toMatch(/Every service started/i);
  });

  it('explains that no variable reaches these, so nobody looks for a setting', () => {
    const html = renderToStaticMarkup(<BrowserWiringPanel problems={[problem]} />);
    expect(html).toMatch(/literals/i);
  });

  it('shows every problem, not just the first', () => {
    const html = renderToStaticMarkup(
      <BrowserWiringPanel problems={[problem, { ...problem, service: 'client', file: 'src/api.js' }]} />,
    );
    expect(html).toContain('src/api.js');
    expect(html).toContain('client');
  });
});
