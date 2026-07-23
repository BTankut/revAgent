import { describe, expect, it } from "vitest";

import {
  BRIDGE_CONTROL_ACTIONS,
  CASE_CONTROL_OBSERVATION_MAP,
  FIXTURE_CONTROL_ACTIONS,
  GATEWAY_CONTROL_ACTIONS,
  HARNESS_ACTIONS,
  assertValidCaseControlStepSemantics,
} from "../src/casePrograms.js";
import type { CaseControlStep } from "../src/casePrograms.js";
import { canonicalManifest } from "../src/manifest.js";
import { ASSERTION_EVIDENCE_BINDINGS } from "../src/observationLedger.js";

const CONTROL_KEYS: Readonly<Record<string, { required: string[]; optional?: string[] }>> = {
  "gateway_http_control:enqueue_frame_fault": { required: ["rule"] },
  "gateway_http_control:enqueue_opening_fault": { required: ["rule"] },
  "gateway_http_control:flush_held": { required: [], optional: ["connection_id"] },
  "gateway_http_control:set_sse_buffering": { required: ["connection_id", "enabled"] },
  "gateway_http_control:disconnect": { required: ["connection_id"] },
  "gateway_http_control:set_auth_status": { required: ["token", "status"] },
  "gateway_http_control:expire_pending": { required: ["rsid"] },
  "gateway_http_control:install_hold": { required: ["rsid", "mutation_scope", "origin_invocation_ids"] },
  "gateway_http_control:record_verification_evidence": { required: ["request"] },
  "gateway_http_control:record_late_terminal_evidence": { required: ["request"] },
  "gateway_http_control:dispatch_invoke": { required: ["request"] },
  "gateway_http_control:dispatch_batch": { required: ["request"] },
  "gateway_http_control:dispatch_cancel": { required: ["request"] },
  "gateway_http_control:dispatch_payload_recovery": { required: ["request"] },
  "gateway_http_control:liveness_sweep": { required: [] },
  "gateway_http_control:set_clock": { required: ["now_ms"] },
  "gateway_http_control:snapshot": { required: [] },
  "bridge_jsonl_control:discover_fixture": { required: [], optional: ["host", "port", "firstPort", "lastPort", "probeTimeoutMs"] },
  "bridge_jsonl_control:attach_fixture_session": {
    required: ["probeIndex", "rsid", "resumeToken", "resumeExpiresAt", "userHint", "hostname", "fingerprint", "bridgeVersion"],
    optional: ["grantedSessionCapabilities"],
  },
  "bridge_jsonl_control:open_transport": {
    required: ["kind", "deviceToken", "hello"],
    optional: ["wssUrl", "fallbackUrl", "fallbackProvisioned", "endpointPolicy", "tlsTrust", "clockStartMs"],
  },
  "bridge_jsonl_control:start_run_loop": { required: [] },
  "bridge_jsonl_control:session_register": { required: ["probeIndex", "userHint", "hostname", "fingerprint", "bridgeVersion"] },
  "bridge_jsonl_control:session_resume": { required: ["rsid"] },
  "bridge_jsonl_control:session_unregister": { required: ["rsid", "reason"] },
  "bridge_jsonl_control:tick": { required: ["nowMs"] },
  "bridge_jsonl_control:poll_document_context": { required: ["rsid"], optional: ["force"] },
  "bridge_jsonl_control:flush_outbound": { required: [], optional: ["rsid"] },
  "bridge_jsonl_control:invoke_local": { required: ["envelope"], optional: ["crashAt"] },
  "bridge_jsonl_control:record_verification_attempt": {
    required: ["rsid", "holdId", "verificationInvocationId", "evidenceDigest", "conclusion", "atMs"],
  },
  "bridge_jsonl_control:record_late_evidence": {
    required: ["rsid", "holdId", "originInvocationId", "evidenceDigest", "conclusion", "atMs"],
  },
  "bridge_jsonl_control:resolve_hold": {
    required: [
      "rsid",
      "holdId",
      "basis",
      "verificationInvocationId",
      "evidenceDigest",
      "decision",
      "resolutionId",
      "auditId",
      "authorizedDispatchIdentity",
      "atMs",
    ],
  },
  "bridge_jsonl_control:clearance_for_hold": { required: ["rsid", "holdId"] },
  "bridge_jsonl_control:inject_crash": { required: ["point"] },
  "bridge_jsonl_control:restart_simulator": { required: [] },
  "bridge_jsonl_control:configure_reconnect_conformance": {
    required: ["mode", "jitterUnits"],
  },
  "bridge_jsonl_control:advance_reconnect_conformance_clock": {
    required: ["advanceByMs", "heartbeatStepMs"],
  },
  "bridge_jsonl_control:snapshot_evidence": { required: [], optional: ["snapshotId", "cursor"] },
  "bridge_jsonl_control:shutdown": { required: [] },
  "fixture_jsonl_control:plan_fault": { required: ["requestId", "fault"], optional: ["fixtureIndex"] },
  "fixture_jsonl_control:release_stall": { required: ["requestId"], optional: ["fixtureIndex"] },
  "fixture_jsonl_control:apply_document_context": { required: ["event"] },
  "fixture_jsonl_control:snapshot_evidence": { required: [], optional: ["snapshotId", "cursor", "fixtureIndex"] },
  "fixture_jsonl_control:shutdown": { required: [] },
};

describe("exact forty-case control and observation catalog", () => {
  it("maps all cases and all 167 assertions in canonical order", () => {
    expect([...CASE_CONTROL_OBSERVATION_MAP.keys()]).toEqual(canonicalManifest.cases.map(({ id }) => id));
    const probes = [...CASE_CONTROL_OBSERVATION_MAP.values()].flatMap(({ assertionProbes }) => assertionProbes);
    const assertions = canonicalManifest.cases.flatMap(({ id }) => canonicalManifest.requiredAssertions[id]!);
    expect(probes).toHaveLength(167);
    expect(probes.map(({ assertionId }) => assertionId)).toEqual(assertions.map(({ id }) => id));
    expect(probes.map(({ subvectorId }) => subvectorId)).toEqual(assertions.map(({ subvectorId }) => subvectorId));
    expect(probes.every(({ evaluationOwner, operator, expected }) =>
      evaluationOwner === "parent_runner" && operator === "canonical_subvector" && expected === true)).toBe(true);
    expect(JSON.stringify(probes)).not.toContain("passed");
  });

  it("uses only exact T3/T4/T5 controls and has resolvable same-case observation sources", () => {
    for (const program of CASE_CONTROL_OBSERVATION_MAP.values()) {
      const stepIds = program.steps.map(({ stepId }) => stepId);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      expect(program.bindings).toEqual(["wss", "streamable_http_sse"]);
      expect(program.steps[0]).toMatchObject({ channel: "parent_harness", action: "restart_case_stack" });
      expect(program.steps[1]).toMatchObject({ channel: "parent_harness", action: "begin_wire_capture" });
      expect(program.steps.at(-2)).toMatchObject({ channel: "parent_harness", action: "end_wire_capture" });
      expect(program.steps.at(-1)).toMatchObject({ channel: "parent_harness", action: "stop_case_stack" });
      for (const step of program.steps) {
        if (step.stepId === "o1-c21.batch") {
          expect(step.expectedOutcome).toEqual({
            kind: "control_error",
            code: "gateway_control_http_400",
            messageIncludes: "atomic batch",
          });
        } else if (step.stepId.endsWith(".resume") && step.stepId.startsWith("o1-c37.")) {
          expect(step.expectedOutcome).toEqual({
            kind: "control_error",
            code: "bridge_control_invalid_control_request",
            messageIncludes: "not resumable",
          });
        } else if (step.stepId.endsWith(".new-dispatch") && step.stepId.startsWith("o1-c37.")) {
          expect(step.expectedOutcome).toEqual({
            kind: "control_error",
            code: "gateway_control_http_403",
            messageIncludes: "revoked",
          });
        } else {
          expect(step.expectedOutcome).toEqual({ kind: "success" });
        }
        expect(["sequential", "async_start", "async_join", "barrier"]).toContain(step.execution.mode);
        expect(new Set(step.captures.map(({ name }) => name)).size).toBe(step.captures.length);
        expect(step.parentTimeoutMs).toBeGreaterThan(0);
        expect(step.parentTimeoutMs).toBeLessThanOrEqual(300_000);
        expect(() => assertValidCaseControlStepSemantics(step)).not.toThrow();
        const actions = step.channel === "gateway_http_control"
          ? GATEWAY_CONTROL_ACTIONS
          : step.channel === "bridge_jsonl_control"
            ? BRIDGE_CONTROL_ACTIONS
            : step.channel === "fixture_jsonl_control"
              ? FIXTURE_CONTROL_ACTIONS
              : HARNESS_ACTIONS;
        expect(actions).toContain(step.action as never);
      }
      const aliases = new Set(program.observations.map(({ alias }) => alias));
      for (const observation of program.observations) {
        expect(observation.sourceStepIds.length).toBeGreaterThan(0);
        expect(observation.sourceStepIds.every((stepId) => stepIds.includes(stepId))).toBe(true);
        expect(observation.requiredJsonPointers.length).toBeGreaterThan(0);
      }
      for (const probe of program.assertionProbes) {
        expect(probe.observationAliases.length).toBeGreaterThan(0);
        expect(probe.observationAliases.every((alias) => aliases.has(alias))).toBe(true);
      }
    }
  });

  it("validates typed outcomes, async execution metadata, barriers, and captures", () => {
    const template = CASE_CONTROL_OBSERVATION_MAP.values().next().value!.steps[0]!;
    const variants: CaseControlStep[] = [
      {
        ...template,
        expectedOutcome: { kind: "control_error", code: "planned_error", messageIncludes: "planned" },
        execution: { mode: "async_start", handle: "first.request" },
        captures: [{ name: "error.code", source: "control_error", jsonPointer: "/code" }],
      },
      {
        ...template,
        expectedOutcome: { kind: "http_status", status: 409 },
        execution: { mode: "async_join", handles: ["first.request"] },
        captures: [
          { name: "response.body", source: "http_body", jsonPointer: "" },
          { name: "retry.after", source: "http_header", header: "Retry-After" },
        ],
      },
      {
        ...template,
        expectedOutcome: { kind: "close", code: 1008, reasonIncludes: "policy" },
        execution: { mode: "barrier", handles: "all" },
        captures: [{ name: "close.code", source: "close", field: "code" }],
      },
    ];
    for (const step of variants) expect(() => assertValidCaseControlStepSemantics(step)).not.toThrow();
  });

  it("rejects incomplete or ambiguous execution semantics", () => {
    const template = CASE_CONTROL_OBSERVATION_MAP.values().next().value!.steps[0]!;
    expect(() => assertValidCaseControlStepSemantics({
      ...template,
      execution: { mode: "async_join", handles: [] },
    })).toThrow(/at least one handle/u);
    expect(() => assertValidCaseControlStepSemantics({
      ...template,
      captures: [
        { name: "same", source: "result", jsonPointer: "/one" },
        { name: "same", source: "result", jsonPointer: "/two" },
      ],
    })).toThrow(/unique/u);
    expect(() => assertValidCaseControlStepSemantics({
      ...template,
      expectedOutcome: { kind: "control_error", code: "planned_error" },
      captures: [{ name: "wrong.source", source: "result", jsonPointer: "" }],
    })).toThrow(/requires an expected success/u);
  });

  it("uses the exact action-specific T3/T4/T5 request-key surfaces for both bindings", () => {
    for (const program of CASE_CONTROL_OBSERVATION_MAP.values()) {
      for (const step of program.steps.filter(({ componentId }) => componentId !== null)) {
        const contract = CONTROL_KEYS[`${step.channel}:${step.action}`];
        expect(contract, `${program.caseId}/${step.stepId}`).toBeDefined();
        for (const binding of program.bindings) {
          const fields = {
            ...(step.arguments.common ?? {}),
            ...(step.arguments[binding] ?? {}),
          };
          const keys = Object.keys(fields);
          expect(contract!.required.every((key) => keys.includes(key)), `${step.stepId}/${binding} required keys`).toBe(true);
          expect(keys.every((key) => [...contract!.required, ...(contract!.optional ?? [])].includes(key)), `${step.stepId}/${binding} allowed keys`).toBe(true);
        }
      }
    }
  });

  it("runs C27 through bounded virtual time instead of wall-clock backoff waits", () => {
    const c27 = CASE_CONTROL_OBSERVATION_MAP.get("O1-C27")!;
    const attempts = c27.steps.find(({ stepId }) => stepId === "o1-c27.await-attempts")!;
    expect(attempts.arguments.common).toMatchObject({
      jsonPointer: "/reconnectConformance/attempts",
      operator: "count_equals",
      expected: 9,
      timeoutMs: 15_000,
    });
    expect(attempts.parentTimeoutMs).toBeGreaterThan(
      Number(attempts.arguments.common?.timeoutMs),
    );
    expect(c27.steps.find(({ stepId }) => stepId === "o1-c27.advance-before-reset"))
      .toMatchObject({
        action: "advance_reconnect_conformance_clock",
        arguments: { common: { advanceByMs: 119_999, heartbeatStepMs: 30_000 } },
      });
    expect(c27.steps.find(({ stepId }) => stepId === "o1-c27.advance-to-reset"))
      .toMatchObject({
        action: "advance_reconnect_conformance_clock",
        arguments: { common: { advanceByMs: 1, heartbeatStepMs: 1 } },
      });
  });

  it("makes the canonical C12 and C17 stalled flows executable instead of deadlocking sequentially", () => {
    const c12 = CASE_CONTROL_OBSERVATION_MAP.get("O1-C12")!;
    expect(c12.steps.find(({ stepId }) => stepId === "o1-c12.first")?.execution).toEqual({
      mode: "async_start",
      handle: "o1-c12.first",
    });
    expect(c12.steps.find(({ stepId }) => stepId === "o1-c12.same-rsid-second")?.execution).toEqual({
      mode: "async_start",
      handle: "o1-c12.same-rsid-second",
    });
    expect(c12.steps.find(({ stepId }) => stepId === "o1-c12.cross-rsid")?.execution).toEqual({
      mode: "async_start",
      handle: "o1-c12.cross-rsid",
    });
    expect(c12.steps.find(({ stepId }) => stepId === "o1-c12.release-first")?.execution).toEqual({
      mode: "async_join",
      handles: ["o1-c12.first", "o1-c12.same-rsid-second", "o1-c12.cross-rsid"],
    });

    const c17 = CASE_CONTROL_OBSERVATION_MAP.get("O1-C17")!;
    expect(c17.steps.find(({ stepId }) => stepId === "o1-c17.dispatch")?.execution).toEqual({
      mode: "async_start",
      handle: "o1-c17.dispatch",
    });
    expect(c17.steps.find(({ stepId }) =>
      stepId === "o1-c17.await-cancel-accepted")).toMatchObject({
        action: "await_condition",
        arguments: {
          common: {
            source: "bridge.snapshot_evidence",
            jsonPointer: "/invocations/0/abandoned",
            operator: "equals",
            expected: true,
            timeoutMs: 5_000,
          },
        },
      });
    expect(c17.steps.find(({ stepId }) => stepId === "o1-c17.release")?.execution).toEqual({
      mode: "async_join",
      handles: ["o1-c17.dispatch"],
    });
  });

  it("requires fixture execution evidence for every execution-count assertion", () => {
    for (const manifestCase of canonicalManifest.cases) {
      const program = CASE_CONTROL_OBSERVATION_MAP.get(manifestCase.id)!;
      const probes = new Map(program.assertionProbes.map((probe) => [probe.assertionId, probe]));
      for (const assertion of canonicalManifest.requiredAssertions[manifestCase.id]!) {
        if (assertion.category === "execution_count") {
          expect(probes.get(assertion.id)?.observationAliases).toContain("fixture.execution");
        }
      }
    }
  });

  it("meets every frozen component and observation-kind coverage contract", () => {
    for (const program of CASE_CONTROL_OBSERVATION_MAP.values()) {
      const observations = new Map(program.observations.map((observation) => [observation.alias, observation]));
      for (const probe of program.assertionProbes) {
        const binding = ASSERTION_EVIDENCE_BINDINGS.get(probe.assertionId)!;
        const selected = probe.observationAliases.map((alias) => observations.get(alias)!);
        const components = new Set(selected.map(({ componentId }) => componentId));
        const kinds = new Set(selected.map(({ kind }) => kind));
        expect(binding.requiredComponents.every((component) => components.has(component))).toBe(true);
        expect(binding.requiredKinds.every((kind) => kinds.has(kind))).toBe(true);
      }
    }
  });
});
