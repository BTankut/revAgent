import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import type { GatewayEventEnvelope } from "./events.js";
import { validateEu12EventEnvelope } from "./eventPersistence.js";
import type { ResultObjectStore } from "./resultReferenceStore.js";

export type RetentionArchiveState = "prepared" | "uploaded" | "dropped";
export type RetentionArchiveClass = "standard_12m" | "lifecycle_24m" | "legacy_mixed_008";

export interface RetentionArchiveRun {
  readonly tenantId: string;
  readonly month: string;
  /** Durable stores expose the class-specific leaf; memory fixtures omit it. */
  readonly retentionClass?: RetentionArchiveClass;
  readonly state: RetentionArchiveState;
  readonly archiveKey: string;
  readonly archiveDigest: `sha256:${string}`;
  readonly eventCount: number;
  readonly attempts: number;
}

export interface RetentionArchiveEventSource {
  listForRetention(input: { readonly tenantId: string; readonly month: string }): Promise<readonly GatewayEventEnvelope[]>;
  dropArchived(input: { readonly tenantId: string; readonly eventIds: readonly string[] }): Promise<number>;
}

interface InternalRun {
  readonly run: RetentionArchiveRun;
  readonly eventIds: readonly string[];
  readonly compressed: Uint8Array;
}

function archiveId(tenantId: string, month: string): string {
  return `${tenantId}/${month}`;
}

function archiveKey(tenantId: string, month: string): string {
  return `archive/${tenantId}/events/${month}.ndjson.zst`;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function immutableRun(run: RetentionArchiveRun): RetentionArchiveRun {
  return Object.freeze({ ...run });
}

function assertScope(tenantId: string, month: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(tenantId)) throw new Error("retention tenant is invalid");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("retention month must be YYYY-MM");
}

export interface RetentionArchiveRunnerOptions {
  readonly objects: ResultObjectStore;
  readonly events: RetentionArchiveEventSource;
  readonly afterObjectWrite?: (run: RetentionArchiveRun) => Promise<void> | void;
}

/**
 * The run ledger advances only after the object write succeeds. Replaying an
 * interrupted run writes the same object key and only then retries the drop.
 */
export class RetentionArchiveRunner {
  readonly #objects: ResultObjectStore;
  readonly #events: RetentionArchiveEventSource;
  readonly #afterObjectWrite: ((run: RetentionArchiveRun) => Promise<void> | void) | undefined;
  readonly #runs = new Map<string, InternalRun>();

  public constructor(options: RetentionArchiveRunnerOptions) {
    this.#objects = options.objects;
    this.#events = options.events;
    this.#afterObjectWrite = options.afterObjectWrite;
  }

  public getRun(input: { readonly tenantId: string; readonly month: string }): RetentionArchiveRun | null {
    assertScope(input.tenantId, input.month);
    return this.#runs.get(archiveId(input.tenantId, input.month))?.run ?? null;
  }

  public async archive(input: { readonly tenantId: string; readonly month: string }): Promise<RetentionArchiveRun> {
    assertScope(input.tenantId, input.month);
    const id = archiveId(input.tenantId, input.month);
    let internal = this.#runs.get(id);
    if (internal === undefined) {
      const events = await this.#events.listForRetention(input);
      const canonical = events
        .map((event) => canonicalizeJson(event as unknown as JsonValue))
        .join("\n");
      const ndjson = Buffer.from(canonical.length === 0 ? "" : `${canonical}\n`, "utf8");
      const run = immutableRun({
        tenantId: input.tenantId,
        month: input.month,
        state: "prepared",
        archiveKey: archiveKey(input.tenantId, input.month),
        archiveDigest: digest(ndjson),
        eventCount: events.length,
        attempts: 0,
      });
      internal = Object.freeze({
        run,
        eventIds: Object.freeze(events.map((event) => event.event_id)),
        compressed: new Uint8Array(zstdCompressSync(ndjson)),
      });
      this.#runs.set(id, internal);
    }
    if (internal.run.state === "dropped") return internal.run;

    const uploading = immutableRun({ ...internal.run, state: "prepared", attempts: internal.run.attempts + 1 });
    internal = Object.freeze({ ...internal, run: uploading });
    this.#runs.set(id, internal);
    await this.#objects.put({ key: internal.run.archiveKey, bytes: internal.compressed });
    await this.#afterObjectWrite?.(internal.run);

    const uploaded = immutableRun({ ...internal.run, state: "uploaded" });
    internal = Object.freeze({ ...internal, run: uploaded });
    this.#runs.set(id, internal);
    await this.#events.dropArchived({ tenantId: input.tenantId, eventIds: internal.eventIds });
    const remaining = await this.#events.listForRetention(input);
    const remainingIds = new Set(remaining.map((event) => event.event_id));
    if (internal.eventIds.some((eventId) => remainingIds.has(eventId))) return internal.run;

    const dropped = immutableRun({ ...internal.run, state: "dropped" });
    internal = Object.freeze({ ...internal, run: dropped });
    this.#runs.set(id, internal);
    return internal.run;
  }
}

export function parseArchivedEventNdjson(compressed: Uint8Array): readonly GatewayEventEnvelope[] {
  const ndjson = zstdDecompressSync(compressed).toString("utf8");
  if (ndjson === "") return Object.freeze([]);
  const records = ndjson.split("\n").filter((line) => line.length > 0)
    .map((line) => validateEu12EventEnvelope(JSON.parse(line) as unknown));
  return Object.freeze(records);
}
