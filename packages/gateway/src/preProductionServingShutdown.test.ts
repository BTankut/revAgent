import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  projectPreProductionAudit,
  type PreProductionAuditExportBundle,
} from "./preProductionAuditExport.js";
import type {
  PreProductionAuditAtomicArtifactWriter,
  PreProductionAuditAtomicCommitOptions,
  PreProductionAuditTextWriter,
} from "./preProductionAuditWriter.js";
import type { PreProductionServingLaunch } from "./preProductionServingCli.js";
import { completePreProductionServingShutdown } from "./preProductionServingShutdown.js";

const CANARY =
  "SYNTHETIC-SHUTDOWN-SECRET__HEAD__MIDDLE__TAIL__DO-NOT-EMIT";
const TENANT_ID = "SYNTHETIC-SHUTDOWN-TENANT";
const USER_ID = "SYNTHETIC-SHUTDOWN-USER";
const PRINCIPAL_KEY = `${TENANT_ID}:${USER_ID}`;
const GATEWAY_SESSION_ID = "SYNTHETIC-SHUTDOWN-GATEWAY-SESSION";
const RECORDED_AT = "2026-08-14T09:00:00.000Z";
const ENROLLMENT_PATH = join(
  process.cwd(),
  "synthetic-shutdown",
  "enrollment.json",
);

const BUNDLE = projectPreProductionAudit({
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
      name: "core.ui.state",
      version: "1.0.0",
      policyClass: "auto",
      mutationScopePolicy: "none",
      executor: "bridge",
    },
  ],
  events: [
    {
      schema: "revagent.event.v2",
      event_id: "018f1f5a-7b00-7000-8000-000000000001",
      event_type: "tool.invocation",
      occurred_at: RECORDED_AT,
      recorded_at: RECORDED_AT,
      tenant_id: TENANT_ID,
      source: {
        component: "revagent-gateway",
        version: "revagent.m4-preproduction-serving/v1",
        instance: "m4-lan-test",
      },
      actor: { type: "user", user_id: USER_ID },
      session_id: GATEWAY_SESSION_ID,
      seq: 1,
      payload: {
        dispatch_attempt_id: "018f1f5a-7b00-7000-8000-000000000002",
        invocation_id: "018f1f5a-7b00-7000-8000-000000000003",
        idempotency_key: null,
        principal_key: PRINCIPAL_KEY,
        actor_role: "user",
        gateway_session_id: GATEWAY_SESSION_ID,
        oauth_client_id: "SYNTHETIC-SHUTDOWN-OAUTH-CLIENT",
        mcp_session_id: "SYNTHETIC-SHUTDOWN-MCP-SESSION",
        rsid: null,
        tool_name: "core.ui.state",
        tool_version: "1.0.0",
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
        params_digest: `sha256:${"a".repeat(64)}`,
        mutation_scope: null,
        recovery_hold_ids: [],
        recovery_resolution_ids: [],
        outcome: "completed",
        outcome_error_code: null,
        executor_reached: true,
        started_at_ms: Date.parse(RECORDED_AT) - 25,
        completed_at_ms: Date.parse(RECORDED_AT),
        duration_ms: 25,
      },
    },
  ],
});

function captureWriter(
  lines: string[],
  sequence?: string[],
  step?: string,
): PreProductionAuditTextWriter {
  return Object.freeze({
    write(
      value: string,
      _options: { readonly signal: AbortSignal },
      callback: (error?: unknown) => void,
    ): void {
      if (step !== undefined) sequence?.push(step);
      lines.push(value);
      callback();
    },
  });
}

function captureArtifact(
  values: string[],
  sequence?: string[],
): PreProductionAuditAtomicArtifactWriter {
  return Object.freeze({
    async commit(
      value: string,
      options: PreProductionAuditAtomicCommitOptions,
    ): Promise<void> {
      values.push(value);
      sequence?.push("artifact");
      options.markCommitted();
    },
  });
}

function launchFixture(input: {
  readonly cleanup: () => Promise<void>;
  readonly exportAuditSnapshot: () => Promise<PreProductionAuditExportBundle>;
}): PreProductionServingLaunch {
  return {
    cleanup: input.cleanup,
    enrollmentOutputPath: ENROLLMENT_PATH,
    prepared: {
      exportAuditSnapshot: input.exportAuditSnapshot,
    },
  } as unknown as PreProductionServingLaunch;
}

describe("M4 pre-production serving shutdown audit ownership", () => {
  it("orders cleanup, snapshot, and atomic sibling artifact commit", async () => {
    const sequence: string[] = [];
    const artifacts: string[] = [];
    const stderr: string[] = [];
    const paths: string[] = [];
    const launch = launchFixture({
      cleanup: vi.fn(async () => {
        sequence.push("cleanup");
      }),
      exportAuditSnapshot: vi.fn(async () => {
        sequence.push("snapshot");
        return BUNDLE;
      }),
    });

    await expect(
      completePreProductionServingShutdown(launch, "SIGTERM", {
        stderr: captureWriter(stderr, sequence, "stderr"),
        createAuditArtifact(filePath) {
          paths.push(filePath);
          return captureArtifact(artifacts, sequence);
        },
      }),
    ).resolves.toBe(0);

    expect(sequence).toEqual(["cleanup", "snapshot", "artifact"]);
    expect(paths).toEqual([
      join(process.cwd(), "synthetic-shutdown", "enrollment.audit.jsonl"),
    ]);
    expect(stderr).toEqual([]);
    expect(artifacts).toHaveLength(1);
    expect(JSON.parse(artifacts[0] ?? "")).toEqual({
      ok: true,
      action: "export_preproduction_audit",
      state: "complete",
      bundle: BUNDLE,
    });
  });

  it("does not snapshot or construct an artifact after cleanup failure", async () => {
    const stderr: string[] = [];
    const exportAuditSnapshot = vi.fn(async () => BUNDLE);
    const createAuditArtifact = vi.fn(() => captureArtifact([]));
    const launch = launchFixture({
      cleanup: vi.fn(async () => {
        throw new Error(CANARY);
      }),
      exportAuditSnapshot,
    });

    await expect(
      completePreProductionServingShutdown(launch, "SIGINT", {
        stderr: captureWriter(stderr),
        createAuditArtifact,
      }),
    ).resolves.toBe(1);

    expect(exportAuditSnapshot).not.toHaveBeenCalled();
    expect(createAuditArtifact).not.toHaveBeenCalled();
    expect(JSON.parse(stderr[0] ?? "")).toEqual({
      level: "fatal",
      msg: "gateway.preproduction_shutdown_failed",
      signal: "SIGINT",
      reason: "internal_error",
    });
    expect(stderr.join("\n")).not.toContain("SYNTHETIC-");
  });

  it("normalizes a value-bearing snapshot failure to fixed stderr", async () => {
    const stderr: string[] = [];
    const createAuditArtifact = vi.fn(() => captureArtifact([]));
    const launch = launchFixture({
      cleanup: vi.fn(async () => undefined),
      exportAuditSnapshot: vi.fn(async () => {
        throw new Error(CANARY, { cause: new Error(`cause-${CANARY}`) });
      }),
    });

    await expect(
      completePreProductionServingShutdown(launch, "SIGTERM", {
        stderr: captureWriter(stderr),
        createAuditArtifact,
      }),
    ).resolves.toBe(1);

    expect(createAuditArtifact).not.toHaveBeenCalled();
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      code: "preproduction_audit_export_refused",
      reason: "export_refused",
    });
    for (const fragment of ["SYNTHETIC-", "HEAD", "MIDDLE", "TAIL"]) {
      expect(stderr.join("\n")).not.toContain(fragment);
    }
  });

  it("normalizes an artifact construction failure without reflecting it", async () => {
    const stderr: string[] = [];
    const launch = launchFixture({
      cleanup: vi.fn(async () => undefined),
      exportAuditSnapshot: vi.fn(async () => BUNDLE),
    });

    await expect(
      completePreProductionServingShutdown(launch, "SIGTERM", {
        stderr: captureWriter(stderr),
        createAuditArtifact() {
          throw new Error(CANARY);
        },
      }),
    ).resolves.toBe(1);

    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      reason: "artifact_commit_failed",
    });
    expect(stderr.join("\n")).not.toContain(CANARY);
  });
});
