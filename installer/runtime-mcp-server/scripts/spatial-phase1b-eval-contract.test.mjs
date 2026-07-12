import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(runtimeRoot, "..", "..");
const fixtureRoot = path.join(__dirname, "fixtures", "spatial");

const read = (filePath) => fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
const readJson = (filePath) => JSON.parse(read(filePath));
const asText = (value) => JSON.stringify(value).toLowerCase();
const collectStrings = (value, output = []) => {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
};
const assertNonEmptyStrings = (value, label) => {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array.`);
  for (const item of value) {
    assert.equal(typeof item, "string", `${label} entries must be strings.`);
    assert.ok(item.trim().length > 0, `${label} entries must not be empty.`);
  }
};

const evalsPath = path.join(repoRoot, "evals", "evals.json");
const acceptancePath = path.join(repoRoot, "docs", "REVAGENT_SPATIAL_PHASE1B_ACCEPTANCE.md");
const planPath = path.join(repoRoot, "docs", "REVAGENT_SPATIAL_CONTEXT_ENGINE_PLAN.md");
const operationFixturePath = path.join(fixtureRoot, "phase1b-operation.golden.json");
const diffFixturePath = path.join(fixtureRoot, "phase1b-diff.golden.json");
const compatibilityFixturePath = path.join(fixtureRoot, "phase1b-compatibility.golden.json");
const exactRuntimeFixturePath = path.join(fixtureRoot, "phase1b-runtime-exact.golden.json");
const agentEvidenceSchemaPath = path.join(repoRoot, "evals", "schemas", "spatial-phase1b-agent-evidence-v2.schema.json");
const agentEvidenceContractPath = path.join(__dirname, "spatial-phase1b-agent-evidence-contract.mjs");
const agentEvidenceTestPath = path.join(__dirname, "spatial-phase1b-agent-evidence.test.mjs");
const agentEvidenceCliPath = path.join(repoRoot, "scripts", "spatial-phase1b-agent-evidence.mjs");
const agentEvidenceCollectorPath = path.join(repoRoot, "scripts", "spatial-phase1b-public-handler-trace.mjs");
const agentEvidenceRuntimeHashPath = path.join(__dirname, "spatial-phase1b-runtime-build-hash.mjs");
const liveHarnessPath = path.join(repoRoot, "scripts", "test-spatial-phase1b-live.mjs");
const liveHarnessWrapperPath = path.join(repoRoot, "scripts", "test-spatial-phase1b-live.ps1");

for (const filePath of [
  evalsPath,
  acceptancePath,
  planPath,
  operationFixturePath,
  diffFixturePath,
  compatibilityFixturePath,
  exactRuntimeFixturePath,
  agentEvidenceSchemaPath,
  agentEvidenceContractPath,
  agentEvidenceTestPath,
  agentEvidenceCliPath,
  agentEvidenceCollectorPath,
  agentEvidenceRuntimeHashPath,
  liveHarnessPath,
  liveHarnessWrapperPath,
]) {
  assert.ok(fs.existsSync(filePath), `Required Phase 1b acceptance artifact is missing: ${filePath}`);
}

const evalDocument = readJson(evalsPath);
assert.equal(evalDocument.skill_name, "revAgent");
assert.ok(Array.isArray(evalDocument.evals));
const ids = evalDocument.evals.map((entry) => String(entry.id));
assert.equal(new Set(ids).size, ids.length, "Every eval id must be globally unique.");

const spatialEvals = evalDocument.evals.filter((entry) => entry.suite === "spatial_grounding_phase1b");
assert.ok(spatialEvals.length >= 11, "Phase 1b must include all required Spatial Grounding Protocol variants.");

for (const entry of spatialEvals) {
  assert.ok([1, 2, 4, 5, 6].includes(entry.protocol_eval), `Unsupported protocol_eval on ${entry.id}.`);
  assert.equal(typeof entry.variant, "string");
  assert.ok(entry.variant.length > 0);
  assert.equal(typeof entry.prompt, "string");
  assert.ok(entry.prompt.length > 0);
  assert.ok(entry.context && typeof entry.context === "object" && !Array.isArray(entry.context));
  assert.equal(typeof entry.expected_output, "string");
  assert.ok(entry.expected_output.length > 0);
  assert.ok(Array.isArray(entry.files));
  assert.ok(Array.isArray(entry.required_tool_calls));
  assertNonEmptyStrings(entry.required_tool_calls, `eval ${entry.id} required_tool_calls`);
  assert.ok(Array.isArray(entry.forbidden_tool_calls));
  assertNonEmptyStrings(entry.forbidden_tool_calls, `eval ${entry.id} forbidden_tool_calls`);
  assert.ok(entry.forbidden_tool_calls.includes("send_code_to_revit"));
  assert.ok(entry.forbidden_tool_calls.includes("set_element_parameter"));
  assert.ok(entry.forbidden_tool_calls.includes("publish_nas_release"));
  assertNonEmptyStrings(entry.hard_fail_if, `eval ${entry.id} hard_fail_if`);
  assertNonEmptyStrings(entry.assertions, `eval ${entry.id} assertions`);
}

const byProtocol = (number) => spatialEvals.filter((entry) => entry.protocol_eval === number);
const variants = (number) => new Set(byProtocol(number).map((entry) => entry.variant));

for (const required of [
  "no_in_session_snapshot",
  "partial_snapshot",
  "stale_current_state",
  "unknown_liveness",
  "explicit_historical_diff",
]) {
  assert.ok(variants(1).has(required), `Protocol eval 1 is missing ${required}.`);
}
for (const required of ["cite_operation_evidence", "summary_is_not_verification"]) {
  assert.ok(variants(2).has(required), `Protocol eval 2 is missing ${required}.`);
}
assert.ok(variants(4).has("coordinates_do_not_authorize_llm_arithmetic"));
for (const required of ["context_only_clearance", "screening_only_intersection"]) {
  assert.ok(variants(5).has(required), `Protocol eval 5 is missing ${required}.`);
}
assert.ok(variants(6).has("derived_node_labeling"));

const evalByVariant = new Map(spatialEvals.map((entry) => [entry.variant, entry]));
assert.ok(evalByVariant.get("no_in_session_snapshot").required_tool_calls.includes("get_revit_mcp_status"));
assert.ok(evalByVariant.get("no_in_session_snapshot").required_tool_calls.includes("capture_spatial_snapshot"));
assert.ok(evalByVariant.get("partial_snapshot").required_tool_calls.includes("query_spatial_context"));
assert.ok(evalByVariant.get("stale_current_state").required_tool_calls.includes("capture_spatial_snapshot"));
assert.ok(evalByVariant.get("unknown_liveness").required_tool_calls.includes("capture_spatial_snapshot"));
assert.ok(evalByVariant.get("explicit_historical_diff").required_tool_calls.includes("compare_spatial_snapshots"));
assert.match(asText(evalByVariant.get("explicit_historical_diff")), /both snapshot|iki snapshot|snapshot id/);
assert.ok(evalByVariant.get("coordinates_do_not_authorize_llm_arithmetic").required_tool_calls.includes("query_spatial_context"));
assert.ok(evalByVariant.get("cite_operation_evidence").required_tool_calls.includes("query_spatial_context"));
assert.ok(evalByVariant.get("summary_is_not_verification").required_tool_calls.includes("summarize_spatial_state"));
assert.ok(evalByVariant.get("context_only_clearance").required_tool_calls.includes("query_spatial_context"));
assert.ok(evalByVariant.get("screening_only_intersection").required_tool_calls.includes("query_spatial_context"));
assert.ok(evalByVariant.get("derived_node_labeling").required_tool_calls.includes("query_spatial_context"));
assert.match(asText(evalByVariant.get("coordinates_do_not_authorize_llm_arithmetic")), /directly by the llm|zihinsel|coordinate arithmetic/);
assert.match(asText(evalByVariant.get("context_only_clearance")), /clearance verified/);
assert.match(asText(evalByVariant.get("screening_only_intersection")), /clash-free/);
for (const term of ["confidence", "basis", "source node id"]) {
  assert.match(asText(evalByVariant.get("derived_node_labeling")), new RegExp(term));
}

const operationFixture = readJson(operationFixturePath);
assert.equal(operationFixture.suite, "spatial_phase1b_operation_gold");
assert.equal(operationFixture.schemaVersion, "0.3");
assert.equal(operationFixture.snapshot.atomic, true);
assert.equal(operationFixture.snapshot.partial, false);
assert.equal(operationFixture.snapshot.coverageStatus, "complete");
assert.ok(Array.isArray(operationFixture.snapshot.nodes));
assert.ok(Array.isArray(operationFixture.snapshot.edges));
assert.ok(Array.isArray(operationFixture.cases));

const knownNodeIds = new Set(operationFixture.snapshot.nodes.map((node) => node.nodeId));
assert.equal(knownNodeIds.size, operationFixture.snapshot.nodes.length, "Operation fixture node ids must be unique.");
const connectorsById = new Map(operationFixture.snapshot.nodes
  .filter((node) => node.nodeKind === "connector")
  .map((node) => [node.nodeId, node]));
for (const connector of connectorsById.values()) {
  assert.ok(Array.isArray(connector.connectedConnectorNodeIds), `${connector.nodeId} must expose explicit adjacency.`);
  assert.equal(new Set(connector.connectedConnectorNodeIds).size, connector.connectedConnectorNodeIds.length,
    `${connector.nodeId} adjacency must be deduplicated.`);
  for (const targetId of connector.connectedConnectorNodeIds) {
    const target = connectorsById.get(targetId);
    assert.ok(target, `${connector.nodeId} cites unknown connector peer ${targetId}.`);
    assert.ok(target.connectedConnectorNodeIds.includes(connector.nodeId),
      `${connector.nodeId} -> ${targetId} adjacency must be reciprocal.`);
  }
}
const knownEdgeIds = new Set(operationFixture.snapshot.edges.map((edge) => edge.edgeId));
assert.equal(knownEdgeIds.size, operationFixture.snapshot.edges.length, "Operation fixture edge ids must be unique.");
for (const edge of operationFixture.snapshot.edges) {
  assert.ok(knownNodeIds.has(edge.sourceNodeId), `Edge ${edge.edgeId} has unknown source ${edge.sourceNodeId}.`);
  assert.ok(knownNodeIds.has(edge.targetNodeId), `Edge ${edge.edgeId} has unknown target ${edge.targetNodeId}.`);
}

const requiredOperationCases = new Set([
  "containment_inside_outer_loop",
  "containment_rejects_polygon_hole",
  "containment_rejects_vertical_outside",
  "containment_ignores_xy_crossing_outside_vertical_band",
  "containment_detects_vertical_boundary_overlap",
  "containment_detects_vertical_interior_overlap",
  "containment_boundary_is_inclusive",
  "direction_above_below",
  "direction_overlapping_ranges_is_indeterminate",
  "double_placed_link_identity",
  "nearest_tie_orders_by_node_id",
  "elements_within_includes_boundary",
  "topology_traces_native_adjacency",
  "topology_does_not_infer_coincident_connection",
  "topology_branch_is_deterministic",
  "topology_cycle_terminates_without_duplicates",
  "topology_ambiguity_fails_closed",
  "analytic_clearance_round_round",
  "rectangular_clearance_is_screening_only",
  "unsupported_geometry_fails_closed",
  "intended_connected_overlap_is_not_a_verdict",
]);
const operationCaseIds = new Set(operationFixture.cases.map((entry) => entry.caseId));
for (const caseId of requiredOperationCases) {
  assert.ok(operationCaseIds.has(caseId), `Operation gold fixture is missing ${caseId}.`);
}
assert.equal(operationCaseIds.size, operationFixture.cases.length, "Operation gold case ids must be unique.");

const requiredQueryFields = [
  "success",
  "guarded",
  "state",
  "action",
  "snapshotId",
  "revisionFingerprint",
  "liveness",
  "mode",
  "operation",
  "inputs",
  "nodes",
  "edges",
  "computed",
  "basis",
  "precisionClass",
  "verdictCapability",
  "partial",
  "truncated",
  "nextCursor",
  "warnings",
  "notices",
];
for (const testCase of operationFixture.cases) {
  const output = testCase.expectedNormalizedOutput;
  for (const referencedId of collectStrings([testCase.input, output])
    .filter((value) => /^(node:|connector:|derived:)/.test(value))) {
    assert.ok(knownNodeIds.has(referencedId), `${testCase.caseId} references unknown node ${referencedId}.`);
  }
  for (const field of requiredQueryFields) {
    assert.ok(Object.hasOwn(output, field), `${testCase.caseId} is missing QueryResult.${field}.`);
  }
  assert.equal(output.action, "query_spatial_context");
  assert.notEqual(output.verdictCapability, "live_verdict");
  assert.ok(["context_only", "screening_only"].includes(output.verdictCapability));
  for (const node of output.nodes) {
    assert.ok(knownNodeIds.has(node.nodeId), `${testCase.caseId} cites unknown node ${node.nodeId}.`);
  }
  for (const edge of output.edges) {
    assert.ok(knownEdgeIds.has(edge.edgeId), `${testCase.caseId} cites unknown edge ${edge.edgeId}.`);
  }
  if (output.computed && Object.hasOwn(output.computed, "clearanceVerdict")) {
    assert.equal(output.computed.clearanceVerdict, null, `${testCase.caseId} must not emit a clearance verdict.`);
  }
  if (output.computed && Object.hasOwn(output.computed, "clashVerdict")) {
    assert.equal(output.computed.clashVerdict, null, `${testCase.caseId} must not emit a clash verdict.`);
  }
}
for (const dimension of ["containment", "direction", "topology", "distance"]) {
  assert.ok(operationFixture.cases.some((entry) => entry.gateDimension === dimension), `Missing ${dimension} gold cases.`);
}

const coincidentNodes = operationFixture.snapshot.nodes.filter((node) =>
  node.nodeId.startsWith("connector:coincident-disconnected"));
assert.equal(coincidentNodes.length, 2);
assert.deepEqual(coincidentNodes[0].pointMm, coincidentNodes[1].pointMm);
assert.deepEqual(coincidentNodes[0].connectedConnectorNodeIds, []);
assert.deepEqual(coincidentNodes[1].connectedConnectorNodeIds, []);

const analyticCase = operationFixture.cases.find((entry) => entry.caseId === "analytic_clearance_round_round");
assert.equal(analyticCase.groundTruth.maximumAllowedAbsoluteErrorMm, 1);
assert.equal(analyticCase.expectedNormalizedOutput.computed.clearanceVerdict, null);
assert.equal(analyticCase.expectedNormalizedOutput.basis, "analytic_profile");
assert.equal(analyticCase.expectedNormalizedOutput.precisionClass, "measured");
const rectangularCase = operationFixture.cases.find((entry) => entry.caseId === "rectangular_clearance_is_screening_only");
assert.equal(rectangularCase.expectedNormalizedOutput.guarded, false);
assert.equal(rectangularCase.expectedNormalizedOutput.state, "completed");
assert.equal(rectangularCase.expectedNormalizedOutput.computed.analyticSupported, false);
assert.equal(rectangularCase.expectedNormalizedOutput.computed.clearanceVerdict, null);
assert.equal(rectangularCase.expectedNormalizedOutput.basis, "aabb");
assert.equal(rectangularCase.expectedNormalizedOutput.precisionClass, "candidate");
assert.equal(rectangularCase.expectedNormalizedOutput.verdictCapability, "screening_only");

const diffFixture = readJson(diffFixturePath);
assert.equal(diffFixture.suite, "spatial_phase1b_diff_gold");
assert.equal(diffFixture.schemaVersion, "0.3");
assert.ok(Array.isArray(diffFixture.scenarios));
const diffCaseIds = new Set(diffFixture.scenarios.map((entry) => entry.caseId));
assert.equal(diffCaseIds.size, diffFixture.scenarios.length, "Diff case ids must be unique.");
for (const required of [
  "link_reload_add_remove_unload",
  "link_transform_change_preserves_node_identity",
  "resized_but_unmoved_duct",
  "moved_same_shape",
  "system_property_change",
  "connector_topology_rewire",
  "journal_gap_allows_historical_diff_only",
  "partial_snapshot_is_not_diffable",
]) {
  assert.ok(diffCaseIds.has(required), `Diff gold fixture is missing ${required}.`);
}

const requiredDiffArrays = [
  "added",
  "removed",
  "sourceAvailabilityChanges",
  "transformChanges",
  "moved",
  "geometryChanges",
  "propertyChanges",
  "connectorChanges",
  "connectivityChanges",
  "proximityChanges",
];
for (const scenario of diffFixture.scenarios) {
  const output = scenario.expectedNormalizedOutput;
  assert.equal(output.action, "compare_spatial_snapshots");
  assert.equal(output.baseSnapshotId, scenario.base.snapshotId);
  assert.equal(output.headSnapshotId, scenario.head.snapshotId);
  for (const field of requiredDiffArrays) {
    assert.ok(Array.isArray(output[field]), `${scenario.caseId} must expose SnapshotDiff.${field}.`);
  }
}
const resizeOutput = diffFixture.scenarios.find((entry) => entry.caseId === "resized_but_unmoved_duct").expectedNormalizedOutput;
assert.equal(resizeOutput.moved.length, 0);
assert.equal(resizeOutput.geometryChanges.length, 1);
const moveOutput = diffFixture.scenarios.find((entry) => entry.caseId === "moved_same_shape").expectedNormalizedOutput;
assert.equal(moveOutput.moved.length, 1);
assert.equal(moveOutput.geometryChanges.length, 0);
const partialOutput = diffFixture.scenarios.find((entry) => entry.caseId === "partial_snapshot_is_not_diffable").expectedNormalizedOutput;
assert.equal(partialOutput.guarded, true);
assert.equal(partialOutput.reason, "partial_snapshot_not_diffable");

const compatibilityFixture = readJson(compatibilityFixturePath);
assert.equal(compatibilityFixture.suite, "spatial_phase1b_compatibility_gold");
assert.ok(Array.isArray(compatibilityFixture.adapters));
assert.ok(Array.isArray(compatibilityFixture.cases));
const compatibilityIds = new Set(compatibilityFixture.cases.map((entry) => entry.caseId));
for (const required of [
  "v0_1_identity_only_is_not_current_query_evidence",
  "v0_2_aabb_direction_adapter_is_explicit",
  "v0_2_topology_is_not_inferred_from_is_connected",
  "v0_2_v0_3_precise_diff_requires_capability_adapter",
  "coordinate_policy_mismatch_is_incomparable",
  "partial_v0_3_is_not_a_diff_base",
]) {
  assert.ok(compatibilityIds.has(required), `Compatibility gold fixture is missing ${required}.`);
}
for (const entry of compatibilityFixture.cases) {
  assert.equal(entry.expectedNormalizedOutput.success, true);
  if (/topology|capability|coordinate|partial|v0_1/.test(entry.caseId)) {
    assert.equal(entry.expectedNormalizedOutput.guarded, true, `${entry.caseId} must fail closed.`);
  }
}

const acceptance = read(acceptancePath);
const plan = read(planPath);
const agentEvidenceSchema = readJson(agentEvidenceSchemaPath);
assert.ok(agentEvidenceSchema.properties.provenance.required.includes("databasePath"));
assert.ok(agentEvidenceSchema.properties.provenance.required.includes("databasePathSha256"));
assert.ok(agentEvidenceSchema.$defs.run.required.includes("databasePathSha256"));
const collectorSource = read(agentEvidenceCollectorPath);
assert.match(collectorSource, /REVAGENT_SPATIAL_DB_PATH\s*=\s*databasePath/);
assert.ok(collectorSource.indexOf("REVAGENT_SPATIAL_DB_PATH = databasePath")
  < collectorSource.indexOf('loadHandler("get_revit_mcp_status")'));
const liveHarnessSource = read(liveHarnessPath);
assert.match(liveHarnessSource, /resolveExternalArtifactPath/);
assert.match(liveHarnessSource, /repoPluginSha256/);
assert.match(liveHarnessSource, /installedAddinLoadsVerifiedPlugin/);
assert.match(liveHarnessSource, /databasePathSha256/);
assert.doesNotMatch(liveHarnessSource,
  /config\.agentEvalEvidencePath,[\s\S]{0,80}config\.host,[\s\S]{0,80}\.\.\.config\.levelNames/,
  "Locked localhost/127.0.0.1 endpoint host must not be treated as sensitive artifact data.");
const liveHarnessWrapperSource = read(liveHarnessWrapperPath);
assert.match(liveHarnessWrapperSource, /Get-NativePathState/);
assert.match(liveHarnessWrapperSource, /fs\.realpathSync\.native/);
assert.match(liveHarnessWrapperSource, /Resolve-NativeRealPath/);
assert.match(liveHarnessWrapperSource, /dangling symlink or reparse-point path/i);
assert.match(acceptance, /^# revAgent Spatial Context Engine — Phase 1b Acceptance/m);
assert.match(acceptance, /Status: Gates A-E passed[\s\S]{0,160}Phase 1b is accepted/i);
for (const gate of ["A", "B", "C", "D", "E"]) {
  assert.match(acceptance, new RegExp(`^## Gate ${gate} —`, "m"), `Acceptance record is missing Gate ${gate}.`);
}
assert.match(acceptance, /zero wrong containment, direction, or\s+topology results/i);
assert.match(acceptance, /at most 1 mm/i);
assert.match(acceptance, /p95 at or below 750 ms/i);
assert.match(acceptance, /p95 at or below 3 seconds/i);
assert.match(acceptance, /Static JSON validation alone is not an agent-eval\s+pass/i);
assert.match(acceptance, /codex desktop jsonl/i);
assert.match(acceptance, /spatial-phase1b-agent-evidence\.mjs assemble/i);
assert.match(acceptance, /spatial-phase1b-agent-evidence\.mjs prepare/i);
assert.match(acceptance, /custom_tool_call.*custom_tool_call_output/is);
assert.match(acceptance, /call_id/i);
assert.match(acceptance, /REVAGENT_PHASE1B_EVAL_CASE:/i);
assert.match(acceptance, /agent-response-attestation\.v1/i);
assert.match(acceptance, /all affected evals must be rerun/i);
assert.match(acceptance, /provider.*model.*agent run id.*turn id/is);
assert.match(acceptance, /test-all\.ps1/);
assert.match(acceptance, /test-ci\.ps1/);
assert.match(acceptance, /Phase 1c[\s\S]{0,80}not authorized/i);
assert.equal([...acceptance.matchAll(/^Evidence status: passed[\s\S]*?(?=\n\n##|$)/gm)].length, 5,
  "Phase 1b Gates A-E must preserve reviewed passed evidence summaries.");
assert.equal([...acceptance.matchAll(/^Evidence status: pending\.$/gm)].length, 0,
  "Phase 1b must not retain a pending acceptance gate after protected delivery closes.");
assert.match(acceptance, /PR #219/);
assert.match(acceptance, /2026\.07\.12\.534-e0f8fc32/);
assert.match(acceptance, /post-publish HAFIZE Revit 2022 sample-model smoke passed/i);
assert.match(acceptance, /persistentTrust=false/);
assert.match(acceptance, /66498919D2D3F3E6A2D9DC502A645B41583DA9C9E46AF69733588567BD5DA14D/i);
assert.match(acceptance, /actionRequiredCount=0/);
assert.match(acceptance, /Phase 1b is accepted\./);
assert.match(plan, /Status: codex_execution; execution completed and accepted through Phase 1b\./);
assert.match(plan, /^\s*- \[x\] \*\*Phase 1b — Deterministic queries \+ diff\.\*\*/m);
assert.match(plan, /^\s*- \[ \] \*\*Phase 1c — Clash detection\.\*\* Not started\./m);
assert.doesNotMatch(plan, /^\s*- \[x\] \*\*Phase 1c\b/m);

console.log("spatial Phase 1b eval, fixture, and acceptance contract tests: ok");
