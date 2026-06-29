import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, "..");

function runProbe(env) {
  const script = `
    import { resolveRevitConnectionTarget, getCandidateRevitTargets } from "./build/utils/ConnectionManager.js";
    import { RevitClientConnection } from "./build/utils/SocketClient.js";
    const target = resolveRevitConnectionTarget();
    const candidates = getCandidateRevitTargets({ includeRegistry: false });
    const client = new RevitClientConnection("localhost", 8080, { logErrors: false });
    client.disconnect();
    console.log(JSON.stringify({
      target,
      candidates: candidates.map((item) => ({ host: item.host, port: item.port, source: item.source })),
      framingMode: client.framingMode,
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: runtimeRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...env,
    },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

const preferred = runProbe({
  REVAGENT_HOST: "127.0.0.2",
  REVIT_MCP_HOST: "127.0.0.3",
  REVAGENT_PORT: "7710",
  REVIT_MCP_PORT: "6610",
  REVAGENT_TARGET: "127.0.0.4:7720",
  REVIT_MCP_TARGET: "127.0.0.5:6620",
  REVAGENT_PORTS: "7721,7722",
  REVIT_MCP_PORTS: "6621,6622",
  REVAGENT_INSTANCE_REGISTRY: path.join(process.cwd(), "__missing_revagent_registry.json"),
  REVAGENT_FRAMING: "legacy",
  REVIT_MCP_FRAMING: "length-prefixed",
});
assert.equal(preferred.target.host, "127.0.0.4");
assert.equal(preferred.target.port, 7720);
assert.deepEqual(preferred.candidates.map((item) => item.port), [7721, 7722]);
assert.equal(preferred.candidates[0].host, "127.0.0.2");
assert.equal(preferred.framingMode, "legacy");

const legacy = runProbe({
  REVIT_MCP_HOST: "127.0.1.3",
  REVIT_MCP_PORT: "6630",
  REVIT_MCP_TARGET: "6631",
  REVIT_MCP_PORTS: "6632,6633",
  REVIT_MCP_INSTANCE_REGISTRY: path.join(process.cwd(), "__missing_legacy_registry.json"),
  REVIT_MCP_FRAMING: "legacy",
});
assert.equal(legacy.target.host, "127.0.1.3");
assert.equal(legacy.target.port, 6631);
assert.deepEqual(legacy.candidates.map((item) => item.port), [6632, 6633]);
assert.equal(legacy.framingMode, "legacy");

const defaultPort = runProbe({
  REVAGENT_PORT: "7740",
  REVIT_MCP_PORT: "6640",
  REVAGENT_INSTANCE_REGISTRY: path.join(process.cwd(), "__missing_default_registry.json"),
});
assert.equal(defaultPort.target.port, 7740);

console.log("revAgent environment alias tests passed");
