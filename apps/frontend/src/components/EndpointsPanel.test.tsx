import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HttpRoute } from '@devlaunch/shared';
import { EndpointsPanel } from './EndpointsPanel';

const routes: HttpRoute[] = [
  { method: 'GET', path: '/states/', source: 'app.js' },
  { method: 'GET', path: '/states/:stateId', source: 'app.js' },
  { method: 'POST', path: '/districts/', source: 'app.js' },
];

describe('<EndpointsPanel>', () => {
  it('says the root has no page and links the routes a person can open', () => {
    // What a READY API looked like before: a URL, and "Cannot GET /" behind it.
    const html = renderToStaticMarkup(
      <EndpointsPanel url="http://localhost:36212/" routes={routes} readiness={{ path: '/', status: 404, healthHintOk: false }} />,
    );
    expect(html).toMatch(/returned 404/);
    expect(html).toContain('href="http://localhost:36212/states/"');
    // A parameterised route cannot be opened as written, so it is listed, not linked.
    expect(html).not.toContain('href="http://localhost:36212/states/:stateId"');
    expect(html).toContain('/states/:stateId');
    expect(html).toContain('POST');
  });

  it('renders nothing when there is nothing to add to the URL', () => {
    expect(renderToStaticMarkup(<EndpointsPanel url="http://x/" routes={[]} readiness={{ path: '/', status: 200 }} />)).toBe('');
  });
});
