import { FailureCode, type FailureDetail } from '@devlaunch/shared';
import type { LogEntry } from '../logs/LogBuffer.js';
import { SIGNATURES, type Phase, type Signature } from './signatures.js';

export interface ClassifyInput {
  logs: LogEntry[] | string;
  exitCode?: number;
  phase: Phase;
  /**
   * The coarse verdict from exit-code and sentinel analysis, or from the readiness
   * port diagnosis. Used verbatim when no signature matches.
   */
  fallback: FailureDetail;
}

/** 128 + SIGKILL(9). The kernel's OOM killer is overwhelmingly the cause in a container. */
const EXIT_SIGKILL = 137;

function toLines(logs: LogEntry[] | string): string[] {
  if (typeof logs === 'string') return logs.split('\n');
  return logs.map((l) => l.text);
}

function appliesTo(sig: Signature, phase: Phase): boolean {
  return sig.phases === undefined || sig.phases.includes(phase);
}

/**
 * Turn raw output into a specific, actionable cause.
 *
 * Exit codes and sentinels establish *which phase* failed; only the text says *why*.
 * "Dependency installation failed" is true but useless — "a native module has no arm64
 * build" tells you what to do next.
 *
 * Every verdict carries the line that produced it, so the diagnosis can be checked
 * rather than trusted. When nothing matches, the coarse verdict is returned marked
 * low-confidence, because admitting there is no diagnosis beats inventing one.
 */
export class FailureClassifier {
  classify(input: ClassifyInput): FailureDetail {
    const lines = toLines(input.logs);

    for (const sig of SIGNATURES) {
      if (!appliesTo(sig, input.phase)) continue;
      const evidence = this.findEvidence(sig, lines);
      if (evidence === null) continue;

      return {
        code: sig.code,
        message: sig.describe(evidence),
        evidence: evidence.trim().slice(0, 500),
        remedy: sig.remedy,
        confidence: 'high',
        exitCode: input.exitCode,
        phase: input.phase === 'none' ? undefined : input.phase,
      };
    }

    // A SIGKILL with no explanatory output is almost always the memory ceiling: the
    // kernel kills the process without giving it a chance to say anything.
    if (input.exitCode === EXIT_SIGKILL) {
      return {
        code: FailureCode.OUT_OF_MEMORY,
        message:
          'The process was killed abruptly (exit 137), which in a container almost ' +
          'always means it exceeded the memory limit.',
        remedy:
          'Raise DEVLAUNCH_CONTAINER_MEMORY_MB, or give the Colima VM more memory.',
        confidence: 'medium',
        exitCode: input.exitCode,
        phase: input.phase === 'none' ? undefined : input.phase,
      };
    }

    return { ...input.fallback, confidence: input.fallback.confidence ?? 'low' };
  }

  /** The last matching line wins: errors accumulate, and the final one is the cause. */
  private findEvidence(sig: Signature, lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (sig.patterns.some((p) => p.test(line))) return line;
    }
    return null;
  }

  /** Human-readable one-liner for the UI. */
  static summarise(detail: FailureDetail): string {
    const confidence = detail.confidence === 'low' ? ' (uncertain)' : '';
    return `${detail.code}${confidence}: ${detail.message}`;
  }
}
