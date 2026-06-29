import * as net from "net";
import { readEnv } from "./env.js";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export class RevitClientConnection {
    host;
    port;
    socket;
    logErrors;
    isConnected = false;
    responseCallbacks = new Map();
    buffer = Buffer.alloc(0);
    framingMode = readEnv("REVAGENT_FRAMING", "REVIT_MCP_FRAMING") === "legacy" ? "legacy" : "length-prefixed";
    constructor(host, port, options = {}) {
        this.host = host;
        this.port = port;
        this.logErrors = options.logErrors !== false;
        this.socket = new net.Socket();
        this.setupSocketListeners();
    }
    setupSocketListeners() {
        this.socket.on("connect", () => {
            this.isConnected = true;
        });
        this.socket.on("data", (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processBuffer();
        });
        this.socket.on("close", () => {
            this.isConnected = false;
        });
        this.socket.on("error", (error) => {
            if (this.logErrors) {
                console.error("RevitClientConnection error:", error);
            }
            this.isConnected = false;
        });
    }
    processBuffer() {
        while (this.buffer.length > 0) {
            if (this.buffer.length > MAX_RESPONSE_BYTES) {
                this.rejectPending(new Error(`revAgent response exceeded ${MAX_RESPONSE_BYTES} bytes`));
                this.buffer = Buffer.alloc(0);
                return;
            }
            if (this.isLikelyLegacyJson(this.buffer)) {
                if (!this.processLegacyJsonBuffer()) {
                    return;
                }
                continue;
            }
            if (!this.isLikelyLengthPrefixed(this.buffer)) {
                return;
            }
            if (!this.processLengthPrefixedBuffer()) {
                return;
            }
        }
    }
    isLikelyLegacyJson(buffer) {
        let index = 0;
        while (index < buffer.length && [0x20, 0x09, 0x0a, 0x0d].includes(buffer[index])) {
            index++;
        }
        return index < buffer.length && buffer[index] === 0x7b;
    }
    isLikelyLengthPrefixed(buffer) {
        if (buffer.length < 4) {
            return true;
        }
        const length = buffer.readUInt32BE(0);
        return length > 0 && length <= MAX_RESPONSE_BYTES;
    }
    processLegacyJsonBuffer() {
        try {
            const text = this.buffer.toString("utf8");
            const extracted = this.extractFirstJsonObject(text);
            if (!extracted) {
                return false;
            }
            const response = JSON.parse(extracted.json);
            this.handleResponseObject(response, extracted.json);
            this.buffer = Buffer.from(extracted.remaining, "utf8");
            return true;
        }
        catch {
            return false;
        }
    }
    extractFirstJsonObject(text) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let started = false;
        let startIndex = 0;
        for (let index = 0; index < text.length; index++) {
            const ch = text[index];
            if (!started) {
                if (/\s/.test(ch)) {
                    continue;
                }
                if (ch !== "{") {
                    return null;
                }
                started = true;
                startIndex = index;
                depth = 1;
                continue;
            }
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = !inString;
                continue;
            }
            if (inString) {
                continue;
            }
            if (ch === "{") {
                depth++;
            }
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    return {
                        json: text.slice(startIndex, index + 1),
                        remaining: text.slice(index + 1),
                    };
                }
            }
        }
        return null;
    }
    processLengthPrefixedBuffer() {
        if (this.buffer.length < 4) {
            return false;
        }
        const length = this.buffer.readUInt32BE(0);
        if (length <= 0 || length > MAX_RESPONSE_BYTES) {
            this.rejectPending(new Error(`Invalid revAgent response frame length: ${length}`));
            this.buffer = Buffer.alloc(0);
            return false;
        }
        if (this.buffer.length < 4 + length) {
            return false;
        }
        const payload = this.buffer.subarray(4, 4 + length);
        const responseData = payload.toString("utf8");
        try {
            const response = JSON.parse(responseData);
            this.handleResponseObject(response, responseData);
        }
        catch (error) {
            this.rejectPending(new Error(`Failed to parse revAgent response: ${error instanceof Error ? error.message : String(error)}`));
        }
        this.buffer = this.buffer.subarray(4 + length);
        return true;
    }
    handleResponseObject(response, responseData) {
        const hasId = response && response.id !== undefined && response.id !== null;
        const requestId = hasId ? String(response.id) : "default";
        const callback = this.responseCallbacks.get(requestId);
        if (callback) {
            callback(responseData);
            this.responseCallbacks.delete(requestId);
            return;
        }
        if (response && response.error && this.responseCallbacks.size === 1) {
            const pending = this.responseCallbacks.entries().next().value;
            if (pending) {
                const [pendingId, pendingCallback] = pending;
                pendingCallback(responseData);
                this.responseCallbacks.delete(pendingId);
            }
            return;
        }
        if (response && response.error && this.responseCallbacks.size > 1) {
            for (const [pendingId, pendingCallback] of this.responseCallbacks.entries()) {
                pendingCallback(responseData);
                this.responseCallbacks.delete(pendingId);
            }
        }
    }
    rejectPending(error) {
        for (const [requestId, callback] of this.responseCallbacks.entries()) {
            callback(JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
            this.responseCallbacks.delete(requestId);
        }
    }
    connect() {
        if (this.isConnected) {
            return true;
        }
        try {
            this.socket.connect(this.port, this.host);
            return true;
        }
        catch (error) {
            console.error("Failed to connect:", error);
            return false;
        }
    }
    disconnect() {
        this.socket.end();
        this.isConnected = false;
    }
    generateRequestId() {
        return Date.now().toString() + Math.random().toString().substring(2, 8);
    }
    async sendCommand(command, params = {}, options = {}) {
        if (command !== "mcp_status" && options.statusPreflight !== false) {
            await this.ensureReadyForCommand(command, options);
        }
        return await this.sendCommandRequest(command, params, options);
    }
    async ensureReadyForCommand(command, options = {}) {
        const statusTimeoutMs = options.statusTimeoutMs || Math.min(options.timeoutMs || 3000, 3000);
        const status = await this.sendCommandRequest("mcp_status", {}, {
            timeoutMs: statusTimeoutMs,
            statusPreflight: false,
        });
        const activeTask = status && typeof status === "object" ? status.activeTask : null;
        if (!activeTask) {
            return;
        }
        const taskName = activeTask.taskName || activeTask.method || "revAgent task";
        const elapsedText = typeof activeTask.elapsedMs === "number"
            ? `, elapsed ${this.formatElapsed(activeTask.elapsedMs)}`
            : "";
        throw new Error(`revAgent is busy with "${taskName}"${elapsedText}. Wait for it to finish before sending "${command}".`);
    }
    formatElapsed(elapsedMs) {
        const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds]
            .map((value) => String(value).padStart(2, "0"))
            .join(":");
    }
    async sendCommandRequest(command, params = {}, options = {}) {
        const framing = options.framing || this.framingMode;
        try {
            return await this.sendCommandRequestOnce(command, params, {
                ...options,
                framing,
            });
        }
        catch (error) {
            if (framing === "length-prefixed" && options.allowLegacyFallback !== false && this.isFramingFallbackError(error)) {
                this.framingMode = "legacy";
                return await this.sendCommandRequestOnce(command, params, {
                    ...options,
                    framing: "legacy",
                });
            }
            throw error;
        }
    }
    isFramingFallbackError(error) {
        const message = error instanceof Error ? error.message : String(error);
        return /Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(message);
    }
    sendCommandRequestOnce(command, params = {}, options = {}) {
        return new Promise((resolve, reject) => {
            let timeoutHandle;
            try {
                if (!this.isConnected) {
                    this.connect();
                }
                const requestId = this.generateRequestId();
                const commandObj = {
                    jsonrpc: "2.0",
                    method: command,
                    params,
                    id: requestId,
                };
                this.responseCallbacks.set(requestId, (responseData) => {
                    clearTimeout(timeoutHandle);
                    try {
                        const response = JSON.parse(responseData);
                        if (response.error) {
                            reject(new Error(response.error.message || "Unknown error from Revit"));
                        }
                        else {
                            resolve(response.result);
                        }
                    }
                    catch (error) {
                        if (error instanceof Error) {
                            reject(new Error(`Failed to parse response: ${error.message}`));
                        }
                        else {
                            reject(new Error(`Failed to parse response: ${String(error)}`));
                        }
                    }
                });
                this.writeCommand(commandObj, options.framing || this.framingMode);
                const timeoutMs = options.timeoutMs || 120000;
                timeoutHandle = setTimeout(() => {
                    if (this.responseCallbacks.has(requestId)) {
                        this.responseCallbacks.delete(requestId);
                        reject(new Error(`Command timed out after ${this.formatElapsed(timeoutMs)}: ${command}`));
                    }
                }, timeoutMs);
                if (typeof timeoutHandle.unref === "function") {
                    timeoutHandle.unref();
                }
            }
            catch (error) {
                clearTimeout(timeoutHandle);
                reject(error);
            }
        });
    }
    writeCommand(commandObj, framing) {
        const payload = Buffer.from(JSON.stringify(commandObj), "utf8");
        if (framing === "length-prefixed") {
            const header = Buffer.alloc(4);
            header.writeUInt32BE(payload.length, 0);
            this.socket.write(Buffer.concat([header, payload]));
            return;
        }
        this.socket.write(payload);
    }
}
