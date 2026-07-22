import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileFromFile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(packageRoot, "schemas/rbp/v1");
const schemaPath = resolve(schemaRoot, "envelope.schema.json");
const rawOutputPath = resolve(packageRoot, "src/generated/schema.ts");
const outputPath = resolve(packageRoot, "src/generated/envelope.ts");

const bindings = [
  ["HelloEnvelope", "preNegotiation", "hello", "Hello", "hello"],
  ["HelloAckEnvelope", "preNegotiation", "hello_ack", "HelloAck", "helloAck"],
  ["SessionRegisterEnvelope", "control", "session_register", "SessionRegister", "sessionRegister"],
  ["SessionRegisteredEnvelope", "control", "session_registered", "SessionRegistered", "sessionRegistered"],
  ["SessionResumeEnvelope", "control", "session_resume", "SessionResume", "sessionResume"],
  ["ResumeAckEnvelope", "control", "resume_ack", "ResumeAck", "resumeAck"],
  ["SessionUnregisterEnvelope", "control", "session_unregister", "SessionUnregister", "sessionUnregister"],
  ["HeartbeatEnvelope", "control", "heartbeat", "Heartbeat", "heartbeat"],
  ["HeartbeatAckEnvelope", "control", "heartbeat_ack", "HeartbeatAck", "heartbeatAck"],
  ["InvokeEnvelope", "data", "invoke", "Invoke", "invoke"],
  ["InvokeBatchEnvelope", "data", "invoke_batch", "InvokeBatch", "invokeBatch"],
  ["ResultEnvelope", "data", "result", "Result", "result"],
  ["PartialEnvelope", "data", "partial", "Partial", "partial"],
  ["DataErrorEnvelope", "data", "error", "DataError", "error"],
  ["ConnectionErrorEnvelope", "control", "error", "ConnectionError", "connectionError"],
  ["CancelEnvelope", "data", "cancel", "Cancel", "cancel"],
  ["DocContextUpdateEnvelope", "data", "doc_context_update", "DocContextUpdate", "docContextUpdate"],
  ["ManifestCheckEnvelope", "control", "manifest_check", "ManifestCheck", "manifestCheck"],
  ["ManifestInfoEnvelope", "control", "manifest_info", "ManifestInfo", "manifestInfo"],
  ["GoodbyeEnvelope", "control", "goodbye", "Goodbye", "goodbye"],
];

const envelopeSchema = JSON.parse(await readFile(schemaPath, "utf8"));
const payloadSchema = JSON.parse(
  await readFile(resolve(schemaRoot, "payloads.schema.json"), "utf8"),
);
const commonSchema = JSON.parse(await readFile(resolve(schemaRoot, "common.schema.json"), "utf8"));
const referencedDefinitions = envelopeSchema.oneOf.map((entry) => entry.$ref.split("/").at(-1));
const expectedDefinitions = bindings.map(([name]) => `${name[0].toLowerCase()}${name.slice(1)}`);
if (JSON.stringify(referencedDefinitions) !== JSON.stringify(expectedDefinitions)) {
  throw new Error("RBP envelope variants changed; update the strict generated type bindings");
}

for (const [name, scope, type, , payloadDefinition] of bindings) {
  const definitionName = `${name[0].toLowerCase()}${name.slice(1)}`;
  const definition = envelopeSchema.$defs[definitionName];
  const actualScope = definition?.allOf?.[0]?.$ref?.split("/").at(-1)?.replace("Base", "");
  const actualType = definition?.allOf?.[1]?.properties?.type?.const;
  const actualPayload = definition?.allOf?.[1]?.properties?.payload?.$ref?.split("/").at(-1);
  if (actualScope !== scope || actualType !== type || actualPayload !== payloadDefinition) {
    throw new Error(`RBP binding drift for ${definitionName}`);
  }
}

function assertRequired(label, actual, expected) {
  const actualSorted = [...(actual ?? [])].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} required fields changed; update exact generated types and consumer fixtures`);
  }
}

assertRequired("messageBase", envelopeSchema.$defs.messageBase.required, [
  "v",
  "type",
  "id",
  "ts",
  "payload",
]);
assertRequired("preNegotiationBase", envelopeSchema.$defs.preNegotiationBase.required, [
  "type",
  "id",
  "ts",
  "payload",
]);
assertRequired("invocationFields", payloadSchema.$defs.invocationFields.required, [
  "invocation_id",
  "method",
  "params",
  "mutating",
  "mutation_scope",
  "policy",
]);
assertRequired("invoke", payloadSchema.$defs.invoke.allOf[1].required, [
  "timeout_ms",
  "verification",
  "recovery_clearances",
]);
assertRequired("batchStep", payloadSchema.$defs.batchStep.allOf[1].required, ["params_digest"]);
assertRequired("invokeBatch", payloadSchema.$defs.invokeBatch.required, [
  "batch_id",
  "atomic",
  "timeout_ms",
  "recovery_clearances",
  "steps",
  "batch_digest",
]);
assertRequired("artifactDescriptor", payloadSchema.$defs.artifactDescriptor.required, [
  "artifact_id",
  "artifact_index",
  "stream_id",
  "filename",
  "content_type",
  "total_chunks",
  "total_size",
  "sha256",
]);
assertRequired("errorDetail", commonSchema.$defs.errorDetail.required, [
  "retryable",
  "fault_class",
  "outcome",
  "verification_required",
  "message",
]);

const rawSource = await compileFromFile(schemaPath, {
  bannerComment:
    "/* Generated schema projections. Public exact wire types are in envelope.ts. Do not edit directly. */",
  cwd: schemaRoot,
  style: {
    singleQuote: false,
    semi: true,
    tabWidth: 2,
    trailingComma: "all",
  },
});

const importNames = [
  "AckEntry",
  "ActiveView",
  "Cancel",
  "Display",
  "DocContextUpdate",
  "Document",
  "Documents",
  "Heartbeat",
  "HeartbeatAck",
  "Hello",
  "HelloAck",
  "ManifestCheck",
  "Metrics",
  "ResumeAck",
  "SessionRegister",
  "SessionRegistered",
  "SessionResume",
  "SessionUnregister",
];

const aliases = bindings
  .map(([name, scope, type, payload]) => {
    const base =
      scope === "preNegotiation"
        ? "PreNegotiationEnvelope"
        : scope === "control"
          ? "ControlEnvelope"
          : "DataEnvelope";
    return `export type ${name} = ${base}<"${type}", ${payload}>;`;
  })
  .join("\n");
const union = bindings.map(([name]) => `  | ${name}`).join("\n");

const exactSource = `/* Generated from schemas/rbp/v1/{common,payloads,envelope}.schema.json. Do not edit directly. */

import type {
${importNames.map((name) => `  ${name},`).join("\n")}
} from "./schema.js";

export type {
${importNames.map((name) => `  ${name},`).join("\n")}
} from "./schema.js";

export type NonIndeterminateFaultClass =
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
  | "oversize"
  | "cancelled";

interface AddinError {
  code: number;
  message?: string;
  [key: string]: unknown;
}

export type MutationScope =
  | { kind: "session"; [key: string]: unknown }
  | { kind: "document"; document_id: string; [key: string]: unknown };

export interface Verification {
  hold_id: string;
  mutation_scope: MutationScope;
  purpose: "resolve_indeterminate";
  [key: string]: unknown;
}

interface RecoveryClearanceBase {
  hold_id: string;
  mutation_scope: MutationScope;
  resolution_id: string;
  evidence_digest: string;
  decision: "non_execution_proven" | "postcondition_verified";
  audit_id: string;
  [key: string]: unknown;
}

export type RecoveryClearance = RecoveryClearanceBase &
  (
    | {
        basis: "verification_read";
        verification_invocation_id: string;
      }
    | {
        basis: "late_terminal";
        verification_invocation_id: null;
      }
  );

export type RecoveryClearances = RecoveryClearance[];

export type InvocationPolicy =
  | { class: "auto"; decision: "auto"; confirmation_id: null; [key: string]: unknown }
  | {
      class: "confirm";
      decision: "confirmed";
      confirmation_id: string;
      [key: string]: unknown;
    }
  | {
      class: "gated";
      decision: "gated_approved";
      confirmation_id: string;
      [key: string]: unknown;
    };

interface InvocationCore {
  invocation_id: string;
  method: string;
  params: unknown;
  policy: InvocationPolicy;
  [key: string]: unknown;
}

export type ReadInvocationFields = InvocationCore & {
  mutating: false;
  mutation_scope: null;
  display?: Display;
};

export type MutatingInvocationFields = InvocationCore & {
  mutating: true;
  mutation_scope: MutationScope;
  display?: Display;
};

export type InvocationFields = ReadInvocationFields | MutatingInvocationFields;

export type Invoke =
  | (ReadInvocationFields & {
      timeout_ms: number;
      verification: Verification | null;
      recovery_clearances: [];
    })
  | (MutatingInvocationFields & {
      timeout_ms: number;
      verification: null;
      recovery_clearances: RecoveryClearances;
    });

type BatchStepFields =
  | (ReadInvocationFields & { display?: never })
  | (MutatingInvocationFields & { display?: never });

export type BatchStep = BatchStepFields & {
  params_digest: string;
};

export interface InvokeBatch {
  batch_id: string;
  atomic: boolean;
  timeout_ms: number;
  recovery_clearances: RecoveryClearances;
  steps: [BatchStep, ...BatchStep[]];
  batch_digest: string;
  [key: string]: unknown;
}

interface ErrorDetailBase {
  message: string;
  addin_error?: AddinError;
  [key: string]: unknown;
}

export type KnownErrorDetail = ErrorDetailBase &
  (
    | {
        retryable: boolean;
        fault_class: NonIndeterminateFaultClass;
        outcome: "known";
        verification_required: false;
        replayed?: boolean;
        late_after_indeterminate?: false;
        verification_hold_id?: never;
        mutation_scope?: never;
        result_digest?: never;
      }
    | {
        retryable: boolean;
        fault_class: NonIndeterminateFaultClass;
        outcome: "known";
        verification_required: false;
        replayed: true;
        late_after_indeterminate: true;
        verification_hold_id: string;
        mutation_scope?: MutationScope;
        result_digest: string;
      }
  );

export type IndeterminateErrorDetail = ErrorDetailBase & {
  retryable: false;
  fault_class: "journal_indeterminate";
  outcome: "indeterminate";
  verification_required: true;
  replayed?: boolean;
  late_after_indeterminate?: false;
  verification_hold_id: string;
  mutation_scope: MutationScope;
  result_digest?: never;
};

export type ErrorDetail = KnownErrorDetail | IndeterminateErrorDetail;

interface InlineResult {
  result: unknown;
  payload_omitted?: false;
  result_digest?: string;
  chunked?: false;
  stream_id?: never;
  content_type?: never;
  total_chunks?: never;
  total_size?: never;
  sha256?: never;
  artifacts?: never;
}

interface OmittedResult {
  result?: never;
  payload_omitted: true;
  result_digest: string;
  replayed: true;
  chunked?: never;
  stream_id?: never;
  content_type?: never;
  total_chunks?: never;
  total_size?: never;
  sha256?: never;
  artifacts?: never;
}

interface ChunkedResult {
  result?: never;
  payload_omitted?: never;
  result_digest?: string;
  chunked: true;
  stream_id: "result";
  content_type: string;
  total_chunks: number;
  total_size: number;
  sha256: string;
  artifacts?: never;
}

export interface ArtifactDescriptor {
  artifact_id: string;
  artifact_index: number;
  stream_id: \`artifact:\${string}\`;
  filename: string;
  content_type: string;
  total_chunks: number;
  total_size: number;
  sha256: string;
  [key: string]: unknown;
}

interface ArtifactResult {
  result: unknown;
  payload_omitted?: false;
  result_digest?: string;
  chunked: true;
  stream_id?: never;
  content_type?: never;
  total_chunks?: never;
  total_size?: never;
  sha256?: never;
  artifacts: [ArtifactDescriptor, ...ArtifactDescriptor[]];
}

type InvocationOutput = InlineResult | OmittedResult | ChunkedResult | ArtifactResult;
type BatchStepOutput =
  | {
      result: unknown;
      payload_omitted?: false;
      result_digest?: string;
    }
  | {
      result?: never;
      payload_omitted: true;
      result_digest: string;
      replayed: true;
    };

interface InvocationResultBase {
  kind: "invocation";
  invocation_id: string;
  replayed?: boolean;
  metrics: Metrics;
  [key: string]: unknown;
}

type ResultRecovery =
  | { late_after_indeterminate?: false; verification_hold_id?: never }
  | {
      late_after_indeterminate: true;
      replayed: true;
      verification_hold_id: string;
      result_digest: string;
    };

type BatchStepRecovery =
  | { late_after_indeterminate?: false; verification_hold_id?: never }
  | {
      late_after_indeterminate: true;
      replayed: true;
      verification_hold_id: string;
      result_digest: string;
    };

export type InvocationResult = InvocationResultBase &
  InvocationOutput &
  ResultRecovery &
  (
    | { status: "completed"; guarded_reason?: never }
    | { status: "guarded"; guarded_reason: string }
  );

interface BatchStepResultBase {
  index: number;
  invocation_id: string;
  replayed: boolean;
  [key: string]: unknown;
}

type CompletedBatchStepResult = BatchStepResultBase &
  BatchStepOutput &
  BatchStepRecovery & {
    status: "completed";
    guarded_reason?: never;
    error?: never;
  };

type GuardedBatchStepResult = BatchStepResultBase &
  BatchStepOutput &
  BatchStepRecovery & {
    status: "guarded";
    guarded_reason: string;
    error?: never;
  };

type FailedErrorDetail = KnownErrorDetail & {
  fault_class: Exclude<NonIndeterminateFaultClass, "cancelled">;
};

type CancelledErrorDetail = KnownErrorDetail & {
  fault_class: "cancelled";
};

type KnownBatchErrorRecovery<T extends KnownErrorDetail> =
  | {
      replayed: false;
      late_after_indeterminate?: false;
      verification_hold_id?: never;
      result_digest?: never;
      error: T & { replayed: false; late_after_indeterminate?: false };
    }
  | {
      replayed: true;
      late_after_indeterminate?: false;
      verification_hold_id?: never;
      result_digest?: never;
      error: T & { late_after_indeterminate?: false };
    }
  | {
      replayed: true;
      late_after_indeterminate: true;
      verification_hold_id: string;
      result_digest: string;
      error: T & {
        replayed: true;
        late_after_indeterminate: true;
        verification_hold_id: string;
        result_digest: string;
      };
    };

type FailedBatchStepResult = BatchStepResultBase & {
  status: "failed";
  result?: never;
  payload_omitted?: never;
  guarded_reason?: never;
} & KnownBatchErrorRecovery<FailedErrorDetail>;

type CancelledBatchStepResult = BatchStepResultBase & {
  status: "cancelled";
  result?: never;
  payload_omitted?: never;
  guarded_reason?: never;
} & KnownBatchErrorRecovery<CancelledErrorDetail>;

type IndeterminateBatchStepResult = BatchStepResultBase & {
  status: "indeterminate";
  result?: never;
  payload_omitted?: never;
  result_digest?: never;
  guarded_reason?: never;
  late_after_indeterminate?: never;
  verification_hold_id?: never;
} &
  (
    | { replayed: false; error: IndeterminateErrorDetail & { replayed: false } }
    | { replayed: true; error: IndeterminateErrorDetail }
  );

type NotStartedBatchStepResult = BatchStepResultBase & {
  status: "not_started";
  replayed: false;
  result?: never;
  payload_omitted?: never;
  result_digest?: never;
  guarded_reason?: never;
  error?: never;
  late_after_indeterminate?: never;
  verification_hold_id?: never;
};

export type BatchStepResult =
  | CompletedBatchStepResult
  | GuardedBatchStepResult
  | FailedBatchStepResult
  | CancelledBatchStepResult
  | IndeterminateBatchStepResult
  | NotStartedBatchStepResult;

interface BatchResultBase {
  kind: "batch";
  batch_id: string;
  failed_step_index: number | null;
  steps: [BatchStepResult, ...BatchStepResult[]];
  replayed: boolean;
  [key: string]: unknown;
}

export type BatchResult = BatchResultBase &
  (
    | {
        atomic: false;
        status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
        transaction_state: "not_applicable";
      }
    | { atomic: true; status: "completed"; transaction_state: "committed" }
    | {
        atomic: true;
        status: "guarded" | "failed" | "cancelled";
        transaction_state: "rolled_back";
      }
    | { atomic: true; status: "indeterminate"; transaction_state: "indeterminate" }
  );

export type Result = InvocationResult | BatchResult;

export type Partial =
  | {
      kind: "chunk";
      invocation_id: string;
      stream_id: "result";
      artifact_id?: never;
      artifact_index?: never;
      chunk_index: number;
      encoding: "base64";
      content_type: string;
      data: string;
      [key: string]: unknown;
    }
  | {
      kind: "chunk";
      invocation_id: string;
      stream_id: \`artifact:\${string}\`;
      artifact_id: string;
      artifact_index: number;
      chunk_index: number;
      encoding: "base64";
      content_type: string;
      data: string;
      [key: string]: unknown;
    }
  | {
      kind: "progress";
      invocation_id: string;
      progress: { elapsed_ms: number; note: string; [key: string]: unknown };
      [key: string]: unknown;
    };

export type DataError = ErrorDetail & {
  invocation_id?: string;
};

export type ConnectionError = ErrorDetailBase & {
  retryable: boolean;
  fault_class: "protocol" | "auth";
  outcome: "known";
  verification_required: false;
  replayed?: boolean;
  late_after_indeterminate?: false;
  verification_hold_id?: never;
  mutation_scope?: never;
  result_digest?: never;
  invocation_id?: never;
};

interface ManifestInfoBase {
  channel: string;
  latest_version: string;
  min_supported_version: string;
  release_sequence: number;
  [key: string]: unknown;
}

export type ManifestInfo = ManifestInfoBase &
  (
    | {
        status: "up_to_date";
        rollout_cohort?: never;
        manifest_url?: never;
        signature_url?: never;
      }
    | {
        status: "update_available" | "update_required";
        rollout_cohort: string;
        manifest_url: string;
        signature_url: string;
      }
  );

type GoodbyeBase = {
  message?: string;
  [key: string]: unknown;
};

export type Goodbye = GoodbyeBase &
  (
    | { reason: "update" | "server_draining"; retry_after_ms?: number }
    | { reason: "shutdown" | "protocol_error" | "auth_revoked"; retry_after_ms?: never }
  );

export interface PreNegotiationEnvelope<TType extends string, TPayload> {
  v?: never;
  type: TType;
  id: string;
  ts: string;
  payload: TPayload;
  rsid?: never;
  seq?: never;
  ack?: never;
  [key: string]: unknown;
}

export interface MessageBase<TType extends string, TPayload> {
  v: 1;
  type: TType;
  id: string;
  ts: string;
  payload: TPayload;
  [key: string]: unknown;
}

export type ControlEnvelope<TType extends string, TPayload> = MessageBase<TType, TPayload> & {
  rsid?: never;
  seq?: never;
  ack?: never;
};

export type DataEnvelope<TType extends string, TPayload> = MessageBase<TType, TPayload> & {
  rsid: string;
  seq: number;
  ack?: number;
};

${aliases}

export type RbpEnvelope =
${union};
`;

await writeFile(rawOutputPath, rawSource, "utf8");
await writeFile(outputPath, exactSource, "utf8");
