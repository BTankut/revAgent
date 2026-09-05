import { loadGatewayConfig, startupLogFields } from "./config.js";
import { composeProductionGateway } from "./productionGatewayComposition.js";
import { startGatewayServer } from "./server.js";

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
  const handle = await startGatewayServer(await composeProductionGateway(config));

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

try { await main(); }
catch {
  // Startup failures must never serialize a database URL, token, or TLS key.
  process.stderr.write(`${JSON.stringify({ level: "fatal", msg: "gateway.production_startup_refused" })}\n`);
  process.exit(78);
}
