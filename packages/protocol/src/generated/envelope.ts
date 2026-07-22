/* Generated from schemas/rbp/v1/envelope.schema.json. Do not edit directly. */

/**
 * M0 scaffold for the RBP/1 envelope. Message-specific payload schemas land during O1 conformance implementation.
 */
export type RbpEnvelope = {
  [k: string]: unknown;
} & {
  v: 1;
  type:
    | "hello"
    | "hello_ack"
    | "session_register"
    | "session_registered"
    | "session_resume"
    | "resume_ack"
    | "session_unregister"
    | "heartbeat"
    | "heartbeat_ack"
    | "invoke"
    | "invoke_batch"
    | "result"
    | "partial"
    | "error"
    | "cancel"
    | "doc_context_update"
    | "manifest_check"
    | "manifest_info"
    | "goodbye";
  id: string;
  rsid?: string;
  seq?: number;
  ack?: number;
  ts: string;
  payload: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
