import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REAL_TRIO_PROCESS_COMPONENT_IDS,
} from "../src/realTrioProcessHarness.js";
import { runRealTrioCli } from "../src/realTrioCli.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("WP-12 real process harness isolation", () => {
  it("owns the exact real carrier identifiers", () => {
    expect(REAL_TRIO_PROCESS_COMPONENT_IDS).toEqual([
      "gateway_production_conformance",
      "bridge_worker",
      "addin_loopback_fixture",
    ]);
  });

  it("does not route the real harness through historical planning or surrogate helpers", () => {
    const target = readFileSync(path.join(sourceRoot, "realTrioProcessHarness.ts"), "utf8");
    const supervisor = readFileSync(path.join(sourceRoot, "realTrioSupervisor.ts"), "utf8");
    for (const forbidden of [
      "CaseStack" + "Supervisor",
      "production" + "Preparation",
      "production" + "ExecutionPlan",
      "Gateway" + "StubProcess",
      "bridge-" + "simulator",
      "import type { Component" + "Id",
    ]) {
      expect(target).not.toContain(forbidden);
      expect(supervisor).not.toContain(forbidden);
    }
  });

  it("requires the explicit real-trio entrypoint and preserves its binding", async () => {
    await expect(runRealTrioCli(["real-trio", "wss"], async (binding) => binding))
      .resolves.toEqual({ binding: "wss", result: "wss" });
    await expect(runRealTrioCli(["run-production", "wss"], async () => "unexpected"))
      .rejects.toThrow(/Usage: real-trio/u);
  });
});
