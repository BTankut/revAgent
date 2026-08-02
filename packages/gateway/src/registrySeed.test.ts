import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RegistrySeedError, verifyRegistrySeed } from "./registrySeed.js";

const SEED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry-seed.json",
);

function loadSeed(): Record<string, unknown> {
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, unknown>;
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

/** Re-seals an edited seed so tests exercise a gate other than the digest. */
function reseal(seed: Record<string, unknown>): Record<string, unknown> {
  const body = { seedVersion: seed.seedVersion, tools: seed.tools };
  return {
    ...seed,
    seedDigest: `sha256:${createHash("sha256")
      .update(canonicalize(body), "utf8")
      .digest("hex")}`,
  };
}

describe("registry seed", () => {
  it("carries the complete 35 runtime + 5 docs surface", () => {
    const seed = verifyRegistrySeed(loadSeed());
    expect(seed.tools).toHaveLength(40);
    expect(seed.tools.filter((tool) => tool.module === "runtime")).toHaveLength(35);
    expect(seed.tools.filter((tool) => tool.module === "docs")).toHaveLength(5);
  });

  it("gives every tool a distinct handler identity", () => {
    // The first collector hashed the shared telemetry wrapper and produced six
    // digests for forty tools, which would have made the startup hash gate
    // accept any handler change.
    const seed = verifyRegistrySeed(loadSeed());
    const digests = new Set(seed.tools.map((tool) => tool.handlerDigest));
    expect(digests.size).toBe(40);
  });

  it("keeps the collected surface byte-stable", () => {
    const seed = verifyRegistrySeed(loadSeed());
    const body = { seedVersion: seed.seedVersion, tools: seed.tools };
    const recomputed = `sha256:${createHash("sha256")
      .update(canonicalize(body), "utf8")
      .digest("hex")}`;
    expect(recomputed).toBe(seed.seedDigest);
  });

  it("names every tool and binds it to its own built module", () => {
    const seed = verifyRegistrySeed(loadSeed());
    for (const tool of seed.tools) {
      expect(tool.handlerModule).toBe(`${tool.name}.js`);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputJsonSchema).toBeTypeOf("object");
    }
  });

  it("rejects a seed whose content was edited after collection", () => {
    const seed = loadSeed();
    const tools = [...(seed.tools as Record<string, unknown>[])];
    tools[0] = { ...tools[0], description: "tampered" };
    expect(() => verifyRegistrySeed({ ...seed, tools })).toThrowError(
      /does not match its content/u,
    );
  });

  it("rejects a dropped tool even when the digest is resealed", () => {
    const seed = loadSeed();
    const tools = (seed.tools as Record<string, unknown>[]).slice(1);
    expect(() => verifyRegistrySeed(reseal({ ...seed, tools }))).toThrowError(
      RegistrySeedError,
    );
  });

  it("rejects two tools sharing one handler digest", () => {
    const seed = loadSeed();
    const tools = [...(seed.tools as Record<string, unknown>[])];
    tools[1] = { ...tools[1], handlerDigest: tools[0].handlerDigest };
    expect(() => verifyRegistrySeed(reseal({ ...seed, tools }))).toThrowError(
      /handler identity is not distinguishing/u,
    );
  });

  it("rejects an unsorted seed", () => {
    const seed = loadSeed();
    const tools = [...(seed.tools as Record<string, unknown>[])];
    [tools[0], tools[1]] = [tools[1], tools[0]];
    expect(() => verifyRegistrySeed(reseal({ ...seed, tools }))).toThrowError(
      /name-sorted/u,
    );
  });
});
