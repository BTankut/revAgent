import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import { sha256File } from "./executionPlan.js";
import {
  createEphemeralLoopbackTlsIdentity,
  type EphemeralTlsIdentity,
} from "./ephemeralTlsIdentity.js";
import {
  StrictJsonlProcess,
  StrictReadyProcess,
  type JsonObject,
  type JsonValue,
} from "./processHarness.js";
import type {
  Binding,
  ComponentId,
  ComponentIdentity,
  ExecutionPlan,
  PlannedComponent,
  ProcessCommandDescriptor,
  ProcessEvidence,
  ProcessObservationRecord,
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_SNAPSHOT_PAGES = 64;
const MAX_AGGREGATED_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_COMPACT_GATEWAY_SNAPSHOT_BYTES = 60 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface GatewayStartupOverrides {
  sessionCapabilities?: readonly string[];
  connectionCapabilities?: readonly string[];
  supportedProtocols?: readonly number[];
  clockStartMs?: number;
}

export interface RestartCaseStackOptions {
  caseId: string;
  binding: Binding;
  preserveState: boolean;
  startupOverrides?: GatewayStartupOverrides;
}

export interface ParentCaptureSummary {
  proxy: "gateway" | "fixture";
  target: { host: string; port: number };
  listening: { host: string; port: number };
  clientToTarget: {
    chunks: number;
    bytes: number;
    sha256: string;
  };
  targetToClient: {
    chunks: number;
    bytes: number;
    sha256: string;
  };
  acceptedConnections: number;
  activeConnections: number;
  startedAtMonotonicMs: number;
  finishedAtMonotonicMs: number;
}

export interface StartedStackComponent {
  componentId: ComponentId;
  identity: ComponentIdentity;
  pid: number;
  process: ProcessEvidence;
  readiness: JsonObject;
  jsonl?: StrictJsonlProcess;
  stop(): Promise<{ killEscalated: boolean }>;
}

export class GatewayControlRequestError extends Error {
  readonly status: number;
  readonly response: JsonObject;

  constructor(action: string, status: number, response: JsonObject) {
    super(`Gateway control ${action} returned HTTP ${status}`);
    this.name = "GatewayControlRequestError";
    this.status = status;
    this.response = structuredClone(response);
  }
}

interface CaptureCounters {
  chunks: number;
  bytes: number;
  hash: ReturnType<typeof createHash>;
}

function counters(): CaptureCounters {
  return { chunks: 0, bytes: 0, hash: createHash("sha256") };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${label} is not a valid TCP port`);
  }
  return Number(value);
}

function selectedObjectFields(
  value: unknown,
  fields: readonly string[],
): JsonObject | null {
  if (!isObject(value)) return null;
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => [field, structuredClone(value[field]!)]),
  );
}

function compactTerminalPayload(value: unknown): JsonObject | null {
  return selectedObjectFields(value, [
    "invocation_id",
    "batch_id",
    "status",
    "fault_class",
    "outcome",
    "verification_required",
    "replayed",
    "late_after_indeterminate",
    "payload_omitted",
    "result_digest",
    "guarded_reason",
    "failed_step_index",
    "error",
    "steps",
  ]);
}

function compactGatewaySnapshotValue(snapshot: JsonObject): JsonObject {
  const sessions = isObject(snapshot.sessions) ? snapshot.sessions : {};
  const compactSessions: JsonObject = {};
  for (const [rsid, rawSession] of Object.entries(sessions)) {
    if (!isObject(rawSession)) continue;
    const terminalOutcomes = isObject(rawSession.terminalOutcomes)
      ? Object.fromEntries(
          Object.entries(rawSession.terminalOutcomes)
            .filter(([, outcome]) => isObject(outcome))
            .map(([correlationId, rawOutcome]) => {
              const outcome = rawOutcome as JsonObject;
              const envelope = isObject(outcome.envelope)
                ? {
                    ...(selectedObjectFields(outcome.envelope, [
                      "v",
                      "type",
                      "id",
                      "ts",
                      "rsid",
                      "seq",
                      "ack",
                    ]) ?? {}),
                    payload: compactTerminalPayload(outcome.envelope.payload),
                  }
                : null;
              return [correlationId, {
                correlationId: outcome.correlationId ?? correlationId,
                classification: outcome.classification ?? null,
                acceptedAtMs: outcome.acceptedAtMs ?? null,
                envelope,
              }];
            }),
        )
      : {};
    const artifacts = isObject(rawSession.artifacts)
      ? Object.fromEntries(
          Object.entries(rawSession.artifacts).map(([invocationId, entries]) => [
            invocationId,
            Array.isArray(entries)
              ? entries
                  .filter(isObject)
                  .map((entry) => selectedObjectFields(entry, [
                    "artifactId",
                    "artifactIndex",
                    "streamId",
                    "filename",
                    "contentType",
                    "totalChunks",
                    "totalSize",
                    "sha256",
                  ]))
              : [],
          ]),
        )
      : {};
    const chunkedResults = isObject(rawSession.chunkedResults)
      ? Object.fromEntries(
          Object.entries(rawSession.chunkedResults).map(([invocationId, entry]) => [
            invocationId,
            selectedObjectFields(entry, [
              "streamId",
              "contentType",
              "totalChunks",
              "totalSize",
              "sha256",
            ]),
          ]),
        )
      : {};
    compactSessions[rsid] = {
      ...(selectedObjectFields(rawSession, [
        "rsid",
        "deviceId",
        "tenantId",
        "userId",
        "seatId",
        "localSessionKey",
        "grantedSessionCapabilities",
        "lifecycle",
        "sequence",
        "dispatchWindow",
        "inFlight",
        "lastHeartbeatAtMs",
        "disconnectedAtMs",
        "liveness",
      ]) ?? {}),
      terminalOutcomes,
      artifacts,
      chunkedResults,
    };
  }
  return {
    schemaVersion: "rbp-gateway-compact-snapshot/v1",
    sourceSchemaVersion: snapshot.schemaVersion ?? null,
    sessions: compactSessions,
    mutationHolds: structuredClone(snapshot.mutationHolds ?? null),
    runtime: structuredClone(snapshot.runtime ?? null),
  };
}

function numericLoopback(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOOPBACK_HOSTS.has(value)) {
    throw new Error(`${label} must be numeric loopback`);
  }
  return value;
}

function replaceTokens(value: string, tokens: Readonly<Record<string, string>>): string {
  const expanded = Object.entries(tokens).reduce(
    (result, [name, replacement]) => result.replaceAll(`{{${name}}}`, replacement),
    value,
  );
  if (/\{\{[^{}]+\}\}/u.test(expanded)) {
    throw new Error(`component command contains an unresolved execution token: ${expanded}`);
  }
  return expanded;
}

function expandedCommand(
  command: ProcessCommandDescriptor,
  tokens: Readonly<Record<string, string>>,
): ProcessCommandDescriptor {
  return {
    ...command,
    executable: replaceTokens(command.executable, tokens),
    args: command.args.map((entry) => replaceTokens(entry, tokens)),
    workingDirectory: replaceTokens(command.workingDirectory, tokens),
    environmentKeys: [...command.environmentKeys],
    readiness: {
      ...command.readiness,
      value: replaceTokens(command.readiness.value, tokens),
    },
    shutdown: { ...command.shutdown },
  };
}

function confinedWorkingDirectory(repoRoot: string, command: ProcessCommandDescriptor): string {
  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, command.workingDirectory);
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new Error(`component working directory is missing: ${command.workingDirectory}`);
  }
  const realCandidate = realpathSync(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`component working directory escapes the source repository: ${command.workingDirectory}`);
  }
  return realCandidate;
}

function entrypointPath(command: ProcessCommandDescriptor, cwd: string): string {
  const argument = command.args.find((entry) => {
    const candidate = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    return existsSync(candidate) && lstatSync(candidate).isFile();
  });
  if (argument !== undefined) return path.isAbsolute(argument) ? argument : path.resolve(cwd, argument);
  const executable = path.isAbsolute(command.executable)
    ? command.executable
    : path.resolve(cwd, command.executable);
  if (existsSync(executable) && lstatSync(executable).isFile()) return executable;
  throw new Error("component command does not expose a hash-verifiable executable entrypoint");
}

function observedIdentity(
  component: PlannedComponent,
  command: ProcessCommandDescriptor,
  cwd: string,
): ComponentIdentity {
  const executableSha256 = sha256File(entrypointPath(command, cwd));
  if (executableSha256 !== component.expectedIdentity.executableSha256) {
    throw new Error(`${component.id} executable digest does not match the execution plan`);
  }
  return { ...component.expectedIdentity };
}

function setCliListArgument(
  args: readonly string[],
  flag: string,
  values: readonly string[] | readonly number[] | undefined,
): string[] {
  if (values === undefined) return [...args];
  const next = [...args];
  const index = next.indexOf(flag);
  const serialized = values.join(",");
  if (index >= 0) {
    if (index + 1 >= next.length) throw new Error(`${flag} lacks its execution-plan value`);
    next[index + 1] = serialized;
  } else {
    next.push(flag, serialized);
  }
  return next;
}

function setCliScalarArgument(
  args: readonly string[],
  flag: string,
  value: string | number | undefined,
): string[] {
  if (value === undefined) return [...args];
  const next = [...args];
  const index = next.indexOf(flag);
  const serialized = String(value);
  if (index >= 0) {
    if (index + 1 >= next.length) throw new Error(`${flag} lacks its execution-plan value`);
    next[index + 1] = serialized;
  } else {
    next.push(flag, serialized);
  }
  return next;
}

function withGatewayOverrides(
  command: ProcessCommandDescriptor,
  overrides: GatewayStartupOverrides | undefined,
  tlsIdentity: EphemeralTlsIdentity | undefined,
): ProcessCommandDescriptor {
  let args = setCliListArgument(command.args, "--session-capabilities", overrides?.sessionCapabilities);
  args = setCliListArgument(args, "--connection-capabilities", overrides?.connectionCapabilities);
  args = setCliListArgument(args, "--supported-protocols", overrides?.supportedProtocols);
  args = setCliScalarArgument(args, "--clock-start-ms", overrides?.clockStartMs);
  if (tlsIdentity !== undefined) {
    if (args.includes("--tls-cert") || args.includes("--tls-key")) {
      throw new Error("execution plan must not pre-provision persistent Gateway TLS material");
    }
    args.push(
      "--tls-cert",
      tlsIdentity.certificatePath,
      "--tls-key",
      tlsIdentity.privateKeyPath,
    );
  }
  return { ...command, args };
}

function parseLoopbackUrl(value: unknown, label: string): URL {
  if (typeof value !== "string") throw new Error(`${label} is not a URL string`);
  const parsed = new URL(value);
  numericLoopback(parsed.hostname, `${label} host`);
  safePort(parsed.port === "" ? undefined : Number(parsed.port), `${label} port`);
  return parsed;
}

function proxyUrl(original: string, listeningPort: number): string {
  const parsed = new URL(original);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(listeningPort);
  return parsed.toString();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function postHttpsControl(
  controlUrl: string,
  body: Buffer,
  identity: EphemeralTlsIdentity,
): Promise<{ status: number; bytes: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(controlUrl, {
      method: "POST",
      ca: readFileSync(identity.caCertificatePath),
      rejectUnauthorized: true,
      checkServerIdentity(host: string, certificate: PeerCertificate): Error | undefined {
        const identityError = checkServerIdentity(host, certificate);
        if (identityError !== undefined) return identityError;
        const digest = `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`;
        if (digest === identity.serverCertificateSha256) return undefined;
        return new Error("Gateway control leaf certificate does not match the supervised stack");
      },
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-rbp-test-control": "rbp-test-control",
      },
      timeout: 30_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          request.destroy(new Error("Gateway control response exceeds 64 KiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          bytes: Buffer.concat(chunks, length),
        });
      });
    });
    request.once("timeout", () => request.destroy(new Error("Gateway control timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

async function waitForNoSurvivors(pids: readonly number[], timeoutMs = 2_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter(processAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    survivors = pids.filter(processAlive);
  }
  return survivors;
}

function adjacentPorts(origin: number, maximumDistance: number): number[] {
  const candidates: number[] = [];
  for (let distance = 1; distance <= maximumDistance; distance += 1) {
    if (origin + distance <= 65_535) candidates.push(origin + distance);
  }
  for (let distance = 1; distance <= maximumDistance; distance += 1) {
    if (origin - distance >= 1) candidates.push(origin - distance);
  }
  return candidates;
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });
}

class ParentTcpCaptureProxy {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #clients = new Set<Socket>();
  #clientToTarget = counters();
  #targetToClient = counters();
  #acceptedConnections = 0;
  #clientToTargetBackpressure = false;
  #stopped = false;
  #startedAtMonotonicMs = performance.now();
  #listeningPort = 0;

  private constructor(
    readonly name: "gateway" | "fixture",
    readonly targetHost: string,
    readonly targetPort: number,
  ) {
    this.#server = createServer((client) => this.#relay(client));
  }

  static async start(input: {
    name: "gateway" | "fixture";
    targetHost: string;
    targetPort: number;
  }): Promise<ParentTcpCaptureProxy> {
    numericLoopback(input.targetHost, `${input.name} proxy target`);
    safePort(input.targetPort, `${input.name} proxy target`);
    const proxy = new ParentTcpCaptureProxy(input.name, input.targetHost, input.targetPort);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      proxy.#server.once("error", onError);
      proxy.#server.listen({ host: "127.0.0.1", port: 0 }, () => {
        proxy.#server.off("error", onError);
        const address = proxy.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error(`${input.name} capture proxy did not bind TCP`));
          return;
        }
        proxy.#listeningPort = address.port;
        resolve();
      });
    });
    return proxy;
  }

  get listeningPort(): number {
    return this.#listeningPort;
  }

  reset(): void {
    this.#clientToTarget = counters();
    this.#targetToClient = counters();
    this.#acceptedConnections = 0;
    this.#startedAtMonotonicMs = performance.now();
  }

  setClientToTargetBackpressure(enabled: boolean): {
    enabled: boolean;
    activeConnections: number;
  } {
    this.#clientToTargetBackpressure = enabled;
    for (const client of this.#clients) {
      if (enabled) client.pause();
      else client.resume();
    }
    return {
      enabled,
      activeConnections: this.#clients.size,
    };
  }

  summary(): ParentCaptureSummary {
    return {
      proxy: this.name,
      target: { host: this.targetHost, port: this.targetPort },
      listening: { host: "127.0.0.1", port: this.#listeningPort },
      clientToTarget: {
        chunks: this.#clientToTarget.chunks,
        bytes: this.#clientToTarget.bytes,
        sha256: `sha256:${this.#clientToTarget.hash.copy().digest("hex")}`,
      },
      targetToClient: {
        chunks: this.#targetToClient.chunks,
        bytes: this.#targetToClient.bytes,
        sha256: `sha256:${this.#targetToClient.hash.copy().digest("hex")}`,
      },
      acceptedConnections: this.#acceptedConnections,
      activeConnections: this.#sockets.size / 2,
      startedAtMonotonicMs: this.#startedAtMonotonicMs,
      finishedAtMonotonicMs: performance.now(),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #record(direction: "client_to_target" | "target_to_client", chunk: Buffer): void {
    const target = direction === "client_to_target" ? this.#clientToTarget : this.#targetToClient;
    target.chunks += 1;
    target.bytes += chunk.length;
    target.hash.update(chunk);
  }

  #relay(client: Socket): void {
    this.#acceptedConnections += 1;
    const target = new Socket();
    this.#sockets.add(client);
    this.#sockets.add(target);
    this.#clients.add(client);
    if (this.#clientToTargetBackpressure) client.pause();
    const close = (): void => {
      client.destroy();
      target.destroy();
      this.#sockets.delete(client);
      this.#sockets.delete(target);
      this.#clients.delete(client);
    };
    client.once("error", close);
    target.once("error", close);
    client.once("close", () => {
      target.destroy();
      this.#sockets.delete(client);
      this.#clients.delete(client);
    });
    target.once("close", () => {
      client.destroy();
      this.#sockets.delete(target);
    });
    client.on("data", (chunk: Buffer) => this.#record("client_to_target", chunk));
    target.on("data", (chunk: Buffer) => this.#record("target_to_client", chunk));
    client.pipe(target);
    target.pipe(client);
    target.connect({ host: this.targetHost, port: this.targetPort });
  }
}

interface ActiveStack {
  caseId: string;
  binding: Binding;
  preserveState: boolean;
  instanceRoot: string;
  instanceRootId: string;
  tokens: Record<string, string>;
  startupOverrides?: GatewayStartupOverrides;
  components: Map<ComponentId, StartedStackComponent>;
  extraFixtures: StartedStackComponent[];
  fixtureProxy: ParentTcpCaptureProxy;
  gatewayProxy: ParentTcpCaptureProxy;
  tlsIdentity?: EphemeralTlsIdentity;
  publicReadiness: {
    fixture: JsonObject;
    gateway: JsonObject;
    bridge: JsonObject;
  };
  stopOrder: ComponentId[];
}

export interface CaseStackSupervisorOptions {
  plan: ExecutionPlan;
  repoRoot: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export class CaseStackSupervisor {
  readonly #plan: ExecutionPlan;
  readonly #repoRoot: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  #active: ActiveStack | null = null;
  #observationOrdinal = 0;

  constructor(options: CaseStackSupervisorOptions) {
    this.#plan = structuredClone(options.plan);
    this.#repoRoot = realpathSync(options.repoRoot);
    this.#environment = { ...(options.environment ?? {}) };
  }

  get active(): boolean {
    return this.#active !== null;
  }

  get pids(): number[] {
    const stack = this.#stack();
    return [
      ...stack.components.values(),
      ...stack.extraFixtures,
    ].map(({ pid }) => pid);
  }

  readiness(): { fixture: JsonObject; gateway: JsonObject; bridge: JsonObject } {
    const readiness = this.#stack().publicReadiness;
    return structuredClone(readiness);
  }

  component(componentId: ComponentId): StartedStackComponent {
    const component = this.#stack().components.get(componentId);
    if (component === undefined) throw new Error(`active stack lacks ${componentId}`);
    return component;
  }

  beginWireCapture(): { started: true; atMonotonicMs: number } {
    const stack = this.#stack();
    stack.gatewayProxy.reset();
    stack.fixtureProxy.reset();
    return { started: true, atMonotonicMs: performance.now() };
  }

  setGatewayProxyBackpressure(enabled: boolean): {
    enabled: boolean;
    activeConnections: number;
  } {
    return this.#stack().gatewayProxy.setClientToTargetBackpressure(enabled);
  }

  wireCapture(): { gateway: ParentCaptureSummary; fixture: ParentCaptureSummary } {
    const stack = this.#stack();
    return {
      gateway: stack.gatewayProxy.summary(),
      fixture: stack.fixtureProxy.summary(),
    };
  }

  rawBindingEndpoint(): JsonObject {
    const stack = this.#stack();
    const tlsTrust = stack.publicReadiness.gateway.tlsTrust;
    return {
      binding: stack.binding,
      wsUrl: stack.publicReadiness.gateway.ws_url ?? null,
      httpConnectionUrl: stack.publicReadiness.gateway.http_connection_url ?? null,
      tlsTrust: isObject(tlsTrust) ? structuredClone(tlsTrust) : null,
    };
  }

  async restartComponent(
    input: {
      componentId: ComponentId;
      preserveState: boolean;
      startupOverrides?: GatewayStartupOverrides;
    },
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    if (input.componentId === "addin_loopback_fixture") {
      throw new Error("restart_component does not replace the canonical fixture process");
    }
    const previous = this.component(input.componentId);
    const stopped = await previous.stop();
    const survivors = await waitForNoSurvivors([previous.pid]);
    if (survivors.length > 0) {
      throw new Error(`${input.componentId} restart left the prior process alive`);
    }
    const stoppedObservation = this.#lifecycleObservation(
      previous,
      stepId,
      action,
      "stopped",
      {
        orphanProcessCount: 0,
        survivingPids: [],
        killEscalated: stopped.killEscalated,
        stopOrder: [input.componentId],
        preserveState: input.preserveState,
      },
    );
    if (!input.preserveState) this.#removeComponentState(stack, input.componentId);
    const startupOverrides = {
      ...(stack.startupOverrides ?? {}),
      ...(input.startupOverrides ?? {}),
    };
    stack.startupOverrides = structuredClone(startupOverrides);

    if (input.componentId === "gateway_stub") {
      await stack.gatewayProxy.stop();
      const replacement = await this.#startComponent(
        this.#componentPlan("gateway_stub"),
        stack.tokens,
        startupOverrides,
        stack.tlsIdentity,
      );
      let replacementProxy: ParentTcpCaptureProxy | undefined;
      try {
        const gatewayWs = parseLoopbackUrl(replacement.readiness.ws_url, "Gateway ws_url");
        const gatewayHttp = parseLoopbackUrl(
          replacement.readiness.http_connection_url,
          "Gateway http_connection_url",
        );
        if (gatewayWs.hostname !== gatewayHttp.hostname || gatewayWs.port !== gatewayHttp.port) {
          throw new Error("restarted Gateway readiness bindings do not share one loopback listener");
        }
        const expectedSchemes = stack.tlsIdentity === undefined
          ? { ws: "ws:", http: "http:" }
          : { ws: "wss:", http: "https:" };
        if (
          gatewayWs.protocol !== expectedSchemes.ws ||
          gatewayHttp.protocol !== expectedSchemes.http
        ) {
          throw new Error("restarted Gateway transport schemes do not match supervised TLS mode");
        }
        replacementProxy = await ParentTcpCaptureProxy.start({
          name: "gateway",
          targetHost: gatewayWs.hostname,
          targetPort: safePort(Number(gatewayWs.port), "restarted Gateway target port"),
        });
        stack.tokens.gateway_ws_url = proxyUrl(
          String(replacement.readiness.ws_url),
          replacementProxy.listeningPort,
        );
        stack.tokens.gateway_http_connection_url = proxyUrl(
          String(replacement.readiness.http_connection_url),
          replacementProxy.listeningPort,
        );
        stack.tokens.gateway_control_url = String(replacement.readiness.control_url);
        stack.gatewayProxy = replacementProxy;
        stack.publicReadiness.gateway = {
          ...replacement.readiness,
          ws_url: stack.tokens.gateway_ws_url,
          http_connection_url: stack.tokens.gateway_http_connection_url,
          control_url: stack.tokens.gateway_control_url,
          proxyCapture: true,
          tlsTrust: stack.tlsIdentity === undefined
            ? {
                enabled: false,
                caCertificatePath: null,
                caCertificateSha256: null,
                serverCertificateSha256: null,
              }
            : {
                enabled: true,
                caCertificatePath: stack.tlsIdentity.caCertificatePath,
                caCertificateSha256: stack.tlsIdentity.caCertificateSha256,
                serverCertificateSha256: stack.tlsIdentity.serverCertificateSha256,
              },
        };
        stack.components.set(input.componentId, replacement);
      } catch (error) {
        await replacementProxy?.stop().catch(() => undefined);
        await replacement.stop().catch(() => undefined);
        throw error;
      }
      return {
        result: {
          restarted: true,
          componentId: input.componentId,
          preserveState: input.preserveState,
          previousPid: previous.pid,
          pid: replacement.pid,
          readiness: structuredClone(stack.publicReadiness.gateway),
        },
        observations: [
          stoppedObservation,
          this.#lifecycleObservation(replacement, stepId, action, "started", {
            orphanProcessCount: 0,
            survivingPids: [],
            killEscalated: false,
            stopOrder: [],
            preserveState: input.preserveState,
          }),
        ],
      };
    }

    const replacement = await this.#startComponent(
      this.#componentPlan("bridge_simulator"),
      stack.tokens,
      startupOverrides,
    );
    stack.components.set(input.componentId, replacement);
    stack.publicReadiness.bridge = { ...replacement.readiness };
    return {
      result: {
        restarted: true,
        componentId: input.componentId,
        preserveState: input.preserveState,
        previousPid: previous.pid,
        pid: replacement.pid,
        readiness: structuredClone(stack.publicReadiness.bridge),
      },
      observations: [
        stoppedObservation,
        this.#lifecycleObservation(replacement, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
          preserveState: input.preserveState,
        }),
      ],
    };
  }

  async spawnAdditionalFixture(
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    if (stack.extraFixtures.length > 0) {
      throw new Error("the supervised early-case stack permits exactly one additional fixture");
    }
    const primaryPort = safePort(
      stack.publicReadiness.fixture.port,
      "primary fixture readiness port",
    );
    const fixturePlan = this.#componentPlan("addin_loopback_fixture");
    let fixture: StartedStackComponent | undefined;
    let selectedPort = 0;
    for (const candidate of adjacentPorts(primaryPort, 5)) {
      if (!await loopbackPortAvailable(candidate)) continue;
      try {
        fixture = await this.#startComponent(
          fixturePlan,
          stack.tokens,
          stack.startupOverrides,
          undefined,
          { "--port": candidate },
        );
        selectedPort = safePort(fixture.readiness.port, "additional fixture readiness port");
        if (selectedPort !== candidate) {
          await fixture.stop();
          fixture = undefined;
          throw new Error("additional fixture did not bind the parent-selected port");
        }
        break;
      } catch {
        fixture = undefined;
      }
    }
    if (fixture === undefined) {
      throw new Error("unable to start an additional fixture in the bounded adjacent port range");
    }
    stack.extraFixtures.push(fixture);
    return {
      result: {
        started: true,
        fixtureIndex: 1,
        pid: fixture.pid,
        host: numericLoopback(fixture.readiness.host, "additional fixture host"),
        port: selectedPort,
        firstPort: Math.min(primaryPort, selectedPort),
        lastPort: Math.max(primaryPort, selectedPort),
        expectedSessionCount: 2,
        primaryProbeIndex: primaryPort < selectedPort ? 0 : 1,
        auxiliaryProbeIndex: primaryPort < selectedPort ? 1 : 0,
        tempRegistryPath: null,
      },
      observations: [
        this.#lifecycleObservation(fixture, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
        }),
      ],
    };
  }

  async restartCaseStack(
    options: RestartCaseStackOptions,
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    if (this.#active !== null) {
      await this.stopCaseStack(stepId, "implicit_stop_before_restart");
    }
    const instanceRoot = this.#privateInstanceRoot(options.caseId, options.binding);
    const instanceRootId = `sha256:${createHash("sha256").update(instanceRoot).digest("hex")}`;
    const components = new Map<ComponentId, StartedStackComponent>();
    const extraFixtures: StartedStackComponent[] = [];
    let fixtureProxy: ParentTcpCaptureProxy | undefined;
    let gatewayProxy: ParentTcpCaptureProxy | undefined;
    try {
      const tokens: Record<string, string> = {
        run_id: this.#plan.runId,
        case_id: options.caseId,
        binding: options.binding,
        instance_root: instanceRoot,
        state_root: path.join(instanceRoot, "state"),
        evidence_root: path.join(instanceRoot, "evidence"),
      };
      mkdirSync(tokens.state_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      mkdirSync(tokens.evidence_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const tlsIdentity = options.binding === "wss"
        ? createEphemeralLoopbackTlsIdentity(instanceRoot)
        : undefined;

      const fixturePlan = this.#componentPlan("addin_loopback_fixture");
      const fixture = await this.#startComponent(fixturePlan, tokens, options.startupOverrides);
      components.set(fixture.componentId, fixture);
      const fixtureHost = numericLoopback(fixture.readiness.host, "fixture readiness host");
      const fixturePort = safePort(fixture.readiness.port, "fixture readiness port");
      fixtureProxy = await ParentTcpCaptureProxy.start({
        name: "fixture",
        targetHost: fixtureHost,
        targetPort: fixturePort,
      });
      tokens.fixture_host = "127.0.0.1";
      tokens.fixture_port = String(fixtureProxy.listeningPort);

      const gatewayPlan = this.#componentPlan("gateway_stub");
      const gateway = await this.#startComponent(
        gatewayPlan,
        tokens,
        options.startupOverrides,
        tlsIdentity,
      );
      components.set(gateway.componentId, gateway);
      const gatewayWs = parseLoopbackUrl(gateway.readiness.ws_url, "Gateway ws_url");
      const gatewayHttp = parseLoopbackUrl(
        gateway.readiness.http_connection_url,
        "Gateway http_connection_url",
      );
      if (gatewayWs.hostname !== gatewayHttp.hostname || gatewayWs.port !== gatewayHttp.port) {
        throw new Error("Gateway readiness bindings do not share one loopback listener");
      }
      const expectedSchemes = tlsIdentity === undefined
        ? { ws: "ws:", http: "http:" }
        : { ws: "wss:", http: "https:" };
      if (gatewayWs.protocol !== expectedSchemes.ws || gatewayHttp.protocol !== expectedSchemes.http) {
        throw new Error("Gateway readiness transport schemes do not match the supervised TLS mode");
      }
      gatewayProxy = await ParentTcpCaptureProxy.start({
        name: "gateway",
        targetHost: gatewayWs.hostname,
        targetPort: safePort(Number(gatewayWs.port), "Gateway proxy target port"),
      });
      tokens.gateway_ws_url = proxyUrl(String(gateway.readiness.ws_url), gatewayProxy.listeningPort);
      tokens.gateway_http_connection_url = proxyUrl(
        String(gateway.readiness.http_connection_url),
        gatewayProxy.listeningPort,
      );
      tokens.gateway_control_url = String(gateway.readiness.control_url);

      const bridgePlan = this.#componentPlan("bridge_simulator");
      const bridge = await this.#startComponent(bridgePlan, tokens, options.startupOverrides);
      components.set(bridge.componentId, bridge);

      const publicReadiness = {
        fixture: {
          ...fixture.readiness,
          host: fixtureHost,
          port: fixturePort,
          proxyCapture: false,
          proxyUnavailableReason:
            "fixture discovery binds the advertised endpoint to the probed endpoint",
        },
        gateway: {
          ...gateway.readiness,
          ws_url: tokens.gateway_ws_url,
          http_connection_url: tokens.gateway_http_connection_url,
          control_url: tokens.gateway_control_url,
          proxyCapture: true,
          tlsTrust: tlsIdentity === undefined
            ? {
                enabled: false,
                caCertificatePath: null,
                caCertificateSha256: null,
                serverCertificateSha256: null,
              }
            : {
                enabled: true,
                caCertificatePath: tlsIdentity.caCertificatePath,
                caCertificateSha256: tlsIdentity.caCertificateSha256,
                serverCertificateSha256: tlsIdentity.serverCertificateSha256,
              },
        },
        bridge: { ...bridge.readiness },
      };
      this.#active = {
        caseId: options.caseId,
        binding: options.binding,
        preserveState: options.preserveState,
        instanceRoot,
        instanceRootId,
        tokens,
        ...(options.startupOverrides === undefined
          ? {}
          : { startupOverrides: structuredClone(options.startupOverrides) }),
        components,
        extraFixtures,
        fixtureProxy,
        gatewayProxy,
        ...(tlsIdentity === undefined ? {} : { tlsIdentity }),
        publicReadiness,
        stopOrder: [],
      };
      const observations = [...components.values()].map((component) =>
        this.#lifecycleObservation(component, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
        }));
      return {
        result: {
          restarted: true,
          caseId: options.caseId,
          binding: options.binding,
          instanceRootId,
          readiness: publicReadiness,
          processIdentities: [...components.values()].map((component) => ({
            componentId: component.componentId,
            pid: component.pid,
            identity: component.identity,
          })) as unknown as JsonValue,
        },
        observations,
      };
    } catch (error) {
      const cleanupErrors: Error[] = [];
      for (const component of [...components.values(), ...extraFixtures].reverse()) {
        await component.stop().catch((cleanupError: unknown) => {
          cleanupErrors.push(
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          );
        });
      }
      await gatewayProxy?.stop().catch((cleanupError: unknown) => {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      });
      await fixtureProxy?.stop().catch((cleanupError: unknown) => {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      });
      const survivors = await waitForNoSurvivors(
        [...components.values(), ...extraFixtures].map(({ pid }) => pid),
      );
      if (survivors.length === 0) {
        rmSync(instanceRoot, { recursive: true, force: true });
      } else {
        cleanupErrors.push(
          new Error(`failed stack start left orphan processes: ${survivors.join(", ")}`),
        );
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "case stack start failed and supervised cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async stopCaseStack(
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    const killEscalated = new Map<ComponentId, boolean>();
    let firstError: Error | undefined;
    const components = [...stack.components.values(), ...stack.extraFixtures];
    for (const component of [...components].reverse()) {
      stack.stopOrder.push(component.componentId);
      try {
        const stopped = await component.stop();
        killEscalated.set(component.componentId, stopped.killEscalated);
      } catch (error) {
        killEscalated.set(component.componentId, true);
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    await stack.gatewayProxy.stop().catch((error: unknown) => {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    });
    await stack.fixtureProxy.stop().catch((error: unknown) => {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    });
    const pids = components.map(({ pid }) => pid);
    const survivors = await waitForNoSurvivors(pids);
    const observations = components.map((component) =>
      this.#lifecycleObservation(component, stepId, action, "stopped", {
        orphanProcessCount: survivors.length,
        survivingPids: survivors,
        killEscalated: killEscalated.get(component.componentId) ?? true,
        stopOrder: [...stack.stopOrder],
      }));
    const result: JsonObject = {
      stopped: true,
      instanceRootId: stack.instanceRootId,
      stopOrder: [...stack.stopOrder],
      orphanProcessCount: survivors.length,
      survivingPids: survivors,
      killEscalated: Object.fromEntries(killEscalated) as unknown as JsonValue,
    };
    this.#active = null;
    if (!stack.preserveState && survivors.length === 0) {
      rmSync(stack.instanceRoot, { recursive: true, force: true });
    }
    if (firstError !== undefined) throw firstError;
    if (survivors.length > 0) {
      throw new Error(`case stack left orphan processes: ${survivors.join(", ")}`);
    }
    return { result, observations };
  }

  async gatewayControl(
    action: string,
    argumentsValue: JsonObject,
    maxResponseBytes = 64 * 1024,
  ): Promise<JsonValue> {
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES
    ) {
      throw new Error("Gateway control response bound is outside the parent-owned limit");
    }
    const stack = this.#stack();
    const controlUrl = stack.publicReadiness.gateway.control_url;
    if (typeof controlUrl !== "string") throw new Error("Gateway readiness lacks control_url");
    const body = Buffer.from(JSON.stringify({ action, ...argumentsValue }), "utf8");
    let status: number;
    let bytes: Buffer;
    if (controlUrl.startsWith("https:")) {
      if (stack.tlsIdentity === undefined) {
        throw new Error("HTTPS Gateway control lacks supervised TLS identity");
      }
      ({ status, bytes } = await postHttpsControl(
        controlUrl,
        body,
        stack.tlsIdentity,
      ));
    } else {
      const response = await fetch(controlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rbp-test-control": "rbp-test-control",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      status = response.status;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length > maxResponseBytes) {
      throw new Error(`Gateway control response exceeds ${maxResponseBytes} bytes`);
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isObject(parsed)) throw new Error("Gateway control response is not a JSON object");
    if (status !== 200) {
      throw new GatewayControlRequestError(action, status, parsed);
    }
    return parsed;
  }

  async compactGatewaySnapshot(): Promise<JsonObject> {
    const raw = await this.gatewayControl(
      "snapshot",
      {},
      MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES,
    );
    if (!isObject(raw)) throw new Error("Gateway snapshot is not an object");
    const compact = compactGatewaySnapshotValue(raw);
    if (Buffer.byteLength(JSON.stringify(compact), "utf8") > MAX_COMPACT_GATEWAY_SNAPSHOT_BYTES) {
      throw new Error("compact Gateway snapshot exceeds the 60 KiB observation bound");
    }
    return compact;
  }

  async jsonlControl(
    componentId: "bridge_simulator" | "addin_loopback_fixture",
    action: string,
    argumentsValue: JsonObject,
    timeoutMs = 30_000,
  ): Promise<JsonValue> {
    const control = this.component(componentId).jsonl;
    if (control === undefined) throw new Error(`${componentId} lacks JSONL control`);
    return await control.request(action, argumentsValue, timeoutMs);
  }

  async aggregateSnapshot(
    componentId: "bridge_simulator" | "addin_loopback_fixture",
  ): Promise<JsonObject> {
    const arrayFields = componentId === "bridge_simulator"
      ? ["invocations", "holds", "durabilityEvents", "sessions", "sequences"]
      : ["observations", "executionCounts", "methodExecutionCounts", "pendingStalls"];
    let fields: Readonly<Record<string, JsonValue>> = {};
    let aggregate: JsonObject | undefined;
    for (let pageIndex = 0; pageIndex < MAX_SNAPSHOT_PAGES; pageIndex += 1) {
      const page = await this.jsonlControl(componentId, "snapshot_evidence", fields);
      if (!isObject(page)) throw new Error(`${componentId} snapshot page is not an object`);
      if (aggregate === undefined) {
        aggregate = structuredClone(page);
        for (const field of arrayFields) aggregate[field] = [];
      }
      for (const field of arrayFields) {
        const values = page[field];
        if (!Array.isArray(values)) throw new Error(`${componentId} snapshot page lacks ${field}`);
        (aggregate[field] as JsonValue[]).push(...structuredClone(values));
      }
      if (Buffer.byteLength(JSON.stringify(aggregate), "utf8") > MAX_AGGREGATED_SNAPSHOT_BYTES) {
        throw new Error(`${componentId} aggregated snapshot exceeds 4 MiB`);
      }
      if (page.complete === true) {
        aggregate.complete = true;
        aggregate.nextCursor = null;
        return aggregate;
      }
      if (typeof page.snapshotId !== "string" || !isObject(page.nextCursor)) {
        throw new Error(`${componentId} snapshot continuation is malformed`);
      }
      fields = {
        snapshotId: page.snapshotId,
        cursor: page.nextCursor,
      };
    }
    throw new Error(`${componentId} snapshot pagination exceeded ${MAX_SNAPSHOT_PAGES} pages`);
  }

  async awaitCondition(input: {
    source: string;
    jsonPointer: string;
    operator: string;
    expected?: JsonValue;
    timeoutMs: number;
    intervalMs?: number;
  }): Promise<JsonObject> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) {
      throw new Error("await_condition timeoutMs is outside the parent bound");
    }
    const intervalMs = input.intervalMs ?? 25;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000) {
      throw new Error("await_condition intervalMs is outside the parent bound");
    }
    const deadline = Date.now() + input.timeoutMs;
    let attempts = 0;
    let lastSnapshot: JsonObject | undefined;
    while (Date.now() <= deadline) {
      attempts += 1;
      const snapshot = await this.#conditionSource(input.source);
      lastSnapshot = snapshot;
      const value = jsonPointer(snapshot, input.jsonPointer);
      if (conditionMatches(input.operator, value, input.expected)) {
        return {
          matched: true,
          attempts,
          source: input.source,
          jsonPointer: input.jsonPointer,
          operator: input.operator,
          expected: input.expected ?? null,
          observed: value ?? null,
          snapshot,
          dynamic: dynamicValues(snapshot),
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `await_condition timed out after ${input.timeoutMs} ms; last=${JSON.stringify(lastSnapshot ?? null)}`,
    );
  }

  #stack(): ActiveStack {
    if (this.#active === null) throw new Error("case stack is not active");
    return this.#active;
  }

  #componentPlan(componentId: ComponentId): PlannedComponent {
    const component = this.#plan.components.find(({ id }) => id === componentId);
    if (component === undefined) throw new Error(`execution plan lacks ${componentId}`);
    return component;
  }

  #privateInstanceRoot(caseId: string, binding: Binding): string {
    const root = mkdtempSync(path.join(tmpdir(), `rbp-${this.#plan.runId}-${caseId}-${binding}-`));
    chmodSync(root, PRIVATE_DIRECTORY_MODE);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("case-stack instance root is not a plain directory");
    }
    return root;
  }

  #removeComponentState(
    stack: ActiveStack,
    componentId: "gateway_stub" | "bridge_simulator",
  ): void {
    const candidate = componentId === "gateway_stub"
      ? path.join(stack.instanceRoot, "state", "gateway.json")
      : path.join(stack.instanceRoot, "state", "bridge");
    const relative = path.relative(stack.instanceRoot, path.resolve(candidate));
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to clear ${componentId} state outside its exact instance root`);
    }
    rmSync(candidate, {
      recursive: componentId === "bridge_simulator",
      force: true,
    });
  }

  async #startComponent(
    component: PlannedComponent,
    tokens: Readonly<Record<string, string>>,
    gatewayOverrides: GatewayStartupOverrides | undefined,
    tlsIdentity?: EphemeralTlsIdentity,
    scalarOverrides: Readonly<Record<string, string | number>> = {},
  ): Promise<StartedStackComponent> {
    let command = expandedCommand(component.command, tokens);
    if (component.id === "gateway_stub") {
      command = withGatewayOverrides(command, gatewayOverrides, tlsIdentity);
    }
    for (const [flag, value] of Object.entries(scalarOverrides)) {
      if (!/^--[a-z0-9-]+$/u.test(flag)) {
        throw new Error(`component scalar override flag is invalid: ${flag}`);
      }
      command = { ...command, args: setCliScalarArgument(command.args, flag, value) };
    }
    const cwd = confinedWorkingDirectory(this.#repoRoot, command);
    const identity = observedIdentity(component, command, cwd);
    if (command.readiness.kind !== "stdout_pattern") {
      throw new Error(`${component.id} must expose supervised JSON stdout readiness`);
    }
    const environment: Record<string, string | undefined> = {};
    for (const key of command.environmentKeys) environment[key] = this.#environment[key];

    if (component.id === "gateway_stub") {
      const processHandle = await StrictReadyProcess.start({
        componentId: component.id,
        command,
        absoluteWorkingDirectory: cwd,
        environment,
        validateReadiness(value) {
          if (
            value.event !== "ready" ||
            value.component !== "@revagent/gateway-stub" ||
            value.control_contract_version !== 1 ||
            typeof value.pid !== "number"
          ) {
            throw new Error("Gateway readiness does not match the O1-T5 process contract");
          }
        },
      });
      if (processHandle.readiness.pid !== processHandle.pid) {
        await processHandle.stop();
        throw new Error("Gateway readiness PID does not match the spawned child");
      }
      return {
        componentId: component.id,
        identity,
        pid: processHandle.pid,
        process: processHandle.process,
        readiness: processHandle.readiness,
        stop: async () => {
          const stopped = await processHandle.stop(
            command.shutdown.signal === "SIGINT" ? "SIGINT" : "SIGTERM",
            command.shutdown.timeoutMs,
          );
          return { killEscalated: stopped.killEscalated };
        },
      };
    }

    const isBridge = component.id === "bridge_simulator";
    const processHandle = await StrictJsonlProcess.start({
      componentId: component.id,
      command,
      absoluteWorkingDirectory: cwd,
      environment,
      expectedReadinessFields: isBridge
        ? {
            component: "bridge-simulator",
            componentRole: "O1-T4",
            contract: "bridge-simulator-control/v1",
          }
        : { contract: "addin-loopback/v1" },
      requiredActions: ["snapshot_evidence", "shutdown"],
    });
    if (isBridge && processHandle.readiness.pid !== processHandle.pid) {
      await processHandle.stop();
      throw new Error("Bridge readiness PID does not match the spawned child");
    }
    return {
      componentId: component.id,
      identity,
      pid: processHandle.pid,
      process: processHandle.process,
      readiness: processHandle.readiness,
      jsonl: processHandle,
      stop: async () => {
        const stopped = await processHandle.stop();
        return { killEscalated: stopped.killEscalated };
      },
    };
  }

  #lifecycleObservation(
    component: StartedStackComponent,
    stepId: string,
    action: string,
    phase: "started" | "stopped",
    cleanup: {
      orphanProcessCount: number;
      survivingPids: readonly number[];
      killEscalated: boolean;
      stopOrder: readonly ComponentId[];
      preserveState?: boolean;
    },
  ): ProcessObservationRecord {
    const stack = this.#stack();
    const auxiliaryIndex = stack.extraFixtures.findIndex(
      (candidate) => candidate === component,
    );
    return {
      schemaVersion: "rbp-process-observation/v2",
      observationId: `${this.#plan.runId}:${stack.caseId}:${stack.binding}:stack:${++this.#observationOrdinal}`,
      runId: this.#plan.runId,
      caseId: stack.caseId,
      binding: stack.binding,
      componentId: component.componentId,
      kind: "process_lifecycle",
      at: new Date().toISOString(),
      payload: {
        schemaVersion: "rbp-supervised-process-lifecycle/v2",
        stepId,
        action,
        spawnOwner: "parent_runner",
        processRole: auxiliaryIndex >= 0 ? "auxiliary_fixture" : "canonical_component",
        auxiliaryIndex: auxiliaryIndex >= 0 ? auxiliaryIndex + 1 : null,
        phase,
        instanceRootId: stack.instanceRootId,
        identity: component.identity,
        process: { ...component.process },
        orphanProcessCount: cleanup.orphanProcessCount,
        survivingPids: [...cleanup.survivingPids],
        killEscalated: cleanup.killEscalated,
        stopOrder: [...cleanup.stopOrder],
        preserveState: cleanup.preserveState ?? null,
      },
    };
  }

  async #conditionSource(source: string): Promise<JsonObject> {
    switch (source) {
      case "bridge.snapshot_evidence":
      case "bridge_reconnect_schedule":
        return await this.aggregateSnapshot("bridge_simulator");
      case "fixture.snapshot_evidence":
        return await this.aggregateSnapshot("addin_loopback_fixture");
      case "gateway.snapshot":
        return await this.gatewayControl("snapshot", {}) as JsonObject;
      case "gateway.compact_snapshot":
        return await this.compactGatewaySnapshot();
      case "wire_capture":
        return this.wireCapture() as unknown as JsonObject;
      default:
        throw new Error(`await_condition source is not implemented: ${source}`);
    }
  }
}

function jsonPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("await_condition JSON pointer must start with /");
  let current: JsonValue | undefined = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function conditionMatches(operator: string, value: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  switch (operator) {
    case "exists":
      return value !== undefined && value !== null;
    case "equals":
      return JSON.stringify(value) === JSON.stringify(expected);
    case "not_equals":
      return value !== undefined && JSON.stringify(value) !== JSON.stringify(expected);
    case "count_equals":
      return Array.isArray(value) && value.length === expected;
    case "minimum_count":
      return Array.isArray(value) && typeof expected === "number" && value.length >= expected;
    case "crosses":
      return typeof value === "number" && typeof expected === "number" && value >= expected;
    default:
      throw new Error(`await_condition operator is not implemented: ${operator}`);
  }
}

function dynamicValues(snapshot: JsonObject): JsonObject {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const rsids = sessions
    .filter(isObject)
    .map((session) => session.rsid)
    .filter((rsid): rsid is string => typeof rsid === "string");
  const firstSession = sessions.find(isObject);
  const sequences = Array.isArray(snapshot.sequences) ? snapshot.sequences : [];
  const firstSequence = sequences.find(isObject);
  const rsid = typeof firstSession?.rsid === "string" ? firstSession.rsid : null;
  const lastRxSeq = Number.isSafeInteger(firstSequence?.lastRxSeq) ? Number(firstSequence?.lastRxSeq) : 0;
  const lastPeerAck = Number.isSafeInteger(firstSequence?.lastPeerAck) ? Number(firstSequence?.lastPeerAck) : 0;
  return {
    rsid,
    rsids,
    nextSeq: lastRxSeq + 1,
    lastAck: lastPeerAck,
    grantedSessionCapabilities: Array.isArray(firstSession?.grantedSessionCapabilities)
      ? firstSession.grantedSessionCapabilities
      : [],
  };
}
