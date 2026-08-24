import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  coherentDocumentContextAudit,
  createOrderedConformanceHostShutdown,
  MAX_DOCUMENT_CONTEXT_OBSERVATIONS,
  MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES,
  type DocumentContextObservationSnapshot,
} from "./productionConformanceHostCli.js";

const epoch = "123e4567-e89b-42d3-a456-426614174000";
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const contextDigest = "c".repeat(64);
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  rsidHash: digest("a"), observedSequence: 7, contextDigest,
  routeDigest: digest("b"), recordDigest: digest("d"),
  sessionBindingDigest: digest("e"), connectionDigest: digest("f"),
  sessionRecordVersion: 9, ...overrides,
});
const observation = Object.freeze({ stage: "accepted" as const, sequence: 7, contextDigest,
  ordinal: 2, observedAtUtc: "2026-08-24T00:00:00.000Z" });
const snapshot = (rows = [observation], highWaterOrdinal = 2, processEpoch = epoch): DocumentContextObservationSnapshot =>
  Object.freeze({ processEpoch, highWaterOrdinal, rows: Object.freeze(rows) });

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function childExit(child: ReturnType<typeof fork>): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("WP-12 coherent document-context host audit", () => {
  it("emits exactly one digest-only join without changing authority", () => {
    let reads = 0;
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => { reads += 1; return route(); } },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(reads).toBe(2);
    expect(result.currentRoute).toMatchObject({ contextDigest, routeDigest: digest("b"), recordDigest: digest("d"), sessionBindingDigest: digest("e"), connectionDigest: digest("f") });
    expect(result.updates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("document-live");
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATIONS).toBe(32);
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES).toBe(2048);
  });

  it("fails closed for append A/route/B, post-B route churn, restart, and eviction", () => {
    let snapshotCall = 0;
    const append = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], ++snapshotCall),
    });
    expect(append.updates).toEqual([]);
    let routeRead = 0;
    const afterB = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => (++routeRead % 2 === 1 ? route() : route({ recordDigest: digest("1") })) },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(afterB.updates).toEqual([]);
    const restarted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], 2, "223e4567-e89b-42d3-a456-426614174000"),
    });
    expect(restarted.updates).toEqual([]);
    const evicted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([], 32),
    });
    expect(evicted.updates).toEqual([]);
  });

  it.each(["recordDigest", "sessionBindingDigest", "connectionDigest"])(
    "fails closed when final %s churns",
    (field) => {
      let read = 0;
      const result = coherentDocumentContextAudit({
        authority: { readCurrentDocumentRouteAuditSnapshot: () => (++read % 2 === 1 ? route() : route({ [field]: digest("9") })) },
        processEpoch: epoch, snapshotObservations: () => snapshot(),
      });
      expect(result.updates).toEqual([]);
    },
  );
});

describe("WP-12 conformance host shutdown", () => {
  it("orders host settlement and SQLite close before one IPC release", async () => {
    const order: string[] = [];
    const shutdown = createOrderedConformanceHostShutdown({
      host: {
        beginShutdown: () => { order.push("begin"); },
        close: async () => { order.push("host"); },
      },
      closeStore: async () => { order.push("store"); },
      releaseIpc: () => { order.push("ipc"); },
    });
    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await first;
    expect(order).toEqual(["begin", "host", "store", "ipc"]);
  });

  it("releases IPC only after the store-close attempt when host close fails", async () => {
    const order: string[] = [];
    const shutdown = createOrderedConformanceHostShutdown({
      host: {
        beginShutdown: () => { order.push("begin"); },
        close: async () => { order.push("host"); throw new Error("host-close-failure"); },
      },
      closeStore: async () => { order.push("store"); },
      releaseIpc: () => { order.push("ipc"); },
    });
    await expect(shutdown()).rejects.toThrow("host-close-failure");
    expect(order).toEqual(["begin", "host", "store", "ipc"]);
  });

  it("uses Node 24 and real better-sqlite3 state for repeated IPC STOP without native cleanup abort", async () => {
    expect(Number(process.versions.node.split(".")[0])).toBe(24);
    const root = await mkdtemp(path.join(tmpdir(), "revagent-wp12-host-shutdown-"));
    const childFile = path.join(root, "shutdown-child.mjs");
    const cliUrl = pathToFileURL(path.join(packageRoot, "dist", "productionConformanceHostCli.js")).href;
    const adaptersUrl = pathToFileURL(path.join(packageRoot, "dist", "conformanceEphemeralAdapters.js")).href;
    const childSource = `
      import { createOrderedConformanceHostShutdown } from ${JSON.stringify(cliUrl)};
      import { SqliteConformanceProtocolStore } from ${JSON.stringify(adaptersUrl)};
      const root = process.argv[2];
      const store = new SqliteConformanceProtocolStore(root);
      const opened = await store.open();
      if (!opened.ok) throw new Error("store open failed");
      const written = await store.transact({ tenantId: "conformance" }, (tx) => {
        tx.stage({ namespace: "shutdown", key: "probe", value: { state: "open" }, expect: { kind: "absent" } });
        return "written";
      });
      if (!written.ok) throw new Error("store write failed");
      const order = [];
      let stops = 0;
      const shutdown = createOrderedConformanceHostShutdown({
        host: {
          beginShutdown() { order.push("begin"); },
          async close() { order.push("host"); await new Promise((resolve) => setTimeout(resolve, 30)); },
        },
        async closeStore() {
          order.push("store");
          const closed = await store.close();
          if (!closed.ok) throw new Error("store close failed");
        },
        releaseIpc() {
          order.push("ipc");
          process.stdout.write(JSON.stringify({ order, stops }) + "\\n");
          if (process.connected) process.disconnect();
        },
      });
      process.on("message", (message) => {
        if (message?.action !== "STOP") return;
        stops += 1;
        void shutdown().catch((error) => {
          process.stderr.write(String(error));
          process.exitCode = 1;
        });
      });
      process.send?.({ ready: true });
    `;
    try {
      await writeFile(childFile, childSource, "utf8");
      const child = fork(childFile, [root], { silent: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("message", (message: unknown) => {
          if ((message as { readonly ready?: unknown }).ready === true) resolve();
          else reject(new Error("unexpected child readiness message"));
        });
      });
      child.send({ action: "STOP" });
      child.send({ action: "STOP" });
      const exited = await childExit(child);
      expect(exited).toEqual({ code: 0, signal: null });
      expect(stderr).not.toContain("RemoveEnvironmentCleanupHook");
      expect(stderr).not.toMatch(/native abort|assertion failed/i);
      expect(JSON.parse(stdout.trim())).toEqual({ order: ["begin", "host", "store", "ipc"], stops: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
