import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  createProductionBuildProvenanceSidecars,
  verifyProductionBuildProvenance,
} from "../src/productionBuildProvenance.js";
import {
  assertProductionExecutionPlanCurrent,
  buildProductionExecutionPlan,
} from "../src/productionExecutionPlan.js";
import type {
  NodeRuntimeMetadata,
  NodeRuntimeMetadataResolver,
} from "../src/productionRuntimeIdentity.js";
import type { ExecutionPlan } from "../src/types.js";

const roots: string[] = [];
const PACKAGES = [
  "protocol",
  "gateway-stub",
  "bridge-simulator",
  "addin-loopback-fixture",
  "rbp-conformance",
] as const;

export interface ProductionProvenanceFixture {
  root: string;
  nodeExecutable: string;
  npmExecutable: string;
  nodeMetadataResolver: NodeRuntimeMetadataResolver;
}

export function writeFixtureFile(
  root: string,
  relative: string,
  contents: string | Buffer,
): void {
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

export function commitFixture(root: string, message: string): void {
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

export function fixturePackageManifest(
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

export function installFixturePackage(
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
  writeFixtureFile(
    root,
    `${packageRoot}/package.json`,
    fixturePackageManifest(name, input.dependencies, {
      ...(input.peerDependencies === undefined
        ? {}
        : { peerDependencies: input.peerDependencies }),
      ...(input.peerDependenciesMeta === undefined
        ? {}
        : { peerDependenciesMeta: input.peerDependenciesMeta }),
    }),
  );
  for (
    const [relative, contents] of
    Object.entries(input.files ?? { "index.js": "export {};\n" })
  ) {
    writeFixtureFile(root, `${packageRoot}/${relative}`, contents);
  }
}

export function productionProvenanceFixture(): ProductionProvenanceFixture {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-build-provenance-"));
  roots.push(root);
  git(root, ["init"]);
  writeFixtureFile(root, ".gitignore", "**/dist/\n**/node_modules/\n");
  writeFixtureFile(
    root,
    "package.json",
    "{\"name\":\"fixture-root\",\"version\":\"1.0.0\",\"private\":true}\n",
  );
  writeFixtureFile(root, "package-lock.json", "{\"lockfileVersion\":3}\n");
  writeFixtureFile(root, "tsconfig.base.json", "{\"compilerOptions\":{}}\n");

  const manifests: Record<(typeof PACKAGES)[number], string> = {
    protocol: fixturePackageManifest(
      "@revagent/protocol",
      {
        ajv: "^8.0.0",
        "ajv-formats": "^3.0.0",
      },
      {
        devDependencies: {
          "json-schema-to-typescript": "15.0.4",
        },
      },
    ),
    "gateway-stub": fixturePackageManifest("@revagent/gateway-stub", {
      "@revagent/protocol": "1.0.0",
      ws: "^8.0.0",
    }),
    "bridge-simulator": fixturePackageManifest("@revagent/bridge-simulator", {
      "@revagent/addin-loopback-fixture": "1.0.0",
      "@revagent/protocol": "1.0.0",
      "better-sqlite3": "12.9.0",
      ws: "^8.0.0",
    }),
    "addin-loopback-fixture": fixturePackageManifest(
      "@revagent/addin-loopback-fixture",
      {
        "@revagent/protocol": "1.0.0",
        ajv: "^8.0.0",
        "ajv-formats": "^3.0.0",
      },
    ),
    "rbp-conformance": fixturePackageManifest("@revagent/rbp-conformance", {
      "@revagent/protocol": "1.0.0",
      ajv: "^8.0.0",
      "ajv-formats": "^3.0.0",
      ws: "^8.0.0",
    }),
  };
  for (const packageName of PACKAGES) {
    writeFixtureFile(
      root,
      `packages/${packageName}/package.json`,
      manifests[packageName],
    );
    writeFixtureFile(
      root,
      `packages/${packageName}/tsconfig.json`,
      "{\"extends\":\"../../tsconfig.base.json\"}\n",
    );
    writeFixtureFile(
      root,
      `packages/${packageName}/src/index.ts`,
      `export const name = "${packageName}";\n`,
    );
    writeFixtureFile(
      root,
      `packages/${packageName}/dist/index.js`,
      `export const name = "${packageName}";\n`,
    );
  }
  writeFixtureFile(
    root,
    "packages/protocol/scripts/clean.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/protocol/scripts/generate-types.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/.gitattributes",
    "scripts/*.ps1 text eol=lf\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/bootstrap-identity.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/invoke-production.ps1",
    "exit 0\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/prepare-production.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-bootstrap-identity.json",
    "{}\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-cli-bootstrap.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-controller-bootstrap.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-launch-bootstrap.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-launch-attestation.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/scripts/production-source-anchor.mjs",
    "export {};\n",
  );
  writeFixtureFile(
    root,
    "packages/protocol/schemas/rbp/v1/envelope.schema.json",
    "{}\n",
  );
  for (const packageName of PACKAGES.filter((entry) => entry !== "protocol")) {
    writeFixtureFile(
      root,
      `packages/${packageName}/dist/cli.js`,
      `console.log("${packageName}");\n`,
    );
  }
  writeFixtureFile(
    root,
    "packages/rbp-conformance/dist/src/cli.js",
    "console.log('rbp-conformance');\n",
  );
  writeFixtureFile(
    root,
    "packages/rbp-conformance/dist/src/validator.js",
    "export const valid = true;\n",
  );

  mkdirSync(path.join(root, "node_modules", "@revagent"), { recursive: true });
  for (const packageName of PACKAGES) {
    symlinkSync(
      path.join(root, "packages", packageName),
      path.join(root, "node_modules", "@revagent", packageName),
      "junction",
    );
  }
  for (
    const packageName of
    ["protocol", "addin-loopback-fixture", "rbp-conformance"]
  ) {
    installFixturePackage(
      root,
      `packages/${packageName}/node_modules/ajv`,
      "ajv",
      { files: { "dist/runtime.js": "export const ajv = 8;\n" } },
    );
  }
  installFixturePackage(root, "node_modules/ajv-formats", "ajv-formats", {
    dependencies: { ajv: "^8.0.0" },
    peerDependencies: { ajv: "^8.0.0" },
    peerDependenciesMeta: { ajv: { optional: true } },
  });
  installFixturePackage(
    root,
    "node_modules/ajv-formats/node_modules/ajv",
    "ajv",
    { files: { "dist/runtime.js": "export const nestedAjv = 8;\n" } },
  );
  installFixturePackage(root, "node_modules/ws", "ws", {
    peerDependencies: {
      bufferutil: "^4.0.1",
      "utf-8-validate": ">=5.0.2",
    },
    peerDependenciesMeta: {
      bufferutil: { optional: true },
      "utf-8-validate": { optional: true },
    },
  });
  installFixturePackage(
    root,
    "node_modules/better-sqlite3",
    "better-sqlite3",
    {
      files: {
        "lib/database.js": "module.exports = {};\n",
        "build/Release/better_sqlite3.node": Buffer.from("native-fixture"),
      },
    },
  );
  installFixturePackage(
    root,
    "node_modules/json-schema-to-typescript",
    "json-schema-to-typescript",
    {
      dependencies: { "generator-transitive": "1.0.0" },
      files: { "index.js": "module.exports = {};\n" },
    },
  );
  installFixturePackage(
    root,
    "node_modules/generator-transitive",
    "generator-transitive",
    { files: { "index.js": "module.exports = {};\n" } },
  );
  installFixturePackage(root, "node_modules/typescript", "typescript", {
    files: {
      "lib/tsc.js": "require('./_tsc.js');\n",
      "lib/_tsc.js": "console.log('compiler runtime');\n",
    },
  });
  installFixturePackage(root, "node_modules/npm", "npm", {
    files: {
      "bin/npm-cli.js": "console.log('npm');\n",
      "node_modules/npm-runtime/index.js": "export {};\n",
    },
  });
  const nodeExecutable = process.execPath;
  const npmExecutable = path.join(
    root,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const nodeMetadataResolver = (executable: string): NodeRuntimeMetadata => ({
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    modulesAbi: process.versions.modules,
    napiVersion: process.versions.napi ?? null,
    execPath: executable,
  });

  commitFixture(root, "source");
  return { root, nodeExecutable, npmExecutable, nodeMetadataResolver };
}

export function createFixtureSidecars(
  value: ProductionProvenanceFixture,
): void {
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

export function buildFixturePlan(
  value: ProductionProvenanceFixture,
): ExecutionPlan {
  return buildProductionExecutionPlan({
    repoRoot: value.root,
    runId: "provenance-test",
    sequence: 1,
    nodeExecutable: value.nodeExecutable,
    nodeMetadataResolver: value.nodeMetadataResolver,
  });
}

export function assertFixtureCurrent(
  value: ProductionProvenanceFixture,
  plan: ExecutionPlan,
): void {
  assertProductionExecutionPlanCurrent(
    plan,
    value.root,
    resolveSourceIdentity,
    verifyProductionBuildProvenance,
    { nodeMetadataResolver: value.nodeMetadataResolver },
  );
}

export function cleanupProductionProvenanceFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
