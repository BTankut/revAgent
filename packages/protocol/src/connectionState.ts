import {
  RBP_RECONNECT_RESET_AFTER_STEADY_MS,
  reconnectBackoffLimitMs,
} from "./reconnectBackoff.js";
import type { SessionUnregister } from "./generated/envelope.js";

export const RBP_HEARTBEAT_DEGRADED_AFTER_MS = 35_000 as const;
export const RBP_HEARTBEAT_DISCONNECTED_AFTER_MS = 65_000 as const;

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  | "hello_exchange"
  | "steady"
  | "degraded"
  | "resuming"
  | "re_enrolling"
  | "backoff"
  | "disconnected"
  | "retry_paused"
  | "shutdown";

export type RetryPauseReason = "auth" | "version_update" | "trust" | "auth_revoked";

export interface RetryDecision {
  readonly action: "backoff" | "pause" | "stop";
  readonly waitAttemptIndex: number | null;
  readonly jitterLimitMs: number | null;
  readonly retryAfterFloorMs: number;
  readonly resetApplied: boolean;
  readonly pauseReason: RetryPauseReason | null;
}

export interface ConnectionLifecycleState {
  readonly phase: ConnectionPhase;
  /** Zero-based index to use for the next automatic retry wait. */
  readonly nextAttemptIndex: number;
  readonly selectedProtocol: number | null;
  readonly grantedCapabilities: readonly string[];
  readonly retryPauseReason: RetryPauseReason | null;
  readonly lastRetryDecision: RetryDecision | null;
}

export type OpeningFailureClass = "environment" | "protocol" | "auth" | "version" | "trust";

export type ConnectionEvent =
  | { readonly type: "start" }
  | { readonly type: "transport_opened" }
  | { readonly type: "authentication_accepted" }
  | {
      readonly type: "hello_accepted";
      readonly selectedProtocol: number;
      readonly grantedCapabilities: readonly string[];
    }
  | { readonly type: "begin_resume" }
  | { readonly type: "resume_complete" }
  | { readonly type: "begin_re_enrollment" }
  | { readonly type: "re_enrollment_complete" }
  | {
      readonly type: "heartbeat_silence";
      readonly silenceMs: number;
      readonly continuousSteadyMs?: number;
    }
  | {
      readonly type: "connection_failed";
      readonly failure: OpeningFailureClass;
      readonly continuousSteadyMs?: number;
      readonly retryAfterMs?: number;
    }
  | { readonly type: "retry_timer_elapsed" }
  | { readonly type: "retry_condition_changed" }
  | {
      readonly type: "goodbye";
      readonly reason: "shutdown" | "update" | "server_draining" | "protocol_error" | "auth_revoked";
      readonly retryAfterMs?: number;
      readonly continuousSteadyMs?: number;
    }
  | { readonly type: "shutdown_requested" }
  | { readonly type: "service_started" };

export type ConnectionTransition =
  | { readonly kind: "transitioned"; readonly state: ConnectionLifecycleState }
  | {
      readonly kind: "invalid_transition";
      readonly state: ConnectionLifecycleState;
      readonly event: ConnectionEvent["type"];
    };

export type SessionPhase =
  | "discovered"
  | "registering"
  | "registered"
  | "disconnected"
  | "resuming"
  | "re_enrolling"
  | "unregistered";

export interface SessionLifecycleState {
  readonly localSessionKey: string;
  readonly rsid: string | null;
  readonly phase: SessionPhase;
  readonly resumeAllowed: boolean;
  readonly dispatchAllowed: boolean;
  readonly unregisterReason: SessionUnregister["reason"] | null;
}

export type SessionEvent =
  | { readonly type: "register_requested" }
  | { readonly type: "registered"; readonly rsid: string }
  | { readonly type: "connection_lost" }
  | { readonly type: "resume_requested" }
  | { readonly type: "resumed" }
  | { readonly type: "resume_rejected" }
  | { readonly type: "re_enrolled"; readonly rsid: string }
  | { readonly type: "unregister"; readonly reason: SessionUnregister["reason"] };

export type SessionTransition =
  | { readonly kind: "transitioned"; readonly state: SessionLifecycleState }
  | {
      readonly kind: "invalid_transition";
      readonly state: SessionLifecycleState;
      readonly event: SessionEvent["type"];
    };

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function invalidConnection(
  state: ConnectionLifecycleState,
  event: ConnectionEvent,
): ConnectionTransition {
  return { kind: "invalid_transition", state, event: event.type };
}

function scheduleBackoff(
  state: ConnectionLifecycleState,
  continuousSteadyMs = 0,
  retryAfterMs = 0,
): ConnectionLifecycleState {
  if (!isNonNegativeFinite(continuousSteadyMs) || !isNonNegativeFinite(retryAfterMs)) {
    throw new RangeError("retry timing inputs must be non-negative finite numbers");
  }
  const resetApplied = continuousSteadyMs >= RBP_RECONNECT_RESET_AFTER_STEADY_MS;
  const waitAttemptIndex = resetApplied ? 0 : state.nextAttemptIndex;
  const decision: RetryDecision = {
    action: "backoff",
    waitAttemptIndex,
    jitterLimitMs: reconnectBackoffLimitMs(waitAttemptIndex),
    retryAfterFloorMs: retryAfterMs,
    resetApplied,
    pauseReason: null,
  };
  return {
    ...state,
    phase: "backoff",
    nextAttemptIndex: Math.min(waitAttemptIndex + 1, Number.MAX_SAFE_INTEGER),
    retryPauseReason: null,
    lastRetryDecision: decision,
  };
}

function pauseRetry(
  state: ConnectionLifecycleState,
  pauseReason: RetryPauseReason,
): ConnectionLifecycleState {
  return {
    ...state,
    phase: "retry_paused",
    retryPauseReason: pauseReason,
    lastRetryDecision: {
      action: "pause",
      waitAttemptIndex: null,
      jitterLimitMs: null,
      retryAfterFloorMs: 0,
      resetApplied: false,
      pauseReason,
    },
  };
}

export function createConnectionLifecycle(): ConnectionLifecycleState {
  return {
    phase: "idle",
    nextAttemptIndex: 0,
    selectedProtocol: null,
    grantedCapabilities: [],
    retryPauseReason: null,
    lastRetryDecision: null,
  };
}

export function transitionConnection(
  state: ConnectionLifecycleState,
  event: ConnectionEvent,
): ConnectionTransition {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "disconnected"
        ? { kind: "transitioned", state: { ...state, phase: "connecting" } }
        : invalidConnection(state, event);
    case "transport_opened":
      return state.phase === "connecting"
        ? { kind: "transitioned", state: { ...state, phase: "authenticating" } }
        : invalidConnection(state, event);
    case "authentication_accepted":
      return state.phase === "authenticating"
        ? { kind: "transitioned", state: { ...state, phase: "hello_exchange" } }
        : invalidConnection(state, event);
    case "hello_accepted": {
      if (
        state.phase !== "hello_exchange" ||
        !Number.isSafeInteger(event.selectedProtocol) ||
        event.selectedProtocol < 1
      ) {
        return invalidConnection(state, event);
      }
      const capabilities = [...new Set(event.grantedCapabilities)].sort();
      return {
        kind: "transitioned",
        state: {
          ...state,
          phase: "steady",
          selectedProtocol: event.selectedProtocol,
          grantedCapabilities: capabilities,
          retryPauseReason: null,
        },
      };
    }
    case "begin_resume":
      return state.phase === "steady" || state.phase === "degraded"
        ? { kind: "transitioned", state: { ...state, phase: "resuming" } }
        : invalidConnection(state, event);
    case "resume_complete":
      return state.phase === "resuming"
        ? { kind: "transitioned", state: { ...state, phase: "steady" } }
        : invalidConnection(state, event);
    case "begin_re_enrollment":
      return state.phase === "resuming" || state.phase === "steady" || state.phase === "degraded"
        ? { kind: "transitioned", state: { ...state, phase: "re_enrolling" } }
        : invalidConnection(state, event);
    case "re_enrollment_complete":
      return state.phase === "re_enrolling"
        ? { kind: "transitioned", state: { ...state, phase: "steady" } }
        : invalidConnection(state, event);
    case "heartbeat_silence": {
      if (
        (state.phase !== "steady" && state.phase !== "degraded") ||
        !isNonNegativeFinite(event.silenceMs)
      ) {
        return invalidConnection(state, event);
      }
      if (event.silenceMs >= RBP_HEARTBEAT_DISCONNECTED_AFTER_MS) {
        return {
          kind: "transitioned",
          state: scheduleBackoff(state, event.continuousSteadyMs ?? 0),
        };
      }
      const phase =
        event.silenceMs >= RBP_HEARTBEAT_DEGRADED_AFTER_MS ? "degraded" : "steady";
      return { kind: "transitioned", state: { ...state, phase } };
    }
    case "connection_failed": {
      if (
        state.phase === "idle" ||
        state.phase === "backoff" ||
        state.phase === "retry_paused" ||
        state.phase === "shutdown"
      ) {
        return invalidConnection(state, event);
      }
      const continuousSteadyMs = event.continuousSteadyMs ?? 0;
      const retryAfterMs = event.retryAfterMs ?? 0;
      if (event.failure === "auth") {
        return { kind: "transitioned", state: pauseRetry(state, "auth") };
      }
      if (event.failure === "version") {
        return { kind: "transitioned", state: pauseRetry(state, "version_update") };
      }
      if (event.failure === "trust") {
        return { kind: "transitioned", state: pauseRetry(state, "trust") };
      }
      return {
        kind: "transitioned",
        state: scheduleBackoff(state, continuousSteadyMs, retryAfterMs),
      };
    }
    case "retry_timer_elapsed":
      return state.phase === "backoff"
        ? { kind: "transitioned", state: { ...state, phase: "connecting" } }
        : invalidConnection(state, event);
    case "retry_condition_changed":
      return state.phase === "retry_paused"
        ? {
            kind: "transitioned",
            state: {
              ...state,
              phase: "idle",
              retryPauseReason: null,
              lastRetryDecision: null,
            },
          }
        : invalidConnection(state, event);
    case "goodbye": {
      if (
        state.phase !== "steady" &&
        state.phase !== "degraded" &&
        state.phase !== "resuming" &&
        state.phase !== "re_enrolling"
      ) {
        return invalidConnection(state, event);
      }
      if (event.reason === "shutdown") {
        return {
          kind: "transitioned",
          state: {
            ...state,
            phase: "shutdown",
            lastRetryDecision: {
              action: "stop",
              waitAttemptIndex: null,
              jitterLimitMs: null,
              retryAfterFloorMs: 0,
              resetApplied: false,
              pauseReason: null,
            },
          },
        };
      }
      if (event.reason === "auth_revoked") {
        return { kind: "transitioned", state: pauseRetry(state, "auth_revoked") };
      }
      return {
        kind: "transitioned",
        state: scheduleBackoff(
          state,
          event.continuousSteadyMs ?? 0,
          event.retryAfterMs ?? 0,
        ),
      };
    }
    case "shutdown_requested":
      return {
        kind: "transitioned",
        state: {
          ...state,
          phase: "shutdown",
          lastRetryDecision: {
            action: "stop",
            waitAttemptIndex: null,
            jitterLimitMs: null,
            retryAfterFloorMs: 0,
            resetApplied: false,
            pauseReason: null,
          },
        },
      };
    case "service_started":
      return state.phase === "shutdown"
        ? {
            kind: "transitioned",
            state: {
              ...state,
              phase: "idle",
              retryPauseReason: null,
              lastRetryDecision: null,
            },
          }
        : invalidConnection(state, event);
  }
}

export function createSessionLifecycle(localSessionKey: string): SessionLifecycleState {
  if (localSessionKey.length === 0) {
    throw new TypeError("localSessionKey must not be empty");
  }
  return {
    localSessionKey,
    rsid: null,
    phase: "discovered",
    resumeAllowed: false,
    dispatchAllowed: false,
    unregisterReason: null,
  };
}

function invalidSession(state: SessionLifecycleState, event: SessionEvent): SessionTransition {
  return { kind: "invalid_transition", state, event: event.type };
}

export function transitionSession(
  state: SessionLifecycleState,
  event: SessionEvent,
): SessionTransition {
  if (event.type === "unregister") {
    return {
      kind: "transitioned",
      state: {
        ...state,
        phase: "unregistered",
        resumeAllowed: false,
        dispatchAllowed: false,
        unregisterReason: event.reason,
      },
    };
  }

  switch (event.type) {
    case "register_requested":
      return state.phase === "discovered" || state.phase === "re_enrolling"
        ? {
            kind: "transitioned",
            state: { ...state, phase: "registering", dispatchAllowed: false },
          }
        : invalidSession(state, event);
    case "registered":
      return state.phase === "registering" && event.rsid.length > 0
        ? {
            kind: "transitioned",
            state: {
              ...state,
              rsid: event.rsid,
              phase: "registered",
              resumeAllowed: true,
              dispatchAllowed: true,
              unregisterReason: null,
            },
          }
        : invalidSession(state, event);
    case "connection_lost":
      return state.phase === "registered"
        ? {
            kind: "transitioned",
            state: { ...state, phase: "disconnected", dispatchAllowed: false },
          }
        : invalidSession(state, event);
    case "resume_requested":
      return state.phase === "disconnected" && state.resumeAllowed
        ? {
            kind: "transitioned",
            state: { ...state, phase: "resuming", dispatchAllowed: false },
          }
        : invalidSession(state, event);
    case "resumed":
      return state.phase === "resuming"
        ? {
            kind: "transitioned",
            state: { ...state, phase: "registered", dispatchAllowed: true },
          }
        : invalidSession(state, event);
    case "resume_rejected":
      return state.phase === "resuming"
        ? {
            kind: "transitioned",
            state: {
              ...state,
              rsid: null,
              phase: "re_enrolling",
              resumeAllowed: false,
              dispatchAllowed: false,
            },
          }
        : invalidSession(state, event);
    case "re_enrolled":
      return state.phase === "re_enrolling" && event.rsid.length > 0
        ? {
            kind: "transitioned",
            state: {
              ...state,
              rsid: event.rsid,
              phase: "registered",
              resumeAllowed: true,
              dispatchAllowed: true,
            },
          }
        : invalidSession(state, event);
  }
}
