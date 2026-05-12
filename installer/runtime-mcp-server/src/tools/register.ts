// @ts-nocheck
import { registerSendCodeToRevitTool } from "./send_code_to_revit.js";
import { registerSendCodeToRevitSafeTool } from "./send_code_to_revit_safe.js";
import { registerGetRevitSessionContextTool } from "./get_revit_session_context.js";
import { registerGetActiveViewContextTool } from "./get_active_view_context.js";
import { registerListOpenViewsTool } from "./list_open_views.js";
import { registerActivateViewTool } from "./activate_view.js";
import { registerCloseViewTool } from "./close_view.js";
import { registerFocusElementsTool } from "./focus_elements.js";
import { registerSectionBoxElementsTool } from "./section_box_elements.js";
import { registerInspectElementsTool } from "./inspect_elements.js";
import { registerInspectParameterSchemaTool } from "./inspect_parameter_schema.js";
import { registerListRevitInstancesTool } from "./list_revit_instances.js";
import { registerGetRevitMcpStatusTool } from "./get_revit_mcp_status.js";

export async function registerTools(server) {
    registerListRevitInstancesTool(server);
    registerGetRevitMcpStatusTool(server);
    registerSendCodeToRevitTool(server);
    registerSendCodeToRevitSafeTool(server);
    registerGetRevitSessionContextTool(server);
    registerGetActiveViewContextTool(server);
    registerListOpenViewsTool(server);
    registerActivateViewTool(server);
    registerCloseViewTool(server);
    registerFocusElementsTool(server);
    registerSectionBoxElementsTool(server);
    registerInspectElementsTool(server);
    registerInspectParameterSchemaTool(server);
    console.error("Registered 13 Revit MCP tools");
}
