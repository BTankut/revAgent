import { registerSendCodeToRevitTool } from "./send_code_to_revit.js";
import { registerSendCodeToRevitSafeTool } from "./send_code_to_revit_safe.js";
import { registerGetRevitMcpStatusTool } from "./get_revit_mcp_status.js";
import { registerGetRevitSessionContextTool } from "./get_revit_session_context.js";
import { registerGetActiveViewContextTool } from "./get_active_view_context.js";
import { registerInspectElementsTool } from "./inspect_elements.js";
import { registerInspectParameterSchemaTool } from "./inspect_parameter_schema.js";
import { registerAnalyzeMepSystemTool } from "./analyze_mep_system.js";
import { registerPrepareWritePlanTool } from "./prepare_write_plan.js";
import { registerPreviewWritePlanTool } from "./preview_write_plan.js";
import { registerCommitWritePlanTool } from "./commit_write_plan.js";
import { registerVerifyWritePlanTool } from "./verify_write_plan.js";
import { registerGetWorkflowStateTool } from "./get_workflow_state.js";
import { registerClearWorkflowStateTool } from "./clear_workflow_state.js";

export async function registerTools(server) {
    registerSendCodeToRevitTool(server);
    registerSendCodeToRevitSafeTool(server);
    registerGetRevitMcpStatusTool(server);
    registerGetRevitSessionContextTool(server);
    registerGetActiveViewContextTool(server);
    registerInspectElementsTool(server);
    registerInspectParameterSchemaTool(server);
    registerAnalyzeMepSystemTool(server);
    registerPrepareWritePlanTool(server);
    registerPreviewWritePlanTool(server);
    registerCommitWritePlanTool(server);
    registerVerifyWritePlanTool(server);
    registerGetWorkflowStateTool(server);
    registerClearWorkflowStateTool(server);
    console.error("Registered 14 Revit MCP tools");
}
