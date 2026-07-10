import { z } from "zod";
import { listNamespace } from "../utils/docIndex.js";
import { formatJsonToolResult, formatToolFailure } from "./tool_result.js";
export function registerListNamespaceTool(server) {
    server.tool("list_namespace", "List types and child namespaces under a Revit API namespace.", {
        namespace: z.string().min(1).describe("Namespace to inspect, such as Autodesk.Revit.DB or Autodesk.Revit.UI.Selection."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
        include_child_namespaces: z.boolean().optional().describe("When true, include immediate child namespaces."),
    }, async (args) => {
        try {
            const result = await listNamespace({
                namespaceName: args.namespace,
                revitVersion: args.revit_version,
                includeChildNamespaces: args.include_child_namespaces,
            });
            return formatJsonToolResult(result);
        }
        catch (error) {
            return formatToolFailure("list_namespace", error);
        }
    });
}
