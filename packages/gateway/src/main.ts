import { loadGatewayConfig, startupLogFields } from "./config.js";
import { composeProductionM5Identity } from "./productionM5IdentityComposition.js";
import { createFailClosedPorts, startGatewayServer } from "./server.js";

/**
 * The container entry point (GW-2).
 *
 * Deliberately not re-exported from `index.ts`: the image build imports the
 * barrel, and a barrel that pulled this in would start a server at build time.
 *
 * The startup line is built by `startupLogFields`, whose key set is asserted
 * against an allowlist in the test suite. That is what makes "startup contains
 * no LLM, provider or model setting" a mechanical check rather than something
 * a reviewer has to notice.
 */
async function main(): Promise<void> {
  const loaded = loadGatewayConfig(process.env);

  if (!loaded.ok) {
    // One structured line, and every message comes from the frozen value-free
    // table — a rejected DATABASE_URL must not print its own password into a
    // CI log.
    process.stderr.write(
      `${JSON.stringify({
        level: "fatal",
        msg: "gateway.invalid_configuration",
        problems: loaded.problems,
      })}\n`,
    );
    // EX_CONFIG: distinguishable from a crash by an orchestrator.
    process.exit(78);
  }

  const config = loaded.value;
  const failClosedPorts = createFailClosedPorts();
  // EU-20-AUTH-INGRESS: when the M5 Postgres control plane is configured
  // (DATABASE_URL + M5_TOKEN_PEPPER), a real, enrolled Bridge device is
  // authenticated exclusively against it, on both the WSS and HTTP/SSE
  // ingress `ports.rbpIngress` shares one `GatewayBridgeSessionAuthority`
  // for. When it is not configured, `ports.identity` stays the existing
  // fail-closed port — never a silent fallback to a separate store-backed
  // authority (none exists in this composition to fall back to).
  const m5 = composeProductionM5Identity(config);
  const handle = await startGatewayServer({
    config,
    ports:
      m5 === null
        ? failClosedPorts
        : Object.freeze({ ...failClosedPorts, identity: m5.identity }),
    ...(m5 === null ? {} : { m5EnrollmentEntitlement: m5.plane }),
  });

  handle.app.log.info(
    { msg: "gateway.startup", ...startupLogFields(config) },
    "gateway.startup",
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Flip /healthz to 503 before closing so the edge proxy stops sending new
    // traffic while in-flight requests finish.
    handle.beginShutdown();
    handle
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({
            level: "fatal",
            msg: "gateway.shutdown_failed",
            signal,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
