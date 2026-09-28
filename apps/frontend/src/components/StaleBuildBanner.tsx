import type { BuildStamp } from '../api';

/**
 * The backend answering is not running the code on disk.
 *
 * This banner exists because of a day that produced no error at all. A development
 * server ran for five days while a fix landed twenty-nine minutes after it started;
 * every launch afterwards was served by the old code, and the failures were
 * indistinguishable from real ones — same panels, same diagnoses, same confidence.
 * Hours went into re-investigating bugs that were already fixed on disk.
 *
 * So it is a banner rather than a line in a disclosure: the whole problem was that
 * nothing looked wrong. It carries the restart command, because being told a thing is
 * stale and then having to go and find out how to fix it is most of the friction.
 */
export function StaleBuildBanner({ build }: { build?: BuildStamp }) {
  if (!build?.stale) return null;

  return (
    <div className="border-b border-warn bg-warn/10 px-4 py-2 text-[13px] text-warn">
      <strong className="font-medium">This backend is running older code.</strong>{' '}
      It started from <code>{build.running?.slice(0, 7)}</code>, and the working tree is
      now on <code>{build.head?.slice(0, 7)}</code> — so anything you run is being
      planned and diagnosed by the version before your latest changes. Restart it before
      trusting a result.
    </div>
  );
}
