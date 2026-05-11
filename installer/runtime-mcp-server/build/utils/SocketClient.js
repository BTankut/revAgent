import * as net from "net";
export class RevitClientConnection {
    host;
    port;
    socket;
    logErrors;
    isConnected = false;
    responseCallbacks = new Map();
    buffer = "";
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
            this.buffer += data.toString();
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
        try {
            JSON.parse(this.buffer);
            this.handleResponse(this.buffer);
            this.buffer = "";
        }
        catch {
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
    handleResponse(responseData) {
        try {
            const response = JSON.parse(responseData);
            const requestId = response.id || "default";
            const callback = this.responseCallbacks.get(requestId);
            if (callback) {
                callback(responseData);
                this.responseCallbacks.delete(requestId);
            }
        }
        catch (error) {
            console.error("Error parsing response:", error);
        }
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
        const taskName = activeTask.taskName || activeTask.method || "Revit MCP task";
        const elapsedText = typeof activeTask.elapsedMs === "number"
            ? `, elapsed ${this.formatElapsed(activeTask.elapsedMs)}`
            : "";
        throw new Error(`Revit MCP is busy with "${taskName}"${elapsedText}. Wait for it to finish before sending "${command}".`);
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
    sendCommandRequest(command, params = {}, options = {}) {
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
                this.socket.write(JSON.stringify(commandObj));
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
}
