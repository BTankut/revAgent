import { describe, expect, it } from "vitest";

import type { CaseControlStep } from "../src/casePrograms.js";
import {
  ParentStepOutcomeError,
  createHarnessStepDriverWithRawBindingHooks,
  executeParentSteps,
  observationsForRequirement,
  type ParentStepDriver,
  type ParentStepAbortContext,
  type ParentStepDriverRequest,
  type ParentStepDrivers,
  type RawStepOutcome,
} from "../src/parentStepEngine.js";
import type { Binding, ProcessObservationRecord } from "../src/types.js";

const runId = "run-step-engine";
const caseId = "O1-C01";
const at = "2026-07-23T00:00:00.000Z";

function fixtureStep(
  stepId: string,
  action: "snapshot_evidence" | "release_stall" = "snapshot_evidence",
  argumentsValue: Readonly<Record<string, unknown>> = {},
): CaseControlStep {
  return {
    stepId,
    phase: "stimulus",
    channel: "fixture_jsonl_control",
    componentId: "addin_loopback_fixture",
    action,
    arguments: { common: argumentsValue },
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs: 30_000,
  };
}

function harnessStep(stepId: string): CaseControlStep {
  return {
    stepId,
    phase: "stimulus",
    channel: "parent_harness",
    componentId: null,
    action: "send_binding_frame",
    arguments: { common: { frame: "{{frame}}" } },
    expectedOutcome: { kind: "success" },
    execution: { mode: "sequential" },
    captures: [],
    parentTimeoutMs: 30_000,
  };
}

function driverSet(
  driver: ParentStepDriver,
  abortAndDrain: (context: ParentStepAbortContext) => Promise<void> = async () => undefined,
): ParentStepDrivers {
  return {
    gateway_http_control: driver,
    bridge_jsonl_control: driver,
    fixture_jsonl_control: driver,
    parent_harness: driver,
    abortAndDrain,
  };
}

function rawWireObservation(
  request: ParentStepDriverRequest,
  suffix: string,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${request.binding}-${suffix}`,
    runId: request.runId,
    caseId: request.caseId,
    binding: request.binding,
    componentId: "gateway_stub",
    kind: "wire_event",
    at,
    payload: {
      direction: "parent_to_gateway",
      binding: request.binding,
      serialized: "{}",
      frame: {},
      atMonotonicMs: 1,
    },
  };
}

describe("parent-owned generic step engine", () => {
  it("substitutes typed values, captures JSON pointers, and emits strict raw control evidence", async () => {
    const seen: ParentStepDriverRequest[] = [];
    const first = {
      ...fixtureStep("capture-session"),
      captures: [{ name: "session.rsid", source: "result", jsonPointer: "/session/rsid" }] as const,
    } satisfies CaseControlStep;
    const second = fixtureStep("use-session", "release_stall", {
      requestId: "{{session.rsid}}",
      retry: "{{seed.retry}}",
      label: "resume={{session.rsid}}",
    });
    const driver: ParentStepDriver = async (request) => {
      seen.push(structuredClone(request));
      return request.stepId === "capture-session"
        ? { kind: "success", result: { session: { rsid: "rsid-1" } } }
        : { kind: "success", result: { released: true } };
    };

    const evidence = await executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [first, second],
      drivers: driverSet(driver),
      variables: { seed: { retry: 2 } },
      now: () => at,
    });

    expect(seen[1]!.arguments).toEqual({
      requestId: "rsid-1",
      retry: 2,
      label: "resume=rsid-1",
    });
    expect(evidence.captures).toEqual({ "session.rsid": "rsid-1" });
    expect(evidence.completedStepIds).toEqual(["capture-session", "use-session"]);
    expect(evidence.observations).toHaveLength(2);
    expect(evidence.observations[0]).toMatchObject({
      schemaVersion: "rbp-process-observation/v2",
      componentId: "addin_loopback_fixture",
      kind: "control_result",
      payload: {
        schemaVersion: "rbp-step-control-observation/v1",
        stepId: "capture-session",
        requestBytes: expect.any(Number),
        responseBytes: expect.any(Number),
      },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/"(?:actual|passed)"\s*:/u);
  });

  it("matches expected control errors in the parent and keeps later steps executable", async () => {
    const planned = {
      ...fixtureStep("planned-error"),
      expectedOutcome: {
        kind: "control_error",
        code: "planned_error",
        messageIncludes: "planned",
      },
      captures: [{ name: "planned.code", source: "control_error", jsonPointer: "/code" }],
    } satisfies CaseControlStep;
    const after = fixtureStep("after-error", "release_stall", {
      requestId: "{{planned.code}}",
    });
    const seen: ParentStepDriverRequest[] = [];
    const driver: ParentStepDriver = async (request) => {
      seen.push(structuredClone(request));
      return request.stepId === "planned-error"
        ? { kind: "control_error", code: "planned_error", message: "planned fixture failure" }
        : { kind: "success", result: { recovered: true } };
    };
    const evidence = await executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [planned, after],
      drivers: driverSet(driver),
      now: () => at,
    });
    expect(seen[1]!.arguments).toEqual({ requestId: "planned_error" });
    expect(evidence.captures).toEqual({ "planned.code": "planned_error" });
    expect(evidence.completedStepIds).toEqual(["planned-error", "after-error"]);

    let mismatchDrainCalls = 0;
    await expect(executeParentSteps({
      runId: "run-outcome-mismatch",
      caseId,
      binding: "wss",
      steps: [planned],
      drivers: driverSet(
        async () => ({ kind: "success", result: {} }),
        async ({ activeRequests }) => {
          mismatchDrainCalls += 1;
          expect(activeRequests).toEqual([]);
        },
      ),
      now: () => at,
    })).rejects.toBeInstanceOf(ParentStepOutcomeError);
    expect(mismatchDrainCalls).toBe(1);
  });

  it("starts a release concurrently, joins in declared order, and makes barrier captures deterministic", async () => {
    let releaseStalled: ((outcome: RawStepOutcome) => void) | undefined;
    const dispatchOrder: string[] = [];
    const dispatchModes: Array<[string, ParentStepDriverRequest["dispatchMode"]]> = [];
    const driver: ParentStepDriver = async (request) => {
      dispatchOrder.push(request.stepId);
      dispatchModes.push([request.stepId, request.dispatchMode]);
      if (request.stepId === "stalled") {
        return await new Promise<RawStepOutcome>((resolve) => {
          releaseStalled = resolve;
        });
      }
      if (request.stepId === "release") {
        releaseStalled?.({ kind: "success", result: { value: "stalled-result" } });
        return { kind: "success", result: { value: "release-result" } };
      }
      expect(request.arguments).toEqual({ requestId: "stalled-result" });
      return { kind: "success", result: { value: "barrier-result" } };
    };
    const stalled = {
      ...fixtureStep("stalled"),
      execution: { mode: "async_start", handle: "stall.handle" },
      captures: [{ name: "stall.value", source: "result", jsonPointer: "/value" }],
    } satisfies CaseControlStep;
    const release = {
      ...fixtureStep("release", "release_stall"),
      execution: { mode: "async_join", handles: ["stall.handle"] },
      captures: [{ name: "release.value", source: "result", jsonPointer: "/value" }],
    } satisfies CaseControlStep;
    const immediate = {
      ...fixtureStep("immediate"),
      execution: { mode: "async_start", handle: "immediate.handle" },
      captures: [{ name: "immediate.value", source: "result", jsonPointer: "/value" }],
    } satisfies CaseControlStep;
    const barrier = {
      ...fixtureStep("barrier", "release_stall", { requestId: "{{immediate.value}}" }),
      execution: { mode: "barrier", handles: "all" },
    } satisfies CaseControlStep;

    const evidence = await executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [stalled, release, immediate, barrier],
      drivers: driverSet(async (request) => {
        if (request.stepId === "immediate") {
          dispatchOrder.push(request.stepId);
          dispatchModes.push([request.stepId, request.dispatchMode]);
          return { kind: "success", result: { value: "stalled-result" } };
        }
        return await driver(request);
      }),
      now: () => at,
    });
    expect(dispatchOrder).toEqual(["stalled", "release", "immediate", "barrier"]);
    expect(dispatchModes).toEqual([
      ["stalled", "concurrent"],
      ["release", "concurrent"],
      ["immediate", "concurrent"],
      ["barrier", "sequential"],
    ]);
    expect(evidence.completedStepIds).toEqual(["stalled", "release", "immediate", "barrier"]);
    expect(evidence.captures).toEqual({
      "stall.value": "stalled-result",
      "release.value": "release-result",
      "immediate.value": "stalled-result",
    });
    expect(evidence.observations.map(({ payload }) =>
      (payload as { stepId: string }).stepId)).toEqual(["stalled", "release", "immediate", "barrier"]);
  });

  it("fails closed on unjoined handles, unresolved substitutions, and malformed outcome envelopes", async () => {
    let driverCalls = 0;
    const pending = {
      ...fixtureStep("pending"),
      execution: { mode: "async_start", handle: "pending.handle" },
    } satisfies CaseControlStep;
    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [pending],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => at,
    })).rejects.toThrow(/unjoined async handles/u);
    expect(driverCalls).toBe(0);

    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [fixtureStep("unresolved", "release_stall", { requestId: "{{missing.value}}" })],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => at,
    })).rejects.toThrow(/unresolved substitution/u);
    expect(driverCalls).toBe(0);

    const opaqueResult = await executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [fixtureStep("opaque-result")],
      drivers: driverSet(async () => ({
        kind: "success",
        result: { passed: true, actual: "legitimate tool payload" },
      })),
      now: () => at,
    });
    expect(opaqueResult.observations[0]!.payload).toMatchObject({
      response: {
        result: { passed: true, actual: "legitimate tool payload" },
      },
    });

    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [fixtureStep("unknown-outcome-field")],
      drivers: driverSet(async () => ({
        kind: "success",
        result: {},
        verdict: true,
      } as unknown as RawStepOutcome)),
      now: () => at,
    })).rejects.toThrow(/unknown or missing fields/u);
  });

  it("preflights the complete plan before any driver side effect", async () => {
    let driverCalls = 0;
    const duplicateCapture = [
      {
        ...fixtureStep("first"),
        captures: [{ name: "same.capture", source: "result", jsonPointer: "" }],
      },
      {
        ...fixtureStep("second"),
        captures: [{ name: "same.capture", source: "result", jsonPointer: "" }],
      },
    ] satisfies CaseControlStep[];
    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: duplicateCapture,
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => at,
    })).rejects.toThrow(/declared more than once/u);
    expect(driverCalls).toBe(0);

    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [fixtureStep("duplicate"), fixtureStep("duplicate")],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => at,
    })).rejects.toThrow(/duplicate step id/u);
    expect(driverCalls).toBe(0);
  });

  it("snapshots the plan and variables and never dispatches a pre-aborted mutation", async () => {
    const externalSteps = [
      fixtureStep("first"),
      fixtureStep("second", "release_stall", { requestId: "{{seed.requestId}}" }),
    ];
    const externalVariables = { seed: { requestId: "original" } };
    const seen: string[] = [];
    const execution = executeParentSteps({
      runId: "run-snapshot",
      caseId,
      binding: "wss",
      steps: externalSteps,
      drivers: driverSet(async (request) => {
        seen.push(String(request.arguments.requestId ?? request.stepId));
        return { kind: "success", result: {} };
      }),
      variables: externalVariables,
      now: () => at,
    });
    externalSteps[1]!.arguments = { common: { requestId: "mutated-plan" } };
    externalVariables.seed.requestId = "mutated-variable";
    await expect(execution).resolves.toMatchObject({
      completedStepIds: ["first", "second"],
    });
    expect(seen).toEqual(["first", "original"]);

    const controller = new AbortController();
    controller.abort(new Error("operator cancelled before dispatch"));
    let driverCalls = 0;
    await expect(executeParentSteps({
      runId: "run-pre-aborted",
      caseId,
      binding: "wss",
      steps: [fixtureStep("must-not-dispatch")],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      signal: controller.signal,
      now: () => at,
    })).rejects.toThrow(/operator cancelled before dispatch/u);
    expect(driverCalls).toBe(0);
  });

  it("bounds never-settling drivers with a real AbortSignal and rejects spoofed component provenance", async () => {
    let driverSignal: AbortSignal | undefined;
    let delayedSideEffect = false;
    let delayedTimer: NodeJS.Timeout | undefined;
    let drainCalls = 0;
    await expect(executeParentSteps({
      runId: "run-timeout",
      caseId,
      binding: "wss",
      steps: [{ ...fixtureStep("never-settles"), parentTimeoutMs: 20 }],
      drivers: driverSet(
        async (request) => {
          driverSignal = request.signal;
          delayedTimer = setTimeout(() => {
            delayedSideEffect = true;
          }, 40);
          return await new Promise<RawStepOutcome>(() => undefined);
        },
        async ({ activeRequests }) => {
          drainCalls += 1;
          expect(activeRequests.map(({ stepId }) => stepId)).toEqual(["never-settles"]);
          if (delayedTimer !== undefined) clearTimeout(delayedTimer);
        },
      ),
      now: () => at,
    })).rejects.toThrow(/exceeded the parent-owned 20 ms deadline/u);
    expect(driverSignal).toBeInstanceOf(AbortSignal);
    expect(driverSignal?.aborted).toBe(true);
    expect(drainCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delayedSideEffect).toBe(false);

    await expect(executeParentSteps({
      runId: "run-provenance",
      caseId,
      binding: "wss",
      steps: [fixtureStep("fixture-spoof")],
      drivers: driverSet(async (request) => ({
        kind: "success",
        result: {},
        observations: [rawWireObservation(request, "spoofed-gateway")],
      })),
      now: () => at,
    })).rejects.toThrow(/outside fixture_jsonl_control provenance/u);

    const awaitStep = {
      ...harnessStep("await-spoof"),
      action: "await_condition",
      arguments: { common: {} },
    } as CaseControlStep;
    await expect(executeParentSteps({
      runId: "run-pair-provenance",
      caseId,
      binding: "wss",
      steps: [awaitStep],
      drivers: driverSet(async (request) => ({
        kind: "success",
        result: {},
        observations: [{
          ...rawWireObservation(request, "cross-pair"),
          kind: "fixture_snapshot",
          payload: {},
        }],
      })),
      now: () => at,
    })).rejects.toThrow(/outside parent-harness action provenance/u);
  });

  it("bounds a stuck abort-and-drain path and preserves both failures", async () => {
    let failure: unknown;
    try {
      await executeParentSteps({
        runId: "run-stuck-drain",
        caseId,
        binding: "wss",
        steps: [{ ...fixtureStep("stuck-driver"), parentTimeoutMs: 10 }],
        drivers: driverSet(
          async () => await new Promise<RawStepOutcome>(() => undefined),
          async () => await new Promise<void>(() => undefined),
        ),
        drainTimeoutMs: 15,
        now: () => at,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/stuck-driver.*10 ms deadline/u) }),
      expect.objectContaining({ message: expect.stringMatching(/abort-and-drain exceeded 15 ms/u) }),
    ]);
  });

  it("rejects coerced observation identities and non-plain JSON values", async () => {
    let driverCalls = 0;
    await expect(executeParentSteps({
      runId: 7 as unknown as string,
      caseId,
      binding: "wss",
      steps: [fixtureStep("bad-run-id")],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => at,
    })).rejects.toThrow(/run\/case identity is invalid/u);
    await expect(executeParentSteps({
      runId,
      caseId,
      binding: "wss",
      steps: [fixtureStep("bad-clock")],
      drivers: driverSet(async () => {
        driverCalls += 1;
        return { kind: "success", result: {} };
      }),
      now: () => 0 as unknown as string,
    })).rejects.toThrow(/RFC 3339/u);
    expect(driverCalls).toBe(0);

    await expect(executeParentSteps({
      runId: "run-bad-observation-id",
      caseId,
      binding: "wss",
      steps: [harnessStep("bad-observation-id")],
      drivers: driverSet(async (request) => ({
        kind: "success",
        result: {},
        observations: [{
          ...rawWireObservation(request, "numeric-id"),
          observationId: 7,
          at: 0,
        } as unknown as ProcessObservationRecord],
      })),
      variables: { frame: {} },
      now: () => at,
    })).rejects.toThrow(/identity fields have invalid types/u);

    await expect(executeParentSteps({
      runId: "run-non-plain-result",
      caseId,
      binding: "wss",
      steps: [fixtureStep("non-plain-result")],
      drivers: driverSet(async () => ({
        kind: "success",
        result: new Date(at),
      } as unknown as RawStepOutcome)),
      now: () => at,
    })).rejects.toThrow(/not a JSON value/u);
  });

  it("allows the canonical C16 raw hook to carry a real over-4-MiB params vector", async () => {
    const overLimitFrame = "x".repeat(4 * 1024 * 1024 + 1);
    let observedBytes = 0;
    const step = harnessStep("o1-c16.params-oversize");
    const evidence = await executeParentSteps({
      runId: "run-c16-over-limit",
      caseId: "O1-C16",
      binding: "wss",
      steps: [step],
      drivers: driverSet(createHarnessStepDriverWithRawBindingHooks(
        async () => {
          throw new Error("raw hook was bypassed");
        },
        {
          wss: async (request) => {
            observedBytes = String(request.arguments.frame).length;
            return { kind: "success", result: { sentBytes: observedBytes } };
          },
        },
      )),
      variables: { frame: overLimitFrame },
      now: () => at,
    });
    expect(observedBytes).toBe(overLimitFrame.length);
    expect(evidence.completedStepIds).toEqual(["o1-c16.params-oversize"]);
  });

  it.each(["wss", "streamable_http_sse"] as const)(
    "keeps a canonical negative %s peer terminal in raw wire evidence, not the step outcome",
    async (binding) => {
      const step = harnessStep("o1-c25.cross-device-resume");
      const evidence = await executeParentSteps({
        runId: `run-negative-normalization-${binding}`,
        caseId: "O1-C25",
        binding,
        steps: [step],
        drivers: driverSet(createHarnessStepDriverWithRawBindingHooks(
          async () => {
            throw new Error("raw hook was bypassed");
          },
          {
            [binding]: async (request) => {
              const observation = rawWireObservation(request, "negative-terminal");
              observation.payload = {
                ...(observation.payload as Record<string, unknown>),
                remoteTerminal: binding === "wss"
                  ? { kind: "close", code: 4403, reason: "authorization refused" }
                  : { kind: "http_response", status: 403 },
              };
              return {
                kind: "success",
                result: { injected: true, captureComplete: true },
                observations: [observation],
              };
            },
          },
        )),
        variables: { frame: { type: "session_resume", invalidCredential: true } },
        now: () => at,
      });
      expect(evidence.completedStepIds).toEqual(["o1-c25.cross-device-resume"]);
      expect(evidence.observations[0]!.payload).toMatchObject({
        remoteTerminal: binding === "wss"
          ? { kind: "close", code: 4403 }
          : { kind: "http_response", status: 403 },
      });
    },
  );

  it.each([
    {
      binding: "wss" as const,
      expectedOutcome: { kind: "close", code: 1008, reasonIncludes: "policy" } as const,
      capture: { name: "raw.close", source: "close", field: "code" } as const,
      expectedCapture: 1008,
    },
    {
      binding: "streamable_http_sse" as const,
      expectedOutcome: { kind: "http_status", status: 429 } as const,
      capture: { name: "raw.retry", source: "http_header", header: "Retry-After" } as const,
      expectedCapture: "2",
    },
  ])("routes raw $binding frames through the binding hook without accepting hook verdicts", async ({
    binding,
    expectedOutcome,
    capture,
    expectedCapture,
  }) => {
    const hookCalls: Binding[] = [];
    const hook: ParentStepDriver = async (request) => {
      hookCalls.push(request.binding);
      const observations = [rawWireObservation(request, "raw-frame")];
      return request.binding === "wss"
        ? { kind: "close", code: 1008, reason: "policy rejection", observations }
        : {
            kind: "http_response",
            status: 429,
            headers: { "Retry-After": "2" },
            body: { error: "rate_limited" },
            observations,
          };
    };
    const fallback: ParentStepDriver = async () => {
      throw new Error("raw binding hook was bypassed");
    };
    const rawStep = {
      ...harnessStep("raw-frame"),
      expectedOutcome,
      captures: [capture],
    } as CaseControlStep;
    const evidence = await executeParentSteps({
      runId: `run-raw-${binding}`,
      caseId,
      binding,
      steps: [rawStep],
      drivers: driverSet(createHarnessStepDriverWithRawBindingHooks(fallback, {
        wss: hook,
        streamable_http_sse: hook,
      })),
      variables: { frame: { type: "probe" } },
      now: () => at,
    });
    expect(hookCalls).toEqual([binding]);
    expect(evidence.captures).toEqual({
      [capture.name]: expectedCapture,
    });
    expect(evidence.observations).toEqual([
      expect.objectContaining({
        binding,
        componentId: "gateway_stub",
        kind: "wire_event",
      }),
    ]);
    expect(evidence.stepObservations).toEqual([{
      stepId: "raw-frame",
      observationIds: [`${binding}-raw-frame`],
    }]);
    expect(observationsForRequirement(evidence, {
      alias: "raw.correct",
      componentId: "gateway_stub",
      kind: "wire_event",
      sourceStepIds: ["raw-frame"],
      requiredJsonPointers: ["/direction", "/binding"],
    })).toHaveLength(1);
    expect(observationsForRequirement(evidence, {
      alias: "raw.wrong-step",
      componentId: "gateway_stub",
      kind: "wire_event",
      sourceStepIds: ["some-other-step"],
      requiredJsonPointers: ["/direction", "/binding"],
    })).toEqual([]);
  });
});
