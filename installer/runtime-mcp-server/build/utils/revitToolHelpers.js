import { withRevitConnection } from "./ConnectionManager.js";
import { recordLiveActivityFinished, recordLiveActivityStarted, recordRevitCommandTelemetry, } from "./telemetry.js";
export function connectionTargetSchema(z) {
    return {
        target: z.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVIT_MCP_TARGET/REVIT_MCP_PORT/8080."),
        host: z.string().optional().describe("Optional Revit socket host. Defaults to REVIT_MCP_HOST or localhost."),
        port: z.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVIT_MCP_PORT or 8080."),
    };
}
export function taskMetadataSchema(z) {
    return {
        taskName: z.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),
        taskId: z.string().optional().describe("Optional client task identifier forwarded to Revit status history."),
    };
}
export function connectionOptionsFromArgs(args = {}) {
    return {
        target: args.target,
        host: args.host,
        port: args.port,
        timeoutMs: args.timeoutMs,
    };
}
export function taskOptionsFromArgs(args = {}, defaultTaskName) {
    return {
        taskName: args.taskName || defaultTaskName,
        taskId: args.taskId,
    };
}
export function executionOptionsFromArgs(args = {}, defaultTaskName) {
    return {
        ...connectionOptionsFromArgs(args),
        ...taskOptionsFromArgs(args, defaultTaskName),
    };
}
export function normalizeSuccessCasing(payload) {
    const visit = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => visit(item));
        }
        if (!value || typeof value !== "object") {
            return value;
        }
        const clone = {};
        for (const [key, child] of Object.entries(value)) {
            clone[key] = visit(child);
        }
        if (Object.prototype.hasOwnProperty.call(clone, "Success")) {
            if (!Object.prototype.hasOwnProperty.call(clone, "success")) {
                clone.success = clone.Success;
            }
            delete clone.Success;
        }
        if (Object.prototype.hasOwnProperty.call(clone, "SUCCESS") &&
            !Object.prototype.hasOwnProperty.call(clone, "success")) {
            clone.success = clone.SUCCESS;
            delete clone.SUCCESS;
        }
        else if (Object.prototype.hasOwnProperty.call(clone, "SUCCESS")) {
            delete clone.SUCCESS;
        }
        return clone;
    };
    return visit(payload);
}
export function formatJsonContent(payload) {
    const normalizedPayload = normalizeSuccessCasing(payload);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(normalizedPayload, null, 2),
            },
        ],
    };
}
function parseJsonLike(value, depth = 0) {
    if (typeof value !== "string") {
        return value;
    }
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\"")) {
        return value;
    }
    try {
        const parsed = JSON.parse(text);
        if (depth < 2 && typeof parsed === "string") {
            return parseJsonLike(parsed, depth + 1);
        }
        return parsed;
    }
    catch {
        return value;
    }
}
export function normalizeRevitExecutionResponse(response) {
    const parsed = parseJsonLike(response);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const cloned = { ...parsed };
        if ("result" in cloned) {
            cloned.result = parseJsonLike(cloned.result);
        }
        return cloned;
    }
    return parsed;
}
function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}
export function trimPlanCandidatesInPayload(payload, options = {}) {
    const verbose = options.verboseCandidates === true;
    const maxCandidates = clampInt(options.maxPlanCandidates, 3, 0, 100);
    if (verbose) {
        return payload;
    }
    const visit = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => visit(item));
        }
        if (!value || typeof value !== "object") {
            return value;
        }
        const clone = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "PlanCandidates" && Array.isArray(child)) {
                clone.PlanCandidatesTotal = child.length;
                clone.PlanCandidatesTruncated = child.length > maxCandidates;
                clone[key] = child.slice(0, maxCandidates).map((item) => visit(item));
                continue;
            }
            clone[key] = visit(child);
        }
        return clone;
    };
    return visit(payload);
}
function compactTaskInfo(task, includeDiagnostics) {
    if (!task || typeof task !== "object") {
        return task;
    }
    const compact = {
        id: task.id,
        requestId: task.requestId,
        method: task.method,
        taskName: task.taskName,
        state: task.state,
        startedAtUtc: task.startedAtUtc,
        finishedAtUtc: task.finishedAtUtc,
        elapsedMs: task.elapsedMs,
        port: task.port,
        error: task.error,
    };
    if (includeDiagnostics) {
        compact.framing = task.framing;
        compact.requestBytes = task.requestBytes;
        compact.receiveMs = task.receiveMs;
        compact.parseMs = task.parseMs;
        compact.executeMs = task.executeMs;
        compact.responseBytes = task.responseBytes;
    }
    return compact;
}
export function compactMcpStatusPayload(payload, options = {}) {
    const includeRecentTasks = options.includeRecentTasks !== false;
    const includeDiagnostics = options.includeDiagnostics === true;
    const recentLimit = clampInt(options.recentLimit, 3, 0, 100);
    const target = payload && typeof payload === "object" && payload.result && typeof payload.result === "object"
        ? payload.result
        : payload;
    if (!target || typeof target !== "object") {
        return payload;
    }
    const clone = { ...target };
    clone.activeTask = compactTaskInfo(target.activeTask, includeDiagnostics);
    if (Array.isArray(target.recentTasks)) {
        clone.recentHistoryCount = target.recentHistoryCount ?? target.recentTasks.length;
        clone.recentHistoryCapacity = target.recentHistoryCapacity ?? 100;
        delete clone.recentTasksTotal;
        if (includeRecentTasks) {
            clone.recentTasks = target.recentTasks
                .slice(0, recentLimit)
                .map((task) => compactTaskInfo(task, includeDiagnostics));
            clone.recentTasksTruncated = target.recentTasks.length > recentLimit;
        }
        else {
            delete clone.recentTasks;
            clone.recentTasksIncluded = false;
        }
    }
    if (payload && typeof payload === "object" && payload.result && typeof payload.result === "object") {
        return { ...payload, result: clone };
    }
    return clone;
}
export async function executeRevitCode(code, options = {}) {
    const params = {
        code,
        parameters: options.parameters || [],
        transactionMode: options.transactionMode || "none",
        taskName: options.taskName || "Run Revit code",
    };
    if (options.taskId) {
        params.taskId = options.taskId;
    }
    const startedAtMs = Date.now();
    const liveTask = recordLiveActivityStarted({
        scope: "revit.command",
        commandName: "send_code_to_revit",
        logicalToolName: options.toolName || params.taskName,
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
        const normalizedResponse = normalizeRevitExecutionResponse(response);
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        recordRevitCommandTelemetry({
            commandName: "send_code_to_revit",
            logicalToolName: options.toolName || params.taskName,
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
        return normalizedResponse;
    }
    catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        recordRevitCommandTelemetry({
            commandName: "send_code_to_revit",
            logicalToolName: options.toolName || params.taskName,
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
        throw error;
    }
}
export async function sendRevitCommand(command, params = {}, options = {}) {
    const commandParams = {
        ...params,
    };
    if (!commandParams.taskName) {
        commandParams.taskName = options.taskName || command;
    }
    if (options.taskId && !commandParams.taskId) {
        commandParams.taskId = options.taskId;
    }
    const startedAtMs = Date.now();
    const liveTask = recordLiveActivityStarted({
        scope: "revit.command",
        commandName: command,
        logicalToolName: options.toolName || command,
        executionKind: "bridgeCommand",
        taskName: commandParams.taskName,
        taskId: commandParams.taskId,
        params: commandParams,
        startedAtMs,
    });
    try {
        const response = await withRevitConnection(async (revitClient) => {
            return await revitClient.sendCommand(command, commandParams, options);
        }, options);
        const normalizedResponse = normalizeRevitExecutionResponse(response);
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        recordRevitCommandTelemetry({
            commandName: command,
            logicalToolName: options.toolName || command,
            executionKind: "bridgeCommand",
            params: commandParams,
            options,
            response: normalizedResponse,
            startedAtMs,
        });
        recordLiveActivityFinished(liveTask, {
            response: normalizedResponse,
            durationMs,
        });
        return normalizedResponse;
    }
    catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        recordRevitCommandTelemetry({
            commandName: command,
            logicalToolName: options.toolName || command,
            executionKind: "bridgeCommand",
            params: commandParams,
            options,
            error,
            startedAtMs,
        });
        recordLiveActivityFinished(liveTask, {
            error,
            durationMs,
        });
        throw error;
    }
}
export function csharpString(value) {
    if (value === null || value === undefined) {
        return "null";
    }
    return `"${String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")}"`;
}
export function csharpStringArray(values) {
    const safeValues = Array.isArray(values) ? values : [];
    return `new string[] { ${safeValues.map(csharpString).join(", ")} }`;
}
export function csharpIntArray(values) {
    const safeValues = (Array.isArray(values) ? values : [])
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
    return `new int[] { ${safeValues.join(", ")} }`;
}
export function truncateText(text, maxChars) {
    const limit = Number(maxChars || 0);
    if (!limit || typeof text !== "string" || text.length <= limit) {
        return { text, truncated: false };
    }
    return {
        text: `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`,
        truncated: true,
    };
}
export function extractElementIdsFromSelectionResponse(response) {
    const ids = new Set();
    const visit = (value, parentKey = "") => {
        if (value === null || value === undefined) {
            return;
        }
        if (typeof value === "number" && /(^id$|elementid|elementids)/i.test(parentKey)) {
            ids.add(value);
            return;
        }
        if (typeof value === "string" && /^-?\d+$/.test(value) && /(^id$|elementid|elementids)/i.test(parentKey)) {
            ids.add(Number.parseInt(value, 10));
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, parentKey);
            }
            return;
        }
        if (typeof value === "object") {
            for (const [key, child] of Object.entries(value)) {
                visit(child, key);
            }
        }
    };
    visit(response);
    return [...ids].filter((id) => Number.isFinite(id) && id > 0);
}
export async function getSelectionElementIds(limit = 100, options = {}) {
    const response = await sendRevitCommand("get_selected_elements", { limit }, options);
    return extractElementIdsFromSelectionResponse(response).slice(0, limit);
}
