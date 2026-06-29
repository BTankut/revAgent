import { RevitClientConnection } from "./SocketClient.js";
import { readEnv } from "./env.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type RegistryEntry = Record<string, any>;

interface RevitConnectionTarget extends RegistryEntry {
    host: string;
    port: number;
    source?: string;
    name?: string;
    metadata?: RegistryEntry;
}

interface RevitConnectionOptions {
    target?: string | number;
    host?: string;
    port?: string | number;
    ports?: string | Array<string | number>;
    includeRegistry?: boolean;
    skipLock?: boolean;
    lockWaitMs?: number;
    logSocketErrors?: boolean;
    connectTimeoutMs?: number;
    timeoutMs?: number;
}

type RevitConnectionOperation = (
    revitClient: RevitClientConnection,
    target: RevitConnectionTarget,
) => Promise<any> | any;

const DEFAULT_HOST = readEnv("REVAGENT_HOST", "REVIT_MCP_HOST", "REVIT_HOST") || "localhost";
const DEFAULT_PORT = parsePort(readEnv("REVAGENT_PORT", "REVIT_MCP_PORT", "REVIT_PORT"), 8080);
const DEFAULT_REGISTRY_PATH = readEnv("REVAGENT_INSTANCE_REGISTRY", "REVIT_MCP_INSTANCE_REGISTRY") ||
    path.join(os.tmpdir(), "revit-mcp-instances.json");
const LOCK_ROOT = path.join(os.tmpdir(), "revit-mcp-command-locks");
const LOCK_WAIT_MS = 8000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parsePort(value: unknown, fallback?: number): number {
    if (value === undefined || value === null || value === "") {
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error("Invalid revAgent port: empty value");
    }
    const port = Number.parseInt(String(value), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid revAgent port: ${value}`);
    }
    return port;
}

function parsePortList(value: unknown): number[] {
    if (!value) {
        return [];
    }
    const rawValues = Array.isArray(value) ? value : String(value).split(",");
    return rawValues
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => parsePort(item));
}

function normalizeHost(value: unknown): string {
    return value ? String(value).trim() : DEFAULT_HOST;
}

function sanitizeLockPart(value: unknown) {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function lockDirForTarget(target: RevitConnectionTarget) {
    return path.join(LOCK_ROOT, `${sanitizeLockPart(target.host)}-${target.port}.lock`);
}

function errorCode(error: unknown): string | null {
    return error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
}

function uniqueTargets(targets: RegistryEntry[]): RevitConnectionTarget[] {
    const seen = new Set<string>();
    const output: RevitConnectionTarget[] = [];
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

function readRegistry(): RegistryEntry[] {
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

function registryTargetMatches(entry: RegistryEntry, name: unknown) {
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

function targetFromRegistry(name: unknown): RevitConnectionTarget | null {
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

function targetFromString(value: unknown, fallbackHost: string): RevitConnectionTarget | null {
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

export function resolveRevitConnectionTarget(options: RevitConnectionOptions = {}): RevitConnectionTarget {
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
    const requestedTarget = options.target || readEnv("REVAGENT_TARGET", "REVIT_MCP_TARGET");
    if (requestedTarget) {
        const parsedTarget = targetFromString(requestedTarget, fallbackHost);
        if (parsedTarget) {
            return parsedTarget;
        }
        const registryTarget = targetFromRegistry(requestedTarget);
        if (registryTarget) {
            return registryTarget;
        }
        throw new Error(`Unknown revAgent target '${requestedTarget}'. Use a port number, host:port, or a registered instance name.`);
    }
    return {
        host: fallbackHost,
        port: DEFAULT_PORT,
        source: "default",
    };
}

export function getCandidateRevitTargets(options: RevitConnectionOptions = {}): RevitConnectionTarget[] {
    const host = normalizeHost(options.host);
    const targets: RevitConnectionTarget[] = [];
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
    const envPorts = parsePortList(readEnv("REVAGENT_PORTS", "REVIT_MCP_PORTS"));
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

function removeStaleLock(lockDir: string) {
    try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    }
    catch (error) {
        if (!error || errorCode(error) === "ENOENT") {
            return;
        }
    }
}

async function acquireRevitCommandLock(target: RevitConnectionTarget, waitMs = LOCK_WAIT_MS) {
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
            if (!error || errorCode(error) !== "EEXIST") {
                throw error;
            }
            removeStaleLock(lockDir);
            if (Date.now() - started >= waitMs) {
                throw new Error(`revAgent target ${target.host}:${target.port} is busy; a previous Revit command is still running. Refusing to send another request.`);
            }
            await sleep(LOCK_POLL_MS);
        }
    }
}

export async function withRevitConnection(operation: RevitConnectionOperation, options: RevitConnectionOptions = {}) {
    const target = resolveRevitConnectionTarget(options);
    const releaseLock = options.skipLock === true
        ? () => { }
        : await acquireRevitCommandLock(target, options.lockWaitMs || LOCK_WAIT_MS);
    const revitClient = new RevitClientConnection(target.host, target.port, {
        logErrors: options.logSocketErrors !== false,
    });
    try {
        if (!revitClient.isConnected) {
            await new Promise<void>((resolve, reject) => {
                let timeoutHandle: ReturnType<typeof setTimeout>;
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
                    reject(new Error(`connect to revAgent target ${target.host}:${target.port} failed`));
                };
                revitClient.socket.on("connect", onConnect);
                revitClient.socket.on("error", onError);
                revitClient.connect();
                timeoutHandle = setTimeout(() => {
                    revitClient.socket.removeListener("connect", onConnect);
                    revitClient.socket.removeListener("error", onError);
                    reject(new Error(`connect to revAgent target ${target.host}:${target.port} timed out`));
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
