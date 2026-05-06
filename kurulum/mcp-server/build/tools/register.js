import { registerSendCodeToRevitTool } from "./send_code_to_revit.js";
import { registerSendCodeToRevitSafeTool } from "./send_code_to_revit_safe.js";
import { registerGetRevitSessionContextTool } from "./get_revit_session_context.js";
import { registerGetActiveViewContextTool } from "./get_active_view_context.js";
import { registerInspectElementsTool } from "./inspect_elements.js";
import { registerInspectParameterSchemaTool } from "./inspect_parameter_schema.js";
import { registerListRevitInstancesTool } from "./list_revit_instances.js";

export async function registerTools(server) {
    registerListRevitInstancesTool(server);
    registerSendCodeToRevitTool(server);
    registerSendCodeToRevitSafeTool(server);
    registerGetRevitSessionContextTool(server);
    registerGetActiveViewContextTool(server);
    registerInspectElementsTool(server);
    registerInspectParameterSchemaTool(server);
    console.error("Registered 7 Revit MCP tools");
}
