import { describe, expect, it } from "vitest";

import {
  createProductionCaseComposition,
  PRODUCTION_CASE_COMPOSITION,
} from "../src/productionCaseComposition.js";
import { canonicalManifest } from "../src/manifest.js";
import { CORE_PRODUCTION_ORACLES } from "../src/productionCaseOraclesCore.js";
import { EARLY_PRODUCTION_ORACLES } from "../src/productionCaseOraclesEarly.js";
import { MIDDLE_PRODUCTION_ORACLES } from "../src/productionCaseOraclesMiddle.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeProductionCaseBothBindings } from "../src/productionCaseRunner.js";
import { executeEarlyProductionCaseBothBindings } from "../src/productionCaseRunnerEarly.js";
import { executeMiddleProductionCaseBothBindings } from "../src/productionCaseRunnerMiddle.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import { SUPPORTED_PRODUCTION_CASES } from "../src/productionCaseSeeds.js";
import { EARLY_PRODUCTION_CASES } from "../src/productionCaseSeedsEarly.js";
import { MIDDLE_PRODUCTION_CASES } from "../src/productionCaseSeedsMiddle.js";
import { RAW_PRODUCTION_CASES } from "../src/productionCaseSeedsRaw.js";
import { createPlan } from "./helpers.js";

const core = {
  name: "core",
  caseIds: SUPPORTED_PRODUCTION_CASES,
  oracles: CORE_PRODUCTION_ORACLES,
  executeCase: executeProductionCaseBothBindings,
} as const;
const early = {
  name: "early",
  caseIds: EARLY_PRODUCTION_CASES,
  oracles: EARLY_PRODUCTION_ORACLES,
  executeCase: executeEarlyProductionCaseBothBindings,
} as const;
const raw = {
  name: "raw",
  caseIds: RAW_PRODUCTION_CASES,
  oracles: RAW_PRODUCTION_ORACLES,
  executeCase: executeRawProductionCaseBothBindings,
} as const;
const middle = {
  name: "middle",
  caseIds: MIDDLE_PRODUCTION_CASES,
  oracles: MIDDLE_PRODUCTION_ORACLES,
  executeCase: executeMiddleProductionCaseBothBindings,
} as const;

describe("production case composition guards", () => {
  it("binds every canonical case once and composes exactly 167 real oracles", () => {
    expect([...PRODUCTION_CASE_COMPOSITION.caseOwners.keys()]).toEqual(
      canonicalManifest.cases.map(({ id }) => id),
    );
    expect(PRODUCTION_CASE_COMPOSITION.caseOwners.size).toBe(40);
    expect(PRODUCTION_CASE_COMPOSITION.oracles.size).toBe(167);
    expect([...PRODUCTION_CASE_COMPOSITION.caseOwners.values()]).toEqual([
      "core",
      ...Array.from({ length: 3 }, () => "early"),
      "core",
      ...Array.from({ length: 9 }, () => "early"),
      ...Array.from({ length: 10 }, () => "middle"),
      ...Array.from({ length: 16 }, () => "raw"),
    ]);
  });

  it("does not expose mutable production oracle, owner, or executor bindings", () => {
    expect(Object.isFrozen(PRODUCTION_CASE_COMPOSITION)).toBe(true);
    for (const registry of [
      CORE_PRODUCTION_ORACLES,
      EARLY_PRODUCTION_ORACLES,
      MIDDLE_PRODUCTION_ORACLES,
      RAW_PRODUCTION_ORACLES,
      PRODUCTION_CASE_COMPOSITION.oracles,
      PRODUCTION_CASE_COMPOSITION.caseOwners,
    ]) {
      expect((registry as unknown as { set?: unknown }).set).toBeUndefined();
      expect((registry as unknown as { clear?: unknown }).clear).toBeUndefined();
    }
    expect(() => {
      (
        PRODUCTION_CASE_COMPOSITION as unknown as {
          executeCase: () => Promise<never[]>;
        }
      ).executeCase = async () => [];
    }).toThrow(TypeError);
  });

  it("rejects the otherwise real composition while C15-C24 has no owner", () => {
    expect(() => createProductionCaseComposition([core, early, raw])).toThrow(
      /missing: O1-C15, O1-C16, O1-C17, O1-C18, O1-C19, O1-C20, O1-C21, O1-C22, O1-C23, O1-C24/u,
    );
  });

  it("rejects duplicate case ownership before a dispatcher can overwrite it", () => {
    expect(() => createProductionCaseComposition([core, core, early, raw])).toThrow(
      /owned by both core and core/u,
    );
  });

  it("rejects an oracle registry that crosses its declared case boundary", () => {
    expect(() => createProductionCaseComposition([
      {
        ...early,
        oracles: CORE_PRODUCTION_ORACLES,
      },
      core,
      raw,
    ])).toThrow(/slice early has an invalid oracle boundary/u);
  });

  it("rejects an unknown case before any slice executor can start a process", async () => {
    await expect(PRODUCTION_CASE_COMPOSITION.executeCase({
      plan: createPlan(),
      repoRoot: "C:/not-used",
      caseId: "O1-C41",
    })).rejects.toThrow(/dispatcher has no owner for O1-C41/u);
  });

  it("rejects a slice result whose two bindings are not in canonical order", async () => {
    const invalid = createProductionCaseComposition([
      {
        ...core,
        executeCase: async () => [
          {
            binding: "streamable_http_sse",
            durationMs: 0,
            evidence: {
              observations: [],
              captures: {},
              completedStepIds: [],
              stepObservations: [],
            },
          },
          {
            binding: "wss",
            durationMs: 0,
            evidence: {
              observations: [],
              captures: {},
              completedStepIds: [],
              stepObservations: [],
            },
          },
        ],
      },
      early,
      middle,
      raw,
    ]);
    await expect(invalid.executeCase({
      plan: createPlan(),
      repoRoot: "C:/not-used",
      caseId: "O1-C01",
    })).rejects.toThrow(/returned bindings streamable_http_sse, wss/u);
  });
});
