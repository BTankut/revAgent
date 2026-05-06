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
            // Wait for the rest of the JSON payload.
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

    sendCommand(command, params = {}, options = {}) {
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
                timeoutHandle = setTimeout(() => {
                    if (this.responseCallbacks.has(requestId)) {
                        this.responseCallbacks.delete(requestId);
                        reject(new Error(`Command timed out after 2 minutes: ${command}`));
                    }
                }, options.timeoutMs || 120000);
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
