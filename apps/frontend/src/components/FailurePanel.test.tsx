import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureCode, type FailureDetail, type RepairRecord } from '@devlaunch/shared';
import { FailurePanel } from './FailurePanel';

/** What a person actually reads, with the markup taken back out. */
function text(failure: FailureDetail, repairs?: RepairRecord[]): string {
  return renderToStaticMarkup(<FailurePanel failure={failure} repairs={repairs} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const base: FailureDetail = {
  code: FailureCode.PORT_NOT_LISTENING,
  message: 'Nothing is listening on port 8000. Sockets observed: 127.0.0.11:45449.',
  phase: 'start',
};

describe('a failure whose plan has since been rewritten', () => {
  it('explains why the plan on screen disagrees with the diagnosis', () => {
    // Taken from a real dashboard: the plan read `uvicorn --port 8080` and the failure
    // read "Nothing is listening on port 8000". Both were correct — the plan is the last
    // one repair produced, the diagnosis is the first one taken — and nothing on screen
    // connected them. Two numbers that cannot both be right is how a tool teaches
    // someone to stop reading it and retry blindly instead.
    const rendered = text({ ...base, repairAttemptsAfter: 2 });
    expect(rendered).toMatch(/describes the first attempt/i);
    expect(rendered).toMatch(/rewritten 2 times/i);
  });

  it('counts one repair in the singular', () => {
    expect(text({ ...base, repairAttemptsAfter: 1 })).toMatch(/rewritten 1 time by/i);
  });

  it('says nothing at all when no repair ran', () => {
    const rendered = text(base);
    expect(rendered).not.toMatch(/first attempt/i);
    expect(rendered).not.toMatch(/rewritten/i);
    // The failure itself is still reported.
    expect(rendered).toContain('Nothing is listening on port 8000');
  });
});

describe('what repair tried', () => {
  it('shows a rule with the evidence that justified it, distinct from a model guess', () => {
    const repairs: RepairRecord[] = [
      {
        source: 'deterministic',
        type: 'PORT_CORRECTION',
        failureCode: FailureCode.PORT_NOT_LISTENING,
        before: { expectedPort: 8000 },
        after: { expectedPort: 8080 },
        evidence: ['log: Uvicorn running on http://0.0.0.0:8080'],
        confidence: 'high',
      },
      {
        source: 'ai',
        type: 'PLAN_REWRITE',
        failureCode: FailureCode.PORT_NOT_LISTENING,
        before: { startCommand: 'a' },
        after: { startCommand: 'b' },
        evidence: [],
        confidence: 'low',
      },
    ];
    const rendered = text(base, repairs);
    expect(rendered).toMatch(/rule/);
    expect(rendered).toMatch(/model/);
    expect(rendered).toMatch(/expectedPort → 8080/);
    expect(rendered).toMatch(/because log: Uvicorn running on/);
  });
});

describe('<FailurePanel> for a project', () => {
  it('names the service a repair applied to', () => {
    // "The start command was corrected" says nothing useful when four applications are
    // running and three of them were already working.
    const html = renderToStaticMarkup(
      <FailurePanel
        failure={{ code: 'PORT_NOT_LISTENING' as never, message: 'api: nothing is listening' }}
        repairs={[
          {
            source: 'deterministic',
            type: 'PORT_CORRECTION',
            failureCode: 'PORT_NOT_LISTENING' as never,
            service: 'api',
            before: { expectedPort: 4000 },
            after: { expectedPort: 9001 },
            evidence: ['the socket table says 9001'],
            confidence: 'high',
          },
        ]}
      />,
    );
    expect(html).toContain('api');
    expect(html).toMatch(/9001/);
  });
});

describe('a failure that ran out of memory', () => {
  it('says which memory, the limit it reached, the most there was, and how it was known', () => {
    const out = text({
      code: FailureCode.OUT_OF_MEMORY,
      message: 'Dependency installation exceeded the container memory limit.',
      phase: 'install',
      memory: { kind: 'container', limitMb: 2955, maximumMb: 2955, attempts: 3, retryable: false, detectedBy: ['docker: OOMKilled'] },
    });
    expect(out).toContain('container memory · limit 2955 MB of 2955 MB available · 3 attempts · not retried further · detected by docker: OOMKilled');
  });

  it('says nothing about memory for a failure that was not memory', () => {
    expect(text(base)).not.toContain('memory · limit');
  });
});
