import { createHash } from "node:crypto";
import type { HelloEnvelope } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import {
  PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
  PreProductionIdentityConfigurationError,
  createPreProductionIdentityAuthority,
  type PreProductionEnrollmentIssueInput,
  type PreProductionIdentityOptions,
} from "./preProductionIdentity.js";
import { createRestartableTestStore } from "./testAdapters.js";

const NOW_MS = 1_800_000_000_000;
const NORTH_TOKEN = "north-preproduction-token-000000000001";
const NORTH_AUTHORIZATION = `Bearer ${NORTH_TOKEN}`;
const TOKEN_KEY = "preproduction-key-material-000000000000000000000001";
const MACHINE_FINGERPRINT = `sha256:${"a".repeat(64)}`;

const NORTH_CONTEXT: AuthContext = Object.freeze({
  contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
  actor: Object.freeze({
    type: "user" as const,
    tenantId: "tenant-preproduction-1",
    userId: "user-preproduction-1",
    role: "user" as const,
    oidcIssuer: "https://issuer.invalid/preproduction",
    oidcSubject: "subject-preproduction-1",
  }),
  session: Object.freeze({
    sessionId: "session-preproduction-1",
    clientType: "mcp" as const,
    mcpSessionId: "mcp-preproduction-1",
    oauthClientId: "client-preproduction-1",
  }),
  principalKey: "tenant-preproduction-1:user-preproduction-1",
  issuedAtMs: NOW_MS - 1_000,
  expiresAtMs: NOW_MS + 60_000,
});

const ACTIVE_ISSUE: PreProductionEnrollmentIssueInput = Object.freeze({
  enrollmentId: "enrollment-preproduction-1",
  tenantId: "tenant-preproduction-1",
  userId: "user-preproduction-1",
  deviceId: "device-preproduction-1",
  seatId: "seat-preproduction-1",
  machineFingerprint: MACHINE_FINGERPRINT,
  grantedSessionCapabilities: Object.freeze([
    "transaction_group_atomic",
    "transport_streamable_http",
    "transaction_group_atomic",
  ]),
});

function options(
  overrides: Partial<PreProductionIdentityOptions> = {},
): PreProductionIdentityOptions {
  return {
    mode: "preproduction",
    nodeEnv: "test",
    tokenKey: TOKEN_KEY,
    clock: () => NOW_MS,
    northIdentities: [
      { authorization: NORTH_AUTHORIZATION, context: NORTH_CONTEXT },
    ],
    ...overrides,
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("pre-production identity configuration", () => {
  it("requires explicit pre-production mode and refuses production", () => {
    expect(() =>
      createPreProductionIdentityAuthority(options({ nodeEnv: "production" })),
    ).toThrowError(PreProductionIdentityConfigurationError);

    expect(() =>
      createPreProductionIdentityAuthority({
        ...options(),
        mode: undefined as unknown as "preproduction",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "preproduction_identity_configuration_refused",
        reason: "invalid_fixture",
      }),
    );
  });

  it("has no default or duplicate north credential", () => {
    expect(() =>
      createPreProductionIdentityAuthority(options({ tokenKey: "too-short" })),
    ).toThrowError(PreProductionIdentityConfigurationError);
    expect(() =>
      createPreProductionIdentityAuthority(
        options({
          northIdentities: [
            { authorization: NORTH_AUTHORIZATION, context: NORTH_CONTEXT },
            { authorization: NORTH_AUTHORIZATION, context: NORTH_CONTEXT },
          ],
        }),
      ),
    ).toThrowError(PreProductionIdentityConfigurationError);
  });
});

describe("pre-production north identity", () => {
  it("returns a deterministic frozen context without retaining the bearer", async () => {
    const first = createPreProductionIdentityAuthority(options());
    const second = createPreProductionIdentityAuthority(options());

    const firstResult = await first.authenticateNorthRequest({
      authorization: NORTH_AUTHORIZATION,
    });
    const secondResult = await second.authenticateNorthRequest({
      authorization: NORTH_AUTHORIZATION,
    });

    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({ ok: true, value: NORTH_CONTEXT });
    expect(Object.isFrozen(first)).toBe(true);
    if (firstResult.ok) {
      expect(Object.isFrozen(firstResult.value)).toBe(true);
      expect(Object.isFrozen(firstResult.value.actor)).toBe(true);
      expect(Object.isFrozen(firstResult.value.session)).toBe(true);
      expect(JSON.stringify(firstResult.value)).not.toContain(NORTH_TOKEN);
    }
  });

  it("projects exact contract fields and does not retain caller fixture secrets", async () => {
    const mutableContext = {
      ...NORTH_CONTEXT,
      token: "must-not-enter-auth-context",
      actor: {
        ...NORTH_CONTEXT.actor,
        authorization: "must-not-enter-actor",
      },
      session: {
        ...NORTH_CONTEXT.session,
        credential: "must-not-enter-session",
      },
    };
    const mutableFixture = {
      authorization: NORTH_AUTHORIZATION,
      context: mutableContext,
    };
    const mutableOptions = options({
      northIdentities: [mutableFixture],
    });
    const authority = createPreProductionIdentityAuthority(mutableOptions);

    mutableFixture.authorization = `Bearer ${"x".repeat(40)}`;
    mutableContext.actor.tenantId = "mutated-tenant";
    mutableContext.token = "mutated-secret";

    const result = await authority.authenticateNorthRequest({
      authorization: NORTH_AUTHORIZATION,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { actor: { tenantId: "tenant-preproduction-1" } },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-enter");
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual([
        "actor",
        "contractVersion",
        "expiresAtMs",
        "issuedAtMs",
        "principalKey",
        "session",
      ]);
      expect(Object.keys(result.value.actor).sort()).toEqual([
        "oidcIssuer",
        "oidcSubject",
        "role",
        "tenantId",
        "type",
        "userId",
      ]);
      expect(Object.keys(result.value.session).sort()).toEqual([
        "clientType",
        "mcpSessionId",
        "oauthClientId",
        "sessionId",
      ]);
    }
  });

  it("uniformly refuses missing, malformed, unknown, expired and future credentials", async () => {
    const authority = createPreProductionIdentityAuthority(options());
    const missing = await authority.authenticateNorthRequest({
      authorization: undefined,
    });
    const malformed = await authority.authenticateNorthRequest({
      authorization: "Bearer short",
    });
    const unknown = await authority.authenticateNorthRequest({
      authorization: `Bearer ${"z".repeat(40)}`,
    });
    expect(malformed).toEqual(missing);
    expect(unknown).toEqual(missing);
    expect(JSON.stringify(missing)).not.toContain(NORTH_TOKEN);

    const expired = createPreProductionIdentityAuthority(
      options({ clock: () => NORTH_CONTEXT.expiresAtMs! }),
    );
    expect(
      await expired.authenticateNorthRequest({
        authorization: NORTH_AUTHORIZATION,
      }),
    ).toEqual(missing);

    const futureContext: AuthContext = Object.freeze({
      ...NORTH_CONTEXT,
      issuedAtMs: NOW_MS + 1,
      expiresAtMs: NOW_MS + 60_000,
    });
    const future = createPreProductionIdentityAuthority(
      options({
        northIdentities: [
          { authorization: NORTH_AUTHORIZATION, context: futureContext },
        ],
      }),
    );
    expect(
      await future.authenticateNorthRequest({
        authorization: NORTH_AUTHORIZATION,
      }),
    ).toEqual(missing);
  });
});

describe("pre-production device enrollment authority", () => {
  it("derives deterministic single-use enrollment and device credentials", async () => {
    const first = createPreProductionIdentityAuthority(options());
    const second = createPreProductionIdentityAuthority(options());

    const firstIssue = first.issueEnrollmentToken(ACTIVE_ISSUE);
    const secondIssue = second.issueEnrollmentToken(ACTIVE_ISSUE);
    expect(firstIssue).toEqual(secondIssue);
    expect(firstIssue.ok).toBe(true);
    if (!firstIssue.ok || !secondIssue.ok) return;
    expect(firstIssue.value.contractVersion).toBe(
      PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
    );
    expect(firstIssue.value.enrollmentToken.length).toBeGreaterThanOrEqual(32);

    const firstExchange = first.exchangeEnrollmentToken({
      enrollmentToken: firstIssue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    const secondExchange = second.exchangeEnrollmentToken({
      enrollmentToken: secondIssue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(firstExchange).toEqual(secondExchange);
    expect(firstExchange.ok).toBe(true);
    if (!firstExchange.ok) return;

    const authenticated = await first.authenticateDevice({
      deviceToken: firstExchange.value.deviceToken,
      connectionId: "connection-preproduction-1",
    });
    expect(authenticated).toMatchObject({
      ok: true,
      value: {
        connectionId: "connection-preproduction-1",
        deviceStatus: "active",
        deviceTokenDigest: sha256(firstExchange.value.deviceToken),
        grantedSessionCapabilities: [
          "transaction_group_atomic",
          "transport_streamable_http",
        ],
      },
    });
    expect(JSON.stringify(authenticated)).not.toContain(
      firstExchange.value.deviceToken,
    );
    expect(JSON.stringify(authenticated)).not.toContain(
      firstIssue.value.enrollmentToken,
    );
  });

  it("refuses malformed, unknown, fingerprint-mismatched and replayed exchanges", () => {
    const authority = createPreProductionIdentityAuthority(options());
    const issued = authority.issueEnrollmentToken(ACTIVE_ISSUE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    expect(
      authority.exchangeEnrollmentToken({
        enrollmentToken: "short",
        machineFingerprint: MACHINE_FINGERPRINT,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(
      authority.exchangeEnrollmentToken({
        enrollmentToken: "unknown-preproduction-enrollment-token-0001",
        machineFingerprint: MACHINE_FINGERPRINT,
      }),
    ).toMatchObject({ ok: false, reason: "enrollment_token_unknown" });
    expect(
      authority.exchangeEnrollmentToken({
        enrollmentToken: issued.value.enrollmentToken,
        machineFingerprint: `sha256:${"b".repeat(64)}`,
      }),
    ).toMatchObject({ ok: false, reason: "enrollment_denied" });

    const exchanged = authority.exchangeEnrollmentToken({
      enrollmentToken: issued.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(exchanged.ok).toBe(true);
    expect(
      authority.exchangeEnrollmentToken({
        enrollmentToken: issued.value.enrollmentToken,
        machineFingerprint: MACHINE_FINGERPRINT,
      }),
    ).toMatchObject({ ok: false, reason: "enrollment_token_reused" });
  });

  it("expires enrollment state and releases the device for a fresh issue", () => {
    let now = NOW_MS;
    const authority = createPreProductionIdentityAuthority(
      options({ clock: () => now, enrollmentTtlMs: 100 }),
    );
    const issued = authority.issueEnrollmentToken(ACTIVE_ISSUE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    now += 100;
    const replacement = authority.issueEnrollmentToken({
      ...ACTIVE_ISSUE,
      enrollmentId: "enrollment-preproduction-2",
    });
    expect(replacement).toMatchObject({ ok: true });
    expect(
      authority.exchangeEnrollmentToken({
        enrollmentToken: issued.value.enrollmentToken,
        machineFingerprint: MACHINE_FINGERPRINT,
      }),
    ).toMatchObject({ ok: false, reason: "enrollment_token_expired" });
    expect(
      authority.issueEnrollmentToken({
        ...ACTIVE_ISSUE,
        enrollmentId: "enrollment-preproduction-3",
      }),
    ).toMatchObject({ ok: false, reason: "enrollment_conflict" });
  });

  it("preserves seat denial, keeps repeated revoke idempotent, and replaces a revoked credential", async () => {
    const authority = createPreProductionIdentityAuthority(options());
    const seatDeniedIssue = authority.issueEnrollmentToken({
      ...ACTIVE_ISSUE,
      enrollmentId: "enrollment-seat-denied",
      deviceId: "device-seat-denied",
      seatId: "seat-denied",
      deviceStatus: "seat_denied",
    });
    expect(seatDeniedIssue.ok).toBe(true);
    if (!seatDeniedIssue.ok) return;
    const seatDeniedExchange = authority.exchangeEnrollmentToken({
      enrollmentToken: seatDeniedIssue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(seatDeniedExchange.ok).toBe(true);
    if (!seatDeniedExchange.ok) return;
    expect(
      await authority.authenticateDevice({
        deviceToken: seatDeniedExchange.value.deviceToken,
        connectionId: "connection-seat-denied",
      }),
    ).toMatchObject({ ok: true, value: { deviceStatus: "seat_denied" } });

    const activeIssue = authority.issueEnrollmentToken(ACTIVE_ISSUE);
    expect(activeIssue.ok).toBe(true);
    if (!activeIssue.ok) return;
    const activeExchange = authority.exchangeEnrollmentToken({
      enrollmentToken: activeIssue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(activeExchange.ok).toBe(true);
    if (!activeExchange.ok) return;

    expect(authority.revokeDevice(ACTIVE_ISSUE.deviceId)).toMatchObject({
      ok: true,
      value: { priorStatus: "active", deviceStatus: "revoked", changed: true },
    });
    expect(authority.revokeDevice(ACTIVE_ISSUE.deviceId)).toMatchObject({
      ok: true,
      value: {
        priorStatus: "revoked",
        deviceStatus: "revoked",
        changed: false,
      },
    });
    expect(
      await authority.authenticateDevice({
        deviceToken: activeExchange.value.deviceToken,
        connectionId: "connection-revoked",
      }),
    ).toMatchObject({ ok: true, value: { deviceStatus: "revoked" } });

    const replacementIssue = authority.issueEnrollmentToken({
      ...ACTIVE_ISSUE,
      enrollmentId: "enrollment-preproduction-replacement",
    });
    expect(replacementIssue.ok).toBe(true);
    if (!replacementIssue.ok) return;
    const replacementExchange = authority.exchangeEnrollmentToken({
      enrollmentToken: replacementIssue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(replacementExchange.ok).toBe(true);
    if (!replacementExchange.ok) return;

    expect(
      await authority.authenticateDevice({
        deviceToken: activeExchange.value.deviceToken,
        connectionId: "connection-old-token",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await authority.authenticateDevice({
        deviceToken: replacementExchange.value.deviceToken,
        connectionId: "connection-new-token",
      }),
    ).toMatchObject({ ok: true, value: { deviceStatus: "active" } });
  });

  it("composes with the bridge session authority to refuse a revoked device", async () => {
    const identity = createPreProductionIdentityAuthority(options());
    const issued = identity.issueEnrollmentToken(ACTIVE_ISSUE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const exchanged = identity.exchangeEnrollmentToken({
      enrollmentToken: issued.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(identity.revokeDevice(ACTIVE_ISSUE.deviceId)).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked" },
    });

    const restartable = createRestartableTestStore();
    const bridge = new GatewayBridgeSessionAuthority(restartable.store, identity, {
      clock: () => NOW_MS,
    });
    await bridge.open();
    const hello: HelloEnvelope = {
      type: "hello",
      id: "018f0f7a-3f5e-7c00-8000-000000000001",
      ts: new Date(NOW_MS).toISOString(),
      payload: {
        min_protocol: 1,
        max_protocol: 1,
        capabilities: ["transport_streamable_http"],
        bridge_version: "m4-01-preproduction-test",
        device_id: ACTIVE_ISSUE.deviceId,
        machine: { hostname: "m4-01-test", os: "windows" },
        addin_versions: ["m4-01-test"],
      },
    };

    try {
      await expect(
        bridge.openConnection({
          deviceToken: exchanged.value.deviceToken,
          binding: "wss",
          hello,
          channel: {
            async send() {},
            async close() {},
          },
        }),
      ).rejects.toMatchObject({
        name: "GatewayRbpFault",
        code: "auth",
        httpStatus: 403,
        closeCode: 4403,
      });
    } finally {
      await bridge.close();
    }
  });
});
