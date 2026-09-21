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
    expect(html).toMatch(/404/);
    expect(html).toMatch(/no page there/);
    expect(html).toContain('href="http://localhost:36212/states/"');
    // A parameterised route cannot be opened as written, so it is listed, not linked.
    expect(html).not.toContain('href="http://localhost:36212/states/:stateId"');
    expect(html).toContain('/states/:stateId');
    expect(html).toContain('POST');
  });

  it('explains a 403, and names an application that refuses plain HTTP', () => {
    // Observed on a real repository: an https-only middleware answers every request
    // with 403, so the link DevLaunch hands over refuses the browser too. A panel that
    // only knew about 404 showed nothing at all, and the 403 read as a DevLaunch bug.
    const html = renderToStaticMarkup(
      <EndpointsPanel
        url="http://localhost:36334/"
        routes={[]}
        readiness={{ path: '/', status: 403, healthHintOk: false, body: '{"detail":"HTTPS is required for all requests."}' }}
      />,
    );
    expect(html).toMatch(/403/);
    expect(html).toMatch(/refuses plain HTTP/);
    expect(html).toMatch(/HTTPS is required for all requests/);
    expect(html).toMatch(/ssl-keyfile/);
  });

  it('reports an unexpected status it has no special knowledge of', () => {
    const html = renderToStaticMarkup(
      <EndpointsPanel url="http://x/" routes={[]} readiness={{ path: '/', status: 500, healthHintOk: false, body: 'Internal Server Error' }} />,
    );
    expect(html).toMatch(/500/);
    expect(html).toMatch(/not a success/);
    expect(html).toMatch(/Internal Server Error/);
  });

  it("quotes the application's own error, not just its error page", () => {
    // The page says "Internal Server Error". The log says which table is missing, and
    // only one of those can be acted on.
    const html = renderToStaticMarkup(
      <EndpointsPanel
        url="http://localhost:36373/"
        routes={[]}
        readiness={{ path: '/', status: 500, healthHintOk: false, body: '500 Internal Server Error', logError: 'sqlite3.OperationalError: no such table: tasks' }}
      />,
    );
    expect(html).toMatch(/its log says/);
    expect(html).toMatch(/no such table: tasks/);
  });

  it('renders nothing when there is nothing to add to the URL', () => {
    expect(renderToStaticMarkup(<EndpointsPanel url="http://x/" routes={[]} readiness={{ path: '/', status: 200, healthHintOk: true }} />)).toBe('');
  });
});
