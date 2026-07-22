export const RBP_RECONNECT_INITIAL_MS = 1_000 as const;
export const RBP_RECONNECT_FACTOR = 2 as const;
export const RBP_RECONNECT_CAP_MS = 60_000 as const;
export const RBP_RECONNECT_RESET_AFTER_STEADY_MS = 120_000 as const;

export function reconnectBackoffLimitMs(attemptIndex: number): number {
  if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0) {
    throw new RangeError("attemptIndex must be a non-negative safe integer");
  }

  if (attemptIndex >= 6) {
    return RBP_RECONNECT_CAP_MS;
  }

  return Math.min(
    RBP_RECONNECT_CAP_MS,
    RBP_RECONNECT_INITIAL_MS * RBP_RECONNECT_FACTOR ** attemptIndex,
  );
}

/** Returns a full-jitter integer delay in the inclusive range [0, limit_ms]. */
export function reconnectFullJitterDelayMs(
  attemptIndex: number,
  random: () => number = Math.random,
): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("random must return a finite value in [0, 1)");
  }

  const limit = reconnectBackoffLimitMs(attemptIndex);
  return Math.floor(sample * (limit + 1));
}

export function shouldResetReconnectBackoff(steadyDurationMs: number): boolean {
  if (!Number.isFinite(steadyDurationMs) || steadyDurationMs < 0) {
    throw new RangeError("steadyDurationMs must be a non-negative finite number");
  }

  return steadyDurationMs >= RBP_RECONNECT_RESET_AFTER_STEADY_MS;
}
