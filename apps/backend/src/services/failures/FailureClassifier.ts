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

    // No signature matched, so there is no diagnosis — but there is nearly always an
    // explanation, and it is the last thing the application said before it stopped.
    // Without this the report was `Start command exited with code 1.` and nothing else,
    // on a run whose log ends `RuntimeError: Working outside of application context.`
    // The verdict stays low-confidence: quoting the log is not the same as understanding
    // it, and saying otherwise would be inventing a diagnosis.
    const said = input.fallback.evidence ?? lastMeaningfulLine(lines);
    return {
      ...input.fallback,
      ...(said ? { evidence: said.slice(0, 500) } : {}),
      confidence: input.fallback.confidence ?? 'low',
    };
  }

  /** The last matching line wins: errors accumulate, and the final one is the cause. */
  private findEvidence(sig: Signature, lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (sig.exclude?.test(line)) continue;
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

/**
 * `RuntimeError: ...`, `sqlalchemy.exc.OperationalError: ...`, `TypeError: ...`, and
 * Node's bracketed form `Error [ERR_UNKNOWN_BUILTIN_MODULE]: ...`.
 *
 * The bracket matters: without it the best line in a Node crash was skipped and the
 * evidence became `Failed running 'app.js'` — the watcher's epilogue, four lines below
 * the sentence naming the module that does not exist.
 */
const EXCEPTION_LINE =
  /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Failure)\b(?:\s*\[[^\]]+\])?[^\s]*:\s\S/;

/**
 * What a package runner says after the thing it ran has already failed.
 *
 * `error Command failed with exit code 1.` is yarn restating the exit code, and it is
 * the last line of the log — so it became the evidence for a real repository's failure,
 * under a heading that already said the command exited 1. The report was the exit code
 * twice and the cause not at all, while the sentence naming it sat four lines above.
 *
 * These are epilogues rather than diagnoses: every one of them is true, none of them is
 * news, and all of them are printed *after* the thing worth reading.
 */
const RUNNER_EPILOGUE =
  /^(?:error Command failed with exit code|info Visit https:\/\/yarnpkg\.com|error This is probably not a problem with npm|npm ERR! (?:code |errno |syscall |path |command |Failed at |This is probably not a problem)|ELIFECYCLE|Command failed with exit code|Node\.js v\d)/;

/**
 * The last line worth showing a person.
 *
 * A traceback's final line is the exception; the lines above it are the frames that got
 * there, and the lines below are usually a runner's own epilogue. Walking backwards past
 * the noise finds the sentence that names the problem.
 */
function lastMeaningfulLine(lines: readonly string[]): string | undefined {
  // An exception line first, wherever it is. Several runtimes print an explanation
  // *after* the exception — Flask's ends "See the documentation for more information."
  // — and the last line of that is true, unhelpful, and not the name of the problem.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (EXCEPTION_LINE.test(line)) return line;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    // Stack frames, and the shell's own accounting of what it ran.
    if (/^(?:at |File "|\s{2,}\^+\s*$|\.{3}|\[nodemon\]|npm ERR! A complete log)/.test(line)) continue;
    if (/^(?:Traceback \(most recent call last\)|During handling of)/.test(line)) continue;
    if (RUNNER_EPILOGUE.test(line)) continue;
    if (line.length < 8) continue;
    return line;
  }
  return undefined;
}
