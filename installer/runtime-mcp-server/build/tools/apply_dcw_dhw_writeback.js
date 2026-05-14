import { z } from "zod";
import { connectionOptionsFromArgs, connectionTargetSchema, executeRevitCode, formatJsonContent, normalizeRevitExecutionResponse, taskMetadataSchema, taskOptionsFromArgs, truncateText, } from "../utils/revitToolHelpers.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { createWriteBackCode, validateWriteBackApproval, WRITEBACK_CONFIRM_TEXT, } from "../engineering/dcw-dhw/writeBack.js";
async function readRevitStatus(args) {
    const timeoutMs = args.statusTimeoutMs || 3000;
    return await withRevitConnection(async (revitClient) => {
        return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
    }, {
        ...connectionOptionsFromArgs(args),
        skipLock: true,
        connectTimeoutMs: timeoutMs,
    });
}
function activeTaskFromStatus(status) {
    const normalized = normalizeRevitExecutionResponse(status);
    if (!normalized || typeof normalized !== "object") {
        return null;
    }
    return normalized.activeTask || normalized.ActiveTask || null;
}
export function registerApplyDcwDhwWritebackTool(server) {
    server.tool("apply_dcw_dhw_writeback", "Apply approved DCW/DHW diameter and parameter write-back actions to Revit. Requires exact approvalToken and confirm text from audit_dcw_dhw_piping. Performs a Revit MCP status preflight before sending the write.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        actions: z.array(z.object({
            actionId: z.string(),
            writeKind: z.enum(["diameter", "parameter"]),
            nodeId: z.string().optional().nullable(),
            elementId: z.union([z.number(), z.string()]),
            parameterName: z.string().optional().nullable(),
            targetDiameterMm: z.number().optional().nullable(),
            parameterValue: z.any().optional().nullable(),
            parameterUnit: z.string().optional().nullable(),
            trace: z.any().optional(),
        })).describe("Actions copied from audit_dcw_dhw_piping.writeBackPlan.actions."),
        approvalToken: z.string().describe("Exact approval token from audit_dcw_dhw_piping.writeBackPlan.approvalToken."),
        confirmWriteBack: z.string().describe(`Must be '${WRITEBACK_CONFIRM_TEXT}' to commit model changes.`),
        dryRun: z.boolean().optional().describe("When true, validate approval and return the generated action summary without sending a Revit write. Defaults true."),
        timeoutMs: z.number().int().positive().optional().describe("Socket timeout in milliseconds for the Revit write. Defaults 120000."),
        statusTimeoutMs: z.number().int().positive().max(10000).optional().describe("Status preflight timeout in milliseconds. Defaults 3000."),
        maxReturnedChars: z.number().int().positive().optional().describe("Maximum returned JSON characters."),
    }, async (args) => {
        const validation = validateWriteBackApproval(args.actions, args.approvalToken, args.confirmWriteBack);
        if (!validation.ok) {
            return formatJsonContent({
                success: false,
                schemaVersion: "dcw-dhw-writeback-preflight.v1",
                errors: validation.errors,
                expectedApprovalToken: validation.expectedToken,
            });
        }
        const dryRun = args.dryRun !== false;
        const code = createWriteBackCode(validation.normalizedActions);
        if (dryRun) {
            return formatJsonContent({
                success: true,
                schemaVersion: "dcw-dhw-writeback-preflight.v1",
                dryRun: true,
                actionCount: validation.normalizedActions.length,
                approvalToken: validation.expectedToken,
                actions: validation.normalizedActions,
                note: "Dry run only; no Revit command was sent.",
            });
        }
        try {
            const status = await readRevitStatus(args);
            const activeTask = activeTaskFromStatus(status);
            if (activeTask) {
                return formatJsonContent({
                    success: false,
                    schemaVersion: "dcw-dhw-writeback-preflight.v1",
                    error: "Revit MCP is busy; write-back was not sent.",
                    activeTask,
                });
            }
            const response = await executeRevitCode(code, {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, "Apply DCW/DHW write-back"),
                transactionMode: "auto",
                parameters: [],
            });
            const payload = {
                success: true,
                schemaVersion: "dcw-dhw-writeback-wrapper.v1",
                actionCount: validation.normalizedActions.length,
                response: normalizeRevitExecutionResponse(response),
            };
            const text = JSON.stringify(payload, null, 2);
            const trimmed = truncateText(text, args.maxReturnedChars);
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
            return formatJsonContent(payload);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                schemaVersion: "dcw-dhw-writeback-wrapper.v1",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
