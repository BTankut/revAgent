import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  assertProductionRuntimeLaunchCurrent,
  buildProductionExecutionPlan,
} from "../src/productionExecutionPlan.js";
import type {
  NodeRuntimeMetadata,
  NodeRuntimeMetadataResolver,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";

const roots: string[] = [];
const PACKAGES = [
  "protocol",
  "gateway-stub",
  "bridge-simulator",
  "addin-loopback-fixture",
  "rbp-conformance",
] as const;

interface Fixture {
  root: string;
  nodeExecutable: string;
  npmExecutable: string;
  nodeMetadataResolver: NodeRuntimeMetadataResolver;
}

function write(root: string, relative: string, contents: string | Buffer): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
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

function packageManifest(
  name: string,
  dependencies: Readonly<Record<string, string>> = {},
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify({
    name,
    version: "1.0.0",
    ...extra,
    dependencies,
  })}\n`;
}

function installedPackage(
  root: string,
  packageRoot: string,
  name: string,
  input: {
    dependencies?: Readonly<Record<string, string>>;
    peerDependencies?: Readonly<Record<string, string>>;
    peerDependenciesMeta?: Readonly<Record<string, { optional: true }>>;
    files?: Readonly<Record<string, string | Buffer>>;
  } = {},
): void {
  write(
    root,
    `${packageRoot}/package.json`,
    packageManifest(name, input.dependencies, {
      ...(input.peerDependencies === undefined
        ? {}
        : { peerDependencies: input.peerDependencies }),
      ...(input.peerDependenciesMeta === undefined
        ? {}
        : { peerDependenciesMeta: input.peerDependenciesMeta }),
    }),
  );
  for (const [relative, contents] of Object.entries(input.files ?? { "index.js": "export {};\n" })) {
    write(root, `${packageRoot}/${relative}`, contents);
  }
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-build-provenance-"));
  roots.push(root);
  git(root, ["init"]);
  write(root, ".gitignore", "**/dist/\n**/node_modules/\n");
  write(root, "package.json", "{\"private\":true}\n");
  write(root, "package-lock.json", "{\"lockfileVersion\":3}\n");
  write(root, "tsconfig.base.json", "{\"compilerOptions\":{}}\n");

  const manifests: Record<(typeof PACKAGES)[number], string> = {
    protocol: packageManifest("@revagent/protocol", {
      ajv: "^8.0.0",
      "ajv-formats": "^3.0.0",
    }),
    "gateway-stub": packageManifest("@revagent/gateway-stub", {
      "@revagent/protocol": "1.0.0",
      ws: "^8.0.0",
    }),
    "bridge-simulator": packageManifest("@revagent/bridge-simulator", {
      "@revagent/addin-loopback-fixture": "1.0.0",
      "@revagent/protocol": "1.0.0",
      "better-sqlite3": "12.9.0",
      ws: "^8.0.0",
    }),
    "addin-loopback-fixture": packageManifest("@revagent/addin-loopback-fixture", {
      "@revagent/protocol": "1.0.0",
      ajv: "^8.0.0",
      "ajv-formats": "^3.0.0",
    }),
    "rbp-conformance": packageManifest("@revagent/rbp-conformance", {
      "@revagent/protocol": "1.0.0",
      ajv: "^8.0.0",
      "ajv-formats": "^3.0.0",
      ws: "^8.0.0",
    }),
  };
  for (const packageName of PACKAGES) {
    write(root, `packages/${packageName}/package.json`, manifests[packageName]);
    write(
      root,
      `packages/${packageName}/tsconfig.json`,
      "{\"extends\":\"../../tsconfig.base.json\"}\n",
    );
    write(
      root,
      `packages/${packageName}/src/index.ts`,
      `export const name = "${packageName}";\n`,
    );
    write(
      root,
      `packages/${packageName}/dist/index.js`,
      `export const name = "${packageName}";\n`,
    );
  }
  write(root, "packages/protocol/scripts/clean.mjs", "export {};\n");
  write(root, "packages/protocol/scripts/generate-types.mjs", "export {};\n");
  write(root, "packages/protocol/schemas/rbp/v1/envelope.schema.json", "{}\n");
  for (const packageName of PACKAGES.filter((entry) => entry !== "protocol")) {
    write(root, `packages/${packageName}/dist/cli.js`, `console.log("${packageName}");\n`);
  }
  write(
    root,
    "packages/rbp-conformance/dist/src/cli.js",
    "console.log('rbp-conformance');\n",
  );
  write(root, "packages/rbp-conformance/dist/src/validator.js", "export const valid = true;\n");

  mkdirSync(path.join(root, "node_modules", "@revagent"), { recursive: true });
  for (const packageName of PACKAGES) {
    symlinkSync(
      path.join(root, "packages", packageName),
      path.join(root, "node_modules", "@revagent", packageName),
      "junction",
    );
  }
  for (const packageName of ["protocol", "addin-loopback-fixture", "rbp-conformance"]) {
    installedPackage(
      root,
      `packages/${packageName}/node_modules/ajv`,
      "ajv",
      { files: { "dist/runtime.js": "export const ajv = 8;\n" } },
    );
  }
  installedPackage(root, "node_modules/ajv-formats", "ajv-formats", {
    dependencies: { ajv: "^8.0.0" },
    peerDependencies: { ajv: "^8.0.0" },
    peerDependenciesMeta: { ajv: { optional: true } },
  });
  installedPackage(
    root,
    "node_modules/ajv-formats/node_modules/ajv",
    "ajv",
    { files: { "dist/runtime.js": "export const nestedAjv = 8;\n" } },
  );
  installedPackage(root, "node_modules/ws", "ws", {
    peerDependencies: {
      bufferutil: "^4.0.1",
      "utf-8-validate": ">=5.0.2",
    },
    peerDependenciesMeta: {
      bufferutil: { optional: true },
      "utf-8-validate": { optional: true },
    },
  });
  installedPackage(root, "node_modules/better-sqlite3", "better-sqlite3", {
    files: {
      "lib/database.js": "module.exports = {};\n",
      "build/Release/better_sqlite3.node": Buffer.from("native-fixture"),
    },
  });

  installedPackage(root, "node_modules/typescript", "typescript", {
    files: {
      "lib/tsc.js": "require('./_tsc.js');\n",
      "lib/_tsc.js": "console.log('compiler runtime');\n",
    },
  });
  installedPackage(root, "node_modules/npm", "npm", {
    files: {
      "bin/npm-cli.js": "console.log('npm');\n",
      "node_modules/npm-runtime/index.js": "export {};\n",
    },
  });
  const nodeExecutable = path.join(root, "node_modules", "fixture-node.exe");
  write(root, "node_modules/fixture-node.exe", Buffer.from("fixture-node-binary"));
  const npmExecutable = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
  const nodeMetadataResolver = (executable: string): NodeRuntimeMetadata => ({
    version: "v22.22.2",
    platform: "win32",
    arch: "x64",
    modulesAbi: "127",
    napiVersion: "10",
    execPath: executable,
  });

  commit(root, "source");
  return { root, nodeExecutable, npmExecutable, nodeMetadataResolver };
}

function createSidecars(value: Fixture): void {
  createProductionBuildProvenanceSidecars(
    value.root,
    resolveSourceIdentity(value.root),
    {
      buildNodeExecutable: value.nodeExecutable,
      runtimeNodeExecutable: value.nodeExecutable,
      npmExecutable: value.npmExecutable,
      nodeMetadataResolver: value.nodeMetadataResolver,
    },
  );
}

function buildPlan(value: Fixture): ExecutionPlan {
  return buildProductionExecutionPlan({
    repoRoot: value.root,
    runId: "provenance-test",
    sequence: 1,
    nodeExecutable: value.nodeExecutable,
    nodeMetadataResolver: value.nodeMetadataResolver,
  });
}

function assertCurrent(value: Fixture, plan: ExecutionPlan): void {
  assertProductionExecutionPlanCurrent(
    plan,
    value.root,
    resolveSourceIdentity,
    verifyProductionBuildProvenance,
    { nodeMetadataResolver: value.nodeMetadataResolver },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production build provenance", { timeout: 20_000 }, () => {
  it("writes deterministic v2 sidecars and carries their exact identity in the plan", () => {
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
      .toThrow(/requires an exactly clean source tree/u);
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

  it.each([
    {
      label: "component runtime output",
      relative: "packages/gateway-stub/dist/cli.js",
      expected: /entrypoint digest is stale|runtime artifacts/u,
    },
    {
      label: "controller runner or validator output",
      relative: "packages/rbp-conformance/dist/src/validator.js",
      expected: /conformance harness/u,
    },
    {
      label: "external JavaScript runtime dependency",
      relative: "node_modules/ws/index.js",
      expected: /runtime dependency closure|runtime dependencies/u,
    },
    {
      label: "native runtime addon",
      relative: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      expected: /runtime dependency closure|runtime dependencies/u,
    },
    {
      label: "full TypeScript compiler runtime",
      relative: "node_modules/typescript/lib/_tsc.js",
      expected: /build toolchain provenance/u,
    },
    {
      label: "npm package runtime",
      relative: "node_modules/npm/node_modules/npm-runtime/index.js",
      expected: /build toolchain provenance/u,
    },
    {
      label: "runtime Node executable",
      relative: "node_modules/fixture-node.exe",
      expected: /build toolchain provenance|runtime Node identity/u,
    },
  ])("invalidates an existing plan when $label bytes change", ({ relative, expected }) => {
    const value = fixture();
    createSidecars(value);
    const plan = buildPlan(value);
    appendFileSync(path.join(value.root, relative), Buffer.from("tamper"));
    expect(() => assertCurrent(value, plan)).toThrow(expected);
  });

  it("records optional-peer absence and rejects a newly resolvable optional package", () => {
    const value = fixture();
    createSidecars(value);
    const plan = buildPlan(value);
    installedPackage(value.root, "node_modules/bufferutil", "bufferutil");
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/runtime dependencies changed before launch/u);
  });

  it("rejects command executable substitution before runtime provenance checking", () => {
    const value = fixture();
    createSidecars(value);
    const plan = buildPlan(value);
    plan.components[0]!.command.executable = process.execPath;
    expect(() =>
      assertProductionRuntimeLaunchCurrent(plan, value.root, {
        nodeMetadataResolver: value.nodeMetadataResolver,
      })).toThrow(/share one bound runtime Node|canonical production descriptor/u);
  });
});
