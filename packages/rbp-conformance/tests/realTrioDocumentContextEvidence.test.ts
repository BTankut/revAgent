import { describe, expect, it } from "vitest";

import {
  parseDocumentContextGrammar,
  preControlWatcherSeedFromSnapshot,
} from "../src/realTrioDocumentContextEvidence.js";

const hash = `sha256:${"a".repeat(64)}` as const;
const incarnation = `sha256:${"b".repeat(64)}` as const;

function row(cursor: number, stage: string, outcome: string, sequence: number | null) {
  const payloadBearing = (stage === "snapshot" && outcome === "ready") ||
    (stage === "queue" && outcome === "durably_queued") ||
    (stage === "send" && outcome === "sent");
  return {
    cursor: String(cursor), at: "", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
      ...(payloadBearing ? { contextDigest: "c".repeat(64), sourceRevision: 1, cacheIncarnationDigest: incarnation } : {}),
    }),
  };
}

describe("WP-12 C39 shared document-context grammar", () => {
  it("keeps the established probe/snapshot/queue/send/ack acceptance vector byte-equivalent", () => {
    const rows = [row(1, "probe", "started", null), row(2, "snapshot", "ready", null),
      row(3, "queue", "durably_queued", 1), row(4, "send", "sent", 1), row(5, "ack", "durably_acknowledged", 1)];
    const parsed = parseDocumentContextGrammar({ rows, generation: 1, controlCursor: "0", precedingProbe: null });
    expect(parsed?.candidates).toHaveLength(1);
    expect(parsed?.currentWatcher).toMatchObject({ generation: 1, highWaterCursor: "5", watcherOrdinal: 1,
      rsidHash: hash, lastSentSequence: 1, lastAckSequence: 1 });
    expect(preControlWatcherSeedFromSnapshot({ generation: 1, lowWaterCursor: "1", highWaterCursor: "5", rows }))
      .toMatchObject({ highWaterCursor: "5", lastSentSequence: 1, lastAckSequence: 1 });
  });

  it("retains only a value-free settled baseline across replay ACKs and cache-not-ready polls", () => {
    const rows = [
      row(1, "probe", "started", null),
      row(2, "ack", "durably_acknowledged", 1),
      row(3, "ack", "durably_acknowledged", 2),
      row(4, "snapshot", "not_ready", null),
      row(5, "probe", "started", null),
      row(6, "snapshot", "not_ready", null),
    ];
    const parsed = parseDocumentContextGrammar({ rows, generation: 4, controlCursor: "0", precedingProbe: null });
    expect(parsed?.candidates).toHaveLength(0);
    expect(parsed?.currentWatcher).toEqual({ generation: 4, highWaterCursor: "6", watcherOrdinal: 2,
      rsidHash: hash, lastSentSequence: null, lastAckSequence: null });
    expect(preControlWatcherSeedFromSnapshot({ generation: 4, lowWaterCursor: "1", highWaterCursor: "6", rows }))
      .toEqual(parsed?.currentWatcher);
  });

  it("rejects a tampered compact seed, an unbacked ACK, and a source-pair mismatch", () => {
    const rows = [row(1, "probe", "started", null), row(2, "snapshot", "ready", null),
      row(3, "queue", "durably_queued", 1), row(4, "send", "sent", 1)];
    expect(parseDocumentContextGrammar({ rows: [...rows, row(5, "ack", "durably_acknowledged", 2)], generation: 1,
      controlCursor: "0", precedingProbe: null })).toBeNull();
    expect(parseDocumentContextGrammar({ rows: rows.map((entry, index) => index === 3
      ? { ...entry, line: entry.line.replace(`\"${"c".repeat(64)}\"`, `\"${"d".repeat(64)}\"`) } : entry), generation: 1,
      controlCursor: "0", precedingProbe: null })).toBeNull();
    expect(parseDocumentContextGrammar({ rows: rows.slice(1), generation: 1, controlCursor: "1", precedingProbe: null,
      precedingSeed: { generation: 1, highWaterCursor: "0", watcherOrdinal: 1, rsidHash: hash,
        lastSentSequence: null, lastAckSequence: null } })).toBeNull();
    expect(parseDocumentContextGrammar({ rows: [row(1, "probe", "started", null),
      row(2, "ack", "durably_acknowledged", 2), row(3, "ack", "durably_acknowledged", 1)],
      generation: 1, controlCursor: "0", precedingProbe: null })).toBeNull();
    expect(parseDocumentContextGrammar({ rows: [row(1, "probe", "started", null),
      row(2, "snapshot", "not_ready", 1)], generation: 1, controlCursor: "0", precedingProbe: null })).toBeNull();
    expect(parseDocumentContextGrammar({ rows: [row(1, "probe", "started", null),
      row(2, "failure", "snapshot_failed", null)], generation: 1,
      controlCursor: "0", precedingProbe: null })).toBeNull();
  });
});
