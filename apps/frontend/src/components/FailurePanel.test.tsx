import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureCode, type FailureDetail } from '@devlaunch/shared';
import { FailurePanel } from './FailurePanel';

/** What a person actually reads, with the markup taken back out. */
function text(failure: FailureDetail): string {
  return renderToStaticMarkup(<FailurePanel failure={failure} />)
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
