import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildConfirmationCommitProjection,
  buildConfirmationPreviewProjection,
  gatewayExternalToolInputJsonSchema,
  gatewayExternalToolInputSchema,
  splitGatewayConfirmationArguments,
} from "./confirmation.js";
import type { GatewayToolRecord } from "./registry.js";

function record(
  executorMethod: string,
  inputSchema: GatewayToolRecord["inputSchema"],
): GatewayToolRecord {
  const properties = Object.fromEntries(
    Object.keys(inputSchema).map((name) => [name, { type: "string" }]),
  );
  return {
    name: "core.confirm.test",
    summary: "Confirm one test write.",
    namespace: "core",
    version: "1.0.0",
    policyClass: "confirm",
    mutationScopePolicy: "session",
    executor: "bridge",
    executorMethod,
    inputSchema,
    inputJsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties,
      additionalProperties: false,
    },
  };
}

describe("Gateway confirmation client contract", () => {
  it("derives exact dry-run and commit projections for guarded write tools", () => {
    const tool = record("delete_review_view", {
      viewName: z.string(),
      mode: z.enum(["dryRun", "commit"]).optional(),
      confirmDelete: z.boolean().optional(),
    });
    const preview = buildConfirmationPreviewProjection(tool, {
      viewName: "revAgent_QA_1",
    });
    expect(preview).toMatchObject({
      ok: true,
      previewArgs: {
        viewName: "revAgent_QA_1",
        mode: "dryRun",
        confirmDelete: false,
      },
      commitArgs: {
        viewName: "revAgent_QA_1",
        mode: "commit",
        confirmDelete: true,
      },
    });
    if (!preview.ok) throw new Error("expected projection");
    expect(
      buildConfirmationCommitProjection(tool, preview.commitArgs),
    ).toMatchObject({
      ok: true,
      commitArgsDigest: preview.commitArgsDigest,
    });
  });

  it("rejects a direct commit and a confirmation call that is still dry-run", () => {
    const tool = record("set_element_parameter", {
      parameterName: z.string(),
      mode: z.enum(["dryRun", "commit"]).optional(),
    });
    expect(
      buildConfirmationPreviewProjection(tool, {
        parameterName: "Mark",
        mode: "commit",
      }),
    ).toEqual({
      ok: false,
      reason: "direct_commit_without_confirmation",
    });
    expect(
      buildConfirmationCommitProjection(tool, {
        parameterName: "Mark",
        mode: "dryRun",
      }),
    ).toEqual({
      ok: false,
      reason: "confirmation_commit_mode_required",
    });
  });

  it("maps raw code preview to the existing safe method without changing commit args", () => {
    const tool = record("send_code_to_revit", {
      code: z.string(),
      transactionMode: z.enum(["auto", "none"]).optional(),
      reportErrorResultAsFailure: z.boolean().optional(),
    });
    const projection = buildConfirmationPreviewProjection(tool, {
      code: "return 1;",
      transactionMode: "auto",
      reportErrorResultAsFailure: true,
    });
    expect(projection).toMatchObject({
      ok: true,
      previewExecutorMethod: "send_code_to_revit_safe",
      previewArgs: {
        code: "return 1;",
        intent: "writePreview",
        transactionMode: "none",
      },
      commitArgs: {
        code: "return 1;",
        transactionMode: "auto",
        reportErrorResultAsFailure: true,
      },
    });
    if (!projection.ok) throw new Error("expected raw-code projection");
    expect(projection.previewArgs).not.toHaveProperty(
      "reportErrorResultAsFailure",
    );
  });

  it("fails closed when a confirm-class method has no explicit preview strategy", () => {
    const tool = record("unclassified_write", { value: z.string() });
    expect(buildConfirmationPreviewProjection(tool, { value: "ready" })).toEqual(
      {
        ok: false,
        reason: "confirmation_preview_strategy_unavailable",
      },
    );
  });

  it("fails closed when raw-code parameters cannot cross the safe preview schema", () => {
    const tool = record("send_code_to_revit", {
      code: z.string(),
      parameters: z.array(z.unknown()).optional(),
    });
    expect(
      buildConfirmationPreviewProjection(tool, {
        code: "return parameters[0];",
        parameters: [{ write: true }],
      }),
    ).toEqual({
      ok: false,
      reason: "confirmation_preview_parameters_unsupported",
    });
  });

  it("advertises, validates, and strips paired Gateway control fields", () => {
    const inputSchema = { value: z.string() };
    const tool: GatewayToolRecord = {
      ...record("test_write", inputSchema),
      inputJsonSchema: z.toJSONSchema(z.object(inputSchema).strict(), {
        io: "input",
      }),
    };
    const parsed = gatewayExternalToolInputSchema(tool).parse({
      value: "ready",
      confirm_token: "token-a",
      originating_preview_invocation_id: "preview-a",
    });
    expect(splitGatewayConfirmationArguments(tool, parsed)).toEqual({
      args: { value: "ready" },
      confirmation: {
        confirmToken: "token-a",
        originatingPreviewInvocationId: "preview-a",
      },
    });
    expect(() =>
      gatewayExternalToolInputSchema(tool).parse({
        value: "ready",
        confirm_token: "token-a",
      }),
    ).toThrow();
    const externalJsonSchema = gatewayExternalToolInputJsonSchema(tool);
    expect(externalJsonSchema).toMatchObject({
      properties: {
        confirm_token: { type: "string" },
        originating_preview_invocation_id: { type: "string" },
      },
      dependentRequired: {
        confirm_token: ["originating_preview_invocation_id"],
        originating_preview_invocation_id: ["confirm_token"],
      },
    });
    expect(
      z.toJSONSchema(gatewayExternalToolInputSchema(tool), { io: "input" }),
    ).toEqual(externalJsonSchema);
  });
});
