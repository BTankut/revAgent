import type { ConformanceCaseProgram } from "./casePrograms.js";
import type { JsonValue } from "./processHarness.js";
import type { Binding } from "./types.js";

export const EARLY_PRODUCTION_CASES = [
  "O1-C02",
  "O1-C03",
  "O1-C04",
  "O1-C06",
  "O1-C07",
  "O1-C08",
  "O1-C09",
  "O1-C10",
  "O1-C11",
  "O1-C12",
  "O1-C13",
  "O1-C14",
] as const;

export type EarlyProductionCase = (typeof EARLY_PRODUCTION_CASES)[number];

const EARLY = new Set<string>(EARLY_PRODUCTION_CASES);

const INVOCATION_SLOTS: Readonly<Record<EarlyProductionCase, readonly string[]>> = {
  "O1-C02": [],
  "O1-C03": [],
  "O1-C04": [],
  "O1-C06": [],
  "O1-C07": ["retransmit"],
  "O1-C08": ["terminal-replay"],
  "O1-C09": ["mutation-indeterminate"],
  "O1-C10": ["read-indeterminate"],
  "O1-C11": ["digest-mismatch"],
  "O1-C12": ["first", "same-rsid-second", "cross-rsid"],
  "O1-C13": ["normal"],
  "O1-C14": ["timeout"],
};

function caseNumber(caseId: EarlyProductionCase): number {
  return Number(caseId.slice(-2));
}

function uuid7(caseId: EarlyProductionCase, slot: number): string {
  const suffix = (caseNumber(caseId) * 1_000 + slot).toString().padStart(12, "0");
  return `019f0a00-0000-7000-8000-${suffix}`;
}

function idsFor(caseId: EarlyProductionCase): Record<string, JsonValue> {
  const ids: Record<string, JsonValue> = {
    "hello-initial": { envelopeId: uuid7(caseId, 1) },
    "hello-reconnect": { envelopeId: uuid7(caseId, 2) },
  };
  INVOCATION_SLOTS[caseId].forEach((name, index) => {
    const baseSlot = 100 + index * 3;
    ids[name] = {
      envelopeId: uuid7(caseId, baseSlot),
      invocationId: uuid7(caseId, baseSlot + 1),
      redeliveryEnvelopeId: uuid7(caseId, baseSlot + 2),
    };
  });
  return ids;
}

function flattenLeafPaths(
  value: JsonValue,
  prefix = "",
  output = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenLeafPaths(entry, `${prefix}.${index}`, output));
    return output;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      flattenLeafPaths(entry, prefix.length === 0 ? key : `${prefix}.${key}`, output);
    }
    return output;
  }
  if (prefix.length > 0) output.add(prefix);
  return output;
}

function tokensIn(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/gu)) {
      output.add(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) tokensIn(entry, output);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) tokensIn(entry, output);
  }
  return output;
}

export function assertEarlyProductionCaseVariablesComplete(
  program: Readonly<ConformanceCaseProgram>,
  variables: Readonly<Record<string, JsonValue>>,
): void {
  const available = flattenLeafPaths(variables as JsonValue);
  for (const step of program.steps) {
    const missing = [...tokensIn(step.arguments)].filter((token) => !available.has(token));
    if (missing.length > 0) {
      throw new Error(`${program.caseId}/${step.stepId} has unresolved seed tokens: ${missing.join(", ")}`);
    }
    for (const capture of step.captures) available.add(capture.name);
  }
}

export function earlyProductionCaseVariables(
  caseId: string,
  binding: Binding,
  clockIso = "2026-07-23T00:00:00.000Z",
): Readonly<Record<string, JsonValue>> {
  if (!EARLY.has(caseId)) throw new Error(`early production seed is not implemented: ${caseId}`);
  const selected = caseId as EarlyProductionCase;
  const baseMs = Date.parse(clockIso);
  if (!Number.isSafeInteger(baseMs) || baseMs < 0) {
    throw new Error("early production clock must be a non-negative RFC3339 instant");
  }
  return {
    binding,
    clock: {
      iso: clockIso,
      base_ms: baseMs,
      at_35s_ms: baseMs + 35_000,
      at_65s_ms: baseMs + 65_000,
    },
    case: {
      device_token: "test-device-token",
      device_id: "device-01",
    },
    ids: {
      [selected]: idsFor(selected),
    },
    fixture: {},
    gateway: {},
    vectors: {},
  };
}
