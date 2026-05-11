// @ts-nocheck
import { RevitClientConnection } from "./SocketClient.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_HOST = process.env.REVIT_MCP_HOST || process.env.REVIT_HOST || "localhost";
const DEFAULT_PORT = parsePort(process.env.REVIT_MCP_PORT || process.env.REVIT_PORT, 8080);
const DEFAULT_REGISTRY_PATH = process.env.REVIT_MCP_INSTANCE_REGISTRY ||
    path.join(os.tmpdir(), "revit-mcp-instances.json");
const LOCK_ROOT = path.join(os.tmpdir(), "revit-mcp-command-locks");
const LOCK_WAIT_MS = 8000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePort(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const port = Number.parseInt(String(value), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid Revit MCP port: ${value}`);
    }
    return port;
}

function parsePortList(value) {
    if (!value) {
        return [];
    }
    const rawValues = Array.isArray(value) ? value : String(value).split(",");
    return rawValues
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => parsePort(item));
}

function normalizeHost(value) {
    return value ? String(value).trim() : DEFAULT_HOST;
}

function sanitizeLockPart(value) {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function lockDirForTarget(target) {
    return path.join(LOCK_ROOT, `${sanitizeLockPart(target.host)}-${target.port}.lock`);
}

function uniqueTargets(targets) {
    const seen = new Set();
    const output = [];
    for (const target of targets) {
        const host = normalizeHost(target.host);
        const port = parsePort(target.port);
        const key = `${host}:${port}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        output.push({
            ...target,
            host,
            port,
        });
    }
    return output;
}

function readRegistry() {
    try {
        if (!fs.existsSync(DEFAULT_REGISTRY_PATH)) {
            return [];
        }
        const parsed = JSON.parse(fs.readFileSync(DEFAULT_REGISTRY_PATH, "utf8"));
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (parsed && Array.isArray(parsed.instances)) {
            return parsed.instances;
        }
        if (parsed && parsed.targets && typeof parsed.targets === "object") {
            return Object.entries(parsed.targets).map(([name, value]) => ({
                ...(typeof value === "object" && value ? value : {}),
                name,
            }));
        }
    }
    catch {
    }
    return [];
}

function registryTargetMatches(entry, name) {
    const wanted = String(name).toLowerCase();
    const candidates = [
        entry.name,
        entry.id,
        entry.target,
        entry.pid,
        entry.title,
        entry.documentTitle,
        entry.path,
        entry.pathName,
    ].filter((value) => value !== undefined && value !== null);
    return candidates.some((value) => String(value).toLowerCase() === wanted);
}

function targetFromRegistry(name) {
    const entry = readRegistry().find((item) => registryTargetMatches(item, name));
    if (!entry) {
        return null;
    }
    return {
        name: entry.name || entry.id || String(name),
        host: normalizeHost(entry.host),
        port: parsePort(entry.port),
        source: "registry",
        metadata: entry,
    };
}

function targetFromString(value, fallbackHost) {
    const text = String(value || "").trim();
    if (!text) {
        return null;
    }
    if (/^\d+$/.test(text)) {
        return {
            host: normalizeHost(fallbackHost),
            port: parsePort(text),
            source: "target-port",
        };
    }
    const hostPort = text.match(/^(.+):(\d+)$/);
    if (hostPort) {
        return {
            host: normalizeHost(hostPort[1]),
            port: parsePort(hostPort[2]),
            source: "target-host-port",
        };
    }
    return null;
}

export function resolveRevitConnectionTarget(options = {}) {
    const fallbackHost = normalizeHost(options.host);
    const explicitPort = options.port !== undefined && options.port !== null
        ? parsePort(options.port)
        : null;
    if (explicitPort) {
        return {
            host: fallbackHost,
            port: explicitPort,
            source: "explicit",
        };
    }
    const requestedTarget = options.target || process.env.REVIT_MCP_TARGET;
    if (requestedTarget) {
        const parsedTarget = targetFromString(requestedTarget, fallbackHost);
        if (parsedTarget) {
            return parsedTarget;
        }
        const registryTarget = targetFromRegistry(requestedTarget);
        if (registryTarget) {
            return registryTarget;
        }
        throw new Error(`Unknown Revit MCP target '${requestedTarget}'. Use a port number, host:port, or a registered instance name.`);
    }
    return {
        host: fallbackHost,
        port: DEFAULT_PORT,
        source: "default",
    };
}

export function getCandidateRevitTargets(options = {}) {
    const host = normalizeHost(options.host);
    const targets = [];
    if (options.includeRegistry !== false) {
        for (const entry of readRegistry()) {
            if (entry.port) {
                targets.push({
                    name: entry.name || entry.id || entry.title || entry.documentTitle,
                    host: normalizeHost(entry.host),
                    port: parsePort(entry.port),
                    source: "registry",
                    metadata: entry,
                });
            }
        }
    }
    const explicitPorts = parsePortList(options.ports);
    const envPorts = parsePortList(process.env.REVIT_MCP_PORTS);
    const fallbackPorts = envPorts.length > 0
        ? envPorts
        : [DEFAULT_PORT, 8081, 8082, 8083, 8084, 8085];
    for (const port of explicitPorts.length > 0 ? explicitPorts : fallbackPorts) {
        targets.push({
            host,
            port,
            source: explicitPorts.length > 0 ? "explicit" : "scan",
        });
    }
    return uniqueTargets(targets);
}

function removeStaleLock(lockDir) {
    try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    }
    catch (error) {
        if (!error || error.code === "ENOENT") {
            return;
        }
    }
}

async function acquireRevitCommandLock(target, waitMs = LOCK_WAIT_MS) {
    const lockDir = lockDirForTarget(target);
    const started = Date.now();
    fs.mkdirSync(LOCK_ROOT, { recursive: true });
    while (true) {
        try {
            fs.mkdirSync(lockDir, { recursive: false });
            fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
                target,
            }, null, 2));
            return () => {
                try {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                }
                catch {
                }
            };
        }
        catch (error) {
            if (!error || error.code !== "EEXIST") {
                throw error;
            }
            removeStaleLock(lockDir);
            if (Date.now() - started >= waitMs) {
                throw new Error(`Revit MCP target ${target.host}:${target.port} is busy; a previous Revit command is still running. Refusing to send another request.`);
            }
            await sleep(LOCK_POLL_MS);
        }
    }
}

export async function withRevitConnection(operation, options = {}) {
    const target = resolveRevitConnectionTarget(options);
    const releaseLock = options.skipLock === true
        ? () => { }
        : await acquireRevitCommandLock(target, options.lockWaitMs || LOCK_WAIT_MS);
    const revitClient = new RevitClientConnection(target.host, target.port, {
        logErrors: options.logSocketErrors !== false,
    });
    try {
        if (!revitClient.isConnected) {
            await new Promise((resolve, reject) => {
                let timeoutHandle;
                const onConnect = () => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    clearTimeout(timeoutHandle);
                    resolve();
                };
                const onError = () => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    clearTimeout(timeoutHandle);
                    reject(new Error(`connect to Revit MCP target ${target.host}:${target.port} failed`));
                };
                revitClient.socket.on("connect", onConnect);
                revitClient.socket.on("error", onError);
                revitClient.connect();
                timeoutHandle = setTimeout(() => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    reject(new Error(`connect to Revit MCP target ${target.host}:${target.port} timed out`));
                }, options.connectTimeoutMs || 5000);
                if (typeof timeoutHandle.unref === "function") {
                    timeoutHandle.unref();
                }
            });
        }
        return await operation(revitClient, target);
    }
    finally {
        revitClient.disconnect();
        releaseLock();
    }
}
