import { caseProgram } from "./casePrograms.js";
import type { CaseControlStep } from "./casePrograms.js";
import type { JsonValue } from "./processHarness.js";
import {
  withRealTrioNorthMcpClient,
  type RealTrioNorthCredential,
  type RealTrioNorthWireEvidence,
} from "./realTrioMcpClient.js";

export type { RealTrioNorthCredential, RealTrioNorthWireEvidence } from "./realTrioMcpClient.js";

/**
 * The real-trio case executor deliberately has a smaller contract than the
 * legacy supervised runner.  It inventories only operations which can be
 * observed through the public Gateway binding/control surface, the real C#
 * worker, and the add-in loopback fixture.  It must never substitute an
 * in-memory responder for an unavailable operation.
 */
export const REAL_TRIO_CASE_DRIVER_CONTRACT = "rbp-real-trio-case-driver/v1" as const;

export const REAL_TRIO_COMPONENTS = Object.freeze([
  "gateway_production_conformance",
  "bridge_worker",
  "addin_loopback_fixture",
] as const);

export type RealTrioCaseComponent = (typeof REAL_TRIO_COMPONENTS)[number];

export const REAL_TRIO_NORTH_EVIDENCE_SCHEMA = "rbp-real-trio-north-evidence/v1" as const;

/**
 * The only north-tool admission mapping for the four frozen real cases.  It
 * is descriptive rather than a control-plane substitute: the case program,
 * its oracle, and the real worker/fixture remain authoritative.  Keeping the
 * mapping here makes both carriers exercise one identical public MCP path.
 */
export const REAL_TRIO_NORTH_CASE_TOOL_MAP = Object.freeze({
  "O1-C28": Object.freeze({ toolName: "conformance.fixture.c28_mutation", confirmation: true }),
  "O1-C29": Object.freeze({ toolName: "conformance.fixture.c29_atomic_batch", confirmation: true }),
  "O1-C38": Object.freeze({ toolName: "core.ui.state", confirmation: false }),
  "O1-C39": Object.freeze({ toolName: "conformance.fixture.c39_multifile", confirmation: false }),
} as const);

export function realTrioNorthToolForCase(
  caseId: keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP,
): (typeof REAL_TRIO_NORTH_CASE_TOOL_MAP)[keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP] {
  return REAL_TRIO_NORTH_CASE_TOOL_MAP[caseId];
}

export const REAL_TRIO_CASE_MAPPING_SCHEMA = "rbp-real-trio-case-mapping/v1" as const;

export type RealTrioMappedOperation =
  | "audited_readiness"
  | "fixture_fault"
  | "north_tool_call"
  | "north_confirm_commit"
  | "public_audit_poll"
  | "supervisor_restart"
  | "raw_binding";

export interface RealTrioCaseSemanticMapping {
  readonly schemaVersion: typeof REAL_TRIO_CASE_MAPPING_SCHEMA;
  readonly caseId: keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP;
  readonly operations: readonly RealTrioMappedOperation[];
  /** Frozen simulator controls are intentionally never an execution route. */
  readonly rejectedFrozenActions: readonly string[];
}

/**
 * Approved semantic substitutions for the real-worker cases.  This is not a
 * generic case-program interpreter: every mapping is deliberately closed to
 * the four named cases and exposes only public Gateway, fixture, binding, or
 * supervisor operations.  In particular, no mapping grants a private worker
 * journal, expiry, hold, or crash-latch mutation.
 */
export const REAL_TRIO_CASE_SEMANTIC_MAPPINGS = Object.freeze({
  "O1-C28": Object.freeze({
    schemaVersion: REAL_TRIO_CASE_MAPPING_SCHEMA,
    caseId: "O1-C28",
    operations: Object.freeze([
      "audited_readiness", "fixture_fault", "north_tool_call",
      "north_confirm_commit", "public_audit_poll",
    ] as const),
    rejectedFrozenActions: Object.freeze([
      "open_session", "register_session", "start_heartbeat", "expire_pending",
      "install_mutation_hold", "clear_mutation_hold", "dispatch_invoke",
    ]),
  }),
  "O1-C29": Object.freeze({
    schemaVersion: REAL_TRIO_CASE_MAPPING_SCHEMA,
    caseId: "O1-C29",
    operations: Object.freeze([
      "audited_readiness", "fixture_fault", "north_tool_call",
      "north_confirm_commit", "public_audit_poll", "supervisor_restart",
    ] as const),
    rejectedFrozenActions: Object.freeze([
      "inject_crash", "restart_simulator", "journal_mutate", "crash_latch_mutate",
      "dispatch_batch",
    ]),
  }),
  "O1-C38": Object.freeze({
    schemaVersion: REAL_TRIO_CASE_MAPPING_SCHEMA,
    caseId: "O1-C38",
    operations: Object.freeze([
      "audited_readiness", "fixture_fault", "raw_binding", "public_audit_poll",
    ] as const),
    rejectedFrozenActions: Object.freeze(["dispatch_batch", "simulator_guarded_result"]),
  }),
  "O1-C39": Object.freeze({
    schemaVersion: REAL_TRIO_CASE_MAPPING_SCHEMA,
    caseId: "O1-C39",
    operations: Object.freeze([
      "audited_readiness", "north_tool_call", "public_audit_poll",
    ] as const),
    rejectedFrozenActions: Object.freeze([
      "dispatch_payload_recovery", "resource_store_mutate", "guessed_result_recovery",
    ]),
  }),
} satisfies Record<keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP, RealTrioCaseSemanticMapping>);

export function realTrioSemanticMappingForCase(
  caseId: keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP,
): RealTrioCaseSemanticMapping {
  return REAL_TRIO_CASE_SEMANTIC_MAPPINGS[caseId];
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export interface RealTrioNorthToolCall {
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly requestId: string;
}

export interface RealTrioNorthToolResult {
  readonly preview: RealTrioNorthWireEvidence;
  readonly commit: RealTrioNorthWireEvidence | null;
  readonly state: string;
  readonly requestId: string;
}

/**
 * Executes a public MCP tool call and, only when Gateway requests it, the
 * ordinary one-time confirmation re-invocation.  Confirmation material is
 * consumed immediately and retained only as wire hashes.
 */
export async function callRealTrioNorthTool(input: {
  readonly endpoint: string;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
  readonly call: RealTrioNorthToolCall;
}): Promise<RealTrioNorthToolResult> {
  return await withRealTrioNorthMcpClient(input, async (client) => {
    const preview = await client.toolCall({
      name: input.call.toolName, arguments: input.call.args, requestId: input.call.requestId,
    });
    const state = preview.content.state;
    const requestId = preview.content.requestId;
    if (typeof state !== "string" || typeof requestId !== "string") {
      throw new Error("real trio MCP tool response lacks state or request id");
    }
    if (state !== "confirmation_required") {
      return Object.freeze({ preview: preview.evidence, commit: null, state, requestId });
    }
    const confirmation = objectRecord(preview.content.confirmation, "real trio MCP confirmation");
    const confirmToken = confirmation.confirmToken;
    const originatingPreviewInvocationId = confirmation.originatingPreviewInvocationId;
    if (typeof confirmToken !== "string" || confirmToken.length === 0 ||
        typeof originatingPreviewInvocationId !== "string" || originatingPreviewInvocationId.length === 0) {
      throw new Error("real trio MCP confirmation is malformed");
    }
    const commit = await client.toolCall({
      name: input.call.toolName,
      arguments: Object.freeze({ ...input.call.args, confirm_token: confirmToken,
        originating_preview_invocation_id: originatingPreviewInvocationId }),
      requestId: `${input.call.requestId}-commit`,
    });
    if (commit.content.state !== "completed" || typeof commit.content.requestId !== "string") {
      throw new Error("real trio MCP confirmed tool call did not complete");
    }
    return Object.freeze({ preview: preview.evidence, commit: commit.evidence,
      state: "completed", requestId: commit.content.requestId });
  });
}

/** Exact, authenticated control payload for the public north bearer route. */
export function issueNorthCredentialControlPayload(): { readonly action: "issue_north_credential" } {
  return Object.freeze({ action: "issue_north_credential" });
}

/**
 * Uses the actual loopback TLS `/mcp` server.  The returned evidence contains
 * only wire hashes and sizes: bearer, JSON-RPC payload and resource paths are
 * intentionally excluded from case artifacts.
 */
export async function callRealTrioNorthMcp(input: {
  readonly endpoint: string;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
  readonly request: Readonly<Record<string, unknown>>;
}): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
  return await withRealTrioNorthMcpClient(input, async (client) => await client.request(input.request));
}

export interface RealTrioCaseControlSurface {
  /** Operations exposed by the loopback/TLS Gateway conformance control route. */
  readonly gatewayActions: readonly string[];
  /** Operations declared by the real C# worker's strict READY record. */
  readonly bridgeActions: readonly string[];
  /** Operations declared by the fixture's strict JSONL READY record. */
  readonly fixtureActions: readonly string[];
  /** Public, raw carrier operations which can be used without test doubles. */
  readonly bindingActions: readonly string[];
  /** Restart is a supervisor operation, never a process-private mutation. */
  readonly supervisorActions: readonly string[];
}

export interface RealTrioCaseControlGap {
  readonly stepId: string;
  readonly component: RealTrioCaseComponent | "public_binding" | "supervisor";
  readonly action: string;
  readonly reason: "not_exposed" | "not_a_real_trio_component";
}

export class RealTrioCaseControlSurfaceError extends Error {
  public constructor(
    readonly caseId: string,
    readonly gaps: readonly RealTrioCaseControlGap[],
  ) {
    super(`${caseId} cannot run against the real trio: ${gaps.map((gap) => `${gap.component}/${gap.action}@${gap.stepId}`).join(", ")}`);
  }
}

function has(actions: readonly string[], action: string): boolean {
  return actions.includes(action);
}

function componentFor(step: CaseControlStep): RealTrioCaseComponent | "public_binding" | "supervisor" {
  if (step.channel === "gateway_http_control") return "gateway_production_conformance";
  if (step.channel === "bridge_jsonl_control") return "bridge_worker";
  if (step.channel === "fixture_jsonl_control") return "addin_loopback_fixture";
  return step.action === "restart_case_stack" || step.action === "restart_component"
    ? "supervisor"
    : "public_binding";
}

function available(surface: RealTrioCaseControlSurface, component: ReturnType<typeof componentFor>, action: string): boolean {
  switch (component) {
    case "gateway_production_conformance": return has(surface.gatewayActions, action);
    case "bridge_worker": return has(surface.bridgeActions, action);
    case "addin_loopback_fixture": return has(surface.fixtureActions, action);
    case "supervisor": return has(surface.supervisorActions, action);
    case "public_binding": return has(surface.bindingActions, action);
  }
}

/**
 * Checks the frozen parent program without rewriting or eliding a semantic
 * step.  A caller may execute a case only when every original step has a
 * concrete real-process route.  This is the fail-closed boundary which keeps
 * C28/C29/C38/C39 from silently falling back to a stub or simulator.
 */
export function realTrioCaseControlGaps(
  caseId: "O1-C28" | "O1-C29" | "O1-C38" | "O1-C39",
  surface: RealTrioCaseControlSurface,
): readonly RealTrioCaseControlGap[] {
  const program = caseProgram(caseId);
  const gaps: RealTrioCaseControlGap[] = [];
  for (const step of program.steps) {
    const component = componentFor(step);
    if (available(surface, component, step.action)) continue;
    gaps.push(Object.freeze({
      stepId: step.stepId,
      component,
      action: step.action,
      reason: "not_exposed",
    }));
  }
  return Object.freeze(gaps);
}

/** Throws before case execution rather than manufacturing any missing evidence. */
export function assertRealTrioCaseControlSurface(
  caseId: "O1-C28" | "O1-C29" | "O1-C38" | "O1-C39",
  surface: RealTrioCaseControlSurface,
): void {
  const gaps = realTrioCaseControlGaps(caseId, surface);
  if (gaps.length > 0) throw new RealTrioCaseControlSurfaceError(caseId, gaps);
}

/** Current C957 exposed control capabilities, obtained from strict READY/public route contracts. */
export const C957_REAL_TRIO_CONTROL_SURFACE: RealTrioCaseControlSurface = Object.freeze({
  gatewayActions: Object.freeze(["issue_device_credential", "revoke_device", "snapshot_audit"]),
  bridgeActions: Object.freeze(["shutdown"]),
  fixtureActions: Object.freeze(["plan_fault", "release_stall", "apply_document_context", "snapshot_evidence", "shutdown"]),
  bindingActions: Object.freeze([]),
  supervisorActions: Object.freeze([]),
});
