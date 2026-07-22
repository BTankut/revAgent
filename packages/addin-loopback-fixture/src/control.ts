import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import type { AddinLoopbackFixture } from "./fixture.js";
import { StrictJsonError, parseStrictJsonBytes } from "./strictJson.js";
import type {
  DocumentContextEvent,
  FaultPlan,
  FixtureEvidenceSnapshot,
  JsonObject,
  JsonValue,
} from "./types.js";

export const FIXTURE_CONTROL_VERSION = 1;
export const MAX_CONTROL_LINE_BYTES = 64 * 1024;

const MAX_ACTIVE_EVIDENCE_SNAPSHOTS = 4;
// These page sizes stay below 64 KiB even when every bounded string uses
// four-byte UTF-8 code points.
const OBSERVATIONS_PER_PAGE = 8;
const COUNTS_PER_PAGE = 16;

interface EvidenceCursor {
  observationOffset: number;
  executionCountOffset: number;
  methodCountOffset: number;
  pendingStallOffset: number;
}

interface ControlSuccess extends JsonObject {
  controlVersion: 1;
  id: string;
  ok: true;
  result: JsonValue;
}

interface ControlFailure extends JsonObject {
  controlVersion: 1;
  id: string | null;
  ok: false;
  error: JsonObject;
}

interface ControlResult {
  readonly response: ControlSuccess | ControlFailure;
  readonly shutdown: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown control field: ${unknown}`);
  const missing = required.find((key) => !(key in value));
  if (missing) throw new Error(`Missing control field: ${missing}`);
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error(`${label} must contain from 1 through 128 characters`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function parseCursor(value: unknown): EvidenceCursor {
  if (!isObject(value)) throw new Error("cursor must be an object");
  const keys = [
    "observationOffset",
    "executionCountOffset",
    "methodCountOffset",
    "pendingStallOffset",
  ] as const;
  exactKeys(value, keys);
  return {
    observationOffset: nonNegativeInteger(value.observationOffset, "cursor.observationOffset"),
    executionCountOffset: nonNegativeInteger(
      value.executionCountOffset,
      "cursor.executionCountOffset",
    ),
    methodCountOffset: nonNegativeInteger(value.methodCountOffset, "cursor.methodCountOffset"),
    pendingStallOffset: nonNegativeInteger(
      value.pendingStallOffset,
      "cursor.pendingStallOffset",
    ),
  };
}

function zeroCursor(): EvidenceCursor {
  return {
    observationOffset: 0,
    executionCountOffset: 0,
    methodCountOffset: 0,
    pendingStallOffset: 0,
  };
}

function evidencePage(
  snapshotId: string,
  snapshot: FixtureEvidenceSnapshot,
  cursor: EvidenceCursor,
): JsonObject {
  for (const [offset, length, label] of [
    [cursor.observationOffset, snapshot.observations.length, "observationOffset"],
    [cursor.executionCountOffset, snapshot.executionCounts.length, "executionCountOffset"],
    [cursor.methodCountOffset, snapshot.methodExecutionCounts.length, "methodCountOffset"],
    [cursor.pendingStallOffset, snapshot.pendingStalls.length, "pendingStallOffset"],
  ] as const) {
    if (offset > length) throw new Error(`cursor.${label} exceeds snapshot length`);
  }

  const observations = snapshot.observations.slice(
    cursor.observationOffset,
    cursor.observationOffset + OBSERVATIONS_PER_PAGE,
  );
  const executionCounts = snapshot.executionCounts.slice(
    cursor.executionCountOffset,
    cursor.executionCountOffset + COUNTS_PER_PAGE,
  );
  const methodExecutionCounts = snapshot.methodExecutionCounts.slice(
    cursor.methodCountOffset,
    cursor.methodCountOffset + COUNTS_PER_PAGE,
  );
  const pendingStalls = snapshot.pendingStalls.slice(
    cursor.pendingStallOffset,
    cursor.pendingStallOffset + COUNTS_PER_PAGE,
  );
  const nextCursor: EvidenceCursor = {
    observationOffset: cursor.observationOffset + observations.length,
    executionCountOffset: cursor.executionCountOffset + executionCounts.length,
    methodCountOffset: cursor.methodCountOffset + methodExecutionCounts.length,
    pendingStallOffset: cursor.pendingStallOffset + pendingStalls.length,
  };
  const complete =
    nextCursor.observationOffset === snapshot.observations.length &&
    nextCursor.executionCountOffset === snapshot.executionCounts.length &&
    nextCursor.methodCountOffset === snapshot.methodExecutionCounts.length &&
    nextCursor.pendingStallOffset === snapshot.pendingStalls.length;
  return {
    snapshotId,
    evidenceVersion: snapshot.evidenceVersion,
    fixtureContract: snapshot.fixtureContract,
    observations: observations as unknown as JsonValue,
    executionCounts: executionCounts as unknown as JsonValue,
    methodExecutionCounts: methodExecutionCounts as unknown as JsonValue,
    modelStateDigest: snapshot.modelStateDigest,
    modelStateEntryCount: snapshot.modelStateEntryCount,
    pendingStalls: pendingStalls as unknown as JsonValue,
    openSocketCount: snapshot.openSocketCount,
    crashed: snapshot.crashed,
    complete,
    nextCursor: complete ? null : nextCursor as unknown as JsonObject,
  };
}

function failure(id: string | null, code: string, message: string): ControlFailure {
  return {
    controlVersion: 1,
    id,
    ok: false,
    error: { code, message: message.slice(0, 600) },
  };
}

export class FixtureJsonlControl {
  readonly #snapshots = new Map<string, FixtureEvidenceSnapshot>();
  #buffer = Buffer.alloc(0);
  #discardingOversizeLine = false;
  #chain = Promise.resolve();
  #closed = false;
  readonly #onData = (chunk: Buffer): void => this.#consume(chunk);

  public constructor(
    private readonly fixture: AddinLoopbackFixture,
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onShutdown: () => void = () => undefined,
  ) {}

  public start(): void {
    if (this.#closed) throw new Error("Fixture JSONL control is closed");
    this.input.on("data", this.#onData);
    this.input.resume();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.input.off("data", this.#onData);
    this.input.pause();
    this.#buffer = Buffer.alloc(0);
  }

  #consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const segment = chunk.subarray(offset, end);
      if (!this.#discardingOversizeLine) {
        if (this.#buffer.byteLength + segment.byteLength > MAX_CONTROL_LINE_BYTES) {
          this.#buffer = Buffer.alloc(0);
          this.#discardingOversizeLine = true;
          this.#enqueueFailure(
            failure(
              null,
              "control_line_too_large",
              `Control line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`,
            ),
          );
        } else if (segment.byteLength > 0) {
          this.#buffer =
            this.#buffer.byteLength === 0
              ? Buffer.from(segment)
              : Buffer.concat([this.#buffer, segment]);
        }
      }
      if (newline >= 0) {
        if (!this.#discardingOversizeLine) {
          const line =
            this.#buffer.at(-1) === 0x0d
              ? this.#buffer.subarray(0, this.#buffer.byteLength - 1)
              : this.#buffer;
          this.#enqueueLine(Buffer.from(line));
        }
        this.#buffer = Buffer.alloc(0);
        this.#discardingOversizeLine = false;
        offset = newline + 1;
      } else {
        offset = chunk.byteLength;
      }
    }
  }

  #enqueueFailure(response: ControlFailure): void {
    this.#chain = this.#chain.then(() => this.#write(response));
  }

  #enqueueLine(line: Buffer): void {
    this.#chain = this.#chain
      .then(async () => {
        const result = await this.#handleLine(line);
        await this.#write(result.response);
        if (result.shutdown) {
          this.close();
          this.onShutdown();
        }
      })
      .catch(async (error: unknown) => {
        await this.#write(failure(null, "control_internal_error", String(error)));
      });
  }

  async #handleLine(line: Buffer): Promise<ControlResult> {
    if (line.byteLength === 0) {
      return { response: failure(null, "invalid_control_json", "Control line is empty"), shutdown: false };
    }
    let value: unknown;
    try {
      value = parseStrictJsonBytes(line, MAX_CONTROL_LINE_BYTES);
    } catch (error) {
      const code = error instanceof StrictJsonError ? error.code : "invalid_json";
      return {
        response: failure(null, `control_${code}`, error instanceof Error ? error.message : String(error)),
        shutdown: false,
      };
    }
    if (!isObject(value)) {
      return { response: failure(null, "invalid_control_shape", "Control record must be an object"), shutdown: false };
    }
    const correlationId =
      typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 128
        ? value.id
        : null;
    try {
      if (value.controlVersion !== FIXTURE_CONTROL_VERSION) {
        throw new Error("controlVersion must equal 1");
      }
      const id = boundedId(value.id, "id");
      if (typeof value.action !== "string") throw new Error("action must be a string");
      const result = await this.#execute(value, id);
      return {
        response: { controlVersion: 1, id, ok: true, result: result.value },
        shutdown: result.shutdown,
      };
    } catch (error) {
      return {
        response: failure(
          correlationId,
          "invalid_control_request",
          error instanceof Error ? error.message : String(error),
        ),
        shutdown: false,
      };
    }
  }

  async #execute(
    record: JsonObject,
    id: string,
  ): Promise<{ value: JsonValue; shutdown: boolean }> {
    switch (record.action) {
      case "plan_fault": {
        exactKeys(record, ["controlVersion", "id", "action", "requestId", "fault"]);
        const requestId = boundedId(record.requestId, "requestId");
        if (!isObject(record.fault)) throw new Error("fault must be an object");
        this.fixture.planFault(requestId, record.fault as unknown as FaultPlan);
        return { value: { queued: true, requestId }, shutdown: false };
      }
      case "release_stall": {
        exactKeys(record, ["controlVersion", "id", "action", "requestId"]);
        const requestId = boundedId(record.requestId, "requestId");
        const released = this.fixture.releaseStall(requestId);
        return {
          value: {
            released,
            requestId,
            pending: this.fixture.getPendingStallCount(requestId),
          },
          shutdown: false,
        };
      }
      case "apply_document_context": {
        exactKeys(record, ["controlVersion", "id", "action", "event"]);
        if (!isObject(record.event)) throw new Error("event must be an object");
        const snapshot = this.fixture.applyDocumentContextEvent(
          record.event as unknown as DocumentContextEvent,
        );
        return { value: snapshot as unknown as JsonObject, shutdown: false };
      }
      case "snapshot_evidence": {
        exactKeys(record, ["controlVersion", "id", "action"], ["snapshotId", "cursor"]);
        let snapshotId: string;
        let snapshot: FixtureEvidenceSnapshot;
        let cursor: EvidenceCursor;
        if (record.snapshotId === undefined) {
          if (record.cursor !== undefined) throw new Error("cursor requires snapshotId");
          if (this.#snapshots.size >= MAX_ACTIVE_EVIDENCE_SNAPSHOTS) {
            throw new Error(`At most ${MAX_ACTIVE_EVIDENCE_SNAPSHOTS} evidence snapshots may be active`);
          }
          snapshotId = id;
          if (this.#snapshots.has(snapshotId)) throw new Error("snapshot id already exists");
          snapshot = this.fixture.snapshotEvidence();
          cursor = zeroCursor();
          this.#snapshots.set(snapshotId, snapshot);
        } else {
          snapshotId = boundedId(record.snapshotId, "snapshotId");
          snapshot = this.#snapshots.get(snapshotId) as FixtureEvidenceSnapshot;
          if (!snapshot) throw new Error("snapshotId is unknown or complete");
          cursor = parseCursor(record.cursor);
        }
        const page = evidencePage(snapshotId, snapshot, cursor);
        if (page.complete === true) this.#snapshots.delete(snapshotId);
        return { value: page, shutdown: false };
      }
      case "shutdown": {
        exactKeys(record, ["controlVersion", "id", "action"]);
        await this.fixture.stop();
        const evidence = this.fixture.snapshotEvidence();
        return {
          value: {
            stopped: true,
            openSocketCount: evidence.openSocketCount,
            pendingStallCount: evidence.pendingStalls.reduce(
              (sum, entry) => sum + entry.count,
              0,
            ),
            modelStateDigest: evidence.modelStateDigest,
            modelStateEntryCount: evidence.modelStateEntryCount,
          },
          shutdown: true,
        };
      }
      default:
        throw new Error(`Unsupported control action: ${String(record.action)}`);
    }
  }

  async #write(response: ControlSuccess | ControlFailure): Promise<void> {
    let bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (bytes.byteLength > MAX_CONTROL_LINE_BYTES) {
      bytes = Buffer.from(
        `${JSON.stringify(
          failure(
            typeof response.id === "string" ? response.id : null,
            "control_response_too_large",
            `Control response exceeds ${MAX_CONTROL_LINE_BYTES} bytes`,
          ),
        )}\n`,
        "utf8",
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.output.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
}
