import type { ToolServer } from "./types.js";
import { registerSearchApiTool } from "./search_api.js";
import { registerGetTypeDetailsTool } from "./get_type_details.js";
import { registerGetMemberDetailsTool } from "./get_member_details.js";
import { registerListNamespaceTool } from "./list_namespace.js";
import { registerResolveApiSymbolsBulkTool } from "./resolve_api_symbols_bulk.js";

export async function registerTools(server: ToolServer) {
    registerSearchApiTool(server);
    registerGetTypeDetailsTool(server);
    registerGetMemberDetailsTool(server);
    registerListNamespaceTool(server);
    registerResolveApiSymbolsBulkTool(server);
    console.error("Registered 5 Revit API Docs MCP tools");
}
