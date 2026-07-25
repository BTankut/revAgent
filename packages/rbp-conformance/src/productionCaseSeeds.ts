import type { Binding } from "./types.js";
import type { JsonValue } from "./processHarness.js";

export const SUPPORTED_PRODUCTION_CASES = [
  "O1-C01",
  "O1-C05",
] as const;

export type SupportedProductionCase = (typeof SUPPORTED_PRODUCTION_CASES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_PRODUCTION_CASES);

function caseNumber(caseId: SupportedProductionCase): number {
  return Number(caseId.slice(-2));
}

function uuid7(caseId: SupportedProductionCase, slot: number): string {
  const suffix = (caseNumber(caseId) * 1_000 + slot).toString().padStart(12, "0");
  return `019f0a00-0000-7000-8000-${suffix}`;
}

function invocationIds(caseId: SupportedProductionCase): Record<string, JsonValue> {
  const ids: Record<string, JsonValue> = {
    "hello-initial": { envelopeId: uuid7(caseId, 1) },
  };
  return ids;
}

function documentContext(clockIso: string): JsonValue {
  return {
    capturedAtUtc: clockIso,
    cacheState: "ready",
    unavailableReason: null,
    documents: [
      {
        documentId: "conformance-document",
        title: "Conformance Fixture",
        pathDigest: null,
        isWorkshared: false,
        isActive: true,
      },
    ],
    activeDocumentId: "conformance-document",
    activeView: {
      documentId: "conformance-document",
      id: "3001",
      name: "Conformance 3D",
      type: "ThreeD",
      level: null,
    },
    disciplineHint: "mechanical",
  };
}

export function productionCaseVariables(
  caseId: string,
  binding: Binding,
  clockIso = "2026-07-23T00:00:00.000Z",
): Readonly<Record<string, JsonValue>> {
  if (!SUPPORTED.has(caseId)) {
    throw new Error(`production case seed is not implemented: ${caseId}`);
  }
  const supportedCase = caseId as SupportedProductionCase;
  const variables: Record<string, JsonValue> = {
    binding,
    clock: { iso: clockIso },
    case: {
      device_token: "test-device-token",
      device_id: "device-01",
    },
    ids: {
      [supportedCase]: invocationIds(supportedCase),
    },
    fixture: {},
    gateway: {},
    vectors: {},
  };
  if (supportedCase === "O1-C05") {
    variables.vectors = {
      document_context: documentContext(clockIso),
    };
  }
  return variables;
}
