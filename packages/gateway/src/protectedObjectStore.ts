import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { GatewayPortResult } from "./gatewayPorts.js";
import type { ObjectStorePort, ProtectedObjectBinding, ProtectedObjectStorePort } from "./store.js";
import type { ProtectedObjectKeyProvider, ProtectedObjectKeyReadiness } from "./protectedObjectKeyProvider.js";

const MAGIC = Buffer.from("RAPO", "ascii");
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const C39_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
export const C39_PROTECTED_OBJECT_MAX_ENVELOPE_BYTES =
  C39_MAX_PLAINTEXT_BYTES + MAGIC.byteLength + 2 + 64 + NONCE_BYTES + TAG_BYTES;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;

export const C39_PROTECTED_OBJECT_CONTENT_TYPE = "application/vnd.revagent.c39.protected-object";

function refuse<T>(): GatewayPortResult<T> {
  return Object.freeze({ ok: false as const, port: "object_store" as const, code: "unavailable" as const, message: "protected object unavailable" });
}

function zero(value: Uint8Array | null | undefined): void { value?.fill(0); }

function validBinding(binding: ProtectedObjectBinding): boolean {
  return TOKEN.test(binding.tenantId) && TOKEN.test(binding.userId) && TOKEN.test(binding.principalKey) && TOKEN.test(binding.effectiveMcpSessionId) && TOKEN.test(binding.sessionBindingId) && Number.isSafeInteger(binding.sessionBindingVersion) && binding.sessionBindingVersion >= 1 && TOKEN.test(binding.rsid) && UUID.test(binding.recoveryInvocationId) && UUID.test(binding.originInvocationId) && DIGEST.test(binding.originResultDigest) && DIGEST.test(binding.resultRefDigest) && binding.originResultDigest !== binding.resultRefDigest && DIGEST.test(binding.plainDigest) && binding.purpose === "dispatch_payload_recovery" && Number.isSafeInteger(binding.bridgeSequence) && binding.bridgeSequence >= 0 && Number.isSafeInteger(binding.chunkIndex) && binding.chunkIndex >= 0 && Number.isSafeInteger(binding.plainLength) && binding.plainLength >= 0 && Number.isSafeInteger(binding.expiresAtMs) && binding.expiresAtMs > 0;
}

function aad(storageKey: string, binding: ProtectedObjectBinding): Buffer | null {
  if (!DIGEST.test(storageKey) || !validBinding(binding)) return null;
  // Fixed field order is the canonical domain.  Length prefixes make the
  // encoding injective even if a future legal token gains a separator.
  const values = ["revagent.c39.protected-object/aad/v1", storageKey, binding.tenantId, binding.userId, binding.principalKey, binding.effectiveMcpSessionId, binding.sessionBindingId, String(binding.sessionBindingVersion), binding.rsid, binding.recoveryInvocationId, binding.originInvocationId, binding.originResultDigest, binding.resultRefDigest, String(binding.bridgeSequence), String(binding.chunkIndex), binding.plainDigest, String(binding.plainLength), binding.purpose, String(binding.expiresAtMs)];
  if (values.some((value) => value.length > 512)) return null;
  return Buffer.from(values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|"), "utf8");
}

function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function encode(kid: string, nonce: Buffer, tag: Buffer, ciphertext: Buffer): Buffer | null {
  const kidBytes = Buffer.from(kid, "ascii");
  if (kidBytes.byteLength === 0 || kidBytes.byteLength > 64 || nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES || ciphertext.byteLength > C39_MAX_PLAINTEXT_BYTES) return null;
  return Buffer.concat([MAGIC, Buffer.from([VERSION, kidBytes.byteLength]), kidBytes, nonce, tag, ciphertext]);
}

function decode(value: Uint8Array): { readonly kid: string; readonly nonce: Buffer; readonly tag: Buffer; readonly ciphertext: Buffer } | null {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < MAGIC.byteLength + 2 + 1 + NONCE_BYTES + TAG_BYTES || bytes.byteLength > C39_PROTECTED_OBJECT_MAX_ENVELOPE_BYTES || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC) || bytes[MAGIC.byteLength] !== VERSION) { zero(bytes); return null; }
  const kidLength = bytes[MAGIC.byteLength + 1]!;
  const start = MAGIC.byteLength + 2;
  const cipherStart = start + kidLength + NONCE_BYTES + TAG_BYTES;
  if (kidLength === 0 || kidLength > 64 || cipherStart > bytes.byteLength) { zero(bytes); return null; }
  const kid = bytes.subarray(start, start + kidLength).toString("ascii");
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(kid)) { zero(bytes); return null; }
  const result = { kid, nonce: Buffer.from(bytes.subarray(start + kidLength, start + kidLength + NONCE_BYTES)), tag: Buffer.from(bytes.subarray(start + kidLength + NONCE_BYTES, cipherStart)), ciphertext: Buffer.from(bytes.subarray(cipherStart)) };
  zero(bytes);
  return result;
}

export class EncryptedProtectedObjectStore implements ProtectedObjectStorePort {
  readonly kind: "fs" | "conformance" | "unavailable";
  readonly #inner: ObjectStorePort;
  readonly #keys: ProtectedObjectKeyProvider;
  readonly #randomBytes: (size: number) => Buffer;
  public constructor(inner: ObjectStorePort, keys: ProtectedObjectKeyProvider, crypto: { readonly randomBytes?: (size: number) => Buffer } = {}) {
    this.#inner = inner;
    this.#keys = keys;
    this.#randomBytes = crypto.randomBytes ?? randomBytes;
    this.kind = this.#keys.kind;
  }
  get readiness(): { readonly ready: boolean; readonly reason: ProtectedObjectKeyReadiness } {
    // The synchronous projection cannot claim readiness until a key snapshot is
    // verified.  Call `checkReadiness` during composition/startup.
    return Object.freeze({ ready: false, reason: "key_unavailable" as const });
  }
  async activeKid(): Promise<string | null> {
    const snapshot = await this.#keys.snapshot();
    return snapshot?.activeKid ?? null;
  }
  async checkReadiness(): Promise<{ readonly ready: boolean; readonly reason: ProtectedObjectKeyReadiness }> {
    const reason = await this.#keys.readiness();
    return Object.freeze({ ready: reason === "ready" && await this.#keys.selfTest(), reason: reason === "ready" ? "ready" : reason });
  }
  async putProtected(input: { readonly storageKey: string; readonly contentType: string; readonly bytes: Uint8Array; readonly binding: ProtectedObjectBinding; readonly kid?: string }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    let plain: Buffer | null = null; let key: Uint8Array | null = null; let aadBytes: Buffer | null = null; let nonce: Buffer | null = null; let ciphertext: Buffer | null = null; let tag: Buffer | null = null; let envelope: Buffer | null = null;
    try {
      // Size and claimed AAD length are checked before hashing/copying or any
      // crypto allocation.  The object store is never reached for oversize input.
      if (input.bytes.byteLength > C39_MAX_PLAINTEXT_BYTES || input.contentType.length === 0 || input.contentType.length > 256 || input.bytes.byteLength !== input.binding.plainLength) return refuse();
      aadBytes = aad(input.storageKey, input.binding);
      if (aadBytes === null) return refuse();
      if (digest(input.bytes) !== input.binding.plainDigest) return refuse();
      const snapshot = await this.#keys.snapshot();
      if (snapshot === null) return refuse();
      const kid = input.kid ?? snapshot.activeKid;
      key = snapshot.keyFor(kid);
      if (key === null) return refuse();
      plain = Buffer.from(input.bytes);
      nonce = this.#randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadBytes, { plaintextLength: plain.byteLength });
      ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      tag = cipher.getAuthTag();
      envelope = encode(kid, nonce, tag, ciphertext);
      if (envelope === null) return refuse();
      const stored = await this.#inner.put({ tenantId: input.binding.tenantId, storageKey: input.storageKey, bytes: envelope, contentType: C39_PROTECTED_OBJECT_CONTENT_TYPE });
      return stored.ok ? Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } }) : refuse();
    } catch { return refuse(); } finally { zero(plain); zero(key); zero(aadBytes); zero(nonce); zero(ciphertext); zero(tag); zero(envelope); }
  }
  async getProtected(input: { readonly storageKey: string; readonly contentType: string; readonly binding: ProtectedObjectBinding }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> {
    let aadBytes: Buffer | null = null; let key: Uint8Array | null = null; let decoded: ReturnType<typeof decode> = null; let plain: Buffer | null = null; let storedBytes: Uint8Array | null = null;
    try {
      if (input.contentType.length === 0 || input.contentType.length > 256 || !validBinding(input.binding)) return refuse();
      aadBytes = aad(input.storageKey, input.binding);
      if (aadBytes === null) return refuse();
      const stored = await this.#inner.get({ tenantId: input.binding.tenantId, storageKey: input.storageKey });
      if (!stored.ok || stored.value.contentType !== C39_PROTECTED_OBJECT_CONTENT_TYPE) return refuse();
      storedBytes = stored.value.bytes;
      decoded = decode(storedBytes);
      if (decoded === null) return refuse();
      const snapshot = await this.#keys.snapshot();
      key = snapshot?.keyFor(decoded.kid) ?? null;
      if (key === null) return refuse();
      const decipher = createDecipheriv("aes-256-gcm", key, decoded.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadBytes, { plaintextLength: input.binding.plainLength });
      decipher.setAuthTag(decoded.tag);
      plain = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
      if (plain.byteLength !== input.binding.plainLength || digest(plain) !== input.binding.plainDigest) return refuse();
      const result = Buffer.from(plain);
      return Object.freeze({ ok: true as const, value: { bytes: result, contentType: input.contentType } });
    } catch { return refuse(); } finally { zero(aadBytes); zero(key); zero(storedBytes); zero(decoded?.nonce); zero(decoded?.tag); zero(decoded?.ciphertext); zero(plain); }
  }

  async deleteProtected(input: { readonly storageKey: string; readonly contentType: string; readonly binding: ProtectedObjectBinding; readonly expectedKid: string; readonly deletionClaim: { readonly id: string; readonly version: number } }): Promise<GatewayPortResult<{ readonly state: "deleted" | "missing" }>> {
    let aadBytes: Buffer | null = null; let key: Uint8Array | null = null; let decoded: ReturnType<typeof decode> = null; let plain: Buffer | null = null; let storedBytes: Uint8Array | null = null;
    try {
      if (!/^[A-Za-z0-9._-]{1,64}$/u.test(input.expectedKid) || !/^[A-Za-z0-9._:-]{1,256}$/u.test(input.deletionClaim.id) || !Number.isSafeInteger(input.deletionClaim.version) || input.deletionClaim.version < 1 || input.contentType.length === 0 || input.contentType.length > 256 || !validBinding(input.binding)) return refuse();
      aadBytes = aad(input.storageKey, input.binding);
      if (aadBytes === null) return refuse();
      const optional = this.#inner.getOptional === undefined
        ? await this.#inner.get({ tenantId: input.binding.tenantId, storageKey: input.storageKey })
        : await this.#inner.getOptional({ tenantId: input.binding.tenantId, storageKey: input.storageKey });
      // Only an explicit optional-null is a positively reported absence.  A
      // port refusal, permission failure, or an adapter without this contract
      // remains opaque and cannot clear a durable deletion claim.
      if (!optional.ok) return refuse();
      if (optional.value === null) return Object.freeze({ ok: true as const, value: { state: "missing" as const } });
      const present = optional.value;
      if (present.contentType !== C39_PROTECTED_OBJECT_CONTENT_TYPE) return refuse();
      storedBytes = present.bytes;
      decoded = decode(storedBytes);
      if (decoded === null || decoded.kid !== input.expectedKid) return refuse();
      const snapshot = await this.#keys.snapshot();
      key = snapshot?.keyFor(decoded.kid) ?? null;
      if (key === null) return refuse();
      const decipher = createDecipheriv("aes-256-gcm", key, decoded.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadBytes, { plaintextLength: input.binding.plainLength });
      decipher.setAuthTag(decoded.tag);
      plain = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
      if (plain.byteLength !== input.binding.plainLength || digest(plain) !== input.binding.plainDigest) return refuse();
      const deleted = await this.#inner.delete({ tenantId: input.binding.tenantId, storageKey: input.storageKey });
      return deleted.ok ? Object.freeze({ ok: true as const, value: { state: "deleted" as const } }) : refuse();
    } catch { return refuse(); } finally { zero(aadBytes); zero(key); zero(storedBytes); zero(decoded?.nonce); zero(decoded?.tag); zero(decoded?.ciphertext); zero(plain); }
  }
}
