// The ambient binding a packaged handler module reads its executor from.
//
// Packaged handlers are plain functions with no Gateway parameter, so the port
// has to reach them out of band. It is bound per dispatch rather than once at
// import: the Gateway resolves which Revit session an invocation may reach from
// its rsid binding, and a module-level singleton would let a later invocation
// inherit an earlier one's session.

let currentPort = null;
let currentContext = null;

export function getExecutorPort() {
  if (currentPort === null) {
    throw new Error(
      "No ExecutorPort is bound for this dispatch; nothing was sent to Revit.",
    );
  }
  return currentPort;
}

export function getExecutorContext(toolName) {
  return {
    toolName: toolName ?? currentContext?.toolName ?? "unknown",
    requestId: currentContext?.requestId ?? "unbound",
  };
}

/**
 * Runs one handler with a bound port and restores the previous binding
 * afterwards, so a nested or concurrent dispatch cannot leak its session to the
 * next caller.
 */
export async function withExecutorPort(port, context, run) {
  const priorPort = currentPort;
  const priorContext = currentContext;
  currentPort = port;
  currentContext = context;
  try {
    return await run();
  } finally {
    currentPort = priorPort;
    currentContext = priorContext;
  }
}
