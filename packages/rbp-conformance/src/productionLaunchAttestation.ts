import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ProductionLaunchRole = "prepare-wrapper" | "cli-bootstrap";

interface SharedAttestationModule {
  assertTrustedProductionLaunch(input: {
    repoRoot: string;
    role: ProductionLaunchRole;
  }): void;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function packageRootForCurrentModule(): string {
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  if (
    !existsSync(modulePath) ||
    !lstatSync(modulePath).isFile() ||
    lstatSync(modulePath).isSymbolicLink() ||
    !samePath(realpathSync(modulePath), modulePath)
  ) {
    throw new Error("production launch attestation must be a physical module");
  }
  const moduleDirectory = path.dirname(modulePath);
  let packageRoot: string;
  if (
    path.basename(modulePath) === "productionLaunchAttestation.ts" &&
    path.basename(moduleDirectory) === "src"
  ) {
    packageRoot = path.dirname(moduleDirectory);
  } else if (
    path.basename(modulePath) === "productionLaunchAttestation.js" &&
    path.basename(moduleDirectory) === "src" &&
    path.basename(path.dirname(moduleDirectory)) === "dist"
  ) {
    packageRoot = path.dirname(path.dirname(moduleDirectory));
  } else {
    throw new Error(
      "production launch attestation is outside its fixed source or dist layout",
    );
  }

  const packageFile = path.join(packageRoot, "package.json");
  if (
    !existsSync(packageFile) ||
    !lstatSync(packageFile).isFile() ||
    lstatSync(packageFile).isSymbolicLink() ||
    !samePath(realpathSync(packageFile), packageFile)
  ) {
    throw new Error("rbp-conformance package manifest is not a physical file");
  }
  const value = JSON.parse(readFileSync(packageFile, "utf8")) as {
    name?: unknown;
  };
  if (value.name !== "@revagent/rbp-conformance") {
    throw new Error("rbp-conformance package manifest identity is invalid");
  }
  return packageRoot;
}

const sharedAttestation = await import(
  pathToFileURL(
    path.join(
      packageRootForCurrentModule(),
      "scripts",
      "production-launch-attestation.mjs",
    ),
  ).href
) as SharedAttestationModule;

export function assertTrustedProductionLaunch(
  repoRoot: string,
  role: ProductionLaunchRole,
): void {
  sharedAttestation.assertTrustedProductionLaunch({ repoRoot, role });
}
