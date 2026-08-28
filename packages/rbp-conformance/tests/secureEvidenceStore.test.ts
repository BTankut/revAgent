import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { SecureEvidenceStore } from "../src/secureEvidenceStore.js";

describe("secure retained-evidence store", () => {
  it("confines atomic writes, refuses replacement, and leaves no staging file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-"));
    try {
      const store = new SecureEvidenceStore(root);
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/run-1/cases/O1-C19/evidence.json`;
      const stored = store.write(relative, "observed bytes");
      expect(readFileSync(stored.absolutePath, "utf8")).toBe("observed bytes");
      expect(readdirSync(path.dirname(stored.absolutePath))).toEqual(["evidence.json"]);
      expect(() => store.write(relative, "replacement")).toThrow(/already exists/u);
      expect(() => store.write(
        `${canonicalManifest.retainedEvidence.root}/../../escaped.json`,
        "escape",
      )).toThrow(/escapes retained root/u);
      if (process.platform !== "win32") {
        expect(statSync(store.retainedRoot).mode & 0o777).toBe(0o700);
        expect(statSync(stored.absolutePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically publishes exactly one of two independent simultaneous publishers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-race-"));
    const workers: Worker[] = [];
    try {
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/run-2/cases/O1-C29/evidence.json`;
      const store = new SecureEvidenceStore(root);
      const target = store.resolve(relative);
      mkdirSync(path.dirname(target), { recursive: true });
      const contents = ["first:" + "A".repeat(128 * 1024), "second:" + "B".repeat(128 * 1024)];
      const release = new Int32Array(new SharedArrayBuffer(4));
      const publisher = `
        const { parentPort, workerData, threadId } = require('node:worker_threads');
        const fs = require('node:fs');
        const { syncBuiltinESMExports } = require('node:module');
        const nativeLink = fs.linkSync;
        fs.linkSync = (temporary, target) => {
          parentPort.postMessage({ phase: 'staged', temporary, threadId });
          if (Atomics.wait(new Int32Array(workerData.release), 0, 0, 5000) === 'timed-out') {
            throw new Error('publication barrier timed out');
          }
          return nativeLink(temporary, target);
        };
        syncBuiltinESMExports();
        import(workerData.moduleUrl).then(({ SecureEvidenceStore }) => {
          try {
            const result = new SecureEvidenceStore(workerData.root).write(workerData.relative, workerData.contents);
            parentPort.postMessage({ phase: 'result', ok: true, bytes: result.bytes.toString('utf8') });
          } catch (error) {
            parentPort.postMessage({ phase: 'result', ok: false, code: error.code, message: error.message });
          }
        }).catch(error => { throw error; });
      `;
      const staged: Array<Promise<{ temporary: string; threadId: number }>> = [];
      const outcomes: Array<Promise<{ ok: boolean; bytes?: string; code?: string }>> = [];
      const exits: Array<Promise<number>> = [];
      for (const content of contents) {
        const worker = new Worker(publisher, {
          eval: true,
          workerData: {
            // Canonical preparation builds this exact checkout before tests.
            moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
            root, relative, contents: content, release: release.buffer,
          },
        });
        workers.push(worker);
        staged.push(new Promise((resolve, reject) => {
          worker.on("message", (message) => { if (message.phase === "staged") resolve(message); });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("publisher exited before staging")));
        }));
        outcomes.push(new Promise((resolve, reject) => {
          worker.on("message", (message) => { if (message.phase === "result") resolve(message); });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("publisher exited without result")));
        }));
        exits.push(new Promise((resolve) => worker.once("exit", resolve)));
      }
      // Both real writes have reached publication with complete, distinct
      // fsynced staging files before either can publish to the same target.
      const ready = await Promise.all(staged);
      expect(new Set(ready.map(({ threadId }) => threadId)).size).toBe(2);
      expect(ready.map(({ temporary }) => readFileSync(temporary, "utf8"))).toEqual(contents);
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0, 2);
      const results = await Promise.all(outcomes);
      expect(await Promise.all(exits)).toEqual([0, 0]);
      expect(results.filter(({ ok }) => ok)).toHaveLength(1);
      expect(results.filter(({ ok }) => !ok)).toEqual([expect.objectContaining({ code: "EEXIST" })]);
      const winner = results.find(({ ok }) => ok)!;
      expect(contents).toContain(winner.bytes);
      expect(readFileSync(target, "utf8")).toBe(winner.bytes);
      expect(readdirSync(path.dirname(target))).toEqual(["evidence.json"]);
      expect(() => store.write(relative, "replacement")).toThrow(/already exists/u);
      expect(readFileSync(target, "utf8")).toBe(winner.bytes);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects real junction or symlink roots and intermediate directories without writing through them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-reparse-"));
    const target = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-target-"));
    try {
      // Windows junction creation does not require symlink privileges. This
      // test runs on Windows as well as POSIX; neither branch is skipped.
      const kind = process.platform === "win32" ? "junction" : "dir";
      const linkRoot = path.join(root, "reparse-root");
      symlinkSync(target, linkRoot, kind);
      expect(lstatSync(linkRoot).isSymbolicLink()).toBe(true);
      expect(() => new SecureEvidenceStore(linkRoot)).toThrow(/plain directory/u);
      const store = new SecureEvidenceStore(root);
      const linkDirectory = path.join(store.retainedRoot, "junction");
      symlinkSync(target, linkDirectory, kind);
      expect(lstatSync(linkDirectory).isSymbolicLink()).toBe(true);
      expect(() => store.write(`${canonicalManifest.retainedEvidence.root}/junction/escape.json`, "escape"))
        .toThrow(/plain directory/u);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
