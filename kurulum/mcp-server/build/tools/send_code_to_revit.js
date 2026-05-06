import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";
export function registerSendCodeToRevitTool(server) {
    server.tool("send_code_to_revit", "Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        code: z
            .string()
            .describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),
        parameters: z
            .array(z.any())
            .optional()
            .describe("Optional execution parameters that will be passed to your code"),
        transactionMode: z
            .enum(["auto", "none"])
            .optional()
            .describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),
    }, async (args, extra) => {
        const params = {
            code: args.code,
            parameters: args.parameters || [],
            transactionMode: args.transactionMode || "auto",
            taskName: args.taskName || "Run Revit code",
        };
        if (args.taskId) {
            params.taskId = args.taskId;
        }
        try {
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("send_code_to_revit", params);
            }, connectionOptionsFromArgs(args));
            return {
                content: [
                    {
                        type: "text",
                        text: `Code execution successful!\nResult: ${JSON.stringify(response, null, 2)}`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Code execution failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
