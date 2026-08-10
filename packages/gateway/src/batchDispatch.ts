import { makeParamsDigest, type JsonValue } from "@revagent/protocol";
import { z } from "zod";

import type {
  GatewayAtomicBatchExecutorRequest,
  GatewayExecutorRequest,
} from "./dispatch.js";
import { isGatewayUuidV7 } from "./identifiers.js";
import type { GatewayToolRegistry } from "./registry.js";

export const GATEWAY_ATOMIC_BATCH_MAX_STEPS = 64 as const;

export type GatewayAtomicBatchAuthorizationErrorCode =
  | "invalid_batch_id"
  | "invalid_step_count"
  | "duplicate_invocation_id"
  | "registry_mismatch"
  | "invalid_arguments"
  | "executor_not_batchable"
  | "policy_not_batchable"
  | "context_mismatch"
  | "params_digest_mismatch"
  | "batch_has_no_mutation";

export class GatewayAtomicBatchAuthorizationError extends Error {
  public constructor(
    public readonly code: GatewayAtomicBatchAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayAtomicBatchAuthorizationError";
  }
}

function fail(
  code: GatewayAtomicBatchAuthorizationErrorCode,
  message: string,
): never {
  throw new GatewayAtomicBatchAuthorizationError(code, message);
}

function sameDocument(
  left: GatewayExecutorRequest["context"]["documentIdentity"],
  right: GatewayExecutorRequest["context"]["documentIdentity"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Converts authoritative per-tool dispatch requests into the only batch value
 * accepted by the Bridge executor. This is deliberately fail-closed: every
 * step must still be an exact registry row, Bridge-bound, already policy
 * authorized, and bound to one actor/session/rsid/document.
 *
 * `confirm` steps are accepted only after their ordinary preview/token path has
 * produced a `confirmed` context. `gated` steps are never batchable because the
 * out-of-band decision cannot be inferred by this primitive.
 */
export function authorizeGatewayAtomicBatch(input: {
  readonly registry: GatewayToolRegistry;
  readonly batchId: string;
  readonly steps: readonly GatewayExecutorRequest[];
}): GatewayAtomicBatchExecutorRequest {
  if (!isGatewayUuidV7(input.batchId)) {
    fail("invalid_batch_id", "atomic batch id must be UUIDv7");
  }
  if (
    input.steps.length < 1 ||
    input.steps.length > GATEWAY_ATOMIC_BATCH_MAX_STEPS
  ) {
    fail(
      "invalid_step_count",
      `atomic batch requires 1-${GATEWAY_ATOMIC_BATCH_MAX_STEPS} steps`,
    );
  }

  const first = input.steps[0]!;
  const invocationIds = new Set<string>();
  let mutationCount = 0;
  const steps = input.steps.map((request, index) => {
    if (invocationIds.has(request.context.invocationId)) {
      fail(
        "duplicate_invocation_id",
        `batch step ${index} repeats an invocation id`,
      );
    }
    invocationIds.add(request.context.invocationId);

    const record = input.registry.get(request.toolName);
    if (
      record === undefined ||
      record.version !== request.toolVersion ||
      record.executorMethod !== request.executorMethod ||
      record.executor !== request.context.executor ||
      record.policyClass !== request.policyClass ||
      record.mutationScopePolicy !== request.mutationScopePolicy ||
      request.context.toolName !== request.toolName ||
      request.context.toolVersion !== request.toolVersion ||
      request.context.policyClass !== request.policyClass ||
      request.context.mutationScopePolicy !== request.mutationScopePolicy
    ) {
      fail("registry_mismatch", `batch step ${index} is not an exact registry row`);
    }
    const parsed = z.object(record.inputSchema).strict().safeParse(request.args);
    if (!parsed.success) {
      fail(
        "invalid_arguments",
        `batch step ${index} arguments do not match the registry schema`,
      );
    }
    if (record.executor !== "bridge") {
      fail(
        "executor_not_batchable",
        `batch step ${index} is not Bridge-bound`,
      );
    }
    if (
      record.policyClass === "gated" ||
      (record.policyClass === "confirm" &&
        (request.context.policyDecision !== "confirmed" ||
          request.context.confirmationId === null)) ||
      (record.policyClass === "auto" &&
        (request.context.policyDecision !== "auto" ||
          request.context.confirmationId !== null))
    ) {
      fail(
        "policy_not_batchable",
        `batch step ${index} lacks an exact server-authored policy decision`,
      );
    }
    if (
      request.context.actor.tenantId !== first.context.actor.tenantId ||
      request.context.actor.userId !== first.context.actor.userId ||
      request.context.actor.role !== first.context.actor.role ||
      request.context.principalKey !== first.context.principalKey ||
      request.context.gatewaySessionId !== first.context.gatewaySessionId ||
      request.context.oauthClientId !== first.context.oauthClientId ||
      request.context.mcpSessionId !== first.context.mcpSessionId ||
      request.context.rsid !== first.context.rsid ||
      !sameDocument(
        request.context.documentIdentity,
        first.context.documentIdentity,
      )
    ) {
      fail(
        "context_mismatch",
        `batch step ${index} crosses an actor/session/rsid/document boundary`,
      );
    }
    const expectedMutating = record.mutationScopePolicy !== "none";
    const expectedScope =
      record.mutationScopePolicy === "none"
        ? request.context.mutationScope === null
        : record.mutationScopePolicy === "session"
          ? request.context.mutationScope?.kind === "session"
          : request.context.mutationScope?.kind === "document";
    if (request.context.mutating !== expectedMutating || !expectedScope) {
      fail(
        "context_mismatch",
        `batch step ${index} mutation effect disagrees with the registry`,
      );
    }
    let paramsDigest: string;
    try {
      paramsDigest = makeParamsDigest(parsed.data as JsonValue);
    } catch {
      fail(
        "params_digest_mismatch",
        `batch step ${index} arguments cannot be canonically digested`,
      );
    }
    if (paramsDigest !== request.context.paramsDigest) {
      fail(
        "params_digest_mismatch",
        `batch step ${index} params do not match its authoritative digest`,
      );
    }
    if (request.context.mutating) mutationCount += 1;
    return Object.freeze({
      ...request,
      args: Object.freeze(structuredClone(request.args)),
      context: Object.freeze(structuredClone(request.context)),
    });
  });

  if (mutationCount === 0) {
    fail("batch_has_no_mutation", "atomic batch must contain a mutation");
  }
  return Object.freeze({
    batchId: input.batchId,
    atomic: true as const,
    steps: Object.freeze(steps),
  });
}
