import type {
  RealTrioDocumentContextCursorRow,
  RealTrioDocumentContextSnapshot,
} from "./realTrioSupervisor.js";

export interface RealTrioDocumentContextSourcePair {
  readonly sourceRevision: number;
  readonly cacheIncarnationDigest: `sha256:${string}`;
}

/**
 * A fixed, value-free checkpoint for a fully ACK-settled watcher history.
 * `highWaterCursor` binds the checkpoint to precisely one journal prefix.
 */
export interface RealTrioPreControlWatcherSeed {
  readonly generation: number;
  readonly highWaterCursor: string;
  readonly watcherOrdinal: number;
  readonly rsidHash: `sha256:${string}`;
  readonly lastSentSequence: number | null;
  readonly lastAckSequence: number | null;
}

export interface RealTrioDocumentContextCorrelation {
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number;
  readonly sendCursor: string;
  readonly generation: number;
  readonly sendTranscriptIndex: number;
  readonly sendRecordedAt: string | null;
}

export interface ParsedDocumentContextCandidate extends RealTrioDocumentContextCorrelation {
  readonly contextDigest: string;
  readonly source: RealTrioDocumentContextSourcePair;
  readonly startCursor: string;
  readonly startTranscriptIndex: number;
  readonly watcherOrdinal: number;
}

type StrictDocumentObservation = Readonly<{
  readonly stage: "probe" | "snapshot" | "queue" | "send" | "ack";
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number | null;
  readonly contextDigest: string | null;
  readonly source: RealTrioDocumentContextSourcePair | null;
}>;

export interface ParsedDocumentContextGrammar {
  readonly candidates: readonly ParsedDocumentContextCandidate[];
  readonly acknowledgements: ReadonlyMap<string, number>;
  readonly currentWatcherOrdinal: number;
  readonly currentWatcher: RealTrioPreControlWatcherSeed | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function documentContextSourcePair(value: Record<string, unknown>): RealTrioDocumentContextSourcePair | null {
  if (!Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) < 1 ||
      !isSha256(value.cacheIncarnationDigest)) return null;
  return Object.freeze({ sourceRevision: Number(value.sourceRevision),
    cacheIncarnationDigest: value.cacheIncarnationDigest });
}

function strictDocumentObservation(row: RealTrioDocumentContextCursorRow): StrictDocumentObservation | null | undefined {
  let value: unknown;
  try { value = JSON.parse(row.line) as unknown; } catch { return null; }
  if (!isObject(value) || value.event !== "bridge.document_context_observation") return undefined;
  if (!isSha256(value.rsidHash) || !(value.sequence === null ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1))) return null;
  const sequence = value.sequence === null ? null : Number(value.sequence);
  const contextDigest = typeof value.contextDigest === "string" && /^[0-9a-f]{64}$/u.test(value.contextDigest)
    ? value.contextDigest : null;
  const hasRevision = value.sourceRevision !== null && value.sourceRevision !== undefined;
  const hasIncarnation = value.cacheIncarnationDigest !== null && value.cacheIncarnationDigest !== undefined;
  if (hasRevision !== hasIncarnation) return null;
  const source = hasRevision ? documentContextSourcePair(value) : null;
  if (hasRevision && source === null) return null;
  if (value.stage === "probe" && value.outcome === "started") {
    return Object.freeze({ stage: "probe", rsidHash: value.rsidHash, sequence, contextDigest: null, source });
  }
  if (value.stage === "ack" && value.outcome === "durably_acknowledged" && sequence !== null) {
    return Object.freeze({ stage: "ack", rsidHash: value.rsidHash, sequence, contextDigest: null, source });
  }
  if ((value.stage === "snapshot" && value.outcome === "ready") ||
      (value.stage === "queue" && value.outcome === "durably_queued") ||
      (value.stage === "send" && value.outcome === "sent")) {
    if ((value.stage === "snapshot" && sequence !== null) ||
        (value.stage !== "snapshot" && sequence === null) || contextDigest === null || source === null) return null;
    return Object.freeze({ stage: value.stage, rsidHash: value.rsidHash, sequence, contextDigest, source });
  }
  return null;
}

export function documentContextObservationLooksAdvertised(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) && value.event === "bridge.document_context_observation";
  } catch {
    return line.includes("bridge.document_context_observation");
  }
}

export function candidateKey(watcherOrdinal: number, rsidHash: `sha256:${string}`, sequence: number): string {
  return `${watcherOrdinal}:${rsidHash}:${sequence}`;
}

export function parseDocumentContextGrammar(input: {
  readonly rows: readonly RealTrioDocumentContextCursorRow[];
  readonly generation: number;
  readonly controlCursor: string;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
  readonly precedingSeed?: RealTrioPreControlWatcherSeed | null;
}): ParsedDocumentContextGrammar | null {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(input.controlCursor)) return null;
  const control = BigInt(input.controlCursor);
  let previous = control;
  for (const row of input.rows) {
    if (!/^[1-9][0-9]*$/u.test(row.cursor) || BigInt(row.cursor) !== previous + 1n) return null;
    previous = BigInt(row.cursor);
  }
  let watcher: {
    readonly ordinal: number; readonly rsidHash: `sha256:${string}`;
    lastSentSequence: number | null; lastAcknowledgedSequence: number | null;
    cycle: { readonly sequence: number | null; readonly contextDigest: string; readonly source: RealTrioDocumentContextSourcePair; readonly startCursor: string; readonly startIndex: number; readonly stage: "snapshot" | "queue" } | null;
    readonly sent: Map<number, ParsedDocumentContextCandidate>;
  } | null = null;
  const candidates: ParsedDocumentContextCandidate[] = [];
  const acknowledgements = new Map<string, number>();
  let nextWatcherOrdinal = 0;
  const openProbe = (observation: StrictDocumentObservation): boolean => {
    if (observation.stage !== "probe" || (watcher !== null && watcher.cycle !== null)) return false;
    watcher = { ordinal: nextWatcherOrdinal += 1, rsidHash: observation.rsidHash,
      lastSentSequence: null, lastAcknowledgedSequence: null, cycle: null, sent: new Map() };
    return true;
  };
  if (input.precedingProbe !== null && input.precedingSeed !== undefined && input.precedingSeed !== null) return null;
  if (input.precedingSeed !== undefined && input.precedingSeed !== null) {
    const seed = input.precedingSeed;
    if (seed.generation !== input.generation || !/^(?:0|[1-9][0-9]*)$/u.test(seed.highWaterCursor) ||
        BigInt(seed.highWaterCursor) !== control || !Number.isSafeInteger(seed.watcherOrdinal) || seed.watcherOrdinal < 1 ||
        !isSha256(seed.rsidHash) || !(seed.lastSentSequence === null || (Number.isSafeInteger(seed.lastSentSequence) && seed.lastSentSequence >= 1)) ||
        !(seed.lastAckSequence === null || (Number.isSafeInteger(seed.lastAckSequence) && seed.lastAckSequence >= 1)) ||
        ((seed.lastSentSequence === null) !== (seed.lastAckSequence === null)) ||
        (seed.lastSentSequence !== null && seed.lastAckSequence! < seed.lastSentSequence)) return null;
    watcher = { ordinal: seed.watcherOrdinal, rsidHash: seed.rsidHash, lastSentSequence: seed.lastSentSequence,
      lastAcknowledgedSequence: seed.lastAckSequence, cycle: null, sent: new Map() };
    nextWatcherOrdinal = seed.watcherOrdinal;
  } else if (input.precedingProbe !== null) {
    if (input.precedingProbe.cursor !== input.controlCursor) return null;
    const prefix = strictDocumentObservation(input.precedingProbe);
    if (prefix === null || prefix === undefined || !openProbe(prefix)) return null;
  }
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index]!;
    const observation = strictDocumentObservation(row);
    if (observation === undefined) continue;
    if (observation === null) return null;
    if (observation.stage === "probe") { if (!openProbe(observation)) return null; continue; }
    if (watcher === null || watcher.rsidHash !== observation.rsidHash) return null;
    if (observation.stage === "ack") {
      const sent = watcher.sent.get(observation.sequence!);
      if (sent === undefined || (watcher.lastAcknowledgedSequence !== null && observation.sequence! <= watcher.lastAcknowledgedSequence)) return null;
      watcher.lastAcknowledgedSequence = observation.sequence!;
      acknowledgements.set(candidateKey(watcher.ordinal, observation.rsidHash, observation.sequence!), index);
      continue;
    }
    if (observation.stage === "snapshot") {
      if (watcher.cycle !== null) return null;
      watcher.cycle = { sequence: null, contextDigest: observation.contextDigest!, source: observation.source!,
        startCursor: row.cursor, startIndex: index, stage: "snapshot" };
      continue;
    }
    if (observation.stage === "queue") {
      if (watcher.cycle === null || watcher.cycle.stage !== "snapshot" || watcher.cycle.contextDigest !== observation.contextDigest ||
          watcher.cycle.source.sourceRevision !== observation.source!.sourceRevision || watcher.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest ||
          (watcher.lastSentSequence !== null && observation.sequence! <= watcher.lastSentSequence)) return null;
      watcher.cycle = { ...watcher.cycle, sequence: observation.sequence!, stage: "queue" };
      continue;
    }
    if (watcher.cycle === null || watcher.cycle.stage !== "queue" || watcher.cycle.sequence !== observation.sequence ||
        watcher.cycle.contextDigest !== observation.contextDigest || watcher.cycle.source.sourceRevision !== observation.source!.sourceRevision ||
        watcher.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest) return null;
    const candidate = Object.freeze({ rsidHash: watcher.rsidHash, sequence: observation.sequence!, sendCursor: row.cursor,
      generation: input.generation, sendTranscriptIndex: index, sendRecordedAt: row.at.length === 0 ? null : row.at,
      contextDigest: observation.contextDigest!, source: observation.source!, startCursor: watcher.cycle.startCursor,
      startTranscriptIndex: watcher.cycle.startIndex, watcherOrdinal: watcher.ordinal });
    watcher.sent.set(candidate.sequence, candidate); watcher.lastSentSequence = candidate.sequence; watcher.cycle = null; candidates.push(candidate);
  }
  if (watcher !== null && watcher.cycle !== null) return null;
  return Object.freeze({ candidates: Object.freeze(candidates), acknowledgements,
    currentWatcherOrdinal: watcher?.ordinal ?? 0,
    currentWatcher: watcher === null ? null : Object.freeze({ generation: input.generation, highWaterCursor: previous.toString(),
      watcherOrdinal: watcher.ordinal, rsidHash: watcher.rsidHash, lastSentSequence: watcher.lastSentSequence,
      lastAckSequence: watcher.lastAcknowledgedSequence }) });
}

export function preControlWatcherSeedFromSnapshot(snapshot: RealTrioDocumentContextSnapshot): RealTrioPreControlWatcherSeed | null {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(snapshot.lowWaterCursor) || !/^(?:0|[1-9][0-9]*)$/u.test(snapshot.highWaterCursor)) return null;
  const lowWater = BigInt(snapshot.lowWaterCursor); const highWater = BigInt(snapshot.highWaterCursor);
  if (snapshot.rows.length === 0 || lowWater !== 1n || highWater < lowWater ||
      BigInt(snapshot.rows[0]!.cursor) !== lowWater || BigInt(snapshot.rows.at(-1)!.cursor) !== highWater) return null;
  const parsed = parseDocumentContextGrammar({ rows: snapshot.rows, generation: snapshot.generation, controlCursor: "0", precedingProbe: null });
  if (parsed === null || parsed.currentWatcher === null || parsed.currentWatcher.watcherOrdinal < 1) return null;
  const unacknowledged = parsed.candidates.filter((candidate) => {
    const acknowledgedAt = parsed.acknowledgements.get(candidateKey(candidate.watcherOrdinal, candidate.rsidHash, candidate.sequence));
    return acknowledgedAt === undefined || acknowledgedAt <= candidate.sendTranscriptIndex;
  });
  return unacknowledged.length === 0 ? parsed.currentWatcher : null;
}

/**
 * Incremental counterpart of the retained-row grammar. It preserves only the
 * value-free watcher state needed to prove a compact prefix; it never keeps
 * payload or historical row content after the supervisor ring evicts it.
 */
export class DocumentContextHistoryReducer {
  private invalid = false;
  private lastCursor = 0n;
  private watcherOrdinal = 0;
  private rsidHash: `sha256:${string}` | null = null;
  private lastSent: number | null = null;
  private lastAck: number | null = null;
  private unacknowledged = new Set<number>();
  private cycle: { readonly stage: "snapshot" | "queue"; readonly sequence: number | null; readonly contextDigest: string; readonly source: RealTrioDocumentContextSourcePair } | null = null;

  public accept(row: RealTrioDocumentContextCursorRow, generation: number): boolean {
    if (this.invalid || !/^[1-9][0-9]*$/u.test(row.cursor) || BigInt(row.cursor) !== this.lastCursor + 1n) {
      this.invalid = true; return false;
    }
    this.lastCursor = BigInt(row.cursor);
    const observation = strictDocumentObservation(row);
    if (observation === undefined) return true;
    if (observation === null) { this.invalid = true; return false; }
    if (observation.stage === "probe") {
      if (this.cycle !== null || this.unacknowledged.size !== 0) { this.invalid = true; return false; }
      this.watcherOrdinal += 1; this.rsidHash = observation.rsidHash;
      this.lastSent = null; this.lastAck = null;
      return true;
    }
    if (this.rsidHash === null || this.rsidHash !== observation.rsidHash) { this.invalid = true; return false; }
    if (observation.stage === "ack") {
      if (!this.unacknowledged.has(observation.sequence!) ||
          (this.lastAck !== null && observation.sequence! <= this.lastAck)) { this.invalid = true; return false; }
      this.unacknowledged.delete(observation.sequence!); this.lastAck = observation.sequence!;
      return true;
    }
    if (observation.stage === "snapshot") {
      if (this.cycle !== null) { this.invalid = true; return false; }
      this.cycle = { stage: "snapshot", sequence: null, contextDigest: observation.contextDigest!, source: observation.source! };
      return true;
    }
    if (observation.stage === "queue") {
      if (this.cycle === null || this.cycle.stage !== "snapshot" || this.cycle.contextDigest !== observation.contextDigest ||
          this.cycle.source.sourceRevision !== observation.source!.sourceRevision ||
          this.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest ||
          (this.lastSent !== null && observation.sequence! <= this.lastSent)) { this.invalid = true; return false; }
      this.cycle = { ...this.cycle, stage: "queue", sequence: observation.sequence! };
      return true;
    }
    if (this.cycle === null || this.cycle.stage !== "queue" || this.cycle.sequence !== observation.sequence ||
        this.cycle.contextDigest !== observation.contextDigest || this.cycle.source.sourceRevision !== observation.source!.sourceRevision ||
        this.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest) { this.invalid = true; return false; }
    this.lastSent = observation.sequence!; this.unacknowledged.add(observation.sequence!); this.cycle = null;
    return true;
  }

  public settledSeed(generation: number): RealTrioPreControlWatcherSeed | null {
    if (this.invalid || this.lastCursor === 0n || this.rsidHash === null || this.cycle !== null || this.unacknowledged.size !== 0 ||
        ((this.lastSent === null) !== (this.lastAck === null)) ||
        (this.lastSent !== null && this.lastAck! < this.lastSent)) return null;
    return Object.freeze({ generation, highWaterCursor: this.lastCursor.toString(), watcherOrdinal: this.watcherOrdinal,
      rsidHash: this.rsidHash, lastSentSequence: this.lastSent, lastAckSequence: this.lastAck });
  }

  public get historyInvalid(): boolean { return this.invalid; }
}
