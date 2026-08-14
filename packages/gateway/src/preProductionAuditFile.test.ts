import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPreProductionAuditFileWriter,
  derivePreProductionAuditFilePath,
  PRE_PRODUCTION_AUDIT_FILE_MODE,
} from "./preProductionAuditFile.js";
import { PreProductionAuditArtifactError } from "./preProductionAuditWriter.js";

const CANARY = "SYNTHETIC-AUDIT-FILE-SECRET__DO-NOT-RETAIN";
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "revagent-m4-audit-"));
  roots.push(root);
  return root;
}

function options(
  signal = new AbortController().signal,
  markCommitted: () => void = () => undefined,
) {
  return { signal, markCommitted };
}

function expectNoTemporaryFiles(root: string): void {
  expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
    [],
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("M4 pre-production atomic audit file", () => {
  it("derives one deterministic sibling from the enrollment output path", () => {
    const root = temporaryRoot();
    expect(
      derivePreProductionAuditFilePath(join(root, "enrollment.json")),
    ).toBe(join(root, "enrollment.audit.jsonl"));
    expect(
      derivePreProductionAuditFilePath(join(root, "enrollment")),
    ).toBe(join(root, "enrollment.audit.jsonl"));
    expect(() =>
      derivePreProductionAuditFilePath("relative/enrollment.json"),
    ).toThrowError("invalid pre-production audit source path");
  });

  it("publishes exact bytes once with the target read-only mode", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    const value = '{"ok":true,"state":"complete"}\n';
    let commits = 0;

    await createPreProductionAuditFileWriter(finalPath).commit(
      value,
      options(new AbortController().signal, () => {
        commits += 1;
      }),
    );

    expect(commits).toBe(1);
    expect(readFileSync(finalPath)).toEqual(Buffer.from(value, "utf8"));
    const stat = statSync(finalPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(stat.size).toBe(Buffer.byteLength(value, "utf8"));
    if (process.platform === "win32") {
      expect(stat.mode & 0o222).toBe(0);
    } else {
      expect(stat.mode & 0o7777).toBe(PRE_PRODUCTION_AUDIT_FILE_MODE);
      expect(stat.uid).toBe(process.getuid?.());
    }
    expectNoTemporaryFiles(root);
  });

  it("never clobbers a preexisting destination and removes its own temp", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    const original = "PREEXISTING-AUDIT-EVIDENCE\n";
    writeFileSync(finalPath, original, {
      encoding: "utf8",
      mode: PRE_PRODUCTION_AUDIT_FILE_MODE,
    });
    chmodSync(finalPath, PRE_PRODUCTION_AUDIT_FILE_MODE);
    let commits = 0;

    await expect(
      createPreProductionAuditFileWriter(finalPath).commit(
        "replacement\n",
        options(new AbortController().signal, () => {
          commits += 1;
        }),
      ),
    ).rejects.toMatchObject({
      code: "preproduction_audit_artifact_failed",
      reason: "commit_failed",
    });

    expect(commits).toBe(0);
    expect(readFileSync(finalPath, "utf8")).toBe(original);
    expectNoTemporaryFiles(root);
  });

  it("removes both staged and final links when the commit marker fails", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    let caught: unknown;

    try {
      await createPreProductionAuditFileWriter(finalPath).commit(
        `${CANARY}\n`,
        options(new AbortController().signal, () => {
          throw new Error(CANARY);
        }),
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ reason: "commit_failed" });
    expect(inspect(caught)).not.toContain(CANARY);
    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves no final or temporary artifact when already aborted", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    const abort = new AbortController();
    abort.abort();

    await expect(
      createPreProductionAuditFileWriter(finalPath).commit(
        `${CANARY}\n`,
        options(abort.signal),
      ),
    ).rejects.toMatchObject({ reason: "commit_failed" });

    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses every direct second attempt without new filesystem residue", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    const writer = createPreProductionAuditFileWriter(finalPath);
    await writer.commit("first\n", options());

    await expect(writer.commit(`${CANARY}\n`, options())).rejects.toThrowError(
      "pre-production audit artifact failed: commit_failed",
    );

    expect(readFileSync(finalPath, "utf8")).toBe("first\n");
    expectNoTemporaryFiles(root);
  });

  it("refuses a directly symlinked parent without staging bytes", async () => {
    const root = temporaryRoot();
    const physical = join(root, "physical");
    const linked = join(root, "linked");
    mkdirSync(physical, { mode: 0o700 });
    symlinkSync(
      physical,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      createPreProductionAuditFileWriter(
        join(linked, "enrollment.audit.jsonl"),
      ).commit(`${CANARY}\n`, options()),
    ).rejects.toMatchObject({ reason: "commit_failed" });

    expect(readdirSync(physical)).toEqual([]);
  });

  it("refuses a non-canonical parent reached through an aliased ancestor", async () => {
    const root = temporaryRoot();
    const physical = join(root, "physical");
    const leaf = join(physical, "leaf");
    const alias = join(root, "alias");
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    symlinkSync(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      createPreProductionAuditFileWriter(
        join(alias, "leaf", "enrollment.audit.jsonl"),
      ).commit(`${CANARY}\n`, options()),
    ).rejects.toMatchObject({ reason: "commit_failed" });

    expect(readdirSync(leaf)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a group/world-writable POSIX parent",
    async () => {
      const root = temporaryRoot();
      chmodSync(root, 0o777);

      await expect(
        createPreProductionAuditFileWriter(
          join(root, "enrollment.audit.jsonl"),
        ).commit(`${CANARY}\n`, options()),
      ).rejects.toMatchObject({ reason: "commit_failed" });

      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("surfaces an unremovable owned-final replacement as cleanup_failed", async () => {
    const root = temporaryRoot();
    const finalPath = join(root, "enrollment.audit.jsonl");
    const displaced = join(root, "displaced-audit.jsonl");
    let caught: unknown;

    try {
      await createPreProductionAuditFileWriter(finalPath).commit(
        `${CANARY}\n`,
        options(new AbortController().signal, () => {
          renameSync(finalPath, displaced);
          mkdirSync(finalPath);
          throw new Error(CANARY);
        }),
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PreProductionAuditArtifactError);
    expect(caught).toMatchObject({
      code: "preproduction_audit_artifact_failed",
      reason: "cleanup_failed",
    });
    expect(inspect(caught)).not.toContain(CANARY);
    expect(existsSync(displaced)).toBe(true);
    expect(statSync(finalPath).isDirectory()).toBe(true);
    expectNoTemporaryFiles(root);
  });
});
