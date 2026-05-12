// @ts-nocheck
import { withRevitConnection } from "./ConnectionManager.js";

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

export function formatJsonContent(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
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
    const response = await withRevitConnection(async (revitClient) => {
        return await revitClient.sendCommand("send_code_to_revit", params, options);
    }, options);
    return normalizeRevitExecutionResponse(response);
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
    const response = await withRevitConnection(async (revitClient) => {
        return await revitClient.sendCommand(command, commandParams, options);
    }, options);
    return normalizeRevitExecutionResponse(response);
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
