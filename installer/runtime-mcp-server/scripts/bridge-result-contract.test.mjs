import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_RESULT_CONTRACT_VERSION,
  hasCanonicalBridgeResultContract,
  normalizeRevitExecutionResponse,
  shouldRefreshLiveRevitStatusAfterCommand,
} from "../build/utils/revitToolHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(packageRoot, "..", "..");

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertContains(source, text, message) {
  assert.ok(source.includes(text), message);
}

function assertNotContains(source, text, message) {
  assert.ok(!source.includes(text), message);
}

const executeCodeEventHandler = readRepo("src/revit-plugin/revAgentCommandSet/Commands/ExecuteDynamicCode/ExecuteCodeEventHandler.cs");
assertNotContains(
  executeCodeEventHandler,
  "ResultInfo.Result = JsonConvert.SerializeObject(result)",
  "Dynamic execution must not double-encode snippet results.",
);
assertContains(
  executeCodeEventHandler,
  "public JToken Result",
  "Dynamic execution result payload must carry JSON tokens, not pre-serialized JSON strings.",
);
assertContains(
  executeCodeEventHandler,
  "CreateSafeResultToken(result)",
  "Dynamic execution must use a safe token conversion fallback for null, primitive, and unserializable results.",
);

const bridgeResultContract = readRepo("src/revit-plugin/revAgentPlugin/Core/BridgeResultContract.cs");
assertContains(
  bridgeResultContract,
  "public const int ResultContractVersion = 2",
  "Bridge result contract version must identify the normalized C# bridge payload floor.",
);
assertContains(
  bridgeResultContract,
  'obj["resultContractVersion"] = ResultContractVersion',
  "Bridge result payloads must be self-describing with resultContractVersion.",
);
assertContains(
  bridgeResultContract,
  "CamelCaseNamingStrategy",
  "Bridge result serialization must use a central camelCase naming strategy.",
);
assertContains(
  bridgeResultContract,
  "ProcessDictionaryKeys = false",
  "Bridge result serialization must not rewrite domain dictionary keys while normalizing DTO property names.",
);

for (const relativePath of [
  "src/revit-plugin/revAgentPlugin/Core/CommandExecutor.cs",
  "src/revit-plugin/revAgentPlugin/Core/SocketService.cs",
]) {
  const source = readRepo(relativePath);
  assertContains(
    source,
    "BridgeResultContract.CreateResultPayload(result)",
    `${relativePath} must use the central bridge result payload helper.`,
  );
  assertNotContains(
    source,
    "JToken.FromObject",
    `${relativePath} must not bypass the central bridge result contract helper.`,
  );
}

const socketService = readRepo("src/revit-plugin/revAgentPlugin/Core/SocketService.cs");
assertContains(
  socketService,
  "BridgeResultContract.ToCamelCaseToken(result)",
  "Socket guarded/failed detection must inspect the same camelCase token shape as response serialization.",
);
assertContains(
  socketService,
  'string.Equals(request.Method, "mcp_status"',
  "mcp_status must continue to expose diagnostic status for bridge contract discovery.",
);
assertContains(
  socketService,
  "return CreateSuccessResponse(request.Id, snapshot)",
  "mcp_status diagnostics must pass through the same resultContractVersion response helper.",
);
assertContains(
  socketService,
  'ExtractRequestParamText(request, "wrapperAction")',
  "Native status history must read wrapperAction from request params.",
);
assertContains(
  socketService,
  'ExtractRequestParamText(request, "logicalToolName", "toolName")',
  "Native status history must read logicalToolName/toolName from request params.",
);

const mcpTaskStatusService = readRepo("src/revit-plugin/revAgentPlugin/Core/McpTaskStatusService.cs");
for (const field of ['JsonProperty("wrapperAction"', 'JsonProperty("logicalToolName"', 'JsonProperty("parentTaskName"', 'JsonProperty("parentTaskId"']) {
  assertContains(
    mcpTaskStatusService,
    field,
    `Native recentTasks must serialize ${field} metadata for public tool identity.`,
  );
}

const viewCommandHelpers = readRepo("src/revit-plugin/revAgentCommandSet/Commands/View/ViewCommandHelpers.cs");
for (const field of ["public bool? DryRun", "public bool? Deleted", "public bool? ConfirmDelete", "public bool? TargetIsReviewView", "public int? DeletedElementCount"]) {
  assertContains(
    viewCommandHelpers,
    field,
    `ViewOperationResult cleanup field must be nullable: ${field}.`,
  );
}
assertContains(
  viewCommandHelpers,
  "NullValueHandling = NullValueHandling.Ignore",
  "ViewOperationResult cleanup-only fields must be omitted unless a cleanup operation sets them.",
);

const canonical = {
  resultContractVersion: BRIDGE_RESULT_CONTRACT_VERSION,
  success: true,
  result: "{\"Success\":false,\"value\":2}",
  nested: {
    success: false,
  },
};
assert.equal(hasCanonicalBridgeResultContract(canonical), true);
assert.deepEqual(
  normalizeRevitExecutionResponse(canonical),
  canonical,
  "Canonical bridge payloads must stay idempotent and must not parse user string results.",
);
const normalizedCanonicalDynamicResult = normalizeRevitExecutionResponse(canonical, { parseResultStrings: true });
assert.equal(normalizedCanonicalDynamicResult.success, true);
assert.deepEqual(
  normalizedCanonicalDynamicResult.result,
  { success: false, value: 2 },
  "Dynamic execution parseJsonResult=true must parse canonical nested result JSON strings.",
);

const nestedCanonical = {
  resultContractVersion: BRIDGE_RESULT_CONTRACT_VERSION,
  success: true,
  result: {
    result: JSON.stringify(JSON.stringify({ Success: true, nestedValue: 7 })),
  },
};
const normalizedNestedCanonical = normalizeRevitExecutionResponse(nestedCanonical, { parseResultStrings: true });
assert.deepEqual(
  normalizedNestedCanonical.result.result,
  { success: true, nestedValue: 7 },
  "Dynamic execution parsing must handle nested and double-encoded result strings.",
);

const malformedCanonical = {
  resultContractVersion: BRIDGE_RESULT_CONTRACT_VERSION,
  success: true,
  result: "{\"success\":",
};
assert.equal(
  normalizeRevitExecutionResponse(malformedCanonical, { parseResultStrings: true }).result,
  malformedCanonical.result,
  "Failed dynamic result parsing must preserve the raw string.",
);

const legacy = {
  Success: true,
  result: "{\"Success\":false,\"value\":2}",
};
const normalizedLegacy = normalizeRevitExecutionResponse(legacy);
assert.equal(normalizedLegacy.success, true);
assert.equal(normalizedLegacy.Success, undefined);
assert.deepEqual(
  normalizedLegacy.result,
  { success: false, value: 2 },
  "Legacy bridge payloads without resultContractVersion must keep the old parse/casing compatibility path.",
);

const legacyAfterCanonical = normalizeRevitExecutionResponse(legacy);
assert.deepEqual(
  legacyAfterCanonical,
  normalizedLegacy,
  "Normalizer behavior must be per response, not controlled by a process-global contract flag.",
);

assert.equal(
  shouldRefreshLiveRevitStatusAfterCommand({}),
  true,
  "Post-command live status refresh must remain enabled by default.",
);
assert.equal(
  shouldRefreshLiveRevitStatusAfterCommand({ refreshStatusAfterCommand: false }),
  false,
  "Latency-sensitive internal probes must be able to suppress only the post-command background refresh.",
);

const spatialContextHelper = readRepo("installer/runtime-mcp-server/src/tools/spatial_context_tool_helpers.ts");
assertContains(
  spatialContextHelper,
  "refreshStatusAfterCommand: false",
  "Current-state snapshot trust probes must not launch a concurrent post-command mcp_status refresh.",
);
assertContains(
  spatialContextHelper,
  'sendRevitCommand("get_spatial_change_state"',
  "The opt-out must remain bound to the native spatial change-state trust probe.",
);

console.log("bridge result contract tests passed");
