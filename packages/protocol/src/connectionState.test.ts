import { describe, expect, it } from "vitest";

import {
  createConnectionLifecycle,
  createSessionLifecycle,
  RBP_HEARTBEAT_DEGRADED_AFTER_MS,
  RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
  transitionConnection,
  transitionSession,
  type ConnectionEvent,
  type ConnectionLifecycleState,
  type SessionUnregister,
} from "./index.js";

function applyConnection(
  state: ConnectionLifecycleState,
  event: ConnectionEvent,
): ConnectionLifecycleState {
  const result = transitionConnection(state, event);
  if (result.kind !== "transitioned") {
    throw new Error(`invalid ${event.type} from ${state.phase}`);
  }
  return result.state;
}

function openSteady(): ConnectionLifecycleState {
  let state = createConnectionLifecycle();
  state = applyConnection(state, { type: "start" });
  state = applyConnection(state, { type: "transport_opened" });
  state = applyConnection(state, { type: "authentication_accepted" });
  return applyConnection(state, {
    type: "hello_accepted",
    selectedProtocol: 1,
    grantedCapabilities: ["journal_v1", "chunked_results", "journal_v1"],
  });
}

describe("connection and session lifecycle FSM", () => {
  it("requires transport authentication and hello/version negotiation before steady", () => {
    const steady = openSteady();
    expect(steady).toMatchObject({
      phase: "steady",
      selectedProtocol: 1,
      grantedCapabilities: ["chunked_results", "journal_v1"],
    });
    expect(transitionConnection(createConnectionLifecycle(), { type: "authentication_accepted" })).toMatchObject({
      kind: "invalid_transition",
    });
  });

  it("applies canonical heartbeat degraded and disconnected thresholds", () => {
    const steady = openSteady();
    expect(
      transitionConnection(steady, {
        type: "heartbeat_silence",
        silenceMs: RBP_HEARTBEAT_DEGRADED_AFTER_MS - 1,
      }),
    ).toMatchObject({ state: { phase: "steady" } });
    expect(
      transitionConnection(steady, {
        type: "heartbeat_silence",
        silenceMs: RBP_HEARTBEAT_DEGRADED_AFTER_MS,
      }),
    ).toMatchObject({ state: { phase: "degraded" } });
    expect(
      transitionConnection(steady, {
        type: "heartbeat_silence",
        silenceMs: RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
      }),
    ).toMatchObject({
      state: {
        phase: "backoff",
        nextAttemptIndex: 1,
        lastRetryDecision: { action: "backoff", waitAttemptIndex: 0, jitterLimitMs: 1_000 },
      },
    });
  });

  it("consumes zero-based retry attempts and resets only after 120 seconds continuously steady", () => {
    let state = openSteady();
    state = applyConnection(state, {
      type: "connection_failed",
      failure: "environment",
      continuousSteadyMs: 119_999,
    });
    expect(state.lastRetryDecision).toMatchObject({
      waitAttemptIndex: 0,
      jitterLimitMs: 1_000,
      resetApplied: false,
    });
    state = applyConnection(state, { type: "retry_timer_elapsed" });
    state = applyConnection(state, {
      type: "connection_failed",
      failure: "protocol",
      continuousSteadyMs: 0,
    });
    expect(state.lastRetryDecision).toMatchObject({ waitAttemptIndex: 1, jitterLimitMs: 2_000 });

    state = applyConnection(state, { type: "retry_timer_elapsed" });
    state = applyConnection(state, {
      type: "connection_failed",
      failure: "environment",
      continuousSteadyMs: 120_000,
      retryAfterMs: 30_000,
    });
    expect(state.lastRetryDecision).toMatchObject({
      waitAttemptIndex: 0,
      jitterLimitMs: 1_000,
      retryAfterFloorMs: 30_000,
      resetApplied: true,
    });
  });

  it.each([
    ["auth", "auth"],
    ["version", "version_update"],
    ["trust", "trust"],
  ] as const)("pauses unchanged retries for %s refusal", (failure, pauseReason) => {
    const result = transitionConnection(openSteady(), { type: "connection_failed", failure });
    expect(result).toMatchObject({
      kind: "transitioned",
      state: { phase: "retry_paused", retryPauseReason: pauseReason },
    });
    if (result.kind === "transitioned") {
      expect(result.state.nextAttemptIndex).toBe(0);
      expect(transitionConnection(result.state, { type: "retry_condition_changed" })).toMatchObject({
        state: { phase: "idle", retryPauseReason: null },
      });
    }
  });

  it("preserves a consumed retry index through auth/version/TLS pause and service restart", () => {
    let state = openSteady();
    state = applyConnection(state, {
      type: "connection_failed",
      failure: "environment",
      continuousSteadyMs: 0,
    });
    state = applyConnection(state, { type: "retry_timer_elapsed" });
    const paused = applyConnection(state, { type: "connection_failed", failure: "trust" });
    expect(paused).toMatchObject({ phase: "retry_paused", nextAttemptIndex: 1 });

    state = applyConnection(paused, { type: "retry_condition_changed" });
    state = applyConnection(state, { type: "start" });
    state = applyConnection(state, { type: "transport_opened" });
    state = applyConnection(state, { type: "authentication_accepted" });
    state = applyConnection(state, {
      type: "hello_accepted",
      selectedProtocol: 1,
      grantedCapabilities: [],
    });
    state = applyConnection(state, { type: "shutdown_requested" });
    state = applyConnection(state, { type: "service_started" });
    expect(state).toMatchObject({ phase: "idle", nextAttemptIndex: 1 });
    expect(applyConnection(state, { type: "start" })).toMatchObject({
      phase: "connecting",
      nextAttemptIndex: 1,
    });
  });

  it("supports resume, re-enrollment, and explicit shutdown without erasing retry state", () => {
    let connection = openSteady();
    connection = applyConnection(connection, { type: "begin_resume" });
    connection = applyConnection(connection, { type: "begin_re_enrollment" });
    connection = applyConnection(connection, { type: "re_enrollment_complete" });
    expect(connection.phase).toBe("steady");
    connection = applyConnection(connection, { type: "goodbye", reason: "shutdown" });
    expect(connection).toMatchObject({ phase: "shutdown", lastRetryDecision: { action: "stop" } });
    expect(applyConnection(connection, { type: "service_started" })).toMatchObject({
      phase: "idle",
      nextAttemptIndex: 0,
    });
  });

  it("registers, resumes, and re-enrolls a session", () => {
    let session = createSessionLifecycle("port:8080:pid:1234");
    let transition = transitionSession(session, { type: "register_requested" });
    expect(transition.kind).toBe("transitioned");
    if (transition.kind !== "transitioned") return;
    session = transition.state;
    transition = transitionSession(session, { type: "registered", rsid: "rs-a" });
    if (transition.kind !== "transitioned") throw new Error("registration failed");
    session = transition.state;
    expect(session).toMatchObject({ dispatchAllowed: true, resumeAllowed: true });
    transition = transitionSession(session, { type: "connection_lost" });
    if (transition.kind !== "transitioned") throw new Error("disconnect failed");
    transition = transitionSession(transition.state, { type: "resume_requested" });
    if (transition.kind !== "transitioned") throw new Error("resume start failed");
    transition = transitionSession(transition.state, { type: "resume_rejected" });
    expect(transition).toMatchObject({ state: { phase: "re_enrolling", rsid: null } });
    if (transition.kind !== "transitioned") return;
    expect(transitionSession(transition.state, { type: "re_enrolled", rsid: "rs-b" })).toMatchObject({
      state: { phase: "registered", rsid: "rs-b", dispatchAllowed: true },
    });
  });

  it.each<SessionUnregister["reason"]>([
    "revit_exited",
    "bridge_shutdown",
    "session_replaced",
    "operator_requested",
  ])("revokes resume and dispatch for session_unregister reason %s", (reason) => {
    const session = createSessionLifecycle("local");
    const registering = transitionSession(session, { type: "register_requested" });
    if (registering.kind !== "transitioned") throw new Error("registration did not start");
    const registered = transitionSession(registering.state, { type: "registered", rsid: "rs-a" });
    if (registered.kind !== "transitioned") throw new Error("registration did not finish");
    const result = transitionSession(registered.state, { type: "unregister", reason });
    expect(result).toMatchObject({
      state: {
        phase: "unregistered",
        resumeAllowed: false,
        dispatchAllowed: false,
        unregisterReason: reason,
      },
    });
  });
});
