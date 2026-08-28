import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

  it("publishes one concurrent writer without replacement and rejects a reparse root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-race-"));
    try {
      const relative = `${canonicalManifest.retainedEvidence.root}/runs/run-2/cases/O1-C29/evidence.json`;
      const first = new SecureEvidenceStore(root);
      const second = new SecureEvidenceStore(root);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => first.write(relative, "first")),
        Promise.resolve().then(() => second.write(relative, "second")),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(readFileSync(path.join(root, relative), "utf8")).toMatch(/^(?:first|second)$/u);

      if (process.platform !== "win32") {
        const target = mkdtempSync(path.join(tmpdir(), "rbp-secure-store-target-"));
        const linkRoot = path.join(root, "reparse-root");
        try {
          symlinkSync(target, linkRoot, "dir");
          expect(() => new SecureEvidenceStore(linkRoot)).toThrow(/plain directory/u);
        } finally {
          rmSync(target, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
