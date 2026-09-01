#!/usr/bin/env node
import { FIXTURE_CONTROL_VERSION, FixtureJsonlControl, MAX_CONTROL_LINE_BYTES } from "./control.js";
import { AddinLoopbackFixture } from "./fixture.js";

interface CliOptions {
  host: string;
  port: number;
  maxRequestPayloadBytes?: number;
  allowUnsafeBind?: boolean;
}

function parseInteger(value: string | undefined, option: string): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error(`${option} requires an integer`);
  return Number(value);
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { host: "127.0.0.1", port: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") options.host = args[++index] ?? "";
    else if (arg === "--port") options.port = parseInteger(args[++index], "--port");
    else if (arg === "--max-request-bytes") {
      options.maxRequestPayloadBytes = parseInteger(args[++index], "--max-request-bytes");
    } else if (arg === "--allow-unsafe-bind") {
      options.allowUnsafeBind = true;
    } else {
      throw new Error(`Unknown option: ${String(arg)}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const fixture = new AddinLoopbackFixture(parseArgs(process.argv.slice(2)));
  const address = await fixture.start();
  const control = new FixtureJsonlControl(
    fixture,
    process.stdin,
    process.stdout,
    () => {
      process.exitCode = 0;
    },
  );
  control.start();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    control.close();
    await fixture.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      component: "addin_loopback_fixture",
      contract: "addin-loopback/v1",
      controlVersion: FIXTURE_CONTROL_VERSION,
      maxControlLineBytes: MAX_CONTROL_LINE_BYTES,
      actions: [
        "plan_fault",
        "release_stall",
        "apply_document_context",
        "snapshot_evidence",
        "read_c39_origin_provenance",
        "shutdown",
      ],
      host: address.host,
      port: address.port,
      cacheIncarnationDigest: fixture.snapshotEvidence().documentContextEvidence.cacheIncarnationDigest,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
