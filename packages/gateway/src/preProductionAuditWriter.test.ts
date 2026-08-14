import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS,
  PRE_PRODUCTION_AUDIT_EXPORT_LIMITS,
  PreProductionAuditExportError,
  projectPreProductionAudit,
  type PreProductionAuditExportBundle,
} from "./preProductionAuditExport.js";
import { createPreProductionAuditFileWriter } from "./preProductionAuditFile.js";
import {
  createPreProductionAuditWriter,
  PreProductionAuditArtifactError,
  PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS,
  type PreProductionAuditAtomicArtifactWriter,
  type PreProductionAuditAtomicCommitOptions,
  type PreProductionAuditDeadlineScheduler,
  type PreProductionAuditMonotonicClock,
  type PreProductionAuditTextWriter,
} from "./preProductionAuditWriter.js";

const CANARY = "SYNTHETIC-SECRET__HEAD__MIDDLE__TAIL__DO-NOT-USE";
const TENANT_ID = "SYNTHETIC-TENANT-WRITER";
const USER_ID = "SYNTHETIC-USER-WRITER";
const PRINCIPAL_KEY = "SYNTHETIC-PRINCIPAL-WRITER";
const GATEWAY_SESSION_ID = "SYNTHETIC-GATEWAY-SESSION-WRITER";
const COMPLETED_AT_MS = Date.parse("2026-08-14T09:00:00.000Z");

function eventId(index: number): string {
  return `018f1f5a-7b00-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function invocationEvent(toolName: string, seq: number): object {
  const completedAtMs = COMPLETED_AT_MS + seq;
  const occurredAt = new Date(completedAtMs).toISOString();
  return {
    schema: "revagent.event.v2",
    event_id: eventId(seq),
    event_type: "tool.invocation",
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tenant_id: TENANT_ID,
    source: {
      component: "revagent-gateway",
      version: "revagent.m4-preproduction-serving/v1",
      instance: "m4-lan-test",
    },
    actor: { type: "user", user_id: USER_ID },
    session_id: GATEWAY_SESSION_ID,
    seq,
    payload: {
      dispatch_attempt_id: "018f1f5a-7b00-7000-8000-000000000100",
      invocation_id: null,
      idempotency_key: null,
      principal_key: PRINCIPAL_KEY,
      actor_role: "user",
      gateway_session_id: GATEWAY_SESSION_ID,
      oauth_client_id: "SYNTHETIC-OAUTH-CLIENT-WRITER",
      mcp_session_id: "SYNTHETIC-MCP-SESSION-WRITER",
      rsid: null,
      tool_name: toolName,
      tool_version: "1.2.3",
      policy_class: "auto",
      policy_decision: "auto",
      confirmation_id: null,
      originating_preview_invocation_id: null,
      preview_digest: null,
      preview_ref: null,
      commit_args_digest: null,
      confirmation_reason: null,
      mutation_scope_policy: "none",
      mutating: false,
      executor: "bridge",
      document_identity: null,
      params_digest: null,
      mutation_scope: null,
      recovery_hold_ids: [],
      recovery_resolution_ids: [],
      outcome: "completed",
      outcome_error_code: null,
      executor_reached: true,
      started_at_ms: completedAtMs - 25,
      completed_at_ms: completedAtMs,
      duration_ms: 25,
    },
  };
}

function projectedBundle(
  toolName = "revit.inspect_model",
  recordCount = 1,
): PreProductionAuditExportBundle {
  return projectPreProductionAudit({
    profile: "lan_test",
    mode: "preproduction",
    selector: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      principalKey: PRINCIPAL_KEY,
      gatewaySessionId: GATEWAY_SESSION_ID,
    },
    approvedTools: [
      {
        name: toolName,
        version: "1.2.3",
        policyClass: "auto",
        mutationScopePolicy: "none",
        executor: "bridge",
      },
    ],
    events: Array.from({ length: recordCount }, (_, index) =>
      invocationEvent(toolName, index + 1),
    ),
  });
}

const BUNDLE = projectedBundle();

function renderedArtifactLine(bundle: PreProductionAuditExportBundle): string {
  return `${JSON.stringify({
    ok: true,
    action: "export_preproduction_audit",
    state: "complete",
    bundle,
  })}\n`;
}

function largestProjectedBundle(): PreProductionAuditExportBundle {
  let lower = 1;
  let upper = 3_000;
  let largest = BUNDLE;
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2);
    try {
      largest = projectedBundle(`revit.${"x".repeat(length)}`, 64);
      lower = length + 1;
    } catch (error: unknown) {
      if (!(error instanceof PreProductionAuditExportError)) throw error;
      upper = length - 1;
    }
  }
  return largest;
}

function textWriter(lines: string[]): PreProductionAuditTextWriter {
  return Object.freeze({
    write(
      value: string,
      _options: { readonly signal: AbortSignal },
      callback: (error?: unknown) => void,
    ): void {
      lines.push(value);
      callback();
    },
  });
}

function artifactWriter(
  lines: string[],
  sequence?: string[],
): PreProductionAuditAtomicArtifactWriter {
  return Object.freeze({
    async commit(
      value: string,
      options: PreProductionAuditAtomicCommitOptions,
    ): Promise<void> {
      if (options.signal.aborted) throw new Error("aborted");
      lines.push(value);
      sequence?.push("artifact");
      options.markCommitted();
    },
  });
}

function assertValueFree(values: readonly unknown[]): void {
  const text = inspect(values, {
    depth: null,
    showHidden: true,
    getters: false,
    customInspect: false,
  });
  for (const fragment of [
    CANARY,
    "SYNTHETIC-SECRET",
    "HEAD",
    "MIDDLE",
    "TAIL",
  ]) {
    expect(text).not.toContain(fragment);
  }
}

describe("M4 bounded pre-production audit writer", () => {
  it("commits one exact JSONL artifact and emits no success diagnostic", async () => {
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const exportBundle = vi.fn(async () => BUNDLE);
    const writer = createPreProductionAuditWriter({
      exportBundle,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(0);
    expect(writer.state).toBe("complete");
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
    expect(artifacts).toEqual([renderedArtifactLine(BUNDLE)]);
    expect(Buffer.byteLength(artifacts[0] ?? "", "utf8")).toBeLessThanOrEqual(
      PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxTotalBytes,
    );
  });

  it("refuses every later attempt without another projection or commit", async () => {
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const exportBundle = vi.fn(() => BUNDLE);
    const writer = createPreProductionAuditWriter({
      exportBundle,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(0);
    await expect(writer.run()).resolves.toBe(78);
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(artifacts).toHaveLength(1);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "attempt_complete",
    });
  });

  it("refuses a concurrent attempt without a second projection", async () => {
    let release!: (bundle: PreProductionAuditExportBundle) => void;
    const pending = new Promise<PreProductionAuditExportBundle>((resolve) => {
      release = resolve;
    });
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const exportBundle = vi.fn(() => pending);
    const writer = createPreProductionAuditWriter({
      exportBundle,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    const first = writer.run();
    expect(writer.state).toBe("writing");
    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "attempt_in_progress",
    });
    release(BUNDLE);
    await expect(first).resolves.toBe(0);
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(artifacts).toHaveLength(1);
  });

  it("fails closed on an artifact failure without reflecting its error", async () => {
    const stderr: string[] = [];
    const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
      async commit(): Promise<void> {
        throw new Error(CANARY, { cause: new Error(`cause-${CANARY}`) });
      },
    });
    const writer = createPreProductionAuditWriter({
      exportBundle: async () => BUNDLE,
      artifact,
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "artifact_commit_failed",
    });
    assertValueFree(stderr);
  });

  it("surfaces typed cleanup failure through a distinct value-free refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "revagent-m4-cleanup-"));
    const finalPath = join(root, "enrollment.audit.jsonl");
    const displaced = join(root, "displaced-audit.jsonl");
    const fileArtifact = createPreProductionAuditFileWriter(finalPath);
    const stderr: string[] = [];
    const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
      async commit(
        value: string,
        options: PreProductionAuditAtomicCommitOptions,
      ): Promise<void> {
        await fileArtifact.commit(value, {
          signal: options.signal,
          markCommitted() {
            renameSync(finalPath, displaced);
            mkdirSync(finalPath);
            throw new Error(CANARY);
          },
        });
      },
    });
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact,
      stderr: textWriter(stderr),
    });

    try {
      await expect(writer.run()).resolves.toBe(78);
      expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
        reason: "artifact_cleanup_failed",
      });
      assertValueFree(stderr);
      expect(existsSync(displaced)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an adapter that returns without an atomic commit", async () => {
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact: Object.freeze({
        async commit(): Promise<void> {
          return undefined;
        },
      }),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "artifact_commit_failed",
    });
  });

  it("reduces a secret-bearing exporter failure to a fixed refusal", async () => {
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: async () => {
        throw new Error(CANARY, { cause: new Error(`cause-${CANARY}`) });
      },
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(artifacts).toEqual([]);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "export_refused",
    });
    assertValueFree([artifacts, stderr]);
  });

  it.each(PRE_PRODUCTION_AUDIT_EXPORT_ERROR_REASONS)(
    "preserves the allowlisted projector refusal %s",
    async (reason) => {
      const stderr: string[] = [];
      const writer = createPreProductionAuditWriter({
        exportBundle: () => {
          throw new PreProductionAuditExportError(reason);
        },
        artifact: artifactWriter([]),
        stderr: textWriter(stderr),
      });

      await expect(writer.run()).resolves.toBe(78);
      expect(JSON.parse(stderr[0] ?? "")).toEqual({
        ok: false,
        action: "export_preproduction_audit",
        state: "refused",
        code: "preproduction_audit_export_refused",
        reason,
      });
    },
  );

  it("does not trust a forged typed projector reason", async () => {
    const forged = Object.create(
      PreProductionAuditExportError.prototype,
    ) as PreProductionAuditExportError;
    Object.defineProperties(forged, {
      code: { value: "preproduction_audit_export_refused" },
      reason: { value: CANARY },
      message: { value: CANARY },
      stack: { value: CANARY },
    });
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => {
        throw forged;
      },
      artifact: artifactWriter([]),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "export_refused",
    });
    assertValueFree(stderr);
  });

  it("contains forged typed getters without escaping the fixed refusal", async () => {
    const forged = Object.create(
      PreProductionAuditExportError.prototype,
    ) as PreProductionAuditExportError;
    Object.defineProperties(forged, {
      code: {
        get(): never {
          throw new Error(CANARY);
        },
      },
      reason: {
        get(): never {
          throw new Error(CANARY);
        },
      },
    });
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => {
        throw forged;
      },
      artifact: artifactWriter([]),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "export_refused",
    });
    assertValueFree(stderr);
  });

  it("refuses an extra-field forged bundle before serialization", async () => {
    const toJSON = vi.fn(() => ({ reflected: CANARY }));
    const forged = Object.freeze({
      ...BUNDLE,
      secret: CANARY,
      toJSON,
    }) as unknown as PreProductionAuditExportBundle;
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => forged,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(artifacts).toEqual([]);
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "event_schema_refused",
    });
    assertValueFree([artifacts, stderr]);
  });

  it("refuses before commit when the wrapper exceeds the byte boundary", async () => {
    const nearLimit = largestProjectedBundle();
    expect(
      Buffer.byteLength(JSON.stringify(nearLimit), "utf8"),
    ).toBeLessThanOrEqual(PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxTotalBytes);
    expect(
      Buffer.byteLength(renderedArtifactLine(nearLimit), "utf8"),
    ).toBeGreaterThan(PRE_PRODUCTION_AUDIT_EXPORT_LIMITS.maxTotalBytes);
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => nearLimit,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(artifacts).toEqual([]);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "total_byte_limit_exceeded",
    });
  });

  it("hard-bounds an uncommitted attempt to five seconds", async () => {
    let deadline: (() => void) | undefined;
    const scheduler: PreProductionAuditDeadlineScheduler = {
      set(callback, milliseconds): unknown {
        expect(milliseconds).toBe(PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS);
        deadline = callback;
        return "deadline";
      },
      clear: vi.fn(),
    };
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () =>
        new Promise<PreProductionAuditExportBundle>(() => undefined),
      artifact: artifactWriter([]),
      stderr: textWriter(stderr),
      scheduler,
    });

    const attempt = writer.run();
    deadline?.();
    await expect(attempt).resolves.toBe(78);
    expect(writer.state).toBe("complete");
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "deadline_exceeded",
    });
    expect(scheduler.clear).toHaveBeenCalledWith("deadline");
  });

  it("never invokes the artifact adapter when projection resolves after deadline", async () => {
    let deadline: (() => void) | undefined;
    let release!: (bundle: PreProductionAuditExportBundle) => void;
    const pending = new Promise<PreProductionAuditExportBundle>((resolve) => {
      release = resolve;
    });
    const scheduler: PreProductionAuditDeadlineScheduler = {
      set(callback): unknown {
        deadline = callback;
        return "deadline";
      },
      clear: vi.fn(),
    };
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => pending,
      artifact: artifactWriter(artifacts),
      stderr: textWriter(stderr),
      scheduler,
    });

    const attempt = writer.run();
    deadline?.();
    await expect(attempt).resolves.toBe(78);
    release(BUNDLE);
    await Promise.resolve();
    await Promise.resolve();
    expect(artifacts).toEqual([]);
    expect(stderr).toHaveLength(1);
  });

  it("aborts an in-flight pre-commit adapter without a success artifact", async () => {
    let deadline: (() => void) | undefined;
    const scheduler: PreProductionAuditDeadlineScheduler = {
      set(callback): unknown {
        deadline = callback;
        return "deadline";
      },
      clear: vi.fn(),
    };
    let commitCalls = 0;
    const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
      async commit(
        _value: string,
        options: PreProductionAuditAtomicCommitOptions,
      ): Promise<void> {
        commitCalls += 1;
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error(CANARY)),
            { once: true },
          );
        });
      },
    });
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact,
      stderr: textWriter(stderr),
      scheduler,
    });

    const attempt = writer.run();
    await Promise.resolve();
    expect(commitCalls).toBe(1);
    deadline?.();
    await expect(attempt).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "deadline_exceeded",
    });
    assertValueFree(stderr);
  });

  it("treats commit as terminal when the deadline fires immediately afterward", async () => {
    let deadline: (() => void) | undefined;
    const scheduler: PreProductionAuditDeadlineScheduler = {
      set(callback): unknown {
        deadline = callback;
        return "deadline";
      },
      clear: vi.fn(),
    };
    const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
      async commit(
        _value: string,
        options: PreProductionAuditAtomicCommitOptions,
      ): Promise<void> {
        options.markCommitted();
        deadline?.();
        throw new Error(CANARY);
      },
    });
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact,
      stderr: textWriter(stderr),
      scheduler,
    });

    await expect(writer.run()).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(scheduler.clear).toHaveBeenCalledWith("deadline");
  });

  it("uses the monotonic deadline to reject and roll back a late synchronous commit", async () => {
    let now = 10_000;
    const clock: PreProductionAuditMonotonicClock = Object.freeze({
      now: () => now,
    });
    const root = mkdtempSync(join(tmpdir(), "revagent-m4-deadline-"));
    const finalPath = join(root, "enrollment.audit.jsonl");
    const fileArtifact = createPreProductionAuditFileWriter(finalPath);
    const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
      async commit(
        value: string,
        options: PreProductionAuditAtomicCommitOptions,
      ): Promise<void> {
        await fileArtifact.commit(value, {
          signal: options.signal,
          markCommitted() {
            now += PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS + 1;
            options.markCommitted();
          },
        });
      },
    });
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact,
      stderr: textWriter(stderr),
      clock,
    });

    try {
      await expect(writer.run()).resolves.toBe(78);
      expect(existsSync(finalPath)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
      expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
        reason: "deadline_exceeded",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps cleanup_failed fatal when cleanup also crosses the deadline", async () => {
    let now = 20_000;
    const stderr: string[] = [];
    const writer = createPreProductionAuditWriter({
      exportBundle: () => BUNDLE,
      artifact: Object.freeze({
        async commit(): Promise<void> {
          now += PRE_PRODUCTION_AUDIT_WRITE_DEADLINE_MS + 1;
          throw new PreProductionAuditArtifactError("cleanup_failed");
        },
      }),
      stderr: textWriter(stderr),
      clock: Object.freeze({ now: () => now }),
    });

    await expect(writer.run()).resolves.toBe(78);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "artifact_cleanup_failed",
    });
  });

  it("returns a closed failure when the refusal sink also fails", async () => {
    const failing: PreProductionAuditTextWriter = Object.freeze({
      write(
        _value: string,
        _options: { readonly signal: AbortSignal },
        callback: (error?: unknown) => void,
      ): void {
        callback(new Error(CANARY));
      },
    });
    const writer = createPreProductionAuditWriter({
      exportBundle: async () => {
        throw new Error(CANARY);
      },
      artifact: artifactWriter([]),
      stderr: failing,
    });

    await expect(writer.run()).resolves.toBe(1);
    expect(writer.state).toBe("complete");
  });
});
