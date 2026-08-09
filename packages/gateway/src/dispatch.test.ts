import { readFileSync } from "node:fs";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import {
  GatewayDispatcher,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
} from "./dispatch.js";
import {
  canonicalParamsDigest,
  currentGatewayInvocationContext,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
import { createUnavailableEventSink } from "./events.js";
import {
  GatewayToolRegistry,
  type GatewayToolRecord,
} from "./registry.js";
import {
  createCapturingEventSink,
  type CapturingEventSink,
} from "./testAdapters.js";

const autoRecord: GatewayToolRecord = {
  name: "core.test.read",
  summary: "Read a test value.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "auto",
  executor: "bridge",
  executorMethod: "test_read",
  inputSchema: { value: z.string().min(1) },
  inputJsonSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      value: { minLength: 1, type: "string" },
    },
    required: ["value"],
    type: "object",
  },
};

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const O1_PARAMS_DIGEST_VECTORS = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../protocol/conformance/fixtures/params-digest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    readonly vectors: readonly {
      readonly name: string;
      readonly params: unknown;
      readonly digest: string;
    }[];
  }
).vectors;

const auth: AuthContext = Object.freeze({
  contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
  actor: Object.freeze({
    type: "user" as const,
    tenantId: "tenant-a",
    userId: "user-a",
    role: "user" as const,
    oidcIssuer: "https://issuer.invalid/test",
    oidcSubject: "subject-a",
  }),
  session: Object.freeze({
    sessionId: "gateway-session-a",
    clientType: "mcp" as const,
    mcpSessionId: "mcp-session-test",
    oauthClientId: "codex-desktop-test",
  }),
  principalKey: "tenant-a:user-a",
  issuedAtMs: 1_000,
  expiresAtMs: null,
});

const route: GatewayInvocationRoute = Object.freeze({
  tenantId: "tenant-a",
  mcpSessionId: "mcp-session-test",
  rsid: "rsid-test-a",
  documentIdentity: Object.freeze({
    kind: "live" as const,
    session_document_id: "document-live-a",
  }),
  mutationScope: null,
});

function dispatchInput(
  args: unknown,
  overrides: {
    readonly auth?: AuthContext;
    readonly mcpSessionId?: string;
    readonly resolveRoute?: (auth: AuthContext) =>
      | GatewayInvocationRoute
      | Promise<GatewayInvocationRoute>;
    readonly route?: GatewayInvocationRoute;
  } = {},
) {
  const selectedAuth = overrides.auth ?? auth;
  const selectedRoute = overrides.route ?? route;
  return {
    toolName: autoRecord.name,
    args,
    auth: selectedAuth,
    mcpSessionId:
      overrides.mcpSessionId ??
      selectedAuth.session.mcpSessionId ??
      selectedRoute.mcpSessionId,
    resolveRoute: overrides.resolveRoute ?? (() => selectedRoute),
  } as const;
}

function createDispatcher(input: {
  readonly record?: GatewayToolRecord;
  readonly execute: (
    request: GatewayExecutorRequest,
  ) => Promise<GatewayExecutorOutcome>;
}): {
  readonly dispatcher: GatewayDispatcher;
  readonly executionCount: () => number;
  readonly executorRequests: () => readonly GatewayExecutorRequest[];
  readonly eventSink: CapturingEventSink;
} {
  let executions = 0;
  let sequence = 0;
  let now = 10_000;
  const executorRequests: GatewayExecutorRequest[] = [];
  const eventSink = createCapturingEventSink();
  const executor: GatewayExecutor = {
    binding: "bridge",
    async execute(request) {
      executions += 1;
      executorRequests.push(request);
      return input.execute(request);
    },
  };
  return {
    dispatcher: new GatewayDispatcher(
      new GatewayToolRegistry([input.record ?? autoRecord]),
      [executor],
      {
        eventSink,
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "dispatch-test",
        },
        clock: () => {
          now += 10;
          return now;
        },
        newInvocationId: () => `invocation-${++sequence}`,
        newEventId: () => `event-${sequence}`,
      },
    ),
    executionCount: () => executions,
    executorRequests: () => [...executorRequests],
    eventSink,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("GatewayDispatcher fail-closed boundaries", () => {
  it("validates direct dispatch arguments against the registry Zod shape", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: 42 })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "invalid_arguments" },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("blocks confirm and gated tools until policy middleware exists", async () => {
    const harness = createDispatcher({
      record: { ...autoRecord, policyClass: "confirm" },
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "policy_enforcement_unavailable" },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("preserves an executor failure as an MCP-error dispatch outcome", async () => {
    const harness = createDispatcher({
      execute: async () => ({
        state: "failed",
        error: {
          code: "bridge_revit_busy",
          message: "Revit is busy",
        },
      }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: {
        code: "executor_failed",
        executorCode: "bridge_revit_busy",
        message: "Revit is busy",
      },
    });
    expect(harness.executionCount()).toBe(1);
  });

  it("rejects an unknown runtime executor outcome state", async () => {
    const harness = createDispatcher({
      execute: async () =>
        ({
          state: "cancelled",
          result: {},
        }) as unknown as GatewayExecutorOutcome,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "invalid_executor_result" },
    });
    expect(harness.executionCount()).toBe(1);
  });

  it.each([new Date(0), new Map([["value", "ready"]])])(
    "rejects a non-plain executor result instead of silently serializing it",
    async (result) => {
      const harness = createDispatcher({
        execute: async () =>
          ({
            state: "completed",
            result,
          }) as unknown as GatewayExecutorOutcome,
      });

      await expect(
        harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
      ).resolves.toMatchObject({
        ok: false,
        state: "failed",
        error: { code: "invalid_executor_result" },
      });
      expect(harness.executionCount()).toBe(1);
    },
  );

  it("binds the authenticated route, canonical digest and audit event", async () => {
    const harness = createDispatcher({
      execute: async (request) => {
        expect(currentGatewayInvocationContext()).toBe(request.context);
        return { state: "completed", result: { ok: true } };
      },
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: true,
      requestId: "invocation-1",
      state: "completed",
    });
    expect(currentGatewayInvocationContext()).toBeUndefined();

    const request = harness.executorRequests()[0];
    expect(request?.context).toMatchObject({
      actor: {
        role: "user",
        tenantId: "tenant-a",
        userId: "user-a",
      },
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live-a",
      },
      executor: "bridge",
      gatewaySessionId: "gateway-session-a",
      idempotencyKey: "rsid-test-a/invocation-1",
      invocationId: "invocation-1",
      mcpSessionId: "mcp-session-test",
      mutationScope: null,
      oauthClientId: "codex-desktop-test",
      paramsDigest: canonicalParamsDigest({ value: "ready" }),
      policyClass: "auto",
      principalKey: "tenant-a:user-a",
      rsid: "rsid-test-a",
      toolName: "core.test.read",
      toolVersion: "1.0.0",
    });
    expect(harness.eventSink.captured()).toEqual([
      expect.objectContaining({
        actor: { type: "user", user_id: "user-a" },
        event_id: "event-1",
        event_type: "tool.invocation",
        seq: 1,
        session_id: "gateway-session-a",
        tenant_id: "tenant-a",
        payload: expect.objectContaining({
          completed_at_ms: 10_020,
          document_identity: {
            kind: "live",
            session_document_id: "document-live-a",
          },
          executor: "bridge",
          executor_reached: true,
          idempotency_key: "rsid-test-a/invocation-1",
          invocation_id: "invocation-1",
          mcp_session_id: "mcp-session-test",
          mutation_scope: null,
          outcome: "completed",
          outcome_error_code: null,
          params_digest: canonicalParamsDigest({ value: "ready" }),
          policy_class: "auto",
          rsid: "rsid-test-a",
          started_at_ms: 10_010,
          tool_name: "core.test.read",
          tool_version: "1.0.0",
        }),
      }),
    ]);
  });

  it.each([
    [
      "tenant",
      { ...route, tenantId: "tenant-b" },
      "tenant_binding_mismatch",
    ],
    [
      "MCP session",
      { ...route, mcpSessionId: "mcp-session-other" },
      "session_binding_mismatch",
    ],
  ] as const)(
    "rejects a cross-%s route before executor contact",
    async (_label, mismatchedRoute, detailCode) => {
      const harness = createDispatcher({
        execute: async () => ({ state: "completed", result: { ok: true } }),
      });

      await expect(
        harness.dispatcher.dispatch(
          dispatchInput(
            { value: "ready" },
            { route: mismatchedRoute as GatewayInvocationRoute },
          ),
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: "failed",
        error: {
          code: "invalid_invocation_context",
          detailCode,
        },
      });
      expect(harness.executionCount()).toBe(0);
      expect(harness.eventSink.captured()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            executor_reached: false,
            outcome: "failed",
            outcome_error_code: "invalid_invocation_context",
          }),
        }),
      ]);
    },
  );

  it("rejects a resolved session mismatch while AuthContext is not yet MCP-bound", async () => {
    const unboundAuth: AuthContext = {
      ...auth,
      session: { ...auth.session, mcpSessionId: null },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            auth: unboundAuth,
            mcpSessionId: "mcp-session-current",
            route: { ...route, mcpSessionId: "mcp-session-stale" },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "session_binding_mismatch",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("audits route-resolution failure without executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            resolveRoute: () => {
              throw new Error("authenticated route store is unavailable");
            },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "route_resolution_failed",
      },
    });
    expect(harness.executionCount()).toBe(0);
    expect(harness.eventSink.captured()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          executor_reached: false,
          mcp_session_id: "mcp-session-test",
          outcome: "failed",
          rsid: null,
        }),
      }),
    ]);
  });

  it("serializes executor contact per rsid", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const started: string[] = [];
    const harness = createDispatcher({
      execute: async (request) => {
        started.push(request.context.invocationId);
        if (request.context.invocationId === "invocation-1") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { state: "completed", result: { ok: true } };
      },
    });

    const first = harness.dispatcher.dispatch(dispatchInput({ value: "first" }));
    await firstStarted.promise;
    const second = harness.dispatcher.dispatch(dispatchInput({ value: "second" }));
    await Promise.resolve();
    expect(started).toEqual(["invocation-1"]);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(started).toEqual(["invocation-1", "invocation-2"]);
  });

  it("allows independent rsids to execute concurrently", async () => {
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    const harness = createDispatcher({
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        active -= 1;
        return { state: "completed", result: { ok: true } };
      },
    });

    const first = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "first" },
        { route: { ...route, rsid: "rsid-a" } },
      ),
    );
    const second = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "second" },
        { route: { ...route, rsid: "rsid-b" } },
      ),
    );

    await bothStarted.promise;
    expect(peak).toBe(2);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps parameter digests stable across object insertion order", () => {
    expect(
      canonicalParamsDigest({
        zeta: 1,
        alpha: { second: true, first: false },
      }),
    ).toBe(
      canonicalParamsDigest({
        alpha: { first: false, second: true },
        zeta: 1,
      }),
    );
  });

  it.each(O1_PARAMS_DIGEST_VECTORS)(
    "matches the frozen O1 $name parameter digest vector",
    ({ params, digest }) => {
      expect(canonicalParamsDigest(params)).toBe(digest);
    },
  );

  it("rejects non-RFC-8785 Unicode before executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "\ud800" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_invocation_context" },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("carries the frozen RBP session mutation scope", async () => {
    const sessionRoute: GatewayInvocationRoute = {
      ...route,
      mutationScope: { kind: "session" },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }, { route: sessionRoute }),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(harness.executorRequests()[0]?.context.mutationScope).toEqual({
      kind: "session",
    });
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      mutation_scope: { kind: "session" },
    });
  });

  it("rejects a live document scope that names another routed document", async () => {
    const mismatchedDocumentRoute: GatewayInvocationRoute = {
      ...route,
      mutationScope: {
        kind: "document",
        document_id: "document-live-b",
      },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          { route: mismatchedDocumentRoute },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "document_scope_mismatch",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("carries the RES-14 published document identity without APS execution", async () => {
    const publishedRoute: GatewayInvocationRoute = {
      ...route,
      documentIdentity: {
        kind: "published",
        acc_project_id: "acc-project-a",
        item_urn: "urn:adsk.wipprod:dm.lineage:item-a",
        version_urn: "urn:adsk.wipprod:fs.file:vf.item-a?version=7",
        version_number: 7,
      },
      mutationScope: {
        kind: "document",
        document_id: "published-document-a",
      },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }, { route: publishedRoute }),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(
      harness.executorRequests()[0]?.context.documentIdentity,
    ).toEqual(publishedRoute.documentIdentity);
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      document_identity: publishedRoute.documentIdentity,
    });
  });

  it("rejects an invalid published identity before executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            route: {
              ...route,
              documentIdentity: {
                kind: "published",
                acc_project_id: "acc-project-a",
                item_urn: "urn:item-a",
                version_urn: "urn:item-a:version:0",
                version_number: 0,
              },
            },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "invalid_document_identity",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("reports audit unavailability without hiding executor contact", async () => {
    const executor: GatewayExecutor = {
      binding: "bridge",
      async execute() {
        return { state: "completed", result: { ok: true } };
      },
    };
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([autoRecord]),
      [executor],
      {
        eventSink: createUnavailableEventSink(),
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "audit-unavailable-test",
        },
        newInvocationId: () => "audit-unavailable-invocation",
        newEventId: () => "audit-unavailable-event",
      },
    );

    await expect(
      dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      executorReached: true,
      error: {
        code: "audit_unavailable",
        detailCode: "event_sink:not_implemented",
      },
    });
  });

  it("mints UUIDv7 invocation and event identities by default", async () => {
    const eventSink = createCapturingEventSink();
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([autoRecord]),
      [
        {
          binding: "bridge",
          async execute(): Promise<GatewayExecutorOutcome> {
            return { state: "completed", result: { ok: true } };
          },
        },
      ],
      {
        eventSink,
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "uuid-v7-test",
        },
        clock: () => 1_750_000_000_000,
      },
    );

    const outcome = await dispatcher.dispatch(dispatchInput({ value: "ready" }));
    expect(outcome.requestId).toMatch(UUID_V7_PATTERN);
    expect(eventSink.captured()[0]?.event_id).toMatch(UUID_V7_PATTERN);
  });

  it("keeps route, executor, and audit identity on one pre-await snapshot", async () => {
    const routeStarted = deferred<void>();
    const releaseRoute = deferred<void>();
    const mutableActor = {
      type: "user" as const,
      tenantId: "tenant-a",
      userId: "user-a",
      role: "user" as const,
      oidcIssuer: "https://issuer.invalid/test",
      oidcSubject: "subject-a",
    };
    const mutableSession = {
      sessionId: "gateway-session-a",
      clientType: "mcp" as const,
      mcpSessionId: "mcp-session-test",
      oauthClientId: "codex-desktop-test",
    };
    const mutableAuth = {
      ...auth,
      actor: mutableActor,
      session: mutableSession,
      principalKey: "tenant-a:user-a",
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    const dispatchPromise = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready" },
        {
          auth: mutableAuth,
          resolveRoute: async (resolvedAuth) => {
            expect(Object.isFrozen(resolvedAuth)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.actor)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.session)).toBe(true);
            routeStarted.resolve();
            await releaseRoute.promise;
            return { ...route, tenantId: resolvedAuth.actor.tenantId };
          },
        },
      ),
    );
    await routeStarted.promise;
    mutableActor.tenantId = "tenant-mutated";
    mutableActor.userId = "user-mutated";
    mutableSession.sessionId = "gateway-session-mutated";
    mutableAuth.principalKey = "tenant-mutated:user-mutated";
    releaseRoute.resolve();

    await expect(dispatchPromise).resolves.toMatchObject({ ok: true });
    expect(harness.executorRequests()[0]?.context).toMatchObject({
      actor: { tenantId: "tenant-a", userId: "user-a" },
      gatewaySessionId: "gateway-session-a",
      principalKey: "tenant-a:user-a",
    });
    expect(harness.eventSink.captured()[0]).toMatchObject({
      actor: { type: "user", user_id: "user-a" },
      session_id: "gateway-session-a",
      tenant_id: "tenant-a",
      payload: {
        gateway_session_id: "gateway-session-a",
        principal_key: "tenant-a:user-a",
      },
    });
  });
});
