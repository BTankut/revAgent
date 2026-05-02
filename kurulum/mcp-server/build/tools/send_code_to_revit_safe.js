import { z } from "zod";
import {
    executeRevitCode,
    formatJsonContent,
    normalizeRevitExecutionResponse,
    truncateText,
} from "../utils/revitToolHelpers.js";

const WRITE_PATTERNS = [
    { name: "Parameter.Set", pattern: /\.Set\s*\(/i },
    { name: "Parameter.SetValueString", pattern: /\.SetValueString\s*\(/i },
    { name: "Parameter.ClearValue", pattern: /\.ClearValue\s*\(/i },
    { name: "Document.Delete", pattern: /Document\s*\.\s*Delete|document\s*\.\s*Delete/i },
    { name: "ElementTransformUtils", pattern: /ElementTransformUtils/i },
    { name: "NewFamilyInstance", pattern: /NewFamilyInstance/i },
    { name: "Create API", pattern: /\.(Create|New[A-Z]\w*)\s*\(/ },
    { name: "Manual Transaction", pattern: /new\s+Transaction\s*\(|Transaction\s*\(/i },
];

function findWritePatterns(code) {
    return WRITE_PATTERNS
        .filter((entry) => entry.pattern.test(code))
        .map((entry) => entry.name);
}

export function registerSendCodeToRevitSafeTool(server) {
    server.tool("send_code_to_revit_safe", "Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.", {
        code: z.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),
        parameters: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),
        transactionMode: z.enum(["auto", "none"]).optional().describe("Forwarded transaction mode. Defaults to none for safe read/preview calls."),
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
        if (writePatterns.length > 0) {
            return formatJsonContent({
                success: false,
                error: `Rejected write-looking code for intent '${intent}'.`,
                writePatterns,
            });
        }
        try {
            const response = await executeRevitCode(args.code, {
                parameters: args.parameters || [],
                transactionMode: args.transactionMode || "none",
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
