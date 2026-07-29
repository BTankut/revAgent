import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GatewayDispatcher,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
import {
  type NorthMcpEndpointHandle,
  startNorthMcpEndpoint,
} from "./northMcpEndpoint.js";
import {
  GatewayToolRegistry,
  M2_BOOTSTRAP_TOOL_RECORDS,
  type GatewayToolRecord,
} from "./registry.js";

interface FixtureAddress {
  readonly host: string;
  readonly port: number;
}

interface FixtureLike {
  start(): Promise<FixtureAddress>;
  stop(): Promise<void>;
  getMethodExecutionCount(method: string): number;
}

interface FixtureModule {
  readonly AddinLoopbackFixture: new () => FixtureLike;
}

interface ProbeLike {
  readonly localSessionKey: string;
  readonly sessionCapabilities: readonly string[];
}

interface JournalLike {
  close(): void;
}

interface SimulatorLike {
  registrationForProbe(input: {
    readonly probe: ProbeLike;
    readonly requestId: string;
    readonly userHint: string;
    readonly hostname: string;
    readonly fingerprint: string;
    readonly bridgeVersion: string;
  }): Promise<unknown>;
  attachSession(input: {
    readonly rsid: string;
    readonly resumeToken: string;
    readonly resumeExpiresAt: string;
    readonly grantedSessionCapabilities: readonly string[];
    readonly probe: ProbeLike;
    readonly registration: unknown;
  }): unknown;
  invoke(envelope: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface SimulatorModule {
  readonly ArtifactSpool: new (
    root: string,
    nextId: () => string,
  ) => unknown;
  readonly BridgeSimulator: new (
    journal: JournalLike,
    spool: unknown,
  ) => SimulatorLike;
  readonly DeterministicUuid7Source: new () => {
    next(): string;
  };
  readonly DurableBridgeJournal: new (path: string) => JournalLike;
  readonly discoverAddinSessions: (input: {
    readonly explicitTarget: FixtureAddress;
  }) => Promise<{ readonly sessions: readonly ProbeLike[] }>;
}

const TOKEN = "m2-test-token";
const OTHER_TOKEN = "m2-other-test-token";
const PRINCIPAL_KEY = "tenant-a:user-a";
const RSID = "019f9ac3-ae89-7342-9f6d-b9269e167184";
const REGISTRATION_ID = "019f9ac3-ae89-7342-9f6d-b9269e167185";
const ENVELOPE_ID = "019f9ac3-ae89-7342-9f6d-b9269e167186";
const INVOCATION_ID = "019f9ac3-ae89-7342-9f6d-b9269e167187";
const SCHEMA_PARITY_TOOL_RECORD = Object.freeze({
  name: "core.element.inspect",
  summary: "Inspect one element with bounded optional controls.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "auto",
  executor: "bridge",
  executorMethod: "inspect_element",
  inputSchema: Object.freeze({
    elementId: z
      .string()
      .min(1)
      .max(64)
      .describe("Stable element identifier."),
    includeHidden: z
      .boolean()
      .optional()
      .describe("Include hidden elements when true."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("Maximum result count."),
  }),
  inputJsonSchema: Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: Object.freeze({
      elementId: Object.freeze({
        description: "Stable element identifier.",
        maxLength: 64,
        minLength: 1,
        type: "string",
      }),
      includeHidden: Object.freeze({
        description: "Include hidden elements when true.",
        type: "boolean",
      }),
      limit: Object.freeze({
        description: "Maximum result count.",
        maximum: 25,
        minimum: 1,
        type: "integer",
      }),
    }),
    required: Object.freeze(["elementId"]),
    type: "object",
  }),
} satisfies GatewayToolRecord);

async function loadFixtureModules(): Promise<{
  readonly fixture: FixtureModule;
  readonly simulator: SimulatorModule;
}> {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureUrl = pathToFileURL(
    resolve(
      sourceDirectory,
      "../../addin-loopback-fixture/dist/index.js",
    ),
  ).href;
  const simulatorUrl = pathToFileURL(
    resolve(sourceDirectory, "../../bridge-simulator/dist/index.js"),
  ).href;
  return {
    fixture: (await import(fixtureUrl)) as unknown as FixtureModule,
    simulator: (await import(simulatorUrl)) as unknown as SimulatorModule,
  };
}

function jsonRoundTrip(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value)) as GatewayJsonValue;
}

function jsonObject(value: GatewayJsonValue): GatewayJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bridge simulator outcome must be a JSON object");
  }
  return value as GatewayJsonObject;
}

describe("M2 north MCP first slice", () => {
  it("exposes a registry index and dispatches one tool through the Bridge simulator", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "revagent-gateway-m2-"),
    );
    const modules = await loadFixtureModules();
    const fixture = new modules.fixture.AddinLoopbackFixture();
    let endpoint: NorthMcpEndpointHandle | undefined;
    let client: Client | undefined;
    let clientTransport: StreamableHTTPClientTransport | undefined;
    let simulator: SimulatorLike | undefined;
    let journal: JournalLike | undefined;

    try {
      const address = await fixture.start();
      const discovery = await modules.simulator.discoverAddinSessions({
        explicitTarget: address,
      });
      const probe = discovery.sessions[0];
      if (probe === undefined) {
        throw new Error("Bridge simulator did not discover the fixture");
      }

      journal = new modules.simulator.DurableBridgeJournal(
        join(temporaryRoot, "bridge.db"),
      );
      const ids = new modules.simulator.DeterministicUuid7Source();
      simulator = new modules.simulator.BridgeSimulator(
        journal,
        new modules.simulator.ArtifactSpool(
          join(temporaryRoot, "spool"),
          () => ids.next(),
        ),
      );
      const registration = await simulator.registrationForProbe({
        probe,
        requestId: REGISTRATION_ID,
        userHint: "gateway-test-user",
        hostname: "gateway-test-host",
        fingerprint: "gateway-test-fingerprint",
        bridgeVersion: "gateway-first-slice",
      });
      simulator.attachSession({
        rsid: RSID,
        resumeToken: "gateway-test-resume-token",
        resumeExpiresAt: "2026-07-26T00:00:00.000Z",
        grantedSessionCapabilities: probe.sessionCapabilities,
        probe,
        registration,
      });

      let sequence = 0;
      const bridgeExecutor: GatewayExecutor = {
        binding: "bridge",
        async execute(request): Promise<GatewayExecutorOutcome> {
          sequence += 1;
          const outcome = await simulator!.invoke({
            v: 1,
            type: "invoke",
            id: ENVELOPE_ID,
            rsid: RSID,
            seq: sequence,
            ts: "2026-07-25T20:00:00.000Z",
            payload: {
              invocation_id: INVOCATION_ID,
              method: request.executorMethod,
              params: request.args,
              timeout_ms: 5_000,
              mutating: false,
              mutation_scope: null,
              policy: {
                class: request.policyClass,
                decision: "auto",
                confirmation_id: null,
              },
              verification: null,
              recovery_clearances: [],
            },
          });
          const normalized = jsonObject(jsonRoundTrip(outcome));
          if (
            normalized.kind === "result" &&
            normalized.status === "completed"
          ) {
            return { state: "completed", result: normalized };
          }
          if (
            normalized.kind === "result" &&
            normalized.status === "guarded"
          ) {
            return {
              state: "guarded",
              reason:
                typeof normalized.guardedReason === "string"
                  ? normalized.guardedReason
                  : "Bridge guarded the invocation",
              result: normalized,
            };
          }
          return {
            state: "failed",
            error: {
              code:
                typeof normalized.kind === "string"
                  ? `bridge_${normalized.kind}`
                  : "bridge_invalid_outcome",
              message:
                typeof normalized.message === "string"
                  ? normalized.message
                  : "Bridge did not return a completed or guarded result",
            },
          };
        },
      };

      const registry = new GatewayToolRegistry([
        ...M2_BOOTSTRAP_TOOL_RECORDS,
        SCHEMA_PARITY_TOOL_RECORD,
      ]);
      const dispatcher = new GatewayDispatcher(registry, [bridgeExecutor]);
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        resourceMetadataUrl: new URL(
          "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
        ),
        authenticator: {
          async authenticate(request) {
            const authorization = request.headers.authorization;
            if (
              authorization !== `Bearer ${TOKEN}` &&
              authorization !== `Bearer ${OTHER_TOKEN}`
            ) {
              return null;
            }
            const otherPrincipal =
              authorization === `Bearer ${OTHER_TOKEN}`;
            return {
              principalKey: otherPrincipal
                ? "tenant-a:user-b"
                : PRINCIPAL_KEY,
              authInfo: {
                token: otherPrincipal ? OTHER_TOKEN : TOKEN,
                clientId: "codex-desktop-test",
                scopes: ["mcp:tools"],
                expiresAt: 4_102_444_800,
                resource: new URL("https://gateway.example.test/mcp"),
                extra: {
                  tenantId: "tenant-a",
                  userId: otherPrincipal ? "user-b" : "user-a",
                },
              },
            };
          },
        },
      });

      const unauthorized = await fetch(endpoint.endpoint, { method: "GET" });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain(
        "oauth-protected-resource",
      );

      client = new Client({
        name: "revAgent Gateway first-slice test",
        version: "0.1.0-m2",
      });
      clientTransport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      await client.connect(clientTransport);
      const sessionId = clientTransport.sessionId;
      expect(sessionId).toBeTypeOf("string");

      expect(client.getInstructions()).toBe(registry.capabilityIndexBytes());
      const resources = await client.listResources();
      expect(resources.resources).toEqual([
        expect.objectContaining({
          uri: "revagent://capability-index",
          mimeType: "application/json",
        }),
      ]);
      const capabilityResource = await client.readResource({
        uri: "revagent://capability-index",
      });
      expect(capabilityResource.contents).toEqual([
        expect.objectContaining({
          uri: "revagent://capability-index",
          text: registry.capabilityIndexBytes(),
        }),
      ]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "core.element.inspect",
        "core.ui.state",
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toEqual(
          registry.require(tool.name).inputJsonSchema,
        );
      }
      expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);
      expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(0);

      const oversizedPost = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ oversized: "x".repeat(1024 * 1024) }),
      });
      expect(oversizedPost.status).toBe(413);
      await expect(oversizedPost.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_600 },
        id: null,
      });

      const malformedPost = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "mcp-session-id": sessionId!,
        },
        body: "{",
      });
      expect(malformedPost.status).toBe(400);
      await expect(malformedPost.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_700 },
        id: null,
      });

      const result = await client.callTool({
        name: "core.ui.state",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        state: "completed",
        toolName: "core.ui.state",
        executor: "bridge",
        result: {
          kind: "result",
          status: "completed",
          addinContacted: true,
        },
      });
      expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(1);
      expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);

      const missingSessionCredential = await fetch(endpoint.endpoint, {
        method: "GET",
        headers: { "mcp-session-id": sessionId! },
      });
      expect(missingSessionCredential.status).toBe(401);

      const mismatchedPrincipal = await fetch(endpoint.endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${OTHER_TOKEN}`,
          "mcp-session-id": sessionId!,
        },
      });
      expect(mismatchedPrincipal.status).toBe(404);

      const unknownSession = await fetch(endpoint.endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "mcp-session-id": "unknown-session",
        },
      });
      expect(unknownSession.status).toBe(404);

      await clientTransport.terminateSession();
      await client.close();
      client = undefined;
      clientTransport = undefined;
      await expect
        .poll(() => endpoint?.activeSessionCount() ?? -1)
        .toBe(0);
    } finally {
      await client?.close().catch(() => undefined);
      await clientTransport?.close().catch(() => undefined);
      await endpoint?.close();
      simulator?.close();
      journal?.close();
      await fixture.stop();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
