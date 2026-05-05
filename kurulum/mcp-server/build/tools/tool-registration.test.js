import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const registerSource = readFileSync(join(toolsDir, "register.js"), "utf8");

const expectedRegistrars = [
    "registerSendCodeToRevitTool",
    "registerSendCodeToRevitSafeTool",
    "registerGetRevitMcpStatusTool",
    "registerGetRevitSessionContextTool",
    "registerGetActiveViewContextTool",
    "registerInspectElementsTool",
    "registerInspectParameterSchemaTool",
    "registerAnalyzeMepSystemTool",
    "registerPrepareWritePlanTool",
    "registerPreviewWritePlanTool",
    "registerCommitWritePlanTool",
    "registerVerifyWritePlanTool",
    "registerGetWorkflowStateTool",
    "registerClearWorkflowStateTool",
];

const registrarCalls = [...registerSource.matchAll(/\b(register[A-Za-z0-9]+Tool)\(server\);/g)]
    .map((match) => match[1]);

assert.deepEqual(registrarCalls, expectedRegistrars);
assert(registerSource.includes('console.error("Registered 14 Revit MCP tools")'));

const expectedToolFiles = [
    "send_code_to_revit.js",
    "send_code_to_revit_safe.js",
    "get_revit_mcp_status.js",
    "get_revit_session_context.js",
    "get_active_view_context.js",
    "inspect_elements.js",
    "inspect_parameter_schema.js",
    "analyze_mep_system.js",
    "prepare_write_plan.js",
    "preview_write_plan.js",
    "commit_write_plan.js",
    "verify_write_plan.js",
    "get_workflow_state.js",
    "clear_workflow_state.js",
];

for (const file of expectedToolFiles) {
    const importPath = `./${file.replace(".js", "")}.js`;
    assert(registerSource.includes(importPath), `missing import for ${file}`);
}

const expectedToolNamesByFile = [
    ["send_code_to_revit.js", "send_code_to_revit"],
    ["send_code_to_revit_safe.js", "send_code_to_revit_safe"],
    ["get_revit_mcp_status.js", "get_revit_mcp_status"],
    ["get_revit_session_context.js", "get_revit_session_context"],
    ["get_active_view_context.js", "get_active_view_context"],
    ["inspect_elements.js", "inspect_elements"],
    ["inspect_parameter_schema.js", "inspect_parameter_schema"],
    ["analyze_mep_system.js", "analyze_mep_system"],
    ["prepare_write_plan.js", "prepare_write_plan"],
    ["preview_write_plan.js", "preview_write_plan"],
    ["commit_write_plan.js", "commit_write_plan"],
    ["verify_write_plan.js", "verify_write_plan"],
    ["get_workflow_state.js", "get_workflow_state"],
    ["clear_workflow_state.js", "clear_workflow_state"],
];

for (const [file, toolName] of expectedToolNamesByFile) {
    const source = readFileSync(join(toolsDir, file), "utf8");
    assert(source.includes(`server.tool("${toolName}"`), `${file} should register ${toolName}`);
}

console.log("tool registration tests passed");
