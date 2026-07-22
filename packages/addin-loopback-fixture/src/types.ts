import type { TestTransactionGroup } from "./transactionGroup.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type Effect = "read_only" | "model_transaction";
export type HandlerState = "completed" | "guarded" | "failed";

export interface CompletedHandlerOutcome {
  state: "completed";
  result: JsonValue;
}

export interface GuardedHandlerOutcome {
  state: "guarded";
  guardedReason: string;
  result?: JsonValue;
}

export interface FailedHandlerOutcome {
  state: "failed";
  error: {
    code: "command_failure" | "revit_api" | "invalid_result" | "response_payload_limit";
    message: string;
    maxResponsePayloadBytes?: number;
    tentativeResponsePayloadBytes?: number;
  };
}

export type HandlerOutcome =
  | CompletedHandlerOutcome
  | GuardedHandlerOutcome
  | FailedHandlerOutcome;

export interface HandlerContext {
  readonly requestId: string;
  readonly method: string;
  readonly executionOrdinal: number;
  readonly transactionGroup: TestTransactionGroup | null;
  readonly stepIndex: number | null;
}

export type FixtureHandler = (
  params: JsonObject,
  context: HandlerContext,
) => HandlerOutcome | JsonValue | Promise<HandlerOutcome | JsonValue>;

export interface HandlerRegistration {
  readonly effect: Effect;
  readonly handler: FixtureHandler;
}

export type DisconnectPhase =
  | "before_dispatch"
  | "after_dispatch"
  | "after_response_bytes";
export type CrashPhase = "before_dispatch" | "after_dispatch";

export interface StandardJsonRpcErrorPlan {
  readonly code: -32700 | -32600 | -32601 | -32602 | -32603;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface FaultPlan {
  readonly busy?: boolean;
  readonly delayMs?: number;
  readonly stall?: boolean;
  readonly disconnect?: DisconnectPhase;
  readonly afterResponseBytes?: number;
  readonly crash?: CrashPhase;
  readonly rollbackFailure?: boolean;
  readonly finalBatchResponseFault?: "omit_batch_digest";
  readonly injectedOutcome?: GuardedHandlerOutcome | FailedHandlerOutcome;
  readonly jsonRpcError?: StandardJsonRpcErrorPlan;
}

export type ObservationPhase =
  | "frame_received"
  | "validated"
  | "dispatch_started"
  | "dispatch_finished"
  | "guarded"
  | "failed"
  | "response_sent"
  | "response_overflow"
  | "disconnected"
  | "crashed"
  | "late_outcome";

export interface FixtureObservation {
  readonly sequence: number;
  readonly requestId: string | null;
  readonly method: string | null;
  readonly phase: ObservationPhase;
  readonly executionOrdinal: number | null;
  readonly payloadBytes: number | null;
  readonly detail: string | null;
}

export interface FixtureEvidenceSnapshot {
  readonly evidenceVersion: 1;
  readonly fixtureContract: "addin-loopback/v1";
  readonly observations: readonly FixtureObservation[];
  readonly executionCounts: readonly {
    readonly requestId: string;
    readonly count: number;
  }[];
  readonly methodExecutionCounts: readonly {
    readonly method: string;
    readonly count: number;
  }[];
  readonly modelStateDigest: string;
  readonly modelStateEntryCount: number;
  readonly pendingStalls: readonly {
    readonly requestId: string;
    readonly count: number;
  }[];
  readonly openSocketCount: number;
  readonly crashed: boolean;
}

export interface DocumentContextSnapshot {
  readonly resultContractVersion: 2;
  readonly documentContextContractVersion: 1;
  readonly capturedAtUtc: string;
  readonly revision: number;
  readonly cacheState: "ready" | "warming" | "unavailable";
  readonly unavailableReason: string | null;
  readonly documents: readonly {
    readonly documentId: string;
    readonly title: string;
    readonly pathDigest: string | null;
    readonly isWorkshared: boolean;
    readonly isActive: boolean;
  }[];
  readonly activeDocumentId: string | null;
  readonly activeView: {
    readonly documentId: string;
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly level: string | null;
  } | null;
  readonly disciplineHint: string | null;
}

export type DocumentContextEvent = Omit<
  DocumentContextSnapshot,
  "resultContractVersion" | "documentContextContractVersion" | "revision"
>;

export interface FixtureOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxRequestPayloadBytes?: number;
  readonly addinVersion?: string;
  readonly revitVersion?: string;
  readonly revitBuild?: string;
  readonly processId?: number;
  readonly documentContext?: DocumentContextSnapshot;
  /** Deliberately rejected. It exists only so tests prove there is no bypass. */
  readonly allowUnsafeBind?: boolean;
}

export interface FixtureAddress {
  readonly host: string;
  readonly port: number;
}

export interface MultiFileArtifact {
  readonly artifactIndex: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}
