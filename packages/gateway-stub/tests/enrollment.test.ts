import { afterEach, describe, expect, it } from "vitest";

import { startGatewayStub } from "../src/server.js";
import type {
  GatewayStubHandle,
  GatewayStubServerOptions,
  StaticEnrollmentTokenTable,
} from "../src/types.js";
import { statePath, tokenTable, FINGERPRINT } from "./helpers.js";

const ENROLL_TOKEN = "enroll-token-active-0123456789abcdef0123456789abcdef";
const DENIED_TOKEN = "enroll-token-denied-0123456789abcdef0123456789abcdef";
const ISSUED_DEVICE_TOKEN = "issued-device-token-0123456789abcdef0123";

const enrollmentTokenTable: StaticEnrollmentTokenTable = {
  [ENROLL_TOKEN]: {
    status: "active",
    deviceId: "device-01",
    deviceToken: ISSUED_DEVICE_TOKEN,
  },
  [DENIED_TOKEN]: {
    status: "denied",
    deviceId: "device-denied",
    deviceToken: "denied-device-token-never-issued-0123456",
  },
};

const handles: GatewayStubHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

async function start(
  name: string,
  overrides: Partial<GatewayStubServerOptions> = {},
): Promise<GatewayStubHandle> {
  const handle = await startGatewayStub({
    statePath: await statePath(name),
    tokenTable,
    enrollmentTokenTable,
    livenessSweepMs: 0,
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

async function postEnroll(
  handle: GatewayStubHandle,
  body: unknown,
  contentType = "application/json",
): Promise<Response> {
  return fetch(`${handle.origin}/bridge/v1/enroll`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("enrollment exchange endpoint", () => {
  it("exchanges an active single-use token for the device credential", async () => {
    const handle = await start("enroll-exchange");
    const response = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device_id: "device-01",
      device_token: ISSUED_DEVICE_TOKEN,
    });
  });

  it("rejects a reused enrollment token with 409", async () => {
    const handle = await start("enroll-reuse");
    const first = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
    });
    expect(first.status).toBe(200);
    const second = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "enrollment token already used" });
  });

  it("rejects an unknown enrollment token with 401", async () => {
    const handle = await start("enroll-unknown");
    const response = await postEnroll(handle, {
      enrollment_token: "enroll-token-unknown-0123456789abcdef0123456789abcd",
      machine_fingerprint: FINGERPRINT,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a denied enrollment grant with 403 without consuming it", async () => {
    const handle = await start("enroll-denied");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postEnroll(handle, {
        enrollment_token: DENIED_TOKEN,
        machine_fingerprint: FINGERPRINT,
      });
      expect(response.status).toBe(403);
    }
  });

  it("rejects malformed exchange requests before touching the token table", async () => {
    const handle = await start("enroll-malformed");
    const wrongMediaType = await postEnroll(
      handle,
      { enrollment_token: ENROLL_TOKEN, machine_fingerprint: FINGERPRINT },
      "text/plain",
    );
    expect(wrongMediaType.status).toBe(415);
    const invalidJson = await postEnroll(handle, "{not json");
    expect(invalidJson.status).toBe(400);
    const extraKey = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
      extra: true,
    });
    expect(extraKey.status).toBe(400);
    const badFingerprint = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: "sha256:not-canonical",
    });
    expect(badFingerprint.status).toBe(400);
    const stillFresh = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
    });
    expect(stillFresh.status).toBe(200);
  });

  it("returns 401 when no enrollment table was configured", async () => {
    const handle = await startGatewayStub({
      statePath: await statePath("enroll-absent"),
      tokenTable,
      livenessSweepMs: 0,
    });
    handles.push(handle);
    const response = await postEnroll(handle, {
      enrollment_token: ENROLL_TOKEN,
      machine_fingerprint: FINGERPRINT,
    });
    expect(response.status).toBe(401);
  });
});
