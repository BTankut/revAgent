import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";

import { sanitizedProductionRuntimeEnvironment } from "./productionRuntimeIdentity.js";
import type { ComponentId, ProcessCommandDescriptor, ProcessEvidence } from "./types.js";

export const MAX_CONTROL_LINE_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
}

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonlReadiness extends JsonObject {
  ready: true;
  controlVersion: 1;
  maxControlLineBytes: 65536;
  actions: JsonValue[];
}

export interface ProcessTranscriptRecord {
  stream: "stdout" | "stderr";
  at: string;
  line: string;
}

export interface JsonlProcessOptions {
  componentId: ComponentId;
  command: ProcessCommandDescriptor;
  absoluteWorkingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  expectedReadinessFields: Readonly<Record<string, JsonValue>>;
  requiredActions: readonly string[];
}

interface PendingResponse {
  id: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface StartedControlRequest {
  id: string;
  response: Promise<JsonValue>;
}

export class ControlResponseError extends Error {
  constructor(
    readonly componentId: ComponentId,
    readonly correlationId: string,
    readonly code: string,
    readonly controlMessage: string,
  ) {
    super(`${componentId} control failed: ${code} ${controlMessage}`);
    this.name = "ControlResponseError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(bytes: Buffer, label: string): JsonObject {
  let text: string;
  try {
    text = decodeUtf8(bytes, label);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
  if (text.length === 0 || text.startsWith("\uFEFF")) throw new Error(`${label} is empty or BOM-prefixed`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function assertExactResponseShape(value: JsonObject): void {
  const success = value.ok === true;
  const expected = success
    ? ["controlVersion", "id", "ok", "result"]
    : ["controlVersion", "error", "id", "ok"];
  const actual = Object.keys(value).sort();
  expected.sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error("control response has unknown or missing fields");
  }
  if (value.controlVersion !== 1 || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
    throw new Error("control response identity is invalid");
  }
  if (!success && !isObject(value.error)) throw new Error("control error response is missing its error object");
}

function assertReadiness(
  value: JsonObject,
  expectedFields: Readonly<Record<string, JsonValue>>,
  requiredActions: readonly string[],
): asserts value is JsonlReadiness {
  if (value.ready !== true || value.controlVersion !== 1 || value.maxControlLineBytes !== MAX_CONTROL_LINE_BYTES) {
    throw new Error("component readiness lacks the strict ready/controlVersion/maxControlLineBytes contract");
  }
  for (const [key, expected] of Object.entries(expectedFields)) {
    if (JSON.stringify(value[key]) !== JSON.stringify(expected)) {
      throw new Error(`component readiness field ${key} does not match the execution contract`);
    }
  }
  if (!Array.isArray(value.actions) || !value.actions.every((entry) => typeof entry === "string")) {
    throw new Error("component readiness actions must be a string array");
  }
  const actions = new Set(value.actions as string[]);
  const missing = requiredActions.filter((action) => !actions.has(action));
  if (missing.length > 0) throw new Error(`component readiness is missing controls: ${missing.join(", ")}`);
}

export class StrictJsonlProcess {
  readonly transcript: ProcessTranscriptRecord[] = [];
  readonly process: ProcessEvidence;
  readonly readiness: JsonlReadiness;
  readonly pid: number;
  #sequentialTail = Promise.resolve<void>(undefined);
  readonly #pending = new Map<string, PendingResponse>();
  readonly #responseOrder: string[] = [];
  #closed = false;
  #exit: Promise<{ code: number; at: string }>;
  #exitResolve!: (value: { code: number; at: string }) => void;
  #controlCounter = 0;

  private constructor(
    readonly componentId: ComponentId,
    private readonly child: ChildProcessWithoutNullStreams,
    readiness: JsonlReadiness,
    startedAt: string,
    readyAt: string,
  ) {
    this.readiness = readiness;
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${componentId} lost its process id`);
    this.pid = pid;
    this.process = { pid, startedAt, readyAt, stoppedAt: null, exitCode: null };
    this.#exit = new Promise((resolve) => { this.#exitResolve = resolve; });
    child.once("exit", (code, signal) => {
      const at = new Date().toISOString();
      const normalized = code ?? (signal === null ? 1 : 128);
      this.process.stoppedAt = at;
      this.process.exitCode = normalized;
      this.#closed = true;
      this.#rejectAllPending(new Error(`${this.componentId} exited before control response`));
      this.#exitResolve({ code: normalized, at });
    });
  }

  static async start(options: JsonlProcessOptions): Promise<StrictJsonlProcess> {
    const startedAt = new Date().toISOString();
    const child = spawn(options.command.executable, options.command.args, {
      cwd: options.absoluteWorkingDirectory,
      env: sanitizedProductionRuntimeEnvironment(process.env, options.environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error(`${options.componentId} did not receive a process id`);

    const transcript: ProcessTranscriptRecord[] = [];
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let settled = false;
    const active: { instance?: StrictJsonlProcess } = {};
    const appendTranscript = (record: ProcessTranscriptRecord): void => {
      transcript.push(record);
      active.instance?.transcript.push(record);
    };
    const readiness = new Promise<{ value: JsonlReadiness; at: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${options.componentId} readiness timed out`));
        child.kill("SIGTERM");
      }, options.command.readiness.timeoutMs);
      const fail = (error: Error): void => {
        if (settled) {
          child.kill("SIGTERM");
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
        child.kill("SIGTERM");
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (!settled) fail(new Error(`${options.componentId} exited before readiness (${String(code ?? signal)})`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        if (stdoutBuffer.length > MAX_CONTROL_LINE_BYTES && !stdoutBuffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} stdout line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
          return;
        }
        while (true) {
          const newline = stdoutBuffer.indexOf(0x0a);
          if (newline < 0) break;
          let line = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length > MAX_CONTROL_LINE_BYTES) {
            fail(new Error(`${options.componentId} stdout line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
            return;
          }
          let lineText: string;
          try { lineText = decodeUtf8(line, `${options.componentId} stdout line`); } catch { lineText = "<invalid-utf8>"; }
          appendTranscript({ stream: "stdout", at: new Date().toISOString(), line: lineText });
          try {
            const parsed = parseJsonObject(line, `${options.componentId} stdout line`);
            if (!settled) {
              assertReadiness(parsed, options.expectedReadinessFields, options.requiredActions);
              settled = true;
              clearTimeout(timer);
              const at = new Date().toISOString();
              resolve({ value: parsed, at });
            } else if (active.instance !== undefined) {
              active.instance.#consumeResponse(parsed);
            } else {
              fail(new Error(`${options.componentId} emitted stdout between readiness and control activation`));
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
        if (stderrBuffer.length > MAX_CONTROL_LINE_BYTES && !stderrBuffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} stderr line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
          return;
        }
        while (true) {
          const newline = stderrBuffer.indexOf(0x0a);
          if (newline < 0) break;
          let line = stderrBuffer.subarray(0, newline);
          stderrBuffer = stderrBuffer.subarray(newline + 1);
          if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
          try {
            appendTranscript({ stream: "stderr", at: new Date().toISOString(), line: decodeUtf8(line, `${options.componentId} stderr line`) });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
    const ready = await readiness;
    active.instance = new StrictJsonlProcess(options.componentId, child, ready.value, startedAt, ready.at);
    active.instance.transcript.push(...transcript);
    return active.instance;
  }

  #consumeResponse(value: JsonObject): void {
    try {
      assertExactResponseShape(value);
      const id = value.id as string;
      const expectedId = this.#responseOrder[0];
      const pending = this.#pending.get(id);
      if (pending === undefined || id !== expectedId) {
        throw new Error(`${this.componentId} emitted an unsolicited or out-of-order control response`);
      }
      this.#responseOrder.shift();
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (value.ok === true) pending.resolve(value.result as JsonValue);
      else {
        const error = value.error as JsonObject;
        pending.reject(new ControlResponseError(
          this.componentId,
          id,
          String(error.code),
          String(error.message),
        ));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#rejectAllPending(failure);
      this.child.kill("SIGTERM");
    }
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#responseOrder.length = 0;
  }

  #beginRequest(
    action: string,
    fields: Readonly<Record<string, JsonValue>>,
    timeoutMs: number,
  ): StartedControlRequest {
    const id = `${this.componentId}-${++this.#controlCounter}`;
    const response = new Promise<JsonValue>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(`${this.componentId} is closed`));
        return;
      }
      if (!this.readiness.actions.includes(action)) {
        reject(new Error(`${this.componentId} did not advertise control action ${action}`));
        return;
      }
      const record = { controlVersion: 1, id, action, ...fields };
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (bytes.length > MAX_CONTROL_LINE_BYTES) {
        reject(new Error(`${this.componentId} control request exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        const failure = new Error(`${this.componentId} control ${action} timed out`);
        this.#rejectAllPending(failure);
        this.child.kill("SIGTERM");
      }, timeoutMs);
      this.#pending.set(id, { id, resolve, reject, timer });
      this.#responseOrder.push(id);
      this.child.stdin.write(bytes, (error) => {
        if (error !== undefined && error !== null && this.#pending.has(id)) {
          this.#rejectAllPending(error);
          this.child.kill("SIGTERM");
        }
      });
    });
    return { id, response };
  }

  startConcurrentRequest(
    action: string,
    fields: Readonly<Record<string, JsonValue>> = {},
    timeoutMs = 30_000,
  ): StartedControlRequest {
    const started = this.#beginRequest(action, fields, timeoutMs);
    // An explicitly non-awaited request is joined later by correlation id. Keep
    // Node from treating the intentional gap as an unhandled rejection.
    void started.response.catch(() => undefined);
    return started;
  }

  requestConcurrent(
    action: string,
    fields: Readonly<Record<string, JsonValue>> = {},
    timeoutMs = 30_000,
  ): Promise<JsonValue> {
    return this.startConcurrentRequest(action, fields, timeoutMs).response;
  }

  request(action: string, fields: Readonly<Record<string, JsonValue>> = {}, timeoutMs = 30_000): Promise<JsonValue> {
    const response = this.#sequentialTail.then(async () =>
      await this.#beginRequest(action, fields, timeoutMs).response);
    this.#sequentialTail = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  async stop(): Promise<{ stoppedAt: string; exitCode: number; killEscalated: boolean }> {
    let killEscalated = false;
    if (!this.#closed) {
      try { await this.request("shutdown", {}, this.process.readyAt === null ? 1_000 : 10_000); }
      catch { this.child.kill("SIGTERM"); }
    }
    const forced = setTimeout(() => {
      killEscalated = true;
      this.child.kill("SIGKILL");
    }, 10_000);
    const exit = await this.#exit;
    clearTimeout(forced);
    return { stoppedAt: exit.at, exitCode: exit.code, killEscalated };
  }
}

export interface HttpControlResponse {
  status: number;
  body: JsonObject;
}

export interface ReadyProcessOptions {
  componentId: ComponentId;
  command: ProcessCommandDescriptor;
  absoluteWorkingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * On Windows, Node cannot deliver POSIX signals with child.kill(). The
   * Gateway CLI exposes a test-only IPC signal proxy so the supervised
   * process can still execute its real graceful signal handler and exit 0.
   */
  useTestSignalProxy?: boolean;
  validateReadiness(value: JsonObject): void;
}

export class StrictReadyProcess {
  readonly transcript: ProcessTranscriptRecord[];
  readonly readiness: JsonObject;
  readonly process: ProcessEvidence;
  readonly pid: number;
  #exit: Promise<{ code: number; at: string }>;

  private constructor(
    readonly componentId: ComponentId,
    private readonly child: ChildProcessWithoutNullStreams,
    readiness: JsonObject,
    transcript: ProcessTranscriptRecord[],
    startedAt: string,
    readyAt: string,
    private readonly useTestSignalProxy: boolean,
  ) {
    this.readiness = readiness;
    this.transcript = transcript;
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${componentId} lost its process id`);
    this.pid = pid;
    this.process = { pid, startedAt, readyAt, stoppedAt: null, exitCode: null };
    this.#exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const at = new Date().toISOString();
        const normalized = code ?? (signal === null ? 1 : 128);
        this.process.stoppedAt = at;
        this.process.exitCode = normalized;
        resolve({ code: normalized, at });
      });
    });
  }

  static async start(options: ReadyProcessOptions): Promise<StrictReadyProcess> {
    const startedAt = new Date().toISOString();
    const child = spawn(options.command.executable, options.command.args, {
      cwd: options.absoluteWorkingDirectory,
      env: sanitizedProductionRuntimeEnvironment(process.env, {
        ...options.environment,
        ...(options.useTestSignalProxy === true ? { NODE_ENV: "test" } : {}),
      }),
      shell: false,
      stdio: options.useTestSignalProxy === true
        ? ["pipe", "pipe", "pipe", "ipc"]
        : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    if (child.pid === undefined) throw new Error(`${options.componentId} did not receive a process id`);
    const transcript: ProcessTranscriptRecord[] = [];
    const ready = await new Promise<{ value: JsonObject; at: string }>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        reject(new Error(`${options.componentId} readiness timed out`));
        child.kill("SIGTERM");
      }, options.command.readiness.timeoutMs);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (!settled) reject(new Error(`${options.componentId} exited before readiness (${String(code ?? signal)})`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_CONTROL_LINE_BYTES && !buffer.includes(0x0a)) {
          reject(new Error(`${options.componentId} readiness exceeds 64 KiB`));
          child.kill("SIGTERM");
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let line = buffer.subarray(0, newline);
        if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
        try {
          const value = parseJsonObject(line, `${options.componentId} readiness`);
          options.validateReadiness(value);
          settled = true;
          clearTimeout(timer);
          const at = new Date().toISOString();
          transcript.push({ stream: "stdout", at, line: decodeUtf8(line, `${options.componentId} readiness`) });
          resolve({ value, at });
        } catch (error) {
          reject(error);
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        let line: string;
        try {
          line = decodeUtf8(chunk, `${options.componentId} stderr`).trimEnd();
        } catch (error) {
          child.kill("SIGTERM");
          reject(error);
          return;
        }
        if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
          child.kill("SIGTERM");
          reject(new Error(`${options.componentId} stderr chunk exceeds 64 KiB`));
          return;
        }
        if (line.length > 0) transcript.push({ stream: "stderr", at: new Date().toISOString(), line });
      });
    });
    return new StrictReadyProcess(
      options.componentId,
      child,
      ready.value,
      transcript,
      startedAt,
      ready.at,
      options.useTestSignalProxy === true,
    );
  }

  async stop(
    signal: NodeJS.Signals = "SIGTERM",
    timeoutMs = 10_000,
  ): Promise<{ stoppedAt: string; exitCode: number; killEscalated: boolean }> {
    let killEscalated = false;
    if (this.process.exitCode === null) {
      let signalled = false;
      if (
        process.platform === "win32" &&
        this.useTestSignalProxy &&
        this.child.connected &&
        this.child.send !== undefined
      ) {
        try {
          signalled = this.child.send({ action: "emit_test_signal", signal });
        } catch {
          signalled = false;
        }
      }
      if (!signalled) this.child.kill(signal);
    }
    const timer = setTimeout(() => {
      killEscalated = true;
      this.child.kill("SIGKILL");
    }, timeoutMs);
    const exit = await this.#exit;
    clearTimeout(timer);
    return { stoppedAt: exit.at, exitCode: exit.code, killEscalated };
  }
}

export async function strictHttpControl(
  url: string,
  token: string,
  request: JsonObject,
  timeoutMs = 30_000,
): Promise<HttpControlResponse> {
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  if (bytes.length > MAX_CONTROL_LINE_BYTES) throw new Error("Gateway control request exceeds 64 KiB");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rbp-test-control": token },
    body: bytes,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  if (bodyBytes.length > MAX_CONTROL_LINE_BYTES) throw new Error("Gateway control response exceeds 64 KiB");
  return { status: response.status, body: parseJsonObject(bodyBytes, "Gateway control response") };
}
