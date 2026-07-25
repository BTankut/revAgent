import {
  appendFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  productionHarnessRuntimeArtifacts,
} from "../src/productionBuildProvenance.js";
import {
  executeCanonicalProductionBuildDag,
} from "../src/productionPreparation.js";
import {
  productionProvenanceFixture,
} from "./productionProvenanceFixture.js";

function outputFixture(): string {
  return productionProvenanceFixture().root;
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
