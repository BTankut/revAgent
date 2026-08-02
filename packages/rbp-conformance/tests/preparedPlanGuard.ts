import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertProductionControllerRuntimeCurrent,
  assertProductionExecutionPlanCurrent,
} from "../src/productionExecutionPlan.js";
import { sha256Text, stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";

/**
 * The gate a shard passes before it may run against a plan it did not prepare.
 *
 * scripts/run-tests.mjs performs one attested preparation per suite invocation
 * and hands its identity to all five shards. Without this guard that handoff
 * would be a fail-open channel: the plan file is gitignored and freely
 * writable, so a shard that merely re-derived provenance from disk would accept
 * any self-consistent set of {substituted dist, rewritten sidecars, rewritten
 * plan}. `assertProductionExecutionPlanCurrent` recomputes identities and
 * compares them against values it reads out of the plan file itself, so on its
 * own it cannot tell a forged-but-consistent set from a genuine one.
 *
 * The byte pin is what closes that. `planSha256` is computed by the runner
 * immediately after the attested wrapper exits zero and exists only in memory
 * and in the child's environment block -- never on disk -- so rewriting the
 * plan would require a SHA-256 preimage. Pinning the plan transitively pins the
 * per-component sidecar digests it records, which in turn pins the dist bytes
 * the recompute hashes.
 *
 * This module is kept out of globalSetup.ts so it stays inside `eslint src
 * tests` and can be unit-tested without importing the setup itself.
 */
export interface PreparedHandoff {
  readonly planPath: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly planSha256: string;
}

const PLAN_VARIABLE = "REVAGENT_RBP_PREPARED_PLAN";
const COMMIT_VARIABLE = "REVAGENT_RBP_PREPARED_COMMIT";
const TREE_VARIABLE = "REVAGENT_RBP_PREPARED_TREE";
const DIGEST_VARIABLE = "REVAGENT_RBP_PREPARED_PLAN_SHA256";

const HANDOFF_VARIABLES = [
  PLAN_VARIABLE,
  COMMIT_VARIABLE,
  TREE_VARIABLE,
  DIGEST_VARIABLE,
] as const;

/**
 * Reads the runner's handoff, or returns null when there is none.
 *
 * Every field is checked against a value the caller derived for itself, so the
 * environment can only narrow what is accepted and never widen it. A partial or
 * mismatched handoff throws rather than quietly degrading to "prepare your
 * own": silently preparing would hide a runner/shard disagreement behind a
 * slower but green build, which is the failure this whole change exists to
 * make visible.
 */
export function handoffFromEnvironment(
  environment: NodeJS.ProcessEnv,
  expectedPlanFile: string,
  identity: { readonly commit: string; readonly tree: string },
): PreparedHandoff | null {
  const present = HANDOFF_VARIABLES.filter(
    (name) => environment[name] !== undefined && environment[name] !== "",
  );
  if (present.length === 0) {
    return null;
  }
  if (present.length !== HANDOFF_VARIABLES.length) {
    const missing = HANDOFF_VARIABLES.filter((name) => !present.includes(name));
    throw new Error(
      `incomplete prepared-plan handoff: missing ${missing.join(", ")}`,
    );
  }

  const planPath = path.resolve(String(environment[PLAN_VARIABLE]));
  if (planPath !== path.resolve(expectedPlanFile)) {
    throw new Error(
      `prepared-plan handoff names ${planPath} but this suite's plan is ${expectedPlanFile}`,
    );
  }
  if (environment[COMMIT_VARIABLE] !== identity.commit) {
    throw new Error(
      `prepared-plan handoff is for commit ${String(environment[COMMIT_VARIABLE])} ` +
        `but HEAD is ${identity.commit}`,
    );
  }
  if (environment[TREE_VARIABLE] !== identity.tree) {
    throw new Error(
      `prepared-plan handoff is for tree ${String(environment[TREE_VARIABLE])} ` +
        `but HEAD is ${identity.tree}`,
    );
  }

  return {
    planPath,
    commitSha: identity.commit,
    treeSha: identity.tree,
    planSha256: String(environment[DIGEST_VARIABLE]),
  };
}

/**
 * Validates a plan a shard is about to run against, or throws.
 *
 * There is no branch here that runs tests with the plan unvalidated, and no
 * re-prepare fallback. A failure means the tree, the compiled dist or the host
 * toolchain moved after the attested preparation, and rebuilding would erase
 * exactly that evidence.
 */
export function validatePreparedPlan(
  planPath: string,
  expectedPlanSha256: string,
  identity: { readonly commit: string; readonly tree: string },
  repoRoot: string,
): void {
  let raw: string;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch (error) {
    throw new Error(`prepared plan is unreadable at ${planPath}`, { cause: error });
  }

  // The anchor. Everything below re-derives from bytes on disk; only this
  // compares those bytes against a value produced by the attested preparation
  // and never written down.
  const actualPlanSha256 = sha256Text(raw);
  if (actualPlanSha256 !== expectedPlanSha256) {
    throw new Error(
      "prepared plan bytes do not match the attested preparation " +
        `(expected ${expectedPlanSha256}, found ${actualPlanSha256})`,
    );
  }

  let plan: ExecutionPlan;
  try {
    plan = JSON.parse(raw) as ExecutionPlan;
  } catch (error) {
    throw new Error("prepared plan is not valid JSON", { cause: error });
  }

  // Redundant with the byte pin, kept for error legibility: a plan that fails
  // here has been hand-edited into non-canonical form and saying so is clearer
  // than a bare digest mismatch. If the pin above is ever removed this check
  // does NOT stand in for it -- it proves only that the bytes are canonical,
  // not that they are the right bytes.
  if (raw !== stableJson(plan)) {
    throw new Error("prepared plan is not in canonical serialized form");
  }

  // Redundant with the full recompute below, kept for the same reason.
  if (plan.source?.commitSha !== identity.commit || plan.source?.treeSha !== identity.tree) {
    throw new Error(
      `prepared plan is for ${String(plan.source?.commitSha)}/${String(plan.source?.treeSha)} ` +
        `but HEAD is ${identity.commit}/${identity.tree}`,
    );
  }

  // Matters only now that the plan is minted by a different process than the
  // one consuming it: this shard's Node and environment must be the ones the
  // plan was built for.
  assertProductionControllerRuntimeCurrent(plan);

  // The full re-verification: live worktree source identity, canonical
  // commands, build provenance recomputed from current bytes, and a re-read of
  // HEAD to catch movement during verification.
  assertProductionExecutionPlanCurrent(plan, repoRoot);
}

export const preparedPlanHandoffVariables = HANDOFF_VARIABLES;
