import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertTrustedProductionLaunch,
  assertTrustedProductionSourceCurrent,
} from "./production-launch-attestation.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

// This OS-backed assertion runs before any compiler, package manager, ignored
// build output, or production controller module is imported.
assertTrustedProductionLaunch({ repoRoot, role: "prepare-wrapper" });

const resolutionEnvironmentKeys = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
]);
const inheritedResolutionOverride = Object.keys(process.env).find((key) =>
  resolutionEnvironmentKeys.has(key.toUpperCase())
);
if (inheritedResolutionOverride !== undefined) {
  throw new Error(
    `canonical production preparation environment cannot set ${
      inheritedResolutionOverride
    }`,
  );
}
if (
  Object.keys(process.env).some((key) =>
    key.toUpperCase() === "NPM_EXECPATH" ||
    key.toUpperCase().startsWith("NPM_LIFECYCLE_")
  )
) {
  throw new Error(
    "canonical production preparation must be invoked directly with the bound Node executable",
  );
}

const {
  assertProductionNpmBootstrapIdentityCurrent,
  innerPrepareArguments,
  parsePrepareBootstrapArguments,
} = await import("./bootstrap-identity.mjs");
const {
  forwardedArgs,
  npmExecutable,
} = parsePrepareBootstrapArguments(process.argv.slice(2));
const expectedNpmExecutable = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
if (!samePath(npmExecutable, expectedNpmExecutable)) {
  throw new Error(
    `canonical production preparation requires exact Program Files npm: ${
      expectedNpmExecutable
    }`,
  );
}

const { buildAndImportTrustedProductionController } = await import(
  "./production-controller-bootstrap.mjs"
);
const {
  module: cliModule,
  npmIdentity,
  sourceAnchor,
} = await buildAndImportTrustedProductionController({
  repoRoot,
  npmExecutable,
});
if (
  npmIdentity === undefined ||
  typeof cliModule.runPrepareProductionAsyncCli !== "function"
) {
  throw new Error("fresh production controller does not expose guarded preparation");
}

process.env.RBP_PRODUCTION_NPM_EXECUTABLE = npmExecutable;
try {
  await cliModule.runPrepareProductionAsyncCli(
    innerPrepareArguments(forwardedArgs, sourceAnchor.git.path),
    repoRoot,
  );
} finally {
  delete process.env.RBP_PRODUCTION_NPM_EXECUTABLE;
  assertProductionNpmBootstrapIdentityCurrent(npmExecutable, npmIdentity);
  assertTrustedProductionSourceCurrent({ repoRoot, expected: sourceAnchor });
}
