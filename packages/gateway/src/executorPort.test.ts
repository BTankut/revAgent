import { describe, expect, it } from "vitest";
import {
  ExecutorPortUnavailableError,
  unboundExecutorPort,
  type ExecutorPort,
  type ExecutorRequest,
} from "./executorPort.js";

const CONTEXT = { toolName: "core.element.query", requestId: "req-1" } as const;

describe("executor port", () => {
  it("fails closed and states that nothing was dispatched when unbound", async () => {
    // A handler reached without a bound executor must never be confusable with
    // one whose call was delivered and lost; that distinction is what the RBP
    // journal replays on.
    const outcome = await unboundExecutorPort.invoke(
      { kind: "send_command", command: "get_ui_state", params: {} },
      CONTEXT,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error("unreachable");
    }
    expect(outcome.dispatched).toBe(false);
    expect(outcome.faultClass).toBe("executor_unavailable");
    expect(outcome.message).toContain("core.element.query");
    expect(outcome.message).toContain("nothing was sent");
  });

  it("names the tool in its unavailable error", () => {
    expect(new ExecutorPortUnavailableError("core.code.execute").message).toContain(
      "core.code.execute",
    );
  });

  it("carries the transaction mode a packaged code call needs", async () => {
    const seen: ExecutorRequest[] = [];
    const port: ExecutorPort = {
      async invoke(request) {
        seen.push(request);
        return { status: "completed", result: { ok: true } };
      },
    };

    await port.invoke(
      {
        kind: "execute_code",
        code: "return 1;",
        parameters: [],
        transactionMode: "none",
        parseJsonResult: true,
      },
      CONTEXT,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "execute_code",
      transactionMode: "none",
    });
  });

  it("exposes no caller-supplied Revit target", () => {
    // The session is resolved from the rsid binding before a handler runs.
    // Honouring target/host/port here would let a tool address a Revit session
    // its invocation was never authorised for.
    const request: ExecutorRequest = {
      kind: "send_command",
      command: "get_ui_state",
      params: {},
    };
    expect(Object.keys(request)).not.toContain("target");
    expect(Object.keys(request)).not.toContain("host");
    expect(Object.keys(request)).not.toContain("port");
  });
});
