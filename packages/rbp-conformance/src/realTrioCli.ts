import type { RealTrioBinding } from "./realTrioSupervisor.js";

/** Test-only command surface; the normal production CLI has no changed default. */
export const REAL_TRIO_CLI_COMMAND = "real-trio" as const;

export interface RealTrioCliRun<T> {
  readonly binding: RealTrioBinding;
  readonly result: T;
}

/**
 * Explicit WP-12 entrypoint shared by the two carrier tests.  Startup is
 * injected so this module cannot choose a mock, an old plan, or a simulator.
 */
export async function runRealTrioCli<T>(
  args: readonly string[],
  start: (binding: RealTrioBinding) => Promise<T>,
): Promise<RealTrioCliRun<T>> {
  if (args[0] !== REAL_TRIO_CLI_COMMAND || args.length !== 2 ||
      (args[1] !== "wss" && args[1] !== "streamable_http_sse")) {
    throw new Error("Usage: real-trio <wss|streamable_http_sse>");
  }
  const binding = args[1];
  return Object.freeze({ binding, result: await start(binding) });
}
