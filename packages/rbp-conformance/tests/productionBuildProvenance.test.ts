import {
  appendFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  productionBuildProvenanceSidecarPath,
  verifyProductionBuildProvenance,
} from "../src/productionBuildProvenance.js";
import {
  assertProductionRuntimeLaunchCurrent,
} from "../src/productionExecutionPlan.js";
import { stableJson } from "../src/stableJson.js";
import {
  assertFixtureCurrent as assertCurrent,
  buildFixturePlan as buildPlan,
  cleanupProductionProvenanceFixtures,
  commitFixture as commit,
  createFixtureSidecars as createSidecars,
  productionProvenanceFixture as fixture,
  writeFixtureFile as write,
} from "./productionProvenanceFixture.js";

afterEach(() => {
  cleanupProductionProvenanceFixtures();
});

describe("production build provenance", { timeout: 30_000 }, () => {
  it("writes deterministic v3 sidecars and carries their exact identity in the plan", () => {
    const value = fixture();
    createSidecars(value);
    const first = readFileSync(
      path.join(value.root, productionBuildProvenanceSidecarPath("gateway_stub")),
      "utf8",
    );
    createSidecars(value);
    const second = readFileSync(
      path.join(value.root, productionBuildProvenanceSidecarPath("gateway_stub")),
      "utf8",
    );
    expect(second).toBe(first);
    expect(first).toBe(stableJson(JSON.parse(first) as unknown));
    const sidecar = JSON.parse(first) as {
      runtimeDependencies: {
        resolutions: Array<{ dependencyName: string; status: string }>;
        packages: Array<{
          name: string;
          nativeFiles: Array<{ path: string }>;
        }>;
      };
      buildGeneratorDependencies: {
        packages: Array<{ name: string; contents: { files: Array<{ path: string }> } }>;
      };
      harness: { runtimeArtifacts: { files: Array<{ path: string }> } };
      toolchain: {
        npmLauncher: { package: { contents: { files: Array<{ path: string }> } } };
        typescript: { package: { contents: { files: Array<{ path: string }> } } };
      };
    };
    expect(sidecar.toolchain.typescript.package.contents.files)
      .toContainEqual(expect.objectContaining({ path: "lib/_tsc.js" }));
    expect(sidecar.toolchain.npmLauncher.package.contents.files)
      .toContainEqual(expect.objectContaining({
        path: "node_modules/npm-runtime/index.js",
      }));
    expect(sidecar.buildGeneratorDependencies.packages)
      .toContainEqual(expect.objectContaining({
        name: "json-schema-to-typescript",
      }));
    expect(sidecar.buildGeneratorDependencies.packages)
      .toContainEqual(expect.objectContaining({
        name: "generator-transitive",
      }));
    expect(sidecar.harness.runtimeArtifacts.files)
      .toContainEqual(expect.objectContaining({
        path: "packages/rbp-conformance/dist/src/validator.js",
      }));
    const bridgeSidecar = JSON.parse(readFileSync(
      path.join(
        value.root,
        productionBuildProvenanceSidecarPath("bridge_simulator"),
      ),
      "utf8",
    )) as typeof sidecar;
    expect(bridgeSidecar.runtimeDependencies.packages)
      .toContainEqual(expect.objectContaining({
        name: "better-sqlite3",
        nativeFiles: [
          expect.objectContaining({ path: "build/Release/better_sqlite3.node" }),
        ],
      }));
    expect(bridgeSidecar.runtimeDependencies.resolutions)
      .toContainEqual(expect.objectContaining({
        dependencyName: "bufferutil",
        status: "absent_optional",
      }));

    const plan = buildPlan(value);
    expect(plan.components.every(({ expectedIdentity }) =>
      expectedIdentity.buildProvenance !== undefined)).toBe(true);
    expect(() => assertCurrent(value, plan)).not.toThrow();
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).not.toThrow();
  });

  it("fails closed when a sidecar is missing", () => {
    const value = fixture();
    createSidecars(value);
    rmSync(path.join(
      value.root,
      productionBuildProvenanceSidecarPath("gateway_stub"),
    ));
    expect(() =>
      verifyProductionBuildProvenance(value.root, resolveSourceIdentity(value.root), {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/sidecar is missing or unreadable/u);
  });

  it("fails closed against sidecars from a prior clean source commit", () => {
    const value = fixture();
    createSidecars(value);
    write(
      value.root,
      "packages/gateway-stub/src/index.ts",
      "export const name = \"changed\";\n",
    );
    commit(value.root, "change compile input");
    expect(() =>
      verifyProductionBuildProvenance(value.root, resolveSourceIdentity(value.root), {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/build provenance source is stale/u);
  });

  it("rejects a dirty source before consulting ignored build outputs", () => {
    const value = fixture();
    createSidecars(value);
    const plan = buildPlan(value);
    appendFileSync(
      path.join(value.root, "packages/gateway-stub/src/index.ts"),
      "// dirty\n",
      "utf8",
    );
    expect(() => assertCurrent(value, plan))
      .toThrow(/tracked bytes do not match protected HEAD/u);
  });

  it("rejects canonical-JSON sidecar toolchain tampering", () => {
    const value = fixture();
    createSidecars(value);
    const sidecarFile = path.join(
      value.root,
      productionBuildProvenanceSidecarPath("gateway_stub"),
    );
    const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8")) as {
      toolchain: { typescript: { package: { version: string } } };
    };
    sidecar.toolchain.typescript.package.version = "5.9.0";
    writeFileSync(sidecarFile, stableJson(sidecar), "utf8");
    expect(() =>
      verifyProductionBuildProvenance(value.root, resolveSourceIdentity(value.root), {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/build toolchain provenance is stale/u);
  });

});
