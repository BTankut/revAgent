import { constants } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  loadPreProductionTlsMaterial,
  type PreProductionTlsFileStat,
  type PreProductionTlsMaterialIo,
} from "./preProductionTlsMaterial.js";

const KEY_PATH = "/run/revagent/m4/tls.key";
const CERT_PATH = "/run/revagent/m4/tls.crt";
const KEY = "SYNTHETIC-M4-TLS-PRIVATE-KEY-NOT-A-REAL-KEY";
const CERT = "SYNTHETIC-M4-TLS-CERTIFICATE-NOT-A-REAL-CERTIFICATE";

function stat(ino: number, size: number): PreProductionTlsFileStat {
  return Object.freeze({
    file: true,
    symbolicLink: false,
    dev: 7,
    ino,
    mode: 0o100400,
    nlink: 1,
    uid: 1000,
    size,
    mtimeMs: 10,
    ctimeMs: 10,
  });
}

function io(overrides: {
  readonly platform?: NodeJS.Platform;
  readonly mutateAfterRead?: string;
  readonly mode?: number;
} = {}): PreProductionTlsMaterialIo {
  const bytes = new Map([
    [KEY_PATH, Buffer.from(KEY)],
    [CERT_PATH, Buffer.from(CERT)],
  ]);
  const stats = new Map([
    [KEY_PATH, stat(11, Buffer.byteLength(KEY))],
    [CERT_PATH, stat(12, Buffer.byteLength(CERT))],
  ]);
  if (overrides.mode !== undefined) {
    stats.set(KEY_PATH, { ...stats.get(KEY_PATH)!, mode: overrides.mode });
  }
  return {
    platform: overrides.platform ?? "linux",
    currentUid: () => 1000,
    isAbsolute: (value) => value.startsWith("/"),
    resolve: (value) => value,
    lstat: async (value) => stats.get(value)!,
    realpath: async (value) => value,
    open: async (value, flags) => {
      expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
      let reads = 0;
      return {
        stat: async () => {
          reads += 1;
          const current = stats.get(value)!;
          return overrides.mutateAfterRead === value && reads > 1
            ? { ...current, mtimeMs: current.mtimeMs + 1 }
            : current;
        },
        readFile: async () => bytes.get(value)!,
        close: async () => undefined,
      };
    },
  };
}

describe("M4 pre-production TLS material", () => {
  it("reads two exact owner-only canonical files without following links", async () => {
    const loaded = await loadPreProductionTlsMaterial(
      { keyFilePath: KEY_PATH, certificateFilePath: CERT_PATH },
      io(),
    );
    expect(loaded.key.toString("utf8")).toBe(KEY);
    expect(loaded.cert.toString("utf8")).toBe(CERT);
  });

  it.each([
    ["unsupported_platform", io({ platform: "win32" })],
    ["invalid_permissions", io({ mode: 0o100440 })],
    ["changed_during_read", io({ mutateAfterRead: KEY_PATH })],
  ] as const)("fails closed with value-free reason %s", async (reason, fixture) => {
    let caught: unknown;
    try {
      await loadPreProductionTlsMaterial(
        { keyFilePath: KEY_PATH, certificateFilePath: CERT_PATH },
        fixture,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "preproduction_tls_material_refused",
      reason,
    });
    expect(JSON.stringify(caught)).not.toContain("SYNTHETIC-M4-TLS");
  });
});
