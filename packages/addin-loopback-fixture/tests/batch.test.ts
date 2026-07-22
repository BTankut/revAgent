import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  AddinLoopbackFixture,
  MAX_RESPONSE_PAYLOAD_BYTES,
  connectFixture,
  type FixtureAddress,
  type JsonObject,
} from "../src/index.js";
import { DIGEST, request, uuid7, writeAndRead } from "./helpers.js";

interface StepInput {
  method: string;
  params?: JsonObject;
  effect?: "read_only" | "model_transaction";
}

function batchRequest(
  batchSuffix: number,
  inputs: readonly StepInput[],
  maxAggregateResultBytes = MAX_RESPONSE_PAYLOAD_BYTES,
): JsonObject {
  const batchId = uuid7(batchSuffix);
  return request(batchId, "execute_batch", {
    batchContractVersion: 1,
    batchId,
    batchDigest: DIGEST,
    atomic: true,
    rollbackPolicy: "rollback_on_non_success",
    maxAggregateResultBytes,
    steps: inputs.map((input, index) => ({
      index,
      invocationId: uuid7(batchSuffix * 100 + index + 1),
      method: input.method,
      params: input.params ?? {},
      paramsDigest: DIGEST,
      effect: input.effect ?? "read_only",
    })),
  });
}

function result(response: JsonObject): JsonObject {
  return response.result as JsonObject;
}

function steps(response: JsonObject): JsonObject[] {
  return result(response).steps as JsonObject[];
}

describe("atomic execute_batch fixture", () => {
  const fixtures: AddinLoopbackFixture[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    for (const fixture of fixtures) await fixture.stop();
  });

  async function setup(): Promise<{
    fixture: AddinLoopbackFixture;
    address: FixtureAddress;
    socket: Socket;
  }> {
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    const address = await fixture.start();
    const socket = await connectFixture(address);
    sockets.push(socket);
    return { fixture, address, socket };
  }

  it("assimilates every staged mutation only after all steps succeed", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("delete_review_view", "model_transaction", (params, context) => {
      context.transactionGroup?.stage("view:42", { deleted: true, params });
      return { state: "completed", result: { success: true, deletedViewId: 42 } };
    });
    const value = batchRequest(100, [
      { method: "get_ui_state" },
      {
        method: "delete_review_view",
        effect: "model_transaction",
        params: { viewId: 42, mode: "commit", confirmDelete: true },
      },
    ]);
    const response = await writeAndRead(socket, value);
    const batchId = String(value.id);
    const requestSteps = ((value.params as JsonObject).steps ?? []) as JsonObject[];

    expect(result(response)).toMatchObject({
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      rollback: { attempted: false, succeeded: null },
    });
    expect(steps(response).map((entry) => entry.effectState)).toEqual(["read_only", "committed"]);
    expect(fixture.modelState.get("view:42")).toMatchObject({ deleted: true });
    expect(fixture.getExecutionCount(batchId)).toBe(1);
    for (const step of requestSteps) {
      expect(fixture.getExecutionCount(String(step.invocationId))).toBe(1);
    }
  });

  it("rolls the whole group back on a guarded nested result and suppresses prior data", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:protected", { deleted: true });
      return {
        success: true,
        result: { success: false, guarded: true, reason: "protected view" },
      };
    });
    const value = batchRequest(101, [
      { method: "get_ui_state" },
      {
        method: "delete_review_view",
        effect: "model_transaction",
        params: { viewId: 43, mode: "commit", confirmDelete: true },
      },
      { method: "inspect_levels" },
    ]);
    const response = await writeAndRead(socket, value);
    const outcomes = steps(response);

    expect(result(response)).toMatchObject({
      status: "guarded",
      transactionState: "rolled_back",
      failedStepIndex: 1,
      rollback: {
        attempted: true,
        succeeded: true,
        triggerStepIndex: 1,
        triggerState: "guarded",
      },
    });
    expect(outcomes[0]).toMatchObject({
      executionState: "completed",
      effectState: "discarded",
      resultSuppressed: "batch_rolled_back",
    });
    expect(outcomes[0]).not.toHaveProperty("result");
    expect(outcomes[1]).toMatchObject({
      executionState: "guarded",
      effectState: "rolled_back",
      guardedReason: "protected_view",
      resultSuppressed: "batch_rolled_back",
    });
    expect(outcomes[2]).toMatchObject({
      executionState: "not_started",
      effectState: "not_started",
    });
    expect(fixture.modelState.has("view:protected")).toBe(false);
  });

  it("recognizes a full nested failure and stops every successor", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      success: true,
      result: { data: { success: false, error: { message: "nested failure" } } },
    }));
    const response = await writeAndRead(
      socket,
      batchRequest(102, [
        { method: "get_ui_state" },
        { method: "inspect_levels" },
      ]),
    );

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 0,
    });
    expect(steps(response)[0]).toMatchObject({
      executionState: "failed",
      error: { code: "command_failure", message: "nested failure" },
    });
    expect(steps(response)[1]).toMatchObject({ executionState: "not_started" });
  });

  it("normalizes numeric-leading guarded reasons inside the batch contract", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "guarded",
      guardedReason: "123 protected view",
    }));
    const response = await writeAndRead(
      socket,
      batchRequest(108, [{ method: "get_ui_state" }]),
    );
    const outcome = steps(response)[0] as JsonObject;

    expect(result(response)).toMatchObject({
      status: "guarded",
      transactionState: "rolled_back",
    });
    expect(outcome.guardedReason).toBe("guarded_123_protected_view");
    expect(String(outcome.guardedReason)).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
  });

  it("rolls back staged mutation when a handler returns undefined invalid_result", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler(
      "delete_review_view",
      "model_transaction",
      ((_params: JsonObject, context: { transactionGroup: { stage: (key: string, value: JsonObject) => void } | null }) => {
        context.transactionGroup?.stage("view:malformed", { deleted: true });
        return undefined;
      }) as never,
    );
    const response = await writeAndRead(
      socket,
      batchRequest(109, [
        {
          method: "delete_review_view",
          effect: "model_transaction",
          params: { viewId: 46, mode: "commit", confirmDelete: true },
        },
      ]),
    );

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 0,
    });
    expect(steps(response)[0]).toMatchObject({
      executionState: "failed",
      effectState: "rolled_back",
      error: { code: "invalid_result" },
      resultSuppressed: "batch_rolled_back",
    });
    expect(fixture.modelState.has("view:malformed")).toBe(false);
  });

  it("validates the final batch envelope before assimilation", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:final-envelope", { deleted: true });
      return { state: "completed", result: { success: true } };
    });
    const value = batchRequest(110, [
      {
        method: "delete_review_view",
        effect: "model_transaction",
        params: { viewId: 47, mode: "commit", confirmDelete: true },
      },
    ]);
    fixture.planFault(String(value.id), { finalBatchResponseFault: "omit_batch_digest" });
    const response = await writeAndRead(socket, value);

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 0,
    });
    expect(steps(response)[0]).toMatchObject({
      executionState: "failed",
      effectState: "rolled_back",
      error: { code: "invalid_result" },
    });
    expect(fixture.modelState.has("view:final-envelope")).toBe(false);
  });

  it("fails indeterminate when the test TransactionGroup rollback fails", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:uncertain", { deleted: true });
      return { state: "guarded", guardedReason: "protected_view" };
    });
    const value = batchRequest(103, [
      {
        method: "delete_review_view",
        effect: "model_transaction",
        params: { viewId: 44, mode: "commit", confirmDelete: true },
      },
    ]);
    fixture.planFault(String(value.id), { rollbackFailure: true });
    const response = await writeAndRead(socket, value);

    expect(result(response)).toMatchObject({
      status: "indeterminate",
      transactionState: "indeterminate",
      failedStepIndex: 0,
      rollback: {
        attempted: true,
        succeeded: false,
        triggerState: "guarded",
        error: { code: "rollback_failure" },
      },
    });
    expect(steps(response)[0]).toMatchObject({
      executionState: "guarded",
      effectState: "indeterminate",
      resultSuppressed: "batch_indeterminate",
    });
    expect(fixture.modelState.has("view:uncertain")).toBe(false);
  });

  it("rejects an oversized inline step result before assimilation", async () => {
    const { fixture, socket } = await setup();
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:overflow", { deleted: true });
      return { state: "completed", result: { success: true } };
    });
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "completed",
      result: { payload: "ğ".repeat(MAX_RESPONSE_PAYLOAD_BYTES / 2) },
    }));
    const response = await writeAndRead(
      socket,
      batchRequest(104, [
        {
          method: "delete_review_view",
          effect: "model_transaction",
          params: { viewId: 45, mode: "commit", confirmDelete: true },
        },
        { method: "get_ui_state" },
      ]),
    );
    const outcomes = steps(response);
    const limitError = outcomes[1]?.error as JsonObject;

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 1,
    });
    expect(outcomes[0]).toMatchObject({
      executionState: "completed",
      effectState: "rolled_back",
      resultSuppressed: "batch_rolled_back",
    });
    expect(outcomes[1]).toMatchObject({
      executionState: "failed",
      effectState: "discarded",
      resultSuppressed: "batch_rolled_back",
    });
    expect(limitError).toMatchObject({
      code: "invalid_result",
    });
    expect(fixture.modelState.has("view:overflow")).toBe(false);
  });

  it("uses the negotiated aggregate result cap for tentative batch assimilation", async () => {
    const { fixture, socket } = await setup();
    const negotiatedCap = 10 * 1024 * 1024;
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "completed",
      result: { payload: "x".repeat(6 * 1024 * 1024) },
    }));
    fixture.registerHandler("get_current_view_info", "read_only", () => ({
      state: "completed",
      result: { payload: "y".repeat(6 * 1024 * 1024) },
    }));
    const response = await writeAndRead(
      socket,
      batchRequest(114, [
        { method: "get_ui_state" },
        { method: "get_current_view_info" },
      ], negotiatedCap),
    );
    const error = steps(response)[1]?.error as JsonObject;

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 1,
    });
    expect(error).toMatchObject({
      code: "response_payload_limit",
      maxResponsePayloadBytes: negotiatedCap,
    });
    expect(Number(error.tentativeResponsePayloadBytes)).toBeGreaterThan(negotiatedCap);
  });

  it("rejects artifact-shaped nested results and rolls back prior mutations without echoing paths", async () => {
    const { fixture, socket } = await setup();
    const secretPath = "C:\\sensitive\\model-export.xlsx";
    fixture.registerHandler("delete_review_view", "model_transaction", (_params, context) => {
      context.transactionGroup?.stage("view:artifact", { deleted: true });
      return { state: "completed", result: { success: true } };
    });
    fixture.registerHandler("get_ui_state", "read_only", () => ({
      state: "completed",
      result: { files: [{ path: secretPath, contentType: "application/octet-stream" }] },
    }));
    const response = await writeAndRead(socket, batchRequest(115, [
      {
        method: "delete_review_view",
        effect: "model_transaction",
        params: { viewId: 46, mode: "commit", confirmDelete: true },
      },
      { method: "get_ui_state" },
    ]));

    expect(result(response)).toMatchObject({
      status: "failed",
      transactionState: "rolled_back",
      failedStepIndex: 1,
    });
    expect(steps(response)[1]).toMatchObject({
      executionState: "failed",
      effectState: "discarded",
      error: { code: "invalid_result" },
    });
    expect(JSON.stringify(response)).not.toContain(secretPath);
    expect(fixture.modelState.has("view:artifact")).toBe(false);
  });

  it("rejects raw dynamic send_code before opening the group or executing a step", async () => {
    const { fixture, socket } = await setup();
    const value = batchRequest(105, [
      {
        method: "send_code_to_revit",
        effect: "model_transaction",
        params: { code: "return 1;" },
      },
    ]);
    const response = await writeAndRead(socket, value);
    const error = response.error as JsonObject;
    const requestSteps = ((value.params as JsonObject).steps ?? []) as JsonObject[];

    expect(error.code).toBe(-32602);
    expect(fixture.getExecutionCount(String(value.id))).toBe(0);
    expect(fixture.getExecutionCount(String(requestSteps[0]?.invocationId))).toBe(0);
    expect(fixture.modelState.size).toBe(0);
  });

  it("rejects descriptor mismatch and non-contiguous indices before dispatch", async () => {
    const { fixture, socket } = await setup();
    const effectMismatch = batchRequest(106, [
      { method: "get_ui_state", effect: "model_transaction" },
    ]);
    const mismatchResponse = await writeAndRead(socket, effectMismatch);
    expect((mismatchResponse.error as JsonObject).code).toBe(-32602);

    const nonContiguous = batchRequest(107, [{ method: "get_ui_state" }]);
    const params = nonContiguous.params as JsonObject;
    const requestSteps = params.steps as JsonObject[];
    (requestSteps[0] as JsonObject).index = 1;
    const indexResponse = await writeAndRead(socket, nonContiguous);
    expect((indexResponse.error as JsonObject).code).toBe(-32602);

    expect(fixture.getMethodExecutionCount("execute_batch")).toBe(0);
  });
});
