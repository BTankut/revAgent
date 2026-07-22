/* Generated schema projections. Public exact wire types are in envelope.ts. Do not edit directly. */

/**
 * RBP/1 envelope with message-specific payload and control/data constraints.
 */
export type RbpEnvelope =
  | HelloEnvelope
  | HelloAckEnvelope
  | SessionRegisterEnvelope
  | SessionRegisteredEnvelope
  | SessionResumeEnvelope
  | ResumeAckEnvelope
  | SessionUnregisterEnvelope
  | HeartbeatEnvelope
  | HeartbeatAckEnvelope
  | InvokeEnvelope
  | InvokeBatchEnvelope
  | ResultEnvelope
  | PartialEnvelope
  | DataErrorEnvelope
  | ConnectionErrorEnvelope
  | CancelEnvelope
  | DocContextUpdateEnvelope
  | ManifestCheckEnvelope
  | ManifestInfoEnvelope
  | GoodbyeEnvelope;
export type HelloEnvelope = PreNegotiationBase & {
  type?: "hello";
  payload?: Hello;
  [k: string]: unknown;
};
export type HelloAckEnvelope = PreNegotiationBase & {
  type?: "hello_ack";
  payload?: HelloAck;
  [k: string]: unknown;
};
export type SessionRegisterEnvelope = ControlBase & {
  type?: "session_register";
  payload?: SessionRegister;
  [k: string]: unknown;
};
export type ControlBase = MessageBase & {
  [k: string]: unknown;
};
export type Documents = Document[];
export type SessionRegisteredEnvelope = ControlBase & {
  type?: "session_registered";
  payload?: SessionRegistered;
  [k: string]: unknown;
};
export type SessionResumeEnvelope = ControlBase & {
  type?: "session_resume";
  payload?: SessionResume;
  [k: string]: unknown;
};
export type ResumeAckEnvelope = ControlBase & {
  type?: "resume_ack";
  payload?: ResumeAck;
  [k: string]: unknown;
};
export type SessionUnregisterEnvelope = ControlBase & {
  type?: "session_unregister";
  payload?: SessionUnregister;
  [k: string]: unknown;
};
export type HeartbeatEnvelope = ControlBase & {
  type?: "heartbeat";
  payload?: Heartbeat;
  [k: string]: unknown;
};
export type HeartbeatAckEnvelope = ControlBase & {
  type?: "heartbeat_ack";
  payload?: HeartbeatAck;
  [k: string]: unknown;
};
export type InvokeEnvelope = DataBase & {
  type?: "invoke";
  payload?: InvocationFields & {
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
export type DataBase = MessageBase & {
  [k: string]: unknown;
};
export type InvocationFields = {
  [k: string]: unknown;
} & {
  invocation_id: string;
  method: string;
  params: unknown;
  mutating: boolean;
  mutation_scope:
    | (
        | {
            kind: "session";
            [k: string]: unknown;
          }
        | {
            kind: "document";
            document_id: string;
            [k: string]: unknown;
          }
      )
    | null;
  policy:
    | {
        class: "auto";
        decision: "auto";
        confirmation_id: null;
        [k: string]: unknown;
      }
    | {
        class: "confirm";
        decision: "confirmed";
        confirmation_id: string;
        [k: string]: unknown;
      }
    | {
        class: "gated";
        decision: "gated_approved";
        confirmation_id: string;
        [k: string]: unknown;
      };
  display?: Display;
  [k: string]: unknown;
};
export type InvokeBatchEnvelope = DataBase & {
  type?: "invoke_batch";
  payload?: InvokeBatch;
  [k: string]: unknown;
};
export type RecoveryClearance = {
  [k: string]: unknown;
} & {
  hold_id: string;
  mutation_scope:
    | {
        kind: "session";
        [k: string]: unknown;
      }
    | {
        kind: "document";
        document_id: string;
        [k: string]: unknown;
      };
  resolution_id: string;
  basis: "verification_read" | "late_terminal";
  verification_invocation_id: string | null;
  evidence_digest: string;
  decision: "non_execution_proven" | "postcondition_verified";
  audit_id: string;
  [k: string]: unknown;
};
export type RecoveryClearances = RecoveryClearance[];
export type ResultEnvelope = DataBase & {
  type?: "result";
  payload?: InvocationResult | BatchResult;
  [k: string]: unknown;
};
export type InvocationResult = {
  [k: string]: unknown;
} & (
  | {
      payload_omitted?: false;
      chunked?: false;
      [k: string]: unknown;
    }
  | {
      payload_omitted: true;
      [k: string]: unknown;
    }
  | {
      chunked: true;
      stream_id: "result";
      [k: string]: unknown;
    }
  | {
      payload_omitted?: false;
      chunked: true;
      [k: string]: unknown;
    }
) & {
    kind: "invocation";
    invocation_id: string;
    status: "completed" | "guarded";
    result?: unknown;
    guarded_reason?: string;
    replayed?: boolean;
    late_after_indeterminate?: boolean;
    verification_hold_id?: string;
    payload_omitted?: boolean;
    result_digest?: string;
    metrics: Metrics;
    chunked?: boolean;
    stream_id?: "result";
    content_type?: string;
    total_chunks?: number;
    total_size?: number;
    sha256?: string;
    /**
     * @minItems 1
     * @maxItems 16
     */
    artifacts?:
      | [ArtifactDescriptor]
      | [ArtifactDescriptor, ArtifactDescriptor]
      | [ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor]
      | [ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor]
      | [ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor, ArtifactDescriptor]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ]
      | [
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
          ArtifactDescriptor,
        ];
    [k: string]: unknown;
  };
export type BatchResult = {
  [k: string]: unknown;
} & {
  kind: "batch";
  batch_id: string;
  atomic: boolean;
  status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
  transaction_state: "committed" | "rolled_back" | "not_applicable" | "indeterminate";
  failed_step_index: number | null;
  /**
   * @minItems 1
   */
  steps: [BatchStepResult, ...BatchStepResult[]];
  replayed: boolean;
  [k: string]: unknown;
};
export type BatchStepResult = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  index: number;
  invocation_id: string;
  status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate" | "not_started";
  result?: unknown;
  payload_omitted?: boolean;
  result_digest?: string;
  guarded_reason?: string;
  effect_state?: "read_only" | "committed" | "not_committed";
  error?: ErrorDetail;
  replayed: boolean;
  late_after_indeterminate?: boolean;
  verification_hold_id?: string;
  [k: string]: unknown;
} & {
  index: number;
  invocation_id: string;
  status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate" | "not_started";
  result?: unknown;
  payload_omitted?: boolean;
  result_digest?: string;
  guarded_reason?: string;
  effect_state?: "read_only" | "committed" | "not_committed";
  error?: ErrorDetail;
  replayed: boolean;
  late_after_indeterminate?: boolean;
  verification_hold_id?: string;
  [k: string]: unknown;
};
export type ErrorDetail = {
  [k: string]: unknown;
} & {
  retryable: boolean;
  fault_class:
    | "protocol"
    | "auth"
    | "policy"
    | "unsupported"
    | "parameter"
    | "environment"
    | "revit_busy"
    | "revit_timeout"
    | "revit_api"
    | "addin_unreachable"
    | "journal_indeterminate"
    | "oversize"
    | "cancelled";
  message: string;
  outcome: "known" | "indeterminate";
  verification_required: boolean;
  replayed?: boolean;
  late_after_indeterminate?: boolean;
  verification_hold_id?: string;
  mutation_scope?:
    | {
        kind: "session";
        [k: string]: unknown;
      }
    | {
        kind: "document";
        document_id: string;
        [k: string]: unknown;
      };
  result_digest?: string;
  addin_error?: {
    code: number;
    message?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
export type PartialEnvelope = DataBase & {
  type?: "partial";
  payload?:
    | {
        [k: string]: unknown;
      }
    | {
        kind: "progress";
        invocation_id: string;
        progress: {
          elapsed_ms: number;
          note: string;
          [k: string]: unknown;
        };
        [k: string]: unknown;
      };
  [k: string]: unknown;
};
export type DataErrorEnvelope = DataBase & {
  type?: "error";
  payload?: ErrorDetail & {
    invocation_id?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
export type ConnectionErrorEnvelope = ControlBase & {
  type?: "error";
  payload?: (ErrorDetail & {
    invocation_id?: string;
    [k: string]: unknown;
  }) & {
    fault_class?: "protocol" | "auth";
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
export type CancelEnvelope = DataBase & {
  type?: "cancel";
  payload?: Cancel;
  [k: string]: unknown;
};
export type DocContextUpdateEnvelope = DataBase & {
  type?: "doc_context_update";
  payload?: DocContextUpdate;
  [k: string]: unknown;
};
export type ManifestCheckEnvelope = ControlBase & {
  type?: "manifest_check";
  payload?: ManifestCheck;
  [k: string]: unknown;
};
export type ManifestInfoEnvelope = ControlBase & {
  type?: "manifest_info";
  payload?: ManifestInfo;
  [k: string]: unknown;
};
export type ManifestInfo = {
  [k: string]: unknown;
} & {
  status: "up_to_date" | "update_available" | "update_required";
  channel: string;
  latest_version: string;
  min_supported_version: string;
  release_sequence: number;
  rollout_cohort?: string;
  manifest_url?: string;
  signature_url?: string;
  [k: string]: unknown;
};
export type GoodbyeEnvelope = ControlBase & {
  type?: "goodbye";
  payload?: Goodbye;
  [k: string]: unknown;
};
export type Goodbye = {
  [k: string]: unknown;
} & {
  reason: "shutdown" | "update" | "server_draining" | "protocol_error" | "auth_revoked";
  retry_after_ms?: number;
  message?: string;
  [k: string]: unknown;
};

export interface PreNegotiationBase {
  type: string;
  id: string;
  ts: string;
  payload: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface Hello {
  min_protocol: 1;
  max_protocol: 1;
  capabilities: string[];
  bridge_version: string;
  device_id: string;
  machine: {
    hostname: string;
    os: string;
    fingerprint?: string;
    [k: string]: unknown;
  };
  addin_versions: string[];
  [k: string]: unknown;
}
export interface HelloAck {
  protocol: 1;
  connection_id: string;
  granted_capabilities: string[];
  heartbeat_interval_ms: 15000;
  limits: {
    max_params_bytes: number;
    max_result_bytes: number;
    max_partial_bytes: number;
    [k: string]: unknown;
  };
  manifest: {
    latest_bridge_version: string;
    manifest_url: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface MessageBase {
  v: 1;
  type: string;
  id: string;
  rsid?: string;
  seq?: number;
  ack?: number;
  ts: string;
  payload: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface SessionRegister {
  local_session_key: string;
  user_hint: {
    name: string;
    [k: string]: unknown;
  };
  machine: {
    hostname: string;
    fingerprint: string;
    [k: string]: unknown;
  };
  revit: {
    version: string;
    build: string;
    pid: number;
    [k: string]: unknown;
  };
  addin_version: string;
  result_contract_version: number;
  session_capabilities: string[];
  bridge_version: string;
  documents: Documents;
  port: number;
  [k: string]: unknown;
}
export interface Document {
  document_id: string;
  title: string;
  path_digest: string | null;
  is_workshared: boolean;
  is_active: boolean;
  [k: string]: unknown;
}
export interface SessionRegistered {
  rsid: string;
  resume_token: string;
  resume_expires_at: string;
  principal: {
    tenant_id: string;
    user_id: string;
    [k: string]: unknown;
  };
  seat: {
    granted: true;
    seat_id: string;
    [k: string]: unknown;
  };
  granted_session_capabilities: string[];
  [k: string]: unknown;
}
export interface SessionResume {
  rsid: string;
  resume_token: string;
  last_rx_seq: number;
  [k: string]: unknown;
}
export interface ResumeAck {
  rsid: string;
  last_rx_seq: number;
  resume_expires_at: string;
  [k: string]: unknown;
}
export interface SessionUnregister {
  rsid: string;
  reason: "revit_exited" | "bridge_shutdown" | "session_replaced" | "operator_requested";
  [k: string]: unknown;
}
export interface Heartbeat {
  bridge_version: string;
  acks: AckEntry[];
  sessions: {
    rsid: string;
    port: number;
    revit_status: {
      active_task: null | {
        name: string;
        method: string;
        elapsed_ms: number;
        [k: string]: unknown;
      };
      addin_reachable: boolean;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
export interface AckEntry {
  rsid: string;
  seq: number;
  [k: string]: unknown;
}
export interface HeartbeatAck {
  server_time: string;
  acks: AckEntry[];
  update_available?: {
    channel: string;
    manifest_url: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface Display {
  task_name?: string;
  wrapper_action?: string;
  logical_tool_name?: string;
  parent_task_name?: string | null;
  parent_task_id?: string | null;
  suppress_task_status_window?: boolean;
  [k: string]: unknown;
}
export interface InvokeBatch {
  batch_id: string;
  atomic: boolean;
  timeout_ms: number;
  recovery_clearances: RecoveryClearances;
  /**
   * @minItems 1
   */
  steps: [
    InvocationFields & {
      method?: string;
      params_digest: string;
      [k: string]: unknown;
    },
    ...(InvocationFields & {
      method?: string;
      params_digest: string;
      [k: string]: unknown;
    })[],
  ];
  batch_digest: string;
  [k: string]: unknown;
}
export interface Metrics {
  execute_ms: number;
  request_bytes: number;
  response_bytes: number;
  framing: "length-prefixed";
  [k: string]: unknown;
}
export interface ArtifactDescriptor {
  artifact_id: string;
  artifact_index: number;
  stream_id: string;
  filename: string;
  content_type: string;
  total_chunks: number;
  total_size: number;
  sha256: string;
  [k: string]: unknown;
}
export interface Cancel {
  invocation_id: string;
  reason: "user_requested" | "client_disconnected" | "deadline_exceeded" | "gateway_shutdown";
  [k: string]: unknown;
}
export interface DocContextUpdate {
  documents: Documents;
  active_document: string | null;
  active_view: ActiveView | null;
  discipline_hint?: string;
  [k: string]: unknown;
}
export interface ActiveView {
  id: string;
  name: string;
  type: string;
  level?: string | null;
  [k: string]: unknown;
}
export interface ManifestCheck {
  bridge_version: string;
  addin_versions: string[];
  channel: string;
  highest_accepted_release_sequence: number;
  [k: string]: unknown;
}
