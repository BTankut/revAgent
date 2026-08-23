import { caseProgram } from "./casePrograms.js";
import type { CaseControlStep } from "./casePrograms.js";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

/**
 * The real-trio case executor deliberately has a smaller contract than the
 * legacy supervised runner.  It inventories only operations which can be
 * observed through the public Gateway binding/control surface, the real C#
 * worker, and the add-in loopback fixture.  It must never substitute an
 * in-memory responder for an unavailable operation.
 */
export const REAL_TRIO_CASE_DRIVER_CONTRACT = "rbp-real-trio-case-driver/v1" as const;

export const REAL_TRIO_COMPONENTS = Object.freeze([
  "gateway_production_conformance",
  "bridge_worker",
  "addin_loopback_fixture",
] as const);

export type RealTrioCaseComponent = (typeof REAL_TRIO_COMPONENTS)[number];

export const REAL_TRIO_NORTH_EVIDENCE_SCHEMA = "rbp-real-trio-north-evidence/v1" as const;

/**
 * The only north-tool admission mapping for the four frozen real cases.  It
 * is descriptive rather than a control-plane substitute: the case program,
 * its oracle, and the real worker/fixture remain authoritative.  Keeping the
 * mapping here makes both carriers exercise one identical public MCP path.
 */
export const REAL_TRIO_NORTH_CASE_TOOL_MAP = Object.freeze({
  "O1-C28": Object.freeze({ toolName: "conformance.fixture.c28_mutation", confirmation: true }),
  "O1-C29": Object.freeze({ toolName: "conformance.fixture.c29_atomic_batch", confirmation: true }),
  "O1-C38": Object.freeze({ toolName: "core.ui.state", confirmation: false }),
  "O1-C39": Object.freeze({ toolName: "conformance.fixture.c39_multifile", confirmation: false }),
} as const);

export function realTrioNorthToolForCase(
  caseId: keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP,
): (typeof REAL_TRIO_NORTH_CASE_TOOL_MAP)[keyof typeof REAL_TRIO_NORTH_CASE_TOOL_MAP] {
  return REAL_TRIO_NORTH_CASE_TOOL_MAP[caseId];
}

/** Bearer material is deliberately short-lived in the caller and never copied into evidence. */
export interface RealTrioNorthCredential {
  readonly bearer: string;
  readonly audience: string;
  readonly credentialProvenance: "gateway_production_conformance";
  readonly identityContract: "revagent.auth-context/v1";
}

export interface RealTrioNorthWireEvidence {
  readonly schemaVersion: typeof REAL_TRIO_NORTH_EVIDENCE_SCHEMA;
  readonly requestSha256: `sha256:${string}`;
  readonly responseSha256: `sha256:${string}`;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly statusCode: number;
  readonly effectiveMcpSessionId: string;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Exact, authenticated control payload for the public north bearer route. */
export function issueNorthCredentialControlPayload(): { readonly action: "issue_north_credential" } {
  return Object.freeze({ action: "issue_north_credential" });
}

/**
 * Uses the actual loopback TLS `/mcp` server.  The returned evidence contains
 * only wire hashes and sizes: bearer, JSON-RPC payload and resource paths are
 * intentionally excluded from case artifacts.
 */
export async function callRealTrioNorthMcp(input: {
  readonly endpoint: string;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
  readonly effectiveMcpSessionId: string;
  readonly request: Readonly<Record<string, unknown>>;
}): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
  if (!/^[-A-Za-z0-9._:]{1,512}$/u.test(input.effectiveMcpSessionId)) {
    throw new Error("real trio effective MCP session id is invalid");
  }
  const url = new URL("/mcp", input.endpoint);
  if (url.protocol !== "https:" || url.hostname !== "127.0.0.1" || url.port.length === 0) {
    throw new Error("real trio north MCP endpoint must be numeric loopback TLS");
  }
  const payload = Buffer.from(JSON.stringify(input.request), "utf8");
  return await new Promise((resolve, reject) => {
    const operation = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        authorization: `Bearer ${input.credential.bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": payload.byteLength,
        "mcp-session-id": input.effectiveMcpSessionId,
      },
    }, (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate(true).raw as Buffer | undefined;
      const observed = peer === undefined ? null : sha256(peer);
      if (observed !== input.certificateSha256) {
        response.resume();
        reject(new Error("real trio north MCP TLS pin mismatch"));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        try {
          const text = bytes.toString("utf8");
          const responseValue = text.length === 0 ? null : JSON.parse(text) as unknown;
          resolve(Object.freeze({
            response: responseValue,
            evidence: Object.freeze({
              schemaVersion: REAL_TRIO_NORTH_EVIDENCE_SCHEMA,
              requestSha256: sha256(payload),
              responseSha256: sha256(bytes),
              requestBytes: payload.byteLength,
              responseBytes: bytes.byteLength,
              statusCode: response.statusCode ?? 0,
              effectiveMcpSessionId: input.effectiveMcpSessionId,
            }),
          }));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    operation.once("error", reject);
    operation.end(payload);
  });
}

export interface RealTrioCaseControlSurface {
  /** Operations exposed by the loopback/TLS Gateway conformance control route. */
  readonly gatewayActions: readonly string[];
  /** Operations declared by the real C# worker's strict READY record. */
  readonly bridgeActions: readonly string[];
  /** Operations declared by the fixture's strict JSONL READY record. */
  readonly fixtureActions: readonly string[];
  /** Public, raw carrier operations which can be used without test doubles. */
  readonly bindingActions: readonly string[];
  /** Restart is a supervisor operation, never a process-private mutation. */
  readonly supervisorActions: readonly string[];
}

export interface RealTrioCaseControlGap {
  readonly stepId: string;
  readonly component: RealTrioCaseComponent | "public_binding" | "supervisor";
  readonly action: string;
  readonly reason: "not_exposed" | "not_a_real_trio_component";
}

export class RealTrioCaseControlSurfaceError extends Error {
  public constructor(
    readonly caseId: string,
    readonly gaps: readonly RealTrioCaseControlGap[],
  ) {
    super(`${caseId} cannot run against the real trio: ${gaps.map((gap) => `${gap.component}/${gap.action}@${gap.stepId}`).join(", ")}`);
  }
}

function has(actions: readonly string[], action: string): boolean {
  return actions.includes(action);
}

function componentFor(step: CaseControlStep): RealTrioCaseComponent | "public_binding" | "supervisor" {
  if (step.channel === "gateway_http_control") return "gateway_production_conformance";
  if (step.channel === "bridge_jsonl_control") return "bridge_worker";
  if (step.channel === "fixture_jsonl_control") return "addin_loopback_fixture";
  return step.action === "restart_case_stack" || step.action === "restart_component"
    ? "supervisor"
    : "public_binding";
}

function available(surface: RealTrioCaseControlSurface, component: ReturnType<typeof componentFor>, action: string): boolean {
  switch (component) {
    case "gateway_production_conformance": return has(surface.gatewayActions, action);
    case "bridge_worker": return has(surface.bridgeActions, action);
    case "addin_loopback_fixture": return has(surface.fixtureActions, action);
    case "supervisor": return has(surface.supervisorActions, action);
    case "public_binding": return has(surface.bindingActions, action);
  }
}

/**
 * Checks the frozen parent program without rewriting or eliding a semantic
 * step.  A caller may execute a case only when every original step has a
 * concrete real-process route.  This is the fail-closed boundary which keeps
 * C28/C29/C38/C39 from silently falling back to a stub or simulator.
 */
export function realTrioCaseControlGaps(
  caseId: "O1-C28" | "O1-C29" | "O1-C38" | "O1-C39",
  surface: RealTrioCaseControlSurface,
): readonly RealTrioCaseControlGap[] {
  const program = caseProgram(caseId);
  const gaps: RealTrioCaseControlGap[] = [];
  for (const step of program.steps) {
    const component = componentFor(step);
    if (available(surface, component, step.action)) continue;
    gaps.push(Object.freeze({
      stepId: step.stepId,
      component,
      action: step.action,
      reason: "not_exposed",
    }));
  }
  return Object.freeze(gaps);
}

/** Throws before case execution rather than manufacturing any missing evidence. */
export function assertRealTrioCaseControlSurface(
  caseId: "O1-C28" | "O1-C29" | "O1-C38" | "O1-C39",
  surface: RealTrioCaseControlSurface,
): void {
  const gaps = realTrioCaseControlGaps(caseId, surface);
  if (gaps.length > 0) throw new RealTrioCaseControlSurfaceError(caseId, gaps);
}

/** Current C957 exposed control capabilities, obtained from strict READY/public route contracts. */
export const C957_REAL_TRIO_CONTROL_SURFACE: RealTrioCaseControlSurface = Object.freeze({
  gatewayActions: Object.freeze(["issue_device_credential", "revoke_device", "snapshot_audit"]),
  bridgeActions: Object.freeze(["shutdown"]),
  fixtureActions: Object.freeze(["plan_fault", "release_stall", "apply_document_context", "snapshot_evidence", "shutdown"]),
  bindingActions: Object.freeze([]),
  supervisorActions: Object.freeze([]),
});
