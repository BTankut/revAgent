import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  createProductionBuildProvenanceSidecars,
  productionBuildProvenanceSidecarPath,
  verifyProductionBuildProvenance,
} from "../src/productionBuildProvenance.js";
import {
  assertProductionExecutionPlanCurrent,
  buildProductionExecutionPlan,
} from "../src/productionExecutionPlan.js";
import { stableJson } from "../src/stableJson.js";

const roots: string[] = [];
const PACKAGES = [
  "protocol",
  "gateway-stub",
  "bridge-simulator",
  "addin-loopback-fixture",
] as const;

function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).trim();
}

function commit(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Conformance Test",
    "-c",
    "user.email=conformance@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-build-provenance-"));
  roots.push(root);
  git(root, ["init"]);
  write(root, ".gitignore", "**/dist/\nnode_modules/\n");
  write(root, "package.json", "{\"private\":true}\n");
  write(root, "package-lock.json", "{\"lockfileVersion\":3}\n");
  write(root, "tsconfig.base.json", "{\"compilerOptions\":{}}\n");
  for (const packageName of PACKAGES) {
    write(
      root,
      `packages/${packageName}/package.json`,
      `{"name":"@revagent/${packageName}","version":"0.0.0"}\n`,
    );
    write(root, `packages/${packageName}/tsconfig.json`, "{\"extends\":\"../../tsconfig.base.json\"}\n");
    write(root, `packages/${packageName}/src/index.ts`, `export const name = "${packageName}";\n`);
    write(root, `packages/${packageName}/dist/index.js`, `export const name = "${packageName}";\n`);
  }
  write(root, "packages/protocol/scripts/clean.mjs", "export {};\n");
  write(root, "packages/protocol/scripts/generate-types.mjs", "export {};\n");
  write(root, "packages/protocol/schemas/rbp/v1/envelope.schema.json", "{}\n");
  for (const packageName of PACKAGES.filter((entry) => entry !== "protocol")) {
    write(root, `packages/${packageName}/dist/cli.js`, `console.log("${packageName}");\n`);
  }
  write(root, "node_modules/typescript/package.json", "{\"version\":\"5.8.2\"}\n");
  write(root, "node_modules/typescript/lib/tsc.js", "console.log('tsc');\n");
  commit(root, "source");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production build provenance", () => {
  it("writes deterministic sidecars and carries their exact identity in the plan", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    const first = readFileSync(
      path.join(root, productionBuildProvenanceSidecarPath("gateway_stub")),
      "utf8",
    );
    createProductionBuildProvenanceSidecars(root, source);
    const second = readFileSync(
      path.join(root, productionBuildProvenanceSidecarPath("gateway_stub")),
      "utf8",
    );
    expect(second).toBe(first);
    expect(first).toBe(stableJson(JSON.parse(first) as unknown));

    const plan = buildProductionExecutionPlan({
      repoRoot: root,
      runId: "provenance-test",
      sequence: 1,
    });
    expect(plan.components.every(({ expectedIdentity }) =>
      expectedIdentity.buildProvenance !== undefined)).toBe(true);
    expect(() => assertProductionExecutionPlanCurrent(plan, root)).not.toThrow();
  });

  it("fails closed when a sidecar is missing", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    rmSync(path.join(root, productionBuildProvenanceSidecarPath("gateway_stub")));
    expect(() => verifyProductionBuildProvenance(root, source))
      .toThrow(/sidecar is missing or unreadable/u);
  });

  it("fails closed when the ignored entrypoint is stale after provenance capture", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    appendFileSync(path.join(root, "packages/gateway-stub/dist/cli.js"), "// stale\n", "utf8");
    expect(() => verifyProductionBuildProvenance(root, source))
      .toThrow(/entrypoint digest is stale or tampered/u);
  });

  it("fails closed when a dependent runtime artifact is tampered", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    appendFileSync(path.join(root, "packages/protocol/dist/index.js"), "// tamper\n", "utf8");
    expect(() => verifyProductionBuildProvenance(root, source))
      .toThrow(/runtime artifacts are stale or tampered/u);
  });

  it("fails closed against sidecars from a prior clean source commit", () => {
    const root = fixture();
    const oldSource = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, oldSource);
    write(root, "packages/gateway-stub/src/index.ts", "export const name = \"changed\";\n");
    commit(root, "change compile input");
    const currentSource = resolveSourceIdentity(root);
    expect(() => verifyProductionBuildProvenance(root, currentSource))
      .toThrow(/build provenance source is stale/u);
  });

  it("rejects a dirty source before consulting ignored build outputs", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    const plan = buildProductionExecutionPlan({
      repoRoot: root,
      runId: "dirty-tree-test",
      sequence: 1,
    });
    appendFileSync(path.join(root, "packages/gateway-stub/src/index.ts"), "// dirty\n", "utf8");
    expect(() => assertProductionExecutionPlanCurrent(plan, root))
      .toThrow(/requires an exactly clean source tree/u);
  });

  it("rejects canonical-JSON sidecar tampering even when the source is clean", () => {
    const root = fixture();
    const source = resolveSourceIdentity(root);
    createProductionBuildProvenanceSidecars(root, source);
    const sidecarFile = path.join(
      root,
      productionBuildProvenanceSidecarPath("gateway_stub"),
    );
    const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8")) as {
      toolchain: { typescriptVersion: string };
    };
    sidecar.toolchain.typescriptVersion = "5.9.0";
    writeFileSync(sidecarFile, stableJson(sidecar), "utf8");
    expect(() => verifyProductionBuildProvenance(root, source))
      .toThrow(/build toolchain provenance is stale/u);
  });
});
