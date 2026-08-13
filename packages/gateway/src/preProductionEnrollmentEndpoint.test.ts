import Fastify, { LogController } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
  type PreProductionIdentityAuthority,
} from "./preProductionIdentity.js";
import {
  PRE_PRODUCTION_ENROLLMENT_PATH,
  createPreProductionEnrollmentEndpoint,
} from "./preProductionEnrollmentEndpoint.js";

const ENROLLMENT_TOKEN_SENTINEL =
  "SYNTHETIC-ENROLLMENT-TOKEN-SENTINEL-000000000001";
const ENROLLMENT_TOKEN_FRAGMENT = "ENROLLMENT-TOKEN-SENTINEL";
const MACHINE_FINGERPRINT = `sha256:${"deadbeef".repeat(8)}`;
const MACHINE_FINGERPRINT_FRAGMENT = "deadbeefdeadbeefdeadbeef";
const DEVICE_TOKEN = "SYNTHETIC-DEVICE-TOKEN-RESULT-000000000001";

type Exchange = PreProductionIdentityAuthority["exchangeEnrollmentToken"];

function identityWith(exchangeEnrollmentToken: Exchange): PreProductionIdentityAuthority {
  return Object.freeze({
    kind: "preproduction" as const,
    exchangeEnrollmentToken,
    issueEnrollmentToken() {
      throw new Error("unused enrollment issue seam");
    },
    revokeDevice() {
      throw new Error("unused device revoke seam");
    },
    async authenticateNorthRequest() {
      throw new Error("unused north identity seam");
    },
    async authenticateDevice() {
      throw new Error("unused device identity seam");
    },
  } satisfies PreProductionIdentityAuthority);
}

function requestBody(): Record<string, string> {
  return {
    enrollment_token: ENROLLMENT_TOKEN_SENTINEL,
    machine_fingerprint: MACHINE_FINGERPRINT,
  };
}

function expectValueFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    ENROLLMENT_TOKEN_SENTINEL,
    ENROLLMENT_TOKEN_FRAGMENT,
    MACHINE_FINGERPRINT,
    MACHINE_FINGERPRINT_FRAGMENT,
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

async function invoke(
  exchangeEnrollmentToken: Exchange,
  payload: unknown = requestBody(),
  rawPayload?: string,
) {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: "trace",
      stream: {
        write(message: string): void {
          logs.push(message);
        },
      },
    },
    logController: new LogController({ disableRequestLogging: false }),
  });
  createPreProductionEnrollmentEndpoint(
    identityWith(exchangeEnrollmentToken),
  ).mount(app);

  const response = await app.inject({
    method: "POST",
    url: PRE_PRODUCTION_ENROLLMENT_PATH,
    headers: { "content-type": "application/json" },
    payload: rawPayload ?? JSON.stringify(payload),
  });
  await app.close();

  const error: unknown =
    response.statusCode >= 400 ? JSON.parse(response.body) : null;
  return {
    response,
    evidence: Object.freeze({
      statusCode: response.statusCode,
      headers: response.headers,
      responseBody: response.body,
      error,
      logs: Object.freeze([...logs]),
    }),
  };
}

describe("pre-production Bridge enrollment endpoint", () => {
  it("returns the exact Bridge success body without echoing enrollment input", async () => {
    const exchange = vi.fn<Exchange>(() => ({
      ok: true,
      value: Object.freeze({
        contractVersion: PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
        deviceId: "device-petrucci-m4",
        deviceToken: DEVICE_TOKEN,
      }),
    }));

    const { response, evidence } = await invoke(exchange);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      device_id: "device-petrucci-m4",
      device_token: DEVICE_TOKEN,
    });
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith({
      enrollmentToken: ENROLLMENT_TOKEN_SENTINEL,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expectValueFree(evidence);
    expect(JSON.stringify(evidence.logs)).not.toContain(DEVICE_TOKEN);
  });

  it.each([
    {
      name: "unknown token",
      reason: "enrollment_token_unknown" as const,
      status: 401,
      error: "enrollment_token_rejected",
    },
    {
      name: "reused token",
      reason: "enrollment_token_reused" as const,
      status: 409,
      error: "enrollment_token_reused",
    },
    {
      name: "fingerprint mismatch",
      reason: "enrollment_denied" as const,
      status: 403,
      error: "enrollment_denied",
    },
  ])("maps $name to a fixed value-free refusal", async (testCase) => {
    const exchange = vi.fn<Exchange>(() => ({
      ok: false,
      reason: testCase.reason,
      message:
        `diagnostic ${ENROLLMENT_TOKEN_SENTINEL} ` +
        `${MACHINE_FINGERPRINT}`,
    }));

    const { response, evidence } = await invoke(exchange);

    expect(response.statusCode).toBe(testCase.status);
    expect(response.json()).toEqual({
      ok: false,
      state: "refused",
      error: testCase.error,
    });
    expect(exchange).toHaveBeenCalledOnce();
    expect(response.headers["cache-control"]).toBe("no-store");
    expectValueFree(evidence);
  });

  it("contains an input-bearing authority exception behind a fixed value-free 503", async () => {
    const exchange = vi.fn<Exchange>(() => {
      throw new Error(
        `exchange failed for ${ENROLLMENT_TOKEN_SENTINEL} ` +
          `and ${MACHINE_FINGERPRINT}`,
      );
    });

    const { response, evidence } = await invoke(exchange);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      state: "unavailable",
      error: "enrollment_exchange_unavailable",
    });
    expect(exchange).toHaveBeenCalledOnce();
    expectValueFree(evidence);
  });

  it("rejects non-exact request shapes before invoking identity authority", async () => {
    const exchange = vi.fn<Exchange>(() => ({
      ok: true,
      value: {
        contractVersion: PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
        deviceId: "not-reached",
        deviceToken: DEVICE_TOKEN,
      },
    }));
    const malformed = [
      null,
      [],
      { enrollment_token: ENROLLMENT_TOKEN_SENTINEL },
      {
        ...requestBody(),
        unexpected: "must-refuse",
      },
      {
        ...requestBody(),
        enrollment_token: "too-short",
      },
      {
        ...requestBody(),
        machine_fingerprint: `sha256:${"A".repeat(64)}`,
      },
    ];

    for (const payload of malformed) {
      const { response, evidence } = await invoke(exchange, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        state: "refused",
        error: "invalid_enrollment_request",
      });
      expectValueFree(evidence);
    }
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed JSON",
      raw:
        `{"enrollment_token":"${ENROLLMENT_TOKEN_SENTINEL}",` +
        `"machine_fingerprint":"${MACHINE_FINGERPRINT}"`,
    },
    {
      name: "oversized JSON",
      raw:
        `{"enrollment_token":"${ENROLLMENT_TOKEN_SENTINEL}${"X".repeat(8_192)}",` +
        `"machine_fingerprint":"${MACHINE_FINGERPRINT}"}`,
    },
    {
      name: "duplicate decoded key",
      raw:
        `{"enrollment_token":"${ENROLLMENT_TOKEN_SENTINEL}",` +
        `"enrollment_\\u0074oken":"${ENROLLMENT_TOKEN_SENTINEL}",` +
        `"machine_fingerprint":"${MACHINE_FINGERPRINT}"}`,
    },
  ])("returns a fixed no-store refusal for $name", async ({ raw }) => {
    const exchange = vi.fn<Exchange>(() => ({
      ok: false,
      reason: "enrollment_denied",
      message: "must not be reached",
    }));

    const { response, evidence } = await invoke(exchange, undefined, raw);

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      ok: false,
      state: "refused",
      error: "invalid_enrollment_request",
    });
    expect(exchange).not.toHaveBeenCalled();
    expectValueFree(evidence);
  });
});
