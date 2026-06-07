import { withRevitConnection } from "./ConnectionManager.js";
import {
    recordLiveActivityFinished,
    recordLiveActivityStarted,
    recordLiveRevitStatus,
    recordRevitCommandTelemetry,
} from "./telemetry.js";

export const BRIDGE_RESULT_CONTRACT_VERSION = 2;

type JsonObject = Record<string, any>;

interface ConnectionArgs extends JsonObject {
    target?: string;
    host?: string;
    port?: number;
    timeoutMs?: number;
    taskName?: string;
    taskId?: string;
    parentTaskName?: string;
    parentTaskId?: string;
}

interface TrimPlanCandidatesOptions {
    verboseCandidates?: boolean;
    maxPlanCandidates?: number;
}

interface CompactMcpStatusOptions {
    includeRecentTasks?: boolean;
    includeDiagnostics?: boolean;
    recentLimit?: number;
}

interface ExecuteRevitCodeOptions extends ConnectionArgs {
    parameters?: unknown[];
    transactionMode?: string;
    toolName?: string;
    statusRefreshTimeoutMs?: number;
}

interface SendRevitCommandOptions extends ConnectionArgs {
    toolName?: string;
    statusRefreshTimeoutMs?: number;
}

export function connectionTargetSchema(z: any) {
    return {
        target: z.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVIT_MCP_TARGET/REVIT_MCP_PORT/8080."),
        host: z.string().optional().describe("Optional Revit socket host. Defaults to REVIT_MCP_HOST or localhost."),
        port: z.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVIT_MCP_PORT or 8080."),
    };
}

export function taskMetadataSchema(z: any) {
    return {
        taskName: z.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),
        taskId: z.string().optional().describe("Optional client task identifier forwarded to Revit status history."),
        parentTaskName: z.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),
        parentTaskId: z.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id."),
    };
}

export function readCasedField(payload: any, pascalName: string, camelName?: string) {
    if (!payload || typeof payload !== "object") {
        return undefined;
    }
    const normalizedCamelName = camelName ?? pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
    return payload[pascalName] ?? payload[normalizedCamelName];
}

export function connectionOptionsFromArgs(args: ConnectionArgs = {}) {
    return {
        target: args.target,
        host: args.host,
        port: args.port,
        timeoutMs: args.timeoutMs,
    };
}

export function taskOptionsFromArgs(args: ConnectionArgs = {}, defaultTaskName: string) {
    return {
        taskName: args.taskName || defaultTaskName,
        taskId: args.taskId,
        parentTaskName: args.parentTaskName,
        parentTaskId: args.parentTaskId,
    };
}

export function executionOptionsFromArgs(args: ConnectionArgs = {}, defaultTaskName: string) {
    return {
        ...connectionOptionsFromArgs(args),
        ...taskOptionsFromArgs(args, defaultTaskName),
    };
}

function applyParentTaskMetadata(commandParams: JsonObject, options: ConnectionArgs) {
    const parentTaskName = options.parentTaskName ||
        (options.taskName && commandParams.taskName && commandParams.taskName !== options.taskName
            ? options.taskName
            : undefined);
    const parentTaskId = options.parentTaskId ||
        (options.taskId && commandParams.taskName && commandParams.taskName !== options.taskName
            ? options.taskId
            : undefined);
    if (parentTaskName && !commandParams.parentTaskName) {
        commandParams.parentTaskName = parentTaskName;
    }
    if (parentTaskId && !commandParams.parentTaskId) {
        commandParams.parentTaskId = parentTaskId;
    }
}

export function normalizeSuccessCasing(payload: any) {
    const contractKeyAliases: Array<[string, string]> = [
        ["Success", "success"],
        ["SUCCESS", "success"],
        ["Guarded", "guarded"],
        ["State", "state"],
        ["Action", "action"],
        ["Message", "message"],
        ["Error", "error"],
        ["ResultContractVersion", "resultContractVersion"],
    ];

    const visit = (value: any): any => {
        if (Array.isArray(value)) {
            return value.map((item) => visit(item));
        }
        if (!value || typeof value !== "object") {
            return value;
        }

        const clone: JsonObject = {};
        for (const [key, child] of Object.entries(value)) {
            clone[key] = visit(child);
        }

        for (const [pascalName, camelName] of contractKeyAliases) {
            if (Object.prototype.hasOwnProperty.call(clone, pascalName)) {
                if (!Object.prototype.hasOwnProperty.call(clone, camelName)) {
                    clone[camelName] = clone[pascalName];
                }
                delete clone[pascalName];
            }
        }
        return clone;
    };

    return visit(payload);
}

export function formatJsonContent(payload: any) {
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

function parseJsonLike(value: any, depth = 0): any {
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

export function getResultContractVersion(payload: any) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
    }
    const raw = payload.resultContractVersion ?? payload.ResultContractVersion;
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function hasCanonicalBridgeResultContract(payload: any) {
    const version = getResultContractVersion(payload);
    return version !== null && version >= BRIDGE_RESULT_CONTRACT_VERSION;
}

export function normalizeRevitExecutionResponse(response: any) {
    const parsed = parseJsonLike(response);
    if (hasCanonicalBridgeResultContract(parsed)) {
        return parsed;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const cloned = { ...parsed };
        if ("result" in cloned) {
            cloned.result = parseJsonLike(cloned.result);
        }
        return normalizeSuccessCasing(cloned);
    }
    return normalizeSuccessCasing(parsed);
}

function clampInt(value: any, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

export function trimPlanCandidatesInPayload(payload: any, options: TrimPlanCandidatesOptions = {}) {
    const verbose = options.verboseCandidates === true;
    const maxCandidates = clampInt(options.maxPlanCandidates, 3, 0, 100);
    if (verbose) {
        return payload;
    }

    const visit = (value: any): any => {
        if (Array.isArray(value)) {
            return value.map((item) => visit(item));
        }
        if (!value || typeof value !== "object") {
            return value;
        }

        const clone: JsonObject = {};
        for (const [key, child] of Object.entries(value)) {
            if ((key === "PlanCandidates" || key === "planCandidates") && Array.isArray(child)) {
                const totalKey = key === "PlanCandidates" ? "PlanCandidatesTotal" : "planCandidatesTotal";
                const truncatedKey = key === "PlanCandidates" ? "PlanCandidatesTruncated" : "planCandidatesTruncated";
                clone[totalKey] = child.length;
                clone[truncatedKey] = child.length > maxCandidates;
                clone[key] = child.slice(0, maxCandidates).map((item) => visit(item));
                continue;
            }
            clone[key] = visit(child);
        }
        return clone;
    };

    return visit(payload);
}

function compactTaskInfo(task: any, includeDiagnostics: boolean) {
    if (!task || typeof task !== "object") {
        return task;
    }
    const compact: JsonObject = {
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

export function compactMcpStatusPayload(payload: any, options: CompactMcpStatusOptions = {}) {
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
                .map((task: any) => compactTaskInfo(task, includeDiagnostics));
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

export async function executeRevitCode(code: string, options: ExecuteRevitCodeOptions = {}) {
    const params = {
        code,
        parameters: options.parameters || [],
        transactionMode: options.transactionMode || "none",
        taskName: options.taskName || "Run Revit code",
    } as JsonObject;
    if (options.taskId) {
        params.taskId = options.taskId;
    }
    applyParentTaskMetadata(params, options);
    const startedAtMs = Date.now();
    const liveTask = recordLiveActivityStarted({
        scope: "revit.command",
        commandName: "send_code_to_revit",
        logicalToolName: options.toolName || params.taskName,
        executionKind: "dynamicCode",
        taskName: params.taskName,
        taskId: params.taskId,
        parentTaskName: params.parentTaskName,
        parentTaskId: params.parentTaskId,
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
        void refreshLiveRevitStatus(options);
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
        void refreshLiveRevitStatus(options);
        throw error;
    }
}

export async function refreshLiveRevitStatus(options: ExecuteRevitCodeOptions | SendRevitCommandOptions = {}) {
    const timeoutMs = Math.max(250, Math.min(5000, Number(options.statusRefreshTimeoutMs || 1500)));
    try {
        const status = await withRevitConnection(async (revitClient) => {
            return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
        }, {
            ...options,
            skipLock: true,
            connectTimeoutMs: timeoutMs,
            timeoutMs,
            logSocketErrors: false,
        });
        recordLiveRevitStatus(status);
        return status;
    }
    catch {
        return null;
    }
}

export async function sendRevitCommand(command: string, params: JsonObject = {}, options: SendRevitCommandOptions = {}) {
    const commandParams = {
        ...params,
    };
    if (!commandParams.taskName) {
        commandParams.taskName = options.taskName || command;
    }
    applyParentTaskMetadata(commandParams, options);
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
        parentTaskName: commandParams.parentTaskName,
        parentTaskId: commandParams.parentTaskId,
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
        void refreshLiveRevitStatus(options);
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
        void refreshLiveRevitStatus(options);
        throw error;
    }
}

export function csharpString(value: any) {
    if (value === null || value === undefined) {
        return "null";
    }
    return `"${String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")}"`;
}

export function csharpStringArray(values: any) {
    const safeValues = Array.isArray(values) ? values : [];
    return `new string[] { ${safeValues.map(csharpString).join(", ")} }`;
}

export function csharpIntArray(values: any) {
    const safeValues = (Array.isArray(values) ? values : [])
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
    return `new int[] { ${safeValues.join(", ")} }`;
}

export function truncateText(text: any, maxChars: any) {
    const limit = Number(maxChars || 0);
    if (!limit || typeof text !== "string" || text.length <= limit) {
        return { text, truncated: false };
    }
    return {
        text: `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`,
        truncated: true,
    };
}

export function extractElementIdsFromSelectionResponse(response: any) {
    const ids = new Set<number>();
    const visit = (value: any, parentKey = "") => {
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

export async function getSelectionElementIds(limit = 100, options: SendRevitCommandOptions = {}) {
    const response = await sendRevitCommand("get_selected_elements", { limit }, options);
    return extractElementIdsFromSelectionResponse(response).slice(0, limit);
}
