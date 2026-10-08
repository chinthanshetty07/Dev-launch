import { useEffect, useState } from 'react';
import { api, type AiStatus } from '../api';

/**
 * Where AI help comes from, and a box to add your own free Groq key.
 *
 * Off: the box, since only a key turns it on. Shared (DevLaunch's relay, limited each day):
 * one line, and the box on request. Your own key added here: a way to remove it. The key is
 * sent once, to be checked and kept on this machine; it is never shown again.
 */
export function AiHelpView({
  status,
  open,
  saving,
  error,
  onOpen,
  onSave,
  onRemove,
}: {
  status: AiStatus | null;
  open: boolean;
  saving: boolean;
  error: string | null;
  onOpen: () => void;
  onSave: (key: string) => void;
  onRemove: () => void;
}) {
  if (!status) return null;
  const box = (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget.elements.namedItem('groq-key') as HTMLInputElement | null)?.value ?? '';
        onSave(input);
      }}
    >
      <input
        name="groq-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="gsk_…"
        aria-label="Your Groq API key"
        className="min-w-0 flex-1 rounded-md border border-edge bg-panel px-3 py-1.5 text-[12px] outline-none focus:border-link"
      />
      <button type="submit" disabled={saving} className="rounded-md border border-edge px-3 py-1.5 text-[12px] hover:border-link hover:text-link disabled:opacity-40">
        {saving ? 'Checking…' : 'Save key'}
      </button>
      <span className="w-full text-[11px] text-muted">
        Free at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-link">console.groq.com/keys</a>.
        Checked with Groq, then kept on this computer only.
      </span>
      {error && <span className="w-full text-[12px] text-bad" data-testid="ai-key-error">{error}</span>}
    </form>
  );

  if (status.source === 'off') {
    return (
      <div className="mt-3 text-[12px] text-muted" data-testid="ai-off">
        AI help is off. Most repositories still run; for the ones no rule recognises, add a free Groq key:
        {box}
      </div>
    );
  }
  if (status.source === 'relay') {
    return (
      <div className="mt-3 text-[12px] text-muted" data-testid="ai-relay">
        AI help: shared, limited each day.{' '}
        {!open && (
          <button type="button" onClick={onOpen} className="text-link hover:underline">
            Add your own free key for no limit
          </button>
        )}
        {open && box}
      </div>
    );
  }
  return (
    <div className="mt-3 text-[12px] text-muted" data-testid="ai-own">
      AI help: your own Groq key.{' '}
      {status.ownKeyRemovable && (
        <button type="button" onClick={onRemove} className="text-link hover:underline">
          Remove it
        </button>
      )}
    </div>
  );
}

export function AiHelp() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => undefined);
  }, []);

  return (
    <AiHelpView
      status={status}
      open={open}
      saving={saving}
      error={error}
      onOpen={() => setOpen(true)}
      onSave={(key) => {
        setSaving(true);
        setError(null);
        api
          .saveAiKey(key)
          .then((s) => {
            setStatus(s);
            setOpen(false);
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setSaving(false));
      }}
      onRemove={() => {
        api.removeAiKey().then(setStatus).catch(() => undefined);
      }}
    />
  );
}
