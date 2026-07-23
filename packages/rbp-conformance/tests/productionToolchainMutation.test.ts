import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  productionBuildProvenanceSidecarPath,
  verifyProductionBuildProvenance,
} from "../src/productionBuildProvenance.js";
import { executeGuardedProtocolGeneration } from "../src/productionPreparation.js";
import {
  resolveInstalledBuildGeneratorDependencyClosure,
  resolveNodeExecutableIdentity,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import {
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  productionProvenanceFixture,
} from "./productionProvenanceFixture.js";

afterEach(cleanupProductionProvenanceFixtures);

describe("production toolchain mutation guards", { timeout: 45_000 }, () => {
  it.each([
    {
      label: "bound Git",
      mutate: (toolchain: {
        git: { sha256: string };
        runtimeNode: { sha256: string };
        powershell: { sha256: string } | null;
      }) => {
        toolchain.git.sha256 = "0".repeat(64);
      },
    },
    {
      label: "bound runtime Node",
      mutate: (toolchain: {
        git: { sha256: string };
        runtimeNode: { sha256: string };
        powershell: { sha256: string } | null;
      }) => {
        toolchain.runtimeNode.sha256 = "0".repeat(64);
      },
    },
    {
      label: "bound PowerShell",
      mutate: (toolchain: {
        git: { sha256: string };
        runtimeNode: { sha256: string };
        powershell: { sha256: string } | null;
      }) => {
        if (toolchain.powershell === null) {
          throw new Error("PowerShell identity is required by this Windows fixture");
        }
        toolchain.powershell.sha256 = "0".repeat(64);
      },
    },
  ])("rejects canonical sidecar drift for $label", ({ mutate }) => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const sidecarFile = path.join(
      value.root,
      productionBuildProvenanceSidecarPath("gateway_stub"),
    );
    const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8")) as {
      toolchain: {
        git: { sha256: string };
        runtimeNode: { sha256: string };
        powershell: { sha256: string } | null;
      };
    };
    mutate(sidecar.toolchain);
    writeFileSync(sidecarFile, stableJson(sidecar), "utf8");

    expect(() =>
      verifyProductionBuildProvenance(
        value.root,
        resolveSourceIdentity(value.root),
        { nodeMetadataResolver: value.nodeMetadataResolver },
      )).toThrow(/production build toolchain provenance is stale/u);
  });

  it("detects generator dependency mutation immediately after generation", () => {
    const value = productionProvenanceFixture();
    const runtimeNode = resolveNodeExecutableIdentity(
      value.nodeExecutable,
      value.nodeMetadataResolver,
    );
    const expected = resolveInstalledBuildGeneratorDependencyClosure(
      value.root,
      runtimeNode,
    );
    const transitive = path.join(
      value.root,
      "node_modules/generator-transitive/index.js",
    );
    const original = readFileSync(transitive);
    try {
      expect(() =>
        executeGuardedProtocolGeneration({
          repoRoot: value.root,
          runtimeNode,
          expected,
          executeGeneration: () => {
            appendFileSync(transitive, "tampered during generation\n", "utf8");
          },
        })).toThrow(/closure changed after generation/u);
    } finally {
      writeFileSync(transitive, original);
    }
    expect(() =>
      executeGuardedProtocolGeneration({
        repoRoot: value.root,
        runtimeNode,
        expected,
        executeGeneration: () => undefined,
      })).not.toThrow();
  });
});
