import { Buffer } from "node:buffer";

import { validateRbpEnvelope } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import { caseProgram } from "../src/casePrograms.js";
import { canonicalManifest } from "../src/manifest.js";
import {
  executeParentSteps,
  type ParentStepDriver,
  type ParentStepDriverRequest,
  type ParentStepDrivers,
} from "../src/parentStepEngine.js";
import {
  RAW_PRODUCTION_EXTERNAL_DEPENDENCIES,
  RAW_PRODUCTION_ORACLES,
} from "../src/productionCaseOraclesRaw.js";
import {
  RAW_PRODUCTION_CASES,
  RAW_PRODUCTION_FRAME_FACTS,
  rawProductionCaseVariables,
  rawProductionOpeningHello,
} from "../src/productionCaseSeedsRaw.js";
import type {
  Binding,
  ManifestAssertion,
  ProcessObservationRecord,
} from "../src/types.js";

const NOW = "2026-07-22T12:00:00.000Z";

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("test value must be an object");
  }
  return value as Record<string, unknown>;
}

function at(value: unknown, ...path: string[]): unknown {
  let cursor = value;
  for (const segment of path) cursor = objectValue(cursor)[segment];
  return cursor;
}

function noUnresolvedTokens(value: unknown): boolean {
  if (typeof value === "string") return !/\{\{[A-Za-z][A-Za-z0-9_.-]*\}\}/u.test(value);
  if (Array.isArray(value)) return value.every(noUnresolvedTokens);
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(noUnresolvedTokens);
  }
  return true;
}

function assertion(assertionId: string): ManifestAssertion {
  for (const rows of Object.values(canonicalManifest.requiredAssertions)) {
    const match = rows.find(({ id }) => id === assertionId);
    if (match !== undefined) return match;
  }
  throw new Error(`missing assertion ${assertionId}`);
}

function context(
  assertionId: string,
  binding: Binding,
  observations: ProcessObservationRecord[],
) {
  return {
    caseId: assertionId.slice(0, 6),
    binding,
    assertion: assertion(assertionId),
    observations,
  };
}

function observation(
  caseId: string,
  binding: Binding,
  ordinal: number,
  kind: ProcessObservationRecord["kind"],
  payload: unknown,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `raw-test:${caseId}:${binding}:${ordinal}`,
    runId: "raw-production-test",
    caseId,
    binding,
    componentId: "gateway_stub",
    kind,
    at: NOW,
    payload,
  };
}

function helloAckRemote(binding: Binding): Record<string, unknown> {
  const ack = {
    type: "hello_ack",
    id: "0197a3c2-0000-7000-8000-000000000001",
    ts: NOW,
    payload: {},
  };
  if (binding === "wss") {
    return {
      kind: "wss_exchange",
      receivedFrames: [{
        index: 0,
        binary: false,
        bytes: 64,
        sha256: `sha256:${"1".repeat(64)}`,
        parsed: ack,
        parseState: "parsed",
      }],
      close: null,
    };
  }
  return {
    kind: "streamable_http_sse_exchange",
    createResponse: {
      status: 201,
      body: {
        bytes: 64,
        sha256: `sha256:${"1".repeat(64)}`,
        parsed: ack,
        parseState: "parsed",
      },
    },
    messagesResponse: null,
    sse: null,
  };
}

function rawObservation(
  caseId: string,
  stepId: string,
  binding: Binding,
  remoteOutcome: Record<string, unknown>,
): ProcessObservationRecord {
  const fact = RAW_PRODUCTION_FRAME_FACTS.get(stepId);
  if (fact === undefined) throw new Error(`missing frame fact ${stepId}`);
  return observation(caseId, binding, 1, "wire_event", {
    stepId,
    action: "send_binding_frame",
    direction: "parent_to_gateway",
    binding,
    serialized: { bytes: fact.bytes, sha256: fact.sha256 },
    frame: { type: fact.type, source: fact.source },
    credentialSource: fact.credentialSource,
    atMonotonicMs: 1,
    remoteOutcome,
  });
}

describe("raw production C25-C40 seed catalog", () => {
  it("covers the exact sixteen raw cases", () => {
    expect(RAW_PRODUCTION_CASES).toEqual(
      Array.from({ length: 16 }, (_, index) => `O1-C${index + 25}`),
    );
  });

  it("resolves every program token for both bindings and emits driver-ready raw frames", async () => {
    const rawRequests: ParentStepDriverRequest[] = [];
    const driver: ParentStepDriver = async (request) => {
      expect(noUnresolvedTokens(request.arguments)).toBe(true);
      if (request.action === "send_binding_frame") rawRequests.push(request);
      if (request.action === "restart_case_stack") {
        return {
          kind: "success",
          result: {
            readiness: {
              fixture: { host: "127.0.0.1", port: 48_298 },
              gateway: {
                ws_url: "wss://127.0.0.1:48291/bridge/v1",
                http_connection_url: "https://127.0.0.1:48291/bridge/v1/http/connections",
                control_url: "https://127.0.0.1:48291/control/v1",
                tlsTrust: {
                  caCertificatePath: "C:/test/ca.pem",
                  caCertificateSha256: `sha256:${"a".repeat(64)}`,
                  serverCertificateSha256: `sha256:${"b".repeat(64)}`,
                },
              },
            },
          },
        };
      }
      if (request.action === "restart_component") {
        return {
          kind: "success",
          result: {
            readiness: {
              ws_url: "ws://127.0.0.1:48291/bridge/v1",
              http_connection_url: "http://127.0.0.1:48291/bridge/v1/http/connections",
            },
          },
        };
      }
      if (request.action === "open_transport") {
        return {
          kind: "success",
          result: {
            connectionId: "connection-raw",
            helloAck: {
              payload: {
                protocol: 1,
                granted_capabilities: ["journal_v1", "chunked_results"],
              },
            },
          },
        };
      }
      if (
        request.caseId === "O1-C37" &&
        request.action === "spawn_fixture_bind_probe"
      ) {
        return {
          kind: "success",
          result: {
            firstPort: 48_298,
            lastPort: 48_301,
            primaryProbeIndex: 0,
            auxiliaryProbeIndexes: [1, 2, 3],
          },
        };
      }
      if (
        request.caseId === "O1-C37" &&
        request.stepId.endsWith(".resume")
      ) {
        return {
          kind: "control_error",
          code: "bridge_control_invalid_control_request",
          message: "session is not resumable",
        };
      }
      if (
        request.caseId === "O1-C37" &&
        request.stepId.endsWith(".new-dispatch")
      ) {
        return {
          kind: "control_error",
          code: "gateway_control_http_403",
          message: "unknown or revoked rsid",
        };
      }
      if (request.action === "await_condition") {
        const c37Rsids = [
          "rs_raw_primary",
          "rs_raw_bridge_shutdown",
          "rs_raw_session_replaced",
          "rs_raw_operator_requested",
        ];
        return {
          kind: "success",
          result: {
            snapshot: {
              sessions: c37Rsids.map((rsid) => ({ rsid })),
            },
            dynamic: {
              rsid: "rs_raw_primary",
              rsids: c37Rsids,
              nextSeq: 1,
              lastAck: 0,
              grantedSessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
            },
          },
        };
      }
      return { kind: "success", result: { retainedFact: request.action } };
    };
    const drivers: ParentStepDrivers = {
      gateway_http_control: driver,
      bridge_jsonl_control: driver,
      fixture_jsonl_control: driver,
      parent_harness: driver,
      abortAndDrain: async () => undefined,
    };

    for (const caseId of RAW_PRODUCTION_CASES) {
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        const program = caseProgram(caseId);
        const result = await executeParentSteps({
          runId: `raw-${caseId.toLowerCase()}-${binding}`,
          caseId,
          binding,
          steps: program.steps,
          drivers,
          variables: rawProductionCaseVariables(caseId, { binding }),
          now: () => NOW,
        });
        expect(result.completedStepIds).toEqual(program.steps.map(({ stepId }) => stepId));
      }
    }

    const uniqueRawSteps = new Set(rawRequests.map(({ stepId }) => stepId));
    expect(uniqueRawSteps).toEqual(new Set(RAW_PRODUCTION_FRAME_FACTS.keys()));
    for (const request of rawRequests) {
      const fact = RAW_PRODUCTION_FRAME_FACTS.get(request.stepId);
      expect(fact).toBeDefined();
      const hasFrame = Object.prototype.hasOwnProperty.call(request.arguments, "frame");
      const hasSerialized = Object.prototype.hasOwnProperty.call(request.arguments, "serializedFrame");
      expect(Number(hasFrame) + Number(hasSerialized)).toBe(1);
      const serialized = hasSerialized
        ? String(request.arguments.serializedFrame)
        : JSON.stringify(request.arguments.frame);
      expect(Buffer.byteLength(serialized, "utf8")).toBe(fact!.bytes);
      expect(fact!.source).toBe(hasSerialized ? "serializedFrame" : "frame");
      expect(fact!.credentialSource).toBe(
        Object.prototype.hasOwnProperty.call(request.arguments, "credential")
          ? "step_override"
          : "configured",
      );
      if (fact!.type !== "hello") {
        expect(at(rawProductionOpeningHello(request), "type")).toBe("hello");
      }
    }
  });

  it("keeps complete batch and payload vectors schema-exact at the protocol boundary", () => {
    const variables = rawProductionCaseVariables("O1-C30");
    const positiveFrames = [
      at(variables, "vectors", "c29", "mixed_non_atomic"),
      at(variables, "vectors", "c29", "atomic_terminal"),
      at(variables, "vectors", "c29", "atomic_indeterminate"),
      at(variables, "vectors", "c30", "property-order"),
      at(variables, "vectors", "c30", "number-formatting"),
      at(variables, "vectors", "c30", "unicode"),
      at(variables, "vectors", "c30", "escapes"),
      at(variables, "vectors", "c30", "changed-policy"),
      at(variables, "vectors", "c30", "changed-scope"),
      at(variables, "vectors", "c30", "changed-clearance"),
      JSON.parse(String(at(variables, "vectors", "c30", "harmless-reserialization"))),
      at(variables, "vectors", "c31", "heartbeat_ack_positive"),
      at(variables, "vectors", "c31", "session_register_positive"),
      at(variables, "vectors", "c31", "session_unregister_positive"),
      at(variables, "vectors", "c31", "session_resume_positive"),
      at(variables, "vectors", "c31", "cancel_positive"),
      at(variables, "vectors", "c31", "goodbye_positive"),
      at(variables, "vectors", "c31", "manifest_positive"),
      at(variables, "vectors", "c34", "valid_session_register"),
      at(variables, "vectors", "c35", "max_safe_seq"),
    ];
    for (const frame of positiveFrames) {
      expect(validateRbpEnvelope(frame), JSON.stringify(frame)).toBe(true);
    }

    const negativeFrames = [
      at(variables, "vectors", "c30", "step-omission"),
      at(variables, "vectors", "c30", "params-digest-mismatch"),
      at(variables, "vectors", "c30", "per-step-digest"),
      at(variables, "vectors", "c30", "batch-digest"),
      at(variables, "vectors", "c31", "heartbeat_ack_negative"),
      at(variables, "vectors", "c31", "session_register_negative"),
      at(variables, "vectors", "c31", "session_unregister_negative"),
      at(variables, "vectors", "c31", "session_resume_negative"),
      at(variables, "vectors", "c31", "cancel_negative"),
      at(variables, "vectors", "c31", "goodbye_negative"),
      at(variables, "vectors", "c31", "manifest_negative"),
      at(variables, "vectors", "c32", "base64_alphabet"),
      at(variables, "vectors", "c32", "base64_padding"),
      at(variables, "vectors", "c32", "stream_identity"),
      at(variables, "vectors", "c32", "decoded_limit"),
      at(variables, "vectors", "c35", "unsafe_two_pow_53"),
      at(variables, "vectors", "c38", "guarded_without_reason"),
      at(variables, "vectors", "c39", "nonreplay"),
      at(variables, "vectors", "c39", "missing_digest"),
      at(variables, "vectors", "c39", "inline_result"),
    ];
    for (const frame of negativeFrames) {
      expect(validateRbpEnvelope(frame), JSON.stringify(frame).slice(0, 1_000)).toBe(false);
    }
  });
});

describe("raw production C25-C40 assertion oracles", () => {
  it("covers the exact canonical assertion range without duplicate or unknown ids", () => {
    const expected = RAW_PRODUCTION_CASES.flatMap((caseId) =>
      canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
    expect([...RAW_PRODUCTION_ORACLES.keys()].sort()).toEqual([...expected].sort());
    expect(RAW_PRODUCTION_ORACLES.size).toBe(expected.length);
    expect(expected.length).toBe(110);
  });

  it("cannot source PASS from generic child success or child-owned verdict fields", () => {
    for (const [assertionId, oracle] of RAW_PRODUCTION_ORACLES) {
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        const generic = observation(assertionId.slice(0, 6), binding, 1, "control_result", {
          schemaVersion: "rbp-step-control-observation/v1",
          stepId: "generic.success",
          phase: "observation",
          channel: "bridge_jsonl_control",
          request: { action: "snapshot_evidence", arguments: {} },
          response: {
            kind: "success",
            result: { actual: true, passed: true, verdict: "pass" },
          },
          requestBytes: 1,
          responseBytes: 1,
        });
        expect(oracle(context(assertionId, binding, [generic])), assertionId).toBe(false);
      }
    }
  });

  it("accepts exact parent-owned wire metadata plus concrete hello_ack evidence", () => {
    const assertionId = "O1-C26-N-COMPATIBLE";
    const oracle = RAW_PRODUCTION_ORACLES.get(assertionId)!;
    for (const binding of ["wss", "streamable_http_sse"] as const) {
      const evidence = rawObservation(
        "O1-C26",
        "o1-c26.version-n",
        binding,
        helloAckRemote(binding),
      );
      expect(oracle(context(assertionId, binding, [evidence]))).toBe(true);

      const tampered = structuredClone(evidence);
      objectValue(objectValue(tampered.payload).serialized).sha256 = `sha256:${"f".repeat(64)}`;
      expect(oracle(context(assertionId, binding, [tampered]))).toBe(false);
    }
  });

  it("keeps C33 and C40 explicit supervisor dependencies fail closed", () => {
    expect(RAW_PRODUCTION_EXTERNAL_DEPENDENCIES.size).toBe(18);
    for (const [assertionId, dependency] of RAW_PRODUCTION_EXTERNAL_DEPENDENCIES) {
      expect(dependency).toMatch(/^supervisor\./u);
      const oracle = RAW_PRODUCTION_ORACLES.get(assertionId)!;
      const forged = observation(assertionId.slice(0, 6), "wss", 1, "wire_event", {
        dependency,
        assertionId,
        actual: true,
        passed: true,
        verdict: "pass",
      });
      expect(oracle(context(assertionId, "wss", [forged]))).toBe(false);
    }
  });
});
