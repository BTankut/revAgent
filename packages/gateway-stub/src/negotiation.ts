export class ProtocolNegotiationError extends Error {
  readonly status = 426;
  readonly closeCode = 4426;

  constructor(
    readonly minimum: number,
    readonly maximum: number,
    readonly supported: readonly number[],
  ) {
    super("no mutually supported RBP protocol version");
    this.name = "ProtocolNegotiationError";
  }
}

export function normalizeSupportedProtocols(versions: readonly number[]): number[] {
  if (versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new TypeError("RBP protocol versions must be positive safe integers");
  }
  const normalized = [...new Set(versions)].sort((left, right) => right - left);
  if (normalized.length === 0) {
    throw new TypeError("at least one positive safe RBP protocol version is required");
  }

  const current = normalized[0]!;
  if (current === 1 && normalized.length === 1) {
    return normalized;
  }
  if (normalized.length !== 2 || normalized[1] !== current - 1) {
    throw new TypeError(
      `RBP ${current} must advertise exactly the contiguous compatibility window ${current},${current - 1}`,
    );
  }
  return normalized;
}

export function selectProtocolVersion(
  supported: readonly number[],
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum < minimum) {
    throw new ProtocolNegotiationError(minimum, maximum, supported);
  }
  const selected = supported.find((version) => version >= minimum && version <= maximum);
  if (selected === undefined) {
    throw new ProtocolNegotiationError(minimum, maximum, supported);
  }
  return selected;
}

export function parseVersionHint(value: string | string[] | undefined): number[] {
  const text = Array.isArray(value) ? value.join(",") : value;
  if (text === undefined) {
    return [];
  }
  const parsed = text.split(",").map((entry) => Number(entry.trim()));
  if (parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    return [];
  }
  return [...new Set(parsed)].sort((left, right) => right - left);
}
