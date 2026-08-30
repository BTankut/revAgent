import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  AddinLoopbackFixture,
  LoopbackContractValidator,
  MIN_REQUEST_PAYLOAD_BYTES,
  connectFixture,
  encodeJsonFrame,
  readFixtureFrames,
  type JsonObject,
} from "../src/index.js";
import { request, uuid7, waitFor, writeAndRead } from "./helpers.js";

function exactRequestPayload(id: string, targetBytes: number): JsonObject {
  const base = request(id, "fixture_echo", { padding: "" });
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  const remaining = targetBytes - overhead;
  if (remaining < 0) throw new Error("Target request size is too small");
  const padding = "ğ".repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "x");
  const value = request(id, "fixture_echo", { padding });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") !== targetBytes) {
    throw new Error("Unable to create exact request payload");
  }
  return value;
}

function exactResponsePadding(id: string, targetBytes: number): string {
  const empty = {
    jsonrpc: "2.0",
    id,
    result: { payload: "", resultContractVersion: 2 },
  };
  const remaining = targetBytes - Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (remaining < 0) throw new Error("Target response size is too small");
  const padding = "ğ".repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "x");
  const value = {
    jsonrpc: "2.0",
    id,
    result: { payload: padding, resultContractVersion: 2 },
  };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") !== targetBytes) {
    throw new Error("Unable to create exact response payload");
  }
  return padding;
}

function rawFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

async function readUntilClose(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
}

describe("add-in loopback fixture listener", () => {
  const fixtures: AddinLoopbackFixture[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    for (const fixture of fixtures) await fixture.stop();
  });

  async function started(options: ConstructorParameters<typeof AddinLoopbackFixture>[0] = {}) {
    const fixture = new AddinLoopbackFixture(options);
    fixtures.push(fixture);
    const address = await fixture.start();
    return { fixture, address };
  }

  async function connected(address: { host: string; port: number }): Promise<Socket> {
    const socket = await connectFixture(address);
    sockets.push(socket);
    return socket;
  }

  it.each(["localhost", "0.0.0.0", "::", "192.168.90.154"])(
    "rejects non-numeric or non-loopback host %s before listen",
    (host) => {
      expect(() => new AddinLoopbackFixture({ host })).toThrow(/numeric IP loopback/u);
    },
  );

  it("rejects an unsafe override even when the requested host is loopback", () => {
    expect(
      () => new AddinLoopbackFixture({ host: "127.0.0.1", allowUnsafeBind: true }),
    ).toThrow(/forbidden/u);
  });

  it("binds and advertises IPv6 loopback on runners that expose it", async (context) => {
    let fixture: AddinLoopbackFixture;
    let address: { host: string; port: number };
    try {
      ({ fixture, address } = await started({ host: "::1" }));
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown";
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes(code)) {
        process.stdout.write(
          `${JSON.stringify({
            fixtureEvidence: "ipv6_loopback_unavailable",
            skipped: true,
            os: process.platform,
            code,
          })}\n`,
        );
        context.skip(`IPv6 loopback is explicitly unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const socket = await connected(address);
    const response = await writeAndRead(socket, request(uuid7(26), "mcp_status"));
    const service = (response.result as JsonObject).service as JsonObject;

    expect(address.host).toBe("::1");
    expect(service).toMatchObject({
      binding: "loopback_only",
      boundAddresses: ["::1"],
    });
    expect(fixture.snapshotEvidence().openSocketCount).toBe(1);
  });

  it("advertises the exact schema-valid listener and capability contract", async () => {
    const { fixture, address } = await started({ maxRequestPayloadBytes: MIN_REQUEST_PAYLOAD_BYTES });
    const socket = await connected(address);
    const id = uuid7(1);
    const response = await writeAndRead(socket, request(id, "mcp_status"));
    const result = response.result as JsonObject;
    const service = result.service as JsonObject;
    const framing = service.framing as JsonObject;
    const capabilityContracts = result.capabilityContracts as JsonObject;
    const batch = capabilityContracts.batch_atomic as JsonObject;

    expect(response.id).toBe(id);
    expect(service.binding).toBe("loopback_only");
    expect(service.boundAddresses).toEqual([address.host]);
    expect(framing).toMatchObject({
      protocol: "length_prefixed_jsonrpc_v1",
      headerBytes: 4,
      byteOrder: "big_endian",
      maxRequestPayloadBytes: MIN_REQUEST_PAYLOAD_BYTES,
      maxResponsePayloadBytes: 32 * 1024 * 1024,
    });
    expect((batch.batchableCommands as unknown[]).some(
      (entry) => (entry as JsonObject).method === "send_code_to_revit",
    )).toBe(false);
    expect(fixture.getExecutionCount(id)).toBe(1);
  });

  it("accepts every schema-valid capability subset conditionally", async () => {
    const { address } = await started({ maxRequestPayloadBytes: MIN_REQUEST_PAYLOAD_BYTES });
    const socket = await connected(address);
    const id = uuid7(27);
    const response = await writeAndRead(socket, request(id, "mcp_status"));
    const original = response.result as JsonObject;
    const originalContracts = original.capabilityContracts as JsonObject;
    const validator = new LoopbackContractValidator(MIN_REQUEST_PAYLOAD_BYTES);
    const cases = [
      { capabilities: [], contracts: {} },
      {
        capabilities: ["doc_context_cached_v1"],
        contracts: { doc_context_cached_v1: originalContracts.doc_context_cached_v1 },
      },
      {
        capabilities: ["batch_atomic"],
        contracts: { batch_atomic: originalContracts.batch_atomic },
      },
      {
        capabilities: ["batch_atomic", "doc_context_cached_v1"],
        contracts: originalContracts,
      },
    ];

    for (const entry of cases) {
      const candidate = structuredClone(response);
      const result = candidate.result as JsonObject;
      result.sessionCapabilities = entry.capabilities;
      result.capabilityContracts = entry.contracts as JsonObject;
      expect(() => validator.validateResponse("mcp_status", id, candidate)).not.toThrow();
    }
  });

  it("serves the cached document context without an ordinary handler", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const id = uuid7(2);
    const response = await writeAndRead(socket, request(id, "get_document_context"));

    expect(response.id).toBe(id);
    expect(response.result).toMatchObject({
      resultContractVersion: 2,
      documentContextContractVersion: 1,
      cacheState: "ready",
      activeDocumentId: "fixture-document-1",
      cache_incarnation_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(fixture.getExecutionCount(id)).toBe(1);
  });

  it("dispatches one former-8192-byte request exactly once across split reads", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const id = uuid7(3);
    const value = exactRequestPayload(id, 8192);
    const frame = encodeJsonFrame(value, MIN_REQUEST_PAYLOAD_BYTES);
    const responsePromise = readFixtureFrames(socket, 1);

    socket.write(frame.subarray(0, 1));
    socket.write(frame.subarray(1, 3));
    socket.write(frame.subarray(3, 4099));
    socket.write(frame.subarray(4099));
    const response = (await responsePromise)[0] as JsonObject;

    expect(response.id).toBe(id);
    expect(fixture.getExecutionCount(id)).toBe(1);
    expect(
      fixture.observations.filter(
        (entry) => entry.requestId === id && entry.phase === "dispatch_started",
      ),
    ).toHaveLength(1);
  });

  it("dispatches two coalesced frames once each and preserves order", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const firstId = uuid7(4);
    const secondId = uuid7(5);
    const frames = Buffer.concat([
      encodeJsonFrame(request(firstId, "fixture_counter"), MIN_REQUEST_PAYLOAD_BYTES),
      encodeJsonFrame(request(secondId, "fixture_counter"), MIN_REQUEST_PAYLOAD_BYTES),
    ]);
    const responsePromise = readFixtureFrames(socket, 2);

    socket.write(frames);
    const responses = await responsePromise;

    expect(responses.map((entry) => entry.id)).toEqual([firstId, secondId]);
    expect(fixture.getExecutionCount(firstId)).toBe(1);
    expect(fixture.getExecutionCount(secondId)).toBe(1);
  });

  it("owns one mutation-probe cell and reports actual routed state", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const originId = uuid7(40);
    const verifyId = uuid7(41);
    const nextId = uuid7(42);

    const origin = await writeAndRead(
      socket,
      request(originId, "fixture_commit_then_throw", {}),
    );
    expect(origin.result).toMatchObject({
      state: "failed",
      error: { code: "command_failure" },
    });

    const read = await writeAndRead(
      socket,
      request(verifyId, "fixture_read_mutation_probe", {}),
    );
    expect(read.result).toMatchObject({
      schema: "revagent.fixture-mutation-probe/v1",
      present: true,
      complete: true,
      originInvocationId: originId,
      value: 1,
      originWriteCount: 1,
      nextWriteCount: 0,
    });

    const next = await writeAndRead(
      socket,
      request(nextId, "fixture_complete_mutation_probe", {}),
    );
    expect(next.result).toMatchObject({ value: 2, originWriteCount: 1, nextWriteCount: 1 });
    expect(fixture.getMethodExecutionCount("fixture_commit_then_throw")).toBe(1);
    expect(fixture.getMethodExecutionCount("fixture_read_mutation_probe")).toBe(1);
    expect(fixture.getMethodExecutionCount("fixture_complete_mutation_probe")).toBe(1);
    const rawRead = fixture.snapshotEvidence().observations.find((observation) =>
      observation.method === "fixture_read_mutation_probe" && observation.phase === "response_sent");
    expect(rawRead).toMatchObject({
      executionOrdinal: expect.any(Number),
      detail: expect.stringMatching(/^mutation_probe_raw_response:sha256:[0-9a-f]{64}$/u),
    });
  });

  it.each([
    ["zero", 0, -32700],
    ["max-plus-one", MIN_REQUEST_PAYLOAD_BYTES + 1, -32600],
    ["signed-negative-uint32", 0xffff_ffff, -32600],
  ] as const)("fails closed for a %s request header without dispatch", async (_name, length, code) => {
    const { fixture, address } = await started({ maxRequestPayloadBytes: MIN_REQUEST_PAYLOAD_BYTES });
    const socket = await connected(address);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    const responsePromise = readFixtureFrames(socket, 1);

    socket.write(header);
    const response = (await responsePromise)[0] as JsonObject;

    expect(response).toMatchObject({ jsonrpc: "2.0", id: null });
    expect((response.error as JsonObject).code).toBe(code);
    expect(fixture.getMethodExecutionCount("fixture_echo")).toBe(0);
  });

  it("accepts an exact advertised-max multibyte UTF-8 JSON request", async () => {
    const { fixture, address } = await started({ maxRequestPayloadBytes: MIN_REQUEST_PAYLOAD_BYTES });
    const socket = await connected(address);
    const id = uuid7(15);
    const value = exactRequestPayload(id, MIN_REQUEST_PAYLOAD_BYTES);
    const response = await writeAndRead(socket, value);

    expect(response.id).toBe(id);
    expect(fixture.getExecutionCount(id)).toBe(1);
    expect(fixture.observations.find(
      (entry) => entry.requestId === id && entry.phase === "validated",
    )?.payloadBytes).toBe(MIN_REQUEST_PAYLOAD_BYTES);
  });

  it("normalizes guarded and fully nested failure outcomes", async () => {
    const { fixture, address } = await started();
    fixture.registerHandler("fixture_guarded", "read_only", () => ({
      success: true,
      result: { success: false, guarded: true, reason: "protected view" },
    }));
    fixture.registerHandler("fixture_nested_failure", "read_only", () => ({
      success: true,
      result: { data: { success: false, error: { message: "nested boom" } } },
    }));
    const socket = await connected(address);

    const guarded = await writeAndRead(
      socket,
      request(uuid7(6), "fixture_guarded"),
    );
    const failed = await writeAndRead(
      socket,
      request(uuid7(7), "fixture_nested_failure"),
    );

    expect(guarded.result).toMatchObject({
      success: false,
      guarded: true,
      state: "guarded",
      guardedReason: "protected_view",
    });
    expect(failed.result).toMatchObject({
      success: false,
      state: "failed",
      error: { message: "nested boom" },
    });
  });

  it("normalizes a numeric-leading guarded reason to the required token grammar", async () => {
    const { fixture, address } = await started();
    fixture.registerHandler("fixture_numeric_guard", "read_only", () => ({
      state: "guarded",
      guardedReason: "123 protected view",
    }));
    const socket = await connected(address);
    const response = await writeAndRead(
      socket,
      request(uuid7(16), "fixture_numeric_guard"),
    );

    expect(response.result).toMatchObject({
      state: "guarded",
      guardedReason: "guarded_123_protected_view",
    });
    expect(String((response.result as JsonObject).guardedReason)).toMatch(
      /^[a-z][a-z0-9_]{0,63}$/u,
    );
  });

  it("returns bounded invalid_result for undefined or cyclic ordinary handler output", async () => {
    const { fixture, address } = await started();
    fixture.registerHandler(
      "fixture_undefined",
      "read_only",
      (() => undefined) as never,
    );
    fixture.registerHandler("fixture_cyclic", "read_only", () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value as never;
    });
    const socket = await connected(address);

    const undefinedResponse = await writeAndRead(
      socket,
      request(uuid7(17), "fixture_undefined"),
    );
    const cyclicResponse = await writeAndRead(
      socket,
      request(uuid7(18), "fixture_cyclic"),
    );

    for (const response of [undefinedResponse, cyclicResponse]) {
      const result = response.result as JsonObject;
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "invalid_result" },
      });
      expect(String((result.error as JsonObject).message).length).toBeLessThanOrEqual(600);
    }
  });

  it("returns deterministic multi-file artifact observations", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const requestId = uuid7(8);
    const response = await writeAndRead(
      socket,
      request(requestId, "fixture_multi_file_output"),
    );
    const files = ((response.result as JsonObject).files ?? []) as unknown[];

    expect(files).toHaveLength(2);
    expect(files.map((entry) => (entry as JsonObject).artifactIndex)).toEqual([0, 1]);
    for (const entry of files) {
      const artifact = entry as JsonObject;
      const bytes = Buffer.from(String(artifact.contentBase64), "base64");
      expect(entry).toMatchObject({
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        contentBase64: expect.any(String),
      });
      expect(artifact.sizeBytes).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
    expect(fixture.snapshotEvidence().c39OriginResponses).toEqual([
      { requestId, responseDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
    ]);
  });

  it("honors bounded deterministic multi-file scenario sizing and rejects an over-budget scenario", async () => {
    const { address } = await started();
    const socket = await connected(address);
    const response = await writeAndRead(
      socket,
      request(uuid7(28), "fixture_multi_file_output", {
        scenario: "valid_multifile",
        fileCount: 3,
        bytesPerFile: 1_048_577,
        contentType: "application/octet-stream",
      }),
    );
    const result = response.result as JsonObject;
    const files = result.files as unknown as JsonObject[];

    expect(result).toMatchObject({
      fixtureArtifactProgress: true,
      artifactScenario: "valid_multifile",
    });
    expect(files).toHaveLength(3);
    expect(files.map((entry) => entry.artifactIndex)).toEqual([0, 1, 2]);
    expect(files.map((entry) => entry.sizeBytes)).toEqual([1_048_577, 1_048_577, 1_048_577]);

    const rejected = await writeAndRead(
      socket,
      request(uuid7(29), "fixture_multi_file_output", {
        scenario: "valid_multifile",
        fileCount: 16,
        bytesPerFile: 4 * 1024 * 1024,
      }),
    );
    expect(rejected.result).toMatchObject({
      state: "failed",
      error: { code: "command_failure" },
    });

    const localPath = "C:\\private-workstation\\local-artifact.bin";
    const localPathVector = await writeAndRead(
      socket,
      request(uuid7(30), "fixture_multi_file_output", {
        scenario: "local_path",
        path: localPath,
      }),
    );
    expect(localPathVector.result).toMatchObject({
      fixtureArtifactProgress: true,
      artifactScenario: "local_path",
      files: [{ path: localPath, contentType: "application/octet-stream" }],
    });
  });

  it("updates the deterministic cached document context within one listener session", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const before = await writeAndRead(
      socket,
      request(uuid7(19), "get_document_context"),
    );
    const updated = fixture.applyDocumentContextEvent({
      capturedAtUtc: "2026-07-22T10:15:00.000Z",
      cacheState: "ready",
      unavailableReason: null,
      documents: [
        {
          documentId: "fixture-document-2",
          title: "Updated Fixture Model",
          pathDigest: null,
          isWorkshared: true,
          isActive: true,
        },
      ],
      activeDocumentId: "fixture-document-2",
      activeView: {
        documentId: "fixture-document-2",
        id: "2002",
        name: "Updated Fixture View",
        type: "ThreeD",
        level: null,
      },
      disciplineHint: "coordination",
    });
    const after = await writeAndRead(
      socket,
      request(uuid7(20), "get_document_context"),
    );

    expect((before.result as JsonObject).revision).toBe(1);
    expect(updated.revision).toBe(2);
    expect(after.result).toMatchObject({
      revision: 2,
      activeDocumentId: "fixture-document-2",
      activeView: { id: "2002" },
    });
    const evidence = fixture.snapshotEvidence().documentContextEvidence;
    expect(evidence).toMatchObject({
      clock: "process_monotonic_ms",
      currentRevision: 2,
      applicationEventCacheUpdateCount: 1,
      cacheReadCount: 2,
      pollRequestCount: 2,
      externalEventRaiseCount: 0,
    });
    expect((before.result as JsonObject).cache_incarnation_digest)
      .not.toBe((after.result as JsonObject).cache_incarnation_digest);
    expect((after.result as JsonObject).cache_incarnation_digest)
      .toBe(evidence.cacheIncarnationDigest);
    expect(evidence.timeline.map((entry) => entry.kind)).toEqual([
      "cache_initialized",
      "cache_read",
      "application_event_cache_update",
      "cache_read",
    ]);
    for (let index = 1; index < evidence.timeline.length; index += 1) {
      expect(evidence.timeline[index]!.atMonotonicMs)
        .toBeGreaterThan(evidence.timeline[index - 1]!.atMonotonicMs);
    }
  });

  it("provides a value-free controlled document-context acknowledgement and probe", () => {
    const fixture = new AddinLoopbackFixture();
    const acknowledgement = fixture.applyDocumentContextControlEvent({
      capturedAtUtc: "2026-07-22T10:15:00.000Z",
      cacheState: "ready",
      unavailableReason: null,
      documents: [{
        documentId: "control-only-document",
        title: "Control-only Fixture Model",
        pathDigest: null,
        isWorkshared: false,
        isActive: true,
      }],
      activeDocumentId: "control-only-document",
      activeView: {
        documentId: "control-only-document",
        id: "2003",
        name: "Control-only Fixture View",
        type: "ThreeD",
        level: null,
      },
      disciplineHint: "coordination",
    });
    const evidence = fixture.snapshotEvidence().documentContextEvidence;

    expect(acknowledgement).toMatchObject({
      action: "apply_document_context",
      revision: 2,
      cacheIncarnationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      cachedContextHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      activeDocumentIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      acknowledgementHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(evidence).toMatchObject({
      currentRevision: acknowledgement.revision,
      cachedContextHash: acknowledgement.cachedContextHash,
      activeDocumentIdentityHash: acknowledgement.activeDocumentIdentityHash,
      lastControlAcknowledgementHash: acknowledgement.acknowledgementHash,
      cacheIncarnationDigest: acknowledgement.cacheIncarnationDigest,
    });
    expect(JSON.stringify(evidence)).not.toContain("control-only-document");
    expect(JSON.stringify(evidence)).not.toContain("Control-only Fixture Model");
  });

  it("uses a new opaque cache incarnation for each fixture process lifetime", () => {
    const first = new AddinLoopbackFixture().snapshotEvidence().documentContextEvidence;
    const second = new AddinLoopbackFixture().snapshotEvidence().documentContextEvidence;
    expect(first.cacheIncarnationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second.cacheIncarnationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.cacheIncarnationDigest).not.toBe(second.cacheIncarnationDigest);
    expect(JSON.stringify(first)).not.toMatch(/revagent:fixture-cache-incarnation|nonce/iu);
  });

  it("bounds document-context evidence while retaining monotonic totals", () => {
    const fixture = new AddinLoopbackFixture();
    for (let index = 0; index < 260; index += 1) {
      fixture.applyDocumentContextEvent({
        capturedAtUtc: "2026-07-22T10:15:00.000Z",
        cacheState: "ready",
        unavailableReason: null,
        documents: [],
        activeDocumentId: null,
        activeView: null,
        disciplineHint: null,
      });
    }
    const evidence = fixture.snapshotEvidence().documentContextEvidence;

    expect(evidence).toMatchObject({
      evidenceVersion: 1,
      capacity: 256,
      totalEventCount: 261,
      droppedEventCount: 5,
      applicationEventCacheUpdateCount: 260,
      externalEventRaiseCount: 0,
    });
    expect(evidence.timeline).toHaveLength(256);
    expect(evidence.timeline[0]!.sequence).toBe(6);
    expect(evidence.timeline.at(-1)!.sequence).toBe(261);
  });

  it("rejects malformed UTF-8 before JSON parsing or method dispatch", async () => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const prefix = Buffer.from(
      '{"jsonrpc":"2.0","id":"malformed","method":"fixture_echo","params":{"x":"',
      "utf8",
    );
    const suffix = Buffer.from('"}}', "utf8");
    const malformed = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);
    const frame = Buffer.alloc(4 + malformed.byteLength);
    frame.writeUInt32BE(malformed.byteLength, 0);
    malformed.copy(frame, 4);
    const responsePromise = readFixtureFrames(socket, 1);

    socket.write(frame);
    const response = (await responsePromise)[0] as JsonObject;

    expect(response).toMatchObject({ jsonrpc: "2.0", id: null });
    expect((response.error as JsonObject).code).toBe(-32700);
    expect(fixture.getMethodExecutionCount("fixture_echo")).toBe(0);
  });

  it.each([
    [
      "root",
      '{"jsonrpc":"2.0","id":"01900000-0000-7000-8000-000000000401","method":"fixture_echo","method":"fixture_counter","params":{}}',
    ],
    [
      "nested",
      '{"jsonrpc":"2.0","id":"01900000-0000-7000-8000-000000000402","method":"fixture_echo","params":{"value":1,"value":2}}',
    ],
  ])("rejects %s duplicate JSON keys before dispatch", async (_scope, raw) => {
    const { fixture, address } = await started();
    const socket = await connected(address);
    const responsePromise = readFixtureFrames(socket, 1);

    socket.write(rawFrame(raw));
    const response = (await responsePromise)[0] as JsonObject;

    expect(response).toMatchObject({ jsonrpc: "2.0", id: null });
    expect((response.error as JsonObject).code).toBe(-32700);
    expect(fixture.getMethodExecutionCount("fixture_echo")).toBe(0);
    expect(fixture.getMethodExecutionCount("fixture_counter")).toBe(0);
  });

  it.each([
    ["partial_header", 2],
    ["partial_payload", 8],
  ] as const)("disconnects after a deterministic %s response prefix", async (_phase, bytes) => {
    const { fixture, address } = await started();
    const id = uuid7(28 + bytes);
    fixture.planFault(id, {
      disconnect: "after_response_bytes",
      afterResponseBytes: bytes,
    });
    const socket = await connected(address);
    const closed = readUntilClose(socket);

    socket.write(encodeJsonFrame(request(id, "fixture_counter"), MIN_REQUEST_PAYLOAD_BYTES));
    const prefix = await closed;

    expect(prefix.byteLength).toBe(bytes);
    expect(fixture.getExecutionCount(id)).toBe(1);
    expect(fixture.observations).toContainEqual(
      expect.objectContaining({
        requestId: id,
        phase: "disconnected",
        payloadBytes: bytes,
        detail: `after_response_bytes:${bytes}`,
      }),
    );
    expect(fixture.observations.filter(
      (entry) => entry.requestId === id && entry.phase === "response_sent",
    )).toHaveLength(0);
  });

  it("emits an exact-max listener response and substitutes max-plus-one", async () => {
    const { fixture, address } = await started();
    const exactId = uuid7(21);
    const plusOneId = uuid7(22);
    fixture.registerHandler("fixture_exact_response", "read_only", () => ({
      payload: exactResponsePadding(exactId, 32 * 1024 * 1024),
    }));
    fixture.registerHandler("fixture_oversize_response", "read_only", () => ({
      payload: exactResponsePadding(plusOneId, 32 * 1024 * 1024 + 1),
    }));
    const socket = await connected(address);

    const exact = await writeAndRead(
      socket,
      request(exactId, "fixture_exact_response"),
    );
    expect(exact.id).toBe(exactId);
    expect(fixture.observations.find(
      (entry) => entry.requestId === exactId && entry.phase === "response_sent",
    )?.payloadBytes).toBe(32 * 1024 * 1024);

    const overflow = await writeAndRead(
      socket,
      request(plusOneId, "fixture_oversize_response"),
    );
    expect((overflow.error as JsonObject).code).toBe(-32603);
    expect(fixture.observations.find(
      (entry) => entry.requestId === plusOneId && entry.phase === "response_overflow",
    )?.payloadBytes).toBe(32 * 1024 * 1024 + 1);
  });

  it("exposes busy, delay, and stall controls without double execution", async () => {
    const { fixture, address } = await started();
    const busyId = uuid7(9);
    fixture.planFault(busyId, { busy: true });
    const busySocket = await connected(address);
    const busy = await writeAndRead(busySocket, request(busyId, "fixture_echo"));
    expect(busy.result).toMatchObject({ guarded: true, guardedReason: "busy" });
    expect(fixture.getExecutionCount(busyId)).toBe(1);

    const delayedId = uuid7(10);
    fixture.planFault(delayedId, { delayMs: 50 });
    const delayedSocket = await connected(address);
    const delayedResponse = writeAndRead(delayedSocket, request(delayedId, "fixture_echo"));
    await waitFor(() => fixture.observations.some(
      (entry) => entry.requestId === delayedId && entry.phase === "validated",
    ));
    const statusSocket = await connected(address);
    const status = await writeAndRead(statusSocket, request(uuid7(11), "mcp_status"));
    expect((status.result as JsonObject).activeTask).toMatchObject({ requestId: delayedId });
    await delayedResponse;

    const stalledId = uuid7(12);
    fixture.planFault(stalledId, { stall: true });
    const stalledSocket = await connected(address);
    const stalledResponse = writeAndRead(stalledSocket, request(stalledId, "fixture_echo"));
    await waitFor(() => fixture.releaseStall(stalledId));
    await stalledResponse;
    expect(fixture.getExecutionCount(stalledId)).toBe(1);
  });

  it("records a deterministic late outcome after disconnect", async () => {
    const { fixture, address } = await started();
    const id = uuid7(13);
    fixture.registerHandler("fixture_late", "read_only", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return { success: true, completedLate: true };
    });
    fixture.planFault(id, { disconnect: "after_dispatch" });
    const socket = await connected(address);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.write(encodeJsonFrame(request(id, "fixture_late"), MIN_REQUEST_PAYLOAD_BYTES));
    await closed;
    await waitFor(() => fixture.observations.some(
      (entry) => entry.requestId === id && entry.phase === "late_outcome",
    ));

    expect(fixture.getExecutionCount(id)).toBe(1);
    expect(fixture.observations.filter(
      (entry) => entry.requestId === id && entry.phase === "response_sent",
    )).toHaveLength(0);
  });

  it("releases two concurrent same-id FIFO stalls and stops cleanly", async () => {
    const { fixture, address } = await started();
    const id = uuid7(23);
    fixture.planFault(id, { stall: true });
    fixture.planFault(id, { stall: true });
    const firstSocket = await connected(address);
    const secondSocket = await connected(address);
    const firstResponse = writeAndRead(firstSocket, request(id, "fixture_counter"));
    const secondResponse = writeAndRead(secondSocket, request(id, "fixture_counter"));

    await waitFor(() => fixture.getPendingStallCount(id) === 2);
    expect(fixture.releaseStall(id)).toBe(true);
    expect(fixture.releaseStall(id)).toBe(true);
    expect(fixture.releaseStall(id)).toBe(false);
    await Promise.all([firstResponse, secondResponse]);

    expect(fixture.getExecutionCount(id)).toBe(2);
    expect(fixture.getPendingStallCount(id)).toBe(0);
    await fixture.stop();
    expect(fixture.address).toBeNull();
  });

  it("releases every duplicate stalled delivery during stop", async () => {
    const { fixture, address } = await started();
    const id = uuid7(24);
    fixture.planFault(id, { stall: true });
    fixture.planFault(id, { stall: true });
    const firstSocket = await connected(address);
    const secondSocket = await connected(address);
    firstSocket.write(encodeJsonFrame(request(id, "fixture_echo"), MIN_REQUEST_PAYLOAD_BYTES));
    secondSocket.write(encodeJsonFrame(request(id, "fixture_echo"), MIN_REQUEST_PAYLOAD_BYTES));

    await waitFor(() => fixture.getPendingStallCount(id) === 2);
    await fixture.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.getPendingStallCount(id)).toBe(0);
    expect(fixture.getExecutionCount(id)).toBe(0);
    expect(fixture.address).toBeNull();
  });

  it("preserves each actual dispatch ordinal for duplicate-id late outcomes", async () => {
    const { fixture, address } = await started();
    const id = uuid7(25);
    fixture.registerHandler("fixture_duplicate_late", "read_only", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return { success: true };
    });
    fixture.planFault(id, { disconnect: "after_dispatch" });
    fixture.planFault(id, { disconnect: "after_dispatch" });
    const firstSocket = await connected(address);
    const secondSocket = await connected(address);
    firstSocket.write(
      encodeJsonFrame(request(id, "fixture_duplicate_late"), MIN_REQUEST_PAYLOAD_BYTES),
    );
    secondSocket.write(
      encodeJsonFrame(request(id, "fixture_duplicate_late"), MIN_REQUEST_PAYLOAD_BYTES),
    );

    await waitFor(() => fixture.observations.filter(
      (entry) => entry.requestId === id && entry.phase === "late_outcome",
    ).length === 2);
    const startedOrdinals = fixture.observations
      .filter((entry) => entry.requestId === id && entry.phase === "dispatch_started")
      .map((entry) => entry.executionOrdinal)
      .sort((left, right) => Number(left) - Number(right));
    const lateOrdinals = fixture.observations
      .filter((entry) => entry.requestId === id && entry.phase === "late_outcome")
      .map((entry) => entry.executionOrdinal)
      .sort((left, right) => Number(left) - Number(right));

    expect(startedOrdinals).toHaveLength(2);
    expect(new Set(startedOrdinals).size).toBe(2);
    expect(lateOrdinals).toEqual(startedOrdinals);
  });

  it("simulates a process crash after dispatch and retains the late observation", async () => {
    const { fixture, address } = await started();
    const id = uuid7(14);
    fixture.registerHandler("fixture_crash", "read_only", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return { success: true };
    });
    fixture.planFault(id, { crash: "after_dispatch" });
    const socket = await connected(address);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.write(encodeJsonFrame(request(id, "fixture_crash"), MIN_REQUEST_PAYLOAD_BYTES));
    await closed;
    await waitFor(() => fixture.observations.some(
      (entry) => entry.requestId === id && entry.phase === "late_outcome",
    ));

    expect(fixture.crashed).toBe(true);
    expect(fixture.address).toBeNull();
    expect(fixture.getExecutionCount(id)).toBe(1);
  });
});
