import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * WP-12 deliberately keeps this descriptor separate from the O1 production
 * simulator plan.  A simulator process is useful for deterministic protocol
 * vectors, but it is not evidence that the published Bridge worker can run
 * against the TypeScript Gateway.
 */
export const REAL_TRIO_COMPONENT_IDS = [
  "gateway",
  "bridge_worker",
  "addin_loopback_fixture",
] as const;

export type RealTrioComponentId = (typeof REAL_TRIO_COMPONENT_IDS)[number];

export interface RealTrioProcessIdentity {
  readonly componentId: RealTrioComponentId;
  readonly executablePath: string;
  readonly executableSha256: `sha256:${string}`;
  readonly pid: number;
  readonly exitCode: number;
  readonly stdoutSha256: `sha256:${string}`;
  readonly stderrSha256: `sha256:${string}`;
}

export interface RealTrioAttestation {
  readonly schemaVersion: "rbp-real-trio-attestation/v1";
  readonly bindings: readonly ["wss", "streamable_http_sse"];
  readonly components: readonly RealTrioProcessIdentity[];
  readonly csharpPublishSha256: `sha256:${string}`;
  readonly gatewayBuildSha256: `sha256:${string}`;
  readonly fixtureBuildSha256: `sha256:${string}`;
}

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function confinedRealFile(repoRootValue: string, candidate: string, label: string): string {
  const repoRoot = realpathSync(repoRootValue);
  const lexical = path.resolve(repoRoot, candidate);
  if (!existsSync(lexical) || lstatSync(lexical).isSymbolicLink()) {
    throw new Error(`${label} is missing or linked`);
  }
  const resolved = realpathSync(lexical);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(resolved).isFile()) {
    throw new Error(`${label} escapes the repository`);
  }
  return resolved;
}

export function sha256RealTrioFile(
  repoRoot: string,
  candidate: string,
  label: string,
): `sha256:${string}` {
  return sha256(readFileSync(confinedRealFile(repoRoot, candidate, label)));
}

/**
 * A conformance publisher supplies the precise publish output path; it must
 * be the actual C# worker, never a Node shim or bridge-simulator substitute.
 */
export function assertRealBridgeWorkerExecutable(
  executablePath: string,
): string {
  if (!path.isAbsolute(executablePath)) {
    throw new Error("real Bridge worker executable path must be absolute");
  }
  if (!existsSync(executablePath) || lstatSync(executablePath).isSymbolicLink()) {
    throw new Error("real Bridge worker executable is missing or linked");
  }
  const normalized = realpathSync(executablePath);
  const base = path.basename(normalized).toLowerCase();
  if (
    base !== "revagent-bridge.exe" && base !== "revagent-bridge" &&
    base !== "revagent.bridge.realworkerhost.exe" && base !== "revagent.bridge.realworkerhost"
  ) {
    throw new Error("real Bridge worker executable identity is invalid");
  }
  if (!statSync(normalized).isFile()) {
    throw new Error("real Bridge worker executable is not a regular file");
  }
  return normalized;
}

export function validateRealTrioAttestation(value: RealTrioAttestation): void {
  if (value.schemaVersion !== "rbp-real-trio-attestation/v1") {
    throw new Error("real trio attestation schema is invalid");
  }
  if (
    value.bindings.length !== 2 ||
    value.bindings[0] !== "wss" ||
    value.bindings[1] !== "streamable_http_sse"
  ) {
    throw new Error("real trio attestation must cover WSS and Streamable HTTP/SSE");
  }
  if (value.components.length !== REAL_TRIO_COMPONENT_IDS.length) {
    throw new Error("real trio attestation component count is invalid");
  }
  const observed = new Set(value.components.map(({ componentId }) => componentId));
  for (const componentId of REAL_TRIO_COMPONENT_IDS) {
    if (!observed.has(componentId)) {
      throw new Error(`real trio attestation is missing ${componentId}`);
    }
  }
  for (const component of value.components) {
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(component.executableSha256) ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.stdoutSha256) ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.stderrSha256) ||
      !Number.isSafeInteger(component.pid) || component.pid <= 0 || component.exitCode !== 0
    ) {
      throw new Error(`real trio ${component.componentId} process evidence is invalid`);
    }
    if (component.componentId === "bridge_worker") {
      assertRealBridgeWorkerExecutable(component.executablePath);
    }
  }
  for (const digest of [
    value.csharpPublishSha256,
    value.gatewayBuildSha256,
    value.fixtureBuildSha256,
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("real trio attestation build digest is invalid");
    }
  }
}
