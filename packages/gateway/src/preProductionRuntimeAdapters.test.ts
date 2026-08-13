import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import type { GatewayJsonObject } from "./dispatch.js";
import type { GatewayEventEnvelope } from "./events.js";
import {
  createPreProductionRuntimeAdapters,
  PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS,
} from "./preProductionRuntimeAdapters.js";
import type {
  GatewayProtocolStore,
  StoreExpectation,
  StoredRecord,
} from "./store.js";

const NOW_MS = 1_800_000_000_000;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function write(
  store: GatewayProtocolStore,
  input: {
    readonly tenantId: string;
    readonly key: string;
    readonly value: GatewayJsonObject | null;
    readonly expect?: StoreExpectation;
  },
) {
  return await store.transact({ tenantId: input.tenantId }, (tx) => {
    tx.stage({
      namespace: "runtime.test/v1",
      key: input.key,
      value: input.value,
      expect: input.expect ?? { kind: "absent" },
    });
    return "written" as const;
  });
}

async function read(
  store: GatewayProtocolStore,
  tenantId: string,
  key: string,
): Promise<StoredRecord | null> {
  const outcome = await store.transact({ tenantId }, (tx) =>
    tx.read("runtime.test/v1", key),
  );
  if (!outcome.ok) throw new Error("fixture read was refused");
  return outcome.value;
}

function event(
  eventId: string,
  payload: GatewayJsonObject = { state: "bounded" },
): GatewayEventEnvelope {
  return {
    schema: "revagent.event.v2",
    event_id: eventId,
    event_type: "tool.invocation",
    occurred_at: "2027-01-15T08:00:00.000Z",
    recorded_at: "2027-01-15T08:00:00.000Z",
    tenant_id: "tenant-runtime",
    source: {
      component: "gateway",
      version: "m4-04-test",
      instance: "preproduction-runtime",
    },
    actor: { type: "user", user_id: "user-runtime" },
    session_id: "session-runtime",
    seq: 1,
    payload,
  };
}

function auth(): AuthContext {
  return {
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: {
      type: "user",
      tenantId: "tenant-runtime",
      userId: "user-runtime",
      role: "user",
      oidcIssuer: "https://issuer.invalid/runtime",
      oidcSubject: "subject-runtime",
    },
    session: {
      sessionId: "session-runtime",
      clientType: "mcp",
      mcpSessionId: "mcp-runtime",
      oauthClientId: "client-runtime",
    },
    principalKey: "tenant-runtime:user-runtime",
    issuedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 60_000,
  };
}

describe("M4 pre-production runtime adapters", () => {
  it("is a standalone pre-production graph with explicit finite defaults", async () => {
    const source = await readFile(
      new URL("./preProductionRuntimeAdapters.ts", import.meta.url),
      "utf8",
    );
    const adapters = createPreProductionRuntimeAdapters({
      clock: () => NOW_MS,
    });

    expect(source).not.toContain("./testAdapters");
    expect(adapters.protocolStore.kind).toBe("preproduction");
    expect(adapters.events.kind).toBe("preproduction");
    expect(adapters.entitlement.kind).toBe("preproduction");
    expect(PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS).toMatchObject({
      maxRecords: expect.any(Number),
      maxTotalRecordValueBytes: expect.any(Number),
      maxTransactionWrites: expect.any(Number),
      maxConcurrentTransactions: expect.any(Number),
      maxEvents: expect.any(Number),
      maxTotalEventBytes: expect.any(Number),
    });
    expect(
      Object.values(PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS).every(
        (limit) => Number.isSafeInteger(limit) && limit > 0,
      ),
    ).toBe(true);
  });

  it("defaults entitlement to deny and grants only exact caller-supplied sets", async () => {
    const denied = createPreProductionRuntimeAdapters().entitlement;
    await expect(
      denied.checkModuleEntitlement({ auth: auth(), moduleName: "core" }),
    ).resolves.toEqual({ ok: true, value: false });
    await expect(
      denied.checkToolEntitlement({
        auth: auth(),
        toolName: "core.ui.state",
        toolVersion: "1.0.0",
      }),
    ).resolves.toEqual({ ok: true, value: false });

    const granted = createPreProductionRuntimeAdapters({
      entitlement: {
        allowedModules: ["core"],
        allowedToolNames: ["core.ui.state"],
      },
    }).entitlement;
    await expect(
      granted.checkModuleEntitlement({ auth: auth(), moduleName: "core" }),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(
      granted.checkModuleEntitlement({ auth: auth(), moduleName: "mech" }),
    ).resolves.toEqual({ ok: true, value: false });
    await expect(
      granted.checkToolEntitlement({
        auth: auth(),
        toolName: "core.ui.state",
        toolVersion: "1.0.0",
      }),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(
      granted.checkToolEntitlement({
        auth: auth(),
        toolName: "core.ui.state.extra",
        toolVersion: "1.0.0",
      }),
    ).resolves.toEqual({ ok: true, value: false });
  });

  it("refuses malformed entitlement auth and request fields without reflecting values", async () => {
    const sentinel = "SYNTHETIC-ENTITLEMENT-SECRET";
    const entitlement = createPreProductionRuntimeAdapters({
      entitlement: {
        allowedModules: ["core"],
        allowedToolNames: ["core.ui.state"],
      },
    }).entitlement;
    const malformedAuth = {
      ...auth(),
      contractVersion: "invalid",
      principalKey: sentinel,
    } as unknown as AuthContext;
    const malformed = await entitlement.checkToolEntitlement({
      auth: malformedAuth,
      toolName: sentinel,
      toolVersion: "1.0.0",
    });

    expect(malformed).toEqual({
      ok: false,
      port: "entitlement",
      code: "unavailable",
      message: "pre-production entitlement request was rejected",
    });
    expect(JSON.stringify(malformed)).not.toContain(sentinel);
  });

  it("isolates tenant reads/lists and returns detached record values", async () => {
    const { protocolStore } = createPreProductionRuntimeAdapters({
      protocolStore: { clock: () => NOW_MS },
    });
    await expect(protocolStore.open()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      write(protocolStore, {
        tenantId: "tenant-a",
        key: "shared-key",
        value: { nested: { state: "tenant-a" } },
      }),
    ).resolves.toEqual({ ok: true, value: "written" });

    const foreignRead = await protocolStore.transact(
      { tenantId: "tenant-b" },
      async (tx) => ({
        record: await tx.read("runtime.test/v1", "shared-key"),
        listed: await tx.list("runtime.test/v1"),
      }),
    );
    expect(foreignRead).toEqual({
      ok: true,
      value: { record: null, listed: [] },
    });

    const ownerRecord = await read(protocolStore, "tenant-a", "shared-key");
    expect(ownerRecord).toMatchObject({
      tenantId: "tenant-a",
      value: { nested: { state: "tenant-a" } },
      version: 1,
      updatedAtMs: NOW_MS,
    });
    const mutable = ownerRecord?.value as {
      nested: { state: string };
    };
    mutable.nested.state = "mutated-outside-store";
    await expect(read(protocolStore, "tenant-a", "shared-key")).resolves.toMatchObject({
      value: { nested: { state: "tenant-a" } },
    });
  });

  it("rolls callback failures back and keeps every refusal value-free", async () => {
    const sentinel = "SYNTHETIC-RUNTIME-SECRET-DO-NOT-REPORT";
    const { protocolStore } = createPreProductionRuntimeAdapters({
      protocolStore: { clock: () => NOW_MS },
    });

    expect(await protocolStore.transact({ tenantId: "tenant-a" }, () => 1)).toEqual({
      ok: false,
      code: "unavailable",
      message: "pre-production protocol store is unavailable",
    });
    await protocolStore.open();
    const rolledBack = await protocolStore.transact(
      { tenantId: "tenant-a" },
      (tx) => {
        tx.stage({
          namespace: "runtime.test/v1",
          key: "rollback",
          value: { secret: sentinel },
          expect: { kind: "absent" },
        });
        throw new Error(sentinel);
      },
    );
    expect(rolledBack).toEqual({
      ok: false,
      code: "invalid_record",
      message: "pre-production protocol store rejected an invalid transaction",
    });
    expect(JSON.stringify(rolledBack)).not.toContain(sentinel);
    await expect(read(protocolStore, "tenant-a", "rollback")).resolves.toBeNull();

    const invalidTenant = await protocolStore.transact(
      { tenantId: `tenant\u0000${sentinel}` },
      () => 1,
    );
    expect(invalidTenant).toEqual({
      ok: false,
      code: "tenant_isolation_violation",
      message: "pre-production protocol store rejected the tenant scope",
    });
    expect(JSON.stringify(invalidTenant)).not.toContain(sentinel);
  });

  it("detects optimistic conflicts at commit without leaking record identity", async () => {
    const sentinelKey = "SYNTHETIC-CONFLICT-KEY";
    const { protocolStore } = createPreProductionRuntimeAdapters({
      protocolStore: { clock: () => NOW_MS },
    });
    await protocolStore.open();
    await write(protocolStore, {
      tenantId: "tenant-a",
      key: sentinelKey,
      value: { revision: 1 },
    });
    const firstRead = deferred();
    const releaseFirst = deferred();
    const first = protocolStore.transact({ tenantId: "tenant-a" }, async (tx) => {
      const current = await tx.read("runtime.test/v1", sentinelKey);
      if (current === null) throw new Error("record must exist");
      tx.stage({
        namespace: "runtime.test/v1",
        key: sentinelKey,
        value: { revision: 2, writer: "first" },
        expect: { kind: "version", version: current.version },
      });
      firstRead.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstRead.promise;

    const second = await protocolStore.transact(
      { tenantId: "tenant-a" },
      async (tx) => {
        const current = await tx.read("runtime.test/v1", sentinelKey);
        if (current === null) throw new Error("record must exist");
        tx.stage({
          namespace: "runtime.test/v1",
          key: sentinelKey,
          value: { revision: 2, writer: "second" },
          expect: { kind: "version", version: current.version },
        });
        return "second";
      },
    );
    releaseFirst.resolve();

    expect(second).toEqual({ ok: true, value: "second" });
    const conflicted = await first;
    expect(conflicted).toEqual({
      ok: false,
      code: "conflict",
      message: "pre-production protocol store transaction conflicted",
    });
    expect(JSON.stringify(conflicted)).not.toContain(sentinelKey);
    await expect(read(protocolStore, "tenant-a", sentinelKey)).resolves.toMatchObject({
      value: { revision: 2, writer: "second" },
      version: 2,
    });
  });

  it("applies record, byte, write and concurrent-transaction bounds atomically", async () => {
    const sentinel = "SYNTHETIC-OVERSIZE-VALUE";
    const { protocolStore } = createPreProductionRuntimeAdapters({
      protocolStore: {
        clock: () => NOW_MS,
        maxRecords: 1,
        maxRecordValueBytes: 96,
        maxTotalRecordValueBytes: 96,
        maxTransactionWrites: 2,
        maxConcurrentTransactions: 1,
      },
    });
    await protocolStore.open();
    await write(protocolStore, {
      tenantId: "tenant-a",
      key: "stable",
      value: { revision: 1 },
    });

    const recordOverflow = await protocolStore.transact(
      { tenantId: "tenant-a" },
      (tx) => {
        tx.stage({
          namespace: "runtime.test/v1",
          key: "stable",
          value: { revision: 2 },
          expect: { kind: "version", version: 1 },
        });
        tx.stage({
          namespace: "runtime.test/v1",
          key: "overflow",
          value: { revision: 1 },
          expect: { kind: "absent" },
        });
      },
    );
    expect(recordOverflow).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
    await expect(read(protocolStore, "tenant-a", "stable")).resolves.toMatchObject({
      value: { revision: 1 },
      version: 1,
    });
    await expect(read(protocolStore, "tenant-a", "overflow")).resolves.toBeNull();

    const oversized = await write(protocolStore, {
      tenantId: "tenant-a",
      key: "oversized",
      value: { secret: sentinel.repeat(8) },
    });
    expect(oversized).toMatchObject({ ok: false, code: "invalid_record" });
    expect(JSON.stringify(oversized)).not.toContain(sentinel);

    const entered = deferred();
    const release = deferred();
    const held = protocolStore.transact({ tenantId: "tenant-a" }, async () => {
      entered.resolve();
      await release.promise;
      return "held";
    });
    await entered.promise;
    await expect(
      protocolStore.transact({ tenantId: "tenant-a" }, () => "second"),
    ).resolves.toEqual({
      ok: false,
      code: "unavailable",
      message: "pre-production protocol store is unavailable",
    });
    release.resolve();
    await expect(held).resolves.toEqual({ ok: true, value: "held" });
  });

  it("buffers detached events and rejects over-limit batches atomically and value-free", async () => {
    const sentinel = "SYNTHETIC-EVENT-SECRET";
    const { events } = createPreProductionRuntimeAdapters({
      events: {
        maxEvents: 2,
        maxEventBytes: 512,
        maxTotalEventBytes: 768,
      },
    });
    const first = event("event-1", { state: "before" });
    await expect(events.emit(first)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    (first.payload as { state: string }).state = "after";
    expect(events.snapshot()[0]?.payload).toEqual({ state: "before" });

    const overflow = await events.emitBatch([
      event("event-2"),
      event("event-3"),
    ]);
    expect(overflow).toEqual({
      ok: false,
      port: "event_sink",
      code: "unavailable",
      message: "pre-production event sink rejected the event batch",
    });
    expect(events.snapshot().map((entry) => entry.event_id)).toEqual(["event-1"]);

    const oversized = await events.emit(
      event("event-secret", { secret: sentinel.repeat(64) }),
    );
    expect(oversized).toEqual({
      ok: false,
      port: "event_sink",
      code: "unavailable",
      message: "pre-production event sink rejected the event batch",
    });
    expect(JSON.stringify(oversized)).not.toContain(sentinel);
    expect(events.snapshot().map((entry) => entry.event_id)).toEqual(["event-1"]);
    await expect(events.flush()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });
});
