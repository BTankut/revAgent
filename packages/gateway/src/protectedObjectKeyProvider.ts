import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import path from "node:path";

const MAX_KEY_FILE_BYTES = 8_192;
const MAX_KEY_COUNT = 16;
const KEY_BYTES = 32;
const KID = /^[A-Za-z0-9._-]{1,64}$/u;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/u;

export type ProtectedObjectKeyReadiness =
  | "ready"
  | "unsupported_platform"
  | "not_configured"
  | "key_unavailable";

export interface ProtectedObjectKeySnapshot {
  readonly activeKid: string;
  readonly kids: readonly string[];
  keyFor(kid: string): Uint8Array | null;
}

export interface ProtectedObjectKeyProvider {
  readonly kind: "fs" | "conformance" | "unavailable";
  readiness(): Promise<ProtectedObjectKeyReadiness>;
  snapshot(liveKids?: ReadonlySet<string>): Promise<ProtectedObjectKeySnapshot | null>;
  selfTest(liveKids?: ReadonlySet<string>): Promise<boolean>;
}

interface ParsedKeyFile {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

function zero(value: Uint8Array): void {
  value.fill(0);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function parseCanonicalKeyFile(source: Buffer): ParsedKeyFile | null {
  if (source.byteLength === 0 || source.byteLength > MAX_KEY_FILE_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(source.toString("utf8")); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as { v?: unknown; active_kid?: unknown; keys?: unknown };
  if (candidate.v !== 1 || typeof candidate.active_kid !== "string" || !KID.test(candidate.active_kid) || candidate.keys === null || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) return null;
  const entries = Object.entries(candidate.keys as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_KEY_COUNT || !entries.every(([kid, value]) => KID.test(kid) && typeof value === "string" && BASE64_32.test(value))) return null;
  const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right));
  if (!sorted.some(([kid]) => kid === candidate.active_kid)) return null;
  // Byte-exact canonical v1 prevents duplicate JSON spellings, whitespace, or
  // alternate base64 encodings from becoming deploy-time key ambiguity.
  const canonical = `{"v":1,"active_kid":${JSON.stringify(candidate.active_kid)},"keys":{${sorted.map(([kid, value]) => `${JSON.stringify(kid)}:${JSON.stringify(value)}`).join(",")}}}`;
  if (!safeEqual(source, Buffer.from(canonical, "utf8"))) return null;
  const keys = new Map<string, Buffer>();
  for (const [kid, encoded] of sorted) {
    const key = Buffer.from(encoded as string, "base64");
    if (key.byteLength !== KEY_BYTES || key.toString("base64") !== encoded) {
      zero(key);
      for (const value of keys.values()) zero(value);
      return null;
    }
    keys.set(kid, key);
  }
  return { activeKid: candidate.active_kid, keys };
}

function immutableSnapshot(parsed: ParsedKeyFile): ProtectedObjectKeySnapshot {
  const snapshotKeys = new Map<string, Buffer>();
  for (const [kid, key] of parsed.keys) snapshotKeys.set(kid, Buffer.from(key));
  const kids = Object.freeze([...snapshotKeys.keys()].sort());
  return Object.freeze({
    activeKid: parsed.activeKid,
    kids,
    keyFor(kid: string): Uint8Array | null {
      const key = snapshotKeys.get(kid);
      return key === undefined ? null : Buffer.from(key);
    },
  });
}

async function assertNoLinkComponents(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("link component");
  }
}

/** Linux-only key reader.  There is deliberately no environment-key path. */
export class LinuxFileProtectedObjectKeyProvider implements ProtectedObjectKeyProvider {
  readonly kind = "fs" as const;
  readonly #configuredPath: string | null;
  readonly #platform: NodeJS.Platform;
  #last: ProtectedObjectKeySnapshot | null = null;

  public constructor(options: { readonly keyFilePath: string | null; readonly platform?: NodeJS.Platform }) {
    this.#configuredPath = options.keyFilePath === null ? null : path.resolve(options.keyFilePath);
    this.#platform = options.platform ?? process.platform;
  }

  async readiness(): Promise<ProtectedObjectKeyReadiness> {
    if (this.#platform !== "linux") return "unsupported_platform";
    if (this.#configuredPath === null) return "not_configured";
    return (await this.#load(undefined)) === null ? "key_unavailable" : "ready";
  }

  async snapshot(liveKids: ReadonlySet<string> = new Set()): Promise<ProtectedObjectKeySnapshot | null> {
    if (this.#platform !== "linux" || this.#configuredPath === null) return null;
    return this.#load(liveKids);
  }

  async selfTest(liveKids: ReadonlySet<string> = new Set()): Promise<boolean> {
    const snapshot = await this.snapshot(liveKids);
    if (snapshot === null) return false;
    const active = snapshot.keyFor(snapshot.activeKid);
    if (active === null) return false;
    zero(active);
    return true;
  }

  async #load(liveKids: ReadonlySet<string> | undefined): Promise<ProtectedObjectKeySnapshot | null> {
    if (this.#configuredPath === null) return null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let bytes: Buffer | null = null;
    try {
      await assertNoLinkComponents(this.#configuredPath);
      const parentReal = await realpath(path.dirname(this.#configuredPath));
      const expected = path.join(parentReal, path.basename(this.#configuredPath));
      handle = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
      const descriptor = await handle.stat();
      if (!descriptor.isFile() || descriptor.uid !== process.geteuid?.() || (descriptor.mode & 0o777) !== 0o400 || descriptor.nlink !== 1 || descriptor.size <= 0 || descriptor.size > MAX_KEY_FILE_BYTES) throw new Error("unsafe key file");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (descriptor.dev !== after.dev || descriptor.ino !== after.ino || descriptor.size !== after.size) throw new Error("key file raced");
      const parsed = parseCanonicalKeyFile(bytes);
      if (parsed === null) throw new Error("malformed key file");
      if (liveKids !== undefined && [...liveKids].some((kid) => !parsed.keys.has(kid))) throw new Error("live key removed");
      const snapshot = immutableSnapshot(parsed);
      for (const key of parsed.keys.values()) zero(key);
      this.#last = snapshot; // Assignment occurs only after all validation: atomic reload.
      return snapshot;
    } catch {
      return null;
    } finally {
      if (bytes !== null) zero(bytes);
      await handle?.close().catch(() => undefined);
    }
  }
}

/** Fixture-only provider.  Composition has no configuration selector for it. */
export class ConformanceProtectedObjectKeyProvider implements ProtectedObjectKeyProvider {
  readonly kind = "conformance" as const;
  readonly #snapshot: ProtectedObjectKeySnapshot;
  public constructor(activeKid: string, keys: ReadonlyMap<string, Uint8Array>) {
    if (!KID.test(activeKid) || !keys.has(activeKid) || keys.size === 0 || keys.size > MAX_KEY_COUNT) throw new Error("invalid conformance protected key fixture");
    const converted = new Map<string, Buffer>();
    for (const [kid, key] of keys) {
      if (!KID.test(kid) || key.byteLength !== KEY_BYTES) throw new Error("invalid conformance protected key fixture");
      converted.set(kid, Buffer.from(key));
    }
    this.#snapshot = immutableSnapshot({ activeKid, keys: converted });
    for (const key of converted.values()) zero(key);
  }
  async readiness(): Promise<ProtectedObjectKeyReadiness> { return "ready"; }
  async snapshot(liveKids: ReadonlySet<string> = new Set()): Promise<ProtectedObjectKeySnapshot | null> {
    return [...liveKids].every((kid) => this.#snapshot.kids.includes(kid)) ? this.#snapshot : null;
  }
  async selfTest(liveKids: ReadonlySet<string> = new Set()): Promise<boolean> { return (await this.snapshot(liveKids)) !== null; }
}

export function createDefaultProtectedObjectKeyProvider(keyFilePath: string | null): ProtectedObjectKeyProvider {
  return new LinuxFileProtectedObjectKeyProvider({ keyFilePath });
}
