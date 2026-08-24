import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const MAX_KEY_FILE_BYTES = 8_192;
const MAX_KEY_COUNT = 16;
const KEY_BYTES = 32;
const KID = /^[A-Za-z0-9._-]{1,64}$/u;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/u;
export type ProtectedObjectKeyReadiness = "ready" | "unsupported_platform" | "not_configured" | "key_unavailable";

/** C2b supplies this from durable recovery receipts; callers cannot name keys. */
export interface ProtectedObjectLiveKeyInventoryPort {
  readonly kind: "durable" | "conformance";
  listLiveKids(): Promise<readonly string[] | null>;
}
export interface ProtectedObjectKeySnapshot { readonly activeKid: string; readonly kids: readonly string[]; keyFor(kid: string): Uint8Array | null; }
export interface ProtectedObjectKeyProvider {
  readonly kind: "fs" | "conformance" | "unavailable";
  readonly inventory: ProtectedObjectLiveKeyInventoryPort;
  readiness(): Promise<ProtectedObjectKeyReadiness>;
  snapshot(): Promise<ProtectedObjectKeySnapshot | null>;
  selfTest(): Promise<boolean>;
}
interface ParsedKeyFile { readonly activeKid: string; readonly keys: ReadonlyMap<string, Buffer>; }
interface Identity { readonly dev: number; readonly ino: number; readonly uid: number; readonly mode: number; }
function zero(value: Uint8Array | null | undefined): void { value?.fill(0); }
function same(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && timingSafeEqual(left, right); }
function identity(value: { dev: number; ino: number; uid: number; mode: number }): Identity { return Object.freeze({ dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode & 0o777 }); }
function equalIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode; }
function safeAncestor(stat: { readonly isDirectory: () => boolean; readonly uid: number; readonly mode: number }, euid: number): boolean {
  if (!stat.isDirectory() || (stat.uid !== euid && stat.uid !== 0)) return false;
  // A root-owned sticky directory (for example /tmp) cannot have a child
  // replaced by another uid; all other group/world-writable ancestors fail.
  return (stat.mode & 0o022) === 0 || (stat.uid === 0 && (stat.mode & 0o1000) !== 0);
}

function parseCanonicalKeyFile(source: Buffer): ParsedKeyFile | null {
  if (source.byteLength === 0 || source.byteLength > MAX_KEY_FILE_BYTES) return null;
  let parsed: unknown; try { parsed = JSON.parse(source.toString("utf8")); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as { v?: unknown; active_kid?: unknown; keys?: unknown };
  if (candidate.v !== 1 || typeof candidate.active_kid !== "string" || !KID.test(candidate.active_kid) || candidate.keys === null || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) return null;
  const entries = Object.entries(candidate.keys as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_KEY_COUNT || !entries.every(([kid, value]) => KID.test(kid) && typeof value === "string" && BASE64_32.test(value))) return null;
  const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right));
  if (!sorted.some(([kid]) => kid === candidate.active_kid)) return null;
  const canonical = `{"v":1,"active_kid":${JSON.stringify(candidate.active_kid)},"keys":{${sorted.map(([kid, value]) => `${JSON.stringify(kid)}:${JSON.stringify(value)}`).join(",")}}}`;
  if (!same(source, Buffer.from(canonical, "utf8"))) return null;
  const keys = new Map<string, Buffer>();
  for (const [kid, encoded] of sorted) { const key = Buffer.from(encoded as string, "base64"); if (key.byteLength !== KEY_BYTES || key.toString("base64") !== encoded) { zero(key); for (const item of keys.values()) zero(item); return null; } keys.set(kid, key); }
  return { activeKid: candidate.active_kid, keys };
}
function immutableSnapshot(parsed: ParsedKeyFile): ProtectedObjectKeySnapshot {
  const copied = new Map<string, Buffer>(); for (const [kid, key] of parsed.keys) copied.set(kid, Buffer.from(key));
  return Object.freeze({ activeKid: parsed.activeKid, kids: Object.freeze([...copied.keys()].sort()), keyFor(kid: string): Uint8Array | null { const value = copied.get(kid); return value === undefined ? null : Buffer.from(value); } });
}
async function liveKids(inventory: ProtectedObjectLiveKeyInventoryPort): Promise<ReadonlySet<string> | null> {
  const values = await inventory.listLiveKids();
  if (values === null || values.length > MAX_KEY_COUNT || values.some((kid) => !KID.test(kid)) || new Set(values).size !== values.length) return null;
  return new Set(values);
}

/** Linux-only descriptor-anchored reader: path components are never reopened by name. */
export class LinuxFileProtectedObjectKeyProvider implements ProtectedObjectKeyProvider {
  readonly kind = "fs" as const;
  readonly #configuredPath: string | null; readonly #platform: NodeJS.Platform;
  readonly inventory: ProtectedObjectLiveKeyInventoryPort;
  readonly #boundaryHook: (() => Promise<void> | void) | undefined;
  #current: ProtectedObjectKeySnapshot | null = null;
  public constructor(options: { readonly keyFilePath: string | null; readonly inventory: ProtectedObjectLiveKeyInventoryPort; readonly platform?: NodeJS.Platform; readonly boundaryHook?: () => Promise<void> | void }) { this.#configuredPath = options.keyFilePath === null ? null : path.resolve(options.keyFilePath); this.#platform = options.platform ?? process.platform; this.inventory = options.inventory; this.#boundaryHook = options.boundaryHook; }
  async readiness(): Promise<ProtectedObjectKeyReadiness> { if (this.#platform !== "linux") return "unsupported_platform"; if (this.#configuredPath === null || this.inventory.kind !== "durable") return "not_configured"; return (await this.#reload()) === null ? "key_unavailable" : "ready"; }
  async snapshot(): Promise<ProtectedObjectKeySnapshot | null> { return this.#platform === "linux" ? this.#reload() : null; }
  async selfTest(): Promise<boolean> { const snapshot = await this.snapshot(); const key = snapshot?.keyFor(snapshot.activeKid) ?? null; zero(key); return key !== null; }
  async #reload(): Promise<ProtectedObjectKeySnapshot | null> {
    if (this.#configuredPath === null || this.inventory.kind !== "durable") return null;
    const required = await liveKids(this.inventory); if (required === null) return null;
    let file: Awaited<ReturnType<typeof open>> | null = null; const directories: Awaited<ReturnType<typeof open>>[] = []; let bytes: Buffer | null = null;
    try {
      const pieces = this.#configuredPath.split(path.sep).filter(Boolean); if (pieces.length === 0) throw new Error("bad path");
      let current = await open(path.parse(this.#configuredPath).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); directories.push(current);
      const anchored: Array<{ readonly name: string; readonly identity: Identity }> = [{ name: path.parse(this.#configuredPath).root, identity: identity(await current.stat()) }]; const geteuid = process.geteuid; if (geteuid === undefined) throw new Error("missing euid"); const euid = geteuid();
      for (const component of pieces.slice(0, -1)) { const next = await open(`/proc/self/fd/${String(current.fd)}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); const stat = await next.stat(); if (!safeAncestor(stat, euid)) throw new Error("unsafe ancestor"); directories.push(next); current = next; anchored.push({ name: component, identity: identity(stat) }); }
      await this.#boundaryHook?.();
      const finalName = pieces.at(-1)!; file = await open(`/proc/self/fd/${String(current.fd)}/${finalName}`, constants.O_RDONLY | constants.O_NOFOLLOW); const before = await file.stat();
      if (!before.isFile() || before.uid !== euid || (before.mode & 0o777) !== 0o400 || before.nlink !== 1 || before.size <= 0 || before.size > MAX_KEY_FILE_BYTES) throw new Error("unsafe key file");
      bytes = await file.readFile(); const after = await file.stat(); if (!equalIdentity(identity(before), identity(after)) || before.size !== after.size) throw new Error("key file raced");
      let named = path.parse(this.#configuredPath).root; for (const anchor of anchored.slice(1)) { named = path.join(named, anchor.name); const stat = await lstat(named); if (stat.isSymbolicLink() || !equalIdentity(anchor.identity, identity(stat))) throw new Error("configured ancestry changed"); }
      const namedFile = await lstat(this.#configuredPath); if (namedFile.isSymbolicLink() || !equalIdentity(identity(before), identity(namedFile))) throw new Error("configured key changed");
      const parsed = parseCanonicalKeyFile(bytes); if (parsed === null || [...required].some((kid) => !parsed.keys.has(kid))) throw new Error("live key missing");
      const snapshot = immutableSnapshot(parsed); for (const key of parsed.keys.values()) zero(key); this.#current = snapshot; return snapshot;
    } catch { return null; } finally { zero(bytes); await file?.close().catch(() => undefined); await Promise.all(directories.reverse().map((handle) => handle.close().catch(() => undefined))); }
  }
}

/** Fixture-only provider; production config has no selector for `conformance`. */
export class ConformanceProtectedObjectKeyProvider implements ProtectedObjectKeyProvider {
  readonly kind = "conformance" as const; readonly inventory: ProtectedObjectLiveKeyInventoryPort; readonly #snapshot: ProtectedObjectKeySnapshot;
  public constructor(activeKid: string, keys: ReadonlyMap<string, Uint8Array>, inventory: ProtectedObjectLiveKeyInventoryPort) { if (inventory.kind !== "conformance" || !KID.test(activeKid) || !keys.has(activeKid) || keys.size === 0 || keys.size > MAX_KEY_COUNT) throw new Error("invalid conformance protected key fixture"); const copied = new Map<string, Buffer>(); for (const [kid, key] of keys) { if (!KID.test(kid) || key.byteLength !== KEY_BYTES) throw new Error("invalid conformance protected key fixture"); copied.set(kid, Buffer.from(key)); } this.#snapshot = immutableSnapshot({ activeKid, keys: copied }); for (const value of copied.values()) zero(value); this.inventory = inventory; }
  async readiness(): Promise<ProtectedObjectKeyReadiness> { return (await this.snapshot()) === null ? "key_unavailable" : "ready"; }
  async snapshot(): Promise<ProtectedObjectKeySnapshot | null> { const required = await liveKids(this.inventory); return required === null || [...required].some((kid) => !this.#snapshot.kids.includes(kid)) ? null : this.#snapshot; }
  async selfTest(): Promise<boolean> { return (await this.snapshot()) !== null; }
}
export function createDefaultProtectedObjectKeyProvider(keyFilePath: string | null, inventory: ProtectedObjectLiveKeyInventoryPort): ProtectedObjectKeyProvider { return new LinuxFileProtectedObjectKeyProvider({ keyFilePath, inventory }); }
