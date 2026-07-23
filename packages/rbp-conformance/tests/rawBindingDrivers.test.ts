import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startGatewayStub,
  type GatewayStubHandle,
  type StaticTokenTable,
} from "../../gateway-stub/src/index.js";
import { loopbackTestCertificate } from "../../gateway-stub/tests/testCertificate.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRawBindingStepHooks,
  createRawHttpSseBindingDriver,
  createRawWssBindingDriver,
  type RawBindingTlsTrust,
} from "../src/rawBindingDrivers.js";
import { createRawProductionBindingStepHooks } from "../src/productionDriversRaw.js";
import { rawProductionCaseVariables } from "../src/productionCaseSeedsRaw.js";
import type {
  ParentStepDriverRequest,
  RawStepOutcome,
} from "../src/parentStepEngine.js";
import type { JsonObject, JsonValue } from "../src/processHarness.js";
import type { Binding } from "../src/types.js";

const TOKEN = "raw-binding-device-token";
const OTHER_TOKEN = "raw-binding-other-token";
const NOW = "2026-07-23T00:00:00.000Z";
const FINGERPRINT = `sha256:${"1".repeat(64)}`;
const PATH_DIGEST = `sha256:${"2".repeat(64)}`;
const handles: GatewayStubHandle[] = [];
const roots: string[] = [];

const tokenTable: StaticTokenTable = {
  [TOKEN]: {
    status: "active",
    deviceId: "raw-device-01",
    tenantId: "tenant-01",
    userId: "user-01",
    seatId: "seat-01",
    machineFingerprint: FINGERPRINT,
    provisionedCapabilities: [
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ],
  },
  [OTHER_TOKEN]: {
    status: "active",
    deviceId: "raw-device-02",
    tenantId: "tenant-01",
    userId: "user-02",
    seatId: "seat-02",
    machineFingerprint: `sha256:${"3".repeat(64)}`,
    provisionedCapabilities: ["journal_v1"],
  },
};

const productionTokenTable: StaticTokenTable = {
  "test-device-token": {
    status: "active",
    deviceId: "device-01",
    tenantId: "tenant-01",
    userId: "user-01",
    seatId: "seat-01",
    machineFingerprint: `sha256:${"0".repeat(64)}`,
    provisionedCapabilities: [
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ],
  },
};

function uuid7(value: number): string {
  return `0197a3c2-0000-7000-8000-${value.toString().padStart(12, "0")}`;
}

function hello(id = 1): JsonObject {
  return {
    type: "hello",
    id: uuid7(id),
    ts: NOW,
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "transport_streamable_http",
      ],
      bridge_version: "raw-driver-test",
      device_id: "raw-device-01",
      machine: { hostname: "raw-driver", os: "Windows test" },
      addin_versions: ["raw-driver-test"],
    },
  };
}

function sessionRegister(id = 2): JsonObject {
  return {
    v: 1,
    type: "session_register",
    id: uuid7(id),
    ts: NOW,
    payload: {
      local_session_key: `raw-local-${id}`,
      user_hint: { name: "Raw Driver" },
      machine: { hostname: "raw-driver", fingerprint: FINGERPRINT },
      revit: { version: "2025", build: "25.0", pid: 1001 },
      addin_version: "raw-driver-test",
      result_contract_version: 1,
      session_capabilities: ["batch_atomic", "doc_context_cached_v1"],
      bridge_version: "raw-driver-test",
      documents: [{
        document_id: "raw-doc-01",
        title: "Raw Fixture",
        path_digest: PATH_DIGEST,
        is_workshared: false,
        is_active: true,
      }],
      port: 8080,
    },
  };
}

function request(
  binding: Binding,
  argumentsValue: JsonObject,
  overrides: Partial<ParentStepDriverRequest> = {},
): ParentStepDriverRequest {
  return {
    runId: `raw-driver-${binding.replaceAll("_", "-")}`,
    caseId: "O1-C31",
    binding,
    stepId: `raw.${binding}.frame`,
    phase: "stimulus",
    channel: "parent_harness",
    componentId: null,
    action: "send_binding_frame",
    executionMode: "sequential",
    dispatchMode: "sequential",
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
    arguments: argumentsValue,
    ...overrides,
  };
}

function successResult(outcome: RawStepOutcome): JsonObject {
  expect(outcome.kind).toBe("success");
  if (outcome.kind !== "success" || outcome.result === null || typeof outcome.result !== "object" ||
    Array.isArray(outcome.result)) {
    throw new Error("expected a successful raw binding result object");
  }
  return outcome.result;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function parsedTypes(frames: JsonValue[]): Array<string | null> {
  return frames.map((frame) => {
    const captured = object(frame, "captured frame");
    const parsed = captured.parsed;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.type === "string"
      ? parsed.type
      : null;
  });
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function startSecureGateway(
  name: string,
  tokens: StaticTokenTable = tokenTable,
): Promise<{
  handle: GatewayStubHandle;
  trust: RawBindingTlsTrust;
}> {
  const root = await mkdtemp(join(tmpdir(), `raw-binding-${name}-`));
  roots.push(root);
  const tls = loopbackTestCertificate();
  const certificatePath = join(root, "gateway-current-stack.pem");
  await writeFile(certificatePath, tls.cert, { encoding: "utf8", flag: "wx" });
  const handle = await startGatewayStub({
    statePath: join(root, "gateway-state.json"),
    tokenTable: tokens,
    host: "127.0.0.1",
    port: 0,
    livenessSweepMs: 0,
    tls,
  });
  handles.push(handle);
  return {
    handle,
    trust: {
      caCertificatePath: certificatePath,
      caCertificateSha256: sha256(tls.cert),
      serverCertificateSha256: sha256(new X509Certificate(tls.cert).raw),
    },
  };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("parent-owned raw WSS binding driver", () => {
  it("runs a real pinned-TLS hello and valid frame without emitting a verdict", async () => {
    const { handle, trust } = await startSecureGateway("wss-valid");
    const driver = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(),
      // The second server frame is asynchronous; keep the bounded quiet window
      // above the full-suite Windows scheduler jitter observed under parallel load.
      limits: { settleMs: 250 },
      now: () => NOW,
    });
    const outcome = await driver(request("wss", { frame: sessionRegister() }));
    const result = successResult(outcome);
    const remote = object(result.remoteOutcome, "remoteOutcome");
    expect(remote).toMatchObject({
      kind: "wss_exchange",
      opened: true,
      openingSent: true,
      targetSent: true,
      close: null,
      tlsTrust: trust,
    });
    expect(parsedTypes(array(remote.receivedFrames, "receivedFrames"))).toEqual([
      "hello_ack",
      "session_registered",
    ]);
    expect(result).toMatchObject({
      stepId: "raw.wss.frame",
      action: "send_binding_frame",
      binding: "wss",
      serialized: {
        bytes: Buffer.byteLength(JSON.stringify(sessionRegister())),
        sha256: sha256(JSON.stringify(sessionRegister())),
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/"(?:actual|passed|verdict)":/u);
    expect(outcome.observations).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(outcome.observations![0]!.payload))).toBeLessThan(64 * 1024);
  });

  it("captures schema close and authenticated upgrade rejection as bounded remote facts", async () => {
    const { handle, trust } = await startSecureGateway("wss-negative");
    const driver = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(10),
      limits: { settleMs: 40 },
    });
    const schema = successResult(await driver(request("wss", {
      serializedFrame: '{"v":1,"type":"session_register","id":"malformed"',
    })));
    const schemaRemote = object(schema.remoteOutcome, "schema remoteOutcome");
    expect(parsedTypes(array(schemaRemote.receivedFrames, "schema frames"))).toContain("error");
    expect(schemaRemote.close).toMatchObject({ code: 4400, remote: true });

    const preNegotiation = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      limits: { settleMs: 40 },
    });
    const wrongFirst = successResult(await preNegotiation(request("wss", {
      frame: sessionRegister(13),
      targetIsOpeningFrame: true,
    })));
    expect(object(wrongFirst.remoteOutcome, "wrong-first remoteOutcome")).toMatchObject({
      openingSent: true,
      targetSent: true,
      close: { code: 4400, remote: true },
    });

    const unauthorized = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: "invalid-device-token",
      tlsTrust: trust,
      openingHello: hello(11),
      limits: { settleMs: 40 },
    });
    const auth = successResult(await unauthorized(request("wss", { frame: hello(12) })));
    expect(object(auth.remoteOutcome, "auth remoteOutcome")).toMatchObject({
      opened: false,
      targetSent: false,
      upgradeResponse: {
        status: 401,
        body: {
          parseState: "parsed",
          parsed: { error: "device credential rejected" },
        },
      },
      openingError: {
        status: 401,
        retryAfter: null,
        retryable: false,
      },
    });
  });

  it("honors live abort, parent timeout, TLS pin, and outbound/evidence bounds", async () => {
    const { handle, trust } = await startSecureGateway("wss-bounds");
    const slow = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      limits: { settleMs: 1_000 },
    });
    const abort = new AbortController();
    const aborted = slow(request("wss", { frame: hello(20) }, { signal: abort.signal }));
    setTimeout(() => abort.abort(new Error("operator cancelled raw frame")), 20);
    await expect(aborted).rejects.toThrow(/operator cancelled raw frame/u);
    await expect(slow(request("wss", { frame: hello(21) }, {
      deadlineAtMs: Date.now() + 20,
    }))).rejects.toThrow(/parent deadline/u);

    const wrongPin = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: { ...trust, serverCertificateSha256: `sha256:${"f".repeat(64)}` },
    });
    await expect(wrongPin(request("wss", { frame: hello(22) }))).rejects.toThrow(
      /pinned current-stack digest/u,
    );

    const capped = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(23),
      limits: { maxOutboundFrameBytes: 256 },
    });
    await expect(capped(request("wss", {
      frame: { v: 1, type: "invalid_large", blob: "x".repeat(1_024) },
    }))).rejects.toThrow(/serialized frame must be from 1 through 256 bytes/u);

    const bounded = createRawWssBindingDriver({
      url: handle.wsUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(24),
      limits: { settleMs: 40, maxParsedCaptureBytes: 2_048 },
    });
    const large = successResult(await bounded(request("wss", {
      frame: { v: 1, type: "invalid_large", blob: "x".repeat(128 * 1024) },
    })));
    expect(object(large.serialized, "serialized").bytes).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(60 * 1024);
  });
});

describe("parent-owned raw Streamable HTTP/SSE binding driver", () => {
  it("executes exact HTTPS create/events/messages and captures status, digest, and SSE frames", async () => {
    const { handle, trust } = await startSecureGateway("http-valid");
    const driver = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(30),
      limits: { settleMs: 40 },
      now: () => NOW,
    });
    const outcome = await driver(request("streamable_http_sse", { frame: sessionRegister(31) }));
    const result = successResult(outcome);
    const remote = object(result.remoteOutcome, "remoteOutcome");
    expect(remote).toMatchObject({
      kind: "streamable_http_sse_exchange",
      tlsTrust: trust,
      createResponse: {
        status: 201,
        body: { parseState: "parsed", parsed: { type: "hello_ack" } },
      },
      connectionIdPresent: true,
      messagesResponse: {
        status: 202,
        body: { bytes: 0, parseState: "empty" },
      },
      sse: { status: 200 },
    });
    const sse = object(remote.sse, "sse");
    expect(parsedTypes(array(sse.receivedFrames, "SSE receivedFrames"))).toContain(
      "session_registered",
    );
    expect(object(object(remote.createResponse, "createResponse").body, "create body").sha256)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(outcome)).not.toMatch(/"(?:actual|passed|verdict)":/u);
  });

  it("captures create auth status and schema-fault message status plus SSE error", async () => {
    const { handle, trust } = await startSecureGateway("http-negative");
    const unauthorized = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: "invalid-device-token",
      tlsTrust: trust,
      openingHello: hello(40),
      limits: { settleMs: 40 },
    });
    const auth = successResult(await unauthorized(request("streamable_http_sse", {
      frame: sessionRegister(41),
    })));
    expect(object(auth.remoteOutcome, "auth remoteOutcome")).toMatchObject({
      createResponse: {
        status: 401,
        body: {
          parseState: "parsed",
          parsed: { error: "device credential rejected" },
        },
      },
      openingError: {
        status: 401,
        retryAfter: null,
        retryable: false,
      },
      connectionIdPresent: false,
      sse: null,
      messagesResponse: null,
    });

    const schemaDriver = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      openingHello: hello(42),
      limits: { settleMs: 40 },
    });
    const schema = successResult(await schemaDriver(request("streamable_http_sse", {
      serializedFrame: '{"v":1,"type":"session_register","id":"malformed"',
    })));
    const schemaRemote = object(schema.remoteOutcome, "schema remoteOutcome");
    expect(schemaRemote.messagesResponse).toMatchObject({
      status: 400,
      body: { parseState: "parsed" },
    });
    const schemaSse = object(schemaRemote.sse, "schema SSE");
    expect(parsedTypes(array(schemaSse.receivedFrames, "schema SSE frames"))).toContain("error");

    const preNegotiation = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      limits: { settleMs: 40 },
    });
    const wrongCreate = successResult(await preNegotiation(request("streamable_http_sse", {
      frame: sessionRegister(43),
      targetIsOpeningFrame: true,
    })));
    expect(object(wrongCreate.remoteOutcome, "wrong-create remoteOutcome")).toMatchObject({
      createResponse: { status: 400, body: { parseState: "parsed" } },
      connectionIdPresent: false,
      sse: null,
      messagesResponse: null,
    });
  });

  it("fails closed on abort, deadline, remote body caps, and non-loopback configuration", async () => {
    const { handle, trust } = await startSecureGateway("http-bounds");
    const slow = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: TOKEN,
      tlsTrust: trust,
      limits: { settleMs: 1_000 },
    });
    const abort = new AbortController();
    const aborted = slow(request("streamable_http_sse", { frame: hello(50) }, {
      signal: abort.signal,
    }));
    setTimeout(() => abort.abort(new Error("cancelled HTTPS/SSE capture")), 20);
    await expect(aborted).rejects.toThrow(/cancelled HTTPS\/SSE capture/u);
    await expect(slow(request("streamable_http_sse", { frame: hello(51) }, {
      deadlineAtMs: Date.now() + 20,
    }))).rejects.toThrow(/parent deadline/u);

    const bodyCapped = createRawHttpSseBindingDriver({
      connectionUrl: handle.httpConnectionUrl,
      deviceToken: "invalid-device-token",
      tlsTrust: trust,
      limits: { maxRemoteEntityBytes: 8 },
    });
    await expect(bodyCapped(request("streamable_http_sse", { frame: hello(52) }))).rejects.toThrow(
      /remote HTTP body exceeds 8 bytes/u,
    );

    expect(() => createRawHttpSseBindingDriver({
      connectionUrl: "https://192.168.90.154:443/bridge/v1/http/connections",
      deviceToken: TOKEN,
      tlsTrust: trust,
    })).toThrow(/numeric loopback/u);
    expect(() => createRawWssBindingDriver({
      url: "wss://gateway.example.test:443/bridge/v1",
      deviceToken: TOKEN,
      tlsTrust: trust,
    })).toThrow(/numeric loopback/u);
  });

  it("provides binding-specific ParentStepDriver hooks without a fallback verdict surface", async () => {
    const { handle, trust } = await startSecureGateway("hook-factory");
    const hooks = createRawBindingStepHooks({
      wss: {
        url: handle.wsUrl,
        deviceToken: TOKEN,
        tlsTrust: trust,
        limits: { settleMs: 40 },
      },
      streamableHttpSse: {
        connectionUrl: handle.httpConnectionUrl,
        deviceToken: TOKEN,
        tlsTrust: trust,
        limits: { settleMs: 40 },
      },
    });
    expect(Object.keys(hooks).sort()).toEqual(["streamable_http_sse", "wss"]);
    const wss = await hooks.wss!(request("wss", { frame: hello(60) }));
    const http = await hooks.streamable_http_sse!(
      request("streamable_http_sse", { frame: hello(61) }),
    );
    expect(wss.kind).toBe("success");
    expect(http.kind).toBe("success");
    expect(object(successResult(wss).remoteOutcome, "hello WSS outcome")).toMatchObject({
      openingSent: true,
      targetSent: true,
    });
  });

  it("runs a catalog C31 frame through both production raw hook formats", async () => {
    const variables = rawProductionCaseVariables("O1-C31");
    const vectors = object(variables.vectors, "production vectors");
    const c31 = object(vectors.c31, "production C31 vectors");
    const frame = c31.session_register_positive;
    if (frame === undefined) throw new Error("production C31 registration frame is absent");

    for (const binding of ["wss", "streamable_http_sse"] as const) {
      const { handle, trust } = await startSecureGateway(
        `production-hook-${binding}`,
        productionTokenTable,
      );
      const hooks = createRawProductionBindingStepHooks(binding === "wss"
        ? {
            wss: {
              url: handle.wsUrl,
              deviceToken: "test-device-token",
              tlsTrust: trust,
              limits: { settleMs: 40 },
              now: () => NOW,
            },
          }
        : {
            streamableHttpSse: {
              connectionUrl: handle.httpConnectionUrl,
              deviceToken: "test-device-token",
              tlsTrust: trust,
              limits: { settleMs: 40 },
              now: () => NOW,
            },
          });
      const outcome = await hooks[binding]!(request(binding, { frame }, {
        caseId: "O1-C31",
        stepId: "o1-c31.session_register_positive",
      }));
      const remote = object(successResult(outcome).remoteOutcome, "production remoteOutcome");
      if (binding === "streamable_http_sse") {
        expect(remote, JSON.stringify(remote)).toMatchObject({
          createResponse: { status: 201 },
          connectionIdPresent: true,
          sse: { status: 200 },
        });
      }
      const frames = binding === "wss"
        ? array(remote.receivedFrames, "production WSS receivedFrames")
        : array(object(remote.sse, "production SSE").receivedFrames, "production SSE receivedFrames");
      expect(parsedTypes(frames)).toContain("session_registered");
    }
  });
});
