import { useState, type ReactNode } from 'react';

/**
 * A detail section that is closed until asked for.
 *
 * The dashboard used to render every panel at once, stacked, so a finished run buried
 * its own result under the plan, the warnings and 400 lines of install output. The
 * evidence is still all there — none of it is removed — but the parts a person only
 * reads when something is wrong no longer compete with the part they came for.
 */
export function Collapsible({
  title,
  badge,
  defaultOpen = false,
  tone = 'plain',
  children,
}: {
  title: string;
  /** A short count or status shown beside the title while closed, e.g. "3 warnings". */
  badge?: ReactNode;
  defaultOpen?: boolean;
  tone?: 'plain' | 'warn';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-b border-edge">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-panel"
      >
        <span
          aria-hidden
          className={`inline-block w-3 text-[11px] text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <h2
          className={`text-[11px] uppercase tracking-[0.15em] ${
            tone === 'warn' ? 'text-warn' : 'text-muted'
          }`}
        >
          {title}
        </h2>
        {badge !== undefined && badge !== null && (
          <span className="text-[11px] text-muted">{badge}</span>
        )}
      </button>
      {open && <div className="border-t border-edge">{children}</div>}
    </section>
  );
}
