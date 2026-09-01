import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * WP-12's non-production Gateway/trio boundary.  This is intentionally a
 * conformance-only descriptor: it names the concrete Gateway composition
 * surface, records only redacted adapter identities, and makes it impossible
 * for a report to call a stub or a pre-production composition "production".
 * It neither reads credentials nor performs a device revocation.
 */
export const PRODUCTION_TRIO_CONFORMANCE_CONTRACT =
  "revagent.production-trio-conformance/v1" as const;

export const PRODUCTION_TRIO_COMPONENTS = [
  "gateway_production_conformance",
  "bridge_worker",
  "addin_loopback_fixture",
] as const;

export type ProductionTrioComponent = (typeof PRODUCTION_TRIO_COMPONENTS)[number];

export interface ProductionTrioModuleHash {
  readonly modulePath: string;
  readonly sha256: `sha256:${string}`;
}

export interface ProductionTrioAdapterIdentity {
  readonly role: "credential" | "protocol_store" | "object_store" | "resource_authority";
  readonly implementation: string;
  readonly configurationRedacted: true;
  readonly durable: boolean;
}

export interface ProductionTrioRuntimeAttestation {
  readonly contractVersion: typeof PRODUCTION_TRIO_CONFORMANCE_CONTRACT;
  readonly environment: "conformance_nonproduction";
  readonly gatewayHost: "productionGatewayHost";
  readonly components: readonly ProductionTrioComponent[];
  readonly bindings: readonly ["wss", "streamable_http_sse"];
  readonly gatewayImports: readonly ProductionTrioModuleHash[];
  readonly adapters: readonly ProductionTrioAdapterIdentity[];
  readonly listener: {
    readonly host: "127.0.0.1";
    readonly pid: number;
    readonly tlsCertificateSha256: `sha256:${string}`;
  };
  readonly evidenceLabels: readonly ["conformance", "non-production"];
}

const REQUIRED_GATEWAY_IMPORTS = [
  "packages/gateway/src/bridgeSession.ts",
  "packages/gateway/src/rbpIngress.ts",
  "packages/gateway/src/server.ts",
] as const;

const FORBIDDEN_GATEWAY_IMPORT_TEXT = [
  "gateway-stub",
  "gateway_stub",
  "preProduction",
  "preproduction",
] as const;

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function confinedSourceFile(repoRootValue: string, relativePath: string): string {
  const root = realpathSync(repoRootValue);
  const lexical = path.resolve(root, relativePath);
  if (!existsSync(lexical) || lstatSync(lexical).isSymbolicLink()) {
    throw new Error(`production trio module is missing or linked: ${relativePath}`);
  }
  const resolved = realpathSync(lexical);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(resolved).isFile()) {
    throw new Error(`production trio module escapes repository: ${relativePath}`);
  }
  return resolved;
}

/**
 * Records the exact production Gateway modules which must be imported by the
 * host.  The negative scan is deliberately narrow: it only guards the host
 * source supplied here, rather than attempting to claim that the whole
 * repository has no fixture code.
 */
export function attestProductionGatewayModuleGraph(input: {
  readonly repoRoot: string;
  readonly hostSource: string;
}): readonly ProductionTrioModuleHash[] {
  const host = confinedSourceFile(input.repoRoot, input.hostSource);
  const hostText = readFileSync(host, "utf8");
  for (const forbidden of FORBIDDEN_GATEWAY_IMPORT_TEXT) {
    if (hostText.includes(forbidden)) {
      throw new Error(`productionGatewayHost imports forbidden ${forbidden} surface`);
    }
  }
  const moduleHashes = REQUIRED_GATEWAY_IMPORTS.map((modulePath) => {
    const file = confinedSourceFile(input.repoRoot, modulePath);
    return Object.freeze({ modulePath, sha256: sha256(readFileSync(file)) });
  });
  for (const required of [
    "GatewayBridgeSessionAuthority",
    "createProductionRbpIngressHost",
    "startGatewayServer",
  ]) {
    if (!hostText.includes(required)) {
      throw new Error(`productionGatewayHost does not import ${required}`);
    }
  }
  return Object.freeze(moduleHashes);
}

function exactStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((entry) => actual.includes(entry));
}

/** Validates redacted launch evidence before it can be sealed with C28/C29/C38/C39 results. */
export function validateProductionTrioRuntimeAttestation(
  value: ProductionTrioRuntimeAttestation,
): void {
  if (
    value.contractVersion !== PRODUCTION_TRIO_CONFORMANCE_CONTRACT ||
    value.environment !== "conformance_nonproduction" ||
    value.gatewayHost !== "productionGatewayHost" ||
    !exactStrings(value.components, PRODUCTION_TRIO_COMPONENTS) ||
    value.bindings.length !== 2 || value.bindings[0] !== "wss" ||
    value.bindings[1] !== "streamable_http_sse" ||
    value.listener.host !== "127.0.0.1" ||
    !Number.isSafeInteger(value.listener.pid) || value.listener.pid <= 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.listener.tlsCertificateSha256) ||
    !exactStrings(value.evidenceLabels, ["conformance", "non-production"])
  ) {
    throw new Error("production trio runtime attestation is malformed or not non-production loopback evidence");
  }
  if (
    value.gatewayImports.length !== REQUIRED_GATEWAY_IMPORTS.length ||
    !exactStrings(value.gatewayImports.map(({ modulePath }) => modulePath), REQUIRED_GATEWAY_IMPORTS) ||
    value.gatewayImports.some(({ sha256: digest }) => !/^sha256:[0-9a-f]{64}$/u.test(digest))
  ) {
    throw new Error("production trio runtime attestation does not pin the exact Gateway import graph");
  }
  const roles = ["credential", "protocol_store", "object_store", "resource_authority"] as const;
  if (
    value.adapters.length !== roles.length ||
    !exactStrings(value.adapters.map(({ role }) => role), roles) ||
    value.adapters.some((adapter) =>
      adapter.implementation.length === 0 || !adapter.configurationRedacted ||
      (adapter.role !== "credential" && !adapter.durable))
  ) {
    throw new Error("production trio runtime attestation has incomplete or unredacted adapters");
  }
}
