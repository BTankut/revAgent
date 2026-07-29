import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  GatewayDispatcher,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
} from "./dispatch.js";
import {
  GatewayToolRegistry,
  type GatewayToolRecord,
} from "./registry.js";

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

function dispatchInput(args: unknown) {
  return {
    toolName: autoRecord.name,
    args,
    principalKey: "tenant-a:user-a",
    oauthClientId: "codex-desktop-test",
    mcpSessionId: "mcp-session-test",
  } as const;
}

function createDispatcher(input: {
  readonly record?: GatewayToolRecord;
  readonly execute: () => Promise<GatewayExecutorOutcome>;
}): {
  readonly dispatcher: GatewayDispatcher;
  readonly executionCount: () => number;
} {
  let executions = 0;
  const executor: GatewayExecutor = {
    binding: "bridge",
    async execute() {
      executions += 1;
      return input.execute();
    },
  };
  return {
    dispatcher: new GatewayDispatcher(
      new GatewayToolRegistry([input.record ?? autoRecord]),
      [executor],
    ),
    executionCount: () => executions,
  };
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
});
