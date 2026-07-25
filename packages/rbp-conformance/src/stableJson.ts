import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }

  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(stableJson(value));
}
