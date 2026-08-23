import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Invoke,
  MutationScope,
  RbpEnvelope,
  SessionRegister,
} from "@revagent/protocol";

import type {
  HelloEnvelope,
  StaticTokenTable,
  TestTransportConnection,
} from "../src/types.js";

export const TOKEN = "device-token";
export const FINGERPRINT = `sha256:${"1".repeat(64)}`;
export const DIGEST = `sha256:${"2".repeat(64)}`;
export const NOW = "2026-07-22T12:00:00.000Z";

export const tokenTable: StaticTokenTable = {
  [TOKEN]: {
    status: "active",
    deviceId: "device-01",
    tenantId: "tenant-01",
    userId: "user-01",
    seatId: "seat-01",
    machineFingerprint: FINGERPRINT,
    provisionedCapabilities: [
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ],
  },
};

export function uuid7(value: number): string {
  return `0197a3c2-0000-7000-8000-${value.toString().padStart(12, "0")}`;
}

export function hello(id = 1): HelloEnvelope {
  return {
    type: "hello",
    id: uuid7(id),
    ts: NOW,
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [
        "journal_v1",
        "chunked_results",
        "artifact_result_v1",
        "transport_streamable_http",
      ],
      bridge_version: "0.1.0-test",
      device_id: "device-01",
      machine: {
        hostname: "fixture",
        os: "test",
        fingerprint: FINGERPRINT,
      },
      addin_versions: ["0.1.0-test"],
    },
  };
}

export function sessionRegister(): SessionRegister {
  return {
    local_session_key: "local-session-01",
    user_hint: { name: "Test User" },
    machine: { hostname: "fixture", fingerprint: FINGERPRINT },
    revit: { version: "2025", build: "25.0", pid: 1001 },
    addin_version: "0.1.0-test",
    result_contract_version: 1,
    session_capabilities: ["batch_atomic", "doc_context_cached_v1"],
    bridge_version: "0.1.0-test",
    documents: [{
      document_id: "doc-01",
      title: "Fixture",
      path_digest: DIGEST,
      is_workshared: false,
      is_active: true,
    }],
    port: 8080,
  };
}

export function controlEnvelope(type: string, payload: unknown, id: number): RbpEnvelope {
  return {
    v: 1,
    type,
    id: uuid7(id),
    ts: NOW,
    payload,
  } as RbpEnvelope;
}

export function readInvoke(invocationId: string, verification: Invoke["verification"] = null): Invoke {
  return {
    invocation_id: invocationId,
    method: "inspect_fixture",
    params: { value: 1 },
    policy: { class: "auto", decision: "auto", confirmation_id: null },
    mutating: false,
    mutation_scope: null,
    timeout_ms: 5_000,
    verification,
    recovery_clearances: [],
  };
}

export function mutatingInvoke(
  invocationId: string,
  mutationScope: MutationScope,
): Invoke {
  return {
    invocation_id: invocationId,
    method: "mutate_fixture",
    params: { value: 1 },
    policy: { class: "confirm", decision: "confirmed", confirmation_id: uuid7(800) },
    mutating: true,
    mutation_scope: mutationScope,
    timeout_ms: 5_000,
    verification: null,
    recovery_clearances: [],
  };
}

export function resultEnvelope(
  rsid: string,
  invocationId: string,
  seq = 1,
  ack = 1,
  id = 30,
): RbpEnvelope {
  return {
    v: 1,
    type: "result",
    id: uuid7(id),
    rsid,
    seq,
    ack,
    ts: NOW,
    payload: {
      kind: "invocation",
      invocation_id: invocationId,
      status: "completed",
      result: { ok: true },
      replayed: false,
      metrics: {
        execute_ms: 1,
        request_bytes: 2,
        response_bytes: 3,
        framing: "length-prefixed",
      },
    },
  };
}

export async function statePath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `rbp-gateway-${name}-`));
  return join(directory, "state.json");
}

export class MemoryTransport implements TestTransportConnection {
  selectedProtocol = 0;
  active = false;
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly connectionId: string,
    readonly binding: "wss" | "http_sse",
    readonly device: TestTransportConnection["device"],
    readonly offeredProtocols: readonly number[] = [1],
  ) {}

  async sendSerialized(serialized: string): Promise<void> {
    this.sent.push(serialized);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.active = false;
  }
}
