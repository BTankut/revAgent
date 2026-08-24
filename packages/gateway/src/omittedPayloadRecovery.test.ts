import { describe, expect, it } from "vitest";

import { gatewayUuidV7 } from "./identifiers.js";
import {
  claimOmittedPayloadRecovery,
  completeOmittedPayloadRecovery,
  type OmittedPayloadRecoveryAdmission,
  type OmittedPayloadRecoveryCurrentOwner,
} from "./omittedPayloadRecovery.js";
import type { GatewayProtocolStore } from "./store.js";
import { createRestartableTestStore } from "./testAdapters.js";

let offset = 0;
const id = (): string => gatewayUuidV7(1_775_000_000_000 + offset++);
const digest = (fill: string): `sha256:${string}` => `sha256:${fill.repeat(64)}`;

function admission(overrides: Partial<OmittedPayloadRecoveryAdmission> = {}): OmittedPayloadRecoveryAdmission {
  return {
    owner: {
      tenantId: "tenant-c39",
      userId: "user-c39",
      effectiveMcpSessionId: "mcp-c39",
      rsid: "rsid-c39",
      sessionBindingId: id(),
      sessionVersion: 3,
    },
    originInvocationId: id(),
    originResultDigest: digest("a"),
    newCarrierRecoveryInvocationId: id(),
    terminalEvidenceDigest: digest("b"),
    terminalRetentionExpiresAtMs: 1_775_000_060_000,
    ownerSessionExpiresAtMs: 1_775_000_120_000,
    nowMs: 1_775_000_000_000,
    ...overrides,
  };
}

function currentOwner(
  value: OmittedPayloadRecoveryAdmission,
  overrides: Partial<OmittedPayloadRecoveryCurrentOwner> = {},
): OmittedPayloadRecoveryCurrentOwner {
  return {
    ...value.owner,
    active: true,
    ownerSessionExpiresAtMs: value.ownerSessionExpiresAtMs,
    nowMs: value.nowMs,
    ...overrides,
  };
}

async function claimWithRetry(
  store: GatewayProtocolStore,
  value: OmittedPayloadRecoveryAdmission,
  owner: OmittedPayloadRecoveryCurrentOwner = currentOwner(value),
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await store.transact(
      { tenantId: value.owner.tenantId },
      async (tx) => await claimOmittedPayloadRecovery(tx, value, owner),
    );
    if (result.ok) return result.value;
    if (result.code !== "conflict") throw new Error(result.message);
  }
  throw new Error("CAS retry limit exhausted");
}

describe("omitted payload recovery CAS admission", () => {
  it("makes concurrent identical claims converge without any origin executor", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const value = admission();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => await claimWithRetry(fixture.store, value)),
    );
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "admitted", "resume", "resume", "resume", "resume", "resume",
      "resume", "resume", "resume", "resume", "resume", "resume",
    ]);
    // The owner admission and its reverse recovery-invocation index are both
    // durable so a C1d terminal can be correlated after a process restart.
    expect(fixture.snapshot().records).toHaveLength(2);
  });

  it("denies binding drift and cross-owner or digest substitution with one guarded shape", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const value = admission();
    await claimWithRetry(fixture.store, value);
    const attempts = await Promise.all([
      claimWithRetry(fixture.store, { ...value, originResultDigest: digest("c") }),
      claimWithRetry(fixture.store, { ...value, owner: { ...value.owner, userId: "other-user" } }),
      claimWithRetry(fixture.store, { ...value, owner: { ...value.owner, sessionVersion: 4 } }),
      claimWithRetry(fixture.store, { ...value, terminalEvidenceDigest: digest("d") }),
    ]);
    expect(attempts).toEqual([{ kind: "guarded" }, { kind: "guarded" }, { kind: "guarded" }, { kind: "guarded" }]);
  });

  it("joins a new North request identity to the first durable carrier identity", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const first = admission();
    const retry = {
      ...first,
      newCarrierRecoveryInvocationId: id(),
    };
    const winner = await claimWithRetry(fixture.store, first);
    const joined = await claimWithRetry(fixture.store, retry);
    expect(winner).toMatchObject({ kind: "admitted" });
    expect(joined).toMatchObject({ kind: "resume" });
    if (winner.kind === "guarded" || joined.kind === "guarded") {
      throw new Error("exact recovery retry was unexpectedly guarded");
    }
    expect(joined.record.carrierRecoveryInvocationId)
      .toBe(winner.record.carrierRecoveryInvocationId);
  });

  it("survives restart as a bounded resume and completes idempotently under a distinct ref digest", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const value = admission();
    await claimWithRetry(fixture.store, value);
    const restarted = fixture.restart();
    await restarted.open();
    await expect(claimWithRetry(restarted, value)).resolves.toMatchObject({ kind: "resume" });
    const complete = await restarted.transact(
      { tenantId: value.owner.tenantId },
      async (tx) => await completeOmittedPayloadRecovery(tx, value, currentOwner(value), digest("e")),
    );
    expect(complete).toMatchObject({ ok: true, value: { kind: "completed", record: {
      originResultDigest: digest("a"), resultReferenceDigest: digest("e"),
    } } });
    const repeated = await restarted.transact(
      { tenantId: value.owner.tenantId },
      async (tx) => await completeOmittedPayloadRecovery(tx, value, currentOwner(value), digest("e")),
    );
    expect(repeated).toMatchObject({ ok: true, value: { kind: "completed" } });
    const substituted = await restarted.transact(
      { tenantId: value.owner.tenantId },
      async (tx) => await completeOmittedPayloadRecovery(tx, value, currentOwner(value), digest("f")),
    );
    expect(substituted).toEqual({ ok: true, value: { kind: "guarded" } });
  });

  it("fails closed for a malformed legacy-like record", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const value = admission();
    await fixture.store.transact({ tenantId: value.owner.tenantId }, async (tx) => {
      tx.stage({
        namespace: "gateway.omitted-payload-recovery/v1",
        key: value.originInvocationId,
        value: { schema: "gateway.omitted-payload-recovery/v1" },
        expect: { kind: "absent" },
      });
    });
    await expect(claimWithRetry(fixture.store, value)).resolves.toEqual({ kind: "guarded" });
  });

  it("expires restart resumes and rejects stale authority completion", async () => {
    const fixture = createRestartableTestStore();
    await fixture.store.open();
    const value = admission();
    await claimWithRetry(fixture.store, value);
    const restarted = fixture.restart();
    await restarted.open();
    const expired = currentOwner(value, { nowMs: value.terminalRetentionExpiresAtMs });
    await expect(claimWithRetry(restarted, value, expired)).resolves.toEqual({ kind: "guarded" });
    const staleComplete = await restarted.transact(
      { tenantId: value.owner.tenantId },
      async (tx) => await completeOmittedPayloadRecovery(tx, value, expired, digest("e")),
    );
    expect(staleComplete).toEqual({ ok: true, value: { kind: "guarded" } });
  });
});
