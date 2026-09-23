import { FailureCode } from '@devlaunch/shared';

export class SecurityRejection extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecurityRejection';
  }
}

export interface ApprovedImage {
  language: 'node' | 'python';
  version: string;
  /** Pinned at release time. Empty during development means tag-only resolution. */
  digest?: string;
}

/**
 * Runtime images DevLaunch is permitted to run.
 *
 * These are DevLaunch's own images, not stock upstream ones: a runner image must
 * pre-create /workspace owned by the non-root user, because an anonymous volume
 * inherits ownership from the image path it shadows. A volume over a non-existent
 * path mounts root-owned, and a non-root process then cannot write to it.
 */
export const APPROVED_IMAGES: Readonly<Record<string, ApprovedImage>> = Object.freeze({
  'devlaunch/node:20': { language: 'node', version: '20' },
  // 22, because a repository asked for something 20 does not have rather than because
  // newer is better: `node:sqlite` arrived in 22.5, and a project importing it cannot
  // run on 20 at all — no plan, no repair and no dependency reaches a built-in module
  // that is not in the binary. 20 remains the default, since a project that runs on it
  // runs on the version its author most likely used.
  'devlaunch/node:22': { language: 'node', version: '22' },
  'devlaunch/python:3.12': { language: 'python', version: '3.12' },
});

export function isImageApproved(image: string): boolean {
  return Object.hasOwn(APPROVED_IMAGES, image);
}

/** Throws unless the image is on the allowlist. No implicit fallback, ever. */
export function assertImageApproved(image: string): ApprovedImage {
  const approved = APPROVED_IMAGES[image];
  if (!approved) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Image "${image}" is not on the approved runtime allowlist. ` +
        `Approved: ${Object.keys(APPROVED_IMAGES).join(', ')}`,
    );
  }
  return approved;
}

export function imageForRuntime(language: string, version: string): string {
  const match = Object.entries(APPROVED_IMAGES).find(
    ([, v]) => v.language === language && v.version === version,
  );
  if (!match) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      `No approved runtime image for ${language} ${version}.`,
    );
  }
  return match[0];
}
