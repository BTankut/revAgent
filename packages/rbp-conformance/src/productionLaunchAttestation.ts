import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ProductionLaunchRole = "prepare-wrapper" | "cli-bootstrap";

interface SharedAttestationModule {
  assertTrustedProductionLaunch(input: {
    repoRoot: string;
    role: ProductionLaunchRole;
  }): void;
}

function packageRootForCurrentModule(): string {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const packageFile = path.join(candidate, "package.json");
    if (existsSync(packageFile)) {
      const value = JSON.parse(readFileSync(packageFile, "utf8")) as {
        name?: unknown;
      };
      if (value.name === "@revagent/rbp-conformance") return candidate;
    }
    candidate = path.dirname(candidate);
  }
  throw new Error("cannot resolve the rbp-conformance package root");
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
