import type { ToolServer } from "./types.js";
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
import { runtimeFailure, runtimeGuarded, runtimeSuccess } from "../utils/runtimeResult.js";

function formatSafetyBlock(error: string, writePatterns: string[], safetyReason: string) {
    return formatJsonContent(runtimeGuarded({
        action: "send_code_to_revit_safe_preflight",
        error,
        reason: safetyReason,
        extra: {
            safetyReason,
            writePatterns,
        },
    }));
}

export function registerSendCodeToRevitSafeTool(server: ToolServer) {
    server.tool("send_code_to_revit_safe", "Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        code: z.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),
        parameters: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),
        transactionMode: z.enum(["auto", "none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),
        intent: z.enum(["read", "writePreview", "writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),
        timeoutMs: z.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),
        maxReturnedChars: z.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),
        parseJsonResult: z.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true."),
    }, async (args) => {
        const intent = args.intent || "read";
        const writePatterns = findWritePatterns(args.code);
        if (intent === "writeCommit") {
            return formatSafetyBlock(
                "send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",
                writePatterns,
                "safe_wrapper_write_commit_not_supported",
            );
        }
        if (args.transactionMode === "auto") {
            return formatSafetyBlock(
                "send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",
                writePatterns,
                "safe_wrapper_requires_transactionMode_none",
            );
        }
        if (writePatterns.length > 0) {
            return formatSafetyBlock(
                `Rejected write-looking code for intent '${intent}'.`,
                writePatterns,
                "safe_wrapper_rejected_write_looking_code",
            );
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
            const successPayload = runtimeSuccess({
                action: "send_code_to_revit_safe",
                extra: {
                    intent,
                    response: normalized,
                },
            });
            const serialized = JSON.stringify(successPayload, null, 2);
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
            return formatJsonContent(successPayload);
        }
        catch (error) {
            return formatJsonContent(runtimeFailure({
                action: "send_code_to_revit_safe",
                error: error instanceof Error ? error.message : String(error),
            }));
        }
    });
}
