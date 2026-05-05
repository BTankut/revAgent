import { RevitClientConnection } from "./SocketClient.js";
import { runWithRevitCommandGate } from "./RevitCommandGate.js";

export async function withRevitConnection(operation, options = {}) {
    const metadata = {
        command: options.command || "unknown",
        commandId: options.commandId,
        planId: extractPlanId(options.params),
        mode: extractMode(options.params),
    };

    return await runWithRevitCommandGate(metadata, async () => {
        const revitClient = new RevitClientConnection("localhost", 8080);
        try {
            if (!revitClient.isConnected) {
                await waitForConnection(revitClient, options.connectTimeoutMs || 5000);
            }
            return await operation(revitClient);
        }
        finally {
            revitClient.disconnect();
        }
    }, options);
}

function waitForConnection(revitClient, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            revitClient.socket.removeListener("connect", onConnect);
            revitClient.socket.removeListener("error", onError);
        };
        const onConnect = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const onError = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("connect to revit client failed"));
        };

        revitClient.socket.on("connect", onConnect);
        revitClient.socket.on("error", onError);
        revitClient.connect();
        setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("connect to revit client timed out"));
        }, timeoutMs);
    });
}

function extractPlanId(params) {
    if (!params || typeof params !== "object") {
        return null;
    }
    if (params.plan && typeof params.plan === "object" && typeof params.plan.planId === "string") {
        return params.plan.planId;
    }
    return typeof params.planId === "string" ? params.planId : null;
}

function extractMode(params) {
    return params && typeof params === "object" && typeof params.mode === "string" ? params.mode : null;
}
