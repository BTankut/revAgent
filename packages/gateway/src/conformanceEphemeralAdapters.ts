import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
  type DeviceAuthContext,
  type EntitlementPort,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { GatewayEventEnvelope, GatewayEventSink } from "./events.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type {
  GatewayProtocolStore,
  GatewayStartupCoordinator,
  ObjectStorePort,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import type { GuardrailPort } from "./guardrails.js";

const CONTRACT = "revagent.conformance-ephemeral/v1" as const;
const failure = <T>(message: string): GatewayPortResult<T> => Object.freeze({
  ok: false as const, port: "identity" as const, code: "unavailable" as const, message,
});
const storeFailure = <T>(code: "conflict" | "invalid_record" | "unavailable", message: string): StoreOutcome<T> =>
  Object.freeze({ ok: false as const, code, message });
const storeSuccess = <T>(value: T): StoreOutcome<T> => Object.freeze({ ok: true as const, value });

export interface ConformanceCredential {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly revoked?: boolean;
}

/** HMAC-backed loopback credential authority.  It is intentionally public-test only. */
export class ConformanceCredentialAuthority implements IdentityPort {
  readonly kind = "conformance" as const;
  readonly #secret: Buffer;
  readonly #credentials = new Map<string, ConformanceCredential>();
  readonly #audit: Array<{ readonly action: "issued" | "revoked" | "authenticated"; readonly deviceId: string }> = [];
  public constructor(credentials: readonly ConformanceCredential[], secret = randomBytes(32)) {
    this.#secret = Buffer.from(secret);
    for (const credential of credentials) this.#credentials.set(credential.deviceId, Object.freeze({ ...credential }));
  }
  public issue(deviceId: string): string {
    const credential = this.#credentials.get(deviceId);
    if (credential === undefined) throw new Error("unknown conformance device");
    const proof = createHmac("sha256", this.#secret).update(`${credential.deviceId}:${credential.token}`).digest("hex");
    this.#audit.push({ action: "issued", deviceId });
    return `${credential.deviceId}.${proof}`;
  }
  public revoke(deviceId: string): boolean {
    const value = this.#credentials.get(deviceId);
    if (value === undefined) return false;
    this.#credentials.set(deviceId, Object.freeze({ ...value, revoked: true }));
    this.#audit.push({ action: "revoked", deviceId });
    return true;
  }
  public audit(): readonly { readonly action: "issued" | "revoked" | "authenticated"; readonly deviceId: string }[] {
    return Object.freeze([...this.#audit]);
  }
  async authenticateNorthRequest(input: { readonly authorization: string | undefined }): Promise<GatewayPortResult<AuthContext>> {
    const bearer = input.authorization?.replace(/^Bearer\s+/u, "");
    const match = bearer === undefined ? undefined : [...this.#credentials.values()].find((row) => row.token === bearer && !row.revoked);
    if (match === undefined) return failure("conformance north credential rejected");
    const now = Date.now();
    const context: AuthContext = {
      contractVersion: GATEWAY_AUTH_CONTRACT_VERSION, actor: { type: "user", tenantId: match.tenantId, userId: match.userId, role: "tenant_admin", oidcIssuer: "conformance://loopback", oidcSubject: match.userId },
      session: { sessionId: `conformance-${match.deviceId}`, clientType: "mcp", mcpSessionId: null, oauthClientId: null }, principalKey: `conformance:${match.tenantId}:${match.userId}`, issuedAtMs: now, expiresAtMs: now + 60_000,
    };
    return Object.freeze({ ok: true as const, value: context });
  }
  async authenticateDevice(input: { readonly deviceToken: string | undefined; readonly connectionId: string; readonly claimedDeviceId?: string; readonly machineFingerprint?: string }): Promise<GatewayPortResult<DeviceAuthContext>> {
    const rawToken = input.deviceToken;
    const [deviceId, proof] = rawToken?.split(".") ?? [];
    const credential = deviceId === undefined ? undefined : this.#credentials.get(deviceId);
    const expected = credential === undefined ? "" : createHmac("sha256", this.#secret).update(`${credential.deviceId}:${credential.token}`).digest("hex");
    const valid = proof !== undefined && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
    if (!valid || credential === undefined || credential.revoked || input.claimedDeviceId !== deviceId || input.machineFingerprint === undefined || !/^sha256:[0-9a-f]{64}$/u.test(input.machineFingerprint)) return failure("conformance device credential rejected");
    this.#audit.push({ action: "authenticated", deviceId });
    const context: DeviceAuthContext = {
      contractVersion: GATEWAY_AUTH_CONTRACT_VERSION, actor: { type: "device", tenantId: credential.tenantId, userId: credential.userId, deviceId, seatId: `seat-${deviceId}` }, connectionId: input.connectionId, deviceStatus: "active", machineFingerprint: input.machineFingerprint as `sha256:${string}`,
      authorizationVersion: 1, identityRecordVersion: 1, connectionCapabilityVersion: 1, sessionCapabilityVersion: 1, seatAuthorityVersion: 1, seatRecordVersion: 1,
      grantedConnectionCapabilities: ["journal_v1", "transport_streamable_http"], grantedSessionCapabilities: ["batch_atomic", "doc_context_cached_v1"], deviceTokenDigest: `sha256:${createHash("sha256").update(rawToken!).digest("hex")}`,
    };
    return Object.freeze({ ok: true as const, value: context });
  }
}

type DiskRecord = { tenantId: string; namespace: string; key: string; value: GatewayJsonValue; version: number; updatedAtMs: number };
type DiskState = { contract: typeof CONTRACT; records: readonly DiskRecord[] };

/** File-backed durable conformance store. The file name is sqlite.db so external tooling has a stable artifact boundary. */
export class SqliteConformanceProtocolStore implements GatewayProtocolStore {
  readonly kind = "conformance" as const;
  readonly contractVersion = "revagent.protocol-store/v1" as const;
  readonly #file: string;
  #state: DiskState = { contract: CONTRACT, records: [] };
  #opened = false;
  #exclusive: Promise<void> = Promise.resolve();
  public readonly startupCoordinator: GatewayStartupCoordinator;
  public constructor(root: string) {
    this.#file = path.join(root, "sqlite.db");
    this.startupCoordinator = Object.freeze({ contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: async <T>(work: () => Promise<StoreOutcome<T>>) => this.#withLock(work),
      listTenantIds: async (limit: number) => storeSuccess([...new Set(this.#state.records.map((record) => record.tenantId))].sort().slice(0, limit)),
      listKeys: async (tenantId: string, namespace: string, limit: number) => storeSuccess(this.#state.records.filter((row) => row.tenantId === tenantId && row.namespace === namespace).map((row) => row.key).sort().slice(0, limit)),
    });
  }
  async #withLock<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> { const previous = this.#exclusive; let release!: () => void; this.#exclusive = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  async open(): Promise<StoreOutcome<void>> { try { await mkdir(path.dirname(this.#file), { recursive: true }); try { const parsed = JSON.parse(await readFile(this.#file, "utf8")) as DiskState; if (parsed.contract !== CONTRACT || !Array.isArray(parsed.records)) return storeFailure("invalid_record", "conformance store schema rejected"); this.#state = parsed; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.#persist(); } this.#opened = true; return storeSuccess(undefined); } catch { return storeFailure("unavailable", "conformance durable store unavailable"); } }
  async close(): Promise<StoreOutcome<void>> { this.#opened = false; return storeSuccess(undefined); }
  async #persist(): Promise<void> { const temporary = `${this.#file}.${randomBytes(8).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(this.#state), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.#file); }
  async transact<T>(scope: { readonly tenantId: string }, fn: (tx: StoreTransaction) => Promise<T> | T): Promise<StoreOutcome<T>> { return this.#withLock(async () => { if (!this.#opened || !scope.tenantId) return storeFailure("unavailable", "conformance store is closed"); const initial = this.#state.records; const staged: Array<{ namespace: string; key: string; value: GatewayJsonValue | null; expect: StoreExpectation }> = []; const find = (namespace: string, key: string) => initial.find((row) => row.tenantId === scope.tenantId && row.namespace === namespace && row.key === key) ?? null; const tx: StoreTransaction = { read: async <TRecord extends GatewayJsonValue>(namespace: string, key: string) => find(namespace, key) as StoredRecord<TRecord> | null, list: async (namespace) => initial.filter((row) => row.tenantId === scope.tenantId && row.namespace === namespace) as readonly StoredRecord[], stage: (write) => staged.push({ ...write }) }; let result: T; try { result = await fn(tx); } catch { return storeFailure("invalid_record", "conformance transaction rejected"); } const next = [...initial]; for (const write of staged) { const index = next.findIndex((row) => row.tenantId === scope.tenantId && row.namespace === write.namespace && row.key === write.key); const current = index < 0 ? null : next[index]; if ((write.expect.kind === "absent" && current !== null) || (write.expect.kind === "version" && (current === null || current.version !== write.expect.version))) return storeFailure("conflict", "conformance compare-and-swap conflicted"); if (write.value === null) { if (index >= 0) next.splice(index, 1); continue; } const record: DiskRecord = { tenantId: scope.tenantId, namespace: write.namespace, key: write.key, value: write.value, version: (current?.version ?? 0) + 1, updatedAtMs: Date.now() }; if (index >= 0) next[index] = record; else next.push(record); } this.#state = { contract: CONTRACT, records: next }; try { await this.#persist(); return storeSuccess(result); } catch { this.#state = { contract: CONTRACT, records: initial }; return storeFailure("unavailable", "conformance durable commit failed"); } }); }
}

export class DigestFileConformanceObjectStore implements ObjectStorePort {
  readonly kind = "conformance" as const;
  public constructor(private readonly root: string) {}
  #file(tenantId: string, storageKey: string): string | null { if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) || !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null; return path.join(this.root, tenantId, storageKey.slice(7)); }
  async put(input: { readonly tenantId: string; readonly storageKey: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<GatewayPortResult<{ readonly storageKey: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null || `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` !== input.storageKey) return failure("conformance object digest rejected") as GatewayPortResult<{ readonly storageKey: string }>; try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, input.bytes, { mode: 0o600, flag: "wx" }); await writeFile(`${file}.content-type`, input.contentType, { mode: 0o600, flag: "wx" }); return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } }); } catch { return failure("conformance object write refused") as GatewayPortResult<{ readonly storageKey: string }>; } }
  async get(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; try { const bytes = await readFile(file); if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.storageKey) return failure("conformance object digest mismatch") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; return Object.freeze({ ok: true as const, value: { bytes, contentType: await readFile(`${file}.content-type`, "utf8") } }); } catch { return failure("conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; } }
  async head(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly byteSize: number }>> { const result = await this.get(input); return result.ok ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } }) : result as GatewayPortResult<{ readonly byteSize: number }>; }
  async delete(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<void>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<void>; try { await rm(file); await rm(`${file}.content-type`); return Object.freeze({ ok: true as const, value: undefined }); } catch { return failure("conformance object unavailable") as GatewayPortResult<void>; } }
}

export function createConformanceSupportingPorts(): { readonly entitlement: EntitlementPort; readonly events: GatewayEventSink; readonly guardrails: GuardrailPort } {
  const ok = <T>(value: T): GatewayPortResult<T> => Object.freeze({ ok: true as const, value });
  return Object.freeze({ entitlement: Object.freeze({ kind: "conformance" as const, async checkModuleEntitlement() { return ok(true); }, async checkToolEntitlement() { return ok(true); } }), events: Object.freeze({ kind: "conformance" as const, async emit(_event: GatewayEventEnvelope) { return ok(undefined); }, async emitBatch(_events: readonly GatewayEventEnvelope[]) { return ok(undefined); }, async flush() { return ok(undefined); } }), guardrails: Object.freeze({ kind: "conformance" as const, async evaluate() { return Object.freeze({ ok: true as const }); } }) });
}
