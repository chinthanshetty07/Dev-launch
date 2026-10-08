import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiHelpView } from './AiHelp';

/**
 * Where AI help comes from, and adding your own free key: the box when it is off, one line
 * and the box on request when it is shared, a way to remove a key added here.
 */
const render = (over: Partial<Parameters<typeof AiHelpView>[0]>) =>
  renderToStaticMarkup(
    <AiHelpView status={null} open={false} saving={false} error={null} onOpen={() => {}} onSave={() => {}} onRemove={() => {}} {...over} />,
  );

describe('<AiHelpView>', () => {
  it('offers the key box when AI help is off, as a password field, saying where the key stays', () => {
    const html = render({ status: { source: 'off', ownKeyRemovable: false, relay: false } });
    expect(html).toContain('AI help is off');
    expect(html).toContain('type="password"');
    expect(html).toContain('console.groq.com/keys');
    expect(html).toContain('kept on this computer only');
  });

  it('says the shared help is limited, and opens the box only when asked', () => {
    const relay = { source: 'relay' as const, ownKeyRemovable: false, relay: true };
    expect(render({ status: relay })).toContain('shared, limited each day');
    expect(render({ status: relay })).not.toContain('type="password"');
    expect(render({ status: relay, open: true })).toContain('type="password"');
  });

  it('offers to remove only a key added here, and shows a refusal plainly', () => {
    expect(render({ status: { source: 'own-key', ownKeyRemovable: true, relay: true } })).toContain('Remove it');
    expect(render({ status: { source: 'own-key', ownKeyRemovable: false, relay: true } })).not.toContain('Remove it');
    expect(render({ status: { source: 'off', ownKeyRemovable: false, relay: false }, error: 'Groq did not accept that key.' })).toContain('Groq did not accept that key.');
  });

  it('is not inside the launch form, so saving a key never starts a run', () => {
    const source = readFileSync(fileURLToPath(new URL('./LaunchView.tsx', import.meta.url)), 'utf8');
    expect(source.indexOf('<AiHelp />')).toBeGreaterThan(source.indexOf('</form>'));
  });
});
