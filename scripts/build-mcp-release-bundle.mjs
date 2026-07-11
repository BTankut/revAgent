import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const packageRoot = process.cwd();
const packageJsonPath = path.join(packageRoot, "package.json");
const packageLockPath = path.join(packageRoot, "package-lock.json");
const releaseRoot = path.join(packageRoot, "release");
const releaseBundlePath = path.join(releaseRoot, "index.js");
const spatialSchemasSource = path.join(packageRoot, "schemas", "spatial", "v0.1");
const spatialSchemasRelease = path.join(releaseRoot, "schemas", "spatial", "v0.1");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildRuntimePackageJson(sourcePackage) {
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    private: true,
    main: "build/index.js",
    type: "module",
    license: sourcePackage.license || "UNLICENSED",
  };

  if (typeof sourcePackage.bin === "string") {
    runtimePackage.bin = "./build/index.js";
  } else if (sourcePackage.bin && Object.keys(sourcePackage.bin).length > 0) {
    runtimePackage.bin = Object.fromEntries(
      Object.keys(sourcePackage.bin).map((name) => [name, "./build/index.js"]),
    );
  }

  if (sourcePackage.dependencies && Object.keys(sourcePackage.dependencies).length > 0) {
    runtimePackage.dependencies = sourcePackage.dependencies;
  }
  if (sourcePackage.overrides && Object.keys(sourcePackage.overrides).length > 0) {
    runtimePackage.overrides = sourcePackage.overrides;
  }

  return runtimePackage;
}

function buildRuntimePackageLock(sourceLock, runtimePackage) {
  const packages = {};
  for (const [packagePath, entry] of Object.entries(sourceLock.packages || {})) {
    if (packagePath !== "" && entry?.dev === true) {
      continue;
    }
    packages[packagePath] = { ...entry };
  }

  packages[""] = {
    name: runtimePackage.name,
    version: runtimePackage.version,
    license: runtimePackage.license,
  };
  if (runtimePackage.dependencies) {
    packages[""].dependencies = runtimePackage.dependencies;
  }
  if (runtimePackage.bin) {
    packages[""].bin = runtimePackage.bin;
  }
  if (runtimePackage.overrides) {
    packages[""].overrides = runtimePackage.overrides;
  }

  return {
    name: runtimePackage.name,
    version: runtimePackage.version,
    lockfileVersion: sourceLock.lockfileVersion,
    requires: sourceLock.requires,
    packages,
  };
}

function assertPackageRoot() {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json was not found in ${packageRoot}`);
  }
  if (!fs.existsSync(packageLockPath)) {
    throw new Error(`package-lock.json was not found in ${packageRoot}`);
  }
  if (!fs.existsSync(path.join(packageRoot, "src", "index.ts"))) {
    throw new Error(`src/index.ts was not found in ${packageRoot}`);
  }
}

async function main() {
  assertPackageRoot();

  const requireFromPackage = createRequire(packageJsonPath);
  const esbuild = requireFromPackage("esbuild");
  const sourcePackage = readJson(packageJsonPath);
  const sourceLock = readJson(packageLockPath);
  const runtimePackage = buildRuntimePackageJson(sourcePackage);
  const runtimeLock = buildRuntimePackageLock(sourceLock, runtimePackage);

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(releaseRoot, { recursive: true });
  if (fs.existsSync(spatialSchemasSource)) {
    fs.cpSync(spatialSchemasSource, spatialSchemasRelease, { recursive: true });
  }

  await esbuild.build({
    entryPoints: [path.join(packageRoot, "src", "index.ts")],
    outfile: releaseBundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
  });

  writeJson(path.join(releaseRoot, "package.json"), runtimePackage);
  writeJson(path.join(releaseRoot, "package-lock.json"), runtimeLock);
  console.log(`release bundle written: ${releaseBundlePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
