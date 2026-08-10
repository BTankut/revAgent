import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function emit(report) {
  const output = argument("--output");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output === undefined) process.stdout.write(serialized);
  else writeFileSync(resolve(output), serialized, "utf8");
}

const execute = process.argv.includes("--execute");
const endpoint = new URL(required("--endpoint"));
if (
  endpoint.protocol !== "https:" ||
  endpoint.pathname !== "/mcp" ||
  endpoint.search !== "" ||
  endpoint.hash !== ""
) {
  throw new Error("--endpoint must be an https URL whose path is exactly /mcp");
}
if (endpoint.username !== "" || endpoint.password !== "") {
  throw new Error("--endpoint must not contain credentials");
}

const clientName = required("--client");
const clientBuild = required("--client-build");
const target = required("--target");
const tokenEnvironmentVariable = required("--token-env");
if (!/^[A-Z][A-Z0-9_]+$/u.test(tokenEnvironmentVariable)) {
  throw new Error("--token-env must name an uppercase environment variable");
}
const expectedTool = argument("--expected-tool", "core.session.status");
const base = {
  schema: "revagent.gw13-live-smoke/v1",
  execute,
  endpoint: endpoint.toString(),
  client: { name: clientName, build: clientBuild },
  target,
  tokenEnvironmentVariable,
  tokenPrinted: false,
  expectedTool,
  boundaries: {
    oauthPassed: false,
    handsOnPassed: false,
    liveRevitPassed: false,
    intendedUse: "post-M3/M5 selected-client and NET01 diagnostic",
  },
};

if (!execute) {
  emit({
    ...base,
    state: "dry_run_ready",
    plannedChecks: [
      "connect to the exact north /mcp endpoint with a caller-supplied bearer credential",
      "read the capability index resource",
      "verify the expected pinned tool is callable",
      "invoke the read-only core.session.status probe",
    ],
    manualObligations: [
      "Record selected Codex Desktop build, OAuth/DCR and token lifecycle evidence separately.",
      "Record visible progress/cancel, Turkish UX, file opening and Revit-visible results separately.",
    ],
  });
} else {
  const token = process.env[tokenEnvironmentVariable];
  if (typeof token !== "string" || token === "") {
    throw new Error(`credential environment variable is absent: ${tokenEnvironmentVariable}`);
  }
  const client = new Client({ name: "revAgent GW-13 live smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    const resources = await client.listResources();
    const capability = resources.resources.find(
      (resource) => resource.uri === "revagent://capability-index",
    );
    if (capability === undefined) throw new Error("capability index resource is absent");
    const capabilityResult = await client.readResource({ uri: capability.uri });
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === expectedTool)) {
      throw new Error(`expected pinned tool is absent: ${expectedTool}`);
    }
    const probe = await client.callTool({ name: expectedTool, arguments: {} });
    if (probe.isError === true) {
      throw new Error(`${expectedTool} returned an MCP error result`);
    }
    emit({
      ...base,
      state: "server_observables_passed",
      observations: {
        protocolEra: client.getProtocolEra(),
        capabilityResourceContentCount: capabilityResult.contents.length,
        callableToolCount: tools.tools.length,
        expectedToolCalled: true,
        probeIsError: false,
      },
    });
  } finally {
    await transport.close();
  }
}
