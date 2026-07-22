import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { startGatewayStub } from "./server.js";
import type { GatewayClock, StaticTokenTable } from "./types.js";

interface CliOptions {
  statePath: string;
  host: string;
  port: number;
  controlToken: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  supportedProtocols?: number[];
  connectionCapabilities?: string[];
  sessionCapabilities?: string[];
  clockStartMs?: number;
}

const CLI_ARGUMENTS = new Set([
  "--state",
  "--host",
  "--port",
  "--control-token",
  "--tls-cert",
  "--tls-key",
  "--supported-protocols",
  "--connection-capabilities",
  "--session-capabilities",
  "--clock-start-ms",
]);

function parseList(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "") || new Set(entries).size !== entries.length) {
    throw new Error(`${label} must be a comma-separated list of unique non-empty values`);
  }
  return entries;
}

class CliClock implements GatewayClock {
  constructor(private value: number) {}

  nowMs(): number {
    return this.value;
  }

  setNowMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("clock time must be a non-negative safe integer");
    }
    this.value = value;
  }
}

function parseArguments(arguments_: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("arguments must be --name value pairs");
    }
    if (!CLI_ARGUMENTS.has(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    values.set(key, value);
  }
  const statePath = values.get("--state");
  if (statePath === undefined) {
    throw new Error("--state <path> is required");
  }
  const port = Number(values.get("--port") ?? "0");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 through 65535");
  }
  const tlsCertPath = values.get("--tls-cert");
  const tlsKeyPath = values.get("--tls-key");
  if ((tlsCertPath === undefined) !== (tlsKeyPath === undefined)) {
    throw new Error("--tls-cert and --tls-key must be supplied together");
  }
  const rawProtocols = parseList(values.get("--supported-protocols"), "--supported-protocols");
  const supportedProtocols = rawProtocols?.map((entry) => Number(entry));
  if (supportedProtocols?.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    throw new Error("--supported-protocols values must be positive safe integers");
  }
  const clockText = values.get("--clock-start-ms");
  const clockStartMs = clockText === undefined ? undefined : Number(clockText);
  if (clockStartMs !== undefined && (!Number.isSafeInteger(clockStartMs) || clockStartMs < 0)) {
    throw new Error("--clock-start-ms must be a non-negative safe integer");
  }
  return {
    statePath: resolve(statePath),
    host: values.get("--host") ?? "127.0.0.1",
    port,
    controlToken: values.get("--control-token") ?? "rbp-test-control",
    tlsCertPath,
    tlsKeyPath,
    supportedProtocols,
    connectionCapabilities: parseList(values.get("--connection-capabilities"), "--connection-capabilities"),
    sessionCapabilities: parseList(values.get("--session-capabilities"), "--session-capabilities"),
    clockStartMs,
  };
}

const tokenTable: StaticTokenTable = {
  "test-device-token": {
    status: "active",
    deviceId: "device-01",
    tenantId: "tenant-01",
    userId: "user-01",
    seatId: "seat-01",
    machineFingerprint: `sha256:${"0".repeat(64)}`,
    provisionedCapabilities: [
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ],
  },
  "revoked-device-token": {
    status: "revoked",
    deviceId: "device-revoked",
    tenantId: "tenant-01",
    userId: "user-revoked",
    seatId: "seat-revoked",
    machineFingerprint: `sha256:${"1".repeat(64)}`,
    provisionedCapabilities: [],
  },
  "seat-denied-device-token": {
    status: "seat_denied",
    deviceId: "device-seat-denied",
    tenantId: "tenant-01",
    userId: "user-seat-denied",
    seatId: "seat-denied",
    machineFingerprint: `sha256:${"2".repeat(64)}`,
    provisionedCapabilities: [],
  },
};

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const tls = options.tlsCertPath === undefined
    ? undefined
    : {
        cert: await readFile(options.tlsCertPath),
        key: await readFile(options.tlsKeyPath!),
      };
  const clock = options.clockStartMs === undefined ? undefined : new CliClock(options.clockStartMs);
  const handle = await startGatewayStub({
    statePath: options.statePath,
    tokenTable,
    host: options.host,
    port: options.port,
    controlToken: options.controlToken,
    tls,
    supportedProtocols: options.supportedProtocols,
    connectionCapabilities: options.connectionCapabilities,
    sessionCapabilities: options.sessionCapabilities,
    clock,
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await handle.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.stdout.write(`${JSON.stringify({
    event: "ready",
    component: "@revagent/gateway-stub",
    component_version: "0.0.0",
    control_contract_version: 1,
    protocol_versions: handle.core.supportedProtocols,
    control_auth_header: "X-RBP-Test-Control",
    shutdown_signals: ["SIGINT", "SIGTERM"],
    deterministic_clock: clock !== undefined,
    pid: process.pid,
    state_path: options.statePath,
    ws_url: handle.wsUrl,
    http_connection_url: handle.httpConnectionUrl,
    control_url: handle.controlUrl,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    event: "fatal",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
