import { withRevitConnection } from "./ConnectionManager.js";

export const REVIT_MCP_STATUS_COMMAND = "get_mcp_status";
const DEFAULT_HANDSHAKE_WAIT_MS = 125000;
const DEFAULT_HANDSHAKE_POLL_MS = 250;
const DEFAULT_STATUS_TIMEOUT_MS = 3000;

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

function parseJsonLike(value) {
    if (typeof value !== "string") {
        return value;
    }
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) {
        return value;
    }
    try {
        return JSON.parse(text);
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
    };
    return await sendRevitCommand("send_code_to_revit", params, options);
}

export async function sendRevitCommand(command, params = {}, options = {}) {
    const response = await withRevitConnection(async (revitClient) => {
        if (options.handshake !== false && command !== REVIT_MCP_STATUS_COMMAND) {
            await waitForRevitMcpReady(revitClient, command, params, options);
        }
        return await revitClient.sendCommand(command, params, { timeoutMs: options.timeoutMs });
    }, {
        command,
        params,
        gate: options.gate,
        waitMs: options.gateWaitMs,
        connectTimeoutMs: options.connectTimeoutMs,
    });
    return normalizeRevitExecutionResponse(response);
}

export async function readRevitMcpStatus(options = {}) {
    try {
        const response = await withRevitConnection(async (revitClient) => {
            return await revitClient.sendCommand(REVIT_MCP_STATUS_COMMAND, {}, {
                timeoutMs: options.timeoutMs || DEFAULT_STATUS_TIMEOUT_MS,
            });
        }, {
            command: REVIT_MCP_STATUS_COMMAND,
            gate: false,
            connectTimeoutMs: options.connectTimeoutMs,
        });
        return normalizeRevitExecutionResponse(response);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStatusCommandUnavailable(message)) {
            return { success: false, supported: false, error: message };
        }
        throw error;
    }
}

async function waitForRevitMcpReady(revitClient, command, params, options) {
    const waitMs = Number(options.handshakeWaitMs || process.env.REVIT_MCP_HANDSHAKE_WAIT_MS || DEFAULT_HANDSHAKE_WAIT_MS);
    const pollMs = Number(process.env.REVIT_MCP_HANDSHAKE_POLL_MS || DEFAULT_HANDSHAKE_POLL_MS);
    const startedAt = Date.now();

    while (true) {
        const status = await tryReadRevitMcpStatus(revitClient, options);
        if (!status || status.supported === false || status.busy !== true) {
            return;
        }
        if (Date.now() - startedAt >= waitMs) {
            const active = status.activeCommand && typeof status.activeCommand === "object"
                ? `${status.activeCommand.method || "unknown"}${status.activeCommand.planId ? ` planId=${status.activeCommand.planId}` : ""}`
                : "another Revit MCP command";
            throw new Error(`Revit MCP is busy running ${active}; handshake refused ${command}.`);
        }
        await sleep(pollMs);
    }
}

async function tryReadRevitMcpStatus(revitClient, options) {
    try {
        const response = await revitClient.sendCommand(REVIT_MCP_STATUS_COMMAND, {}, {
            timeoutMs: options.statusTimeoutMs || DEFAULT_STATUS_TIMEOUT_MS,
        });
        return normalizeRevitExecutionResponse(response);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStatusCommandUnavailable(message)) {
            return { supported: false };
        }
        throw error;
    }
}

function isStatusCommandUnavailable(message) {
    return message.includes(`Method '${REVIT_MCP_STATUS_COMMAND}' not found`) || message.includes("Method not found");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function getSelectionElementIds(limit = 100) {
    const response = await sendRevitCommand("get_selected_elements", { limit });
    return extractElementIdsFromSelectionResponse(response).slice(0, limit);
}
