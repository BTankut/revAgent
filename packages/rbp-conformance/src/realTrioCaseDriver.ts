import { caseProgram } from "./casePrograms.js";
import type { CaseControlStep } from "./casePrograms.js";

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
