import { RevitClientConnection } from "./SocketClient.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOCK_DIR = path.join(os.tmpdir(), "revit-mcp-command.lock");
const LOCK_WAIT_MS = 8000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock() {
    try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        }
    }
    catch (error) {
        if (!error || error.code === "ENOENT") {
            return;
        }
    }
}

async function acquireRevitCommandLock() {
    const started = Date.now();
    while (true) {
        try {
            fs.mkdirSync(LOCK_DIR);
            fs.writeFileSync(path.join(LOCK_DIR, "owner.json"), JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
            }, null, 2));
            return () => {
                try {
                    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
                }
                catch {
                }
            };
        }
        catch (error) {
            if (!error || error.code !== "EEXIST") {
                throw error;
            }
            removeStaleLock();
            if (Date.now() - started >= LOCK_WAIT_MS) {
                throw new Error("Revit MCP is busy; a previous Revit command is still running. Refusing to send another request.");
            }
            await sleep(LOCK_POLL_MS);
        }
    }
}

/**
 * 连接到Revit客户端并执行操作
 * @param operation 连接成功后要执行的操作函数
 * @returns 操作的结果
 */
export async function withRevitConnection(operation) {
    const releaseLock = await acquireRevitCommandLock();
    const revitClient = new RevitClientConnection("localhost", 8080);
    try {
        // 连接到Revit客户端
        if (!revitClient.isConnected) {
            await new Promise((resolve, reject) => {
                const onConnect = () => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    resolve();
                };
                const onError = (error) => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    reject(new Error("connect to revit client failed"));
                };
                revitClient.socket.on("connect", onConnect);
                revitClient.socket.on("error", onError);
                revitClient.connect();
                setTimeout(() => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    reject(new Error("连接到Revit客户端失败"));
                }, 5000);
            });
        }
        // 执行操作
        return await operation(revitClient);
    }
    finally {
        // 断开连接
        revitClient.disconnect();
        releaseLock();
    }
}
