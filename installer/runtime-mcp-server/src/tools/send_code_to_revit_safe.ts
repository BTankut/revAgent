// @ts-nocheck
import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    executeRevitCode,
    formatJsonContent,
    normalizeRevitExecutionResponse,
    taskMetadataSchema,
    taskOptionsFromArgs,
    truncateText,
} from "../utils/revitToolHelpers.js";
import { findWritePatterns } from "./send_code_to_revit_safe_guards.js";

export function registerSendCodeToRevitSafeTool(server) {
    server.tool("send_code_to_revit_safe", "Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        code: z.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),
        parameters: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),
        transactionMode: z.enum(["auto", "none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),
        intent: z.enum(["read", "writePreview", "writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),
        timeoutMs: z.number().int().positive().optional().describe("Reserved for future plugin support; current socket timeout is controlled by the Revit client."),
        maxReturnedChars: z.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),
        parseJsonResult: z.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true."),
    }, async (args) => {
        const intent = args.intent || "read";
        const writePatterns = findWritePatterns(args.code);
        if (intent === "writeCommit") {
            return formatJsonContent({
                success: false,
                error: "send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",
                writePatterns,
            });
        }
        if (args.transactionMode === "auto") {
            return formatJsonContent({
                success: false,
                error: "send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",
                writePatterns,
            });
        }
        if (writePatterns.length > 0) {
            return formatJsonContent({
                success: false,
                error: `Rejected write-looking code for intent '${intent}'.`,
                writePatterns,
            });
        }
        try {
            const response = await executeRevitCode(args.code, {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, "Run safe Revit read"),
                parameters: args.parameters || [],
                transactionMode: "none",
            });
            const normalized = args.parseJsonResult === false
                ? response
                : normalizeRevitExecutionResponse(response);
            const serialized = JSON.stringify({
                success: true,
                intent,
                response: normalized,
            }, null, 2);
            const trimmed = truncateText(serialized, args.maxReturnedChars);
            if (trimmed.truncated) {
                return {
                    content: [
                        {
                            type: "text",
                            text: trimmed.text,
                        },
                    ],
                };
            }
            return formatJsonContent({
                success: true,
                intent,
                response: normalized,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
