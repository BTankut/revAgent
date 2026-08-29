import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { MAX_SECURE_EVIDENCE_CONTENT_BYTES, SecureEvidenceStore } from "../src/secureEvidenceStore.js";

async function acceptWrite(store: SecureEvidenceStore, relativePath: string, contents: string | Buffer): Promise<{ absolutePath: string; bytes: Buffer }> {
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return await store.writeAccepted(relativePath, bytes, (candidate) => candidate.acceptExact({
    logicalPath: relativePath,
    absolutePath: store.resolve(relativePath),
    bytes,
    sha256,
  }, { absolutePath: candidate.absolutePath, bytes: candidate.bytes }));
}

describe("secure retained-evidence store", () => {
  it("requires nominal exact awaited acceptance and exposes no legacy write methods", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-acceptance-"));
    try {
      const lifecycle = { leasesOpened: 0, leasesDisposed: 0, helpersSpawned: 0, helpersClosed: 0 };
      const store = new SecureEvidenceStore(root, { test: { lifecycle } });
      expect((store as unknown as { write?: unknown }).write).toBeUndefined();
      expect((store as unknown as { writeDirect?: unknown }).writeDirect).toBeUndefined();
      const base = canonicalManifest.retainedEvidence.root;
      await expect((store.writeAccepted as unknown as (path: string, bytes: Buffer, consume?: unknown) => Promise<unknown>)(`${base}/missing.json`, Buffer.from("x")))
        .rejects.toMatchObject({ code: "EVIDENCE_ACCEPTOR_REQUIRED" });
      expect(existsSync(store.resolve(`${base}/missing.json`))).toBe(false);

      await expect(store.writeAccepted(`${base}/plain.json`, "plain", (() => undefined) as never))
        .rejects.toMatchObject({ code: "EVIDENCE_ACCEPTANCE_REQUIRED" });
      await expect(store.writeAccepted(`${base}/wrong.json`, "wrong", (candidate) => candidate.acceptExact({
        logicalPath: `${base}/different.json`,
        absolutePath: candidate.absolutePath,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
      }, undefined))).rejects.toMatchObject({ code: "EVIDENCE_CONSUMER_BINDING_MISMATCH" });

      let foreignToken: unknown;
      await store.writeAccepted(`${base}/mint.json`, "mint", (candidate) => {
        const token = candidate.acceptExact({ logicalPath: candidate.logicalPath, absolutePath: candidate.absolutePath, bytes: candidate.bytes, sha256: candidate.sha256 }, undefined);
        foreignToken = token;
        return token;
      });
      await expect(store.writeAccepted(`${base}/foreign.json`, "foreign", (() => foreignToken) as never))
        .rejects.toMatchObject({ code: "EVIDENCE_ACCEPTANCE_REQUIRED" });
      expect(lifecycle).toEqual({ leasesOpened: 4, leasesDisposed: 4, helpersSpawned: 4, helpersClosed: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("rejects a post-consumer hardlink before COMMIT", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-post-consumer-link-"));
    const alias = path.join(root, "alias.bin");
    try {
      const store = new SecureEvidenceStore(root);
      const logicalPath = `${canonicalManifest.retainedEvidence.root}/post-consumer.json`;
      const bytes = Buffer.from("post-consumer");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await expect(store.writeAccepted(logicalPath, bytes, (candidate) => {
        linkSync(candidate.absolutePath, alias);
        return candidate.acceptExact({ logicalPath, absolutePath: store.resolve(logicalPath), bytes, sha256 }, "accepted-value");
      })).rejects.toMatchObject({ code: "EVIDENCE_IDENTITY_CHANGED" });
      expect(readFileSync(alias, "utf8")).toBe("post-consumer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("retains callback and lease causes when both fail", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-composed-failure-"));
    const alias = path.join(root, "alias.bin");
    try {
      const store = new SecureEvidenceStore(root);
      const logicalPath = `${canonicalManifest.retainedEvidence.root}/composed.json`;
      let observed: Error | undefined;
      try {
        await store.writeAccepted(logicalPath, "composed", (candidate) => {
          linkSync(candidate.absolutePath, alias);
          throw new Error("planned consumer failure");
        });
      } catch (error) { observed = error as Error; }
      expect(observed).toMatchObject({ code: "EVIDENCE_CONSUMER_AND_LEASE_FAILED", cause: expect.any(AggregateError) });
      const causes = (observed!.cause as AggregateError).errors;
      expect(causes).toHaveLength(2);
      expect(String(causes[0])).toMatch(/planned consumer failure/u);
      expect(String(causes[1])).toMatch(/leased identity|LINK_COUNT|identity/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it.runIf(process.platform === "win32")("fails closed on malformed, crashed, timed-out, and cleanup-uncertain native helper states", async () => {
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
      await expect(acceptWrite(store, relative, "published but cleanup uncertain")).rejects.toThrow(/cleanup is uncertain/u);
      const directory = path.dirname(store.resolve(relative));
      expect(readdirSync(directory)).toEqual(expect.arrayContaining(["evidence.json"]));
      expect(readdirSync(directory).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects content at the fixed size bound plus one before publication allocation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-size-bound-"));
    try {
      const store = new SecureEvidenceStore(root);
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/size/evidence.bin`;
      await expect(acceptWrite(store, relative, Buffer.alloc(MAX_SECURE_EVIDENCE_CONTENT_BYTES + 1))).rejects.toThrow(/fixed bound/u);
      expect(existsSync(store.resolve(relative))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("binds the GLOBALROOT Windows identity and rejects ambient mismatch, mutation, or junction substitution", async () => {
    const originalPath = process.env.PATH;
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-helper-identity-"));
    try {
      process.env.PATH = path.join(root, "hostile-path");
      const store = new SecureEvidenceStore(path.join(root, "safe"));
      await acceptWrite(store, `${canonicalManifest.retainedEvidence.root}/identity.json`, "safe");

      process.env.SystemRoot = path.join(root, "missing-system-root");
      expect(() => new SecureEvidenceStore(path.join(root, "mismatch"))).toThrow(/GLOBALROOT/u);

      process.env.WINDIR = process.env.SystemRoot;
      expect(() => new SecureEvidenceStore(path.join(root, "plain-fake-initial"))).toThrow(/GLOBALROOT/u);
      await expect(acceptWrite(store, `${canonicalManifest.retainedEvidence.root}/identity-after-mutation.json`, "blocked"))
        .rejects.toThrow(/GLOBALROOT|environment changed/u);

      if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;

      const substitutedRoot = path.join(root, "substituted-system-root");
      mkdirSync(substitutedRoot);
      symlinkSync(path.join(originalSystemRoot!, "System32"), path.join(substitutedRoot, "System32"), "junction");
      process.env.SystemRoot = substitutedRoot;
      process.env.WINDIR = substitutedRoot;
      expect(() => new SecureEvidenceStore(path.join(root, "substituted"))).toThrow(/GLOBALROOT/u);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;
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
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(async ({SecureEvidenceStore}) => {
        try {
          const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'stage_complete',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});
          const bytes=Buffer.from('pinned bytes');const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
          await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},undefined));
          parentPort.postMessage({ok:true});
        } catch(error) { parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root: artifactRoot, relative, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    const outcomePromise = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!existsSync(reached)) {
        const early = await Promise.race([outcomePromise, new Promise<{ ok: false; message: string }>((resolve) => setTimeout(() => resolve({ ok: false, message: "no worker outcome" }), 100))]);
        throw new Error(`stage boundary was not reached: ${String(early.message)}`);
      }
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
      const outcome = await outcomePromise;
      expect(outcome.ok).toBe(!substituted);
      expect(readdirSync(outside)).toEqual([]);
      if (!substituted) expect(readFileSync(seed.resolve(relative), "utf8")).toBe("pinned bytes");
      else expect(outcome.message).toMatch(/identity changed|PUBLISH_FAILED/u);
    } finally {
      await worker.terminate();
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("rejects a same-user hardlink alias added at the staged publication boundary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-stage-alias-"));
    const reached = path.join(root, "stage-reached");
    const continued = path.join(root, "continue");
    const alias = path.join(root, "owner-alias.bin");
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/alias/evidence.json`;
    const seed = new SecureEvidenceStore(root);
    const target = seed.resolve(relative);
    mkdirSync(path.dirname(target), { recursive: true });
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(async ({SecureEvidenceStore})=>{
        try { const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'stage_complete',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});const bytes=Buffer.from('staged-evidence-bytes');const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},undefined)); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, relative, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    const outcomePromise = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!existsSync(reached)) {
        const early = await Promise.race([outcomePromise, new Promise<{ ok: false; message: string }>((resolve) => setTimeout(() => resolve({ ok: false, message: "no worker outcome" }), 100))]);
        throw new Error(`lease boundary was not reached: ${String(early.message)}`);
      }
      const staged = readdirSync(path.dirname(target)).filter((entry) => entry.endsWith(".tmp"));
      expect(staged).toHaveLength(1);
      linkSync(path.join(path.dirname(target), staged[0]!), alias);
      writeFileSync(continued, "continue");
      const outcome = await outcomePromise;
      expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/LINK_COUNT_CHANGED/u) });
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(path.dirname(target)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      expect(readFileSync(alias, "utf8")).toBe("staged-evidence-bytes");
      expect(statSync(alias).nlink).toBe(1);
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a same-size target replacement after readback and before return", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-final-replace-"));
    const reached = path.join(root, "verified");
    const continued = path.join(root, "continue");
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/final/evidence.json`;
    const seed = new SecureEvidenceStore(root);
    const target = seed.resolve(relative);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(async ({SecureEvidenceStore})=>{
        try { const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'after_cleanup_before_return',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});const bytes=Buffer.from('original-bytes');const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},undefined)); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, relative, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    const outcomePromise = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      rmSync(target);
      writeFileSync(target, "attacker-bytes");
      expect(Buffer.byteLength("attacker-bytes")).toBe(Buffer.byteLength("original-bytes"));
      writeFileSync(continued, "continue");
      const outcome = await outcomePromise;
      expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/IDENTITY_CHANGED|READBACK_MISMATCH|identity changed|readback mismatch/u) });
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds or rejects replacement at the actual leased last boundary before caller success", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-lease-race-"));
    const reached = path.join(root, "lease-reached");
    const continued = path.join(root, "continue");
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/lease/evidence.json`;
    const target = new SecureEvidenceStore(root).resolve(relative);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(async ({SecureEvidenceStore})=>{
        try { const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'lease_verified_before_return',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});const bytes=Buffer.from('leased-original');const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},undefined)); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, relative, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    const outcomePromise = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      let replaced = false;
      try {
        rmSync(target);
        writeFileSync(target, "leased-attacker");
        replaced = true;
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      writeFileSync(continued, "continue");
      const outcome = await outcomePromise;
      if (replaced) expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/consumer and lease both failed/u) });
      else expect(outcome).toEqual({ ok: true });
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.runIf(process.platform !== "win32")("rejects pathname replacement after the final verified inode handle is open", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-final-handle-"));
    const reached = path.join(root, "handle-pinned");
    const continued = path.join(root, "continue");
    const relative = `${canonicalManifest.retainedEvidence.root}/runs/final-handle/evidence.json`;
    const target = new SecureEvidenceStore(root).resolve(relative);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(async ({SecureEvidenceStore})=>{
        try { const store=new SecureEvidenceStore(workerData.root,{test:{boundary:'final_handle_pinned',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});const bytes=Buffer.from('original-bytes');const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},undefined)); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, relative, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      rmSync(target);
      writeFileSync(target, "attacker-bytes");
      writeFileSync(continued, "continue");
      const outcome = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
        worker.once("message", resolve); worker.once("error", reject);
      });
      expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/pathname|identity/u) });
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a fresh directory recreated at the same lexical root pathname", async () => {
    const owner = mkdtempSync(path.join(tmpdir(), "rbp-secure-root-id-"));
    const root = path.join(owner, "artifact");
    const moved = path.join(owner, "artifact-moved");
    mkdirSync(root);
    const store = new SecureEvidenceStore(root);
    renameSync(root, moved);
    mkdirSync(root);
    try {
      await expect(acceptWrite(store, `${canonicalManifest.retainedEvidence.root}/identity.json`, "must not publish"))
        .rejects.toThrow(/identity changed|IDENTITY_CHANGED/u);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
  });

  it("fails a synchronized constructor swap after the root handle is pinned", async () => {
    const owner = mkdtempSync(path.join(tmpdir(), "rbp-secure-constructor-swap-"));
    const root = path.join(owner, "artifact");
    const moved = path.join(owner, "artifact-moved");
    const reached = path.join(owner, "baseline-reached");
    const continued = path.join(owner, "continue");
    mkdirSync(root);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
      import(workerData.moduleUrl).then(({SecureEvidenceStore})=>{
        try { new SecureEvidenceStore(workerData.root,{test:{boundary:'constructor_baseline_pinned',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}}); parentPort.postMessage({ok:true}); }
        catch(error){ parentPort.postMessage({ok:false,message:error.message}); }
      });
    `, { eval: true, workerData: {
      moduleUrl: new URL("../dist/src/secureEvidenceStore.js", import.meta.url).href,
      root, reached, continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
    } });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(reached) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(reached)).toBe(true);
      renameSync(root, moved);
      mkdirSync(root);
      writeFileSync(continued, "continue");
      const outcome = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
        worker.once("message", resolve); worker.once("error", reject);
      });
      expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/identity changed/u) });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await worker.terminate();
      rmSync(owner, { recursive: true, force: true });
    }
  });

  it("confines atomic writes, refuses replacement, and leaves no staging file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-"));
    try {
      const store = new SecureEvidenceStore(root);
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/run-1/cases/O1-C19/evidence.json`;
      const stored = await acceptWrite(store, relative, "observed bytes");
      expect(readFileSync(stored.absolutePath, "utf8")).toBe("observed bytes");
      expect(readdirSync(path.dirname(stored.absolutePath))).toEqual(["evidence.json"]);
      await expect(acceptWrite(store, relative, "replacement")).rejects.toThrow(/already exists/u);
      await expect(acceptWrite(store,
        `${canonicalManifest.retainedEvidence.root}/../../escaped.json`,
        "escape",
      )).rejects.toThrow(/escapes retained root/u);
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
        if(process.platform==='win32'){process.env.SystemRoot=workerData.windowsRoot;process.env.WINDIR=workerData.windowsRoot;}
        import(workerData.moduleUrl).then(async ({ SecureEvidenceStore }) => {
          try {
            const store = new SecureEvidenceStore(workerData.root,{test:{boundary:'stage_complete',reachedMarker:workerData.reached,continueMarker:workerData.continued,timeoutMs:5000}});
            const bytes=Buffer.from(workerData.contents);const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
            const result = await store.writeAccepted(workerData.relative,bytes,c=>c.acceptExact({logicalPath:workerData.relative,absolutePath:store.resolve(workerData.relative),bytes,sha256},{bytes:c.bytes}));
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
            root, relative, contents: content, reached: path.join(root, `publisher-${index}-staged`), continued, windowsRoot: process.env.SystemRoot ?? process.env.WINDIR,
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
      await expect(acceptWrite(store, relative, "replacement")).rejects.toThrow(/already exists/u);
      expect(readFileSync(target, "utf8")).toBe(winner.bytes);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects real junction or symlink roots and intermediate directories without writing through them", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-reparse-"));
    const target = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-target-"));
    try {
      // Windows junction creation does not require symlink privileges. This
      // test runs on Windows as well as POSIX; neither branch is skipped.
      const kind = process.platform === "win32" ? "junction" : "dir";
      const linkRoot = path.join(root, "reparse-root");
      symlinkSync(target, linkRoot, kind);
      expect(lstatSync(linkRoot).isSymbolicLink()).toBe(true);
      expect(() => new SecureEvidenceStore(linkRoot)).toThrow(/plain directory|identity changed|substituted directory identity/u);
      const store = new SecureEvidenceStore(root);
      const linkDirectory = path.join(store.retainedRoot, "junction");
      symlinkSync(target, linkDirectory, kind);
      expect(lstatSync(linkDirectory).isSymbolicLink()).toBe(true);
      await expect(acceptWrite(store, `${canonicalManifest.retainedEvidence.root}/junction/escape.json`, "escape"))
        .rejects.toThrow(/plain directory|IDENTITY_CHANGED|identity changed/u);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
import { createHash } from "node:crypto";
