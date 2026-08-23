import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  SqliteConformanceProtocolStore,
  createConformanceSupportingPorts,
} from "./conformanceEphemeralAdapters.js";
import { startProductionGatewayHost } from "./productionConformanceHost.js";
import { createConformanceRbpIngressHost } from "./rbpIngress.js";

interface CliOptions {
  readonly root: string;
  readonly certificate: string;
  readonly key: string;
  readonly controlToken: string;
  readonly port: number;
}

function parse(args: readonly string[]): CliOptions {
  if (args.length !== 10) throw new Error("production conformance host requires five --key value pairs");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) throw new Error("invalid production conformance host arguments");
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const rawPort = required("--port");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || values.size !== 5) throw new Error("invalid production conformance host port");
  return Object.freeze({ root: path.resolve(required("--root")), certificate: path.resolve(required("--certificate")), key: path.resolve(required("--key")), controlToken: required("--control-token"), port });
}

function constantTokenEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Executable WP-12 Gateway composition. The admin surface is deliberately
 * loopback/TLS-only and requires an out-of-band test token. It is the sole
 * mutation route for the conformance credential authority; callers cannot
 * reach its in-process store or authority object directly.
 */
export async function runProductionConformanceHostCli(args: readonly string[]): Promise<void> {
  const options = parse(args);
  const [cert, key] = await Promise.all([readFile(options.certificate), readFile(options.key)]);
  const credentials = [{ tenantId: "conformance", userId: "conformance", deviceId: "wp12-device", token: "wp12-device-token" }];
  const identity = new ConformanceCredentialAuthority(credentials);
  const protocolStore = new SqliteConformanceProtocolStore(options.root);
  const opened = await protocolStore.open();
  if (!opened.ok) throw new Error("conformance protocol store did not open");
  const authority = new GatewayBridgeSessionAuthority(protocolStore, identity);
  const ingress = createConformanceRbpIngressHost({ authority });
  const supporting = createConformanceSupportingPorts();
  let stopping = false;
  try {
    const handle = await startProductionGatewayHost({
      hostProfile: "production_conformance",
      authority,
      server: {
        config: {
          nodeEnv: "test",
          logLevel: "fatal",
          http: { bindHost: "127.0.0.1", port: options.port },
          publicUrl: "https://127.0.0.1",
          objectStore: { driver: "fs", root: null },
          credentialsPresent: { databaseUrl: false },
          ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
        },
        tls: { cert, key },
      },
      ports: {
        identity,
        protocolStore,
        objectStore: new DigestFileConformanceObjectStore(options.root),
        entitlement: supporting.entitlement,
        events: supporting.events,
        guardrails: supporting.guardrails,
        rbpIngress: ingress,
      },
      mountConformanceControl(app) {
        app.post("/__conformance/v1/control", async (request, reply) => {
          if (!constantTokenEquals(request.headers["x-rbp-test-control"], options.controlToken)) return reply.code(401).send({ ok: false, error: "unauthorized" });
          const body = request.body as { action?: unknown } | null;
          const action = body?.action;
          if (action === "issue_device_credential") {
            const credential = credentials[0]!;
            const proof = identity.issue(credential.deviceId);
            return reply.send({ ok: true, action, deviceId: credential.deviceId, deviceToken: credential.token, deviceProof: proof, audit: identity.audit() });
          }
          if (action === "revoke_device") {
            const credential = credentials[0]!;
            const revoked = identity.revoke(credential.deviceId);
            return reply.send({ ok: true, action, revoked, audit: identity.audit() });
          }
          if (action === "snapshot_audit") {
            const sessions = await protocolStore.transact(
              { tenantId: "conformance" },
              async (tx) => await tx.list("gateway.rbp-session/v2"),
            );
            if (!sessions.ok) {
              return reply.code(503).send({ ok: false, action, error: "session_audit_unavailable" });
            }
            return reply.send({ ok: true, action, audit: identity.audit(), sessions: sessions.value });
          }
          return reply.code(400).send({ ok: false, error: "invalid_action" });
        });
      },
    });
    const close = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      handle.beginShutdown();
      await handle.close();
    };
    const stopped = new Promise<void>((resolve, reject) => {
      process.once("SIGTERM", () => { void close().then(resolve, reject); });
      process.once("SIGINT", () => { void close().then(resolve, reject); });
      if (process.send !== undefined) process.on("message", (message: unknown) => {
        if ((message as { action?: unknown })?.action === "emit_test_signal") void close().then(resolve, reject);
      });
    });
    // Register STOP before publishing READY: a parent which stops immediately
    // after the ready line must still observe a normal close rather than a
    // signal-terminated child.
    // C# pins the DER certificate returned by TLS, not the PEM transport file.
    const certificateSha256 = `sha256:${createHash("sha256").update(new X509Certificate(cert).raw).digest("hex")}`;
    process.stdout.write(`${JSON.stringify({ ready: true, component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1", endpoint: `https://127.0.0.1:${String(handle.port)}`, tlsCertificateSha256: certificateSha256, controlPath: "/__conformance/v1/control", pid: process.pid })}\n`);
    await stopped;
    // An IPC channel is supplied only by the Windows supervision harness. It
    // keeps Node's event loop alive after an otherwise clean app close unless
    // it is explicitly released.
    if (process.connected) process.disconnect();
  } finally {
    await protocolStore.close();
  }
}

if (process.argv[1]?.endsWith("productionConformanceHostCli.js")) {
  void runProductionConformanceHostCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`production-conformance-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  });
}
