import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function isTruthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}
export function readJsonFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return null;
    }
}
export function getRuntimeRoot() {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = path.dirname(thisFile);
    const candidates = [
        path.resolve(thisDir, "..", ".."),
        path.resolve(thisDir, ".."),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "package.json"))) {
            return candidate;
        }
    }
    return candidates[0];
}
export function getInstallRoot() {
    const runtimeRoot = getRuntimeRoot();
    const parent = path.dirname(runtimeRoot);
    return parent && parent !== runtimeRoot ? parent : runtimeRoot;
}
export function getProgramDataRoot() {
    return process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
}
export function readUpdaterConfig() {
    const installRoot = getInstallRoot();
    const candidates = [
        process.env.REVAGENT_UPDATER_CONFIG,
        path.join(installRoot, "updater", "updater-config.json"),
        path.join(getProgramDataRoot(), "DPE", "RevitMCP", "updater", "updater-config.json"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        const config = readJsonFile(candidate);
        if (config) {
            return config;
        }
    }
    return null;
}
export function readInstalledState(extraCandidates = []) {
    const installRoot = getInstallRoot();
    const candidates = [
        path.join(installRoot, "updater", "installed.json"),
        ...extraCandidates,
        path.join(getProgramDataRoot(), "DPE", "RevitMCP", "updater", "installed.json"),
    ];
    for (const candidate of candidates) {
        const state = readJsonFile(candidate);
        if (state) {
            return state;
        }
    }
    return null;
}
export function parseBuildHash(version) {
    const match = String(version || "").match(/-([0-9a-f]{7,40})$/i);
    return match ? match[1] : null;
}
export function defaultLocalTelemetryRoot() {
    return path.join(getProgramDataRoot(), "DPE", "RevitMCP", "state", "telemetry");
}
export function normalizeMachineName(value) {
    const text = String(value || "").trim();
    return (text || "unknown-machine").toUpperCase();
}
export function sanitizeTelemetryPathSegment(value, fallback = "unknown") {
    const text = String(value || "").trim();
    if (!text) {
        return fallback;
    }
    const safe = text
        .replace(/[<>:"/\\|?*\x00-\x1F\s]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "");
    return safe || fallback;
}
