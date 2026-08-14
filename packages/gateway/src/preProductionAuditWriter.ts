import { performance } from "node:perf_hooks";

import {
  isProjectedPreProductionAuditBundle,
  PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS,
  PRE_PRODUCTION_AUDIT_EXPORT_LIMITS,
  PreProductionAuditExportError,
  type PreProductionAuditExportBundle,
  type PreProductionAuditExportErrorReason,
} from "./preProductionAuditExport.js";

export const PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS = 5_000 as const;
export const PRE_PRODUCTION_AUDIT_WRITE_ACTION =
  "export_preproduction_audit" as const;

export type PreProductionAuditWriterState = "idle" | "writing" | "complete";

export type PreProductionAuditWriterRefusalReason =
  | PreProductionAuditExportErrorReason
  | "attempt_in_progress"
  | "attempt_complete"
  | "export_refused"
  | "deadline_exceeded"
  | "artifact_commit_failed"
  | "artifact_cleanup_failed";

export const PRE_PRODUCTION_AUDIT_ARTIFACT_ERROR_REASONS = Object.freeze([
  "commit_failed",
  "cleanup_failed",
] as const);

export type PreProductionAuditArtifactErrorReason =
  (typeof PRE_PRODUCTION_AUDIT_ARTIFACT_ERROR_REASONS)[number];

export class PreProductionAuditArtifactError extends Error {
  readonly code = "preproduction_audit_artifact_failed" as const;

  constructor(readonly reason: PreProductionAuditArtifactErrorReason) {
    super(`pre-production audit artifact failed: ${reason}`);
    this.name = "PreProductionAuditArtifactError";
  }
}

export interface PreProductionAuditTextWriter {
  write(
    value: string,
    options: { readonly signal: AbortSignal },
    callback: (error?: unknown) => void,
  ): void | Promise<void>;
}

export interface PreProductionAuditAtomicCommitOptions {
  readonly signal: AbortSignal;
  /**
   * Marks the no-clobber publish as the terminal commit point. An artifact
   * adapter must call this synchronously, without yielding, immediately after
   * its complete final artifact becomes visible.
   */
  readonly markCommitted: () => void;
}

export interface PreProductionAuditAtomicArtifactWriter {
  commit(
    value: string,
    options: PreProductionAuditAtomicCommitOptions,
  ): Promise<void>;
}

export interface PreProductionAuditDeadlineScheduler {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface PreProductionAuditMonotonicClock {
  now(): number;
}

export interface PreProductionAuditWriterOptions {
  readonly exportBundle: () =>
    | PreProductionAuditExportBundle
    | Promise<PreProductionAuditExportBundle>;
  readonly artifact: PreProductionAuditAtomicArtifactWriter;
  readonly stderr: PreProductionAuditTextWriter;
  readonly scheduler?: PreProductionAuditDeadlineScheduler;
  readonly clock?: PreProductionAuditMonotonicClock;
}

export interface PreProductionAuditWriter {
  readonly state: PreProductionAuditWriterState;
  run(): Promise<number>;
}

const DEFAULT_SCHEDULER: PreProductionAuditDeadlineScheduler = Object.freeze({
  set: (callback: () => void, milliseconds: number): unknown =>
    setTimeout(callback, milliseconds),
  clear: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout),
});

const DEFAULT_CLOCK: PreProductionAuditMonotonicClock = Object.freeze({
  now: (): number => performance.now(),
});

const DEADLINE = Symbol("preproduction_audit_deadline");
const SAFE_EXPORT_REASONS: ReadonlySet<string> = new Set(
  PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS,
);
const SAFE_ARTIFACT_REASONS: ReadonlySet<string> = new Set(
  PRE_PRODUCTION_AUDIT_ARTIFACT_ERROR_REASONS,
);

function safeExportRefusalReason(
  error: unknown,
): PreProductionAuditExportErrorReason | "export_refused" {
  try {
    if (
      error instanceof PreProductionAuditExportError &&
      error.code === "preproduction_audit_export_refused" &&
      SAFE_EXPORT_REASONS.has(error.reason)
    ) {
      return error.reason;
    }
  } catch {
    // A forged prototype/getter is arbitrary input, not a trusted typed error.
  }
  return "export_refused";
}

function safeArtifactRefusalReason(
  error: unknown,
): "artifact_commit_failed" | "artifact_cleanup_failed" {
  try {
    if (
      error instanceof PreProductionAuditArtifactError &&
      error.code === "preproduction_audit_artifact_failed" &&
      SAFE_ARTIFACT_REASONS.has(error.reason) &&
      error.reason === "cleanup_failed"
    ) {
      return "artifact_cleanup_failed";
    }
  } catch {
    // A forged prototype/getter is arbitrary input, not a trusted typed error.
  }
  return "artifact_commit_failed";
}

function artifactLine(bundle: PreProductionAuditExportBundle): string {
  if (!isProjectedPreProductionAuditBundle(bundle)) {
    throw new PreProductionAuditExportError("event_schema_refused");
  }
  const serialized = JSON.stringify({
    ok: true,
    action: PRE_PRODUCTION_AUDIT_WRITE_ACTION,
    state: "complete",
    bundle,
  });
  if (serialized === undefined) {
    throw new TypeError("pre-production audit bundle is not serializable");
  }
  const line = `${serialized}\n`;
  if (
    Buffer.byteLength(line, "utf8") >
    PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxTotalBytes
  ) {
    throw new PreProductionAuditExportError("total_byte_limit_exceeded");
  }
  return line;
}

function refusalLine(reason: PreProductionAuditWriterRefusalReason): string {
  return `${JSON.stringify({
    ok: false,
    action: PRE_PRODUCTION_AUDIT_WRITE_ACTION,
    state: "refused",
    code: "preproduction_audit_export_refused",
    reason,
  })}\n`;
}

function writeText(
  writer: PreProductionAuditTextWriter,
  value: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error === undefined || error === null) resolve();
      else reject(new Error("pre-production audit writer failed"));
    };
    try {
      const returned = writer.write(value, { signal }, settle);
      if (returned !== undefined) {
        Promise.resolve(returned).then(
          () => settle(),
          () => settle(new Error("pre-production audit writer failed")),
        );
      }
    } catch {
      settle(new Error("pre-production audit writer failed"));
    }
  });
}

async function writeRefusal(
  writer: PreProductionAuditTextWriter,
  reason: PreProductionAuditWriterRefusalReason,
  signal: AbortSignal,
): Promise<number> {
  try {
    await writeText(writer, refusalLine(reason), signal);
    return 78;
  } catch {
    return 1;
  }
}

function writeDeadlineRefusal(writer: PreProductionAuditTextWriter): void {
  try {
    const returned = writer.write(
      refusalLine("deadline_exceeded"),
      { signal: new AbortController().signal },
      () => undefined,
    );
    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch {
    // A failed diagnostic writer cannot extend or reopen the attempt.
  }
}

/**
 * Creates one process-lifetime, post-cleanup audit export attempt.
 *
 * Success is represented only by an atomic retained-evidence artifact. The
 * commit callback is the terminal boundary: a deadline before it wins and a
 * deadline after it cannot retract or reclassify the durable artifact.
 */
export function createPreProductionAuditWriter(
  options: PreProductionAuditWriterOptions,
): PreProductionAuditWriter {
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const clock = options.clock ?? DEFAULT_CLOCK;
  let state: PreProductionAuditWriterState = "idle";

  const writer: PreProductionAuditWriter = {
    get state(): PreProductionAuditWriterState {
      return state;
    },
    async run(): Promise<number> {
      if (state !== "idle") {
        const reason =
          state === "writing" ? "attempt_in_progress" : "attempt_complete";
        return await writeRefusal(
          options.stderr,
          reason,
          new AbortController().signal,
        );
      }

      state = "writing";
      const abort = new AbortController();
      const deadlineAt = clock.now() + PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS;
      let committed = false;
      let deadlineExpired = false;
      let timeoutHandle: unknown;
      const deadlineReached = (): boolean => {
        if (deadlineExpired) return true;
        if (clock.now() < deadlineAt) return false;
        deadlineExpired = true;
        abort.abort();
        return true;
      };
      const markCommitted = (): void => {
        if (committed || abort.signal.aborted || deadlineReached()) {
          throw new Error("invalid pre-production audit commit transition");
        }
        committed = true;
      };
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timeoutHandle = scheduler.set(() => {
          if (committed) return;
          deadlineExpired = true;
          abort.abort();
          resolve(DEADLINE);
        }, PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS);
      });

      const attempt = (async (): Promise<number | typeof DEADLINE> => {
        let bundle: PreProductionAuditExportBundle;
        try {
          bundle = await options.exportBundle();
        } catch (error: unknown) {
          if (deadlineReached()) return DEADLINE;
          return await writeRefusal(
            options.stderr,
            safeExportRefusalReason(error),
            abort.signal,
          );
        }
        if (deadlineReached()) return DEADLINE;

        let line: string;
        try {
          line = artifactLine(bundle);
        } catch (error: unknown) {
          if (deadlineReached()) return DEADLINE;
          return await writeRefusal(
            options.stderr,
            safeExportRefusalReason(error),
            abort.signal,
          );
        }
        if (deadlineReached()) return DEADLINE;

        try {
          await options.artifact.commit(line, {
            signal: abort.signal,
            markCommitted,
          });
          if (!committed) {
            throw new Error("audit artifact adapter returned without commit");
          }
          return 0;
        } catch (error: unknown) {
          if (committed) return 0;
          const artifactReason = safeArtifactRefusalReason(error);
          if (artifactReason === "artifact_cleanup_failed") {
            return await writeRefusal(
              options.stderr,
              artifactReason,
              new AbortController().signal,
            );
          }
          if (deadlineReached()) return DEADLINE;
          return await writeRefusal(
            options.stderr,
            artifactReason,
            abort.signal,
          );
        }
      })();

      try {
        const terminal = await Promise.race([attempt, deadline]);
        if (terminal === DEADLINE) {
          writeDeadlineRefusal(options.stderr);
          return 78;
        }
        return terminal;
      } finally {
        if (timeoutHandle !== undefined) scheduler.clear(timeoutHandle);
        state = "complete";
        void attempt.catch(() => undefined);
      }
    },
  };

  return Object.freeze(writer);
}
