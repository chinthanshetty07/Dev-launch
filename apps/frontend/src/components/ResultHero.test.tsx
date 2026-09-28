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

/**
 * A project where one service did not start.
 *
 * The run is over and the rest are serving, which is neither the green result nor the
 * failure this used to be forced into. It used to be the failure — and not only in the
 * telling: the working containers were removed to say so.
 */
describe('<ResultHero> for a project that is partly running', () => {
  const mixed = [
    service({ name: 'web', role: 'web', state: 'READY', url: 'http://localhost:5173/' }),
    service({ name: 'api', role: 'api', state: 'FAILED' }),
  ];

  it('still leads with the URL, because that is still the answer', () => {
    // Everything else here is a qualification of this link. Demoting it would make a
    // half-working project indistinguishable from one that did nothing at all.
    const html = renderToStaticMarkup(
      <ResultHero url="http://localhost:5173/" services={mixed} partial />,
    );
    expect(html).toContain('>http://localhost:5173/<');
    expect(html).toMatch(/http:\/\/localhost:5173\/[^]*Open/);
  });

  it('counts what did not start, and names it', () => {
    const html = renderToStaticMarkup(
      <ResultHero url="http://localhost:5173/" services={mixed} partial />,
    );
    expect(html).toMatch(/1 of 2 services did not start/);
    expect(html).toMatch(/Still down: api/);
  });

  it('says the rest will stay up, because the opposite used to be true', () => {
    // The behaviour being announced is the change: these containers used to be torn
    // down. Somebody who remembers that needs telling they no longer are.
    const html = renderToStaticMarkup(
      <ResultHero url="http://localhost:5173/" services={mixed} partial />,
    );
    expect(html).toMatch(/kept its\s+container and will stay up/);
    expect(html).toMatch(/restart just that service/);
  });

  it('reads as a qualified result, not a successful one', () => {
    // Colour is the only thing carrying this at a glance, and a green panel above a
    // half-broken project is the failure mode being fixed.
    const partial = renderToStaticMarkup(
      <ResultHero url="http://localhost:5173/" services={mixed} partial />,
    );
    const whole = renderToStaticMarkup(<ResultHero url="http://localhost:5173/" services={both} />);
    expect(partial).toContain('border-warn/40');
    expect(partial).not.toContain('border-ok/40');
    expect(whole).toContain('border-ok/40');
  });

  it('claims nothing about a whole project it was not told is partial', () => {
    const html = renderToStaticMarkup(<ResultHero url="http://localhost:5173/" services={both} />);
    expect(html).not.toMatch(/did not start/);
    expect(html).not.toMatch(/Still down/);
  });
});
