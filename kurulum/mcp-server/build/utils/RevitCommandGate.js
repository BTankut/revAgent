import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCK_FILE = path.join(os.tmpdir(), "revit-mcp-command.lock");
const DEFAULT_WAIT_MS = 125000;
const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 250;

let inProcessQueue = Promise.resolve();

export async function runWithRevitCommandGate(metadata, operation, options = {}) {
    if (options.gate === false) {
        return await operation();
    }

    const run = async () => {
        const lock = await acquireRevitCommandLock(metadata, options);
        try {
            return await operation();
        }
        finally {
            releaseRevitCommandLock(lock);
        }
    };

    const queuedRun = inProcessQueue.then(run, run);
    inProcessQueue = queuedRun.catch(() => {});
    return await queuedRun;
}

export async function acquireRevitCommandLock(metadata = {}, options = {}) {
    const config = getCommandGateConfig(options);
    const startedAt = Date.now();
    const owner = {
        pid: process.pid,
        commandId: metadata.commandId || generateCommandId(metadata.command || "revit-command"),
        command: metadata.command || "unknown",
        planId: metadata.planId || null,
        mode: metadata.mode || null,
        startedAtUtc: new Date().toISOString(),
    };

    while (true) {
        try {
            const fd = fs.openSync(config.lockFile, "wx");
            try {
                fs.writeFileSync(fd, JSON.stringify(owner, null, 2));
            }
            finally {
                fs.closeSync(fd);
            }
            return { lockFile: config.lockFile, owner };
        }
        catch (error) {
            if (!error || error.code !== "EEXIST") {
                throw error;
            }
            removeStaleLock(config.lockFile, config.staleMs);
            if (Date.now() - startedAt >= config.waitMs) {
                const existing = readLockOwner(config.lockFile);
                const active = existing && existing.command
                    ? `${existing.command}${existing.planId ? ` planId=${existing.planId}` : ""}`
                    : "another Revit MCP command";
                throw new Error(`Revit MCP is busy running ${active}; refusing to send an overlapping request.`);
            }
            await sleep(config.pollMs);
        }
    }
}

export function releaseRevitCommandLock(lock) {
    if (!lock || !lock.lockFile) {
        return;
    }
    try {
        const existing = readLockOwner(lock.lockFile);
        if (!existing || existing.commandId === lock.owner.commandId) {
            fs.unlinkSync(lock.lockFile);
        }
    }
    catch (error) {
        if (!error || error.code !== "ENOENT") {
            throw error;
        }
    }
}

export function getCommandGateConfig(options = {}) {
    return {
        lockFile: options.lockFile || process.env.REVIT_MCP_COMMAND_LOCK_FILE || DEFAULT_LOCK_FILE,
        waitMs: positiveNumber(options.waitMs, process.env.REVIT_MCP_COMMAND_GATE_WAIT_MS, DEFAULT_WAIT_MS),
        staleMs: positiveNumber(options.staleMs, process.env.REVIT_MCP_COMMAND_LOCK_STALE_MS, DEFAULT_STALE_MS),
        pollMs: positiveNumber(options.pollMs, process.env.REVIT_MCP_COMMAND_LOCK_POLL_MS, DEFAULT_POLL_MS),
    };
}

export function readLockOwner(lockFile = getCommandGateConfig().lockFile) {
    try {
        return JSON.parse(fs.readFileSync(lockFile, "utf8"));
    }
    catch {
        return null;
    }
}

function removeStaleLock(lockFile, staleMs) {
    try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs >= staleMs) {
            fs.unlinkSync(lockFile);
        }
    }
    catch (error) {
        if (!error || error.code !== "ENOENT") {
            throw error;
        }
    }
}

function positiveNumber(primary, fallback, defaultValue) {
    const value = Number(primary ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function generateCommandId(command) {
    return `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
