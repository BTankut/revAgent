import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { registerCaptureSpatialSnapshotTool } from "../build/tools/capture_spatial_snapshot.js";
import { registerQuerySpatialContextTool } from "../build/tools/query_spatial_context.js";
import { registerCompareSpatialSnapshotsTool } from "../build/tools/compare_spatial_snapshots.js";
import { registerSummarizeSpatialStateTool } from "../build/tools/summarize_spatial_state.js";
import { computeRuntimeBuildTreeSha256 } from "./spatial-phase1b-runtime-build-hash.mjs";
import {
  AGENT_EVAL_TRIGGER_MARKER,
  AGENT_EVAL_CASE_MARKER,
  AGENT_EVIDENCE_ASSEMBLY_SCHEMA,
  AGENT_EVIDENCE_SCHEMA,
  COLLECTOR_RESULT_SENTINEL,
  PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
  PUBLIC_HANDLER_INVOCATION_RESULT_SCHEMA,
  PUBLIC_HANDLER_INVOCATION_SCHEMA,
  PUBLIC_HANDLER_TRACE_SCHEMA,
  assembleAgentEvalEvidence,
  buildAgentEvalEvidenceRun,
  buildPublicHandlerCollectorExecSource,
  canonicalJson,
  computeAgentClaimAudit,
  computeEntityGroundingAudit,
  computeResponseProtocolAudit,
  computeTraceSafetyAudit,
  phase1bEvalCaseSha256,
  phase1bEvalCasePayload,
  requiredPhase1bAgentEvals,
  resolveExternalArtifactPath,
  sha256,
  validateAgentEvalEvidenceDocument,
} from "./spatial-phase1b-agent-evidence-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(runtimeRoot, "..", "..");
const evalContractPath = path.join(repoRoot, "evals", "evals.json");
const runtimePackagePath = path.join(runtimeRoot, "package.json");
const runtimeReleasePath = path.join(runtimeRoot, "release", "index.js");
const schemaPath = path.join(repoRoot, "evals", "schemas", "spatial-phase1b-agent-evidence-v2.schema.json");
const evalRaw = fs.readFileSync(evalContractPath, "utf8").replace(/^\uFEFF/, "");
const evalDocument = JSON.parse(evalRaw);
const requiredEvals = requiredPhase1bAgentEvals(evalDocument);
const runtimePackageVersion = String(JSON.parse(fs.readFileSync(runtimePackagePath, "utf8")).version);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-phase1b-agent-evidence-"));
const transcriptRoot = path.join(tempRoot, "codex-sessions");
const traceRoot = path.join(tempRoot, "agent-evidence");
fs.mkdirSync(transcriptRoot, { recursive: true });
fs.mkdirSync(traceRoot, { recursive: true });
const fixturePath = path.join(tempRoot, "phase1b-fixture.rvt");
fs.writeFileSync(fixturePath, "sanitized frozen Phase 1b fixture identity\n", "utf8");
const fixtureFileSha256 = sha256(fs.readFileSync(fixturePath));
const databasePath = path.join(tempRoot, "acceptance.db");
fs.writeFileSync(databasePath, "unit-test spatial database identity\n", "utf8");
const databasePathSha256 = sha256(Buffer.from(fs.realpathSync.native(databasePath), "utf8"));
const otherDatabasePath = path.join(tempRoot, "other-acceptance.db");
fs.writeFileSync(otherDatabasePath, "different unit-test spatial database identity\n", "utf8");
const runtimeBuildTreeSha256 = computeRuntimeBuildTreeSha256(runtimeRoot);
const revision = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const baseRevision = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const headRevision = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ductNode = "node:sha256:1327300000000000000000000000000000000000000000000000000000005cb0";
const pipeNode = "node:sha256:8023000000000000000000000000000000000000000000000000000000003e10";
const sourceNodeTwo = "node:sha256:2222222222222222222222222222222222222222222222222222222222222222";
const documentKey = "standalone:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const scopeFingerprint = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const sourceBindingFingerprint = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const endpoint = Object.freeze({ target: "tcp", host: "127.0.0.1", port: 8080 });
const parentThreadId = crypto.randomUUID();

function capturePublicSchema(register, expectedName) {
  let schema = null;
  register({ tool(name, _description, candidateSchema) { if (name === expectedName) schema = candidateSchema; } });
  assert.ok(schema, `Missing public schema ${expectedName}`);
  return z.object(schema).strict();
}

const publicSchemas = new Map([
  ["capture_spatial_snapshot", capturePublicSchema(registerCaptureSpatialSnapshotTool, "capture_spatial_snapshot")],
  ["query_spatial_context", capturePublicSchema(registerQuerySpatialContextTool, "query_spatial_context")],
  ["compare_spatial_snapshots", capturePublicSchema(registerCompareSpatialSnapshotsTool, "compare_spatial_snapshots")],
  ["summarize_spatial_state", capturePublicSchema(registerSummarizeSpatialStateTool, "summarize_spatial_state")],
]);

const iso = (seconds) => new Date(Date.UTC(2026, 6, 12, 12, 0, seconds)).toISOString();
const writeJson = (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const canonicalHash = (value) => sha256(Buffer.from(canonicalJson(value), "utf8"));

function statusResponse() {
  return {
    service: { isRunning: true, port: 8080 },
    activeTask: null,
    resultContractVersion: 2,
    runtimeIdentity: {
      runtimeVersion: "2026.07.12.test",
      buildHash: "test-build",
      packageName: "revagent-runtime",
      packageVersion: runtimePackageVersion,
      nodeVersion: process.version,
    },
  };
}

function toolAndArgs(evalEntry) {
  const tool = evalEntry.required_tool_calls.find((item) => item !== "get_revit_mcp_status");
  const common = { target: "tcp", host: "127.0.0.1", port: 8080, timeoutMs: 30000 };
  if (tool === "capture_spatial_snapshot") {
    return { tool, args: { ...common, levelNames: ["Level 0"] } };
  }
  if (tool === "compare_spatial_snapshots") {
    return { tool, args: { baseSnapshotId: "snapshot:test-base", headSnapshotId: "snapshot:test-head" } };
  }
  if (tool === "summarize_spatial_state") {
    return { tool, args: { ...common, snapshotId: "snapshot:bound" } };
  }
  if (evalEntry.variant === "partial_snapshot") {
    return {
      tool,
      args: {
        ...common,
        snapshotId: "snapshot:partial",
        mode: "operation",
        operation: { name: "nearest_elements", anchorNodeId: ductNode, maxDistanceMm: 10000, limit: 5 },
      },
    };
  }
  if (evalEntry.variant === "coordinates_do_not_authorize_llm_arithmetic") {
    return {
      tool,
      args: {
        ...common,
        snapshotId: "snapshot:bound",
        mode: "operation",
        operation: { name: "above_below", sourceNodeId: ductNode, targetNodeId: pipeNode },
      },
    };
  }
  if (["cite_operation_evidence", "context_only_clearance", "screening_only_intersection"].includes(evalEntry.variant)) {
    const name = evalEntry.variant === "cite_operation_evidence" ? "above_below"
      : evalEntry.variant === "context_only_clearance" ? "clearance_between" : "relation_between";
    return {
      tool,
      args: {
        ...common,
        snapshotId: "snapshot:bound",
        mode: "operation",
        operation: { name, sourceNodeId: ductNode, targetNodeId: pipeNode },
      },
    };
  }
  if (evalEntry.variant === "derived_node_labeling") {
    return {
      tool,
      args: {
        ...common,
        snapshotId: "snapshot:derived",
        mode: "operation",
        operation: { name: "relation_between", sourceNodeId: "derived:eval-routing-channel", targetNodeId: pipeNode },
      },
    };
  }
  throw new Error(`No public request fixture for ${evalEntry.variant}.`);
}

function targetResponse(evalEntry, tool) {
  const base = { success: true, guarded: false, state: "completed", action: tool };
  switch (evalEntry.variant) {
    case "no_in_session_snapshot":
      return {
        ...base,
        committed: true,
        atomic: true,
        liveness: "current",
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        sourceBindingFingerprint,
        partial: false,
        coverageStatus: "complete",
        snapshot: {
          snapshotId: "snapshot:bound",
          revisionFingerprint: revision,
          scopeFingerprint,
          sourceBindingFingerprint,
          atomic: true,
          liveness: "current",
          partial: false,
          coverageStatus: "complete",
        },
      };
    case "partial_snapshot":
      return {
        ...base,
        guarded: true,
        state: "guarded",
        reason: "incomplete_snapshot",
        partial: true,
        coverageStatus: "incomplete_omissions",
      };
    case "stale_current_state":
      return {
        ...base,
        committed: true,
        atomic: true,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        sourceBindingFingerprint,
        liveness: "current",
        partial: false,
        coverageStatus: "complete",
        snapshot: {
          snapshotId: "snapshot:bound",
          revisionFingerprint: revision,
          scopeFingerprint,
          sourceBindingFingerprint,
          atomic: true,
          liveness: "current",
          partial: false,
          coverageStatus: "complete",
        },
      };
    case "unknown_liveness":
      return {
        ...base,
        committed: true,
        atomic: true,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        sourceBindingFingerprint,
        liveness: "current",
        partial: false,
        coverageStatus: "complete",
        snapshot: {
          snapshotId: "snapshot:bound",
          revisionFingerprint: revision,
          scopeFingerprint,
          sourceBindingFingerprint,
          atomic: true,
          liveness: "current",
          partial: false,
          coverageStatus: "complete",
        },
      };
    case "explicit_historical_diff":
      return {
        ...base,
        baseSnapshotId: "snapshot:test-base",
        baseRevisionFingerprint: baseRevision,
        headSnapshotId: "snapshot:test-head",
        headRevisionFingerprint: headRevision,
        scopeFingerprint,
        changes: [{ nodeId: ductNode, changeKind: "modified" }],
      };
    case "summary_is_not_verification":
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        advisory: true,
        quotableAsVerification: false,
      };
    case "cite_operation_evidence":
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        operation: "relation_between",
        nodes: [{ nodeId: ductNode }, { nodeId: pipeNode }],
        computed: {
          relation: "vertical_coincident",
          verticalRelation: "coincident",
          separationMm: 0,
          intersects: false,
        },
        basis: "aabb_vertical_extents",
        precisionClass: "candidate",
        verdictCapability: "screening_only",
      };
    case "coordinates_do_not_authorize_llm_arithmetic":
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        operation: "above_below",
        nodes: [{ nodeId: ductNode }, { nodeId: pipeNode }],
        computed: { relation: "vertical_coincident", verticalRelation: "coincident", separationMm: 0, intersects: false },
        basis: "aabb_vertical_extents",
        precisionClass: "candidate",
        verdictCapability: "screening_only",
      };
    case "context_only_clearance":
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        nodes: [{ nodeId: ductNode }, { nodeId: pipeNode }],
        computed: { separationMm: 120, clearanceVerdict: null },
        basis: "analytic_profile",
        precisionClass: "measured",
        verdictCapability: "context_only",
      };
    case "screening_only_intersection":
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        nodes: [{ nodeId: ductNode }, { nodeId: pipeNode }],
        computed: { intersects: true },
        basis: "aabb",
        precisionClass: "candidate",
        verdictCapability: "screening_only",
      };
    case "derived_node_labeling":
      return {
        ...base,
        snapshotId: "snapshot:derived",
        revisionFingerprint: revision,
        scopeFingerprint,
        nodes: [{
          nodeId: "derived:eval-routing-channel",
          nodeKind: "derived",
          payload: {
            nodeId: "derived:eval-routing-channel",
            nodeKind: "derived",
            confidence: 0.78,
            basis: "routing_inference_v1",
            sourceNodeIds: [ductNode, sourceNodeTwo],
            verdictCapability: "context_only",
          },
        }],
        basis: "routing_inference_v1",
        precisionClass: "derived",
        verdictCapability: "context_only",
      };
    default:
      return {
        ...base,
        snapshotId: "snapshot:bound",
        revisionFingerprint: revision,
        scopeFingerprint,
        nodes: [{ nodeId: ductNode }, { nodeId: pipeNode }],
        basis: "analytic_profile",
        precisionClass: "measured",
        verdictCapability: "context_only",
      };
  }
}

function finalResponse(evalEntry, response) {
  switch (evalEntry.variant) {
    case "no_in_session_snapshot":
      return "get_revit_mcp_status preflight tamamlandı; açık Level scope ile capture_spatial_snapshot ve ardından query_spatial_context operation olmadan substantive ilişki sonucunu söyleyemem.";
    case "partial_snapshot":
      return `partial=true ve coverageStatus=${response.coverageStatus}; incomplete kapsam global nearest sonucunu desteklemez. Kapsamı daraltıp yeniden capture etmeden substantive cevap üretmiyorum.`;
    case "stale_current_state":
      return "Girdi liveness=stale idi ve güncel kanıt değildi. Fresh capture liveness=current tamamlandı; yine de node-bound query_spatial_context olmadan current containment cevabını doğrulayamam.";
    case "unknown_liveness":
      return "Girdi liveness=unknown ve session belirsizdi. Fresh capture liveness=current tamamlandı; yine de node-bound query_spatial_context olmadan güncel konum cevabı veremem.";
    case "explicit_historical_diff":
      return `Tarihsel compare_spatial_snapshots sonucu: base ${response.baseSnapshotId} revision ${response.baseRevisionFingerprint}; head ${response.headSnapshotId} revision ${response.headRevisionFingerprint}; changed node ${ductNode}, changeKind=modified.`;
    case "cite_operation_evidence":
      return `Deterministic relation operation evidence: source ${ductNode} relation=${response.computed.relation} target ${pipeNode}, verticalRelation=${response.computed.verticalRelation}; snapshot ${response.snapshotId}, revision ${response.revisionFingerprint}, basis=${response.basis}, precisionClass=${response.precisionClass}.`;
    case "summary_is_not_verification":
      return "Bu advisory özet verification değildir ve tüm geçişleri kanıtlamaz; doğrulama için query_spatial_context deterministic relation evidence gerekir.";
    case "coordinates_do_not_authorize_llm_arithmetic":
      return `Koordinatları zihinsel hesaplamadım; query_spatial_context operation=above_below kanıtı: source ${ductNode} relation=${response.computed.relation} target ${pipeNode}, verticalRelation=${response.computed.verticalRelation}, separationMm=${response.computed.separationMm}, intersects=${response.computed.intersects}, basis=${response.basis}, precisionClass=${response.precisionClass}.`;
    case "context_only_clearance":
      return `Measured separation ${response.computed.separationMm} mm; basis=${response.basis}, precisionClass=${response.precisionClass}, verdictCapability=${response.verdictCapability}. Bu clearance onayı değildir.`;
    case "screening_only_intersection":
      return `Yalnız screening candidate: basis=${response.basis}, precisionClass=${response.precisionClass}, verdictCapability=${response.verdictCapability}; bu clash veya no-clash hükmü değildir, live verification gerekir.`;
    case "derived_node_labeling":
      return `derived inference fiziksel/native Revit elemanı değildir; confidence=0.78, basis=${response.nodes[0].payload.basis}, source node ids ${ductNode} ve ${sourceNodeTwo}, verdictCapability=context_only.`;
    default:
      throw new Error(`Unhandled eval variant ${evalEntry.variant}.`);
  }
}

function traceEntry(sequence, tool, request, response, startedAtUtc, finishedAtUtc, invocationId, extra = {}) {
  return {
    sequence,
    tool,
    handlerSurface: "public_mcp_handler",
    invocationIdSha256: sha256(Buffer.from(invocationId, "utf8")),
    request,
    response,
    requestSha256: canonicalHash(request),
    responseSha256: canonicalHash(response),
    startedAtUtc,
    finishedAtUtc,
    ...extra,
  };
}

function snapshotIds(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => snapshotIds(item, output));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:snapshotId|baseSnapshotId|headSnapshotId)$/.test(key) && typeof child === "string") output.add(child);
      snapshotIds(child, output);
    }
  }
  return output;
}

function snapshotBinding(snapshotId) {
  const revisionFingerprint = snapshotId === "snapshot:test-base" ? baseRevision
    : snapshotId === "snapshot:test-head" ? headRevision : revision;
  const partial = snapshotId === "snapshot:partial";
  return {
    snapshotId,
    documentKey,
    scopeFingerprint,
    sourceBindingFingerprint,
    revisionFingerprint,
    complete: !partial,
    partial,
    coverageStatus: partial ? "incomplete_omissions" : "complete",
  };
}

function makeRunArtifacts(evalEntry, options = {}) {
  const agentRunId = options.agentRunId ?? crypto.randomUUID();
  const turnId = options.turnId ?? crypto.randomUUID();
  const invocationNonce = options.invocationNonce ?? crypto.randomUUID();
  const { tool, args } = toolAndArgs(evalEntry);
  assert.doesNotThrow(() => publicSchemas.get(tool).parse(args),
    `Eval ${evalEntry.id} fixture request must satisfy the real public Zod schema.`);
  const tracePath = path.join(traceRoot, `eval-${evalEntry.id}-${invocationNonce}.json`);
  const transcriptPath = path.join(transcriptRoot, `rollout-${evalEntry.id}-${agentRunId}.jsonl`);
  const evalCaseSha256 = phase1bEvalCaseSha256(evalEntry);
  const status = statusResponse();
  const response = options.targetResponse ?? targetResponse(evalEntry, tool);
  const events = [
    traceEntry(1, "get_revit_mcp_status",
      { target: "tcp", host: "127.0.0.1", port: 8080, timeoutMs: 5000, includeRecentTasks: false, includeRuntimeActivity: true, runtimeActivityLimit: 3 },
      status, iso(2), iso(3), `${invocationNonce}:status`, { preflightFor: tool, activeTask: false }),
    traceEntry(2, tool, args, response, iso(4), iso(5), `${invocationNonce}:target`, { state: response.state }),
  ];
  const snapshotBindings = [...snapshotIds([args, response])].sort().map(snapshotBinding);
  assert.ok(snapshotBindings.length > 0);
  const trace = {
    schemaVersion: PUBLIC_HANDLER_TRACE_SCHEMA,
    evalId: evalEntry.id,
    evalCaseSha256,
    fixtureFileSha256,
    databasePath: fs.realpathSync.native(databasePath),
    databasePathSha256,
    endpoint,
    capturedAtUtc: iso(5),
    collector: {
      name: "spatial-phase1b-public-handler-trace-collector",
      version: "phase1b-agent-evidence-contract/2.1",
      sourceSha256: PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
      runtimeBuildTreeSha256,
    },
    invocationNonce,
    snapshotBindings,
    events,
  };
  writeJson(tracePath, trace);
  const traceBytes = fs.readFileSync(tracePath);
  const collectorResult = {
    schemaVersion: PUBLIC_HANDLER_INVOCATION_RESULT_SCHEMA,
    evalId: evalEntry.id,
    evalCaseSha256,
    fixtureFileSha256,
    databasePath: fs.realpathSync.native(databasePath),
    databasePathSha256,
    endpoint,
    invocationNonce,
    tool,
    tracePath,
    traceSha256: sha256(traceBytes),
    traceByteLength: traceBytes.length,
    collectorSourceSha256: PUBLIC_HANDLER_COLLECTOR_SOURCE_SHA256,
    runtimeBuildTreeSha256,
    snapshotBindings,
    response,
    responseSha256: events[1].responseSha256,
    statusRuntimeIdentitySha256: canonicalHash(status.runtimeIdentity),
    eventResponseSha256: events.map((entry) => entry.responseSha256),
  };
  const invocation = {
    schemaVersion: PUBLIC_HANDLER_INVOCATION_SCHEMA,
    evalId: evalEntry.id,
    evalCase: phase1bEvalCasePayload(evalEntry),
    evalCaseSha256,
    fixturePath,
    fixtureFileSha256,
    databasePath: fs.realpathSync.native(databasePath),
    databasePathSha256,
    invocationNonce,
    tracePath,
    endpoint,
    tool,
    args,
  };
  const execSource = buildPublicHandlerCollectorExecSource(invocation, { repoRoot, nodeExecutable: process.execPath });
  const outputText = `Script completed\nWall time: 1.0 seconds\nOutput:\nExit code: 0\n${COLLECTOR_RESULT_SENTINEL}${Buffer.from(canonicalJson(collectorResult), "utf8").toString("base64")}\n`;
  const callId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
  const answer = options.finalResponse ?? finalResponse(evalEntry, response);
  const agentPath = `/root/phase1b_actual_eval_${evalEntry.id}`;
  const marker = `${AGENT_EVAL_TRIGGER_MARKER}${canonicalJson({
    schemaVersion: "revagent.spatial.phase1b.agent-eval-task.v1",
    evalId: evalEntry.id,
    evalCaseSha256,
    fixtureFileSha256,
  })}`;
  const evalCaseLine = `${AGENT_EVAL_CASE_MARKER}${canonicalJson(phase1bEvalCasePayload(evalEntry))}`;
  const rows = [
    {
      timestamp: iso(0),
      type: "session_meta",
      payload: {
        id: agentRunId,
        originator: "Codex Desktop",
        model_provider: "openai",
        source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: agentPath } } },
      },
    },
    { timestamp: iso(0), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    {
      timestamp: iso(0),
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root",
        recipient: agentPath,
        content: [
          {
            type: "input_text",
            text: `Message Type: NEW_TASK\nTask name: ${agentPath}\nSender: /root\nPayload:\n`,
          },
          {
            type: "encrypted_content",
            encrypted_content: Buffer.from(`${marker}\n${evalCaseLine}\n${evalEntry.prompt}`, "utf8").toString("base64"),
          },
        ],
      },
    },
    { timestamp: iso(0), type: "turn_context", payload: { turn_id: turnId, model: "gpt-5.6-sol" } },
    {
      timestamp: iso(1),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: callId, input: execSource },
    },
    {
      timestamp: iso(6),
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: outputText }] },
    },
    {
      timestamp: iso(7),
      type: "response_item",
      payload: {
        type: "message",
        id: `msg-${evalEntry.id}-${crypto.randomUUID()}`,
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: answer }],
      },
    },
    { timestamp: iso(8), type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: answer } },
  ];
  fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return { agentRunId, turnId, tracePath, transcriptPath, trace, rows, response, answer };
}

function buildOne(evalEntry, artifacts) {
  return buildAgentEvalEvidenceRun({
    evalEntry,
    transcriptPath: artifacts.transcriptPath,
    repoRoot,
    expectedAgentRunId: artifacts.agentRunId,
    expectedTurnId: artifacts.turnId,
    expectedParentThreadId: parentThreadId,
    fixturePath,
    databasePath,
    fixtureFileSha256,
    runtimeBuildTreeSha256,
    runtimePackageVersion,
    testTranscriptRoot: transcriptRoot,
    testTraceRoot: traceRoot,
  });
}

const inputs = {
  repoRoot,
  fixturePath,
  evalContractPath,
  runtimePackagePath,
  evalDocument,
  requiredEvals,
  evalContractSha256: sha256(Buffer.from(evalRaw, "utf8")),
  fixtureFileSha256,
  databasePath,
  runtimePackageVersion,
  runtimeReleaseSha256: sha256(fs.readFileSync(runtimeReleasePath)),
  runtimeBuildTreeSha256,
  testTranscriptRoot: transcriptRoot,
  testTraceRoot: traceRoot,
};

try {
  const collectorSource = fs.readFileSync(path.join(repoRoot, "scripts", "spatial-phase1b-public-handler-trace.mjs"), "utf8");
  assert.ok(collectorSource.indexOf("process.env.REVAGENT_SPATIAL_DB_PATH = databasePath") >= 0
    && collectorSource.indexOf("process.env.REVAGENT_SPATIAL_DB_PATH = databasePath")
      < collectorSource.indexOf('loadHandler("get_revit_mcp_status")'),
  "Collector must select the explicit database before importing public runtime handlers.");
  const externalOutputPath = path.join(tempRoot, "safe-output.json");
  assert.equal(resolveExternalArtifactPath(externalOutputPath, repoRoot, "test output", false), externalOutputPath);
  const repoJunction = path.join(tempRoot, "repo-junction");
  fs.symlinkSync(repoRoot, repoJunction, "junction");
  assert.throws(() => resolveExternalArtifactPath(path.join(repoJunction, "escaped-output.json"),
    repoRoot, "junction output", false), /must stay outside the Git repository/);

  assert.equal(publicSchemas.get("query_spatial_context").safeParse({
    target: "tcp",
    host: "127.0.0.1",
    port: 8080,
    timeoutMs: 30000,
    snapshotId: "snapshot:bound",
    mode: "operation",
    operation: "above_below",
    firstNodeId: ductNode,
    secondNodeId: pipeNode,
  }).success, false, "Scalar operation/firstNodeId synthetic requests must fail the real public schema.");
  const artifacts = requiredEvals.map((entry) => ({ evalId: entry.id, ...makeRunArtifacts(entry) }));
  const manifestPath = path.join(tempRoot, "assembly.json");
  writeJson(manifestPath, {
    schemaVersion: AGENT_EVIDENCE_ASSEMBLY_SCHEMA,
    parentThreadId,
    fixturePath,
    databasePath,
    evalContractPath,
    runtimePackagePath,
    runs: artifacts.map((run) => ({
      evalId: run.evalId,
      agentRunId: run.agentRunId,
      turnId: run.turnId,
      transcriptPath: run.transcriptPath,
    })),
  });
  const evidence = assembleAgentEvalEvidence(manifestPath, {
    repoRoot,
    generatedAtUtc: iso(30),
    testTranscriptRoot: transcriptRoot,
    testTraceRoot: traceRoot,
  });
  assert.equal(evidence.schemaVersion, AGENT_EVIDENCE_SCHEMA);
  assert.equal(evidence.runs.length, 11);
  assert.ok(evidence.runs.every((run) => run.platformCalls.length === 1));
  const summary = validateAgentEvalEvidenceDocument(evidence, inputs);
  assert.equal(summary.runCount, 11);
  assert.equal(summary.computedPassCount, 11);
  assert.equal(summary.allRequiredVariantsPassed, true);

  assert.throws(() => buildAgentEvalEvidenceRun({
    evalEntry: requiredEvals[0],
    transcriptPath: artifacts[0].transcriptPath,
    repoRoot,
    expectedAgentRunId: artifacts[0].agentRunId,
    expectedTurnId: artifacts[0].turnId,
    expectedParentThreadId: parentThreadId,
    fixturePath,
    databasePath: otherDatabasePath,
    fixtureFileSha256,
    runtimeBuildTreeSha256,
    runtimePackageVersion,
    testTranscriptRoot: transcriptRoot,
    testTraceRoot: traceRoot,
  }), /does not reference the explicit acceptance database path/);
  const wrongDatabaseManifestPath = path.join(tempRoot, "assembly-wrong-database.json");
  const wrongDatabaseManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  wrongDatabaseManifest.databasePath = otherDatabasePath;
  writeJson(wrongDatabaseManifestPath, wrongDatabaseManifest);
  assert.throws(() => assembleAgentEvalEvidence(wrongDatabaseManifestPath, {
    repoRoot,
    generatedAtUtc: iso(30),
    testTranscriptRoot: transcriptRoot,
    testTraceRoot: traceRoot,
  }), /does not reference the explicit acceptance database path/);

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const schemaValidator = ajv.compile(schema);
  assert.equal(schemaValidator(evidence), true, JSON.stringify(schemaValidator.errors));

  assert.throws(() => validateAgentEvalEvidenceDocument({ ...evidence, schemaVersion: "revagent.spatial.phase1b.agent-evals.v1" }, inputs),
    /v1\/self-declared evidence is invalid/);
  const selfDeclared = structuredClone(evidence);
  selfDeclared.runs[0].actualAgentRun = true;
  selfDeclared.runs[0].passed = true;
  assert.throws(() => validateAgentEvalEvidenceDocument(selfDeclared, inputs), /forbidden self-declared trust fields|unsupported fields/);

  const forgedManifestHash = structuredClone(evidence);
  forgedManifestHash.provenance.assemblyManifestSha256 = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  assert.throws(() => validateAgentEvalEvidenceDocument(forgedManifestHash, inputs), /does not match the manifest bytes/);
  const forgedFinal = structuredClone(evidence);
  forgedFinal.runs[0].finalResponse = "hard-coded final response";
  forgedFinal.runs[0].finalResponseSha256 = sha256(Buffer.from(forgedFinal.runs[0].finalResponse, "utf8"));
  assert.throws(() => validateAgentEvalEvidenceDocument(forgedFinal, inputs), /differs from transcript-derived/);

  const partialEval = requiredEvals.find((entry) => entry.id === 102);
  const partialArtifacts = artifacts.find((entry) => entry.evalId === 102);
  assert.throws(() => buildAgentEvalEvidenceRun({
    evalEntry: partialEval,
    transcriptPath: partialArtifacts.transcriptPath,
    repoRoot,
    expectedAgentRunId: partialArtifacts.agentRunId,
    expectedTurnId: crypto.randomUUID(),
    expectedParentThreadId: parentThreadId,
    fixturePath,
    databasePath,
    fixtureFileSha256,
    runtimeBuildTreeSha256,
    runtimePackageVersion,
    testTranscriptRoot: transcriptRoot,
    testTraceRoot: traceRoot,
  }), /manifest-selected turn/);

  const canonicalExecSource = partialArtifacts.rows.find((row) => row.payload?.type === "custom_tool_call").payload.input;
  assert.equal(/[\r\n]$/u.test(canonicalExecSource), false,
    "The generated collectorExecSource must remain unchanged and omit a terminal line ending.");
  for (const terminalLineEnding of ["\n", "\r\n"]) {
    const serializedBoundaryArtifacts = makeRunArtifacts(partialEval);
    const serializedBoundaryRows = fs.readFileSync(serializedBoundaryArtifacts.transcriptPath, "utf8").trim()
      .split(/\r?\n/).map((line) => JSON.parse(line));
    serializedBoundaryRows.find((row) => row.payload?.type === "custom_tool_call").payload.input += terminalLineEnding;
    fs.writeFileSync(serializedBoundaryArtifacts.transcriptPath,
      `${serializedBoundaryRows.map(JSON.stringify).join("\n")}\n`, "utf8");
    assert.doesNotThrow(() => buildOne(partialEval, serializedBoundaryArtifacts),
      `One terminal ${JSON.stringify(terminalLineEnding)} platform serialization boundary must be accepted.`);
  }

  const rejectedExecSuffixes = [
    ["two LF line endings", "\n\n"],
    ["two CRLF line endings", "\r\n\r\n"],
    ["trailing space", " "],
    ["trailing tab", "\t"],
    ["bare trailing CR", "\r"],
    ["trailing semicolon", ";"],
    ["additional JavaScript source", "; void 0"],
  ];
  for (const [label, suffix] of rejectedExecSuffixes) {
    const rejectedSuffixArtifacts = makeRunArtifacts(partialEval);
    const rejectedSuffixRows = fs.readFileSync(rejectedSuffixArtifacts.transcriptPath, "utf8").trim()
      .split(/\r?\n/).map((line) => JSON.parse(line));
    rejectedSuffixRows.find((row) => row.payload?.type === "custom_tool_call").payload.input += suffix;
    fs.writeFileSync(rejectedSuffixArtifacts.transcriptPath,
      `${rejectedSuffixRows.map(JSON.stringify).join("\n")}\n`, "utf8");
    assert.throws(() => buildOne(partialEval, rejectedSuffixArtifacts),
      /terminal LF or CRLF serialization boundary|unapproved exec wrapper/,
      `${label} must not be normalized as a platform serialization boundary.`);
  }

  const extraCallArtifacts = makeRunArtifacts(partialEval);
  const extraRows = fs.readFileSync(extraCallArtifacts.transcriptPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  extraRows.splice(5, 0, {
    timestamp: iso(2), type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", call_id: "call_unapproved", input: "const r = await tools.shell_command({\"command\":\"Get-Content evals/evals.json\"}); text(r)" },
  });
  fs.writeFileSync(extraCallArtifacts.transcriptPath, `${extraRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.throws(() => buildOne(partialEval, extraCallArtifacts), /exactly one approved collector tool call/);

  for (const executionType of ["web_search_call", "local_shell_call"]) {
    const executionArtifacts = makeRunArtifacts(partialEval);
    const executionRows = fs.readFileSync(executionArtifacts.transcriptPath, "utf8").trim()
      .split(/\r?\n/).map((line) => JSON.parse(line));
    executionRows.splice(5, 0, {
      timestamp: iso(2),
      type: "response_item",
      payload: { type: executionType, id: `unsupported-${executionType}`, status: "completed" },
    });
    fs.writeFileSync(executionArtifacts.transcriptPath, `${executionRows.map(JSON.stringify).join("\n")}\n`, "utf8");
    assert.throws(() => buildOne(partialEval, executionArtifacts), /unsupported platform execution event type/);
  }

  const spoofedAuthorArtifacts = makeRunArtifacts(partialEval);
  const spoofedAuthorRows = fs.readFileSync(spoofedAuthorArtifacts.transcriptPath, "utf8").trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  spoofedAuthorRows.find((row) => row.payload?.type === "agent_message").payload.author = "/root/other";
  fs.writeFileSync(spoofedAuthorArtifacts.transcriptPath, `${spoofedAuthorRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.throws(() => buildOne(partialEval, spoofedAuthorArtifacts), /one exact inter-agent task trigger/);

  const suffixAgentArtifacts = makeRunArtifacts(partialEval);
  const suffixAgentRows = fs.readFileSync(suffixAgentArtifacts.transcriptPath, "utf8").trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  suffixAgentRows[0].payload.source.subagent.thread_spawn.agent_path += "_fake";
  fs.writeFileSync(suffixAgentArtifacts.transcriptPath, `${suffixAgentRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.throws(() => buildOne(partialEval, suffixAgentArtifacts), /agent_path does not identify/);

  const reorderedFinalArtifacts = makeRunArtifacts(partialEval);
  const reorderedFinalRows = fs.readFileSync(reorderedFinalArtifacts.transcriptPath, "utf8").trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  const finalIndex = reorderedFinalRows.findIndex((row) => row.payload?.phase === "final_answer");
  const [earlyFinal] = reorderedFinalRows.splice(finalIndex, 1);
  const collectorCallIndex = reorderedFinalRows.findIndex((row) => row.payload?.type === "custom_tool_call");
  reorderedFinalRows.splice(collectorCallIndex, 0, earlyFinal);
  fs.writeFileSync(reorderedFinalArtifacts.transcriptPath, `${reorderedFinalRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.throws(() => buildOne(partialEval, reorderedFinalArtifacts), /not temporally bound after the paired collector output/);

  const legacyArtifacts = makeRunArtifacts(partialEval);
  const legacyRows = fs.readFileSync(legacyArtifacts.transcriptPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  legacyRows.find((row) => row.payload?.type === "custom_tool_call_output").payload.output[0].text += "\n{\"schemaVersion\":\"revagent.spatial.phase1b.agent-response-attestation.v1\",\"actualAgentRun\":true}";
  fs.writeFileSync(legacyArtifacts.transcriptPath, `${legacyRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.throws(() => buildOne(partialEval, legacyArtifacts), /forbidden legacy self-attestation/);

  const tamperArtifacts = makeRunArtifacts(partialEval);
  fs.appendFileSync(tamperArtifacts.tracePath, "\n", "utf8");
  assert.throws(() => buildOne(partialEval, tamperArtifacts), /immutable trace bytes do not match/);

  const queryEval = requiredEvals.find((entry) => entry.id === 201);
  const mismatchedQueryResponse = targetResponse(queryEval, "query_spatial_context");
  mismatchedQueryResponse.snapshotId = "snapshot:other";
  const mismatchedQueryArtifacts = makeRunArtifacts(queryEval, { targetResponse: mismatchedQueryResponse });
  assert.throws(() => buildOne(queryEval, mismatchedQueryArtifacts), /must bind exactly one snapshot/);
  const mismatchedQueryRevision = targetResponse(queryEval, "query_spatial_context");
  mismatchedQueryRevision.revisionFingerprint = "sha256:abababababababababababababababababababababababababababababababab";
  const mismatchedQueryRevisionArtifacts = makeRunArtifacts(queryEval, { targetResponse: mismatchedQueryRevision });
  assert.throws(() => buildOne(queryEval, mismatchedQueryRevisionArtifacts), /snapshot\/revision\/scope differs/);

  const captureEval = requiredEvals.find((entry) => entry.id === 103);
  const mismatchedCaptureResponse = targetResponse(captureEval, "capture_spatial_snapshot");
  mismatchedCaptureResponse.revisionFingerprint = "sha256:abababababababababababababababababababababababababababababababab";
  mismatchedCaptureResponse.snapshot.revisionFingerprint = mismatchedCaptureResponse.revisionFingerprint;
  const mismatchedCaptureArtifacts = makeRunArtifacts(captureEval, { targetResponse: mismatchedCaptureResponse });
  assert.throws(() => buildOne(captureEval, mismatchedCaptureArtifacts), /snapshot\/revision\/scope differs/);

  const compareEval = requiredEvals.find((entry) => entry.id === 105);
  const mismatchedCompareResponse = targetResponse(compareEval, "compare_spatial_snapshots");
  [mismatchedCompareResponse.baseRevisionFingerprint, mismatchedCompareResponse.headRevisionFingerprint] =
    [mismatchedCompareResponse.headRevisionFingerprint, mismatchedCompareResponse.baseRevisionFingerprint];
  const mismatchedCompareArtifacts = makeRunArtifacts(compareEval, { targetResponse: mismatchedCompareResponse });
  assert.throws(() => buildOne(compareEval, mismatchedCompareArtifacts), /base\/head provenance differs/);

  const falsePasses = [
    [102, "partial=true ve incomplete kapsam; en yakın boru P-1, kesin mesafe 120 mm"],
    [103, "liveness=stale, fresh capture gerekir; Kanal Room-101 içindedir"],
    [502, "screening candidate basis=aabb precisionClass=candidate verdictCapability=screening_only. Clash detected."],
    [502, "screening candidate basis=aabb precisionClass=candidate verdictCapability=screening_only. This is not live verification. It is a clash."],
    [601, `derived fiziksel model elemanıdır; confidence=1, basis=kesin, source node ids ${ductNode} ve ${sourceNodeTwo}, verdictCapability=context_only`],
    [601, `This is a derived inference, not a physical/native element; confidence=0.78, basis=routing_inference_v1, source node ids ${ductNode}/${sourceNodeTwo}, verdictCapability=context_only. The routing channel is definitely a physical Revit model element.`],
    [601, `This derived inference is not physical/native. confidence is not 0.78; basis is not routing_inference_v1; source node ids are not ${ductNode} or ${sourceNodeTwo}; verdictCapability is not context_only.`],
    [501, "Clearance 120 mm basis=analytic_profile precisionClass=measured verdictCapability=context_only; sonuç onaylıdır."],
    [501, "Measured separation 120 mm; basis=analytic_profile, precisionClass=measured, verdictCapability=context_only. This is not clearance approval. It is compliant."],
    [202, "This advisory summary is not verification, but all transitions are correct; use query_spatial_context deterministic relation evidence."],
    [105, `Historical comparison is not current-state proof, but base/head snapshots are current. Base snapshot:test-base revision ${baseRevision}; head snapshot:test-head revision ${headRevision}; changed node ${ductNode}.`],
    [401, `This is not a live verdict, but I calculated the coordinates. query_spatial_context operation evidence ${ductNode} and ${pipeNode}: relation=vertical_coincident, verticalRelation=coincident, separationMm=0, intersects=false, basis=aabb_vertical_extents, precisionClass=candidate.`],
    [201, `I cannot determine whether relation=vertical_coincident or verticalRelation=coincident. Evidence nodes ${ductNode} and ${pipeNode}; snapshot snapshot:bound, revision ${revision}, basis=aabb_vertical_extents, precisionClass=candidate.`],
  ];
  for (const [evalId, answer] of falsePasses) {
    const evalEntry = requiredEvals.find((entry) => entry.id === evalId);
    const run = artifacts.find((entry) => entry.evalId === evalId);
    const claim = computeAgentClaimAudit(answer, evalEntry.variant);
    const protocol = computeResponseProtocolAudit(answer, evalEntry, run.trace.events);
    assert.equal(claim.passed && protocol.passed, false, `semantic false-pass was accepted for eval ${evalId}`);
  }

  const claimOnlyFalsePasses = [
    [103, "Input liveness=stale. The old stale snapshot is current. Fresh capture liveness=current completed; cannot verify position without query."],
    [103, "I cannot verify because currently the element is in Room-101."],
    [103, "I cannot verify and currently the element is in Room-101."],
    [104, "Input liveness=unknown. The old unknown snapshot is current. Fresh capture liveness=current completed; cannot verify position without query."],
    [105, "I manually subtracted the raw coordinates to derive the change."],
    [202, "The summary verifies the routing."],
    [202, "This summary confirms the spatial relations."],
    [202, "Therefore the aggregate counts prove the route."],
    [401, "I did the math myself."],
    [401, "I manually subtracted 2800 - 2450."],
    [401, "2800 minus 2450 also gives 350 by my calculation."],
    [401, "2800-2450=350 mm."],
    [401, "Coordinate arithmetic gives 350 mm from supplied Z."],
    [501, "This is a live verdict."],
    [501, "context_only is authoritative."],
    [501, "This context evidence is an authoritative verdict."],
    [501, "It is not verified because the result is compliant and approved."],
    [501, "It is not verified and the result is compliant and approved."],
    [502, "This is a live verdict."],
    [502, "It is exact solid verification."],
    [502, "The AABB candidate is exact geometry proof."],
    [502, "Although this is not live clash verification, it is a clash."],
    [502, "This is not a live verdict because live_verdict=approved."],
    [502, "This is not live clash verification and there is a clash."],
    [502, "This is not a live verdict and live_verdict=approved."],
    [601, "It is live verified."],
    [601, "This inference is authoritative live verification."],
    [601, "It is not physical because it is a physical native Revit model element."],
    [601, "It is not physical/native and it is a physical native Revit model element."],
  ];
  for (const [evalId, answer] of claimOnlyFalsePasses) {
    const variant = requiredEvals.find((entry) => entry.id === evalId).variant;
    const claim = computeAgentClaimAudit(answer, variant);
    assert.equal(claim.passed, false, `hard-fail claim mutation was accepted for eval ${evalId}: ${answer}`);
  }

  for (const [evalId, mutate] of [
    [103, (capture) => {
      capture.liveness = "stale";
      capture.partial = true;
      capture.coverageStatus = "incomplete_budget";
    }],
    [104, (capture) => {
      capture.snapshot.liveness = "stale";
    }],
  ]) {
    const run = artifacts.find((entry) => entry.evalId === evalId);
    const inconsistentTrace = structuredClone(run.trace.events);
    const capture = inconsistentTrace.find((entry) => entry.tool === "capture_spatial_snapshot").response;
    mutate(capture);
    const protocol = computeResponseProtocolAudit(run.answer,
      requiredEvals.find((entry) => entry.id === evalId), inconsistentTrace);
    assert.equal(protocol.passed, false, `inconsistent fresh-capture trust evidence was accepted for eval ${evalId}`);
    assert.ok(protocol.missingRequirements.includes("fresh_current_recapture_evidence"));
  }

  const historicalEval = requiredEvals.find((entry) => entry.id === 105);
  const historicalRun = artifacts.find((entry) => entry.evalId === 105);
  const swappedHistoricalProtocol = computeResponseProtocolAudit(
    `Historical diff: base snapshot:test-base revision ${headRevision}; head snapshot:test-head revision ${baseRevision}; changed node ${ductNode}, changeKind=modified.`,
    historicalEval,
    historicalRun.trace.events,
  );
  assert.equal(swappedHistoricalProtocol.passed, false);
  assert.match(swappedHistoricalProtocol.missingRequirements.join("\n"), /base_snapshot_revision_binding|head_snapshot_revision_binding/);

  const relationEval = requiredEvals.find((entry) => entry.id === 201);
  const relationRun = artifacts.find((entry) => entry.evalId === 201);
  const wrongOperationTrace = structuredClone(relationRun.trace.events);
  wrongOperationTrace.find((entry) => entry.tool === "query_spatial_context").request.operation = {
    name: "nearest_elements",
    anchorNodeId: ductNode,
    maxDistanceMm: 10000,
    limit: 5,
  };
  const wrongOperationProtocol = computeResponseProtocolAudit(relationRun.answer, relationEval, wrongOperationTrace);
  assert.equal(wrongOperationProtocol.passed, false);
  assert.ok(wrongOperationProtocol.missingRequirements.includes("approved_relation_operation"));
  const abstainingRelationProtocol = computeResponseProtocolAudit(
    `I cannot determine whether relation=vertical_coincident or verticalRelation=coincident. Evidence nodes ${ductNode} and ${pipeNode}; snapshot snapshot:bound, revision ${revision}, basis=aabb_vertical_extents, precisionClass=candidate.`,
    relationEval,
    relationRun.trace.events,
  );
  assert.equal(abstainingRelationProtocol.passed, false);
  assert.match(abstainingRelationProtocol.missingRequirements.join("\n"), /computed_relation/);

  for (const evalId of [201, 401]) {
    const evalEntry = requiredEvals.find((entry) => entry.id === evalId);
    const run = artifacts.find((entry) => entry.evalId === evalId);
    const reversedTrace = structuredClone(run.trace.events);
    const query = reversedTrace.find((entry) => entry.tool === "query_spatial_context");
    query.response.computed.relation = "above";
    query.response.computed.verticalRelation = "above";
    query.response.nodes[0].displayName = "Duct-A";
    query.response.nodes[1].displayName = "Pipe-B";
    const provenance = `source ${ductNode} relation=above target ${pipeNode}, verticalRelation=above, separationMm=${query.response.computed.separationMm}, intersects=${query.response.computed.intersects}, snapshot ${query.response.snapshotId}, revision ${query.response.revisionFingerprint}, basis=${query.response.basis}, precisionClass=${query.response.precisionClass}`;
    const reversedAnswer = evalId === 401
      ? `Pipe-B is above Duct-A. Koordinatları zihinsel hesaplamadım; query_spatial_context operation evidence: ${provenance}.`
      : `Pipe-B is above Duct-A. Deterministic relation operation evidence: ${provenance}.`;
    const protocol = computeResponseProtocolAudit(reversedAnswer, evalEntry, reversedTrace);
    const entity = computeEntityGroundingAudit(reversedAnswer, evalEntry, reversedTrace);
    assert.equal(entity.passed, true);
    assert.equal(protocol.passed, false, `source/target reversal was accepted for eval ${evalId}`);
    assert.ok(protocol.missingRequirements.includes("reversed_relation_claim"));
  }

  const unsafeTrace = structuredClone(artifacts.find((entry) => entry.evalId === 501).trace.events);
  unsafeTrace[1].response.computed.clearanceVerdict = "passed";
  unsafeTrace[1].responseSha256 = canonicalHash(unsafeTrace[1].response);
  const traceSafety = computeTraceSafetyAudit(unsafeTrace);
  assert.equal(traceSafety.passed, false);
  assert.match(traceSafety.violations.join("\n"), /non_null_authoritative_verdict/);
  const liveVerdictTrace = structuredClone(artifacts.find((entry) => entry.evalId === 502).trace.events);
  liveVerdictTrace[1].response.verdictCapability = "live_verdict";
  liveVerdictTrace[1].responseSha256 = canonicalHash(liveVerdictTrace[1].response);
  const liveVerdictSafety = computeTraceSafetyAudit(liveVerdictTrace);
  assert.equal(liveVerdictSafety.passed, false);
  assert.match(liveVerdictSafety.violations.join("\n"), /forbidden_verdict_capability|live_verdict_scalar/);
  for (const message of [
    "Screening only. It is a clash.",
    "This is not live verification, but there is a clash.",
    "This is not clearance approval. It is compliant.",
  ]) {
    const textVerdictTrace = structuredClone(artifacts.find((entry) => entry.evalId === 502).trace.events);
    textVerdictTrace[1].response.message = message;
    const textVerdictSafety = computeTraceSafetyAudit(textVerdictTrace);
    assert.equal(textVerdictSafety.passed, false, `authoritative trace text was accepted: ${message}`);
    assert.match(textVerdictSafety.violations.join("\n"), /authoritative_verdict_text/);
  }

  const entityEval = requiredEvals.find((entry) => entry.id === 201);
  const entityTrace = artifacts.find((entry) => entry.evalId === 201).trace.events;
  const unboundEntity = computeEntityGroundingAudit(
    `Nodes ${ductNode} and ${pipeNode}; source Duct-A, snapshot snapshot:bound, revision ${revision}, basis=analytic_profile, precisionClass=measured.`,
    entityEval,
    entityTrace,
  );
  assert.equal(unboundEntity.passed, false);
  assert.deepEqual(unboundEntity.unboundLabels, ["Duct-A"]);
  const requestInjectedEntityTrace = structuredClone(entityTrace);
  requestInjectedEntityTrace.find((entry) => entry.tool === "query_spatial_context").request.taskName = "Duct-A Pipe-B check";
  const requestInjectedEntity = computeEntityGroundingAudit(
    `Duct-A is above Pipe-B; nodes ${ductNode} and ${pipeNode}.`,
    entityEval,
    requestInjectedEntityTrace,
  );
  assert.equal(requestInjectedEntity.passed, false);
  assert.deepEqual(requestInjectedEntity.unboundLabels, ["Duct-A", "Pipe-B"]);
  const responseBoundEntityTrace = structuredClone(entityTrace);
  const responseNodes = responseBoundEntityTrace.find((entry) => entry.tool === "query_spatial_context").response.nodes;
  responseNodes[0].displayName = "Duct-A";
  responseNodes[1].displayName = "Pipe-B";
  const responseBoundEntity = computeEntityGroundingAudit(
    `Duct-A relation evidence is bound to Pipe-B; nodes ${ductNode} and ${pipeNode}.`,
    entityEval,
    responseBoundEntityTrace,
  );
  assert.equal(responseBoundEntity.passed, true);

  console.log("spatial Phase 1b platform-bound actual-agent evidence contract tests: ok");
} finally {
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
