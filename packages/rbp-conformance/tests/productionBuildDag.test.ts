import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  productionHarnessRuntimeArtifacts,
} from "../src/productionBuildProvenance.js";
import {
  executeCanonicalProductionBuildDag,
  PRODUCTION_BUILD_STEPS,
} from "../src/productionPreparation.js";

function outputFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-build-dag-"));
  for (const { outputRoot, workspace } of PRODUCTION_BUILD_STEPS) {
    const target = path.join(root, outputRoot, "index.js");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `export const workspace = ${JSON.stringify(workspace)};\n`);
  }
  const harness = path.join(
    root,
    "packages/rbp-conformance/dist/src/cli.js",
  );
  mkdirSync(path.dirname(harness), { recursive: true });
  writeFileSync(harness, "console.log('controller');\n", "utf8");
  return root;
}

describe("canonical direct production build DAG", () => {
  it("rechecks gateway output after a later bridge build step", () => {
    const root = outputFixture();
    try {
      const bootstrapHarness = productionHarnessRuntimeArtifacts(root);
      expect(() =>
        executeCanonicalProductionBuildDag({
          repoRoot: root,
          bootstrapHarness,
          executeStep: (workspace) => {
            if (workspace === "@revagent/bridge-simulator") {
              appendFileSync(
                path.join(root, "packages/gateway-stub/dist/index.js"),
                "// rewritten by later step\n",
                "utf8",
              );
            }
          },
        })).toThrow(
          /@revagent\/bridge-simulator rewrote upstream output packages\/gateway-stub\/dist/u,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an unchanged four-step physical output DAG", () => {
    const root = outputFixture();
    try {
      const bootstrapHarness = productionHarnessRuntimeArtifacts(root);
      expect(() =>
        executeCanonicalProductionBuildDag({
          repoRoot: root,
          bootstrapHarness,
          executeStep: () => undefined,
        })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
