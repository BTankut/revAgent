/**
 * The seam every packaged legacy handler reaches Revit through (GW-1 / P-GW-5).
 *
 * All 30+ Revit-bound tools call exactly two helpers —
 * `executeRevitCode(code, options)` and `sendRevitCommand(command, params,
 * options)` — 67 call sites across 30 tool modules. The packager rebinds those
 * two exports to this port at build time, so the packaged modules carry no
 * socket, no port scan, and no workstation path: dispatch decides which Revit
 * session a call reaches.
 *
 * `ConnectionArgs` (`target`/`host`/`port`) is deliberately absent. In the
 * legacy stdio server those fields let a caller pick a Revit instance; in the
 * Gateway the session is already resolved by the `rsid` binding before a
 * handler runs, and honouring a caller-supplied target would let a tool address
 * a Revit session its invocation was never authorised for.
 */

/** Bounded, non-secret provenance the audit sink records for every call. */
export interface ExecutorCallContext {
  /** Registry name of the tool making the call, e.g. `core.element.query`. */
  readonly toolName: string;
  /** Gateway request correlation id. */
  readonly requestId: string;
}

export interface ExecuteCodeRequest {
  readonly kind: "execute_code";
  readonly code: string;
  readonly parameters: readonly unknown[];
  /** `"auto"` opens a Revit transaction; `"none"` forbids one. */
  readonly transactionMode: "auto" | "none";
  readonly parseJsonResult: boolean;
}

export interface SendCommandRequest {
  readonly kind: "send_command";
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ExecutorRequest = ExecuteCodeRequest | SendCommandRequest;

/**
 * Outcome of one port call.
 *
 * `dispatched` is not a convenience flag: a handler that cannot tell "the
 * add-in refused" from "nothing was sent" cannot be replayed safely, so the
 * port reports the distinction the RBP journal already depends on rather than
 * collapsing both into a thrown error.
 */
export type ExecutorResult =
  | { readonly status: "completed"; readonly result: unknown }
  | {
      readonly status: "failed";
      readonly dispatched: boolean;
      readonly faultClass: string;
      readonly message: string;
    };

export interface ExecutorPort {
  invoke(
    request: ExecutorRequest,
    context: ExecutorCallContext,
  ): Promise<ExecutorResult>;
}

export class ExecutorPortUnavailableError extends Error {
  constructor(readonly toolName: string) {
    super(
      `No executor port is bound for ${toolName}; nothing was sent to Revit.`,
    );
    this.name = "ExecutorPortUnavailableError";
  }
}

/**
 * The port a packaged module gets when the Gateway has bound no executor.
 *
 * It fails closed and states that nothing was dispatched, so a handler reached
 * without a bound executor can never be mistaken for one whose call was
 * delivered and lost.
 */
export const unboundExecutorPort: ExecutorPort = Object.freeze({
  async invoke(
    _request: ExecutorRequest,
    context: ExecutorCallContext,
  ): Promise<ExecutorResult> {
    return {
      status: "failed",
      dispatched: false,
      faultClass: "executor_unavailable",
      message: new ExecutorPortUnavailableError(context.toolName).message,
    };
  },
});
