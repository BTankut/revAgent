import { makeParamsDigest } from "@revagent/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import {
  GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
  GATEWAY_CONFIRMATION_NAMESPACE,
  GATEWAY_CONFIRMATION_TTL_MS,
  GatewayConfirmationAuthority,
  type GatewayConfirmationProof,
  type GatewayPendingActionBinding,
} from "./confirmationAuthority.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { createRestartableTestStore } from "./testAdapters.js";
import type { GatewayProtocolStore } from "./store.js";

const TENANT_ID = "tenant-confirmation-test";
const PREVIEW_INVOCATION_ID = gatewayUuidV7(2_000);
const COMMIT_INVOCATION_ID = gatewayUuidV7(3_000);
const TOKEN_SECRET = "A".repeat(43);

const baseBinding: GatewayPendingActionBinding = Object.freeze({
  tenantId: TENANT_ID,
  principalKey: `${TENANT_ID}:user-a`,
  userId: "user-a",
  gatewaySessionId: "gateway-session-a",
  confirmationSessionId: "mcp-session-a",
  oauthClientId: "codex-desktop-a",
  rsid: "rsid-confirmation-a",
  toolName: "core.parameter.set",
  toolVersion: "1.0.0",
  commitArgsDigest: makeParamsDigest({ mode: "commit", value: "ready" }),
  mutationScope: Object.freeze({ kind: "session" as const }),
  documentIdentity: Object.freeze({
    kind: "live" as const,
    session_document_id: "document-a",
  }),
});

async function open(store: GatewayProtocolStore): Promise<void> {
  await expect(store.open()).resolves.toEqual({ ok: true, value: undefined });
}

describe("GatewayConfirmationAuthority durable pending actions", () => {
  let now: number;

  beforeEach(() => {
    now = 10_000;
  });

  async function issue() {
    const restartable = createRestartableTestStore();
    await open(restartable.store);
    const authority = new GatewayConfirmationAuthority(restartable.store, {
      clock: () => now,
      newConfirmationId: () => gatewayUuidV7(1_000),
      newTokenSecret: () => TOKEN_SECRET,
    });
    const issued = await authority.createPendingAction({
      ...baseBinding,
      effectiveMcpRequestScope: createEffectiveMcpRequestScopeV1({
        principalKey: baseBinding.principalKey,
        transportMcpSessionId: baseBinding.confirmationSessionId,
        identityMcpSessionId: null,
        nowMs: 1_775_000_000_000,
      }),
      originatingPreviewInvocationId: PREVIEW_INVOCATION_ID,
      previewDigest: makeParamsDigest({ preview: "bounded" }),
      previewRef: "inline:preview-a",
    });
    if (issued.kind !== "issued") {
      throw new Error(`expected issued pending action: ${issued.message}`);
    }
    return { authority, issued, restartable };
  }

  function proof(
    confirmToken: string,
    overrides: Partial<GatewayConfirmationProof> = {},
  ): GatewayConfirmationProof {
    return Object.freeze({
      confirmToken,
      originatingPreviewInvocationId: PREVIEW_INVOCATION_ID,
      commitInvocationId: COMMIT_INVOCATION_ID,
      binding: baseBinding,
      ...overrides,
    });
  }

  it("persists a ten-minute pending action without the raw token", async () => {
    const { issued, restartable } = await issue();

    expect(issued.pendingAction).toMatchObject({
      state: "pending",
      issuedAtMs: now,
      expiresAtMs: now + GATEWAY_CONFIRMATION_TTL_MS,
      originatingPreviewInvocationId: PREVIEW_INVOCATION_ID,
      commitInvocationId: null,
    });
    expect(issued.confirmToken).toContain(TOKEN_SECRET);
    const snapshotText = JSON.stringify(restartable.snapshot());
    expect(snapshotText).not.toContain(issued.confirmToken);
    expect(snapshotText).not.toContain(TOKEN_SECRET);
    expect(
      restartable
        .snapshot()
        .records.filter(
          (record) => record.namespace === GATEWAY_CONFIRMATION_NAMESPACE,
        ),
    ).toHaveLength(1);
  });

  it("consumes once with CAS and remains replay-denied after restart", async () => {
    const { authority, issued, restartable } = await issue();
    const first = await restartable.store.transact(
      { tenantId: TENANT_ID },
      async (tx) => {
        const validated = await authority.validatePendingAction(
          tx,
          proof(issued.confirmToken),
          now,
        );
        expect(validated.kind).toBe("validated");
        if (validated.kind !== "validated") return validated;
        return authority.stageConsumption(
          tx,
          validated,
          COMMIT_INVOCATION_ID,
          now,
        );
      },
    );
    expect(first).toMatchObject({
      ok: true,
      value: { state: "consumed", commitInvocationId: COMMIT_INVOCATION_ID },
    });
    expect(
      restartable
        .snapshot()
        .records.filter(
          (record) =>
            record.namespace === GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
        ),
    ).toMatchObject([
      {
        value: {
          state: "approved",
          confirmationId: issued.pendingAction.confirmationId,
          tenantId: TENANT_ID,
          originatingPreviewInvocationId: PREVIEW_INVOCATION_ID,
          commitInvocationId: COMMIT_INVOCATION_ID,
        },
      },
    ]);

    const restartedStore = restartable.restart();
    await open(restartedStore);
    const restarted = new GatewayConfirmationAuthority(restartedStore, {
      clock: () => now,
    });
    const replay = await restartedStore.transact(
      { tenantId: TENANT_ID },
      (tx) =>
        restarted.validatePendingAction(
          tx,
          proof(issued.confirmToken),
          now,
        ),
    );
    expect(replay).toMatchObject({
      ok: true,
      value: { kind: "rejected", reason: "replayed" },
    });
  });

  it("lets only one concurrent consumption commit", async () => {
    const { authority, issued, restartable } = await issue();
    const consume = () =>
      restartable.store.transact({ tenantId: TENANT_ID }, async (tx) => {
        const validated = await authority.validatePendingAction(
          tx,
          proof(issued.confirmToken),
          now,
        );
        if (validated.kind !== "validated") return validated;
        return authority.stageConsumption(
          tx,
          validated,
          COMMIT_INVOCATION_ID,
          now,
        );
      });

    const results = await Promise.all([consume(), consume()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "conflict" }),
    ]);
  });

  it("expires at the exact deadline and persists terminal expiry", async () => {
    const { authority, issued, restartable } = await issue();
    now += GATEWAY_CONFIRMATION_TTL_MS;
    const expired = await restartable.store.transact(
      { tenantId: TENANT_ID },
      (tx) =>
        authority.validatePendingAction(
          tx,
          proof(issued.confirmToken),
          now,
        ),
    );
    expect(expired).toMatchObject({
      ok: true,
      value: { kind: "rejected", reason: "expired" },
    });
    expect(JSON.stringify(restartable.snapshot())).toContain('"state":"expired"');
  });

  it.each([
    ["tenant", { tenantId: "tenant-confirmation-other" }, "foreign_tenant"],
    ["actor", { principalKey: `${TENANT_ID}:user-b` }, "foreign_actor"],
    ["session", { confirmationSessionId: "mcp-session-b" }, "foreign_session"],
    ["route", { rsid: "rsid-confirmation-b" }, "not_found"],
    ["tool", { toolName: "core.schedule.set_cells" }, "tool_mismatch"],
    ["version", { toolVersion: "1.0.1" }, "tool_version_mismatch"],
    [
      "args",
      { commitArgsDigest: makeParamsDigest({ mode: "commit", value: "changed" }) },
      "args_mismatch",
    ],
    ["scope", { mutationScope: { kind: "document", document_id: "document-a" } }, "scope_mismatch"],
    [
      "document",
      {
        documentIdentity: {
          kind: "live",
          session_document_id: "document-b",
        },
      },
      "document_mismatch",
    ],
  ] as const)("rejects a changed %s binding", async (_label, changed, reason) => {
    const { authority, issued, restartable } = await issue();
    const result = await restartable.store.transact(
      { tenantId: TENANT_ID },
      (tx) =>
        authority.validatePendingAction(
          tx,
          proof(issued.confirmToken, {
            binding: { ...baseBinding, ...changed } as GatewayPendingActionBinding,
          }),
          now,
        ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "rejected", reason },
    });
  });

  it("rejects an unrelated preview without consuming the valid action", async () => {
    const { authority, issued, restartable } = await issue();
    const unrelated = await restartable.store.transact(
      { tenantId: TENANT_ID },
      (tx) =>
        authority.validatePendingAction(
          tx,
          proof(issued.confirmToken, {
            originatingPreviewInvocationId: gatewayUuidV7(2_001),
          }),
          now,
        ),
    );
    expect(unrelated).toMatchObject({
      ok: true,
      value: { kind: "rejected", reason: "preview_mismatch" },
    });
    const exact = await restartable.store.transact(
      { tenantId: TENANT_ID },
      (tx) =>
        authority.validatePendingAction(
          tx,
          proof(issued.confirmToken),
          now,
        ),
    );
    expect(exact).toMatchObject({ ok: true, value: { kind: "validated" } });
  });
});
