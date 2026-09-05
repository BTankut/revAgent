import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type { GatewayPrivateObjectBinding, GatewayOwnedPrivateObjectMetadata, ObjectStorePort, PrivateObjectStoreBackendPort } from "./store.js";
import { GATEWAY_PRIVATE_OBJECT_MAX_BYTES } from "./store.js";

/** Private immutable filesystem envelopes used by the production serving owner.
 * Uses tenant confinement, digest/descriptor checks and exclusive writes. */
export class FilesystemPrivateObjectStore implements PrivateObjectStoreBackendPort {
  readonly kind = "fs" as const;
  readonly #root: string;
  #physicalRoot: string | null = null;
  #ready: Promise<void> | null = null;
  public constructor(root: string) { this.#root = path.resolve(root, "objects"); }

  #objectFailure<T>(message: string): GatewayPortResult<T> {
    return Object.freeze({
      ok: false as const,
      port: "object_store" as const,
      code: "unavailable" as const,
      message,
    });
  }

  #file(tenantId: string, storageKey: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) ||
        !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null;
    return path.join(this.#root, tenantId, storageKey.slice(7));
  }

  async #assertNoLinkComponent(candidate: string): Promise<void> {
    const parsed = path.parse(candidate);
    let current = parsed.root;
    for (const part of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("production object path contains a link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  async #assertContained(candidate: string): Promise<void> {
    const root = await this.#assertPhysicalRootCurrent();
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("production object path escaped root");
    }
  }

  async #assertPhysicalRootCurrent(): Promise<string> {
    if (this.#physicalRoot === null) throw new Error("production object root is not opened");
    const current = await realpath(this.#root);
    const normalize = (value: string): string => process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
    if (normalize(current) !== normalize(this.#physicalRoot) ||
        (await lstat(this.#root)).isSymbolicLink()) {
      throw new Error("production object physical root changed");
    }
    return this.#physicalRoot;
  }

  async #withDeleteRootPinned<T>(action: () => Promise<T>): Promise<T> {
    await this.#open();
    const pin = await open(path.join(this.#root, ".production-owner-v1"), "r+");
    try {
      await this.#assertPhysicalRootCurrent();
      return await action();
    } finally {
      await pin.close();
    }
  }

  async #open(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    this.#ready = (async () => {
      await this.#assertNoLinkComponent(path.dirname(this.#root));
      await mkdir(path.dirname(this.#root), { recursive: true });
      const marker = path.join(this.#root, ".production-owner-v1");
      try {
        await mkdir(this.#root, { recursive: false, mode: 0o700 });
        await this.#writeAtomic(marker, Buffer.from("revagent-production-owner/v1", "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const rootStat = await lstat(this.#root);
        if (rootStat.isSymbolicLink()) throw new Error("production object root is a link");
        if (process.platform !== "win32" &&
            (rootStat.uid !== process.getuid!() || (rootStat.mode & 0o077) !== 0)) {
          throw new Error("production object root access is too broad");
        }
        if ((await readFile(marker, "utf8")) !== "revagent-production-owner/v1") {
          throw new Error("production object root is unowned");
        }
      }
      this.#physicalRoot = await realpath(this.#root);
      await this.#assertPhysicalRootCurrent();
      await this.#syncDirectory(path.dirname(this.#root));
    })();
    return this.#ready;
  }

  async #ensureTenant(tenantId: string): Promise<void> {
    await this.#open();
    await this.#assertPhysicalRootCurrent();
    const tenant = path.join(this.#root, tenantId);
    try { await mkdir(tenant, { recursive: false, mode: 0o700 }); await this.#syncDirectory(this.#root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(tenant);
    if (stat.isSymbolicLink()) throw new Error("production tenant directory is a link");
    await this.#assertContained(tenant);
  }

  async #readableFile(file: string): Promise<void> {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("production object is a link");
    await this.#assertContained(file);
  }

  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    await rename(temporary, file);
    await this.#syncDirectory(path.dirname(file));
  }

  async #syncDirectory(directory: string): Promise<void> {
    // Production images run Linux. Windows is only an isolated unit-test host.
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #writeExclusive(file: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
      await link(temporary, file);
      await this.#syncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #readContainer(tenantId: string, storageKey: string): Promise<{
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly owner: GatewayPrivateObjectBinding | null;
  } | null> {
    const file = this.#file(tenantId, storageKey);
    if (file === null) throw new Error("production object key rejected");
    try {
      await this.#open();
      await this.#readableFile(file);
      const container = await readFile(file);
      if (container.subarray(0, 5).toString("utf8") !== "RACO1") throw new Error("container magic");
      const headerLength = container.readUInt32BE(5);
      const header = JSON.parse(container.subarray(9, 9 + headerLength).toString("utf8")) as {
        v: number;
        digest: string;
        storageKey?: string;
        length: number;
        contentType: string;
        owner?: GatewayPrivateObjectBinding;
      };
      const bytes = container.subarray(9 + headerLength);
      const byteDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const ordinary = header.v === 1 && header.owner === undefined &&
        header.storageKey === undefined && header.digest === storageKey && byteDigest === storageKey;
      const owned = header.v === 2 && header.owner !== undefined &&
        header.storageKey === storageKey && header.digest === header.owner.digest &&
        header.owner.tenantId === tenantId && header.owner.storageKey === storageKey &&
        header.owner.byteLength === bytes.byteLength &&
        header.owner.contentType === header.contentType && byteDigest === header.owner.digest;
      if ((!ordinary && !owned) || header.length !== bytes.byteLength ||
          header.contentType.length === 0 || header.contentType.length > 256) {
        throw new Error("container integrity");
      }
      return { bytes, contentType: header.contentType, owner: header.owner ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #putContainer(input: {
    readonly tenantId: string;
    readonly storageKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly owner: GatewayPrivateObjectBinding | null;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    const file = this.#file(input.tenantId, input.storageKey);
    const byteDigest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
    const identityValid = input.owner === null
      ? byteDigest === input.storageKey
      : input.owner.tenantId === input.tenantId &&
        input.owner.storageKey === input.storageKey &&
        input.owner.byteLength === input.bytes.byteLength &&
        input.owner.digest === byteDigest && input.owner.contentType === input.contentType;
    if (file === null || input.bytes.byteLength > GATEWAY_PRIVATE_OBJECT_MAX_BYTES ||
        !identityValid || input.contentType.length === 0 || input.contentType.length > 256) {
      return this.#objectFailure("production object digest rejected");
    }
    try {
      await this.#ensureTenant(input.tenantId);
      const header = Buffer.from(JSON.stringify({
        v: input.owner === null ? 1 : 2,
        digest: input.owner?.digest ?? input.storageKey,
        ...(input.owner === null ? {} : { storageKey: input.storageKey }),
        length: input.bytes.byteLength,
        contentType: input.contentType,
        ...(input.owner === null ? {} : { owner: input.owner }),
      }), "utf8");
      const container = Buffer.concat([
        Buffer.from("RACO1"),
        Buffer.from(Uint32Array.of(header.byteLength).buffer).swap32(),
        header,
        input.bytes,
      ]);
      if (input.owner === null) {
        await this.#writeAtomic(file, container);
      } else if (!await this.#writeExclusive(file, container)) {
        const prior = await this.#readContainer(input.tenantId, input.storageKey);
        if (prior === null || prior.owner === null ||
            JSON.stringify(prior.owner) !== JSON.stringify(input.owner) ||
            prior.contentType !== input.contentType ||
            !Buffer.from(prior.bytes).equals(input.bytes)) {
          return this.#objectFailure("owned production object key is already bound");
        }
      }
      return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } });
    } catch {
      return this.#objectFailure("production object write refused");
    }
  }

  async put(input: Parameters<ObjectStorePort["put"]>[0]): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    return await this.#putContainer({ ...input, owner: null });
  }

  async get(input: Parameters<ObjectStorePort["get"]>[0]): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> {
    try {
      const value = await this.#readContainer(input.tenantId, input.storageKey);
      return value === null
        ? this.#objectFailure("production object unavailable")
        : Object.freeze({ ok: true as const, value: { bytes: value.bytes, contentType: value.contentType } });
    } catch { return this.#objectFailure("production object unavailable"); }
  }

  async getOptional(input: Parameters<NonNullable<ObjectStorePort["getOptional"]>>[0]): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>> {
    try {
      const value = await this.#readContainer(input.tenantId, input.storageKey);
      return Object.freeze({
        ok: true as const,
        value: value === null ? null : { bytes: value.bytes, contentType: value.contentType },
      });
    } catch { return this.#objectFailure("production object unavailable"); }
  }

  async head(input: Parameters<ObjectStorePort["head"]>[0]): Promise<GatewayPortResult<{ readonly byteSize: number }>> {
    const result = await this.get(input);
    return result.ok
      ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } })
      : result;
  }

  async delete(input: Parameters<ObjectStorePort["delete"]>[0]): Promise<GatewayPortResult<void>> {
    const file = this.#file(input.tenantId, input.storageKey);
    if (file === null) return this.#objectFailure("production object key rejected");
    try {
      await this.#withDeleteRootPinned(async () => {
        await this.#readableFile(file);
        await rm(file);
        await this.#syncDirectory(path.dirname(file));
      });
      return Object.freeze({ ok: true as const, value: undefined });
    } catch { return this.#objectFailure("production object unavailable"); }
  }

  async putOwned(input: {
    readonly binding: GatewayPrivateObjectBinding;
    readonly bytes: Uint8Array;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    if (input.binding.byteLength !== input.bytes.byteLength) {
      return this.#objectFailure("owned production object descriptor rejected");
    }
    return await this.#putContainer({
      tenantId: input.binding.tenantId,
      storageKey: input.binding.storageKey,
      bytes: input.bytes,
      contentType: input.binding.contentType,
      owner: input.binding,
    });
  }

  async getOwnedOptional(input: { readonly binding: GatewayPrivateObjectBinding }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>> {
    try {
      const value = await this.#readContainer(input.binding.tenantId, input.binding.storageKey);
      if (value === null) return Object.freeze({ ok: true as const, value: null });
      if (value.owner === null || JSON.stringify(value.owner) !== JSON.stringify(input.binding)) {
        return this.#objectFailure("owned production object descriptor mismatch");
      }
      return Object.freeze({ ok: true as const, value: { bytes: value.bytes, contentType: value.contentType } });
    } catch { return this.#objectFailure("owned production object unavailable"); }
  }

  async deleteOwned(input: { readonly binding: GatewayPrivateObjectBinding }): Promise<GatewayPortResult<{ readonly state: "deleted" | "missing" }>> {
    const file = this.#file(input.binding.tenantId, input.binding.storageKey);
    if (file === null) return this.#objectFailure("owned production object key rejected");
    try {
      return await this.#withDeleteRootPinned(async () => {
        const existing = await this.getOwnedOptional(input);
        if (!existing.ok) return existing;
        if (existing.value === null) {
          return Object.freeze({ ok: true as const, value: { state: "missing" as const } });
        }
        await this.#readableFile(file);
        await rm(file);
        await this.#syncDirectory(path.dirname(file));
        return Object.freeze({ ok: true as const, value: { state: "deleted" as const } });
      });
    } catch { return this.#objectFailure("owned production object delete failed"); }
  }

  async scanOwned(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly purpose?: GatewayPrivateObjectBinding["purpose"];
    readonly afterKey: string | null;
    readonly limit: number;
  }): Promise<GatewayPortResult<readonly GatewayOwnedPrivateObjectMetadata[]>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64 ||
        !/^[a-zA-Z0-9_-]+$/u.test(input.tenantId)) {
      return this.#objectFailure("owned production object inventory rejected");
    }
    try {
      await this.#open();
      await this.#assertPhysicalRootCurrent();
      const tenantRoot = path.join(this.#root, input.tenantId);
      let names: string[];
      try { names = await readdir(tenantRoot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return Object.freeze({ ok: true as const, value: Object.freeze([]) });
        }
        throw error;
      }
      const rows: GatewayOwnedPrivateObjectMetadata[] = [];
      for (const name of names.sort()) {
        const storageKey = `sha256:${name}`;
        if (!/^sha256:[0-9a-f]{64}$/u.test(storageKey) ||
            (input.afterKey !== null && storageKey <= input.afterKey)) continue;
        const value = await this.#readContainer(input.tenantId, storageKey);
        if (value?.owner === null || value?.owner === undefined) continue;
        if (value.owner.rsid !== input.rsid ||
            (input.purpose !== undefined && value.owner.purpose !== input.purpose)) continue;
        rows.push(Object.freeze({ ...value.owner }));
        if (rows.length === input.limit) break;
      }
      return Object.freeze({ ok: true as const, value: Object.freeze(rows) });
    } catch { return this.#objectFailure("owned production object inventory unavailable"); }
  }
}
