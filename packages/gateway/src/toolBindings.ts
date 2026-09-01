import type {
  GatewayExecutorBinding,
  GatewayPolicyClass,
  GatewayMutationScopePolicy,
} from "./registry.js";

/**
 * The E5 mapping for all 41 tools (GW-3).
 *
 * Every row is transcribed from the frozen E5 tools map: the target name and
 * policy class come from its per-tool table, and the executor binding from its
 * executor-binding paragraph, which assigns tools 1-25 and 27-31 to the bridge,
 * the spatial query/compare/summarize tools plus schedule reconciliation and
 * all docs tools to the Gateway's own runtime, and calls the spatial capture
 * hybrid.
 *
 * One row deviates from E5 deliberately and that deviation is recorded in
 * `docs/decisions/DP-log.md`: `core.bridge.list` is bound to `internal_mcp`
 * even though E5 counts it bridge-bound. Discovery is the Gateway's under
 * RES-23/29, and the packaged handler has no target-selection surface to probe
 * ports with — GW-1's build-time rebinding fails that call closed.
 */
export interface ToolBindingRow {
  /** Legacy tool name, as the registry seed reports it. */
  readonly tool: string;
  /** E5 target name. */
  readonly target: string;
  readonly module: "runtime" | "docs";
  readonly policyClass: GatewayPolicyClass;
  readonly executor: GatewayExecutorBinding;
  /**
   * True where E5 calls the tool hybrid: a bridge leg that pages data out of
   * Revit followed by a Gateway-side store commit. It binds to `bridge` because
   * that is the leg that leaves the process; the flag records that the binding
   * alone does not describe the whole tool.
   */
  readonly hybrid?: true;
  /** Set where this row knowingly departs from E5, with the deciding record. */
  readonly overrideOfE5?: string;
}

export const E5_TOOL_BINDINGS: readonly ToolBindingRow[] = Object.freeze([
  {
    tool: "list_revit_instances",
    target: "core.bridge.list",
    module: "runtime",
    policyClass: "auto",
    executor: "internal_mcp",
    overrideOfE5:
      "E5 counts this bridge-bound; RES-23/29 make discovery Gateway-owned and GW-1 fails target selection closed (DP-log 2026-08-02)",
  },
  {
    tool: "get_revit_mcp_status",
    target: "core.session.status",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "send_code_to_revit",
    target: "core.code.execute",
    module: "runtime",
    policyClass: "confirm",
    executor: "bridge",
  },
  {
    tool: "send_code_to_revit_safe",
    target: "core.code.preview",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "get_revit_session_context",
    target: "core.document.context",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "get_active_view_context",
    target: "core.view.context",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "list_open_views",
    target: "core.view.list_open",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "activate_view",
    target: "core.view.activate",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "close_view",
    target: "core.view.close",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "clear_selection",
    target: "core.ui.clear_selection",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "delete_review_view",
    target: "core.view.delete_review",
    module: "runtime",
    policyClass: "confirm",
    executor: "bridge",
  },
  {
    tool: "get_ui_state",
    target: "core.ui.state",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "find_elements",
    target: "core.element.query",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "open_existing_plan_for_element_level",
    target: "core.view.open_plan_for_level",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "focus_elements",
    target: "core.view.focus",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "section_box_elements",
    target: "core.view.section_box",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "create_3d_view_for_elements",
    target: "core.view.create_3d",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "export_revit_view_image",
    target: "core.image.export_view",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "export_revit_coordination_image",
    target: "core.image.export_coordination",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "show_element_in_plan_and_3d",
    target: "core.view.show_plan_3d",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "smart_focus_elements",
    target: "core.view.smart_focus",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "inspect_elements",
    target: "core.element.inspect",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "inspect_levels",
    target: "core.level.inspect",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "inspect_sheet_text",
    target: "core.sheet.inspect_text",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "inspect_schedules",
    target: "core.schedule.inspect",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  // E5 assigns schedule reconciliation to the Gateway runtime: it works against
  // supplied spreadsheet data, not against Revit.
  {
    tool: "reconcile_schedule_excel",
    target: "core.schedule.reconcile_excel",
    module: "runtime",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "count_annotations",
    target: "core.annotation.count",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "inspect_parameter_schema",
    target: "core.parameter.inspect_schema",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
  },
  {
    tool: "set_element_parameter",
    target: "core.parameter.set",
    module: "runtime",
    policyClass: "confirm",
    executor: "bridge",
  },
  {
    tool: "set_schedule_cells",
    target: "core.schedule.set_cells",
    module: "runtime",
    policyClass: "confirm",
    executor: "bridge",
  },
  {
    tool: "set_schedule_cells_by_text",
    target: "core.schedule.set_cells_by_text",
    module: "runtime",
    policyClass: "confirm",
    executor: "bridge",
  },
  {
    tool: "capture_spatial_snapshot",
    target: "core.spatial.capture",
    module: "runtime",
    policyClass: "auto",
    executor: "bridge",
    hybrid: true,
  },
  {
    tool: "query_spatial_context",
    target: "core.spatial.query",
    module: "runtime",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "compare_spatial_snapshots",
    target: "core.spatial.compare",
    module: "runtime",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "summarize_spatial_state",
    target: "core.spatial.summarize",
    module: "runtime",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "search_api",
    target: "core.docs.search",
    module: "docs",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "get_type_details",
    target: "core.docs.type",
    module: "docs",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "get_member_details",
    target: "core.docs.member",
    module: "docs",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "list_namespace",
    target: "core.docs.namespace",
    module: "docs",
    policyClass: "auto",
    executor: "internal_mcp",
  },
  {
    tool: "resolve_api_symbols_bulk",
    target: "core.docs.resolve_bulk",
    module: "docs",
    policyClass: "auto",
    executor: "internal_mcp",
  },
] as const);

/**
 * Gateway-owned C39 recovery is intentionally outside the collected Revit
 * tool map.  It has no legacy handler and is only registered by the normal
 * north surface after C39 composition readiness has passed.
 */
export const C39_PAYLOAD_RECOVERY_BINDING: ToolBindingRow = Object.freeze({
  tool: "dispatch_payload_recovery",
  target: "core.dispatch.payload_recovery",
  module: "runtime",
  policyClass: "auto",
  executor: "bridge",
});

/** E5's stated totals, asserted rather than recomputed from the rows above. */
export const E5_EXPECTED_TOTALS = Object.freeze({
  tools: 40,
  runtime: 35,
  docs: 5,
  auto: 35,
  confirm: 5,
  gated: 0,
});

/** The five tools E5 names as confirm class, listed so the set is checkable. */
export const E5_CONFIRM_CLASS_TOOLS: readonly string[] = Object.freeze([
  "send_code_to_revit",
  "delete_review_view",
  "set_element_parameter",
  "set_schedule_cells",
  "set_schedule_cells_by_text",
]);

/**
 * O1 journal-effect classes, transcribed from O1 section 7 plus E5's composite
 * tool effects. UI-only operations remain read/replay-safe; an arbitrary code
 * invocation is session-scoped because its document reach cannot be proven.
 * The current model/view writers also resolve their target from Revit's
 * implicit active document, so O1 section 6.2.1 conservatively makes them
 * session-scoped. Document scope remains reserved for a future handler whose
 * exact live document target is explicit and registry-authoritative.
 */
export const E5_SESSION_RECOVERY_TOOLS: readonly string[] = Object.freeze([
  "create_3d_view_for_elements",
  "delete_review_view",
  "export_revit_coordination_image",
  "export_revit_view_image",
  "send_code_to_revit",
  "send_code_to_revit_safe",
  "section_box_elements",
  "set_element_parameter",
  "set_schedule_cells",
  "set_schedule_cells_by_text",
  "show_element_in_plan_and_3d",
  "smart_focus_elements",
]);

/** Reserved for future handlers whose exact document target is not implicit. */
export const E5_DOCUMENT_RECOVERY_TOOLS: readonly string[] = Object.freeze([]);

export const E5_NO_RECOVERY_TOOLS: readonly string[] = Object.freeze([
  "activate_view",
  "capture_spatial_snapshot",
  "clear_selection",
  "close_view",
  "compare_spatial_snapshots",
  "count_annotations",
  "find_elements",
  "focus_elements",
  "get_active_view_context",
  "get_member_details",
  "get_revit_mcp_status",
  "get_revit_session_context",
  "get_type_details",
  "get_ui_state",
  "inspect_elements",
  "inspect_levels",
  "inspect_parameter_schema",
  "inspect_schedules",
  "inspect_sheet_text",
  "list_namespace",
  "list_open_views",
  "list_revit_instances",
  "open_existing_plan_for_element_level",
  "query_spatial_context",
  "reconcile_schedule_excel",
  "resolve_api_symbols_bulk",
  "search_api",
  "summarize_spatial_state",
]);

const C39_NO_RECOVERY_TOOLS = Object.freeze([
  "dispatch_payload_recovery",
]);

export function mutationScopePolicyForTool(
  tool: string,
): GatewayMutationScopePolicy {
  const matches = [
    E5_SESSION_RECOVERY_TOOLS.includes(tool),
    E5_DOCUMENT_RECOVERY_TOOLS.includes(tool),
    E5_NO_RECOVERY_TOOLS.includes(tool),
    C39_NO_RECOVERY_TOOLS.includes(tool),
  ].filter(Boolean).length;
  if (matches !== 1) {
    fail(
      "recovery_scope_unclassified",
      `${tool} must appear in exactly one O1/E5 recovery-scope class`,
    );
  }
  if (E5_SESSION_RECOVERY_TOOLS.includes(tool)) return "session";
  if (E5_DOCUMENT_RECOVERY_TOOLS.includes(tool)) return "document";
  return "none";
}

/**
 * The tool whose payload is arbitrary C# executed inside Revit.
 *
 * RES-14: `aps` is a legitimate future executor variant, but dynamic code must
 * never resolve to it — running caller-supplied code through a cloud executor
 * is a different trust boundary from running it on an enrolled workstation.
 */
export const DYNAMIC_CODE_TOOL = "send_code_to_revit" as const;

export class ToolBindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolBindingError";
  }
}

function fail(code: string, message: string): never {
  throw new ToolBindingError(code, message);
}

/**
 * Fails closed on any mapping that contradicts E5 or RES-14.
 *
 * Written as an assertion over the table rather than a comment above it: the
 * failure this guards against is a future edit that quietly rebinds a write
 * tool or drops a confirm class, which no reviewer reliably catches in a
 * forty-row diff.
 */
export function verifyToolBindings(
  rows: readonly ToolBindingRow[] = E5_TOOL_BINDINGS,
): void {
  if (rows.length !== E5_EXPECTED_TOTALS.tools) {
    fail(
      "tool_count_mismatch",
      `E5 states ${String(E5_EXPECTED_TOTALS.tools)} tools but the mapping has ${String(rows.length)}`,
    );
  }

  const tools = new Set<string>();
  const targets = new Set<string>();
  for (const row of rows) {
    if (tools.has(row.tool)) {
      fail("tool_duplicate", `${row.tool} appears more than once`);
    }
    tools.add(row.tool);
    if (targets.has(row.target)) {
      fail(
        "target_duplicate",
        `${row.target} is assigned to more than one tool`,
      );
    }
    targets.add(row.target);
    mutationScopePolicyForTool(row.tool);

    // RES-14, stated as an explicit refusal rather than an omitted case: an
    // unhandled switch branch would let a later executor table silently route
    // dynamic code to a cloud executor.
    if (row.tool === DYNAMIC_CODE_TOOL && row.executor === "aps") {
      fail(
        "dynamic_code_bound_to_aps",
        `${DYNAMIC_CODE_TOOL} must never resolve to the aps executor (RES-14)`,
      );
    }

    if (row.module === "docs" && row.executor !== "internal_mcp") {
      fail(
        "docs_tool_not_internal",
        `${row.tool} is a docs tool and must bind to internal_mcp, not ${row.executor}`,
      );
    }
  }

  const counts = {
    runtime: rows.filter((r) => r.module === "runtime").length,
    docs: rows.filter((r) => r.module === "docs").length,
    auto: rows.filter((r) => r.policyClass === "auto").length,
    confirm: rows.filter((r) => r.policyClass === "confirm").length,
    gated: rows.filter((r) => r.policyClass === "gated").length,
  };
  for (const [key, expected] of Object.entries({
    runtime: E5_EXPECTED_TOTALS.runtime,
    docs: E5_EXPECTED_TOTALS.docs,
    auto: E5_EXPECTED_TOTALS.auto,
    confirm: E5_EXPECTED_TOTALS.confirm,
    gated: E5_EXPECTED_TOTALS.gated,
  })) {
    const actual = counts[key as keyof typeof counts];
    if (actual !== expected) {
      fail(
        "total_mismatch",
        `E5 states ${String(expected)} ${key} tools but the mapping has ${String(actual)}`,
      );
    }
  }

  const confirmTools = rows
    .filter((r) => r.policyClass === "confirm")
    .map((r) => r.tool)
    .sort();
  const expectedConfirm = [...E5_CONFIRM_CLASS_TOOLS].sort();
  if (JSON.stringify(confirmTools) !== JSON.stringify(expectedConfirm)) {
    fail(
      "confirm_set_mismatch",
      `E5 names ${expectedConfirm.join(", ")} as confirm class but the mapping has ${confirmTools.join(", ")}`,
    );
  }
}
