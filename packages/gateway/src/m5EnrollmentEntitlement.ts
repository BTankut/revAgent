import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import pg, { type PoolClient } from "pg";

import {
  isCanonicalMachineFingerprint,
  type AuthContext,
  type GatewayModuleName,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";

const { Pool } = pg;

export const M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION =
  "revagent.m5-enrollment-entitlement/v1" as const;
export const M5_ACTIVE_REVOKE_BOUND_MS = 5_000 as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]+$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODULES = new Set<GatewayModuleName>([
  "core",
  "mech",
  "arch",
  "struct",
  "elec",
]);

export type M5EnrollmentEntitlementFailureReason =
  | "invalid_request"
  | "admin_required"
  | "tenant_binding_denied"
  | "principal_binding_denied"
  | "device_binding_denied"
  | "enrollment_code_unknown"
  | "enrollment_code_reused"
  | "enrollment_code_expired"
  | "enrollment_conflict"
  | "device_credential_denied"
  | "seat_cap_exceeded"
  | "seat_binding_denied"
  | "entitlement_denied"
  | "connection_denied"
  | "device_revoked"
  | "invocation_conflict"
  | "invocation_in_progress"
  | "unavailable";

export interface M5EnrollmentEntitlementFailure {
  readonly ok: false;
  readonly reason: M5EnrollmentEntitlementFailureReason;
}

export type M5EnrollmentEntitlementResult<T> =
  | { readonly ok: true; readonly value: T }
  | M5EnrollmentEntitlementFailure;

export interface M5Capability {
  readonly name: string;
  readonly module: GatewayModuleName;
  readonly summary: string;
}

export interface M5BridgeExecutor {
  invoke(input: {
    readonly invocationId: string;
    readonly toolName: string;
    readonly params: GatewayJsonValue;
    readonly signal: AbortSignal;
  }): Promise<GatewayJsonValue>;
}

export interface M5BridgeCloseControl {
  close(code: number, reason: "device_revoked"): void;
}

export interface M5EnrollmentEntitlementOptions {
  readonly databaseUrl: string;
  /** Host-supplied HMAC key. Raw enrollment/device secrets are never stored. */
  readonly tokenPepper: string;
  readonly capabilities: readonly M5Capability[];
  readonly clock?: () => number;
  readonly rotationGraceMs?: number;
}

export interface M5MintEnrollmentInput {
  readonly principalUserId: string;
  readonly deviceId: string;
  readonly machineFingerprint: string;
  readonly expiresInMs?: number;
}

export interface M5IssuedEnrollmentCode {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly enrollmentId: string;
  readonly enrollmentCode: string;
  readonly expiresAtMs: number;
}

export interface M5EnrollmentExchange {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly deviceId: string;
  readonly deviceToken: string;
}

export interface M5BridgeConnection {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly connectionId: string;
  readonly tenantId: string;
  readonly principalUserId: string;
  readonly deviceId: string;
  readonly credentialVersion: number;
  readonly usedPreviousCredential: boolean;
}

export interface M5SeatAssignment {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly seatId: string;
  readonly module: GatewayModuleName;
  readonly principalUserId: string;
  readonly deviceId: string;
  readonly replayed: boolean;
}

export interface M5RotatedCredential {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly credentialVersion: number;
  readonly previousValidUntilMs: number;
}

export interface M5RevocationResult {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly deviceId: string;
  readonly changed: boolean;
  readonly closedConnectionCount: number;
  readonly maximumCloseLatencyMs: number;
  readonly withinBound: boolean;
}

export interface M5DispatchResult {
  readonly contractVersion: typeof M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION;
  readonly invocationId: string;
  readonly replayed: boolean;
  readonly result?: GatewayJsonValue;
}

interface LocatedCredential {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly credential_kind: "enrollment" | "device";
  readonly valid_until: Date | null;
}

interface ActiveConnection {
  readonly binding: M5BridgeConnection;
  readonly executor: M5BridgeExecutor;
  readonly closeControl: M5BridgeCloseControl;
  readonly abortController: AbortController;
}

function success<T>(value: T): M5EnrollmentEntitlementResult<T> {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function failure(
  reason: M5EnrollmentEntitlementFailureReason,
): M5EnrollmentEntitlementFailure {
  return Object.freeze({ ok: false as const, reason });
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function moduleName(value: unknown): value is GatewayModuleName {
  return typeof value === "string" && MODULES.has(value as GatewayModuleName);
}

function visibleSecret(value: string): boolean {
  return (
    value.length >= 32 &&
    value.length <= 4_096 &&
    [...value].every((character) => character >= "!" && character <= "~")
  );
}

function canonicalJson(value: GatewayJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function validGatewayJson(value: unknown): value is GatewayJsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 64) return false;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return true;
    }
    if (typeof candidate === "string") {
      return Buffer.byteLength(candidate, "utf8") <= 1_048_576;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.every((item) => visit(item, depth + 1));
    }
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(candidate).every(
      ([key, item]) =>
        Buffer.byteLength(key, "utf8") <= 512 && visit(item, depth + 1),
    );
  };
  return visit(value, 0);
}

function publicDigest(value: GatewayJsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function activeDeviceKey(tenantId: string, deviceId: string): string {
  return `${tenantId}\0${deviceId}`;
}

/**
 * EU-11's bounded M5 control-plane vertical. It composes the existing Bridge
 * enrollment wire shape with Postgres tenant/RLS authority. The only raw
 * secret outputs are the one-time code and newly issued device credential.
 */
export class M5EnrollmentEntitlementControlPlane {
  readonly #pool: pg.Pool;
  readonly #tokenPepper: string;
  readonly #clock: () => number;
  readonly #rotationGraceMs: number;
  readonly #capabilities: readonly M5Capability[];
  readonly #capabilityByName: ReadonlyMap<string, M5Capability>;
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #revokedDevices = new Set<string>();

  public constructor(options: M5EnrollmentEntitlementOptions) {
    if (!visibleSecret(options.tokenPepper)) {
      throw new Error("EU-11 token pepper must be 32-4096 visible ASCII characters");
    }
    const grace = options.rotationGraceMs ?? 60_000;
    if (!Number.isSafeInteger(grace) || grace <= 0 || grace > 24 * 60 * 60 * 1_000) {
      throw new Error("EU-11 rotation grace must be 1ms through 24h");
    }
    const capabilities = options.capabilities.map((capability) => {
      if (
        !TOOL_NAME_PATTERN.test(capability.name) ||
        !moduleName(capability.module) ||
        !boundedText(capability.summary)
      ) {
        throw new Error("EU-11 capability configuration is invalid");
      }
      return Object.freeze({ ...capability });
    });
    const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
    if (byName.size !== capabilities.length || capabilities.length === 0) {
      throw new Error("EU-11 capabilities must be non-empty and unique");
    }
    this.#pool = new Pool({ connectionString: options.databaseUrl });
    this.#tokenPepper = options.tokenPepper;
    this.#clock = options.clock ?? Date.now;
    this.#rotationGraceMs = grace;
    this.#capabilities = Object.freeze(
      [...capabilities].sort((left, right) => left.name.localeCompare(right.name)),
    );
    this.#capabilityByName = byName;
  }

  public async close(): Promise<void> {
    for (const connection of this.#connections.values()) {
      connection.abortController.abort("control_plane_closed");
    }
    this.#connections.clear();
    await this.#pool.end();
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("EU-11 clock must return a non-negative safe integer");
    }
    return value;
  }

  #secretDigest(purpose: "enrollment" | "device", value: string): string {
    return createHmac("sha256", this.#tokenPepper)
      .update(M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION, "utf8")
      .update("\0", "utf8")
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  #newSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  async #transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #tenantRole(client: PoolClient, tenantId: string): Promise<void> {
    await client.query("SET LOCAL ROLE revagent_app");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  }

  async #locatorRole(client: PoolClient): Promise<void> {
    await client.query("SET LOCAL ROLE revagent_credential_locator");
  }

  async #tenantTransaction<T>(
    tenantId: string,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return await this.#transaction(async (client) => {
      await this.#tenantRole(client, tenantId);
      return await action(client);
    });
  }

  async #locatedTransaction<T>(
    digest: string,
    kind: LocatedCredential["credential_kind"],
    action: (
      client: PoolClient,
      located: LocatedCredential,
    ) => Promise<M5EnrollmentEntitlementResult<T>>,
  ): Promise<M5EnrollmentEntitlementResult<T>> {
    return await this.#transaction(async (client) => {
      await this.#locatorRole(client);
      const scope = await client.query<LocatedCredential>(
        `SELECT tenant_id, device_id, credential_kind, valid_until
         FROM credential_scopes
         WHERE token_digest = $1 AND credential_kind = $2
         FOR UPDATE`,
        [digest, kind],
      );
      const located = scope.rows[0];
      if (located === undefined) {
        return failure(
          kind === "enrollment"
            ? "enrollment_code_unknown"
            : "device_credential_denied",
        );
      }
      await this.#tenantRole(client, located.tenant_id);
      return await action(client, located);
    });
  }

  async #adminAllowed(client: PoolClient, actor: AuthContext): Promise<boolean> {
    if (actor.actor.type !== "user" || actor.actor.role !== "tenant_admin") {
      return false;
    }
    const row = await client.query(
      `SELECT 1 FROM users
       WHERE id = $1 AND role = 'tenant_admin' AND status = 'active'`,
      [actor.actor.userId],
    );
    return row.rowCount === 1;
  }

  async #event(
    client: PoolClient,
    input: {
      readonly tenantId: string;
      readonly eventType: string;
      readonly actorUserId?: string;
      readonly actorDeviceId?: string;
      readonly targetUserId?: string;
      readonly targetDeviceId?: string;
      readonly outcome: "completed" | "denied" | "failed";
      readonly reason?: string;
      readonly details?: Readonly<Record<string, GatewayJsonValue>>;
      readonly occurredAtMs?: number;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO security_events(
         id, tenant_id, event_type, actor_user_id, actor_device_id,
         target_user_id, target_device_id, outcome, reason, details, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,to_timestamp($11 / 1000.0))`,
      [
        randomUUID(),
        input.tenantId,
        input.eventType,
        input.actorUserId ?? null,
        input.actorDeviceId ?? null,
        input.targetUserId ?? null,
        input.targetDeviceId ?? null,
        input.outcome,
        input.reason ?? null,
        JSON.stringify(input.details ?? {}),
        input.occurredAtMs ?? this.#now(),
      ],
    );
  }

  public async mintEnrollmentCode(
    actor: AuthContext,
    input: M5MintEnrollmentInput,
  ): Promise<M5EnrollmentEntitlementResult<M5IssuedEnrollmentCode>> {
    if (
      actor.actor.type !== "user" ||
      !uuid(actor.actor.tenantId) ||
      !uuid(actor.actor.userId) ||
      !uuid(input.principalUserId) ||
      !uuid(input.deviceId) ||
      !isCanonicalMachineFingerprint(input.machineFingerprint)
    ) {
      return failure("invalid_request");
    }
    if (actor.actor.role !== "tenant_admin") return failure("admin_required");
    const expiresInMs = input.expiresInMs ?? 10 * 60 * 1_000;
    if (
      !Number.isSafeInteger(expiresInMs) ||
      expiresInMs <= 0 ||
      expiresInMs > 24 * 60 * 60 * 1_000
    ) {
      return failure("invalid_request");
    }
    const issuedAtMs = this.#now();
    const expiresAtMs = issuedAtMs + expiresInMs;
    const enrollmentId = randomUUID();
    const enrollmentCode = this.#newSecret();
    const digest = this.#secretDigest("enrollment", enrollmentCode);
    try {
      return await this.#tenantTransaction(actor.actor.tenantId, async (client) => {
        if (!(await this.#adminAllowed(client, actor))) {
          return failure("admin_required");
        }
        const principal = await client.query(
          "SELECT 1 FROM users WHERE id = $1 AND status = 'active'",
          [input.principalUserId],
        );
        if (principal.rowCount !== 1) {
          await this.#event(client, {
            tenantId: actor.actor.tenantId,
            eventType: "enrollment_code.mint",
            actorUserId: actor.actor.userId,
            outcome: "denied",
            reason: "principal_binding_denied",
          });
          return failure("principal_binding_denied");
        }
        const pending = await client.query(
          `SELECT 1 FROM enrollment_codes
           WHERE device_id = $1 AND status = 'issued' AND expires_at > to_timestamp($2 / 1000.0)`,
          [input.deviceId, issuedAtMs],
        );
        if (pending.rowCount !== 0) {
          await this.#event(client, {
            tenantId: actor.actor.tenantId,
            eventType: "enrollment_code.mint",
            actorUserId: actor.actor.userId,
            targetUserId: input.principalUserId,
            outcome: "denied",
            reason: "enrollment_conflict",
          });
          return failure("enrollment_conflict");
        }
        await client.query(
          `UPDATE enrollment_codes SET status = 'expired', version = version + 1
           WHERE device_id = $1 AND status = 'issued'
             AND expires_at <= to_timestamp($2 / 1000.0)`,
          [input.deviceId, issuedAtMs],
        );
        await client.query(
          `INSERT INTO enrollment_codes(
             id,tenant_id,issued_by_user_id,principal_user_id,device_id,
             machine_fingerprint,code_digest,issued_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0),to_timestamp($9 / 1000.0))`,
          [
            enrollmentId,
            actor.actor.tenantId,
            actor.actor.userId,
            input.principalUserId,
            input.deviceId,
            input.machineFingerprint,
            digest,
            issuedAtMs,
            expiresAtMs,
          ],
        );
        await this.#locatorRole(client);
        await client.query(
          `INSERT INTO credential_scopes(
             token_digest,credential_kind,tenant_id,device_id,valid_until)
           VALUES ($1,'enrollment',$2,$3,to_timestamp($4 / 1000.0))`,
          [digest, actor.actor.tenantId, input.deviceId, expiresAtMs],
        );
        await this.#tenantRole(client, actor.actor.tenantId);
        await this.#event(client, {
          tenantId: actor.actor.tenantId,
          eventType: "enrollment_code.mint",
          actorUserId: actor.actor.userId,
          targetUserId: input.principalUserId,
          outcome: "completed",
          details: { enrollmentId, deviceId: input.deviceId, expiresAtMs },
          occurredAtMs: issuedAtMs,
        });
        return success({
          contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
          enrollmentId,
          enrollmentCode,
          expiresAtMs,
        });
      });
    } catch {
      return failure("unavailable");
    }
  }

  public async exchangeEnrollmentCode(input: {
    readonly enrollmentCode: string | undefined;
    readonly machineFingerprint: string;
  }): Promise<M5EnrollmentEntitlementResult<M5EnrollmentExchange>> {
    if (
      input.enrollmentCode === undefined ||
      !visibleSecret(input.enrollmentCode) ||
      !isCanonicalMachineFingerprint(input.machineFingerprint)
    ) {
      return failure("invalid_request");
    }
    const codeDigest = this.#secretDigest("enrollment", input.enrollmentCode);
    try {
      return await this.#locatedTransaction(
        codeDigest,
        "enrollment",
        async (client, located) => {
          const code = await client.query<{
            id: string;
            principal_user_id: string;
            device_id: string;
            machine_fingerprint: string;
            status: "issued" | "consumed" | "expired";
            expires_at: Date;
          }>(
            `SELECT id,principal_user_id,device_id,machine_fingerprint,status,expires_at
             FROM enrollment_codes WHERE code_digest = $1 FOR UPDATE`,
            [codeDigest],
          );
          const record = code.rows[0];
          if (record === undefined || record.device_id !== located.device_id) {
            return failure("enrollment_code_unknown");
          }
          if (record.status === "consumed") {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "enrollment_code.exchange",
              targetUserId: record.principal_user_id,
              outcome: "denied",
              reason: "enrollment_code_reused",
            });
            return failure("enrollment_code_reused");
          }
          const nowMs = this.#now();
          if (record.status === "expired" || record.expires_at.getTime() <= nowMs) {
            if (record.status !== "expired") {
              await client.query(
                "UPDATE enrollment_codes SET status='expired',version=version+1 WHERE id=$1",
                [record.id],
              );
            }
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "enrollment_code.exchange",
              targetUserId: record.principal_user_id,
              outcome: "denied",
              reason: "enrollment_code_expired",
            });
            return failure("enrollment_code_expired");
          }
          if (record.machine_fingerprint !== input.machineFingerprint) {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "enrollment_code.exchange",
              targetUserId: record.principal_user_id,
              outcome: "denied",
              reason: "device_binding_denied",
            });
            return failure("device_binding_denied");
          }
          const principal = await client.query(
            "SELECT 1 FROM users WHERE id=$1 AND status='active'",
            [record.principal_user_id],
          );
          if (principal.rowCount !== 1) return failure("principal_binding_denied");
          const prior = await client.query(
            "SELECT 1 FROM device_credentials WHERE device_id=$1",
            [record.device_id],
          );
          if (prior.rowCount !== 0) return failure("enrollment_conflict");
          const deviceWritten = await client.query(
            `INSERT INTO devices(id,tenant_id,machine_name,status)
             VALUES ($1,$2,$3,'active')
             ON CONFLICT (id) DO UPDATE SET status='active'
             WHERE devices.tenant_id=EXCLUDED.tenant_id
             RETURNING id`,
            [record.device_id, located.tenant_id, record.device_id],
          );
          if (deviceWritten.rowCount !== 1) {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "enrollment_code.exchange",
              targetUserId: record.principal_user_id,
              outcome: "denied",
              reason: "tenant_binding_denied",
              details: { deviceId: record.device_id },
            });
            return failure("tenant_binding_denied");
          }
          const deviceToken = this.#newSecret();
          const deviceDigest = this.#secretDigest("device", deviceToken);
          await client.query(
            `INSERT INTO device_credentials(
               tenant_id,device_id,principal_user_id,machine_fingerprint,
               current_token_digest,created_at)
             VALUES ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0))`,
            [
              located.tenant_id,
              record.device_id,
              record.principal_user_id,
              record.machine_fingerprint,
              deviceDigest,
              nowMs,
            ],
          );
          await client.query(
            `UPDATE enrollment_codes
             SET status='consumed',consumed_at=to_timestamp($2 / 1000.0),version=version+1
             WHERE id=$1`,
            [record.id, nowMs],
          );
          await this.#locatorRole(client);
          await client.query(
            `INSERT INTO credential_scopes(
               token_digest,credential_kind,tenant_id,device_id,valid_until)
             VALUES ($1,'device',$2,$3,NULL)`,
            [deviceDigest, located.tenant_id, record.device_id],
          );
          await this.#tenantRole(client, located.tenant_id);
          await this.#event(client, {
            tenantId: located.tenant_id,
            eventType: "enrollment_code.exchange",
            targetUserId: record.principal_user_id,
            targetDeviceId: record.device_id,
            outcome: "completed",
            details: { enrollmentId: record.id, credentialVersion: 1 },
            occurredAtMs: nowMs,
          });
          return success({
            contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
            deviceId: record.device_id,
            deviceToken,
          });
        },
      );
    } catch {
      return failure("unavailable");
    }
  }

  public async grantModuleLicense(
    actor: AuthContext,
    input: { readonly module: GatewayModuleName; readonly seatLimit: number },
  ): Promise<M5EnrollmentEntitlementResult<{ readonly licenseId: string }>> {
    if (
      actor.actor.type !== "user" ||
      !uuid(actor.actor.tenantId) ||
      !moduleName(input.module) ||
      !Number.isSafeInteger(input.seatLimit) ||
      input.seatLimit <= 0 ||
      input.seatLimit > 100_000
    ) {
      return failure("invalid_request");
    }
    if (actor.actor.role !== "tenant_admin") return failure("admin_required");
    try {
      return await this.#tenantTransaction(actor.actor.tenantId, async (client) => {
        if (!(await this.#adminAllowed(client, actor))) return failure("admin_required");
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM module_licenses WHERE module_name=$1 FOR UPDATE",
          [input.module],
        );
        const active = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM seat_assignments WHERE module_name=$1 AND status='active'",
          [input.module],
        );
        if (Number(active.rows[0]?.count ?? "0") > input.seatLimit) {
          return failure("seat_cap_exceeded");
        }
        const licenseId = existing.rows[0]?.id ?? randomUUID();
        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO module_licenses(
               id,tenant_id,module_name,seat_limit,status,created_at,updated_at)
             VALUES ($1,$2,$3,$4,'active',to_timestamp($5/1000.0),to_timestamp($5/1000.0))`,
            [licenseId, actor.actor.tenantId, input.module, input.seatLimit, this.#now()],
          );
        } else {
          await client.query(
            `UPDATE module_licenses SET seat_limit=$2,status='active',
             version=version+1,updated_at=to_timestamp($3/1000.0) WHERE id=$1`,
            [licenseId, input.seatLimit, this.#now()],
          );
        }
        await this.#event(client, {
          tenantId: actor.actor.tenantId,
          eventType: "license.grant",
          actorUserId: actor.actor.userId,
          outcome: "completed",
          details: { module: input.module, seatLimit: input.seatLimit },
        });
        return success({ licenseId });
      });
    } catch {
      return failure("unavailable");
    }
  }

  public async assignSeat(
    actor: AuthContext,
    input: {
      readonly module: GatewayModuleName;
      readonly principalUserId: string;
      readonly deviceId: string;
    },
  ): Promise<M5EnrollmentEntitlementResult<M5SeatAssignment>> {
    if (
      actor.actor.type !== "user" ||
      !uuid(actor.actor.tenantId) ||
      !moduleName(input.module) ||
      !uuid(input.principalUserId) ||
      !uuid(input.deviceId)
    ) {
      return failure("invalid_request");
    }
    if (actor.actor.role !== "tenant_admin") return failure("admin_required");
    try {
      return await this.#tenantTransaction(actor.actor.tenantId, async (client) => {
        if (!(await this.#adminAllowed(client, actor))) return failure("admin_required");
        const license = await client.query<{ id: string; seat_limit: number }>(
          `SELECT id,seat_limit FROM module_licenses
           WHERE module_name=$1 AND status='active' FOR UPDATE`,
          [input.module],
        );
        const licensed = license.rows[0];
        if (licensed === undefined) return failure("entitlement_denied");
        const binding = await client.query<{ principal_user_id: string }>(
          `SELECT dc.principal_user_id
           FROM device_credentials dc JOIN devices d
             ON d.tenant_id=dc.tenant_id AND d.id=dc.device_id
           JOIN users u ON u.tenant_id=dc.tenant_id AND u.id=dc.principal_user_id
           WHERE dc.device_id=$1 AND d.status='active' AND u.status='active'`,
          [input.deviceId],
        );
        if (binding.rows[0]?.principal_user_id !== input.principalUserId) {
          await this.#event(client, {
            tenantId: actor.actor.tenantId,
            eventType: "seat.assign",
            actorUserId: actor.actor.userId,
            outcome: "denied",
            reason: "seat_binding_denied",
          });
          return failure("seat_binding_denied");
        }
        const existing = await client.query<{
          id: string;
          user_id: string;
          device_id: string;
        }>(
          `SELECT id,user_id,device_id FROM seat_assignments
           WHERE module_name=$1 AND status='active'
             AND (user_id=$2 OR device_id=$3) FOR UPDATE`,
          [input.module, input.principalUserId, input.deviceId],
        );
        if (existing.rowCount !== 0) {
          const exact = existing.rows.find(
            (row) =>
              row.user_id === input.principalUserId && row.device_id === input.deviceId,
          );
          if (exact === undefined) return failure("seat_binding_denied");
          return success({
            contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
            seatId: exact.id,
            module: input.module,
            principalUserId: input.principalUserId,
            deviceId: input.deviceId,
            replayed: true,
          });
        }
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM seat_assignments WHERE license_id=$1 AND status='active'",
          [licensed.id],
        );
        if (Number(count.rows[0]?.count ?? "0") >= licensed.seat_limit) {
          await this.#event(client, {
            tenantId: actor.actor.tenantId,
            eventType: "seat.assign",
            actorUserId: actor.actor.userId,
            outcome: "denied",
            reason: "seat_cap_exceeded",
          });
          return failure("seat_cap_exceeded");
        }
        const seatId = randomUUID();
        const assignedAtMs = this.#now();
        await client.query(
          `INSERT INTO seat_assignments(
             id,tenant_id,license_id,module_name,user_id,device_id,assigned_at)
           VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0))`,
          [
            seatId,
            actor.actor.tenantId,
            licensed.id,
            input.module,
            input.principalUserId,
            input.deviceId,
            assignedAtMs,
          ],
        );
        await this.#event(client, {
          tenantId: actor.actor.tenantId,
          eventType: "seat.assign",
          actorUserId: actor.actor.userId,
          targetUserId: input.principalUserId,
          targetDeviceId: input.deviceId,
          outcome: "completed",
          details: { module: input.module, seatId },
          occurredAtMs: assignedAtMs,
        });
        return success({
          contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
          seatId,
          module: input.module,
          principalUserId: input.principalUserId,
          deviceId: input.deviceId,
          replayed: false,
        });
      });
    } catch {
      return failure("unavailable");
    }
  }

  public async openBridgeConnection(input: {
    readonly deviceToken: string | undefined;
    readonly claimedTenantId: string;
    readonly claimedDeviceId: string;
    readonly principalUserId: string;
    readonly machineFingerprint: string;
    readonly connectionId: string;
    readonly executor: M5BridgeExecutor;
    readonly closeControl: M5BridgeCloseControl;
  }): Promise<M5EnrollmentEntitlementResult<M5BridgeConnection>> {
    if (
      input.deviceToken === undefined ||
      !visibleSecret(input.deviceToken) ||
      !uuid(input.claimedTenantId) ||
      !uuid(input.claimedDeviceId) ||
      !uuid(input.principalUserId) ||
      !isCanonicalMachineFingerprint(input.machineFingerprint) ||
      !boundedIdentifier(input.connectionId)
    ) {
      return failure("invalid_request");
    }
    const digest = this.#secretDigest("device", input.deviceToken);
    try {
      const authorized = await this.#locatedTransaction(
        digest,
        "device",
        async (client, located) => {
          if (
            located.tenant_id !== input.claimedTenantId ||
            located.device_id !== input.claimedDeviceId
          ) {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "bridge.handshake",
              actorDeviceId: located.device_id,
              outcome: "denied",
              reason: "tenant_binding_denied",
            });
            return failure("tenant_binding_denied");
          }
          const credential = await client.query<{
            principal_user_id: string;
            machine_fingerprint: string;
            current_token_digest: string;
            previous_token_digest: string | null;
            previous_valid_until: Date | null;
            version: number;
            device_status: "active" | "revoked";
            user_status: "active" | "disabled";
          }>(
            `SELECT dc.principal_user_id,dc.machine_fingerprint,
                    dc.current_token_digest,dc.previous_token_digest,
                    dc.previous_valid_until,dc.version,d.status AS device_status,
                    u.status AS user_status
             FROM device_credentials dc
             JOIN devices d ON d.tenant_id=dc.tenant_id AND d.id=dc.device_id
             JOIN users u ON u.tenant_id=dc.tenant_id AND u.id=dc.principal_user_id
             WHERE dc.device_id=$1 FOR UPDATE OF dc,d`,
            [input.claimedDeviceId],
          );
          const record = credential.rows[0];
          if (record === undefined) return failure("device_credential_denied");
          const usedPrevious = record.previous_token_digest === digest;
          const previousStillValid =
            usedPrevious &&
            record.previous_valid_until !== null &&
            record.previous_valid_until.getTime() >= this.#now();
          if (
            (record.current_token_digest !== digest && !previousStillValid) ||
            record.machine_fingerprint !== input.machineFingerprint ||
            record.device_status !== "active" ||
            record.user_status !== "active"
          ) {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "bridge.handshake",
              actorDeviceId: located.device_id,
              outcome: "denied",
              reason:
                record.device_status === "revoked"
                  ? "device_revoked"
                  : "device_credential_denied",
            });
            return failure(
              record.device_status === "revoked"
                ? "device_revoked"
                : "device_credential_denied",
            );
          }
          if (record.principal_user_id !== input.principalUserId) {
            await this.#event(client, {
              tenantId: located.tenant_id,
              eventType: "bridge.handshake",
              actorDeviceId: located.device_id,
              outcome: "denied",
              reason: "principal_binding_denied",
            });
            return failure("principal_binding_denied");
          }
          const openedAtMs = this.#now();
          const inserted = await client.query(
            `INSERT INTO bridge_connections(
               id,tenant_id,device_id,principal_user_id,credential_version,opened_at)
             VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            [
              input.connectionId,
              located.tenant_id,
              located.device_id,
              record.principal_user_id,
              record.version,
              openedAtMs,
            ],
          );
          if (inserted.rowCount !== 1) return failure("connection_denied");
          await this.#event(client, {
            tenantId: located.tenant_id,
            eventType: "bridge.handshake",
            actorDeviceId: located.device_id,
            targetUserId: record.principal_user_id,
            outcome: "completed",
            details: {
              connectionId: input.connectionId,
              credentialVersion: record.version,
              usedPreviousCredential: previousStillValid,
            },
            occurredAtMs: openedAtMs,
          });
          return success({
            contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
            connectionId: input.connectionId,
            tenantId: located.tenant_id,
            principalUserId: record.principal_user_id,
            deviceId: located.device_id,
            credentialVersion: record.version,
            usedPreviousCredential: previousStillValid,
          });
        },
      );
      if (!authorized.ok) return authorized;
      const active: ActiveConnection = Object.freeze({
        binding: authorized.value,
        executor: input.executor,
        closeControl: input.closeControl,
        abortController: new AbortController(),
      });
      this.#connections.set(input.connectionId, active);
      if (
        this.#revokedDevices.has(
          activeDeviceKey(authorized.value.tenantId, authorized.value.deviceId),
        )
      ) {
        active.abortController.abort("device_revoked");
        active.closeControl.close(4_003, "device_revoked");
        this.#connections.delete(input.connectionId);
        return failure("device_revoked");
      }
      return authorized;
    } catch {
      return failure("unavailable");
    }
  }

  public async capabilityIndex(input: {
    readonly tenantId: string;
    readonly principalUserId: string;
    readonly deviceId: string;
  }): Promise<M5EnrollmentEntitlementResult<readonly M5Capability[]>> {
    if (!uuid(input.tenantId) || !uuid(input.principalUserId) || !uuid(input.deviceId)) {
      return failure("invalid_request");
    }
    try {
      return await this.#tenantTransaction(input.tenantId, async (client) => {
        const modules = await client.query<{ module_name: GatewayModuleName }>(
          `SELECT sa.module_name
           FROM seat_assignments sa
           JOIN module_licenses ml ON ml.tenant_id=sa.tenant_id AND ml.id=sa.license_id
           JOIN devices d ON d.tenant_id=sa.tenant_id AND d.id=sa.device_id
           JOIN device_credentials dc ON dc.tenant_id=sa.tenant_id AND dc.device_id=sa.device_id
           JOIN users u ON u.tenant_id=sa.tenant_id AND u.id=sa.user_id
           WHERE sa.user_id=$1 AND sa.device_id=$2 AND sa.status='active'
             AND ml.status='active' AND d.status='active' AND u.status='active'
             AND dc.principal_user_id=sa.user_id`,
          [input.principalUserId, input.deviceId],
        );
        const entitled = new Set(modules.rows.map((row) => row.module_name));
        return success(
          Object.freeze(
            this.#capabilities.filter((capability) => entitled.has(capability.module)),
          ),
        );
      });
    } catch {
      return failure("unavailable");
    }
  }

  public async rotateDeviceCredential(
    actor: AuthContext,
    input: { readonly deviceId: string },
  ): Promise<M5EnrollmentEntitlementResult<M5RotatedCredential>> {
    if (
      actor.actor.type !== "user" ||
      !uuid(actor.actor.tenantId) ||
      !uuid(input.deviceId)
    ) {
      return failure("invalid_request");
    }
    if (actor.actor.role !== "tenant_admin") return failure("admin_required");
    const deviceToken = this.#newSecret();
    const nextDigest = this.#secretDigest("device", deviceToken);
    try {
      return await this.#tenantTransaction(actor.actor.tenantId, async (client) => {
        if (!(await this.#adminAllowed(client, actor))) return failure("admin_required");
        const credential = await client.query<{
          current_token_digest: string;
          previous_token_digest: string | null;
          version: number;
        }>(
          `SELECT current_token_digest,previous_token_digest,version
           FROM device_credentials WHERE device_id=$1 FOR UPDATE`,
          [input.deviceId],
        );
        const record = credential.rows[0];
        if (record === undefined) return failure("device_binding_denied");
        const rotatedAtMs = this.#now();
        const previousValidUntilMs = rotatedAtMs + this.#rotationGraceMs;
        const credentialVersion = record.version + 1;
        await client.query(
          `UPDATE device_credentials SET
             previous_token_digest=current_token_digest,
             previous_valid_until=to_timestamp($2/1000.0),
             current_token_digest=$3,version=$4,rotated_at=to_timestamp($5/1000.0)
           WHERE device_id=$1`,
          [
            input.deviceId,
            previousValidUntilMs,
            nextDigest,
            credentialVersion,
            rotatedAtMs,
          ],
        );
        await this.#locatorRole(client);
        if (record.previous_token_digest !== null) {
          await client.query("DELETE FROM credential_scopes WHERE token_digest=$1", [
            record.previous_token_digest,
          ]);
        }
        await client.query(
          `UPDATE credential_scopes SET valid_until=to_timestamp($2/1000.0)
           WHERE token_digest=$1 AND credential_kind='device'`,
          [record.current_token_digest, previousValidUntilMs],
        );
        await client.query(
          `INSERT INTO credential_scopes(
             token_digest,credential_kind,tenant_id,device_id,valid_until)
           VALUES ($1,'device',$2,$3,NULL)`,
          [nextDigest, actor.actor.tenantId, input.deviceId],
        );
        await this.#tenantRole(client, actor.actor.tenantId);
        await this.#event(client, {
          tenantId: actor.actor.tenantId,
          eventType: "device_credential.rotate",
          actorUserId: actor.actor.userId,
          targetDeviceId: input.deviceId,
          outcome: "completed",
          details: { credentialVersion, previousValidUntilMs },
          occurredAtMs: rotatedAtMs,
        });
        return success({
          contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
          deviceId: input.deviceId,
          deviceToken,
          credentialVersion,
          previousValidUntilMs,
        });
      });
    } catch {
      return failure("unavailable");
    }
  }

  public async dispatch(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly principalUserId: string;
    readonly deviceId: string;
    readonly invocationId: string;
    readonly toolName: string;
    readonly params: GatewayJsonValue;
  }): Promise<M5EnrollmentEntitlementResult<M5DispatchResult>> {
    const capability = this.#capabilityByName.get(input.toolName);
    if (
      !uuid(input.tenantId) ||
      !boundedIdentifier(input.connectionId) ||
      !uuid(input.principalUserId) ||
      !uuid(input.deviceId) ||
      !boundedIdentifier(input.invocationId) ||
      capability === undefined ||
      !validGatewayJson(input.params)
    ) {
      return failure("invalid_request");
    }
    const paramsDigest = publicDigest(input.params);
    const active = this.#connections.get(input.connectionId);
    try {
      const reserved = await this.#tenantTransaction(input.tenantId, async (client) => {
        const entitled = await client.query(
          `SELECT 1
           FROM bridge_connections bc
           JOIN devices d ON d.tenant_id=bc.tenant_id AND d.id=bc.device_id
           JOIN device_credentials dc ON dc.tenant_id=bc.tenant_id AND dc.device_id=bc.device_id
           JOIN seat_assignments sa ON sa.tenant_id=bc.tenant_id
             AND sa.user_id=bc.principal_user_id AND sa.device_id=bc.device_id
           JOIN module_licenses ml ON ml.tenant_id=sa.tenant_id AND ml.id=sa.license_id
           WHERE bc.id=$1 AND bc.status='active' AND bc.principal_user_id=$2
             AND bc.device_id=$3 AND d.status='active'
             AND dc.principal_user_id=bc.principal_user_id
             AND sa.module_name=$4 AND sa.status='active' AND ml.status='active'`,
          [
            input.connectionId,
            input.principalUserId,
            input.deviceId,
            capability.module,
          ],
        );
        const memoryBound =
          active !== undefined &&
          active.binding.tenantId === input.tenantId &&
          active.binding.principalUserId === input.principalUserId &&
          active.binding.deviceId === input.deviceId &&
          !active.abortController.signal.aborted;
        if (entitled.rowCount !== 1 || !memoryBound) {
          await this.#event(client, {
            tenantId: input.tenantId,
            eventType: "bridge.dispatch",
            actorDeviceId: memoryBound ? input.deviceId : undefined,
            targetUserId: memoryBound ? input.principalUserId : undefined,
            outcome: "denied",
            reason: entitled.rowCount === 1 ? "connection_denied" : "entitlement_denied",
            details: { invocationId: input.invocationId, toolName: input.toolName },
          });
          return failure(
            entitled.rowCount === 1 ? "connection_denied" : "entitlement_denied",
          );
        }
        const prior = await client.query<{
          connection_id: string;
          principal_user_id: string;
          device_id: string;
          tool_name: string;
          params_digest: string;
          outcome: "pending" | "completed" | "failed" | "denied";
        }>(
          `SELECT connection_id,principal_user_id,device_id,tool_name,params_digest,outcome
           FROM bridge_dispatches WHERE invocation_id=$1 FOR UPDATE`,
          [input.invocationId],
        );
        const replay = prior.rows[0];
        if (replay !== undefined) {
          if (
            replay.connection_id !== input.connectionId ||
            replay.principal_user_id !== input.principalUserId ||
            replay.device_id !== input.deviceId ||
            replay.tool_name !== input.toolName ||
            replay.params_digest !== paramsDigest
          ) {
            await this.#event(client, {
              tenantId: input.tenantId,
              eventType: "bridge.dispatch",
              actorDeviceId: input.deviceId,
              targetUserId: input.principalUserId,
              outcome: "denied",
              reason: "invocation_conflict",
              details: { invocationId: input.invocationId, toolName: input.toolName },
            });
            return failure("invocation_conflict");
          }
          if (replay.outcome === "completed") {
            return success({
              contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
              invocationId: input.invocationId,
              replayed: true,
            });
          }
          return failure("invocation_in_progress");
        }
        await client.query(
          `INSERT INTO bridge_dispatches(
             id,tenant_id,invocation_id,connection_id,principal_user_id,device_id,
             module_name,tool_name,params_digest,outcome,started_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',to_timestamp($10/1000.0))`,
          [
            randomUUID(),
            input.tenantId,
            input.invocationId,
            input.connectionId,
            input.principalUserId,
            input.deviceId,
            capability.module,
            input.toolName,
            paramsDigest,
            this.#now(),
          ],
        );
        return success({ reserved: true as const });
      });
      if (!reserved.ok) return reserved;
      if ("replayed" in reserved.value) {
        return reserved as M5EnrollmentEntitlementResult<M5DispatchResult>;
      }
      if (active === undefined || active.abortController.signal.aborted) {
        await this.#tenantTransaction(input.tenantId, async (client) => {
          await client.query(
            `UPDATE bridge_dispatches SET outcome='failed',finished_at=to_timestamp($2/1000.0)
             WHERE invocation_id=$1 AND outcome='pending'`,
            [input.invocationId, this.#now()],
          );
          await this.#event(client, {
            tenantId: input.tenantId,
            eventType: "bridge.dispatch",
            actorDeviceId: input.deviceId,
            targetUserId: input.principalUserId,
            outcome: "failed",
            reason: "device_revoked",
            details: { invocationId: input.invocationId, toolName: input.toolName },
          });
        });
        return failure("device_revoked");
      }
      try {
        const result = await active.executor.invoke({
          invocationId: input.invocationId,
          toolName: input.toolName,
          params: input.params,
          signal: active.abortController.signal,
        });
        if (!validGatewayJson(result)) {
          throw new Error("Bridge returned a non-JSON result");
        }
        const finishedAtMs = this.#now();
        await this.#tenantTransaction(input.tenantId, async (client) => {
          await client.query(
            `UPDATE bridge_dispatches SET outcome='completed',result_digest=$2,
             finished_at=to_timestamp($3/1000.0)
             WHERE invocation_id=$1 AND outcome='pending'`,
            [input.invocationId, publicDigest(result), finishedAtMs],
          );
          await this.#event(client, {
            tenantId: input.tenantId,
            eventType: "bridge.dispatch",
            actorDeviceId: input.deviceId,
            targetUserId: input.principalUserId,
            outcome: "completed",
            details: { invocationId: input.invocationId, toolName: input.toolName },
            occurredAtMs: finishedAtMs,
          });
        });
        return success({
          contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
          invocationId: input.invocationId,
          replayed: false,
          result,
        });
      } catch {
        const reason = active.abortController.signal.aborted
          ? "device_revoked"
          : "unavailable";
        await this.#tenantTransaction(input.tenantId, async (client) => {
          await client.query(
            `UPDATE bridge_dispatches SET outcome='failed',finished_at=to_timestamp($2/1000.0)
             WHERE invocation_id=$1 AND outcome='pending'`,
            [input.invocationId, this.#now()],
          );
          await this.#event(client, {
            tenantId: input.tenantId,
            eventType: "bridge.dispatch",
            actorDeviceId: input.deviceId,
            targetUserId: input.principalUserId,
            outcome: "failed",
            reason,
            details: { invocationId: input.invocationId, toolName: input.toolName },
          });
        });
        return failure(reason);
      }
    } catch {
      return failure("unavailable");
    }
  }

  public async revokeDevice(
    actor: AuthContext,
    input: { readonly deviceId: string },
  ): Promise<M5EnrollmentEntitlementResult<M5RevocationResult>> {
    if (
      actor.actor.type !== "user" ||
      !uuid(actor.actor.tenantId) ||
      !uuid(input.deviceId)
    ) {
      return failure("invalid_request");
    }
    if (actor.actor.role !== "tenant_admin") return failure("admin_required");
    try {
      const mutation = await this.#tenantTransaction(
        actor.actor.tenantId,
        async (client) => {
          if (!(await this.#adminAllowed(client, actor))) return failure("admin_required");
          const device = await client.query<{ status: "active" | "revoked" }>(
            "SELECT status FROM devices WHERE id=$1 FOR UPDATE",
            [input.deviceId],
          );
          const prior = device.rows[0];
          if (prior === undefined) return failure("device_binding_denied");
          const changed = prior.status !== "revoked";
          const revokedAtMs = this.#now();
          if (changed) {
            await client.query("UPDATE devices SET status='revoked' WHERE id=$1", [
              input.deviceId,
            ]);
            await client.query(
              `UPDATE seat_assignments SET status='revoked',version=version+1,
               revoked_at=to_timestamp($2/1000.0)
               WHERE device_id=$1 AND status='active'`,
              [input.deviceId, revokedAtMs],
            );
            await client.query(
              `UPDATE bridge_connections SET status='revoked',
               closed_at=to_timestamp($2/1000.0),close_reason='device_revoked'
               WHERE device_id=$1 AND status='active'`,
              [input.deviceId, revokedAtMs],
            );
          }
          await this.#event(client, {
            tenantId: actor.actor.tenantId,
            eventType: "device.revoke",
            actorUserId: actor.actor.userId,
            targetDeviceId: input.deviceId,
            outcome: "completed",
            details: { changed },
            occurredAtMs: revokedAtMs,
          });
          return success({ changed, revokedAtMs });
        },
      );
      if (!mutation.ok) return mutation;
      const key = activeDeviceKey(actor.actor.tenantId, input.deviceId);
      this.#revokedDevices.add(key);
      let closedConnectionCount = 0;
      let maximumCloseLatencyMs = 0;
      for (const [connectionId, active] of this.#connections) {
        if (
          active.binding.tenantId !== actor.actor.tenantId ||
          active.binding.deviceId !== input.deviceId
        ) {
          continue;
        }
        const started = performance.now();
        active.abortController.abort("device_revoked");
        active.closeControl.close(4_003, "device_revoked");
        maximumCloseLatencyMs = Math.max(
          maximumCloseLatencyMs,
          performance.now() - started,
        );
        closedConnectionCount += 1;
        this.#connections.delete(connectionId);
      }
      return success({
        contractVersion: M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
        deviceId: input.deviceId,
        changed: mutation.value.changed,
        closedConnectionCount,
        maximumCloseLatencyMs,
        withinBound: maximumCloseLatencyMs <= M5_ACTIVE_REVOKE_BOUND_MS,
      });
    } catch {
      return failure("unavailable");
    }
  }
}
