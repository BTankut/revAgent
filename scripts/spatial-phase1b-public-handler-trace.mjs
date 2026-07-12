#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeRuntimeBuildTreeSha256 } from "../installer/runtime-mcp-server/scripts/spatial-phase1b-runtime-build-hash.mjs";

const COLLECTOR_INVOCATION_SCHEMA = "revagent.spatial.phase1b.public-handler-invocation.v1";
const COLLECTOR_RESULT_SCHEMA = "revagent.spatial.phase1b.public-handler-invocation-result.v1";
const TRACE_SCHEMA = "revagent.spatial.phase1b.public-handler-trace.v2";
const CONTRACT_VERSION = "phase1b-agent-evidence-contract/2.1";
const RESULT_SENTINEL = "REVAGENT_PHASE1B_COLLECTOR_RESULT:";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ALLOWED_TARGET_TOOLS = new Set([
  "capture_spatial_snapshot",
  "query_spatial_context",
  "compare_spatial_snapshots",
  "summarize_spatial_state",
]);

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const runtimeRoot = path.join(repoRoot, "installer", "runtime-mcp-server");
const runtimeBuildHashSourcePath = path.join(runtimeRoot, "scripts", "spatial-phase1b-runtime-build-hash.mjs");
const buildRoot = path.join(runtimeRoot, "build");
const phaseRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "revAgent", "spatial", "phase1b");
const traceRoot = path.join(phaseRoot, "agent-evidence");
const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
const { z } = runtimeRequire("zod");

const moduleDefinitions = Object.freeze({
  get_revit_mcp_status: ["tools/get_revit_mcp_status.js", "registerGetRevitMcpStatusTool"],
  capture_spatial_snapshot: ["tools/capture_spatial_snapshot.js", "registerCaptureSpatialSnapshotTool"],
  query_spatial_context: ["tools/query_spatial_context.js", "registerQuerySpatialContextTool"],
  compare_spatial_snapshots: ["tools/compare_spatial_snapshots.js", "registerCompareSpatialSnapshotsTool"],
  summarize_spatial_state: ["tools/summarize_spatial_state.js", "registerSummarizeSpatialStateTool"],
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function isPathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realExistingFile(candidate, label) {
  requireCondition(path.isAbsolute(candidate), `${label} must be absolute.`);
  requireCondition(!candidate.startsWith("\\\\"), `${label} must be local, not UNC.`);
  requireCondition(fs.existsSync(candidate) && fs.statSync(candidate).isFile(), `${label} was not found.`);
  const real = fs.realpathSync.native(candidate);
  requireCondition(!real.startsWith("\\\\"), `${label} must resolve to a local file.`);
  return real;
}

function requireFixturePath(candidate) {
  const real = realExistingFile(path.resolve(String(candidate || "")), "fixturePath");
  const realPhaseRoot = fs.realpathSync.native(phaseRoot);
  requireCondition(isPathWithin(real, realPhaseRoot), "fixturePath must stay under the local Phase 1b evidence root.");
  requireCondition(!isPathWithin(real, repoRoot), "fixturePath must stay outside the Git repository.");
  return real;
}

function requireDatabasePath(candidate) {
  const real = realExistingFile(path.resolve(String(candidate || "")), "databasePath");
  const realPhaseRoot = fs.realpathSync.native(phaseRoot);
  requireCondition(isPathWithin(real, realPhaseRoot), "databasePath must stay under the local Phase 1b evidence root.");
  requireCondition(!isPathWithin(real, repoRoot), "databasePath must stay outside the Git repository.");
  requireCondition(path.extname(real).toLowerCase() === ".db", "databasePath must identify the explicit Phase 1b SQLite .db file.");
  return real;
}

function requireNewTracePath(candidate, evalId, invocationNonce) {
  fs.mkdirSync(traceRoot, { recursive: true });
  const realRoot = fs.realpathSync.native(traceRoot);
  const absolute = path.resolve(String(candidate || ""));
  requireCondition(!absolute.startsWith("\\\\"), "tracePath must be local, not UNC.");
  requireCondition(path.dirname(absolute) === realRoot, "tracePath must be directly under the local agent-evidence directory.");
  requireCondition(path.basename(absolute) === `eval-${evalId}-${invocationNonce}.json`,
    "tracePath filename must bind evalId and invocationNonce.");
  requireCondition(!fs.existsSync(absolute), "tracePath already exists; collector traces are immutable.");
  return absolute;
}

function registerPublicHandler(register, expectedName) {
  let handler = null;
  let schema = null;
  register({ tool(name, _description, candidateSchema, candidate) {
    if (name === expectedName) {
      handler = candidate;
      schema = candidateSchema;
    }
  } });
  requireCondition(typeof handler === "function", `Missing public handler: ${expectedName}`);
  requireCondition(isObject(schema), `Missing public schema: ${expectedName}`);
  return { handler, schema };
}

function parseToolResult(value) {
  const block = value?.content?.find((item) => item?.type === "text" && typeof item.text === "string");
  requireCondition(block, "Public handler returned no JSON text block.");
  const parsed = JSON.parse(block.text);
  requireCondition(isObject(parsed), "Public handler JSON result must be an object.");
  return parsed;
}

async function loadHandler(tool) {
  const [relativeModulePath, registerName] = moduleDefinitions[tool] || [];
  requireCondition(relativeModulePath && registerName, `Unsupported public handler ${tool}.`);
  const modulePath = path.join(buildRoot, relativeModulePath);
  const loaded = await import(pathToFileURL(modulePath).href);
  return { ...registerPublicHandler(loaded[registerName], tool), modulePath };
}

async function invokeAndRecord(events, tool, registered, request, invocationId, extra = {}) {
  const parsed = z.object(registered.schema).strict().safeParse(request);
  requireCondition(parsed.success,
    `${tool} request failed the real public Zod schema: ${parsed.success ? "" : parsed.error.message}`);
  const startedAtUtc = new Date().toISOString();
  const response = parseToolResult(await registered.handler(parsed.data));
  const finishedAtUtc = new Date().toISOString();
  events.push({
    sequence: events.length + 1,
    tool,
    handlerSurface: "public_mcp_handler",
    invocationIdSha256: sha256(Buffer.from(invocationId, "utf8")),
    request: parsed.data,
    response,
    requestSha256: sha256(Buffer.from(canonicalJson(parsed.data), "utf8")),
    responseSha256: sha256(Buffer.from(canonicalJson(response), "utf8")),
    startedAtUtc,
    finishedAtUtc,
    ...extra,
  });
  return response;
}

function parseInvocation(encoded) {
  requireCondition(typeof encoded === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    "--request-base64 must contain canonical base64 JSON.");
  const bytes = Buffer.from(encoded, "base64");
  requireCondition(bytes.toString("base64") === encoded, "--request-base64 is not canonical base64.");
  const input = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  requireCondition(isObject(input) && input.schemaVersion === COLLECTOR_INVOCATION_SCHEMA,
    `Invocation schemaVersion must be ${COLLECTOR_INVOCATION_SCHEMA}.`);
  const allowedKeys = new Set([
    "schemaVersion", "evalId", "evalCase", "evalCaseSha256", "fixturePath", "fixtureFileSha256",
    "databasePath", "databasePathSha256", "invocationNonce", "tracePath", "endpoint", "tool", "args",
  ]);
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.has(key));
  requireCondition(unexpected.length === 0, `Invocation contains unsupported fields: ${unexpected.join(", ")}.`);
  const evalId = Number(input.evalId);
  requireCondition(Number.isInteger(evalId) && evalId > 0, "evalId must be a positive integer.");
  requireCondition(SHA256_PATTERN.test(String(input.evalCaseSha256 || "")), "evalCaseSha256 is invalid.");
  requireCondition(isObject(input.evalCase)
      && sha256(Buffer.from(canonicalJson(input.evalCase), "utf8")) === input.evalCaseSha256,
  "evalCaseSha256 does not match the exact canonical evalCase payload.");
  requireCondition(SHA256_PATTERN.test(String(input.fixtureFileSha256 || "")), "fixtureFileSha256 is invalid.");
  requireCondition(typeof input.databasePath === "string" && path.isAbsolute(input.databasePath),
    "databasePath must be absolute.");
  requireCondition(SHA256_PATTERN.test(String(input.databasePathSha256 || "")), "databasePathSha256 is invalid.");
  requireCondition(UUID_PATTERN.test(String(input.invocationNonce || "")), "invocationNonce must be a UUID.");
  requireCondition(ALLOWED_TARGET_TOOLS.has(input.tool), `Unsupported target public tool ${input.tool}.`);
  requireCondition(isObject(input.endpoint), "endpoint must be an object.");
  const endpointKeys = Object.keys(input.endpoint);
  requireCondition(endpointKeys.length === 3 && endpointKeys.every((key) => ["target", "host", "port"].includes(key)),
    "endpoint must contain only target, host, and port.");
  requireCondition(input.endpoint.target === "tcp"
      && ["127.0.0.1", "localhost"].includes(String(input.endpoint.host).toLowerCase())
      && Number(input.endpoint.port) === 8080,
  "Phase 1b agent evidence permits only tcp localhost/127.0.0.1 port 8080.");
  requireCondition(isObject(input.args), "args must be an object.");
  if (input.tool !== "compare_spatial_snapshots") {
    requireCondition(input.args.target === input.endpoint.target
        && String(input.args.host).toLowerCase() === String(input.endpoint.host).toLowerCase()
        && Number(input.args.port) === Number(input.endpoint.port),
    `${input.tool} request endpoint must equal the locked local endpoint.`);
  }
  return { ...input, evalId };
}

function collectSnapshotIds(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectSnapshotIds(item, output));
  else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:snapshotId|baseSnapshotId|headSnapshotId)$/u.test(key)
        && typeof child === "string" && child.trim()) output.add(child.trim());
      collectSnapshotIds(child, output);
    }
  }
  return output;
}

async function resolveSnapshotBindings(request, response) {
  const snapshotIds = [...collectSnapshotIds([request, response])].sort();
  requireCondition(snapshotIds.length > 0, "Public target request/response exposed no snapshot identity to bind.");
  const storeModulePath = path.join(buildRoot, "spatial", "spatialStoreManager.js");
  const storeModule = await import(pathToFileURL(storeModulePath).href);
  const store = storeModule.getSpatialStore();
  return snapshotIds.map((snapshotId) => {
    const record = store.getSnapshotRecord(snapshotId);
    requireCondition(record, `Snapshot ${snapshotId} was not found in the executed local spatial store.`);
    const sourceBindingFingerprint = record.captureMetadata?.sourceBindingFingerprint;
    requireCondition(typeof record.documentKey === "string" && record.documentKey
        && SHA256_PATTERN.test(String(record.scopeFingerprint || ""))
        && SHA256_PATTERN.test(String(record.revisionFingerprint || ""))
        && SHA256_PATTERN.test(String(sourceBindingFingerprint || "")),
    `Snapshot ${snapshotId} lacks the required document/scope/source/revision binding.`);
    return {
      snapshotId,
      documentKey: record.documentKey,
      scopeFingerprint: record.scopeFingerprint,
      sourceBindingFingerprint,
      revisionFingerprint: record.revisionFingerprint,
      complete: record.complete === true,
      partial: record.partial === true,
      coverageStatus: record.coverageStatus ?? null,
    };
  });
}

async function invoke(encoded) {
  const input = parseInvocation(encoded);
  const fixturePath = requireFixturePath(input.fixturePath);
  const fixtureFileSha256 = sha256(fs.readFileSync(fixturePath));
  requireCondition(fixtureFileSha256 === input.fixtureFileSha256,
    "fixtureFileSha256 does not match the exact fixture bytes read by the collector.");
  const databasePath = requireDatabasePath(input.databasePath);
  requireCondition(databasePath === input.databasePath
      && sha256(Buffer.from(databasePath, "utf8")) === input.databasePathSha256,
  "databasePath/databasePathSha256 does not bind the canonical Phase 1b SQLite store path.");
  process.env.REVAGENT_SPATIAL_DB_PATH = databasePath;
  const tracePath = requireNewTracePath(input.tracePath, input.evalId, input.invocationNonce);
  const status = await loadHandler("get_revit_mcp_status");
  const target = await loadHandler(input.tool);
  const modulePayloadSha256 = computeRuntimeBuildTreeSha256(runtimeRoot);
  const events = [];
  const statusRequest = {
    target: input.endpoint.target,
    host: input.endpoint.host,
    port: Number(input.endpoint.port),
    timeoutMs: 5000,
    includeRecentTasks: false,
    includeRuntimeActivity: true,
    runtimeActivityLimit: 3,
  };
  const statusResponse = await invokeAndRecord(events, "get_revit_mcp_status", status,
    statusRequest, `${input.invocationNonce}:status`, { preflightFor: input.tool, activeTask: false });
  requireCondition(statusResponse.success !== false && !statusResponse.activeTask,
    `${input.tool} was blocked by a non-clear status preflight.`);
  const response = await invokeAndRecord(events, input.tool, target, input.args,
    `${input.invocationNonce}:target`);
  events[1].state = String(response.state || "");
  requireCondition(response.success === true && ["completed", "guarded"].includes(events[1].state),
    `${input.tool} did not return a successful completed/guarded result.`);
  const snapshotBindings = await resolveSnapshotBindings(events[1].request, response);
  const collectorSourceSha256 = sha256(Buffer.from(canonicalJson([
    { path: "scripts/spatial-phase1b-public-handler-trace.mjs", sha256: sha256(fs.readFileSync(scriptPath)) },
    { path: "installer/runtime-mcp-server/scripts/spatial-phase1b-runtime-build-hash.mjs", sha256: sha256(fs.readFileSync(runtimeBuildHashSourcePath)) },
  ]), "utf8"));
  const trace = {
    schemaVersion: TRACE_SCHEMA,
    evalId: input.evalId,
    evalCaseSha256: input.evalCaseSha256,
    fixtureFileSha256,
    databasePath,
    databasePathSha256: input.databasePathSha256,
    endpoint: input.endpoint,
    capturedAtUtc: new Date().toISOString(),
    collector: {
      name: "spatial-phase1b-public-handler-trace-collector",
      version: CONTRACT_VERSION,
      sourceSha256: collectorSourceSha256,
      runtimeBuildTreeSha256: modulePayloadSha256,
    },
    invocationNonce: input.invocationNonce,
    snapshotBindings,
    events,
  };
  fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const traceBytes = fs.readFileSync(tracePath);
  const traceSha256 = sha256(traceBytes);
  const result = {
    schemaVersion: COLLECTOR_RESULT_SCHEMA,
    evalId: input.evalId,
    evalCaseSha256: input.evalCaseSha256,
    fixtureFileSha256,
    databasePath,
    databasePathSha256: input.databasePathSha256,
    endpoint: input.endpoint,
    invocationNonce: input.invocationNonce,
    tool: input.tool,
    tracePath,
    traceSha256,
    traceByteLength: traceBytes.length,
    collectorSourceSha256,
    runtimeBuildTreeSha256: modulePayloadSha256,
    snapshotBindings,
    response,
    responseSha256: events[1].responseSha256,
    statusRuntimeIdentitySha256: sha256(Buffer.from(canonicalJson(statusResponse.runtimeIdentity ?? null), "utf8")),
    eventResponseSha256: events.map((event) => event.responseSha256),
  };
  process.stdout.write(`${RESULT_SENTINEL}${Buffer.from(canonicalJson(result), "utf8").toString("base64")}\n`);
}

const [command, flag, encoded, ...rest] = process.argv.slice(2);
if (command !== "invoke" || flag !== "--request-base64" || !encoded || rest.length > 0) {
  process.stderr.write("Usage: spatial-phase1b-public-handler-trace.mjs invoke --request-base64 <canonical-base64-json>\n");
  process.exitCode = 2;
} else {
  invoke(encoded).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
