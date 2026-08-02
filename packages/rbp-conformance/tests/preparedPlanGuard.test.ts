import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handoffFromEnvironment,
  validatePreparedPlan,
} from "./preparedPlanGuard.js";
import { sha256Text, stableJson } from "../src/stableJson.js";

const IDENTITY = { commit: "a".repeat(40), tree: "b".repeat(40) } as const;

let scratch: string;
let planPath: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "revagent-prepared-plan-guard-"));
  planPath = join(scratch, "current-production-plan.json");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writePlan(value: unknown): string {
  const raw = stableJson(value);
  writeFileSync(planPath, raw, "utf8");
  return sha256Text(raw);
}

function environmentFor(overrides: Record<string, string | undefined> = {}) {
  return {
    REVAGENT_RBP_PREPARED_PLAN: planPath,
    REVAGENT_RBP_PREPARED_COMMIT: IDENTITY.commit,
    REVAGENT_RBP_PREPARED_TREE: IDENTITY.tree,
    REVAGENT_RBP_PREPARED_PLAN_SHA256: "c".repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("prepared plan handoff", () => {
  it("returns null only when the runner issued no handoff at all", () => {
    // The standalone path: a developer running vitest directly must still get a
    // real preparation rather than an implicit reuse of whatever is on disk.
    expect(handoffFromEnvironment({}, planPath, IDENTITY)).toBeNull();
  });

  it("refuses a partial handoff instead of degrading to prepare", () => {
    // Silently preparing here would hide a runner/shard disagreement behind a
    // slower but green build -- the exact failure this change exists to expose.
    expect(() =>
      handoffFromEnvironment(
        environmentFor({ REVAGENT_RBP_PREPARED_PLAN_SHA256: undefined }),
        planPath,
        IDENTITY,
      ),
    ).toThrow(/incomplete prepared-plan handoff/);
  });

  it("refuses a handoff naming a different plan file", () => {
    expect(() =>
      handoffFromEnvironment(
        environmentFor({ REVAGENT_RBP_PREPARED_PLAN: join(scratch, "other.json") }),
        planPath,
        IDENTITY,
      ),
    ).toThrow(/but this suite's plan is/);
  });

  it("refuses a handoff for a different commit or tree", () => {
    expect(() =>
      handoffFromEnvironment(
        environmentFor({ REVAGENT_RBP_PREPARED_COMMIT: "d".repeat(40) }),
        planPath,
        IDENTITY,
      ),
    ).toThrow(/but HEAD is/);
    expect(() =>
      handoffFromEnvironment(
        environmentFor({ REVAGENT_RBP_PREPARED_TREE: "e".repeat(40) }),
        planPath,
        IDENTITY,
      ),
    ).toThrow(/but HEAD is/);
  });

  it("never widens what is accepted: every field is matched against a locally derived value", () => {
    const handoff = handoffFromEnvironment(environmentFor(), planPath, IDENTITY);
    expect(handoff?.commitSha).toBe(IDENTITY.commit);
    expect(handoff?.treeSha).toBe(IDENTITY.tree);
  });
});

describe("prepared plan validation", () => {
  it("refuses a plan whose bytes are not the ones the preparation produced", () => {
    // The load-bearing case. Deleting the byte-pin check from
    // validatePreparedPlan must turn this test red; if it stays green the pin
    // is not wired in and the rest of the guard is only recomputing values it
    // reads out of the same file it is checking.
    writePlan({ source: { commitSha: IDENTITY.commit, treeSha: IDENTITY.tree } });
    expect(() =>
      validatePreparedPlan(planPath, "f".repeat(64), IDENTITY, scratch),
    ).toThrow(/prepared plan bytes do not match the attested preparation/);
  });

  it("names both digests so a mismatch is diagnosable", () => {
    const actual = writePlan({ source: { commitSha: IDENTITY.commit, treeSha: IDENTITY.tree } });
    expect(() =>
      validatePreparedPlan(planPath, "f".repeat(64), IDENTITY, scratch),
    ).toThrow(new RegExp(`expected ${"f".repeat(64)}, found ${actual}`));
  });

  it("refuses a plan that is not canonically serialized", () => {
    const raw = '{"source":{"commitSha":"x"}}';
    writeFileSync(planPath, raw, "utf8");
    expect(() =>
      validatePreparedPlan(planPath, sha256Text(raw), IDENTITY, scratch),
    ).toThrow(/not in canonical serialized form/);
  });

  it("refuses a canonical plan recorded for a different source", () => {
    const digest = writePlan({
      source: { commitSha: "9".repeat(40), treeSha: "8".repeat(40) },
    });
    expect(() => validatePreparedPlan(planPath, digest, IDENTITY, scratch)).toThrow(
      /but HEAD is/,
    );
  });

  it("refuses an unreadable plan rather than treating absence as success", () => {
    expect(() =>
      validatePreparedPlan(join(scratch, "absent.json"), "0".repeat(64), IDENTITY, scratch),
    ).toThrow(/prepared plan is unreadable/);
  });
});
