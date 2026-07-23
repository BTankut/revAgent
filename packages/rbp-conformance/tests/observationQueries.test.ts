import { describe, expect, it } from "vitest";

import {
  controlFactForStep,
  observationPointer,
  observationsForStep,
  singleStepObservation,
  successfulControlResult,
} from "../src/observationQueries.js";
import type { ProcessObservationRecord } from "../src/types.js";

function control(stepId: string, ordinal = 1): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `run:O1-C01:wss:${ordinal}`,
    runId: "run",
    caseId: "O1-C01",
    binding: "wss",
    componentId: "bridge_simulator",
    kind: "control_result",
    at: "2026-07-23T00:00:00.000Z",
    payload: {
      schemaVersion: "rbp-step-control-observation/v1",
      stepId,
      phase: "stimulus",
      channel: "bridge_jsonl_control",
      executionMode: "sequential",
      dispatchMode: "sequential",
      request: { action: "snapshot_evidence", arguments: {} },
      response: { kind: "success", result: { sessions: [{ rsid: "rsid-1" }] } },
      requestBytes: 2,
      responseBytes: 2,
    },
  };
}

function snapshot(stepId: string): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: "run:O1-C01:wss:snapshot",
    runId: "run",
    caseId: "O1-C01",
    binding: "wss",
    componentId: "bridge_simulator",
    kind: "bridge_snapshot",
    at: "2026-07-23T00:00:01.000Z",
    payload: { schemaVersion: "rbp-parent-bridge-snapshot/v1", stepId, action: "snapshot_evidence" },
  };
}

describe("parent observation queries", () => {
  it("resolves strict JSON pointers without prototype traversal", () => {
    const value = { a: [{ "x/y": { "~z": 7 } }] };
    expect(observationPointer(value, "/a/0/x~1y/~0z")).toBe(7);
    expect(() => observationPointer(value, "/__proto__/x")).toThrow(/reserved/u);
    expect(() => observationPointer(value, "/a/01")).toThrow(/array index/u);
  });

  it("parses one exact control result and returns a clone", () => {
    const row = control("o1-c01.bridge-snapshot");
    expect(controlFactForStep([row], "o1-c01.bridge-snapshot").action).toBe("snapshot_evidence");
    const result = successfulControlResult([row], "o1-c01.bridge-snapshot", "snapshot_evidence") as {
      sessions: Array<{ rsid: string }>;
    };
    result.sessions[0]!.rsid = "mutated";
    expect(observationPointer(row.payload, "/response/result/sessions/0/rsid")).toBe("rsid-1");
  });

  it("fails closed on missing, duplicate, mismatched, or unsuccessful controls", () => {
    expect(() => controlFactForStep([], "missing")).toThrow(/observed 0/u);
    expect(() => controlFactForStep([control("same", 1), control("same", 2)], "same")).toThrow(/observed 2/u);
    expect(() => successfulControlResult([control("same")], "same", "shutdown")).toThrow(/does not match/u);
    const failed = control("same");
    (failed.payload as { response: unknown }).response = { kind: "control_error", code: "x", message: "no" };
    expect(() => successfulControlResult([failed], "same")).toThrow(/did not retain/u);
  });

  it("binds non-control observations to parent-attached step ids", () => {
    const row = snapshot("o1-c01.bridge-snapshot");
    expect(observationsForStep([row], "o1-c01.bridge-snapshot", {
      kind: "bridge_snapshot",
      componentId: "bridge_simulator",
      binding: "wss",
    })).toHaveLength(1);
    expect(singleStepObservation([row], "o1-c01.bridge-snapshot", {
      kind: "bridge_snapshot",
    }).observationId).toBe(row.observationId);
    expect(() => singleStepObservation([], "o1-c01.bridge-snapshot", {
      kind: "bridge_snapshot",
    })).toThrow(/observed 0/u);
  });
});
