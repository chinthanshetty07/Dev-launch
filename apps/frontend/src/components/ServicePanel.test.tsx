import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ServiceView } from '@devlaunch/shared';
import { ServicePanel } from './ServicePanel';

/**
 * A project's plan was never sent to the client at all: `session.plan` is the
 * single-service field, so the dashboard's "Run plan" disclosure was empty for every
 * multi-service run. A service reporting `Start command exited with code 1` offered no
 * way to see which command that was — which is the first thing anybody asks.
 */
const withPlan = (over: Partial<ServiceView>): ServiceView =>
  ({
    name: 'api',
    role: 'api',
    state: 'FAILED',
    containerPort: 4000,
    plan: {
      installCommand: 'npm install',
      buildCommand: null,
      startCommand: 'npm run dev',
      workingDirectory: 'backend',
      runtime: 'node 20',
    },
    ...over,
  }) as ServiceView;

describe('<ServicePanel> commands', () => {
  it('shows the command each service was actually run with', () => {
    const html = renderToStaticMarkup(
      <ServicePanel services={[withPlan({})]} onRestart={() => undefined} busy={false} />,
    );
    expect(html).toContain('npm run dev');
    expect(html).toContain('backend');
    expect(html).toContain('npm install');
    expect(html).toContain('node 20');
  });

  it('says nothing about commands for a session that sent none', () => {
    // A single-service session renders its plan elsewhere, in full. Repeating a partial
    // copy of it here would be two sources for one fact.
    const html = renderToStaticMarkup(
      <ServicePanel
        services={[{ name: 'api', role: 'api', state: 'READY', containerPort: 4000 } as ServiceView]}
        onRestart={() => undefined}
        busy={false}
      />,
    );
    expect(html).not.toContain('npm run dev');
  });

  it('omits a build step the plan does not have, rather than printing null', () => {
    const html = renderToStaticMarkup(
      <ServicePanel services={[withPlan({})]} onRestart={() => undefined} busy={false} />,
    );
    expect(html).not.toMatch(/null/);
  });
});

describe('<ServicePanel> restart', () => {
  // Audit A-07: restart was offered from the moment services existed, while the server
  // refused it (rightly) until the run was up.
  const count = (html: string) => (html.match(/disabled=""/g) ?? []).length;
  it('is not offered while the run is still starting', () => {
    const html = renderToStaticMarkup(
      <ServicePanel services={[withPlan({})]} onRestart={() => undefined} busy={false} canRestart={false} />,
    );
    expect(count(html)).toBe(2); // restart all, and the row's restart
    expect(html).toContain('Available once the run is up');
  });
  it('is offered once it is up', () => {
    const html = renderToStaticMarkup(
      <ServicePanel services={[withPlan({})]} onRestart={() => undefined} busy={false} canRestart />,
    );
    expect(count(html)).toBe(0);
  });
});
