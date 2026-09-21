import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ServiceView } from '@devlaunch/shared';
import { ResultHero, CompletedHero } from './ResultHero';
import { Collapsible } from './Collapsible';

/**
 * A project publishes several URLs and only one of them is a page. Handing a person two
 * equal-looking links and letting them work out which is which is how a working stack
 * reads as broken: opening the API shows `Cannot GET /`.
 */
const service = (over: Partial<ServiceView>): ServiceView =>
  ({ name: 'x', role: 'api', state: 'READY', containerPort: 3000, ...over }) as ServiceView;

const both = [
  service({ name: 'api', role: 'api', url: 'http://localhost:5001/' }),
  service({ name: 'web', role: 'web', url: 'http://localhost:5173/' }),
];

describe('<ResultHero>', () => {
  it('leads with the browser-facing service, not whichever URL the session carries', () => {
    const html = renderToStaticMarkup(<ResultHero url="http://localhost:5001/" services={both} />);
    // The big link and the Open button are both the page, not the API.
    expect(html).toContain('>http://localhost:5173/<');
    expect(html).toMatch(/http:\/\/localhost:5173\/[^]*Open/);
  });

  it('still lists the API, so nothing published is hidden', () => {
    const html = renderToStaticMarkup(<ResultHero url="http://localhost:5173/" services={both} />);
    expect(html).toMatch(/Also published/);
    expect(html).toContain('http://localhost:5001/');
  });

  it('uses the session URL when there is only one service', () => {
    const html = renderToStaticMarkup(<ResultHero url="http://localhost:3000/" />);
    expect(html).toContain('http://localhost:3000/');
    expect(html).not.toMatch(/Also published/);
  });

  it('does not offer a second link to the address it is already showing', () => {
    // One service listed twice reads as two things to try.
    const html = renderToStaticMarkup(
      <ResultHero
        url="http://localhost:5173/"
        services={[service({ name: 'web', role: 'web', url: 'http://localhost:5173/' })]}
      />,
    );
    expect(html).not.toMatch(/Also published/);
  });
});

describe('<CompletedHero>', () => {
  it('says a program that exited cleanly worked, rather than showing nothing', () => {
    // A CLI, a migration or a seeder finishing is a success. A page with no URL on it
    // looks like the failure it is not.
    const html = renderToStaticMarkup(<CompletedHero />);
    expect(html).toMatch(/exited cleanly/);
    expect(html).toMatch(/never opened a port/);
  });
});

describe('<Collapsible>', () => {
  it('keeps detail off the page until it is asked for', () => {
    const html = renderToStaticMarkup(
      <Collapsible title="Run plan">
        <p>the whole plan</p>
      </Collapsible>,
    );
    expect(html).toContain('Run plan');
    expect(html).not.toContain('the whole plan');
    expect(html).toContain('aria-expanded="false"');
  });

  it('opens by default when the caller says the detail is the point', () => {
    // A failed run's warnings are not detail; they are the answer.
    const html = renderToStaticMarkup(
      <Collapsible title="Planning warnings" defaultOpen>
        <p>the whole plan</p>
      </Collapsible>,
    );
    expect(html).toContain('the whole plan');
    expect(html).toContain('aria-expanded="true"');
  });

  it('shows a badge beside the title while closed, so the count is not hidden too', () => {
    const html = renderToStaticMarkup(
      <Collapsible title="Planning warnings" badge="3">
        <p>x</p>
      </Collapsible>,
    );
    expect(html).toContain('3');
  });
});
