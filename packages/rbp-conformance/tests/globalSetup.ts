import { writeFileSync } from "node:fs";

// Test support may construct the canonical host arguments from the exact
// checked-out commit. Production evidence still requires an independently
// reviewed authority vector retained outside the checkout.
// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import {
  planFile,
  prepareCurrentProductionPlan,
  repoRoot,
  repositoryIdentity,
} from "../scripts/prepare-current-production.mjs";

import { handoffFromEnvironment, validatePreparedPlan } from "./preparedPlanGuard.js";

const REUSE_PROOF_VARIABLE = "REVAGENT_RBP_REUSE_PROOF_PATH";

/**
 * Records what this shard actually did, so the runner can tell reuse from a
 * silent fallback.
 *
 * A guard that is wrongly always-false costs nothing visible -- the suite just
 * stays at its old duration and nobody learns the reuse never happened. The
 * runner requires all five shards to report `reused` whenever it issued a
 * handoff, which turns that silence into a red build. `wx` matches
 * scripts/cardinality-reporter.mjs and makes a duplicate write an error rather
 * than an overwrite.
 */
function recordReuseProof(mode: "reused" | "prepared"): void {
  const target = process.env[REUSE_PROOF_VARIABLE];
  if (target === undefined || target === "") {
    return;
  }
  writeFileSync(target, `${JSON.stringify({ mode })}\n`, { encoding: "utf8", flag: "wx" });
}

/**
 * Prepares once per suite invocation, or validates the preparation the runner
 * already performed.
 *
 * scripts/run-tests.mjs runs five shards sequentially and each boots its own
 * vitest, so this file used to run the ~173 s attested preparation five times --
 * about 14 of the suite's 42-46 minutes. The runner now prepares once and hands
 * the identity down; this validates it rather than trusting it.
 *
 * The standalone path is preserved deliberately: a developer running
 * `npx vitest run <file>` has no runner and must still get a real preparation,
 * and it is checked by the same guard so the two paths cannot diverge.
 */
export default function setup(): void {
  const identity = repositoryIdentity();
  const handoff = handoffFromEnvironment(process.env, planFile, identity);

  if (handoff !== null) {
    const startedAt = Date.now();
    // Any throw here fails the shard. There is no re-prepare fallback: the
    // attested preparation for this invocation already happened, so a failure
    // means the tree, dist or toolchain moved since, and rebuilding would
    // destroy exactly that evidence.
    validatePreparedPlan(handoff.planPath, handoff.planSha256, identity, repoRoot);
    console.log(
      `[globalSetup] reused attested production plan (validated in ${String(Date.now() - startedAt)}ms)`,
    );
    recordReuseProof("reused");
  } else {
    const prepared = prepareCurrentProductionPlan({ nodeExecutable: process.execPath });
    console.log(
      `[globalSetup] canonical production preparation took ${String(prepared.elapsedMs)}ms`,
    );
    // Validated against its own digest so the standalone path exercises the
    // same gate the shards do; a guard that only ever runs in CI is a guard
    // nobody debugs.
    validatePreparedPlan(prepared.planFile, prepared.planSha256, identity, repoRoot);
    recordReuseProof("prepared");
  }

  process.env.RBP_TEST_PRODUCTION_PLAN = planFile;
  process.env.RBP_TEST_REPO_ROOT = repoRoot;
}
