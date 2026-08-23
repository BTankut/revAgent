import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sanitizedProductionRuntimeEnvironment } from "./productionRuntimeIdentity.js";
import type { ComponentId, ProcessCommandDescriptor, ProcessEvidence } from "./types.js";

export const MAX_CONTROL_LINE_BYTES = 64 * 1024;
export const MAX_PROCESS_TRANSCRIPT_RECORDS = 128;
export const REAL_TRIO_PROCESS_START_FAILURE_SCHEMA =
  "rbp-real-trio-process-start-failure/v1" as const;
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
}

function readinessExitError(
  componentId: ComponentId,
  code: number | null,
  signal: NodeJS.Signals | null,
  transcript: readonly ProcessTranscriptRecord[],
  trailingStderr = Buffer.alloc(0),
): Error {
  const stderrLines = transcript
    .filter((entry) => entry.stream === "stderr")
    .slice(-8)
    .map((entry) => entry.line);
  if (trailingStderr.length > 0) {
    try {
      const trailing = decodeUtf8(trailingStderr, `${componentId} trailing stderr`).trimEnd();
      if (trailing.length > 0) stderrLines.push(trailing);
    } catch {
      stderrLines.push("<invalid-utf8>");
    }
  }
  const stderr = stderrLines.map(redactDiagnosticLine).join(" | ");
  const excerpt = stderr.length <= 4_096 ? stderr : stderr.slice(-4_096);
  return new Error(
    `${componentId} exited before readiness (${String(code ?? signal)})${
      excerpt.length === 0 ? "" : `; stderr: ${excerpt}`
    }`,
  );
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

export interface ProcessEvidenceDirectoryOptions {
  /** Caller-selected test evidence directory; no runtime path is inferred. */
  readonly evidenceDirectory?: string;
}

interface ProcessFailureEvidence {
  readonly schemaVersion: typeof REAL_TRIO_PROCESS_START_FAILURE_SCHEMA;
  readonly component: string;
  readonly phase: string;
  readonly commandHash: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Readonly<{ readonly hash: string; readonly safeLines: readonly string[] }>;
  readonly stderr: Readonly<{ readonly hash: string; readonly safeLines: readonly string[] }>;
  readonly timeline: readonly string[];
}

function appendBoundedTranscript(target: ProcessTranscriptRecord[], record: ProcessTranscriptRecord): void {
  target.push(record);
  if (target.length > MAX_PROCESS_TRANSCRIPT_RECORDS) target.splice(0, target.length - MAX_PROCESS_TRANSCRIPT_RECORDS);
}

/** Safe, bounded process evidence for real-trio failure diagnostics. */
export interface ProcessDiagnosticSnapshot {
  readonly componentId: string;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const MAX_DIAGNOSTIC_LINES_PER_STREAM = 8;
const MAX_DIAGNOSTIC_LINE_BYTES = 512;

function redactDiagnosticText(input: string): string {
  return input
    .replace(/(bearer|token|secret|proof|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/[A-Za-z]:\\[^\s,;]+/gu, "[path-redacted]")
    .replace(/\/[^\s,;]+/gu, (value) => value.startsWith("//") ? value : "[path-redacted]");
}

function redactDiagnosticLine(input: string): string {
  let redacted = redactDiagnosticText(input);
  try {
    const parsed = JSON.parse(input) as unknown;
    const redactValue = (value: unknown, key = ""): unknown => {
      if (/(?:token|secret|proof|password|bearer|payload|document(?:id)?|path|command|args)/iu.test(key)) {
        return "[redacted]";
      }
      if (typeof value === "string") return redactDiagnosticText(value);
      if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
      }
      return value;
    };
    redacted = JSON.stringify(redactValue(parsed));
  } catch {
    // Non-JSON diagnostics retain their bounded pattern redaction above.
  }
  const bytes = Buffer.from(redacted, "utf8");
  return bytes.length <= MAX_DIAGNOSTIC_LINE_BYTES
    ? redacted
    : `${bytes.subarray(0, MAX_DIAGNOSTIC_LINE_BYTES - 16).toString("utf8")}…[truncated]`;
}

/**
 * Writes only redacted, bounded child output.  Raw chunks never leave memory
 * and are represented in failure artifacts solely by SHA-256 digests.
 */
class ProcessEvidenceRecorder {
  readonly #stdout = createHash("sha256");
  readonly #stderr = createHash("sha256");
  readonly #safeLines: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  readonly #partial: Record<"stdout" | "stderr", Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  readonly #timeline: string[] = ["spawn_requested"];
  #pid: number | null = null;
  #exitCode: number | null = null;
  #signal: string | null = null;

  constructor(
    private readonly component: string,
    private readonly commandHash: string,
    private readonly evidenceDirectory: string | undefined,
  ) {
    if (evidenceDirectory !== undefined) mkdirSync(evidenceDirectory, { recursive: true });
  }

  spawned(pid: number | undefined): void {
    this.#pid = pid ?? null;
    this.#timeline.push(this.#pid === null ? "spawn_without_pid" : "spawned");
  }

  exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exitCode = code;
    this.#signal = signal;
    this.#timeline.push("child_exit");
  }

  observeChunk(stream: "stdout" | "stderr", chunk: Buffer): void {
    (stream === "stdout" ? this.#stdout : this.#stderr).update(chunk);
    const buffer = Buffer.concat([this.#partial[stream], chunk]);
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    this.#partial[stream] = Buffer.from(lines.pop() ?? "", "utf8");
    for (const line of lines) this.#record(stream, line);
  }

  failure(phase: string): void {
    this.#timeline.push(`failure:${phase}`);
    this.#flushPartials();
    if (this.evidenceDirectory === undefined) return;
    const failure: ProcessFailureEvidence = Object.freeze({
      schemaVersion: REAL_TRIO_PROCESS_START_FAILURE_SCHEMA,
      component: this.component,
      phase,
      commandHash: this.commandHash,
      pid: this.#pid,
      exitCode: this.#exitCode,
      signal: this.#signal,
      stdout: Object.freeze({ hash: `sha256:${this.#stdout.copy().digest("hex")}`, safeLines: Object.freeze([...this.#safeLines.stdout]) }),
      stderr: Object.freeze({ hash: `sha256:${this.#stderr.copy().digest("hex")}`, safeLines: Object.freeze([...this.#safeLines.stderr]) }),
      timeline: Object.freeze([...this.#timeline]),
    });
    const destination = path.join(this.evidenceDirectory, `${this.component}.start-failure.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(failure)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  }

  #record(stream: "stdout" | "stderr", line: string): void {
    const safe = redactDiagnosticLine(line);
    const retained = this.#safeLines[stream];
    retained.push(safe);
    if (retained.length > MAX_DIAGNOSTIC_LINES_PER_STREAM) retained.splice(0, retained.length - MAX_DIAGNOSTIC_LINES_PER_STREAM);
    if (this.evidenceDirectory !== undefined) {
      appendFileSync(path.join(this.evidenceDirectory, `${this.component}.${stream}.log`), `${safe}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  #flushPartials(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const partial = this.#partial[stream];
      if (partial.length === 0) continue;
      this.#partial[stream] = Buffer.alloc(0);
      this.#record(stream, partial.toString("utf8"));
    }
  }
}

function processCommandHash(command: ProcessCommandDescriptor): string {
  const canonical = JSON.stringify({ executable: command.executable, args: command.args, workingDirectory: command.workingDirectory });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function boundedProcessDiagnostics(input: {
  readonly componentId: string;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly transcript: readonly ProcessTranscriptRecord[];
}): ProcessDiagnosticSnapshot {
  const lines = (stream: "stdout" | "stderr"): readonly string[] => Object.freeze(
    input.transcript
      .filter((record) => record.stream === stream)
      .slice(-MAX_DIAGNOSTIC_LINES_PER_STREAM)
      .map((record) => redactDiagnosticLine(record.line)),
  );
  return Object.freeze({
    componentId: input.componentId,
    phase: input.phase,
    exitCode: input.exitCode,
    stdout: lines("stdout"),
    stderr: lines("stderr"),
  });
}

export class ReadyProcessStartError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ProcessDiagnosticSnapshot,
  ) {
    super(message);
    this.name = "ReadyProcessStartError";
  }
}

export interface JsonlProcessOptions extends ProcessEvidenceDirectoryOptions {
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
    const evidence = new ProcessEvidenceRecorder(
      options.componentId,
      processCommandHash(options.command),
      options.evidenceDirectory,
    );
    const child = spawn(options.command.executable, options.command.args, {
      cwd: options.absoluteWorkingDirectory,
      env: sanitizedProductionRuntimeEnvironment(process.env, options.environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    evidence.spawned(child.pid);
    if (child.pid === undefined) {
      evidence.failure("spawn");
      throw new Error(`${options.componentId} did not receive a process id`);
    }

    const transcript: ProcessTranscriptRecord[] = [];
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let settled = false;
    const active: { instance?: StrictJsonlProcess } = {};
    const appendTranscript = (record: ProcessTranscriptRecord): void => {
      appendBoundedTranscript(transcript, record);
      if (active.instance !== undefined) appendBoundedTranscript(active.instance.transcript, record);
    };
    const readiness = new Promise<{ value: JsonlReadiness; at: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${options.componentId} readiness timed out`));
        child.kill("SIGTERM");
      }, options.command.readiness.timeoutMs);
      const fail = (error: Error): void => {
        evidence.failure("pre_ready");
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
      child.once("close", (code, signal) => {
        evidence.exited(code, signal);
        if (!settled) {
          fail(readinessExitError(
            options.componentId,
            code,
            signal,
            transcript,
            stderrBuffer,
          ));
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stdout", chunk);
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
        evidence.observeChunk("stderr", chunk);
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
    for (const record of transcript) appendBoundedTranscript(active.instance.transcript, record);
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

  /**
   * Conformance-only crash boundary.  Unlike `stop`, this does not send a
   * component-private control action: it terminates the actual child process
   * and waits for its observed exit before a supervisor may relaunch it.
   */
  async terminateForConformance(): Promise<{ stoppedAt: string; exitCode: number; killEscalated: boolean }> {
    let killEscalated = false;
    if (this.process.exitCode === null) this.child.kill("SIGTERM");
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

export interface ReadyProcessOptions extends ProcessEvidenceDirectoryOptions {
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
    const evidence = new ProcessEvidenceRecorder(
      options.componentId,
      processCommandHash(options.command),
      options.evidenceDirectory,
    );
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
    evidence.spawned(child.pid);
    if (child.pid === undefined) {
      evidence.failure("spawn");
      throw new Error(`${options.componentId} did not receive a process id`);
    }
    const transcript: ProcessTranscriptRecord[] = [];
    let observedExitCode: number | null = null;
    child.once("exit", (code, signal) => {
      observedExitCode = code ?? (signal === null ? 1 : 128);
      evidence.exited(code, signal);
    });
    let ready: { value: JsonObject; at: string };
    try {
      ready = await new Promise<{ value: JsonObject; at: string }>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const fail = (error: Error): void => {
        evidence.failure("pre_ready");
        reject(error);
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        fail(new Error(`${options.componentId} readiness timed out`));
      }, options.command.readiness.timeoutMs);
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        if (!settled) fail(new Error(`${options.componentId} exited before readiness (${String(code ?? signal)})`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stdout", chunk);
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_CONTROL_LINE_BYTES && !buffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} readiness exceeds 64 KiB`));
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
          appendBoundedTranscript(transcript, { stream: "stdout", at, line: decodeUtf8(line, `${options.componentId} readiness`) });
          resolve({ value, at });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stderr", chunk);
        let line: string;
        try {
          line = decodeUtf8(chunk, `${options.componentId} stderr`).trimEnd();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
          fail(new Error(`${options.componentId} stderr chunk exceeds 64 KiB`));
          return;
        }
        if (line.length > 0) appendBoundedTranscript(transcript, { stream: "stderr", at: new Date().toISOString(), line });
      });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReadyProcessStartError(
        message,
        boundedProcessDiagnostics({
          componentId: options.componentId,
          phase: "ready",
          exitCode: observedExitCode,
          transcript,
        }),
      );
    }
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
