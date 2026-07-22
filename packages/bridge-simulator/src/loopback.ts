import type { Buffer } from "node:buffer";
import { isIP, Socket } from "node:net";

import {
  DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
  FrameDecoder,
  MAX_RESPONSE_PAYLOAD_BYTES,
  encodeJsonFrame,
  type JsonObject,
} from "@revagent/addin-loopback-fixture";

export interface LoopbackTarget {
  readonly host: string;
  readonly port: number;
}

export interface RawAddinResponse {
  readonly message: JsonObject;
  /** Exact UTF-8 JSON response body, excluding the four-byte header. */
  readonly payload: Uint8Array;
}

export interface ProbedAddinSession {
  readonly target: LoopbackTarget;
  readonly localSessionKey: string;
  readonly addinVersion: string;
  readonly resultContractVersion: 2;
  readonly revit: { readonly version: string; readonly build: string; readonly processId: number };
  readonly sessionCapabilities: readonly ("batch_atomic" | "doc_context_cached_v1")[];
  readonly batchableCommands: readonly {
    readonly method: string;
    readonly effect: "read_only" | "model_transaction";
  }[];
  readonly maxRequestPayloadBytes: number;
  readonly maxResponsePayloadBytes: number;
  readonly client: PersistentAddinClient;
}

export interface DiscoveryEvidence {
  readonly source: "explicit_override" | "bounded_scan";
  readonly probedTargets: readonly LoopbackTarget[];
  readonly acceptedTargets: readonly LoopbackTarget[];
  readonly rejectedTargets: readonly { readonly target: LoopbackTarget; readonly reason: string }[];
  readonly tempRegistryReads: 0;
  readonly filesystemLocksCreated: 0;
}

export interface DiscoveryResult {
  readonly sessions: readonly ProbedAddinSession[];
  readonly evidence: DiscoveryEvidence;
}

/**
 * Runs a bounded cache/status read on a short-lived connection so a timed-out
 * command cannot occupy the only command correlation slot. The add-in still
 * owns one in-order request window per TCP connection.
 */
export async function requestAddinSideChannel(
  session: Pick<
    ProbedAddinSession,
    "target" | "maxRequestPayloadBytes"
  >,
  id: string,
  method: "mcp_status" | "get_document_context",
  timeoutMs = 1_000,
): Promise<RawAddinResponse> {
  const client = await PersistentAddinClient.connect(session.target, timeoutMs);
  client.setMaxRequestPayloadBytes(session.maxRequestPayloadBytes);
  try {
    return await client.request(id, method, {}, timeoutMs);
  } finally {
    client.close();
  }
}

interface PendingRequest {
  readonly id: string;
  readonly resolve: (response: RawAddinResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly onLateResponse?: (response: RawAddinResponse) => void;
  timedOut: boolean;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/gu, " ").slice(0, 240);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!isJsonObject(value)) throw new Error(`mcp_status.${key} must be an object`);
  return value;
}

function requiredString(parent: JsonObject, key: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`mcp_status.${key} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(parent: JsonObject, key: string): number {
  const value = parent[key];
  if (!Number.isSafeInteger(value)) throw new Error(`mcp_status.${key} must be a safe integer`);
  return value as number;
}

export function isNumericLoopback(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  if (family !== 6) return false;
  return normalized.toLowerCase() === "::1" || normalized.toLowerCase() === "0:0:0:0:0:0:0:1";
}

export function assertLoopbackTarget(target: LoopbackTarget): void {
  if (!isNumericLoopback(target.host)) {
    throw new Error(`numeric IP loopback required before probe: ${target.host}`);
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new RangeError("loopback target port must be an integer from 1 through 65535");
  }
}

export class PersistentAddinClient {
  readonly #target: LoopbackTarget;
  readonly #socket: Socket;
  readonly #decoder = new FrameDecoder(MAX_RESPONSE_PAYLOAD_BYTES);
  #pending: PendingRequest | null = null;
  #closed = false;
  #maxRequestPayloadBytes = DEFAULT_MAX_REQUEST_PAYLOAD_BYTES;

  private constructor(target: LoopbackTarget, socket: Socket) {
    this.#target = { ...target };
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (error: Error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("add-in loopback connection closed")));
  }

  public static async connect(target: LoopbackTarget, timeoutMs = 1_000): Promise<PersistentAddinClient> {
    assertLoopbackTarget(target);
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("add-in loopback connect timeout"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("connect", onConnect);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.connect({ host: target.host, port: target.port });
    });
    return new PersistentAddinClient(target, socket);
  }

  public get target(): LoopbackTarget {
    return { ...this.#target };
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public setMaxRequestPayloadBytes(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 128 * 1024 * 1024) {
      throw new RangeError("invalid advertised add-in request limit");
    }
    this.#maxRequestPayloadBytes = value;
  }

  public async request(
    id: string,
    method: string,
    params: JsonObject,
    timeoutMs = 5_000,
    onLateResponse?: (response: RawAddinResponse) => void,
  ): Promise<RawAddinResponse> {
    if (this.#closed || this.#socket.destroyed) throw new Error("add-in loopback client is closed");
    if (this.#pending !== null) throw new Error("persistent add-in window is already occupied");
    const request: JsonObject = { jsonrpc: "2.0", id, method, params };
    const frame = encodeJsonFrame(request, this.#maxRequestPayloadBytes);
    const response = new Promise<RawAddinResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pending?.id === id) this.#pending.timedOut = true;
        reject(new Error(`add-in request timed out: ${method}`));
      }, timeoutMs);
      this.#pending = {
        id,
        resolve,
        reject,
        timeout,
        ...(onLateResponse === undefined ? {} : { onLateResponse }),
        timedOut: false,
      };
    });
    await new Promise<void>((resolve) => {
      const settleWrite = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve();
          return;
        }
        const pending = this.#pending;
        if (pending?.id === id) {
          clearTimeout(pending.timeout);
          this.#pending = null;
          pending.reject(error);
        }
        resolve();
      };
      this.#socket.write(frame, settleWrite);
    });
    return response;
  }

  public close(): void {
    this.#closed = true;
    this.#socket.destroy();
    this.#fail(new Error("add-in loopback client closed"));
  }

  #onData(chunk: Buffer): void {
    let payloads: Buffer[];
    try {
      payloads = this.#decoder.push(chunk);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const payload of payloads) {
      const pending = this.#pending;
      if (pending === null) {
        this.#fail(new Error("uncorrelated add-in response"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.#fail(new Error("add-in response is not UTF-8 JSON"));
        return;
      }
      if (!isJsonObject(message) || message.id !== pending.id) {
        this.#fail(new Error("add-in response id mismatch"));
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending = null;
      const response = { message, payload: new Uint8Array(payload) };
      if (pending.timedOut) pending.onLateResponse?.(response);
      else pending.resolve(response);
    }
  }

  #fail(error: Error): void {
    this.#closed = true;
    const pending = this.#pending;
    if (pending !== null) {
      clearTimeout(pending.timeout);
      this.#pending = null;
      pending.reject(error);
    }
  }
}

export type LoopbackConnector = (
  target: LoopbackTarget,
) => Promise<PersistentAddinClient>;

function parseStatus(
  target: LoopbackTarget,
  client: PersistentAddinClient,
  response: RawAddinResponse,
): ProbedAddinSession {
  const root = response.message;
  if (root.jsonrpc !== "2.0" || !isJsonObject(root.result)) {
    throw new Error("mcp_status response is not a JSON-RPC success");
  }
  const result = root.result;
  if (result.resultContractVersion !== 2 || result.addinLoopbackContractVersion !== 1) {
    throw new Error("unsupported add-in loopback/result contract");
  }
  const service = requiredObject(result, "service");
  if (service.binding !== "loopback_only" || service.isRunning !== true) {
    throw new Error("add-in does not attest loopback-only running service");
  }
  const boundAddresses = service.boundAddresses;
  if (
    !Array.isArray(boundAddresses) ||
    boundAddresses.length < 1 ||
    boundAddresses.some((address) => typeof address !== "string" || !isNumericLoopback(address))
  ) {
    throw new Error("add-in reported a non-loopback bound address");
  }
  const framing = requiredObject(service, "framing");
  if (
    framing.protocol !== "length_prefixed_jsonrpc_v1" ||
    framing.headerBytes !== 4 ||
    framing.byteOrder !== "big_endian" ||
    framing.payloadEncoding !== "utf-8"
  ) {
    throw new Error("unsupported add-in framing contract");
  }
  const maxRequestPayloadBytes = requiredInteger(framing, "maxRequestPayloadBytes");
  const maxResponsePayloadBytes = requiredInteger(framing, "maxResponsePayloadBytes");
  if (maxResponsePayloadBytes !== MAX_RESPONSE_PAYLOAD_BYTES) {
    throw new Error("unexpected add-in response limit");
  }
  const revit = requiredObject(result, "revit");
  const rawCapabilities = result.sessionCapabilities;
  if (!Array.isArray(rawCapabilities)) throw new Error("sessionCapabilities must be an array");
  const allowed = new Set(["batch_atomic", "doc_context_cached_v1"]);
  if (rawCapabilities.some((entry) => typeof entry !== "string" || !allowed.has(entry))) {
    throw new Error("invalid session capability claim");
  }
  const sessionCapabilities = [...new Set(rawCapabilities)] as (
    | "batch_atomic"
    | "doc_context_cached_v1"
  )[];
  if (sessionCapabilities.length !== rawCapabilities.length) {
    throw new Error("duplicate session capability claim");
  }
  let batchableCommands: Array<{
    readonly method: string;
    readonly effect: "read_only" | "model_transaction";
  }> = [];
  if (sessionCapabilities.includes("batch_atomic")) {
    const contracts = requiredObject(result, "capabilityContracts");
    const batchContract = requiredObject(contracts, "batch_atomic");
    if (batchContract.contractVersion !== 1 || batchContract.method !== "execute_batch") {
      throw new Error("unsupported batch_atomic capability contract");
    }
    if (!Array.isArray(batchContract.batchableCommands)) {
      throw new Error("batchableCommands must be an array");
    }
    batchableCommands = batchContract.batchableCommands.map((entry) => {
      if (!isJsonObject(entry) || typeof entry.method !== "string") {
        throw new Error("invalid batchable command descriptor");
      }
      if (entry.effect !== "read_only" && entry.effect !== "model_transaction") {
        throw new Error("invalid batchable command effect");
      }
      return { method: entry.method, effect: entry.effect };
    });
    if (new Set(batchableCommands.map((entry) => entry.method)).size !== batchableCommands.length) {
      throw new Error("duplicate batchable command descriptor");
    }
  }
  client.setMaxRequestPayloadBytes(maxRequestPayloadBytes);
  return {
    target: { ...target },
    localSessionKey: `port:${target.port}:pid:${requiredInteger(revit, "processId")}`,
    addinVersion: requiredString(result, "addinVersion"),
    resultContractVersion: 2,
    revit: {
      version: requiredString(revit, "version"),
      build: requiredString(revit, "build"),
      processId: requiredInteger(revit, "processId"),
    },
    sessionCapabilities,
    batchableCommands,
    maxRequestPayloadBytes,
    maxResponsePayloadBytes,
    client,
  };
}

export async function discoverAddinSessions(options: {
  readonly explicitTarget?: LoopbackTarget;
  readonly host?: string;
  readonly firstPort?: number;
  readonly lastPort?: number;
  readonly connector?: LoopbackConnector;
  readonly probeTimeoutMs?: number;
} = {}): Promise<DiscoveryResult> {
  const connector = options.connector ?? ((target) => PersistentAddinClient.connect(target));
  const source = options.explicitTarget === undefined ? "bounded_scan" : "explicit_override";
  const targets: LoopbackTarget[] = [];
  if (options.explicitTarget !== undefined) {
    targets.push({ ...options.explicitTarget });
  } else {
    const host = options.host ?? "127.0.0.1";
    const firstPort = options.firstPort ?? 8080;
    const lastPort = options.lastPort ?? 8085;
    if (lastPort < firstPort || lastPort - firstPort > 5) {
      throw new RangeError("discovery scan must remain bounded to at most six ports");
    }
    for (let port = firstPort; port <= lastPort; port += 1) targets.push({ host, port });
  }

  const sessions: ProbedAddinSession[] = [];
  const rejectedTargets: Array<{ target: LoopbackTarget; reason: string }> = [];
  for (const target of targets) {
    try {
      assertLoopbackTarget(target);
      const client = await connector(target);
      try {
        const id = `discovery-${target.host}-${target.port}`;
        const response = await client.request(id, "mcp_status", {}, options.probeTimeoutMs ?? 1_000);
        sessions.push(parseStatus(target, client, response));
      } catch (error) {
        client.close();
        throw error;
      }
    } catch (error) {
      rejectedTargets.push({ target: { ...target }, reason: boundedError(error) });
    }
  }
  return {
    sessions,
    evidence: {
      source,
      probedTargets: targets.map((target) => ({ ...target })),
      acceptedTargets: sessions.map((session) => ({ ...session.target })),
      rejectedTargets,
      tempRegistryReads: 0,
      filesystemLocksCreated: 0,
    },
  };
}
