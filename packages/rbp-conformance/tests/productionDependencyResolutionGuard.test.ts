import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProductionRuntimeLaunchCurrent,
} from "../src/productionExecutionPlan.js";
import {
  buildFixturePlan,
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  fixturePackageManifest,
  installFixturePackage,
  productionProvenanceFixture,
  writeFixtureFile,
} from "./productionProvenanceFixture.js";

afterEach(cleanupProductionProvenanceFixtures);

describe("runtime dependency resolution guards", { timeout: 45_000 }, () => {
  it("records optional absence then rejects a newly installed package", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    installFixturePackage(value.root, "node_modules/bufferutil", "bufferutil");
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/runtime dependencies changed before launch/u);
  });

  it.each([
    {
      label: "directory entrypoint without a manifest",
      relative: "node_modules/bufferutil/index.js",
    },
    {
      label: "package-like top-level file without a manifest",
      relative: "node_modules/bufferutil.js",
    },
  ])("rejects optional $label", ({ relative }) => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    writeFixtureFile(value.root, relative, "module.exports = {};\n");
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(
        /Node resolved bufferutil without a captured owning package manifest/u,
      );
  });

  it("rejects a workspace junction retarget before launch", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    writeFixtureFile(
      value.root,
      "node_modules/.retarget/protocol/package.json",
      fixturePackageManifest("@revagent/protocol"),
    );
    writeFixtureFile(
      value.root,
      "node_modules/.retarget/protocol/index.js",
      "module.exports = {};\n",
    );
    const link = path.join(value.root, "node_modules", "@revagent", "protocol");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(
      path.join(value.root, "node_modules", ".retarget", "protocol"),
      link,
      "junction",
    );
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/external dependency is a symbolic link|runtime dependencies/u);
  });

  it("rejects command executable substitution before dependency verification", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    plan.components[0]!.command.executable = process.execPath;
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/share one bound runtime Node|canonical production descriptor/u);
  });
});
