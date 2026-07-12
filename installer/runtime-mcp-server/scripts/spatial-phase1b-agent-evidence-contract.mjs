import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { computeRuntimeBuildTreeSha256 } from "./spatial-phase1b-runtime-build-hash.mjs";

export const AGENT_EVIDENCE_SCHEMA = "revagent.spatial.phase1b.agent-evals.v2";
export const AGENT_EVIDENCE_ASSEMBLY_SCHEMA = "revagent.spatial.phase1b.agent-evidence-assembly.v1";
export const PUBLIC_HANDLER_TRACE_SCHEMA = "revagent.spatial.phase1b.public-handler-trace.v2";
export const PUBLIC_HANDLER_INVOCATION_SCHEMA = "revagent.spatial.phase1b.public-handler-invocation.v1";
export const PUBLIC_HANDLER_INVOCATION_RESULT_SCHEMA = "revagent.spatial.phase1b.public-handler-invocation-result.v1";
export const AGENT_EVIDENCE_CONTRACT_VERSION = "phase1b-agent-evidence-contract/2.1";
export const REQUIRED_AGENT_EVAL_GROUPS = Object.freeze([1, 2, 4, 5, 6]);

const CONTRACT_SOURCE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT_FROM_CONTRACT = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(path.dirname(CONTRACT_SOURCE_PATH), "..", "..", "..");
export const PUBLIC_HANDLER_COLLECTOR_PATH = path.join(REPO_ROOT_FROM_CONTRACT,
  "scripts", "spatial-phase1b-public-handler-trace.mjs");
const RUNTIME_BUILD_HASH_SOURCE_PATH = path.join(path.dirname(CONTRACT_SOURCE_PATH),
  "spatial-phase1b-runtime-build-hash.mjs");
export const AGENT_EVIDENCE_CONTRACT_SOURCE_SHA256 = sha256(fs.readFileSync(CONTRACT_SOURCE_PATH));
export const PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256 = sha256(Buffer.from(canonicalJson([
  { path: "scripts/spatial-phase1b-public-handler-trace.mjs", sha256: sha256(fs.readFileSync(PUBLIC_HANDLER_COLLECTOR_PATH)) },
  { path: "installer/runtime-mcp-server/scripts/spatial-phase1b-runtime-build-hash.mjs", sha256: sha256(fs.readFileSync(RUNTIME_BUILD_HASH_SOURCE_PATH)) },
]), "utf8"));
export const COLLECTOR_RESULT_SENTINEL = "REVAGENT_PHASE1B_COLLECTOR_RESULT:";
export const AGENT_EVAL_TRIGGER_MARKER = "REVAGENT_PHASE1B_AGENT_EVAL:";
export const AGENT_EVAL_CASE_MARKER = "REVAGENT_PHASE1B_EVAL_CASE:";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ALLOWED_PUBLIC_TOOLS = new Set([
  "get_revit_mcp_status",
  "capture_spatial_snapshot",
  "query_spatial_context",
  "compare_spatial_snapshots",
  "summarize_spatial_state",
]);
const ALLOWED_TARGET_TOOLS = new Set([...ALLOWED_PUBLIC_TOOLS]
  .filter((tool) => tool !== "get_revit_mcp_status"));
const LEGACY_TRUST_FIELDS = new Set([
  "actualAgentRun",
  "passed",
  "toolTracePassed",
  "forbiddenClaimCheckPassed",
  "claimAudit",
  "agent-response-attestation.v1",
]);
const FAIL_CLOSED_CURRENT_STATE_VARIANTS = new Set([
  "no_in_session_snapshot",
  "partial_snapshot",
  "stale_current_state",
  "unknown_liveness",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(cleanText)
    .filter((value) => value !== null))];
}

function assertOnlyKeys(value, allowed, label) {
  requireCondition(isObject(value), `${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  requireCondition(unexpected.length === 0, `${label} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function rejectLegacyTrustFields(value, label) {
  if (!isObject(value)) return;
  const present = Object.keys(value).filter((key) => LEGACY_TRUST_FIELDS.has(key));
  requireCondition(present.length === 0,
    `${label} contains forbidden self-declared trust fields: ${present.join(", ")}.`);
}

export function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function exactTimestamp(value, label) {
  requireCondition(typeof value === "string" && value.trim(), `${label} is required.`);
  const milliseconds = Date.parse(value);
  requireCondition(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value,
    `${label} must be an exact UTC ISO-8601 timestamp.`);
  return milliseconds;
}

function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveExternalArtifactPath(value, repositoryRoot, label, mustExist = true) {
  requireCondition(typeof value === "string" && value.trim() && path.isAbsolute(value),
    `${label} must be an absolute path.`);
  const requested = path.resolve(value);
  requireCondition(!requested.startsWith("\\\\"), `${label} must not be a UNC/network path.`);
  const exists = fs.existsSync(requested);
  if (mustExist) {
    requireCondition(exists && fs.statSync(requested).isFile(), `${label} file was not found: ${requested}`);
  }
  let effective;
  if (exists) {
    effective = fs.realpathSync.native(requested);
    requireCondition(!mustExist || fs.statSync(effective).isFile(), `${label} file was not found: ${effective}`);
  } else {
    requireCondition(!mustExist, `${label} file was not found: ${requested}`);
    const requestedParent = path.dirname(requested);
    requireCondition(fs.existsSync(requestedParent) && fs.statSync(requestedParent).isDirectory(),
      `${label} parent directory was not found: ${requestedParent}`);
    const realParent = fs.realpathSync.native(requestedParent);
    effective = path.join(realParent, path.basename(requested));
  }
  requireCondition(!effective.startsWith("\\\\"), `${label} must resolve locally.`);
  const realRepositoryRoot = fs.realpathSync.native(repositoryRoot);
  requireCondition(!isPathWithin(effective, realRepositoryRoot), `${label} must stay outside the Git repository.`);
  return effective;
}

function resolveInputPath(value, baseDirectory, label, options = {}) {
  requireCondition(typeof value === "string" && value.trim(), `${label} is required.`);
  const candidate = path.resolve(baseDirectory, value);
  requireCondition(path.isAbsolute(candidate), `${label} must resolve to an absolute path.`);
  requireCondition(!candidate.startsWith("\\\\"), `${label} must not be a UNC/network path.`);
  const exists = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  const resolved = exists ? fs.realpathSync.native(candidate) : candidate;
  requireCondition(!resolved.startsWith("\\\\"), `${label} must not resolve to a UNC/network path.`);
  if (options.outsideRoot) {
    requireCondition(!isPathWithin(resolved, options.outsideRoot), `${label} must stay outside the Git repository.`);
  }
  if (options.mustExist !== false) {
    requireCondition(exists, `${label} file was not found: ${resolved}`);
  }
  return resolved;
}

function readStableBytes(filePath, label) {
  const before = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  requireCondition(before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === after.size,
    `${label} changed while it was being read; wait for the completed agent turn and retry.`);
  requireCondition(bytes.length > 0, `${label} must not be empty.`);
  return bytes;
}

function objectField(value, camelName) {
  if (!isObject(value)) return undefined;
  if (Object.hasOwn(value, camelName)) return value[camelName];
  const pascalName = `${camelName[0].toUpperCase()}${camelName.slice(1)}`;
  return value[pascalName];
}

function collectNestedStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectNestedStrings(item, output));
  else if (isObject(value)) Object.values(value).forEach((item) => collectNestedStrings(item, output));
  return output;
}

function messageText(payload) {
  if (typeof payload?.content === "string") return payload.content;
  if (!Array.isArray(payload?.content)) return "";
  return payload.content.map((item) => {
    if (!isObject(item)) return "";
    return typeof item.text === "string" ? item.text
      : typeof item.input_text === "string" ? item.input_text
        : typeof item.output_text === "string" ? item.output_text : "";
  }).join("");
}

function agentMessageText(payload) {
  if (typeof payload?.content === "string") return payload.content;
  if (Array.isArray(payload?.content)) return messageText(payload);
  return "";
}

export function phase1bEvalCasePayload(evalEntry) {
  return {
    id: Number(evalEntry.id),
    protocol_eval: Number(evalEntry.protocol_eval),
    variant: String(evalEntry.variant || ""),
    prompt: String(evalEntry.prompt || ""),
    context: evalEntry.context ?? {},
    expected_output: evalEntry.expected_output ?? "",
    files: evalEntry.files ?? [],
    required_tool_calls: cleanStrings(evalEntry.required_tool_calls),
    forbidden_tool_calls: cleanStrings(evalEntry.forbidden_tool_calls),
    hard_fail_if: evalEntry.hard_fail_if ?? [],
    assertions: evalEntry.assertions ?? [],
  };
}

export function phase1bEvalCaseSha256(evalEntry) {
  return sha256(Buffer.from(canonicalJson(phase1bEvalCasePayload(evalEntry)), "utf8"));
}

export function requiredPhase1bAgentEvals(evalDocument) {
  requireCondition(isObject(evalDocument) && Array.isArray(evalDocument.evals),
    "evals.json must contain an evals array.");
  const entries = evalDocument.evals
    .filter((entry) => entry?.suite === "spatial_grounding_phase1b"
      && REQUIRED_AGENT_EVAL_GROUPS.includes(Number(entry.protocol_eval)))
    .map((entry) => ({
      ...entry,
      id: Number(entry.id),
      protocol_eval: Number(entry.protocol_eval),
      variant: String(entry.variant || ""),
      prompt: String(entry.prompt || ""),
      required_tool_calls: cleanStrings(entry.required_tool_calls),
      forbidden_tool_calls: cleanStrings(entry.forbidden_tool_calls),
    }))
    .sort((left, right) => left.id - right.id);
  requireCondition(entries.length === 11,
    "The repository must define exactly 11 required Spatial Grounding Protocol Phase 1b variants.");
  requireCondition(new Set(entries.map((entry) => entry.id)).size === entries.length,
    "Required Phase 1b eval ids must be unique.");
  requireCondition(new Set(entries.map((entry) => `${entry.protocol_eval}:${entry.variant}`)).size === entries.length,
    "Required Phase 1b eval group/variant pairs must be unique.");
  for (const entry of entries) {
    requireCondition(Number.isInteger(entry.id) && entry.id > 0, "Every required eval needs a positive id.");
    requireCondition(entry.variant && entry.prompt, `Eval ${entry.id} needs variant and prompt text.`);
    requireCondition(entry.required_tool_calls.length > 0,
      `Eval ${entry.id}/${entry.variant} must declare at least one required_tool_calls entry.`);
    for (const tool of entry.required_tool_calls) {
      requireCondition(ALLOWED_PUBLIC_TOOLS.has(tool),
        `Eval ${entry.id}/${entry.variant} names unsupported public tool ${tool}.`);
    }
    requireCondition(entry.forbidden_tool_calls.length > 0,
      `Eval ${entry.id}/${entry.variant} must declare forbidden_tool_calls for raw/write/deploy surfaces.`);
    for (const tool of entry.forbidden_tool_calls) {
      requireCondition(/^[a-zA-Z0-9_.:-]+$/.test(tool),
        `Eval ${entry.id}/${entry.variant} forbidden tool name ${tool} is invalid.`);
    }
  }
  return entries;
}

function normalizePublicHandlerTrace(source, evalEntry, sourceTraceSha256, fixtureFileSha256) {
  const evalId = Number(evalEntry.id);
  const evalCaseSha256 = phase1bEvalCaseSha256(evalEntry);
  requireCondition(isObject(source), "Public-handler trace must be an object.");
  rejectLegacyTrustFields(source, "public-handler trace");
  requireCondition(source.schemaVersion === PUBLIC_HANDLER_TRACE_SCHEMA,
    `Public-handler trace schemaVersion must be ${PUBLIC_HANDLER_TRACE_SCHEMA}; legacy raw-agent-run-trace and agent-response-attestation inputs are forbidden.`);
  assertOnlyKeys(source, new Set([
    "schemaVersion", "evalId", "evalCaseSha256", "fixtureFileSha256", "capturedAtUtc",
    "databasePath", "databasePathSha256", "endpoint", "collector", "invocationNonce", "snapshotBindings", "events",
  ]), "public-handler trace");
  requireCondition(Number(source.evalId) === evalId, `Public-handler trace evalId must be ${evalId}.`);
  requireCondition(source.evalCaseSha256 === evalCaseSha256,
    `Public-handler trace is not bound to the exact eval ${evalId} case bytes.`);
  requireCondition(source.fixtureFileSha256 === fixtureFileSha256,
    `Public-handler trace is not bound to the exact frozen fixture bytes.`);
  requireCondition(typeof source.databasePath === "string" && path.isAbsolute(source.databasePath)
      && SHA256_PATTERN.test(String(source.databasePathSha256 || ""))
      && source.databasePathSha256 === sha256(Buffer.from(source.databasePath, "utf8")),
  "Public-handler trace database path binding is invalid.");
  exactTimestamp(source.capturedAtUtc, "public-handler trace capturedAtUtc");
  requireCondition(isObject(source.endpoint)
      && source.endpoint.target === "tcp"
      && ["127.0.0.1", "localhost"].includes(String(source.endpoint.host).toLowerCase())
      && Number(source.endpoint.port) === 8080,
  "Public-handler trace endpoint is not the locked local Phase 1b endpoint.");
  assertOnlyKeys(source.collector, new Set([
    "name", "version", "sourceSha256", "runtimeBuildTreeSha256",
  ]), "public-handler trace collector");
  requireCondition(source.collector?.name === "spatial-phase1b-public-handler-trace-collector"
      && source.collector?.version === AGENT_EVIDENCE_CONTRACT_VERSION
      && source.collector?.sourceSha256 === PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256
      && SHA256_PATTERN.test(String(source.collector?.runtimeBuildTreeSha256 || "")),
  "Public-handler trace collector identity/source/runtime payload is invalid.");
  requireCondition(UUID_PATTERN.test(String(source.invocationNonce || "")),
    "Public-handler trace invocationNonce must be a UUID.");
  const sourceEntries = source.events;
  requireCondition(Array.isArray(sourceEntries) && sourceEntries.length === 2,
    "Each immutable public-handler trace must contain exactly one status preflight and one target call.");
  let previousFinishedAt = null;
  const entries = sourceEntries.map((entry, index) => {
    const label = `public-handler trace[${index}]`;
    requireCondition(isObject(entry), `${label} must be an object.`);
    assertOnlyKeys(entry, new Set([
      "sequence", "tool", "handlerSurface", "invocationIdSha256", "request", "response",
      "requestSha256", "responseSha256", "startedAtUtc", "finishedAtUtc",
      "activeTask", "preflightFor", "state",
    ]), label);
    rejectLegacyTrustFields(entry, label);
    requireCondition(Number(entry.sequence) === index + 1, `${label}.sequence is invalid.`);
    const tool = cleanText(entry.tool);
    requireCondition(tool && ALLOWED_PUBLIC_TOOLS.has(tool), `${label}.tool is not allowed.`);
    requireCondition(entry.handlerSurface === "public_mcp_handler", `${label} is not a public MCP handler trace.`);
    requireCondition(isObject(entry.request) && isObject(entry.response), `${label} requires request and response objects.`);
    const requestSha256 = sha256(Buffer.from(canonicalJson(entry.request), "utf8"));
    const responseSha256 = sha256(Buffer.from(canonicalJson(entry.response), "utf8"));
    requireCondition(entry.requestSha256 === requestSha256, `${label}.requestSha256 is invalid.`);
    requireCondition(entry.responseSha256 === responseSha256, `${label}.responseSha256 is invalid.`);
    const startedAt = exactTimestamp(entry.startedAtUtc, `${label}.startedAtUtc`);
    const finishedAt = exactTimestamp(entry.finishedAtUtc, `${label}.finishedAtUtc`);
    requireCondition(finishedAt >= startedAt, `${label} has reversed timestamps.`);
    requireCondition(previousFinishedAt === null || startedAt >= previousFinishedAt,
      `${label} overlaps or precedes the prior public-handler call.`);
    previousFinishedAt = finishedAt;
    const responseSuccess = objectField(entry.response, "success");
    const activeTask = objectField(entry.response, "activeTask");
    const state = objectField(entry.response, "state");
    if (tool === "get_revit_mcp_status") {
      const nextTool = sourceEntries[index + 1]?.tool;
      requireCondition(responseSuccess !== false && !activeTask,
        `${label} is not a successful clear status preflight.`);
      requireCondition(nextTool && nextTool !== "get_revit_mcp_status" && entry.preflightFor === nextTool,
        `${label} preflightFor does not bind the immediately following public call.`);
    } else {
      requireCondition(responseSuccess === true && ["completed", "guarded"].includes(String(state)),
        `${label} did not return a successful completed/guarded result.`);
      const preflight = sourceEntries[index - 1];
      requireCondition(preflight?.tool === "get_revit_mcp_status" && preflight.preflightFor === tool,
        `${label} lacks an immediately preceding matching status preflight.`);
    }
    return {
      sequence: index + 1,
      tool,
      handlerSurface: "public_mcp_handler",
      traceEntryIdSha256: sha256(Buffer.from(`${sourceTraceSha256}:${index + 1}`, "utf8")),
      ...(SHA256_PATTERN.test(String(entry.invocationIdSha256 || ""))
        ? { invocationIdSha256: entry.invocationIdSha256 } : {}),
      request: entry.request,
      response: entry.response,
      requestSha256,
      responseSha256,
      startedAtUtc: entry.startedAtUtc,
      finishedAtUtc: entry.finishedAtUtc,
      ...(tool === "get_revit_mcp_status"
        ? { activeTask: false, preflightFor: entry.preflightFor }
        : { state: String(state) }),
    };
  });
  const snapshotBindings = (Array.isArray(source.snapshotBindings) ? source.snapshotBindings : [])
    .map((binding, index) => {
      const label = `public-handler snapshotBinding[${index}]`;
      assertOnlyKeys(binding, new Set([
        "snapshotId", "documentKey", "scopeFingerprint", "sourceBindingFingerprint",
        "revisionFingerprint", "complete", "partial", "coverageStatus",
      ]), label);
      requireCondition(typeof binding.snapshotId === "string" && binding.snapshotId
          && typeof binding.documentKey === "string" && binding.documentKey
          && SHA256_PATTERN.test(String(binding.scopeFingerprint || ""))
          && SHA256_PATTERN.test(String(binding.sourceBindingFingerprint || ""))
          && SHA256_PATTERN.test(String(binding.revisionFingerprint || ""))
          && typeof binding.complete === "boolean" && typeof binding.partial === "boolean"
          && (binding.coverageStatus === null || typeof binding.coverageStatus === "string"),
      `${label} is incomplete or invalid.`);
      return binding;
    });
  requireCondition(snapshotBindings.length > 0, "Public-handler trace has no store-derived snapshot binding.");
  return {
    sourceSchemaVersion: source.schemaVersion,
    evalCaseSha256,
    fixtureFileSha256,
    databasePath: source.databasePath,
    databasePathSha256: source.databasePathSha256,
    endpoint: source.endpoint,
    invocationNonce: source.invocationNonce,
    runtimeBuildTreeSha256: source.collector.runtimeBuildTreeSha256,
    snapshotBindings,
    entries,
  };
}

function encodeCollectorInvocation(invocation) {
  return Buffer.from(canonicalJson(invocation), "utf8").toString("base64");
}

function validateTargetSnapshotProvenance(targetEntry, snapshotBindings, evalEntry) {
  const bindingMap = new Map(snapshotBindings.map((binding) => [binding.snapshotId, binding]));
  requireCondition(bindingMap.size === snapshotBindings.length,
    `Eval ${evalEntry.id} store-derived snapshot bindings contain duplicate snapshot ids.`);
  const request = targetEntry.request;
  const response = targetEntry.response;
  const requireBinding = (snapshotId, role) => {
    requireCondition(typeof snapshotId === "string" && snapshotId.length > 0 && bindingMap.has(snapshotId),
      `Eval ${evalEntry.id} ${role} snapshot id is not bound to the same local store record.`);
    return bindingMap.get(snapshotId);
  };
  const requireResponseBinding = (value, binding, role, options = {}) => {
    requireCondition(objectField(value, "snapshotId") === binding.snapshotId
        && objectField(value, "revisionFingerprint") === binding.revisionFingerprint
        && objectField(value, "scopeFingerprint") === binding.scopeFingerprint,
    `Eval ${evalEntry.id} ${role} response snapshot/revision/scope differs from its store binding.`);
    if (options.sourceBinding) {
      requireCondition(objectField(value, "sourceBindingFingerprint") === binding.sourceBindingFingerprint,
        `Eval ${evalEntry.id} ${role} response source binding differs from its store binding.`);
    }
  };

  if (["query_spatial_context", "summarize_spatial_state"].includes(targetEntry.tool)) {
    requireCondition(snapshotBindings.length === 1,
      `Eval ${evalEntry.id} ${targetEntry.tool} must bind exactly one snapshot.`);
    const requestSnapshotId = objectField(request, "snapshotId");
    const binding = requireBinding(requestSnapshotId, "request");
    const responseSnapshotId = objectField(response, "snapshotId");
    if (objectField(response, "state") === "completed" && objectField(response, "guarded") === false) {
      requireResponseBinding(response, binding, "completed query/summary");
    } else if (responseSnapshotId !== undefined) {
      requireCondition(responseSnapshotId === binding.snapshotId,
        `Eval ${evalEntry.id} guarded response snapshot differs from its request/store binding.`);
      for (const [field, expected] of [
        ["revisionFingerprint", binding.revisionFingerprint],
        ["scopeFingerprint", binding.scopeFingerprint],
      ]) {
        const observed = objectField(response, field);
        if (observed !== undefined) requireCondition(observed === expected,
          `Eval ${evalEntry.id} guarded response ${field} differs from its store binding.`);
      }
    }
    return;
  }

  if (targetEntry.tool === "capture_spatial_snapshot") {
    requireCondition(snapshotBindings.length === 1,
      `Eval ${evalEntry.id} capture must bind exactly one committed snapshot.`);
    const binding = snapshotBindings[0];
    requireResponseBinding(response, binding, "capture", { sourceBinding: true });
    const snapshot = objectField(response, "snapshot");
    requireCondition(isObject(snapshot), `Eval ${evalEntry.id} capture response has no nested snapshot provenance.`);
    requireResponseBinding(snapshot, binding, "nested capture", { sourceBinding: true });
    requireCondition(objectField(response, "partial") === binding.partial
        && objectField(response, "coverageStatus") === binding.coverageStatus
        && objectField(snapshot, "partial") === binding.partial
        && objectField(snapshot, "coverageStatus") === binding.coverageStatus,
    `Eval ${evalEntry.id} capture coverage differs from its store binding.`);
    return;
  }

  if (targetEntry.tool === "compare_spatial_snapshots") {
    requireCondition(snapshotBindings.length === 2,
      `Eval ${evalEntry.id} compare must bind exactly two snapshots.`);
    const baseSnapshotId = objectField(request, "baseSnapshotId");
    const headSnapshotId = objectField(request, "headSnapshotId");
    requireCondition(baseSnapshotId !== headSnapshotId,
      `Eval ${evalEntry.id} compare base/head snapshot ids must be distinct.`);
    const baseBinding = requireBinding(baseSnapshotId, "base request");
    const headBinding = requireBinding(headSnapshotId, "head request");
    requireCondition(objectField(response, "baseSnapshotId") === baseBinding.snapshotId
        && objectField(response, "baseRevisionFingerprint") === baseBinding.revisionFingerprint
        && objectField(response, "headSnapshotId") === headBinding.snapshotId
        && objectField(response, "headRevisionFingerprint") === headBinding.revisionFingerprint
        && objectField(response, "scopeFingerprint") === baseBinding.scopeFingerprint
        && objectField(response, "scopeFingerprint") === headBinding.scopeFingerprint,
    `Eval ${evalEntry.id} compare response base/head provenance differs from its role-bound store records.`);
    return;
  }

  requireCondition(false, `Eval ${evalEntry.id} target tool has no snapshot provenance policy.`);
}

export function buildPublicHandlerCollectorExecSource(invocation, options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT_FROM_CONTRACT);
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const collectorPath = path.join(repoRoot, "scripts", "spatial-phase1b-public-handler-trace.mjs");
  const encoded = encodeCollectorInvocation(invocation);
  const command = `& "${nodeExecutable}" "${collectorPath}" invoke --request-base64 "${encoded}"`;
  return `const r = await tools.shell_command(${JSON.stringify({
    command,
    workdir: repoRoot,
    timeout_ms: Number(options.timeoutMs ?? 120000),
  })}); text(r)`;
}

function parseCollectorExecSource(source, repoRoot) {
  requireCondition(typeof source === "string", "Platform exec input must be JavaScript source text.");
  const normalizedSource = source.endsWith("\r\n") ? source.slice(0, -2)
    : source.endsWith("\n") ? source.slice(0, -1) : source;
  requireCondition(!/[\r\n]$/u.test(normalizedSource),
    "Permanent collector exec wrapper may contain at most one terminal LF or CRLF serialization boundary.");
  const prefix = "const r = await tools.shell_command(";
  const suffix = "); text(r)";
  requireCondition(normalizedSource.startsWith(prefix) && normalizedSource.endsWith(suffix),
    "Agent turn contains an unapproved exec wrapper; only the permanent public-handler collector is allowed.");
  const serialized = normalizedSource.slice(prefix.length, -suffix.length);
  let args;
  try {
    args = JSON.parse(serialized);
  } catch {
    throw new Error("Permanent collector exec wrapper must use one canonical JSON shell_command argument.");
  }
  assertOnlyKeys(args, new Set(["command", "workdir", "timeout_ms"]), "collector shell_command args");
  requireCondition(path.resolve(String(args.workdir || "")) === path.resolve(repoRoot),
    "Permanent collector must run from the exact Git repository root.");
  requireCondition(Number.isInteger(args.timeout_ms) && args.timeout_ms >= 10000 && args.timeout_ms <= 300000,
    "Permanent collector timeout_ms is outside the approved range.");
  const escapedNode = process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expectedCollector = path.join(path.resolve(repoRoot), "scripts", "spatial-phase1b-public-handler-trace.mjs");
  const escapedCollector = expectedCollector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^& "${escapedNode}" "${escapedCollector}" invoke --request-base64 "([A-Za-z0-9+/]+={0,2})"$`).exec(args.command);
  requireCondition(match,
    "shell_command is not the exact permanent collector command or contains extra shell operations.");
  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  requireCondition(bytes.toString("base64") === encoded, "Collector request base64 is not canonical.");
  let invocation;
  try {
    invocation = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Collector request base64 does not contain JSON.");
  }
  return { args, invocation, encodedSha256: sha256(Buffer.from(encoded, "utf8")) };
}

function parseCollectorResult(output, evalId) {
  const strings = collectNestedStrings(output);
  requireCondition(strings.some((value) => /Exit code:\s*0\b/iu.test(value)),
    `Eval ${evalId} collector platform output did not report exit code 0.`);
  const encodedResults = [];
  for (const value of strings) {
    for (const line of String(value).split(/\r?\n/)) {
      const markerIndex = line.indexOf(COLLECTOR_RESULT_SENTINEL);
      if (markerIndex >= 0) encodedResults.push(line.slice(markerIndex + COLLECTOR_RESULT_SENTINEL.length).trim());
    }
  }
  requireCondition(encodedResults.length === 1,
    `Eval ${evalId} collector platform output must contain exactly one bound result sentinel.`);
  const encoded = encodedResults[0];
  requireCondition(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), `Eval ${evalId} collector result is not base64.`);
  const bytes = Buffer.from(encoded, "base64");
  requireCondition(bytes.toString("base64") === encoded, `Eval ${evalId} collector result base64 is not canonical.`);
  let result;
  try {
    result = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Eval ${evalId} collector result does not contain JSON.`);
  }
  return { result, resultSha256: sha256(bytes), platformOutputSha256: sha256(Buffer.from(canonicalJson(output), "utf8")) };
}

function validateCollectorInvocation(invocation, evalEntry, fixtureFileSha256) {
  requireCondition(isObject(invocation), `Eval ${evalEntry.id} collector invocation must be an object.`);
  assertOnlyKeys(invocation, new Set([
    "schemaVersion", "evalId", "evalCase", "evalCaseSha256", "fixturePath", "fixtureFileSha256",
    "databasePath", "databasePathSha256", "invocationNonce", "tracePath", "endpoint", "tool", "args",
  ]), `Eval ${evalEntry.id} collector invocation`);
  requireCondition(invocation.schemaVersion === PUBLIC_HANDLER_INVOCATION_SCHEMA,
    `Eval ${evalEntry.id} collector invocation schema is invalid.`);
  requireCondition(Number(invocation.evalId) === evalEntry.id
      && canonicalJson(invocation.evalCase) === canonicalJson(phase1bEvalCasePayload(evalEntry))
      && invocation.evalCaseSha256 === phase1bEvalCaseSha256(evalEntry)
      && invocation.fixtureFileSha256 === fixtureFileSha256,
  `Eval ${evalEntry.id} collector invocation is not bound to the exact eval case and fixture bytes.`);
  requireCondition(UUID_PATTERN.test(String(invocation.invocationNonce || "")),
    `Eval ${evalEntry.id} collector invocationNonce must be a UUID.`);
  requireCondition(ALLOWED_TARGET_TOOLS.has(invocation.tool),
    `Eval ${evalEntry.id} collector requested an unapproved public tool ${invocation.tool}.`);
  requireCondition(isObject(invocation.args), `Eval ${evalEntry.id} collector args must be an object.`);
  requireCondition(isObject(invocation.endpoint)
      && invocation.endpoint.target === "tcp"
      && ["127.0.0.1", "localhost"].includes(String(invocation.endpoint.host).toLowerCase())
      && Number(invocation.endpoint.port) === 8080,
  `Eval ${evalEntry.id} collector endpoint must be locked to tcp localhost/127.0.0.1 port 8080.`);
  if (invocation.tool !== "compare_spatial_snapshots") {
    requireCondition(invocation.args.target === invocation.endpoint.target
        && String(invocation.args.host).toLowerCase() === String(invocation.endpoint.host).toLowerCase()
        && Number(invocation.args.port) === 8080,
    `Eval ${evalEntry.id} target request escaped the locked local endpoint.`);
  }
  requireCondition(typeof invocation.fixturePath === "string" && path.isAbsolute(invocation.fixturePath),
    `Eval ${evalEntry.id} collector fixturePath must be absolute.`);
  requireCondition(typeof invocation.databasePath === "string" && path.isAbsolute(invocation.databasePath)
      && SHA256_PATTERN.test(String(invocation.databasePathSha256 || ""))
      && invocation.databasePathSha256 === sha256(Buffer.from(invocation.databasePath, "utf8")),
  `Eval ${evalEntry.id} collector database path binding is invalid.`);
  requireCondition(typeof invocation.tracePath === "string" && path.isAbsolute(invocation.tracePath),
    `Eval ${evalEntry.id} collector tracePath must be absolute.`);
}

function validateCollectorResult(result, invocation, evalEntry) {
  requireCondition(isObject(result), `Eval ${evalEntry.id} collector result must be an object.`);
  assertOnlyKeys(result, new Set([
    "schemaVersion", "evalId", "evalCaseSha256", "fixtureFileSha256", "invocationNonce",
    "databasePath", "databasePathSha256", "endpoint", "tool", "tracePath", "traceSha256", "traceByteLength", "collectorSourceSha256",
    "runtimeBuildTreeSha256", "response", "responseSha256", "statusRuntimeIdentitySha256",
    "eventResponseSha256", "snapshotBindings",
  ]), `Eval ${evalEntry.id} collector result`);
  requireCondition(result.schemaVersion === PUBLIC_HANDLER_INVOCATION_RESULT_SCHEMA,
    `Eval ${evalEntry.id} collector result schema is invalid.`);
  for (const key of ["evalId", "evalCaseSha256", "fixtureFileSha256", "databasePath", "databasePathSha256",
    "invocationNonce", "tool", "tracePath"]) {
    requireCondition(String(result[key]) === String(invocation[key]),
      `Eval ${evalEntry.id} collector result ${key} does not match its platform-bound invocation.`);
  }
  requireCondition(canonicalJson(result.endpoint) === canonicalJson(invocation.endpoint),
    `Eval ${evalEntry.id} collector result endpoint does not match its invocation.`);
  requireCondition(result.collectorSourceSha256 === PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
    `Eval ${evalEntry.id} collector result source hash is stale or forged.`);
  for (const [label, value] of [
    ["traceSha256", result.traceSha256],
    ["runtimeBuildTreeSha256", result.runtimeBuildTreeSha256],
    ["responseSha256", result.responseSha256],
    ["statusRuntimeIdentitySha256", result.statusRuntimeIdentitySha256],
  ]) requireCondition(SHA256_PATTERN.test(String(value || "")), `Eval ${evalEntry.id} ${label} is invalid.`);
  requireCondition(Number.isInteger(result.traceByteLength) && result.traceByteLength > 0,
    `Eval ${evalEntry.id} collector result traceByteLength is invalid.`);
  requireCondition(isObject(result.response), `Eval ${evalEntry.id} collector result response is missing.`);
  requireCondition(result.responseSha256 === sha256(Buffer.from(canonicalJson(result.response), "utf8")),
    `Eval ${evalEntry.id} collector result responseSha256 is invalid.`);
  requireCondition(Array.isArray(result.eventResponseSha256) && result.eventResponseSha256.length === 2
      && result.eventResponseSha256.every((value) => SHA256_PATTERN.test(String(value))),
  `Eval ${evalEntry.id} collector result must bind both public-handler response hashes.`);
  requireCondition(Array.isArray(result.snapshotBindings) && result.snapshotBindings.length > 0,
    `Eval ${evalEntry.id} collector result has no store-derived snapshot binding.`);
}

function requireOfficialTranscriptPath(transcriptPath, agentRunId, options = {}) {
  const realTranscript = fs.realpathSync.native(transcriptPath);
  const permittedRoot = options.testTranscriptRoot
    ? fs.realpathSync.native(options.testTranscriptRoot)
    : fs.realpathSync.native(path.join(process.env.USERPROFILE || os.homedir(), ".codex", "sessions"));
  requireCondition(isPathWithin(realTranscript, permittedRoot),
    "Codex transcript must resolve under the local Codex Desktop sessions directory.");
  if (!options.testTranscriptRoot) {
    requireCondition(path.basename(realTranscript).endsWith(`-${agentRunId}.jsonl`),
      "Codex transcript filename must bind the session_meta agent run id.");
  }
  return realTranscript;
}

function parseCodexDesktopTranscript(transcriptPath, evalEntry, options) {
  const bytes = readStableBytes(transcriptPath, `Eval ${evalEntry.id} Codex transcript`);
  const raw = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const rawLines = raw.split(/\r?\n/).filter((line) => line.trim());
  const rows = rawLines.map((line, index) => {
    try {
      return { index, raw: line, value: JSON.parse(line) };
    } catch (error) {
      throw new Error(`Eval ${evalEntry.id} Codex transcript line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  requireCondition(rows.length > 0, `Eval ${evalEntry.id} Codex transcript has no rows.`);
  const sessionRow = rows[0];
  requireCondition(sessionRow.value?.type === "session_meta" && isObject(sessionRow.value.payload),
    `Eval ${evalEntry.id} Codex transcript must begin with session_meta.`);
  const session = sessionRow.value.payload;
  const agentRunId = cleanText(session.id);
  const provider = cleanText(session.model_provider);
  const originator = cleanText(session.originator);
  const agentPath = cleanText(session?.source?.subagent?.thread_spawn?.agent_path ?? session.agent_path);
  const parentThreadId = cleanText(session?.source?.subagent?.thread_spawn?.parent_thread_id);
  const spawnDepth = Number(session?.source?.subagent?.thread_spawn?.depth);
  requireCondition(agentRunId && UUID_PATTERN.test(agentRunId), `Eval ${evalEntry.id} transcript session id is invalid.`);
  requireCondition(provider, `Eval ${evalEntry.id} transcript model_provider is missing.`);
  requireCondition(originator === "Codex Desktop", `Eval ${evalEntry.id} transcript originator must be Codex Desktop.`);
  requireCondition(agentPath === `/root/phase1b_actual_eval_${evalEntry.id}`,
    `Eval ${evalEntry.id} transcript agent_path does not identify the expected actual-eval subagent.`);
  requireCondition(parentThreadId === options.expectedParentThreadId && UUID_PATTERN.test(String(parentThreadId || ""))
      && spawnDepth === 1,
  `Eval ${evalEntry.id} transcript is not a depth-1 child of the manifest-selected root thread.`);
  requireCondition(agentRunId === options.expectedAgentRunId,
    `Eval ${evalEntry.id} transcript session id does not match the assembly manifest agentRunId.`);
  requireOfficialTranscriptPath(transcriptPath, agentRunId, options);

  const turnId = options.expectedTurnId;
  requireCondition(UUID_PATTERN.test(String(turnId || "")), `Eval ${evalEntry.id} expected turnId is invalid.`);
  const starts = rows.filter((row) => row.value?.type === "event_msg"
    && row.value?.payload?.type === "task_started" && row.value.payload.turn_id === turnId);
  const ends = rows.filter((row) => row.value?.type === "event_msg"
    && row.value?.payload?.type === "task_complete" && row.value.payload.turn_id === turnId);
  requireCondition(starts.length === 1 && ends.length === 1 && ends[0].index > starts[0].index,
    `Eval ${evalEntry.id} transcript needs exactly one completed manifest-selected turn.`);
  const selected = { start: starts[0], end: ends[0], turnId };
  const segment = rows.filter((row) => row.index >= selected.start.index && row.index <= selected.end.index);
  const turnContexts = segment.filter((row) => row.value?.type === "turn_context"
    && row.value?.payload?.turn_id === selected.turnId);
  requireCondition(turnContexts.length === 1, `Eval ${evalEntry.id} completed turn needs one matching turn_context.`);
  const model = cleanText(turnContexts[0].value.payload.model);
  requireCondition(model, `Eval ${evalEntry.id} transcript model is missing from turn_context.`);
  const triggerRows = segment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "agent_message"
    && row.value?.payload?.author === "/root"
    && row.value?.payload?.recipient === agentPath);
  requireCondition(triggerRows.length === 1, `Eval ${evalEntry.id} transcript needs one exact inter-agent task trigger.`);
  const trigger = triggerRows[0];
  const triggerText = agentMessageText(trigger.value.payload);
  requireCondition(new RegExp(`^Message Type: NEW_TASK[\\s\\S]*Task name: ${agentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*Sender: /root[\\s\\S]*Payload:\\s*$`, "u").test(triggerText),
    `Eval ${evalEntry.id} task trigger plaintext envelope is not the expected root-to-subagent platform event.`);
  const encryptedItems = Array.isArray(trigger.value.payload.content)
    ? trigger.value.payload.content.filter((item) => item?.type === "encrypted_content"
      && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0)
    : [];
  requireCondition(encryptedItems.length === 1,
    `Eval ${evalEntry.id} task payload must be present as one platform encrypted_content item.`);
  const evidenceSegment = segment.filter((row) => row.index >= trigger.index);
  const legacyOutputs = evidenceSegment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "custom_tool_call_output")
    .flatMap((row) => collectNestedStrings(row.value.payload.output))
    .filter((value) => /agent-response-attestation\.v1|raw-agent-run-trace\.v1|"actualAgentRun"|"toolTracePassed"|"forbiddenClaimCheckPassed"/iu.test(value));
  requireCondition(legacyOutputs.length === 0,
    `Eval ${evalEntry.id} contains forbidden legacy self-attestation/temp-recorder output.`);

  const callRows = evidenceSegment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "custom_tool_call");
  const outputRows = evidenceSegment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "custom_tool_call_output");
  const allTurnCallRows = segment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "custom_tool_call");
  const allTurnOutputRows = segment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "custom_tool_call_output");
  requireCondition(allTurnCallRows.length === callRows.length && allTurnOutputRows.length === outputRows.length,
    `Eval ${evalEntry.id} contains platform calls before the bound task trigger.`);
  const executionRows = segment.filter((row) => row.value?.type === "response_item"
    && /_call(?:_output)?$/iu.test(String(row.value?.payload?.type || "")));
  const unsupportedExecutionRows = executionRows.filter((row) =>
    !["custom_tool_call", "custom_tool_call_output"].includes(String(row.value?.payload?.type || "")));
  requireCondition(unsupportedExecutionRows.length === 0
      && executionRows.length === allTurnCallRows.length + allTurnOutputRows.length,
  `Eval ${evalEntry.id} contains an unsupported platform execution event type.`);
  requireCondition(callRows.length === 1, `Eval ${evalEntry.id} must contain exactly one approved collector tool call.`);
  requireCondition(outputRows.length === 1, `Eval ${evalEntry.id} must contain exactly one paired collector output.`);
  const callRow = callRows[0];
  const callId = cleanText(callRow.value.payload.call_id);
  requireCondition(callId && callRow.value.payload.name === "exec", `Eval ${evalEntry.id} platform tool must be exec.`);
  const matchingOutputs = outputRows.filter((row) => row.value.payload.call_id === callId);
  requireCondition(matchingOutputs.length === 1, `Eval ${evalEntry.id} collector output call_id is missing or ambiguous.`);
  const outputRow = matchingOutputs[0];
  requireCondition(outputRow.index > callRow.index, `Eval ${evalEntry.id} collector output precedes its call.`);
  const parsedExec = parseCollectorExecSource(callRow.value.payload.input, options.repoRoot);
  validateCollectorInvocation(parsedExec.invocation, evalEntry, options.fixtureFileSha256);
  const parsedOutput = parseCollectorResult(outputRow.value.payload.output, evalEntry.id);
  validateCollectorResult(parsedOutput.result, parsedExec.invocation, evalEntry);
  const finalRows = segment.filter((row) => row.value?.type === "response_item"
    && row.value?.payload?.type === "message" && row.value?.payload?.role === "assistant"
    && row.value?.payload?.phase === "final_answer");
  requireCondition(finalRows.length === 1, `Eval ${evalEntry.id} completed turn needs exactly one final assistant response.`);
  const finalRow = finalRows[0];
  requireCondition(finalRow.index > outputRow.index && finalRow.index < selected.end.index,
    `Eval ${evalEntry.id} final assistant response is not temporally bound after the paired collector output.`);
  const finalResponse = messageText(finalRow.value.payload);
  requireCondition(finalResponse.trim(), `Eval ${evalEntry.id} final assistant response is empty.`);
  const finalResponseEventId = cleanText(finalRow.value.payload.id);
  requireCondition(finalResponseEventId, `Eval ${evalEntry.id} final assistant response event id is missing.`);
  requireCondition(selected.end.value.payload.last_agent_message === finalResponse,
    `Eval ${evalEntry.id} task_complete is not bound to the final assistant response.`);
  const startedAtUtc = selected.start.value.timestamp;
  const finishedAtUtc = selected.end.value.timestamp;
  exactTimestamp(startedAtUtc, `Eval ${evalEntry.id} turn start timestamp`);
  exactTimestamp(finishedAtUtc, `Eval ${evalEntry.id} turn completion timestamp`);
  requireCondition(Date.parse(finishedAtUtc) >= Date.parse(startedAtUtc),
    `Eval ${evalEntry.id} turn timestamps are reversed.`);
  return {
    provider,
    model,
    originator,
    agentRunId,
    turnId: selected.turnId,
    agentPath,
    parentThreadId,
    startedAtUtc,
    finishedAtUtc,
    finalResponseEventId,
    finalResponse,
    collectorBinding: {
      invocation: parsedExec.invocation,
      result: parsedOutput.result,
      platformCallStartedAtUtc: callRow.value.timestamp,
      platformCallFinishedAtUtc: outputRow.value.timestamp,
      platformCall: {
        sequence: 1,
        platformTool: "exec",
        classification: "permanent_public_handler_collector",
        callIdSha256: sha256(Buffer.from(callId, "utf8")),
        inputSha256: sha256(Buffer.from(callRow.value.payload.input, "utf8")),
        encodedRequestSha256: parsedExec.encodedSha256,
        outputSha256: parsedOutput.platformOutputSha256,
        collectorResultSha256: parsedOutput.resultSha256,
        requestedPublicTool: parsedExec.invocation.tool,
        startedAtUtc: callRow.value.timestamp,
        finishedAtUtc: outputRow.value.timestamp,
      },
    },
    transcript: {
      format: "codex_desktop_jsonl",
      path: transcriptPath,
      byteLength: bytes.length,
      rawTranscriptSha256: sha256(bytes),
      turnSegmentSha256: sha256(Buffer.from(evidenceSegment.map((row) => row.raw).join("\n"), "utf8")),
      taskTriggerSha256: sha256(Buffer.from(triggerText, "utf8")),
      taskTriggerEnvelopeSha256: sha256(Buffer.from(canonicalJson(trigger.value.payload.content), "utf8")),
      taskPayloadEncrypted: true,
      evalCaseBoundViaCollectorInvocation: true,
      promptObservedInPlaintext: false,
      customToolCallCount: callRows.length,
      pairedToolOutputCount: outputRows.length,
    },
  };
}

function sentenceHasDisclaimer(sentence) {
  return /\b(?:cannot|can't|not|was not|were not|wasn't|weren't|unverified|no verdict|does not|isn't|aren't|must not|requires? (?:a )?live|future live|live[^.!?]{0,40}(?:is )?required)\b|\b(?:söyleyemem|doğrulayamam|kesin değil|kanıtlamaz|onay değildir|onaylanamaz|değildir|değildi|değil|hüküm değildir|live[^.!?]{0,30}gerekir|ileride[^.!?]{0,30}live)\b/iu.test(sentence);
}

function semanticClauses(value) {
  return String(value)
    .split(/(?<=[.!?])\s+|[\r\n]+/u)
    .flatMap((sentence) => {
      const leadingContrast = sentence.match(/^\s*(?:although|though|even\s+though)\s+([^,;]+)[,;]\s*(.+)$/iu);
      if (leadingContrast) return [leadingContrast[1], leadingContrast[2]];
      const turkishContrast = sentence.match(/^\s*(.+?)\b(?:olmasına\s+rağmen|rağmen)\s*[,;]\s*(.+)$/iu);
      return turkishContrast ? [turkishContrast[1], turkishContrast[2]] : [sentence];
    })
    .flatMap((sentence) => sentence.split(/\s*(?:;|\b(?:but|however|yet|although|though|even\s+though|because|ancak|fakat|ama|yine\s+de|çünkü|zira|oysa|halbuki|rağmen)\b)\s*,?\s*/iu))
    .map((item) => item.trim())
    .filter(Boolean);
}

function claimClauses(value) {
  return semanticClauses(value)
    .flatMap((clause) => clause.split(/\s*,?\s+\b(?:and|ve)\b\s+/iu))
    .map((item) => item.trim())
    .filter(Boolean);
}

const CLASH_POSITIVE_CLAIM = /\bclash(?:es)?\s+(?:detected|found|exists?|present)\b|\b(?:there (?:is|are) )?(?:a )?clash(?:es)?\b|\b(?:intersects?|intersection (?:is )?(?:confirmed|verified))\b|\b(?:çakışma (?:var|tespit edildi|doğrulandı)|kesişiyor|kesişim (?:var|kesin))\b/iu;
const CLASH_FREE_CLAIM = /\bclash[- ]free\b|\b(?:there (?:is|are) )?no clash(?:es)?\b|\b(?:çakışmasız|çakışma yok)\b/iu;
const STANDALONE_APPROVAL_CLAIM = /\b(?:it|this|that|the result|the candidate|the measurement)\b[^.!?]{0,25}\b(?:is|was|remains)\b[^.!?]{0,20}\b(?:approved|verified|compliant|adequate|sufficient|passed|acceptable)\b|^(?:approved|verified|compliant|adequate|sufficient|passed|acceptable)\b|\b(?:bu|o|sonuç|aday|ölçüm)\b[^.!?]{0,25}\b(?:onaylı|doğrulanmış|uygun|yeterli|geçti|kabul edilebilir)\b/iu;
const LIVE_AUTHORITATIVE_CLAIM = /\b(?:live[_ -]?verdict|live\s+verified|verified\s+live|live\s+verification|authoritative\s+(?:live\s+)?(?:verdict|verification|proof)|(?:context[_ -]?only|context evidence|this inference|this evidence|it|this|that)\b[^.!?]{0,35}\b(?:is|becomes?|constitutes?|provides?)\b[^.!?]{0,25}\b(?:an?\s+)?(?:live|authoritative)\b(?:[^.!?]{0,20}\b(?:verdict|verification|proof))?)\b|\b(?:canlı|otoritatif|yetkili)\b[^.!?]{0,25}\b(?:hüküm|doğrulama|kanıt)\b/iu;
const CLEARANCE_VERDICT_CLAIM = /\bclearance\b[^.!?]{0,100}\b(?:approved|verified|compliant|adequate|sufficient|passed)\b|\b(?:geçiş|açıklık|mesafe)\b[^.!?]{0,100}\b(?:onaylı|doğrulandı|uygun|yeterli|geçti)\b/iu;
const EXACT_VERIFICATION_CLAIM = /\b(?:exact|solid|exactness|precise|certain)\b[^.!?]{0,60}\b(?:verification|proof|verdict|geometry)\b|\b(?:verification|proof|verdict|geometry)\b[^.!?]{0,60}\b(?:exact|solid|exactness|precise|certain)\b|\b(?:kesin|katı|tam)\b[^.!?]{0,60}\b(?:doğrulama|kanıt|hüküm|geometri)\b/iu;

function clauseHasAuthoritativeVerdictText(clause) {
  return CLEARANCE_VERDICT_CLAIM.test(clause)
    || STANDALONE_APPROVAL_CLAIM.test(clause)
    || CLASH_POSITIVE_CLAIM.test(clause)
    || CLASH_FREE_CLAIM.test(clause)
    || LIVE_AUTHORITATIVE_CLAIM.test(clause)
    || EXACT_VERIFICATION_CLAIM.test(clause);
}

export function computeAgentClaimAudit(finalResponse, variant) {
  const sentences = claimClauses(finalResponse);
  const currentStateClaim = /\b(?:currently|right now|as of now|still|presently)\b[^.!?]{0,120}\b(?:inside|above|below|located|remains|is|are)\b|\b(?:şu anda|şu an|halen|hâlâ|güncel olarak)\b[^.!?]{0,120}\b(?:içinde|üstünde|altında|konumda|duruyor|bulunuyor|kalmaktadır)\b/iu;
  const oldSnapshotPromotedCurrent = /\b(?:the\s+)?(?:old|stale|unknown)(?:\s+(?:liveness|snapshot))?\b[^.!?]{0,60}\b(?:is|was|became|counts? as|can be treated as)\b[^.!?]{0,20}\bcurrent\b|\b(?:stale|unknown|old snapshot|eski snapshot|eski kayıt|belirsiz liveness)\b[^.!?]{0,60}\b(?:günceldir|güncel sayılır|güncel kabul edilir|güncel durumu gösterir|mevcut durumu gösterir)\b/iu;
  const unsupportedRelationClaim = /\b(?:nearest|closest|en yakın)\b[^.!?]{0,100}(?:\b[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü-]*[- ]?\d+\b|\bis\b|\bboru\b|\bkanal\b)|\b\d+(?:[.,]\d+)?\s*(?:mm|cm|metre|meter|m)\b|\b(?:inside|outside|above|below|within)\b[^.!?]{0,80}\b(?:room|space|duct|pipe|element)\b|\b(?:room|space|duct|pipe|element|kanal|boru|eleman)\b[^.!?]{0,100}\b(?:inside|outside|above|below|içinde(?:dir)?|dışında(?:dır)?|üstünde(?:dir)?|altında(?:dır)?|bulunuyor)\b/iu;
  const derivedPhysicalClaim = /\b(?:derived(?:\s+(?:node|inference|channel))?|inferred\s+(?:node|channel)|routing\s+channel|channel|it|this\s+(?:finding|result|node|channel|inference))\b[^.!?]{0,100}\b(?:physical|native)\b[^.!?]{0,50}\b(?:revit\s+model\s+)?(?:element|object|component|entity)\b|\b(?:derived|türetilmiş|routing channel|rota kanalı|kanal|bu (?:bulgu|sonuç|eleman|kanal)|o)\b[^.!?]{0,100}\b(?:fiziksel|native|yerel)\b[^.!?]{0,50}\b(?:model |revit )?eleman(?:ı|ıdır|dir)?\b/iu;
  const genericApprovalClaim = /\b(?:result|clearance|separation)\b[^.!?]{0,80}\b(?:approved|compliant|adequate|sufficient|passed|acceptable)\b|(?:sonuç|açıklık|mesafe|ayrım)[^.!?]{0,80}(?:onaylı(?:dır)?|uygun(?:dur)?|yeterli(?:dir)?|kabul edilebilir)/iu;
  const summaryVerificationClaim = /\b(?:all (?:transitions?|relations?|counts?) (?:are|remain) (?:correct|verified)|everything is correct)\b|\b(?:it|this|that|the summary|the result)\b[^.!?]{0,25}\b(?:is|proves?|verifies?|confirms?)\b[^.!?]{0,25}\b(?:correct|verified|proof|valid)\b|\b(?:(?:this|the)\s+)?(?:advisory\s+)?summary\b[^.!?]{0,50}\b(?:proves?|verifies?|confirms?|validates?)\b[^.!?]{0,60}\b(?:route|routing|spatial relations?|transitions?|correctness)\b|\b(?:aggregate\s+)?counts?\b[^.!?]{0,50}\b(?:proves?|verifies?|confirms?|validates?)\b[^.!?]{0,60}\b(?:route|routing|spatial relations?|transitions?|correctness)\b|(?:tüm (?:geçişler|ilişkiler)|hepsi)[^.!?]{0,50}(?:doğru(?:dur)?|doğrulandı|onaylı)|(?:bu|o|özet|sonuç|toplu sayılar)[^.!?]{0,50}(?:doğrudur|doğrulandı|kanıttır|onaylıdır|rotayı kanıtlar|ilişkileri doğrular)/iu;
  const historicalCurrentClaim = /\b(?:snapshots?|base|head)\b[^.!?]{0,80}\b(?:is|are|remain) current\b|\b(?:it|they|these|those|both|the snapshots?)\b[^.!?]{0,30}\b(?:is|are|remain) current\b|(?:snapshotlar|base|head)[^.!?]{0,80}(?:günceldir|güncel durumu|mevcut durumu)|(?:bunlar|ikisi|onlar)[^.!?]{0,30}(?:günceldir|güncel durumu|mevcut durumu)/iu;
  const manualArithmeticClaim = /\b(?:i|we)\b[^.!?]{0,20}\b(?:did|performed|used)\b[^.!?]{0,15}\b(?:the\s+)?(?:math|calculation|arithmetic)\b[^.!?]{0,20}\b(?:myself|manually)?\b|\b(?:coordinate|z(?:-value)?)\s+arithmetic\b[^.!?]{0,50}\b(?:gives?|yields?|produces?|equals?|calculates?)\b|\b(?:i|we)\b[^.!?]{0,25}\bmanually\b[^.!?]{0,20}\b(?:subtracted|calculated|computed|derived)\b|\b(?:i|we)\b[^.!?]{0,25}\b(?:subtracted|calculated|computed|derived)\b[^.!?]{0,80}\b(?:myself|manually|from (?:the )?raw coordinates?)\b|\b\d+(?:[.,]\d+)?\s*(?:minus|-)\s*\d+(?:[.,]\d+)?\s*=\s*\d+(?:[.,]\d+)?\b|\b\d+(?:[.,]\d+)?\s*(?:minus|-)\s*\d+(?:[.,]\d+)?\b[^.!?]{0,50}\b(?:my|our) calculation\b|\bmanually\b[^.!?]{0,60}\b(?:raw\s+)?coordinates?\b|\b(?:raw\s+)?coordinates?\b[^.!?]{0,60}\bmanually\b|\b(?:koordinatları|z değerlerini|ham koordinatları)\b[^.!?]{0,60}\b(?:kendim|zihinsel|manuel|zihnimden)\b[^.!?]{0,30}\b(?:hesapladım|çıkardım|türettim)\b|\b(?:kendim|zihinsel|manuel|zihnimden)\b[^.!?]{0,50}\b(?:koordinat|z değer|hesap|çıkarma)\b[^.!?]{0,30}\b(?:hesapladım|çıkardım|yaptım)\b/iu;
  let forbiddenCurrentStateClaimCount = 0;
  let forbiddenUnsupportedRelationClaimCount = 0;
  let forbiddenClearanceVerdictClaimCount = 0;
  let forbiddenClashFreeClaimCount = 0;
  let forbiddenScreeningVerdictClaimCount = 0;
  let forbiddenDerivedPhysicalClaimCount = 0;
  let forbiddenLiveVerdictTokenCount = 0;
  let forbiddenSummaryVerificationClaimCount = 0;
  let forbiddenHistoricalCurrentClaimCount = 0;
  let forbiddenCoordinateArithmeticClaimCount = 0;
  for (const sentence of sentences) {
    const disclaimed = sentenceHasDisclaimer(sentence);
    if (FAIL_CLOSED_CURRENT_STATE_VARIANTS.has(variant) && currentStateClaim.test(sentence) && !disclaimed) {
      forbiddenCurrentStateClaimCount += 1;
    }
    if (["stale_current_state", "unknown_liveness"].includes(variant)
      && oldSnapshotPromotedCurrent.test(sentence) && !disclaimed) forbiddenCurrentStateClaimCount += 1;
    if (FAIL_CLOSED_CURRENT_STATE_VARIANTS.has(variant) && unsupportedRelationClaim.test(sentence)) {
      forbiddenUnsupportedRelationClaimCount += 1;
    }
    if ((CLEARANCE_VERDICT_CLAIM.test(sentence) || (variant === "context_only_clearance"
      && (genericApprovalClaim.test(sentence) || STANDALONE_APPROVAL_CLAIM.test(sentence))))
      && !disclaimed) forbiddenClearanceVerdictClaimCount += 1;
    if (CLASH_FREE_CLAIM.test(sentence) && !disclaimed) forbiddenClashFreeClaimCount += 1;
    if (variant === "screening_only_intersection"
      && (CLASH_FREE_CLAIM.test(sentence) || CLASH_POSITIVE_CLAIM.test(sentence)
        || EXACT_VERIFICATION_CLAIM.test(sentence)) && !disclaimed) {
      forbiddenScreeningVerdictClaimCount += 1;
    }
    if (variant === "derived_node_labeling" && derivedPhysicalClaim.test(sentence) && !disclaimed) {
      forbiddenDerivedPhysicalClaimCount += 1;
    }
    if (["context_only_clearance", "screening_only_intersection", "derived_node_labeling"].includes(variant)
      && LIVE_AUTHORITATIVE_CLAIM.test(sentence) && !disclaimed) {
      forbiddenLiveVerdictTokenCount += 1;
    }
    if (variant === "summary_is_not_verification"
      && summaryVerificationClaim.test(sentence)
      && !disclaimed) forbiddenSummaryVerificationClaimCount += 1;
    if (variant === "explicit_historical_diff"
      && historicalCurrentClaim.test(sentence)
      && !disclaimed) forbiddenHistoricalCurrentClaimCount += 1;
    if (["no_in_session_snapshot", "partial_snapshot", "stale_current_state", "unknown_liveness",
      "explicit_historical_diff", "coordinates_do_not_authorize_llm_arithmetic"].includes(variant)
      && manualArithmeticClaim.test(sentence)
      && !disclaimed) forbiddenCoordinateArithmeticClaimCount += 1;
  }
  return {
    auditedResponseSha256: sha256(Buffer.from(String(finalResponse), "utf8")),
    forbiddenCurrentStateClaimCount,
    forbiddenUnsupportedRelationClaimCount,
    forbiddenClearanceVerdictClaimCount,
    forbiddenClashFreeClaimCount,
    forbiddenScreeningVerdictClaimCount,
    forbiddenDerivedPhysicalClaimCount,
    forbiddenLiveVerdictTokenCount,
    forbiddenSummaryVerificationClaimCount,
    forbiddenHistoricalCurrentClaimCount,
    forbiddenCoordinateArithmeticClaimCount,
    passed: forbiddenCurrentStateClaimCount + forbiddenUnsupportedRelationClaimCount
      + forbiddenClearanceVerdictClaimCount + forbiddenClashFreeClaimCount
      + forbiddenScreeningVerdictClaimCount + forbiddenDerivedPhysicalClaimCount
      + forbiddenLiveVerdictTokenCount + forbiddenSummaryVerificationClaimCount
      + forbiddenHistoricalCurrentClaimCount + forbiddenCoordinateArithmeticClaimCount === 0,
  };
}

function traceResult(trace, tool) {
  return trace.findLast((entry) => entry.tool === tool)?.response ?? null;
}

function responseIncludesValue(response, value) {
  if (value === null || value === undefined || String(value).length === 0) return false;
  return response.toLowerCase().includes(String(value).toLowerCase());
}

function collectDeepFields(value, output = [], pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDeepFields(item, output, [...pathParts, String(index)]));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      output.push({ key, value: child, path: [...pathParts, key].join(".") });
      collectDeepFields(child, output, [...pathParts, key]);
    }
  }
  return output;
}

function collectDeepObjects(value, output = []) {
  if (isObject(value)) {
    output.push(value);
    Object.values(value).forEach((child) => collectDeepObjects(child, output));
  } else if (Array.isArray(value)) {
    value.forEach((child) => collectDeepObjects(child, output));
  }
  return output;
}

function deepFieldValues(value, keyPattern) {
  return collectDeepFields(value).filter((field) => keyPattern.test(field.key)).flatMap((field) => {
    if (Array.isArray(field.value)) return field.value.filter((item) => ["string", "number", "boolean"].includes(typeof item));
    return ["string", "number", "boolean"].includes(typeof field.value) ? [field.value] : [];
  });
}

function uniqueScalarValues(values) {
  return [...new Map(values.map((value) => [String(value), value])).values()];
}

function evidenceNodeIds(value) {
  return uniqueScalarValues(deepFieldValues(value,
    /^(?:nodeId|evidenceNodeIds?|sourceNodeIds?|targetNodeIds?|fromNodeIds?|toNodeIds?|nodeAId|nodeBId|firstNodeId|secondNodeId)$/iu)
    .filter((item) => typeof item === "string" && item.length > 0));
}

function traceEntry(trace, tool) {
  return trace.findLast((entry) => entry.tool === tool) ?? null;
}

function requireTraceValues(response, missing, label, values, minimum = 1) {
  const unique = uniqueScalarValues(values);
  if (unique.length < minimum) {
    missing.push(`${label}_trace_evidence`);
    return;
  }
  unique.forEach((value, index) => {
    if (!responseIncludesValue(response, value)) missing.push(`${label}_${index + 1}`);
  });
}

function requireAffirmedTraceValues(response, missing, label, values, minimum = 1) {
  const unique = uniqueScalarValues(values);
  if (unique.length < minimum) {
    missing.push(`${label}_trace_evidence`);
    return;
  }
  const clauses = semanticClauses(response);
  unique.forEach((value, index) => {
    const affirmed = clauses.some((clause) => responseIncludesValue(clause, value)
      && !sentenceHasDisclaimer(clause));
    if (!affirmed) missing.push(`${label}_${index + 1}`);
  });
}

function nodeReferenceValues(result, nodeId) {
  const values = [nodeId];
  for (const node of collectDeepObjects(result)) {
    if (objectField(node, "nodeId") !== nodeId) continue;
    for (const [key, value] of Object.entries(node)) {
      if (/^(?:name|displayName|label|entityLabel|elementName|familyAndType)$/iu.test(key)
        && typeof value === "string" && value.trim().length > 0) values.push(value.trim());
    }
  }
  return uniqueScalarValues(values);
}

function valueIndex(clause, values) {
  const lower = clause.toLowerCase();
  const indexes = values.map((value) => lower.indexOf(String(value).toLowerCase())).filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function requireDirectionalRelationBinding(response, missing, entry, result, relationValues) {
  const operation = objectField(entry.request ?? {}, "operation") ?? {};
  const sourceNodeId = objectField(operation, "sourceNodeId");
  const targetNodeId = objectField(operation, "targetNodeId");
  const relations = uniqueScalarValues(relationValues).filter((value) => typeof value === "string" && value.length > 0);
  if (!(typeof sourceNodeId === "string" && sourceNodeId.length > 0
    && typeof targetNodeId === "string" && targetNodeId.length > 0 && relations.length > 0)) {
    missing.push("directional_relation_trace_evidence");
    return;
  }
  const clauses = semanticClauses(response).filter((clause) => !sentenceHasDisclaimer(clause));
  const primaryRelation = relations[0];
  const directionBound = clauses.some((clause) => {
    const sourceIndex = valueIndex(clause, [sourceNodeId]);
    const targetIndex = valueIndex(clause, [targetNodeId]);
    const relationIndex = valueIndex(clause, [primaryRelation]);
    const lower = clause.toLowerCase();
    const explicitSourceRole = /\b(?:source|kaynak)\b/iu.test(lower.slice(Math.max(0, sourceIndex - 40), sourceIndex));
    const explicitTargetRole = /\b(?:target|hedef)\b/iu.test(lower.slice(Math.max(0, targetIndex - 40), targetIndex));
    return sourceIndex >= 0 && targetIndex >= 0 && relationIndex >= 0
      && ((sourceIndex < relationIndex && relationIndex < targetIndex)
        || (explicitSourceRole && explicitTargetRole));
  });
  if (!directionBound) missing.push("directional_relation_binding");

  const sourceReferences = nodeReferenceValues(result, sourceNodeId);
  const targetReferences = nodeReferenceValues(result, targetNodeId);
  const reversed = clauses.some((clause) => {
    const sourceIndex = valueIndex(clause, sourceReferences);
    const targetIndex = valueIndex(clause, targetReferences);
    const relationIndex = valueIndex(clause, relations);
    return targetIndex >= 0 && relationIndex > targetIndex && sourceIndex > relationIndex;
  });
  if (reversed) missing.push("reversed_relation_claim");
}

function requireRoleBoundSnapshotRevision(response, missing, role, snapshotId, revisionFingerprint) {
  if (!(typeof snapshotId === "string" && snapshotId.length > 0
    && typeof revisionFingerprint === "string" && revisionFingerprint.length > 0)) {
    missing.push(`${role}_snapshot_revision_trace_evidence`);
    return;
  }
  const lower = String(response).toLowerCase();
  const roleMatches = [...lower.matchAll(/(?<![-:_])\b(?:base|head)\b/gu)]
    .map((match) => ({ role: match[0], index: match.index }));
  const bound = roleMatches.some((match, index) => {
    if (match.role !== role) return false;
    const end = roleMatches[index + 1]?.index ?? lower.length;
    const segment = lower.slice(match.index, end);
    return segment.includes(snapshotId.toLowerCase())
      && segment.includes(revisionFingerprint.toLowerCase());
  });
  if (!bound) missing.push(`${role}_snapshot_revision_binding`);
}

function requireFreshCaptureEvidence(response, missing, result) {
  const snapshot = objectField(result, "snapshot");
  const snapshotId = objectField(result, "snapshotId");
  const revisionFingerprint = objectField(result, "revisionFingerprint");
  const topLevelTrusted = objectField(result, "success") === true
    && objectField(result, "guarded") === false
    && objectField(result, "state") === "completed"
    && objectField(result, "committed") === true
    && objectField(result, "atomic") === true
    && objectField(result, "liveness") === "current"
    && objectField(result, "partial") === false
    && objectField(result, "coverageStatus") === "complete";
  const snapshotTrusted = isObject(snapshot)
    && objectField(snapshot, "atomic") === true
    && objectField(snapshot, "liveness") === "current"
    && objectField(snapshot, "partial") === false
    && objectField(snapshot, "coverageStatus") === "complete";
  const fieldsConsistent = topLevelTrusted && snapshotTrusted
    && typeof snapshotId === "string" && snapshotId.length > 0
    && typeof revisionFingerprint === "string" && revisionFingerprint.length > 0
    && snapshotId === objectField(snapshot, "snapshotId")
    && revisionFingerprint === objectField(snapshot, "revisionFingerprint")
    && objectField(result, "liveness") === objectField(snapshot, "liveness")
    && objectField(result, "atomic") === objectField(snapshot, "atomic")
    && objectField(result, "partial") === objectField(snapshot, "partial")
    && objectField(result, "coverageStatus") === objectField(snapshot, "coverageStatus");
  if (!(topLevelTrusted && snapshotTrusted && fieldsConsistent)) {
    missing.push("fresh_current_recapture_evidence");
  }
  if (!/\bliveness\s*=\s*current\b/iu.test(response)) missing.push("recovery_liveness");
}

export function computeResponseProtocolAudit(finalResponse, evalEntry, toolTrace) {
  const response = String(finalResponse);
  const lower = response.toLowerCase();
  const missing = [];
  const requirePattern = (label, pattern) => { if (!pattern.test(response)) missing.push(label); };
  const requireValue = (label, value) => { if (!responseIncludesValue(response, value)) missing.push(label); };
  switch (evalEntry.variant) {
    case "no_in_session_snapshot":
      requirePattern("status_preflight_wording", /status|preflight|get_revit_mcp_status/iu);
      requirePattern("capture_wording", /capture|snapshot/iu);
      requirePattern("abstention_wording", /cannot|can't|not answer|söyleyemem|yanıtlamıyorum|sonuç üretmiyorum|kesin.*değil/iu);
      requirePattern("explicit_scope_wording", /scope|kapsam|level|seviye/iu);
      requirePattern("query_after_capture_wording", /query_spatial_context|query|operation/iu);
      break;
    case "partial_snapshot":
      requirePattern("partial_wording", /partial/iu);
      requirePattern("incomplete_scope_wording", /incomplete|eksik|kapsam/iu);
      requirePattern("abstention_wording", /cannot|can't|not answer|söyleyemem|yanıtlamıyorum|sonuç üretmiyorum|desteklemez|kesin.*değil/iu);
      requirePattern("recapture_or_narrow_wording", /recapture|capture|narrow|scope|yeniden|daralt|kapsam/iu);
      {
        const result = traceResult(toolTrace, "query_spatial_context") ?? {};
        const partialValues = deepFieldValues(result, /^partial$/iu);
        const coverageValues = deepFieldValues(result, /^coverageStatus$/iu);
        if (!(objectField(result, "guarded") === true
          && objectField(result, "state") === "guarded"
          && objectField(result, "reason") === "incomplete_snapshot"
          && partialValues.includes(true)
          && coverageValues.some((value) => /incomplete/iu.test(String(value))))) {
          missing.push("incomplete_snapshot_guard_evidence");
        }
        requireTraceValues(response, missing, "coverage_status", coverageValues);
      }
      break;
    case "stale_current_state":
      requirePattern("stale_wording", /stale/iu);
      requirePattern("fresh_capture_wording", /capture|yeni snapshot|fresh snapshot/iu);
      requirePattern("abstention_wording", /cannot|can't|söyleyemem|doğrulayamam|üretmiyorum|veremem|güncel[^.!?]{0,30}değil/iu);
      {
        const result = traceResult(toolTrace, "capture_spatial_snapshot") ?? {};
        requireFreshCaptureEvidence(response, missing, result);
      }
      break;
    case "unknown_liveness":
      requirePattern("unknown_liveness_wording", /unknown|bilinmiyor|belirsiz/iu);
      requirePattern("fresh_capture_wording", /capture|yeni snapshot|fresh snapshot/iu);
      requirePattern("abstention_wording", /cannot|can't|söyleyemem|doğrulayamam|üretmiyorum|veremem|güncel[^.!?]{0,30}değil/iu);
      {
        const result = traceResult(toolTrace, "capture_spatial_snapshot") ?? {};
        requireFreshCaptureEvidence(response, missing, result);
      }
      break;
    case "explicit_historical_diff": {
      const result = traceResult(toolTrace, "compare_spatial_snapshots") ?? {};
      for (const [label, value] of [
        ["base_snapshot_id", objectField(result, "baseSnapshotId")],
        ["head_snapshot_id", objectField(result, "headSnapshotId")],
        ["base_revision", objectField(result, "baseRevisionFingerprint")],
        ["head_revision", objectField(result, "headRevisionFingerprint")],
      ]) requireValue(label, value);
      requireRoleBoundSnapshotRevision(response, missing, "base",
        objectField(result, "baseSnapshotId"), objectField(result, "baseRevisionFingerprint"));
      requireRoleBoundSnapshotRevision(response, missing, "head",
        objectField(result, "headSnapshotId"), objectField(result, "headRevisionFingerprint"));
      requirePattern("historical_wording", /historical|tarihsel|iki snapshot/iu);
      requireTraceValues(response, missing, "changed_node_id",
        deepFieldValues(result, /^(?:changedNodeIds?|nodeId)$/iu));
      requireAffirmedTraceValues(response, missing, "change_kind",
        deepFieldValues(result, /^(?:changeKind|changeType)$/iu));
      break;
    }
    case "cite_operation_evidence": {
      const entry = traceEntry(toolTrace, "query_spatial_context") ?? {};
      const result = entry.response ?? {};
      for (const [label, value] of [
        ["snapshot_id", objectField(result, "snapshotId")],
        ["revision", objectField(result, "revisionFingerprint")],
        ["basis", objectField(result, "basis")],
        ["precision_class", objectField(result, "precisionClass")],
      ]) requireValue(label, value);
      requireTraceValues(response, missing, "evidence_node_id", evidenceNodeIds(result), 2);
      const operationName = objectField(objectField(entry.request ?? {}, "operation"), "name");
      if (!["above_below", "relation_between"].includes(String(operationName))) {
        missing.push("approved_relation_operation");
      }
      const computed = objectField(result, "computed") ?? {};
      const relationValues = deepFieldValues(computed, /^(?:relation|verticalRelation)$/iu);
      requireAffirmedTraceValues(response, missing, "computed_relation", relationValues);
      requireDirectionalRelationBinding(response, missing, entry, result, relationValues);
      break;
    }
    case "summary_is_not_verification":
      requirePattern("advisory_wording", /advisory/iu);
      requirePattern("not_verification_wording", /not[^.!?]{0,40}verif|kanıtlamaz|doğrulama[^.!?]{0,40}değil|onay[^.!?]{0,40}değil/iu);
      requirePattern("deterministic_query_request", /query_spatial_context|deterministic|relation evidence|operation evidence/iu);
      {
        const result = traceResult(toolTrace, "summarize_spatial_state") ?? {};
        if (!(objectField(result, "advisory") === true
          && objectField(result, "quotableAsVerification") === false)) {
          missing.push("advisory_only_summary_evidence");
        }
      }
      break;
    case "coordinates_do_not_authorize_llm_arithmetic": {
      const entry = traceEntry(toolTrace, "query_spatial_context") ?? {};
      const result = entry.response ?? {};
      requirePattern("deterministic_operation_wording", /deterministic|query_spatial_context|operation|zihinsel.*hesap|hesaplamadım/iu);
      requireValue("basis", objectField(result, "basis"));
      requireValue("precision_class", objectField(result, "precisionClass"));
      const operationName = objectField(objectField(entry.request ?? {}, "operation"), "name");
      if (!["above_below", "relation_between"].includes(String(operationName))) {
        missing.push("approved_relation_operation");
      }
      requireTraceValues(response, missing, "evidence_node_id", evidenceNodeIds(result), 2);
      const computedValues = uniqueScalarValues([
        ...deepFieldValues(result, /^(?:relation|verticalRelation|separationMm|intersects)$/iu),
      ]);
      requireTraceValues(response, missing, "computed_relation", computedValues);
      requireDirectionalRelationBinding(response, missing, entry, result,
        deepFieldValues(objectField(result, "computed") ?? {}, /^(?:relation|verticalRelation)$/iu));
      break;
    }
    case "context_only_clearance": {
      const result = traceResult(toolTrace, "query_spatial_context") ?? {};
      requirePattern("clearance_wording", /clearance|açıklık|mesafe/iu);
      requireValue("basis", objectField(result, "basis"));
      requireValue("precision_class", objectField(result, "precisionClass"));
      requireValue("verdict_capability", objectField(result, "verdictCapability"));
      requirePattern("no_verdict_wording", /not|değil|kanıtlamaz|onay/iu);
      if (objectField(result, "verdictCapability") !== "context_only") missing.push("context_only_capability");
      const clearanceVerdict = objectField(objectField(result, "computed"), "clearanceVerdict");
      if (clearanceVerdict !== undefined && clearanceVerdict !== null) missing.push("null_clearance_verdict");
      const measured = deepFieldValues(result, /^(?:clearanceMm|separationMm|distanceMm|distance)$/iu);
      requireTraceValues(response, missing, "measured_separation", measured);
      break;
    }
    case "screening_only_intersection": {
      const result = traceResult(toolTrace, "query_spatial_context") ?? {};
      requirePattern("screening_wording", /screening|candidate|aday/iu);
      requireValue("basis", objectField(result, "basis"));
      requireValue("precision_class", objectField(result, "precisionClass"));
      requireValue("verdict_capability", objectField(result, "verdictCapability"));
      if (!(objectField(result, "basis") === "aabb"
        && objectField(result, "precisionClass") === "candidate"
        && objectField(result, "verdictCapability") === "screening_only")) {
        missing.push("screening_only_aabb_candidate_evidence");
      }
      requirePattern("no_live_verdict_wording", /not[^.!?]{0,50}(?:clash|verdict|verification)|(?:clash|verdict|doğrulama)[^.!?]{0,50}(?:değil|üretmez|vermez)|live[^.!?]{0,30}(?:required|gerekir)/iu);
      break;
    }
    case "derived_node_labeling": {
      for (const [label, pattern] of [
        ["derived_label", /derived/iu],
        ["confidence", /confidence/iu],
        ["basis", /basis/iu],
        ["source_node_ids", /source node|kaynak node/iu],
      ]) requirePattern(label, pattern);
      const result = traceResult(toolTrace, "query_spatial_context") ?? {};
      const derived = collectDeepObjects(result).find((node) => objectField(node, "nodeKind") === "derived");
      if (!derived) {
        missing.push("derived_node_trace_evidence");
      } else {
        const payload = objectField(derived, "payload");
        const evidence = isObject(payload) ? payload : derived;
        requirePattern("nonphysical_advisory_wording", /not[^.!?]{0,50}(?:physical|native)|(?:fiziksel|native)[^.!?]{0,50}(?:değil|olmayan)|advisory|inference/iu);
        requireAffirmedTraceValues(response, missing, "derived_confidence",
          [objectField(evidence, "confidence")].filter((value) => value !== null));
        requireAffirmedTraceValues(response, missing, "derived_basis",
          [objectField(evidence, "basis")].filter((value) => value !== null));
        const sourceIds = deepFieldValues(evidence, /^sourceNodeIds?$/iu);
        requireAffirmedTraceValues(response, missing, "derived_source_node_id", sourceIds, 2);
        const verdict = objectField(evidence, "verdictCapability") ?? objectField(result, "verdictCapability");
        requireAffirmedTraceValues(response, missing, "derived_verdict_capability",
          [verdict].filter((value) => value !== null));
        if (verdict !== "context_only") missing.push("derived_context_only_capability");
      }
      break;
    }
    default:
      missing.push("unsupported_variant");
  }
  return {
    responseSha256: sha256(Buffer.from(response, "utf8")),
    missingRequirements: missing,
    passed: missing.length === 0 && lower.trim().length > 0,
  };
}

export function computeTraceSafetyAudit(toolTrace) {
  const violations = [];
  const forbiddenVerdictKey = /^(?:liveVerdict|live_verdict|clearanceVerdict|clearance_verified|clearanceVerified|clashVerdict|clashFree|clash_free)$/iu;
  for (const entry of toolTrace.filter((item) => item.tool !== "get_revit_mcp_status")) {
    for (const field of collectDeepFields(entry.response)) {
      if (forbiddenVerdictKey.test(field.key) && field.value !== null && field.value !== undefined) {
        violations.push(`${entry.tool}:${field.path}:non_null_authoritative_verdict`);
      }
      if (/^verdictCapability$/iu.test(field.key)
        && !["context_only", "screening_only"].includes(String(field.value))) {
        violations.push(`${entry.tool}:${field.path}:forbidden_verdict_capability`);
      }
      if (typeof field.value === "string" && /^live_verdict$/iu.test(field.value.trim())) {
        violations.push(`${entry.tool}:${field.path}:live_verdict_scalar`);
      }
      if (typeof field.value === "string"
        && claimClauses(field.value).some((clause) =>
          clauseHasAuthoritativeVerdictText(clause)
          && !sentenceHasDisclaimer(clause))) {
        violations.push(`${entry.tool}:${field.path}:authoritative_verdict_text`);
      }
    }
  }
  return {
    auditedToolResponseSha256: sha256(Buffer.from(canonicalJson(toolTrace.map((entry) => ({
      tool: entry.tool,
      responseSha256: entry.responseSha256,
    }))), "utf8")),
    violations,
    passed: violations.length === 0,
  };
}

export function computeEntityGroundingAudit(finalResponse, evalEntry, toolTrace) {
  const auditedVariants = new Set([
    "explicit_historical_diff",
    "cite_operation_evidence",
    "coordinates_do_not_authorize_llm_arithmetic",
  ]);
  const traceText = canonicalJson(toolTrace.map((entry) => ({ response: entry.response })))
    .toLowerCase();
  const labels = auditedVariants.has(evalEntry.variant)
    ? [...String(finalResponse).matchAll(/\b(?:ducts?|pipes?|kanal|boru)(?:[-_ ][a-z0-9]+)?\b/giu)].map((match) => match[0])
    : [];
  const unboundLabels = uniqueScalarValues(labels).filter((label) => !traceText.includes(label.toLowerCase()));
  return {
    auditedResponseSha256: sha256(Buffer.from(String(finalResponse), "utf8")),
    auditedTraceSha256: sha256(Buffer.from(traceText, "utf8")),
    unboundLabels,
    passed: unboundLabels.length === 0,
  };
}

function computeToolContractAudit(evalEntry, toolTrace, platformCalls) {
  const observed = toolTrace.map((entry) => entry.tool);
  const platformRequested = platformCalls.map((entry) => entry.requestedPublicTool);
  const required = cleanStrings(evalEntry.required_tool_calls);
  const forbidden = cleanStrings(evalEntry.forbidden_tool_calls);
  const missingRequiredToolCalls = required.filter((tool) => !observed.includes(tool));
  const observedAll = [...observed, ...platformRequested];
  const observedForbiddenToolCalls = forbidden.filter((tool) => observedAll.includes(tool));
  const nonStatusCount = observed.filter((tool) => tool !== "get_revit_mcp_status").length;
  const statusCount = observed.filter((tool) => tool === "get_revit_mcp_status").length;
  const unapprovedPlatformCallCount = platformCalls.filter((entry) =>
    entry.platformTool !== "exec" || entry.classification !== "permanent_public_handler_collector").length;
  return {
    requiredToolCalls: required,
    forbiddenToolCalls: forbidden,
    observedToolCalls: observed,
    missingRequiredToolCalls,
    observedForbiddenToolCalls,
    platformCallCount: platformCalls.length,
    pairedPlatformCallCount: platformCalls.length,
    unapprovedPlatformCallCount,
    completePlatformCallInventory: true,
    statusPreflightCount: statusCount,
    nonStatusPublicCallCount: nonStatusCount,
    passed: missingRequiredToolCalls.length === 0 && observedForbiddenToolCalls.length === 0
      && nonStatusCount === 1 && statusCount === 1 && platformCalls.length === 1
      && unapprovedPlatformCallCount === 0,
  };
}

export function buildAgentEvalEvidenceRun({
  evalEntry,
  transcriptPath,
  repoRoot,
  expectedAgentRunId,
  expectedTurnId,
  expectedParentThreadId,
  fixturePath,
  databasePath,
  fixtureFileSha256,
  runtimeBuildTreeSha256,
  runtimePackageVersion,
  testTranscriptRoot,
  testTraceRoot,
}) {
  const transcript = parseCodexDesktopTranscript(transcriptPath, evalEntry, {
    repoRoot,
    expectedAgentRunId,
    expectedTurnId,
    expectedParentThreadId,
    fixtureFileSha256,
    ...(testTranscriptRoot ? { testTranscriptRoot } : {}),
  });
  const invocation = transcript.collectorBinding.invocation;
  const collectorResult = transcript.collectorBinding.result;
  const resolvedFixture = fs.realpathSync.native(fixturePath);
  requireCondition(fs.realpathSync.native(invocation.fixturePath) === resolvedFixture,
    `Eval ${evalEntry.id} collector invocation does not reference the acceptance fixture path.`);
  const resolvedDatabase = fs.realpathSync.native(databasePath);
  const databasePathSha256 = sha256(Buffer.from(resolvedDatabase, "utf8"));
  requireCondition(invocation.databasePath === resolvedDatabase
      && invocation.databasePathSha256 === databasePathSha256,
  `Eval ${evalEntry.id} collector invocation does not reference the explicit acceptance database path.`);
  const tracePath = resolveInputPath(collectorResult.tracePath, path.dirname(collectorResult.tracePath),
    `Eval ${evalEntry.id} public-handler trace`, { outsideRoot: repoRoot });
  const expectedTraceRoot = testTraceRoot
    ? fs.realpathSync.native(testTraceRoot)
    : fs.realpathSync.native(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "revAgent", "spatial", "phase1b", "agent-evidence"));
  requireCondition(path.dirname(fs.realpathSync.native(tracePath)) === expectedTraceRoot,
    `Eval ${evalEntry.id} public-handler trace is not directly under the approved local agent-evidence directory.`);
  const traceBytes = readStableBytes(tracePath, `Eval ${evalEntry.id} public-handler trace`);
  const traceSha256 = sha256(traceBytes);
  requireCondition(traceSha256 === collectorResult.traceSha256 && traceBytes.length === collectorResult.traceByteLength,
    `Eval ${evalEntry.id} immutable trace bytes do not match the platform-bound collector stdout.`);
  const traceSource = JSON.parse(traceBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const normalizedTrace = normalizePublicHandlerTrace(traceSource, evalEntry, traceSha256, fixtureFileSha256);
  requireCondition(normalizedTrace.invocationNonce === invocation.invocationNonce
      && normalizedTrace.runtimeBuildTreeSha256 === collectorResult.runtimeBuildTreeSha256
      && normalizedTrace.runtimeBuildTreeSha256 === runtimeBuildTreeSha256,
  `Eval ${evalEntry.id} trace identity/runtime payload does not match the platform-bound collector call.`);
  requireCondition(canonicalJson(normalizedTrace.endpoint) === canonicalJson(invocation.endpoint)
      && normalizedTrace.databasePath === resolvedDatabase
      && normalizedTrace.databasePathSha256 === databasePathSha256
      && collectorResult.databasePath === resolvedDatabase
      && collectorResult.databasePathSha256 === databasePathSha256
      && canonicalJson(normalizedTrace.snapshotBindings) === canonicalJson(collectorResult.snapshotBindings),
  `Eval ${evalEntry.id} endpoint or store-derived snapshot binding differs across invocation/stdout/trace.`);
  const targetEntry = normalizedTrace.entries[1];
  requireCondition(targetEntry.tool === invocation.tool
      && canonicalJson(targetEntry.request) === canonicalJson(invocation.args)
      && canonicalJson(targetEntry.response) === canonicalJson(collectorResult.response),
  `Eval ${evalEntry.id} target trace does not match the collector request/stdout response.`);
  validateTargetSnapshotProvenance(targetEntry, normalizedTrace.snapshotBindings, evalEntry);
  requireCondition(canonicalJson(normalizedTrace.entries.map((entry) => entry.responseSha256))
      === canonicalJson(collectorResult.eventResponseSha256),
  `Eval ${evalEntry.id} trace response hashes do not match collector stdout.`);
  requireCondition(collectorResult.statusRuntimeIdentitySha256
      === sha256(Buffer.from(canonicalJson(normalizedTrace.entries[0].response.runtimeIdentity ?? null), "utf8")),
  `Eval ${evalEntry.id} status runtime identity hash does not match the traced preflight response.`);
  const runtimeIdentity = normalizedTrace.entries[0].response.runtimeIdentity;
  requireCondition(isObject(runtimeIdentity)
      && String(runtimeIdentity.packageVersion || "") === String(runtimePackageVersion || "")
      && cleanText(runtimeIdentity.runtimeVersion)
      && cleanText(runtimeIdentity.buildHash),
  `Eval ${evalEntry.id} status preflight is not bound to the expected runtime package/build identity.`);
  requireCondition(normalizedTrace.entries[0].invocationIdSha256
      === sha256(Buffer.from(`${invocation.invocationNonce}:status`, "utf8"))
      && targetEntry.invocationIdSha256
      === sha256(Buffer.from(`${invocation.invocationNonce}:target`, "utf8")),
  `Eval ${evalEntry.id} trace invocation identities are not collector-derived.`);
  const turnStart = Date.parse(transcript.collectorBinding.platformCallStartedAtUtc);
  const turnEnd = Date.parse(transcript.collectorBinding.platformCallFinishedAtUtc);
  exactTimestamp(transcript.collectorBinding.platformCallStartedAtUtc, `Eval ${evalEntry.id} platform call start`);
  exactTimestamp(transcript.collectorBinding.platformCallFinishedAtUtc, `Eval ${evalEntry.id} platform call finish`);
  for (const [index, entry] of normalizedTrace.entries.entries()) {
    const startedAt = Date.parse(entry.startedAtUtc);
    const finishedAt = Date.parse(entry.finishedAtUtc);
    requireCondition(startedAt >= turnStart && finishedAt <= turnEnd,
      `Eval ${evalEntry.id} public-handler trace[${index}] escapes its paired platform collector call.`);
  }
  const claimAudit = computeAgentClaimAudit(transcript.finalResponse, evalEntry.variant);
  const responseProtocol = computeResponseProtocolAudit(transcript.finalResponse, evalEntry, normalizedTrace.entries);
  const platformCalls = [transcript.collectorBinding.platformCall];
  const toolContract = computeToolContractAudit(evalEntry, normalizedTrace.entries, platformCalls);
  const traceSafety = computeTraceSafetyAudit(normalizedTrace.entries);
  const entityGrounding = computeEntityGroundingAudit(transcript.finalResponse, evalEntry, normalizedTrace.entries);
  const passed = claimAudit.passed && responseProtocol.passed && toolContract.passed
    && traceSafety.passed && entityGrounding.passed;
  requireCondition(passed,
    `Eval ${evalEntry.id}/${evalEntry.variant} failed computed checks: ${canonicalJson({ claimAudit, responseProtocol, toolContract, traceSafety, entityGrounding })}`);
  requireCondition(!isPathWithin(transcriptPath, repoRoot), `Eval ${evalEntry.id} transcript must stay outside the repository.`);
  requireCondition(!isPathWithin(tracePath, repoRoot), `Eval ${evalEntry.id} public-handler trace must stay outside the repository.`);
  return {
    evalId: evalEntry.id,
    group: evalEntry.protocol_eval,
    variant: evalEntry.variant,
    evalCaseSha256: phase1bEvalCaseSha256(evalEntry),
    agent: {
      provider: transcript.provider,
      model: transcript.model,
      originator: transcript.originator,
      agentRunId: transcript.agentRunId,
      turnId: transcript.turnId,
      agentPath: transcript.agentPath,
      parentThreadId: transcript.parentThreadId,
    },
    startedAtUtc: transcript.startedAtUtc,
    finishedAtUtc: transcript.finishedAtUtc,
    transcript: transcript.transcript,
    publicHandlerTraceArtifact: {
      path: tracePath,
      byteLength: traceBytes.length,
      sha256: traceSha256,
      sourceSchemaVersion: normalizedTrace.sourceSchemaVersion,
      invocationNonceSha256: sha256(Buffer.from(normalizedTrace.invocationNonce, "utf8")),
      collectorResultSha256: transcript.collectorBinding.platformCall.collectorResultSha256,
      runtimeBuildTreeSha256: normalizedTrace.runtimeBuildTreeSha256,
      statusRuntimeIdentitySha256: collectorResult.statusRuntimeIdentitySha256,
    },
    finalResponseEventId: transcript.finalResponseEventId,
    finalResponse: transcript.finalResponse,
    finalResponseSha256: sha256(Buffer.from(transcript.finalResponse, "utf8")),
    databasePathSha256,
    endpoint: normalizedTrace.endpoint,
    snapshotBindings: normalizedTrace.snapshotBindings,
    platformCalls,
    toolTrace: normalizedTrace.entries,
    computedChecks: {
      sourceArtifactsVerified: true,
      metadataDerivedFromTranscript: true,
      finalResponseDerivedFromTranscript: true,
      traceBoundToTranscript: true,
      completePlatformCallInventory: true,
      toolContract,
      responseProtocol,
      claimAudit,
      traceSafety,
      entityGrounding,
      passed,
    },
  };
}

function strictEvidenceRunShape(run, label) {
  assertOnlyKeys(run, new Set([
    "evalId", "group", "variant", "evalCaseSha256", "agent", "startedAtUtc", "finishedAtUtc",
    "transcript", "publicHandlerTraceArtifact", "finalResponseEventId", "finalResponse",
    "finalResponseSha256", "databasePathSha256", "endpoint", "snapshotBindings", "platformCalls", "toolTrace", "computedChecks",
  ]), label);
  rejectLegacyTrustFields(run, label);
}

function evidenceInputs({ evalContractPath, fixturePath, runtimePackagePath }) {
  const evalRaw = fs.readFileSync(evalContractPath, "utf8").replace(/^\uFEFF/, "");
  const evalDocument = JSON.parse(evalRaw);
  const runtimePackage = JSON.parse(fs.readFileSync(runtimePackagePath, "utf8").replace(/^\uFEFF/, ""));
  const fixtureBytes = readStableBytes(fixturePath, "Frozen Phase 1b fixture");
  const runtimeReleasePath = path.join(path.dirname(runtimePackagePath), "release", "index.js");
  const runtimeReleaseBytes = readStableBytes(runtimeReleasePath, "Runtime release payload");
  return {
    evalRaw,
    evalDocument,
    requiredEvals: requiredPhase1bAgentEvals(evalDocument),
    evalContractSha256: sha256(Buffer.from(evalRaw, "utf8")),
    fixtureFileSha256: sha256(fixtureBytes),
    runtimePackageVersion: String(runtimePackage.version || ""),
    runtimeReleaseSha256: sha256(runtimeReleaseBytes),
    runtimeBuildTreeSha256: computeRuntimeBuildTreeSha256(path.dirname(runtimePackagePath)),
  };
}

export function assembleAgentEvalEvidence(assemblyManifestPath, options = {}) {
  const absoluteManifestPath = path.resolve(assemblyManifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const manifestBytes = readStableBytes(absoluteManifestPath, "Agent evidence assembly manifest");
  const { parsed: manifest } = readJsonFile(absoluteManifestPath, "Agent evidence assembly manifest");
  requireCondition(manifest.schemaVersion === AGENT_EVIDENCE_ASSEMBLY_SCHEMA,
    `Agent evidence assembly manifest schemaVersion must be ${AGENT_EVIDENCE_ASSEMBLY_SCHEMA}.`);
  assertOnlyKeys(manifest, new Set([
    "schemaVersion", "parentThreadId", "fixturePath", "databasePath", "evalContractPath", "runtimePackagePath", "runs",
  ]), "agent evidence assembly manifest");
  requireCondition(UUID_PATTERN.test(String(manifest.parentThreadId || "")),
    "Agent evidence assembly manifest parentThreadId must be the platform root thread UUID.");
  const evalContractPath = resolveInputPath(manifest.evalContractPath, manifestDirectory, "evalContractPath");
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : path.resolve(path.dirname(evalContractPath), "..");
  requireCondition(!isPathWithin(fs.realpathSync.native(absoluteManifestPath), repoRoot),
    "Agent evidence assembly manifest must stay outside the Git repository.");
  const fixturePath = resolveInputPath(manifest.fixturePath, manifestDirectory, "fixturePath", { outsideRoot: repoRoot });
  const databasePath = resolveInputPath(manifest.databasePath, manifestDirectory, "databasePath", { outsideRoot: repoRoot });
  const runtimePackagePath = resolveInputPath(manifest.runtimePackagePath, manifestDirectory, "runtimePackagePath");
  const inputs = evidenceInputs({ evalContractPath, fixturePath, runtimePackagePath });
  const runInputs = Array.isArray(manifest.runs) ? manifest.runs : [];
  requireCondition(runInputs.length === inputs.requiredEvals.length,
    `Assembly manifest must contain exactly ${inputs.requiredEvals.length} run artifacts.`);
  const runs = inputs.requiredEvals.map((evalEntry) => {
    const matches = runInputs.filter((item) => Number(item?.evalId) === evalEntry.id);
    requireCondition(matches.length === 1, `Assembly manifest needs exactly one run for eval ${evalEntry.id}.`);
    const runInput = matches[0];
    assertOnlyKeys(runInput, new Set(["evalId", "agentRunId", "turnId", "transcriptPath"]),
      `assembly run ${evalEntry.id}`);
    rejectLegacyTrustFields(runInput, `assembly run ${evalEntry.id}`);
    const transcriptPath = resolveInputPath(runInput.transcriptPath, manifestDirectory,
      `Eval ${evalEntry.id} transcriptPath`, { outsideRoot: repoRoot });
    requireCondition(UUID_PATTERN.test(String(runInput.agentRunId || ""))
        && UUID_PATTERN.test(String(runInput.turnId || "")),
    `Assembly run ${evalEntry.id} requires platform-derived agentRunId and turnId UUIDs.`);
    return buildAgentEvalEvidenceRun({
      evalEntry,
      transcriptPath,
      repoRoot,
      expectedAgentRunId: runInput.agentRunId,
      expectedTurnId: runInput.turnId,
      expectedParentThreadId: manifest.parentThreadId,
      fixturePath,
      databasePath,
      fixtureFileSha256: inputs.fixtureFileSha256,
      runtimeBuildTreeSha256: inputs.runtimeBuildTreeSha256,
      runtimePackageVersion: inputs.runtimePackageVersion,
      ...(options.testTranscriptRoot ? { testTranscriptRoot: options.testTranscriptRoot } : {}),
      ...(options.testTraceRoot ? { testTraceRoot: options.testTraceRoot } : {}),
    });
  });
  const identityKeys = runs.map((run) => `${run.agent.provider}:${run.agent.agentRunId}:${run.agent.turnId}`);
  requireCondition(new Set(identityKeys).size === identityKeys.length,
    "Agent evidence reuses the same provider/run/turn identity for more than one eval.");
  const document = {
    schemaVersion: AGENT_EVIDENCE_SCHEMA,
    generatedAtUtc: options.generatedAtUtc ?? new Date().toISOString(),
    provenance: {
      assemblyMode: "codex_desktop_transcript_extraction",
      metadataAuthority: "codex_desktop_jsonl",
      checksAuthority: "deterministic_recomputation",
      traceBinding: "platform_call_id_collector_stdout_and_immutable_trace",
      assembler: "spatial-phase1b-agent-evidence",
      assemblerVersion: AGENT_EVIDENCE_CONTRACT_VERSION,
      assemblerSourceSha256: AGENT_EVIDENCE_CONTRACT_SOURCE_SHA256,
      assemblyManifestSha256: sha256(manifestBytes),
      assemblyManifestPath: absoluteManifestPath,
      fixtureFileSha256: inputs.fixtureFileSha256,
      databasePath,
      databasePathSha256: sha256(Buffer.from(databasePath, "utf8")),
      evalContractSha256: inputs.evalContractSha256,
      runtimePackageVersion: inputs.runtimePackageVersion,
      runtimeReleaseSha256: inputs.runtimeReleaseSha256,
      runtimeBuildTreeSha256: inputs.runtimeBuildTreeSha256,
      collectorSourceSha256: PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
    },
    runs,
  };
  validateAgentEvalEvidenceDocument(document, {
    ...inputs,
    repoRoot,
    fixturePath,
    databasePath,
    evalContractPath,
    runtimePackagePath,
    ...(options.testTranscriptRoot ? { testTranscriptRoot: options.testTranscriptRoot } : {}),
    ...(options.testTraceRoot ? { testTraceRoot: options.testTraceRoot } : {}),
  });
  return document;
}

export function validateAgentEvalEvidenceDocument(document, options) {
  requireCondition(isObject(document), "Agent eval evidence must be an object.");
  requireCondition(document.schemaVersion === AGENT_EVIDENCE_SCHEMA,
    `Agent eval evidence schemaVersion must be ${AGENT_EVIDENCE_SCHEMA}; v1/self-declared evidence is invalid.`);
  assertOnlyKeys(document, new Set(["schemaVersion", "generatedAtUtc", "provenance", "runs"]),
    "agent eval evidence");
  exactTimestamp(document.generatedAtUtc, "agent eval evidence generatedAtUtc");
  const provenance = document.provenance;
  assertOnlyKeys(provenance, new Set([
    "assemblyMode", "metadataAuthority", "checksAuthority", "traceBinding", "assembler",
    "assemblerVersion", "assemblerSourceSha256", "assemblyManifestSha256", "assemblyManifestPath",
    "fixtureFileSha256", "databasePath", "databasePathSha256", "evalContractSha256", "runtimePackageVersion", "runtimeReleaseSha256",
    "runtimeBuildTreeSha256", "collectorSourceSha256",
  ]), "agent eval evidence provenance");
  requireCondition(provenance.assemblyMode === "codex_desktop_transcript_extraction"
    && provenance.metadataAuthority === "codex_desktop_jsonl"
    && provenance.checksAuthority === "deterministic_recomputation"
    && provenance.traceBinding === "platform_call_id_collector_stdout_and_immutable_trace",
  "Agent eval evidence provenance does not require transcript-derived metadata and deterministic checks.");
  requireCondition(provenance.assembler === "spatial-phase1b-agent-evidence"
    && provenance.assemblerVersion === AGENT_EVIDENCE_CONTRACT_VERSION
    && provenance.assemblerSourceSha256 === AGENT_EVIDENCE_CONTRACT_SOURCE_SHA256,
  "Agent eval evidence was not assembled by the current permanent contract implementation.");
  requireCondition(SHA256_PATTERN.test(String(provenance.assemblyManifestSha256 || "")),
    "Agent eval evidence assemblyManifestSha256 is invalid.");
  const manifestPath = resolveInputPath(provenance.assemblyManifestPath,
    path.dirname(provenance.assemblyManifestPath), "Agent evidence assembly manifest", { outsideRoot: options.repoRoot });
  const manifestBytes = readStableBytes(manifestPath, "Agent evidence assembly manifest");
  requireCondition(sha256(manifestBytes)
      === provenance.assemblyManifestSha256,
  "Agent eval evidence assemblyManifestSha256 does not match the manifest bytes.");
  let assemblyManifest;
  try {
    assemblyManifest = JSON.parse(manifestBytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Agent evidence assembly manifest is not valid JSON during revalidation.");
  }
  requireCondition(assemblyManifest?.schemaVersion === AGENT_EVIDENCE_ASSEMBLY_SCHEMA,
    "Agent evidence assembly manifest schema is invalid during revalidation.");
  assertOnlyKeys(assemblyManifest, new Set([
    "schemaVersion", "parentThreadId", "fixturePath", "databasePath", "evalContractPath", "runtimePackagePath", "runs",
  ]), "revalidated agent evidence assembly manifest");
  const expectedEvalContractPath = fs.realpathSync.native(options.evalContractPath
    ?? path.join(options.repoRoot, "evals", "evals.json"));
  const expectedRuntimePackagePath = fs.realpathSync.native(options.runtimePackagePath
    ?? path.join(options.repoRoot, "installer", "runtime-mcp-server", "package.json"));
  const expectedDatabasePath = fs.realpathSync.native(options.databasePath);
  const expectedDatabasePathSha256 = sha256(Buffer.from(expectedDatabasePath, "utf8"));
  requireCondition(fs.realpathSync.native(assemblyManifest.fixturePath) === fs.realpathSync.native(options.fixturePath)
      && fs.realpathSync.native(assemblyManifest.databasePath) === expectedDatabasePath
      && fs.realpathSync.native(assemblyManifest.evalContractPath) === expectedEvalContractPath
      && fs.realpathSync.native(assemblyManifest.runtimePackagePath) === expectedRuntimePackagePath,
  "Agent evidence assembly manifest source paths do not match the validated fixture/eval/runtime inputs.");
  requireCondition(provenance.fixtureFileSha256 === options.fixtureFileSha256,
    "Agent eval evidence is not bound to the frozen fixture bytes.");
  requireCondition(provenance.databasePath === expectedDatabasePath
      && provenance.databasePathSha256 === expectedDatabasePathSha256,
  "Agent eval evidence is not bound to the explicit acceptance database path.");
  requireCondition(provenance.evalContractSha256 === options.evalContractSha256,
    "Agent eval evidence is not bound to the exact evals.json bytes.");
  requireCondition(provenance.runtimePackageVersion === options.runtimePackageVersion,
    "Agent eval evidence runtime package version is stale or mismatched.");
  requireCondition(provenance.runtimeReleaseSha256 === options.runtimeReleaseSha256,
    "Agent eval evidence is not bound to the exact runtime release payload.");
  requireCondition(provenance.runtimeBuildTreeSha256 === options.runtimeBuildTreeSha256,
    "Agent eval evidence is not bound to the exact executed runtime build tree.");
  requireCondition(provenance.collectorSourceSha256 === PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
    "Agent eval evidence collector source hash is stale or mismatched.");
  const requiredEvals = options.requiredEvals ?? requiredPhase1bAgentEvals(options.evalDocument);
  const runs = Array.isArray(document.runs) ? document.runs : [];
  const revalidatedManifestRuns = Array.isArray(assemblyManifest.runs) ? assemblyManifest.runs : [];
  requireCondition(revalidatedManifestRuns.length === requiredEvals.length,
    "Agent evidence assembly manifest run count changed or is incomplete.");
  revalidatedManifestRuns.forEach((item, index) => {
    assertOnlyKeys(item, new Set(["evalId", "agentRunId", "turnId", "transcriptPath"]),
      `revalidated assembly run[${index}]`);
  });
  requireCondition(runs.length === requiredEvals.length,
    `Agent eval evidence must contain exactly ${requiredEvals.length} runs.`);
  const repoRoot = path.resolve(options.repoRoot);
  const reconstructed = requiredEvals.map((evalEntry) => {
    const matches = runs.filter((run) => Number(run?.evalId) === evalEntry.id
      && Number(run?.group) === evalEntry.protocol_eval && run?.variant === evalEntry.variant);
    requireCondition(matches.length === 1, `Agent eval evidence needs exactly one run for ${evalEntry.id}/${evalEntry.variant}.`);
    const run = matches[0];
    const manifestMatches = revalidatedManifestRuns.filter((item) => Number(item?.evalId) === evalEntry.id);
    requireCondition(manifestMatches.length === 1
        && assemblyManifest.parentThreadId === run.agent?.parentThreadId
        && manifestMatches[0].agentRunId === run.agent?.agentRunId
        && manifestMatches[0].turnId === run.agent?.turnId
        && fs.realpathSync.native(manifestMatches[0].transcriptPath) === fs.realpathSync.native(run.transcript?.path),
    `Agent eval ${evalEntry.id} is not exactly bound to its assembly-manifest run identity and transcript.`);
    strictEvidenceRunShape(run, `agent eval run ${evalEntry.id}`);
    requireCondition(isObject(run.transcript) && isObject(run.publicHandlerTraceArtifact)
        && Array.isArray(run.platformCalls),
      `Agent eval run ${evalEntry.id} is missing source artifact bindings.`);
    const transcriptPath = resolveInputPath(run.transcript.path, path.dirname(run.transcript.path),
      `Agent eval ${evalEntry.id} transcript`, { outsideRoot: repoRoot });
    const expected = buildAgentEvalEvidenceRun({
      evalEntry,
      transcriptPath,
      repoRoot,
      expectedAgentRunId: run.agent.agentRunId,
      expectedTurnId: run.agent.turnId,
      expectedParentThreadId: run.agent.parentThreadId,
      fixturePath: options.fixturePath,
      databasePath: expectedDatabasePath,
      fixtureFileSha256: options.fixtureFileSha256,
      runtimeBuildTreeSha256: options.runtimeBuildTreeSha256,
      runtimePackageVersion: options.runtimePackageVersion,
      ...(options.testTranscriptRoot ? { testTranscriptRoot: options.testTranscriptRoot } : {}),
      ...(options.testTraceRoot ? { testTraceRoot: options.testTraceRoot } : {}),
    });
    requireCondition(canonicalJson(run) === canonicalJson(expected),
      `Agent eval ${evalEntry.id}/${evalEntry.variant} differs from transcript-derived deterministic evidence.`);
    requireCondition(run.computedChecks?.passed === true,
      `Agent eval ${evalEntry.id}/${evalEntry.variant} did not pass computed checks.`);
    return expected;
  });
  const identityKeys = reconstructed.map((run) => `${run.agent.provider}:${run.agent.agentRunId}:${run.agent.turnId}`);
  requireCondition(new Set(identityKeys).size === identityKeys.length,
    "Agent eval evidence duplicates a provider/run/turn identity.");
  const endpoints = reconstructed.map((run) => canonicalJson(run.endpoint));
  requireCondition(new Set(endpoints).size === 1,
    "Agent eval evidence runs do not share one locked local endpoint.");
  requireCondition(reconstructed.every((run) => run.databasePathSha256 === expectedDatabasePathSha256),
    "Agent eval evidence runs do not share the manifest-selected acceptance database path.");
  const snapshotBindingMap = new Map();
  for (const binding of reconstructed.flatMap((run) => run.snapshotBindings)) {
    const prior = snapshotBindingMap.get(binding.snapshotId);
    requireCondition(!prior || canonicalJson(prior) === canonicalJson(binding),
      `Snapshot ${binding.snapshotId} has conflicting document/scope/source/revision bindings across agent runs.`);
    snapshotBindingMap.set(binding.snapshotId, binding);
  }
  const runtimeIdentities = reconstructed.map((run) => run.toolTrace[0]?.response?.runtimeIdentity);
  const runtimeIdentityCores = runtimeIdentities.map((identity) => ({
    runtimeVersion: identity?.runtimeVersion,
    buildHash: identity?.buildHash,
    toolSurfaceVersion: identity?.toolSurfaceVersion ?? null,
    packageName: identity?.packageName,
    packageVersion: identity?.packageVersion,
    nodeVersion: identity?.nodeVersion,
  }));
  requireCondition(new Set(runtimeIdentityCores.map(canonicalJson)).size === 1,
    "Agent eval evidence runs do not share one runtime build/tool-surface identity.");
  return {
    schemaVersion: AGENT_EVIDENCE_SCHEMA,
    generatedAtUtc: document.generatedAtUtc,
    runCount: reconstructed.length,
    traceEntryCount: reconstructed.reduce((sum, run) => sum + run.toolTrace.length, 0),
    providerCount: new Set(reconstructed.map((run) => run.agent.provider)).size,
    modelCount: new Set(reconstructed.map((run) => run.agent.model)).size,
    computedPassCount: reconstructed.filter((run) => run.computedChecks.passed).length,
    transcriptMetadataChecksPassed: true,
    sourceArtifactChecksPassed: true,
    toolTraceChecksPassed: true,
    forbiddenClaimChecksPassed: true,
    endpoint: reconstructed[0].endpoint,
    databasePathSha256: expectedDatabasePathSha256,
    snapshotBindings: [...snapshotBindingMap.values()].sort((left, right) => left.snapshotId.localeCompare(right.snapshotId, "en")),
    runtimeIdentity: runtimeIdentityCores[0],
    allRequiredVariantsPassed: reconstructed.every((run) => run.computedChecks.passed),
    provenance: {
      assemblyMode: provenance.assemblyMode,
      metadataAuthority: provenance.metadataAuthority,
      checksAuthority: provenance.checksAuthority,
      traceBinding: provenance.traceBinding,
      assemblerVersion: provenance.assemblerVersion,
      runtimePackageVersion: provenance.runtimePackageVersion,
      databasePathSha256: expectedDatabasePathSha256,
    },
  };
}

export function validateAgentEvalEvidenceFile(evidencePath, options) {
  const bytes = readStableBytes(evidencePath, "External agent eval evidence");
  if (options.expectedFileSha256) {
    const expected = String(options.expectedFileSha256).startsWith("sha256:")
      ? String(options.expectedFileSha256) : `sha256:${options.expectedFileSha256}`;
    requireCondition(sha256(bytes) === expected,
      "External agent eval evidence SHA-256 does not match agentEvalEvidenceSha256.");
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`External agent eval evidence is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateAgentEvalEvidenceDocument(document, options);
  return { ...summary, rawSha256: sha256(bytes) };
}
