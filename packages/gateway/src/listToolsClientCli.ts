import { measureToolCatalog } from "./toolListProbe.js";

const endpointText = process.argv[2];
if (endpointText === undefined) {
  throw new Error("usage: spike:list-tools <http://127.0.0.1:port/mcp>");
}

const measurement = await measureToolCatalog(new URL(endpointText));
console.log(JSON.stringify(measurement, null, 2));

if (measurement.observedToolCount !== 35) {
  process.exitCode = 2;
}
