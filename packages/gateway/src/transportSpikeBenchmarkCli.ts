import { measureToolCatalog } from "./toolListProbe.js";
import { startTransportSpike } from "./transportSpike.js";

const iterationsText = process.argv[2] ?? "25";
const iterations = Number.parseInt(iterationsText, 10);
if (
  !Number.isInteger(iterations) ||
  String(iterations) !== iterationsText ||
  iterations < 1 ||
  iterations > 1_000
) {
  throw new RangeError("usage: spike:benchmark [positive integer iterations]");
}

const spike = await startTransportSpike();
try {
  const measurement = await measureToolCatalog(spike.endpoint, iterations);
  const evidence = {
    recordedAtUtc: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    transport: "MCP Streamable HTTP (JSON response mode, loopback)",
    sourceCatalog: "installer/runtime-mcp-server/src/tools/register.ts",
    expectedToolCount: 35,
    ...measurement,
  };
  console.log(JSON.stringify(evidence, null, 2));

  if (measurement.observedToolCount !== 35) {
    process.exitCode = 2;
  }
} finally {
  await spike.close();
}
