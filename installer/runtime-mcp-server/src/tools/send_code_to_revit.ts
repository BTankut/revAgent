// @ts-nocheck
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    normalizeRevitExecutionResponse,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";
import {
    recordLiveActivityFinished,
    recordLiveActivityStarted,
    recordRevitCommandTelemetry,
} from "../utils/telemetry.js";

function findErrorLikeResult(value) {
    const normalized = normalizeRevitExecutionResponse(value);
    const candidate = normalized && typeof normalized === "object" && "result" in normalized
        ? normalized.result
        : normalized;

    if (typeof candidate === "string" && /^\s*ERROR\s*:/i.test(candidate)) {
        return candidate.trim();
    }

    if (candidate && typeof candidate === "object" && candidate.success === false) {
        return candidate.error || candidate.message || "Revit code returned success=false.";
    }

    return null;
}

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
        timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),
        reportErrorResultAsFailure: z
            .boolean()
            .optional()
            .describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),
        parseJsonResult: z
            .boolean()
            .optional()
            .describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result."),
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
        const options = connectionOptionsFromArgs(args);
        const startedAtMs = Date.now();
        const liveTask = recordLiveActivityStarted({
            scope: "revit.command",
            commandName: "send_code_to_revit",
            logicalToolName: "send_code_to_revit",
            executionKind: "dynamicCode",
            taskName: params.taskName,
            taskId: params.taskId,
            params,
            startedAtMs,
        });
        try {
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("send_code_to_revit", params, options);
            }, options);
            const normalizedResponse = args.parseJsonResult === false
                ? response
                : normalizeRevitExecutionResponse(response);
            const durationMs = Math.max(0, Date.now() - startedAtMs);
            recordRevitCommandTelemetry({
                commandName: "send_code_to_revit",
                logicalToolName: "send_code_to_revit",
                executionKind: "dynamicCode",
                params,
                options,
                response: normalizedResponse,
                startedAtMs,
            });
            recordLiveActivityFinished(liveTask, {
                response: normalizedResponse,
                durationMs,
            });
            const errorLikeResult = args.reportErrorResultAsFailure === false
                ? null
                : findErrorLikeResult(normalizedResponse);
            if (errorLikeResult) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Code execution failed: ${errorLikeResult}`,
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Code execution successful!\nResult: ${JSON.stringify(normalizedResponse, null, 2)}`,
                    },
                ],
            };
        }
        catch (error) {
            const durationMs = Math.max(0, Date.now() - startedAtMs);
            recordRevitCommandTelemetry({
                commandName: "send_code_to_revit",
                logicalToolName: "send_code_to_revit",
                executionKind: "dynamicCode",
                params,
                options,
                error,
                startedAtMs,
            });
            recordLiveActivityFinished(liveTask, {
                error,
                durationMs,
            });
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
