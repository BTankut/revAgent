import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  StrictJsonlProcess,
  StrictReadyProcess,
  type JsonObject,
  type JsonValue,
} from "./processHarness.js";
import type { ProcessCommandDescriptor } from "./types.js";
import {
  assertRealBridgeWorkerExecutable,
  validateRealTrioAttestation,
  type RealTrioAttestation,
  type RealTrioProcessIdentity,
} from "./realTrioAttestation.js";
import { stableJson } from "./stableJson.js";

export const REAL_TRIO_SUPERVISOR_SCHEMA = "rbp-real-trio-supervisor/v1" as const;

export interface RealTrioSupervisorCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
}

export interface RealTrioSupervisorLaunch {
  readonly gateway: RealTrioSupervisorCommand;
  readonly bridgeWorker: RealTrioSupervisorCommand;
  readonly fixture: RealTrioSupervisorCommand;
  readonly gatewayExpected: Readonly<Record<string, JsonValue>>;
  readonly fixtureExpected: Readonly<Record<string, JsonValue>>;
  readonly csharpPublishPath: string;
  readonly gatewayBuildPath: string;
  readonly fixtureBuildPath: string;
  /** Out-of-band test secret used only on the Gateway's public loopback control route. */
  readonly gatewayControlToken: string;
}

export interface RealTrioSupervisorResult {
  readonly schemaVersion: typeof REAL_TRIO_SUPERVISOR_SCHEMA;
  readonly attestation: RealTrioAttestation;
  readonly gatewayReadiness: JsonObject;
  readonly bridgeReadiness: JsonObject;
  readonly fixtureReadiness: JsonObject;
  readonly stop: () => Promise<void>;
}

function sha256File(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function command(input: RealTrioSupervisorCommand): ProcessCommandDescriptor {
  return {
    executable: input.executable,
    args: [...input.args],
    workingDirectory: input.workingDirectory,
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 30_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 10_000 },
  };
}

function replaceTokens(input: RealTrioSupervisorCommand, values: Readonly<Record<string, string>>): RealTrioSupervisorCommand {
  const replace = (value: string): string => Object.entries(values).reduce((current, [token, replacement]) => current.replaceAll(`{{${token}}}`, replacement), value);
  return { executable: replace(input.executable), args: input.args.map(replace), workingDirectory: replace(input.workingDirectory) };
}

async function publicGatewayControl(
  endpoint: string,
  controlToken: string,
  expectedCertificateSha256: string,
  action: "issue_device_credential" | "snapshot_audit",
): Promise<JsonObject> {
  const url = new URL("/__conformance/v1/control", endpoint);
  const payload = Buffer.from(JSON.stringify({ action }), "utf8");
  return await new Promise<JsonObject>((resolve, reject) => {
    const operation = httpsRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json", "content-length": payload.byteLength, "x-rbp-test-control": controlToken } }, (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate(true).raw as Buffer | undefined;
      const observed = peer === undefined ? null : `sha256:${createHash("sha256").update(peer).digest("hex")}`;
      if (observed !== expectedCertificateSha256) { response.resume(); reject(new Error("Gateway control TLS pin mismatch")); return; }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
          if (response.statusCode !== 200 || body.ok !== true || body.action !== action) throw new Error("Gateway public control refused request");
          resolve(body);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.once("error", reject);
    operation.end(payload);
  });
}

function transcriptHash(process: StrictJsonlProcess | StrictReadyProcess, stream: "stdout" | "stderr"): `sha256:${string}` {
  const records = process.transcript.filter((record) => record.stream === stream);
  return `sha256:${createHash("sha256").update(stableJson(records)).digest("hex")}`;
}

function processIdentity(
  componentId: RealTrioProcessIdentity["componentId"],
  executablePath: string,
  process: StrictJsonlProcess | StrictReadyProcess,
): RealTrioProcessIdentity {
  if (process.process.exitCode !== 0) {
    throw new Error(`real trio ${componentId} is not cleanly stopped`);
  }
  return Object.freeze({
    componentId,
    executablePath,
    executableSha256: sha256File(executablePath),
    pid: process.pid,
    exitCode: process.process.exitCode,
    stdoutSha256: transcriptHash(process, "stdout"),
    stderrSha256: transcriptHash(process, "stderr"),
  });
}

/**
 * Supervises only actual processes. It has no response simulator and cannot
 * manufacture a case outcome: WSS/HTTP-SSE callers must use the public
 * binding drivers against the Gateway endpoint advertised by the child.
 */
export async function startRealTrioSupervisor(input: RealTrioSupervisorLaunch): Promise<RealTrioSupervisorResult> {
  const bridgeExecutable = assertRealBridgeWorkerExecutable(input.bridgeWorker.executable);
  const gateway = await StrictReadyProcess.start({
    componentId: "gateway_stub",
    command: command(input.gateway),
    absoluteWorkingDirectory: input.gateway.workingDirectory,
    useTestSignalProxy: true,
    validateReadiness(value) {
      for (const [key, expected] of Object.entries(input.gatewayExpected)) {
        if (JSON.stringify(value[key]) !== JSON.stringify(expected)) throw new Error(`Gateway readiness ${key} is not exact`);
      }
      if (value.component !== "gateway_production_conformance" || typeof value.endpoint !== "string" || !value.endpoint.startsWith("https://127.0.0.1:")) throw new Error("real trio Gateway readiness is not a loopback production composition");
    },
  });
  try {
    const endpoint = gateway.readiness.endpoint;
    const certificateSha256 = gateway.readiness.tlsCertificateSha256;
    if (typeof endpoint !== "string" || typeof certificateSha256 !== "string") throw new Error("Gateway readiness lacks endpoint pin");
    try {
      const fixture = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command(input.fixture),
        absoluteWorkingDirectory: input.fixture.workingDirectory,
        expectedReadinessFields: input.fixtureExpected,
        requiredActions: ["snapshot_evidence", "shutdown"],
      });
      try {
        const fixturePort = fixture.readiness.port;
        if (!Number.isSafeInteger(fixturePort) || Number(fixturePort) < 1) throw new Error("fixture readiness lacks a loopback port");
        const credential = await publicGatewayControl(endpoint, input.gatewayControlToken, certificateSha256, "issue_device_credential");
        if (typeof credential.deviceId !== "string" || typeof credential.deviceProof !== "string") throw new Error("Gateway public control did not issue a bridge credential");
        const bridge = await StrictJsonlProcess.start({
          componentId: "bridge_simulator",
          command: command(replaceTokens({ ...input.bridgeWorker, executable: bridgeExecutable }, {
            gateway_endpoint: endpoint.replace("127.0.0.1", "localhost"),
            gateway_certificate_sha256: certificateSha256.replace("sha256:", ""),
            fixture_port: String(fixturePort),
            device_id: credential.deviceId,
            device_proof: credential.deviceProof,
          })),
          absoluteWorkingDirectory: input.bridgeWorker.workingDirectory,
          expectedReadinessFields: { component: "bridge_worker", contract: "wp12-real-worker-host/v1" },
          requiredActions: ["shutdown"],
        });
        let stopped = false;
        const stop = async (): Promise<void> => {
          if (stopped) return;
          stopped = true;
          const bridgeStop = await bridge.stop();
          const fixtureStop = await fixture.stop();
          const gatewayStop = await gateway.stop();
          if (fixtureStop.exitCode !== 0 || bridgeStop.exitCode !== 0 || gatewayStop.exitCode !== 0 || fixtureStop.killEscalated || bridgeStop.killEscalated || gatewayStop.killEscalated) throw new Error("real trio did not close cleanly");
        };
        return Object.freeze({
        schemaVersion: REAL_TRIO_SUPERVISOR_SCHEMA,
        get attestation(): RealTrioAttestation {
          if (!stopped) throw new Error("real trio attestation is unavailable before exact clean STOP");
          const value: RealTrioAttestation = {
            schemaVersion: "rbp-real-trio-attestation/v1", bindings: ["wss", "streamable_http_sse"],
            components: [processIdentity("gateway", input.gateway.executable, gateway), processIdentity("bridge_worker", bridgeExecutable, bridge), processIdentity("addin_loopback_fixture", input.fixture.executable, fixture)],
            csharpPublishSha256: sha256File(input.csharpPublishPath), gatewayBuildSha256: sha256File(input.gatewayBuildPath), fixtureBuildSha256: sha256File(input.fixtureBuildPath),
          };
          validateRealTrioAttestation(value);
          return value;
        },
        gatewayReadiness: gateway.readiness,
        bridgeReadiness: bridge.readiness,
        fixtureReadiness: fixture.readiness,
        stop,
        });
      } catch (error) { await fixture.stop(); throw error; }
    } catch (error) { throw error; }
  } catch (error) { await gateway.stop(); throw error; }
}
