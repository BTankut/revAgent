import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HandlerManifestError,
  verifyHandlerManifest,
  type HandlerManifest,
} from "./handlerManifest.js";

const HANDLERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "handlers",
);

function loadRealManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(HANDLERS_DIR, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

function readRealModule(file: string): Uint8Array {
  return readFileSync(join(HANDLERS_DIR, file));
}

/** Re-seals a mutated body so a test reaches the check it is aiming at. */
function reseal(body: Record<string, unknown>): Record<string, unknown> {
  const { manifestDigest: _omitted, ...rest } = body;
  const canonical = canonicalize(rest);
  return {
    ...rest,
    manifestDigest: `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function expectRejection(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerManifestError);
    expect((error as HandlerManifestError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but nothing threw`);
}

describe("handler manifest", () => {
  const real = loadRealManifest();
  const seedDigest = real.seedDigest as string;

  it("accepts the manifest and modules the packager actually produced", () => {
    // Against the real bytes, not a fixture: a fixture would keep passing after
    // the packager changed what it emits.
    const verified: HandlerManifest = verifyHandlerManifest(real, {
      seedDigest,
      readModule: readRealModule,
    });

    expect(verified.modules.map((m) => m.module).sort()).toEqual([
      "docs",
      "runtime",
    ]);
    const runtime = verified.modules.find((m) => m.module === "runtime");
    expect(runtime?.chokepointsRebound).toBeGreaterThan(0);
  });

  it("refuses a module whose bytes changed after packaging", () => {
    expectRejection(
      () =>
        verifyHandlerManifest(real, {
          seedDigest,
          readModule: (file) => {
            const bytes = readRealModule(file);
            // Same length, one byte different: catches substitution that a
            // size check alone would pass.
            const tampered = Uint8Array.from(bytes);
            tampered[0] = tampered[0] ^ 0xff;
            return tampered;
          },
        }),
      "module_digest_mismatch",
    );
  });

  it("refuses a module that was truncated or padded", () => {
    expectRejection(
      () =>
        verifyHandlerManifest(real, {
          seedDigest,
          readModule: (file) => readRealModule(file).slice(0, 128),
        }),
      "module_size_mismatch",
    );
  });

  it("refuses a manifest field edited without resealing", () => {
    const tampered = { ...real, seedDigest: "sha256:" + "0".repeat(64) };
    expectRejection(
      () =>
        verifyHandlerManifest(tampered, {
          seedDigest,
          readModule: readRealModule,
        }),
      "manifest_digest_mismatch",
    );
  });

  it("refuses a resealed manifest built for a different seed", () => {
    // Resealed, so the digest check passes and the seed binding is what fires.
    // Without this binding a valid seed could be paired with handlers packaged
    // from an entirely different tool set.
    const other = reseal({ ...real, seedDigest: `sha256:${"a".repeat(64)}` });
    expectRejection(
      () =>
        verifyHandlerManifest(other, {
          seedDigest,
          readModule: readRealModule,
        }),
      "manifest_seed_mismatch",
    );
  });

  it("refuses a runtime module that declares no rebound transport", () => {
    // The field a hand-edited manifest would zero out to describe a
    // socket-carrying module as acceptable.
    const modules = (real.modules as Record<string, unknown>[]).map((entry) =>
      entry.module === "runtime" ? { ...entry, chokepointsRebound: 0 } : entry,
    );
    expectRejection(
      () =>
        verifyHandlerManifest(reseal({ ...real, modules }), {
          seedDigest,
          readModule: readRealModule,
        }),
      "manifest_transport_not_rebound",
    );
  });
});
