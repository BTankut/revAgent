// Build-time replacement for
// `installer/runtime-mcp-server/src/utils/ConnectionManager.ts` -- the single
// seam every Revit-bound call in the legacy runtime passes through.
//
// P-GW-5 names two chokepoints, `executeRevitCode` and `sendRevitCommand` in
// revitToolHelpers. Packaging the module showed that premise is incomplete:
// three tool modules (`send_code_to_revit`, `get_revit_mcp_status`,
// `list_revit_instances`) import `withRevitConnection` directly, and
// `refreshLiveRevitStatus` (helpers L452) reaches it without going through
// either helper. Rebinding at the helper layer leaves all four on a raw socket.
//
// ConnectionManager is one layer down and has no such gap: both helpers, the
// status refresh, and the three direct importers all funnel through it, and
// `RevitClientConnection` is constructed here and nowhere else. Rebinding here
// also keeps the helpers' real bodies -- response normalization, bridge result
// contract checks, plan-candidate trimming -- which the helper-layer shim was
// bypassing.
//
// The packager asserts on the produced bytes that no socket survives this.

import { getExecutorPort, getExecutorContext } from "revagent-executor-port";

/**
 * Dynamic C# execution rides the same wire command as everything else.
 *
 * `executeRevitCode` builds a params object and sends it as
 * `sendCommand("send_code_to_revit", params)` (helpers L370-396), so without
 * this mapping the port would only ever see opaque `send_command` calls and its
 * typed `execute_code` variant -- the one carrying the transaction mode that
 * D12's confirm class turns on -- would be dead on arrival.
 */
const CODE_EXECUTION_COMMAND = "send_code_to_revit";

function codeExecutionRequest(params, options) {
  const { code, parameters, transactionMode, ...metadata } = params;
  return {
    kind: "execute_code",
    code: typeof code === "string" ? code : "",
    parameters: Array.isArray(parameters) ? parameters : [],
    transactionMode: transactionMode === "auto" ? "auto" : "none",
    parseJsonResult: options.parseJsonResult !== false,
    metadata,
  };
}

/**
 * The only client member the operations use.
 *
 * `socket`/`connect`/`disconnect`/`isConnected` are touched solely by the
 * original ConnectionManager's own connect dance, which this module replaces
 * wholesale; every caller-supplied operation uses `sendCommand` alone.
 */
function portBackedClient() {
  return {
    async sendCommand(command, params = {}, options = {}) {
      // Liveness polling never reaches the executor.
      //
      // `refreshLiveRevitStatus` (helpers L452) is fired as
      // `void refreshLiveRevitStatusAfterCommand()` after every command, and
      // that call sits *inside* the helpers module, so no export rebinding can
      // reach it -- it has to be stopped at the transport. Left alone it would
      // add a redundant `mcp_status` dispatch per tool call: the Gateway
      // already owns session liveness, which is what resolved the rsid this
      // dispatch is bound to. `get_revit_mcp_status` is the only other caller
      // and is Gateway-native per E5 row 2 ("should leave the LLM-visible core
      // set and become orchestrator-internal").
      //
      // Throwing rather than returning null is the closer emulation: the
      // original wraps this call in try/catch and returns null on failure
      // (helpers L467-469), so callers already take this path.
      if (command === "mcp_status") {
        throw new ExecutorPortBoundaryError('sendCommand("mcp_status")');
      }

      const context = getExecutorContext(options.toolName ?? command);
      const outcome = await getExecutorPort().invoke(
        command === CODE_EXECUTION_COMMAND
          ? codeExecutionRequest(params ?? {}, options)
          : { kind: "send_command", command, params: params ?? {} },
        context,
      );
      return unwrap(outcome);
    },
  };
}

/**
 * Legacy call shape: `withRevitConnection(operation, options)`.
 *
 * The lock, the connect/disconnect dance and the socket timeouts are all gone
 * rather than reimplemented: the Gateway scheduler already serializes per
 * session (5.2.4), so keeping a second lock here would be a distinct
 * serialization domain that can deadlock against the first.
 */
export async function withRevitConnection(operation, _options = {}) {
  return await operation(portBackedClient());
}

/**
 * Fails closed: target selection is not a packaged handler's decision.
 *
 * The original probes configured ports to pick a Revit instance. In the Gateway
 * the session is resolved from the rsid binding before a handler runs, so a
 * handler that picks its own target could address a session its invocation was
 * never authorised for. The two tools that call this -- `core.bridge.list` and
 * `core.session.status` -- are Gateway-native per E5 (row 1, and row 2's note
 * that status becomes orchestrator-internal), so nothing that should reach
 * Revit depends on this returning a value.
 */
export function resolveRevitConnectionTarget() {
  throw new ExecutorPortBoundaryError("resolveRevitConnectionTarget");
}

/** Fails closed for the same reason as `resolveRevitConnectionTarget`. */
export function getCandidateRevitTargets() {
  throw new ExecutorPortBoundaryError("getCandidateRevitTargets");
}

export class ExecutorPortBoundaryError extends Error {
  constructor(symbol) {
    super(
      `${symbol} is not available to a packaged handler: Revit target ` +
        "selection belongs to the Gateway session binding, not the tool.",
    );
    this.name = "ExecutorPortBoundaryError";
    this.dispatched = false;
    this.faultClass = "executor_boundary";
  }
}

/**
 * The legacy client threw on failure and returned the payload on success. The
 * port's structured outcome is converted back to that contract, with
 * `dispatched` preserved so the Gateway can still tell a refusal from a call
 * that never left.
 */
function unwrap(outcome) {
  if (outcome.status === "completed") {
    return outcome.result;
  }
  const error = new Error(outcome.message);
  error.name = "ExecutorPortError";
  error.faultClass = outcome.faultClass;
  error.dispatched = outcome.dispatched;
  throw error;
}
