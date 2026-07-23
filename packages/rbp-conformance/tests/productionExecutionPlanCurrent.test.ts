import { describe, expect, it, vi } from "vitest";

import {
  assertProductionControllerRuntimeCurrent,
  assertProductionExecutionPlanCurrent,
  productionComponentLaunchConfigs,
} from "../src/productionExecutionPlan.js";
import { resolveCurrentProcessNodeIdentity } from "../src/productionRuntimeIdentity.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
} from "../src/types.js";
import { createPlan } from "./helpers.js";

function provenance(seed: number): ComponentBuildProvenanceIdentity {
  const hash = seed.toString(16).padStart(64, "0");
  const toolchainHash = "f".repeat(64);
  const packageIdentity = {
    name: "package",
    version: "1.0.0",
    packagePath: "node_modules/package",
    fileCount: 1,
    filesSha256: toolchainHash,
    nativeFileCount: 0,
    nativeFilesSha256: toolchainHash,
  };
  const node = {
    path: "C:/node.exe",
    realPath: "C:/node.exe",
    sha256: toolchainHash,
    version: "v22.0.0",
    platform: "win32",
    arch: "x64",
    modulesAbi: "127",
    napiVersion: "10",
  };
  return {
    schemaVersion: "rbp-production-build-provenance/v3",
    buildContractVersion: "rbp-production-typescript-build/v3",
    sidecarPath: `packages/component-${String(seed)}/dist/rbp-build-provenance.json`,
    sidecarSha256: hash,
    compileInputsSha256: hash,
    buildGeneratorDependenciesSha256: hash,
    runtimeArtifactsSha256: hash,
    runtimeDependenciesSha256: hash,
    harnessArtifactsSha256: hash,
    harnessRuntimeDependenciesSha256: hash,
    toolchain: {
      buildNode: node,
      runtimeNode: node,
      npmLauncher: {
        path: "C:/npm/npm-cli.js",
        realPath: "C:/npm/npm-cli.js",
        sha256: toolchainHash,
        package: { ...packageIdentity, name: "npm" },
      },
      typescript: {
        package: { ...packageIdentity, name: "typescript", version: "5.8.2" },
        entrypointPath: "node_modules/typescript/lib/tsc.js",
        entrypointSha256: toolchainHash,
      },
      git: {
        path: "C:/git.exe",
        realPath: "C:/git.exe",
        sha256: toolchainHash,
        version: "git version 2.50.0",
      },
      powershell: null,
    },
  };
}

function canonicalizeCommands(plan: ReturnType<typeof createPlan>): void {
  const commands = new Map(
    productionComponentLaunchConfigs("C:/repo", "C:/node.exe")
      .map(({ id, command }) => [id, command]),
  );
  for (const component of plan.components) {
    component.command = structuredClone(commands.get(component.id)!);
  }
}

describe("production execution plan source gate", () => {
  it("accepts only the exact clean source identity resolved at execution time", () => {
    const plan = createPlan();
    canonicalizeCommands(plan);
    const verified = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      component.expectedIdentity.buildProvenance = identity;
      verified.set(component.id, structuredClone(identity));
    });
    const resolver = vi.fn(() => structuredClone(plan.source));
    const verifier = vi.fn(() => verified);
    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", resolver, verifier),
    ).not.toThrow();
    expect(resolver).toHaveBeenCalledWith(
      "C:/repo",
      plan.components[0]!.expectedIdentity.buildProvenance!.toolchain.git,
    );
    expect(verifier).toHaveBeenCalledWith(
      "C:/repo",
      plan.source,
      {
        expectedRuntimeNodeExecutable: "C:/node.exe",
        expectedGitExecutable: "C:/git.exe",
      },
    );

    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", () => ({
        ...structuredClone(plan.source),
        treeSha: "b".repeat(40),
      }), verifier),
    ).toThrow(/does not match clean repository source/u);
  });

  it("requires every production plan identity to match verified provenance", () => {
    const plan = createPlan();
    canonicalizeCommands(plan);
    const verified = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      component.expectedIdentity.buildProvenance = identity;
      verified.set(component.id, structuredClone(identity));
    });
    delete plan.components[0]!.expectedIdentity.buildProvenance;
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        "C:/repo",
        () => structuredClone(plan.source),
        () => verified,
      ),
    ).toThrow(/lacks required build provenance/u);

    plan.components[0]!.expectedIdentity.buildProvenance = provenance(1);
    verified.set("gateway_stub", provenance(99));
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        "C:/repo",
        () => structuredClone(plan.source),
        () => verified,
      ),
    ).toThrow(/does not match the execution plan/u);
  });

  it("rejects a substituted controller Node identity before production execution", () => {
    const plan = createPlan();
    const current = resolveCurrentProcessNodeIdentity();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      identity.toolchain.runtimeNode = structuredClone(current);
      component.expectedIdentity.buildProvenance = identity;
    });
    expect(() => assertProductionControllerRuntimeCurrent(plan)).not.toThrow();
    plan.components.forEach((component) => {
      component.expectedIdentity.buildProvenance!.toolchain.runtimeNode.sha256 =
        "0".repeat(64);
    });
    expect(() => assertProductionControllerRuntimeCurrent(plan))
      .toThrow(/controller Node does not match/u);
  });

  it.each([
    "NODE_OPTIONS",
    "node_path",
    "Node_Preserve_Symlinks",
    "NODE_COMPILE_CACHE",
    "node_disable_compile_cache",
    "WS_NO_BUFFER_UTIL",
    "ws_no_utf_8_validate",
  ])("rejects controller runtime-affecting environment key %s", (key) => {
    const plan = createPlan();
    const current = resolveCurrentProcessNodeIdentity();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      identity.toolchain.runtimeNode = structuredClone(current);
      component.expectedIdentity.buildProvenance = identity;
    });
    expect(() =>
      assertProductionControllerRuntimeCurrent(
        plan,
        () => structuredClone(current),
        { [key]: "hostile" },
      )).toThrow(new RegExp(key, "iu"));
  });
});
