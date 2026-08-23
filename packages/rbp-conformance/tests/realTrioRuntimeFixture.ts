import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueNorthCredentialControlPayload,
  type RealTrioNorthCredential,
} from "../src/realTrioCaseDriver.js";
import {
  publicGatewayControl,
  startRealTrioSupervisor,
  type RealTrioBinding,
  type RealTrioSupervisorResult,
} from "../src/realTrioSupervisor.js";
import { createEphemeralLoopbackTlsIdentity } from "../src/ephemeralTlsIdentity.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const node24 = process.execPath;
const npmCli = "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js";
const dotnet = "C:/Program Files/dotnet/dotnet.exe";

function run(executable: string, args: readonly string[]): void {
  execFileSync(executable, [...args], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: "pipe",
    timeout: 180_000,
  });
}

/**
 * The real-case suite intentionally compiles/publishes the three components
 * itself.  It must never borrow the old simulator production plan or a
 * sibling worktree's compiled output.
 */
export function buildRealTrioRuntimeFixture(): void {
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/protocol"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/addin-loopback-fixture"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/gateway"]);
  run(dotnet, [
    "publish",
    "packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/RevAgent.Bridge.RealWorkerHost.csproj",
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "false",
    "-p:UseAppHost=true",
  ]);
}

function requiredFile(relative: string): string {
  const candidate = path.resolve(repoRoot, relative);
  return candidate;
}

function credential(value: Record<string, unknown>): RealTrioNorthCredential {
  if (typeof value.bearer !== "string" || typeof value.audience !== "string" ||
      value.credentialProvenance !== "gateway_production_conformance" ||
      value.identityContract !== "revagent.auth-context/v1") {
    throw new Error("real trio north credential control response is malformed");
  }
  return Object.freeze({
    bearer: value.bearer,
    audience: value.audience,
    credentialProvenance: value.credentialProvenance,
    identityContract: value.identityContract,
  });
}

export interface RealTrioRuntimeFixture {
  readonly root: string;
  readonly binding: RealTrioBinding;
  readonly supervisor: RealTrioSupervisorResult;
  readonly credential: RealTrioNorthCredential;
  readonly endpoint: string;
  readonly certificateSha256: string;
  stop(): Promise<void>;
}

export const REAL_TRIO_FIXTURE_DOCUMENT_ID = "fixture-document-1" as const;

export function realTrioFixtureDocumentContextEvent(
  documentId = REAL_TRIO_FIXTURE_DOCUMENT_ID,
): Record<string, unknown> {
  return Object.freeze({
    capturedAtUtc: "2026-08-23T00:00:00.000Z",
    cacheState: "ready",
    unavailableReason: null,
    documents: [Object.freeze({
      documentId,
      title: "WP12 Fixture Document",
      pathDigest: null,
      isWorkshared: false,
      isActive: true,
    })],
    activeDocumentId: documentId,
    activeView: Object.freeze({
      documentId,
      id: "1001",
      name: "Fixture View",
      type: "FloorPlan",
      level: "Level 01",
    }),
    disciplineHint: "mechanical",
  });
}

export function hasRealTrioLiveDocumentRoute(
  snapshot: Record<string, unknown>,
  expectedDocumentId = REAL_TRIO_FIXTURE_DOCUMENT_ID,
): boolean {
  const sessions = snapshot.sessions;
  if (!Array.isArray(sessions) || sessions.length !== 1) return false;
  const row = sessions[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const value = (row as Record<string, unknown>).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lifecycle = (value as Record<string, unknown>).lifecycle;
  if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return false;
  const route = (lifecycle as Record<string, unknown>).liveDocumentRoute;
  return route !== null && typeof route === "object" && !Array.isArray(route) &&
    (route as Record<string, unknown>).sessionDocumentId === expectedDocumentId;
}

async function waitForLiveDocumentRoute(input: {
  readonly endpoint: string;
  readonly controlToken: string;
  readonly certificateSha256: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 35_000);
  for (;;) {
    const snapshot = await publicGatewayControl(
      input.endpoint,
      input.controlToken,
      input.certificateSha256,
      { action: "snapshot_audit" },
    );
    if (hasRealTrioLiveDocumentRoute(snapshot)) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio fixture document context did not produce a live Gateway route");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

export async function startRealTrioRuntimeFixture(
  binding: RealTrioBinding,
): Promise<RealTrioRuntimeFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-"));
  mkdirSync(path.join(root, "install"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  const tls = createEphemeralLoopbackTlsIdentity(root);
  const controlToken = `wp12-${path.basename(root)}`;
  const gatewayCli = requiredFile("packages/gateway/dist/productionConformanceHostCli.js");
  const fixtureCli = requiredFile("packages/addin-loopback-fixture/dist/cli.js");
  const worker = requiredFile("packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/bin/Release/net9.0/win-x64/publish/RevAgent.Bridge.RealWorkerHost.exe");
  const supervisor = await startRealTrioSupervisor({
    gateway: {
      executable: node24,
      args: [gatewayCli, "--root", path.join(root, "gateway"), "--certificate", tls.certificatePath, "--key", tls.privateKeyPath, "--control-token", controlToken, "--port", "0"],
      workingDirectory: repoRoot,
    },
    bridgeWorker: {
      executable: worker,
      args: [
        "--binding", binding,
        "--gateway-uri", "{{gateway_endpoint}}",
        "--addin-port", "{{fixture_port}}",
        "--fixture-pid", "{{fixture_pid}}",
        "--install-root", path.join(root, "install"),
        "--state-root", path.join(root, "state"),
        "--device-id", "{{device_id}}",
        "--device-token", "{{device_proof}}",
        "--fingerprint", `sha256:${"a".repeat(64)}`,
        "--certificate-sha256", "{{gateway_certificate_sha256}}",
      ],
      workingDirectory: repoRoot,
    },
    fixture: {
      executable: node24,
      args: [fixtureCli, "--host", "127.0.0.1", "--port", "0"],
      workingDirectory: repoRoot,
    },
    gatewayExpected: { component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1" },
    fixtureExpected: { contract: "addin-loopback/v1" },
    csharpPublishPath: worker,
    gatewayBuildPath: gatewayCli,
    fixtureBuildPath: fixtureCli,
    gatewayControlToken: controlToken,
  });
  const endpoint = supervisor.gatewayReadiness.endpoint;
  const certificateSha256 = supervisor.gatewayReadiness.tlsCertificateSha256;
  if (typeof endpoint !== "string" || typeof certificateSha256 !== "string") {
    await supervisor.stop();
    throw new Error("real trio Gateway readiness did not contain its loopback pin");
  }
  try {
    // This is the normal attested loopback fixture document-context event;
    // route authority is still earned only when the C# watcher forwards it
    // and the Gateway's public audit observes the live route.
    await supervisor.fixtureControl("apply_document_context", {
      event: realTrioFixtureDocumentContextEvent(),
    });
    await waitForLiveDocumentRoute({ endpoint, controlToken, certificateSha256 });
    const issued = await publicGatewayControl(
      endpoint,
      controlToken,
      certificateSha256,
      issueNorthCredentialControlPayload(),
    );
    return Object.freeze({
      root,
      binding,
      supervisor,
      credential: credential(issued),
      endpoint,
      certificateSha256,
      stop: async () => await supervisor.stop(),
    });
  } catch (error) {
    await supervisor.stop().catch(() => undefined);
    throw error;
  }
}
