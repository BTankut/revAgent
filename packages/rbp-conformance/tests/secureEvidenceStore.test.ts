import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { MAX_SECURE_EVIDENCE_CONTENT_BYTES, SecureEvidenceStore } from "../src/secureEvidenceStore.js";

describe("secure retained-evidence store", () => {
  it.runIf(process.platform === "win32")("fails closed on malformed, crashed, timed-out, and cleanup-uncertain native helper states", () => {
    for (const helperFault of ["malformed_output", "unknown_error_code", "crash", "timeout"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `rbp-secure-helper-${helperFault}-`));
      try {
        const started = Date.now();
        const construct = (): SecureEvidenceStore => new SecureEvidenceStore(root, { test: { helperFault, timeoutMs: helperFault === "unknown_error_code" ? 1_000 : 150 } });
        if (helperFault === "unknown_error_code") expect(construct).toThrow(/unknown error code/u);
        else expect(construct).toThrow();
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-helper-cleanup-"));
    try {
      const store = new SecureEvidenceStore(root, { test: { helperFault: "cleanup_uncertain" } });
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/uncertain/evidence.json`;
      expect(() => store.write(relative, "published but cleanup uncertain")).toThrow(/cleanup is uncertain/u);
      const directory = path.dirname(store.resolve(relative));
      expect(readdirSync(directory)).toEqual(expect.arrayContaining(["evidence.json"]));
      expect(readdirSync(directory).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects content at the fixed size bound plus one before publication allocation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-size-bound-"));
    try {
      const store = new SecureEvidenceStore(root);
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/size/evidence.bin`;
      expect(() => store.write(relative, Buffer.alloc(MAX_SECURE_EVIDENCE_CONTENT_BYTES + 1))).toThrow(/fixed bound/u);
      expect(existsSync(store.resolve(relative))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("binds the absolute helper identity and rejects PATH, SystemRoot, or junction substitution", () => {
    const originalPath = process.env.PATH;
    const originalSystemRoot = process.env.SystemRoot;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-helper-identity-"));
    try {
      process.env.PATH = path.join(root, "hostile-path");
      const store = new SecureEvidenceStore(path.join(root, "safe"));
      store.write(`${canonicalManifest.retainedEvidence.root}/identity.json`, "safe");

      process.env.SystemRoot = path.join(root, "missing-system-root");
      expect(() => new SecureEvidenceStore(path.join(root, "missing"))).toThrow();

      const substitutedRoot = path.join(root, "substituted-system-root");
      mkdirSync(substitutedRoot);
      symlinkSync(path.join(originalSystemRoot!, "System32"), path.join(substitutedRoot, "System32"), "junction");
      process.env.SystemRoot = substitutedRoot;
      expect(() => new SecureEvidenceStore(path.join(root, "substituted"))).toThrow(/substituted directory identity/u);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins a real directory identity across a synchronized post-validation substitution attempt", async () => {
    const owned = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-swap-"));
    const artifactRoot = path.join(owned, "artifact");
    const outside = path.join(owned, "outside");
    const reached = path.join(owned, "stage-reached");
    const continued = path.join(owned, "continue");
    mkdirSync(artifactRoot);
    mkdirSync(outside);
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/swap/cases/O1-C29/evidence.json`;
    const seed = new SecureEvidenceStore(artifactRoot);
    const attacked = path.dirname(seed.resolve(relative));
    mkdirSync(attacked, { recursive: true });
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({SecureEvidenceStore}) => {
        try {
          const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'stage_complete',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});
          store.write(workerData.relative,'pinned bytes');
          parentPort.postMessage({ok:true});
        } catch(error) { parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root: artifactRoot, relative, reached, continued,
    } });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      const moved = `${attacked}-moved`;
      let substituted = false;
      try {
        renameSync(attacked, moved);
        symlinkSync(outside, attacked, process.platform === "win32" ? "junction" : "dir");
        substituted = true;
      } catch {
        // Windows directory handles deliberately deny the rename.
      }
      writeFileSync(continued, "continue");
      const outcome = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(outcome.ok).toBe(!substituted);
      expect(readdirSync(outside)).toEqual([]);
      if (!substituted) expect(readFileSync(seed.resolve(relative), "utf8")).toBe("pinned bytes");
      else expect(outcome.message).toMatch(/identity changed|PUBLISH_FAILED/u);
    } finally {
      await worker.terminate();
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it("rejects a same-size target replacement after readback and before return", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-final-replace-"));
    const reached = path.join(root, "verified");
    const continued = path.join(root, "continue");
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/final/evidence.json`;
    const seed = new SecureEvidenceStore(root);
    const target = seed.resolve(relative);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.moduleUrl).then(({SecureEvidenceStore})=>{
        try { new SecureEvidenceStore(workerData.root,{test:{boundary:'after_verification_before_return',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}}).write(workerData.relative,'original-bytes'); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, relative, reached, continued,
    } });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      rmSync(target);
      writeFileSync(target, "attacker-bytes");
      expect(Buffer.byteLength("attacker-bytes")).toBe(Buffer.byteLength("original-bytes"));
      writeFileSync(continued, "continue");
      const outcome = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
        worker.once("message", resolve); worker.once("error", reject);
      });
      expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/IDENTITY_CHANGED|READBACK_MISMATCH|identity changed|readback mismatch/u) });
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a fresh directory recreated at the same lexical root pathname", () => {
    const owner = mkdtempSync(path.join(tmpdir(), "rbp-secure-root-id-"));
    const root = path.join(owner, "artifact");
    const moved = path.join(owner, "artifact-moved");
    mkdirSync(root);
    const store = new SecureEvidenceStore(root);
    renameSync(root, moved);
    mkdirSync(root);
    try {
      expect(() => store.write(`${canonicalManifest.retainedEvidence.root}/identity.json`, "must not publish"))
        .toThrow(/identity changed|IDENTITY_CHANGED/u);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
  });

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
      const continued = path.join(root, "publish-continue");
      const publisher = `
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.moduleUrl).then(({ SecureEvidenceStore }) => {
          try {
            const store = new SecureEvidenceStore(workerData.root,{test:{boundary:'stage_complete',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});
            const result = store.write(workerData.relative, workerData.contents);
            parentPort.postMessage({ phase: 'result', ok: true, bytes: result.bytes.toString('utf8') });
          } catch (error) {
            parentPort.postMessage({ phase: 'result', ok: false, code: error.code, message: error.message });
          }
        }).catch(error => { throw error; });
      `;
      const outcomes: Array<Promise<{ ok: boolean; bytes?: string; code?: string }>> = [];
      const exits: Array<Promise<number>> = [];
      for (const [index, content] of contents.entries()) {
        const worker = new Worker(publisher, {
          eval: true,
          workerData: {
            // Canonical preparation builds this exact checkout before tests.
            moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
            root, relative, contents: content, reached: path.join(root, `publisher-${index}-staged`), continued,
          },
        });
        workers.push(worker);
        outcomes.push(new Promise((resolve, reject) => {
          worker.on("message", (message) => { if (message.phase === "result") resolve(message); });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("publisher exited without result")));
        }));
        exits.push(new Promise((resolve) => worker.once("exit", resolve)));
      }
      const deadline = Date.now() + 5_000;
      while ((!existsSync(path.join(root, "publisher-0-staged")) || !existsSync(path.join(root, "publisher-1-staged"))) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(path.join(root, "publisher-0-staged"))).toBe(true);
      expect(existsSync(path.join(root, "publisher-1-staged"))).toBe(true);
      writeFileSync(continued, "publish");
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
        .toThrow(/plain directory|IDENTITY_CHANGED/u);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
