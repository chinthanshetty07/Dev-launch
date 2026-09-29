import { FailureCode, type FailureDetail } from '@devlaunch/shared';

/**
 * Whether a process died for want of memory, and which memory.
 *
 * Two different failures share the words "out of memory". A **container** OOM is the
 * kernel killing a process because the container's cgroup reached its limit; the answer is
 * a larger limit. A **Node heap** OOM is V8 refusing to grow its heap past its own maximum
 * while the container still had room; the answer is a larger heap, and a larger container
 * does nothing for it.
 *
 * The strongest evidence is Docker's own `State.OOMKilled`, and it was measured before
 * being relied on: a child process killed inside the container — yarn, under the wrapper's
 * install step — sets it even though the container itself exits 110, not 137, because the
 * cgroup is shared. A Node heap failure leaves it false. So:
 *
 * - the flag, when it can be read, decides whether the container ran out;
 * - a bare `Killed` line or exit 137 stands in for it only when it cannot be read, and is
 *   *overruled* when Docker says false — something else killed that process;
 * - the heap messages are a heap OOM, unless the flag says the container went too.
 *
 * The word "memory" alone is never evidence.
 */

export type OomKind = 'container' | 'node-heap';

export interface OomVerdict {
  kind: OomKind;
  /** Every signal that agreed, strongest first, so a verdict can be checked. */
  detectedBy: string[];
  /** The line that showed it, when a line did. */
  evidence?: string;
}

export interface OomInput {
  /** Docker's `State.OOMKilled`: true, false, or undefined when it could not be read. */
  oomKilled?: boolean;
  exitCode?: number;
  lines: readonly string[];
}

const HEAP = [
  /JavaScript heap out of memory/i,
  /Reached heap limit Allocation failed/i,
  /FATAL ERROR: .*(?:heap limit|Allocation failed)/i,
  /Ineffective mark-compacts near heap limit/i,
];
/** The shell's own report of a child it lost to SIGKILL. */
const KILLED = /^\s*(?:.*: )?Killed\s*$/;

function lastMatch(lines: readonly string[], patterns: readonly RegExp[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (patterns.some((p) => p.test(lines[i]!))) return lines[i]!.trim();
  }
  return undefined;
}

export function detectOom(input: OomInput): OomVerdict | null {
  const killed = lastMatch(input.lines, [KILLED]);
  const heap = lastMatch(input.lines, HEAP);

  if (input.oomKilled === true) {
    const by = ['docker: OOMKilled'];
    if (killed) by.push('log: Killed');
    if (input.exitCode === 137) by.push('exit code 137');
    return { kind: 'container', detectedBy: by, ...(killed ? { evidence: killed } : {}) };
  }

  if (heap) {
    return { kind: 'node-heap', detectedBy: ['log: JavaScript heap limit'], evidence: heap };
  }

  // Docker said no. A Killed line then means something else sent SIGKILL — a timeout,
  // a stop — and calling it memory would send somebody after the wrong limit.
  if (input.oomKilled === false) return null;

  if (killed || input.exitCode === 137) {
    const by = [...(killed ? ['log: Killed'] : []), ...(input.exitCode === 137 ? ['exit code 137'] : [])];
    return { kind: 'container', detectedBy: by, ...(killed ? { evidence: killed } : {}) };
  }
  return null;
}

const PHASE_WORDS: Record<string, string> = {
  install: 'Dependency installation',
  build: 'The build',
  start: 'The application',
};

/**
 * A failure restated in the light of what the memory evidence says.
 *
 * With an OOM verdict the failure becomes `OUT_OF_MEMORY` carrying which kind, the limit it
 * ran under and what detected it. Without one, a verdict that said `OUT_OF_MEMORY` from
 * text alone is withdrawn when Docker has said the container was *not* OOM-killed, and the
 * coarse phase failure it replaced is reported instead — with the log line kept as
 * evidence, never hidden.
 */
export function withMemoryEvidence(
  failure: FailureDetail,
  oom: OomVerdict | null,
  context: { limitMb: number; oomKilled?: boolean; coarse: FailureDetail },
): FailureDetail {
  if (oom) {
    const what = PHASE_WORDS[failure.phase ?? ''] ?? 'The process';
    const message =
      oom.kind === 'container'
        ? `${what} was killed for exceeding the ${context.limitMb} MB container memory limit.`
        : `${what} ran out of Node heap inside a ${context.limitMb} MB container: V8 refused to grow its heap, while the container itself was not killed.`;
    return {
      ...failure,
      code: FailureCode.OUT_OF_MEMORY,
      message,
      ...(oom.evidence ? { evidence: oom.evidence } : {}),
      confidence: oom.detectedBy[0]?.startsWith('docker') || oom.kind === 'node-heap' ? 'high' : 'medium',
      memory: { kind: oom.kind, limitMb: context.limitMb, detectedBy: oom.detectedBy },
    };
  }
  if (failure.code === FailureCode.OUT_OF_MEMORY && context.oomKilled === false) {
    return {
      ...context.coarse,
      ...(failure.evidence ? { evidence: failure.evidence } : {}),
      confidence: 'low',
    };
  }
  return failure;
}
