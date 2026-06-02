import path from "node:path";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { connectionOptionsFromArgs, connectionTargetSchema, compactMcpStatusPayload, formatJsonContent, normalizeRevitExecutionResponse, } from "../utils/revitToolHelpers.js";
import { recordLiveRevitStatus } from "../utils/telemetry.js";
import { getRuntimeRoot, parseBuildHash, readInstalledState, readJsonFile, } from "../utils/runtimeIdentity.js";
const RUNTIME_PROCESS_STARTED_AT_UTC = new Date().toISOString();
const STATUS_SCHEMA_VERSION = "revit-mcp-status.v3";
const TOOL_SURFACE_VERSION = "revit-mcp-runtime-tools.32";
function readPackageMetadata() {
    const packageJson = readJsonFile(path.join(getRuntimeRoot(), "package.json"));
    return {
        packageName: packageJson?.name || "revit-mcp",
        packageVersion: packageJson?.version || "unknown",
    };
}
function getRuntimeIdentity() {
    const packageMetadata = readPackageMetadata();
    const installedState = readInstalledState([
        path.join(process.cwd(), "..", "updater", "installed.json"),
    ]);
    const runtimeVersion = installedState?.version || packageMetadata.packageVersion;
    return {
        runtimeVersion,
        schemaVersion: STATUS_SCHEMA_VERSION,
        toolSurfaceVersion: TOOL_SURFACE_VERSION,
        processStartedAtUtc: RUNTIME_PROCESS_STARTED_AT_UTC,
        buildTimestampUtc: installedState?.installedAtUtc || null,
        buildHash: parseBuildHash(runtimeVersion),
        packageName: packageMetadata.packageName,
        packageVersion: packageMetadata.packageVersion,
        nodeVersion: process.version,
    };
}
export function registerGetRevitMcpStatusTool(server) {
    server.tool("get_revit_mcp_status", "Read the Revit MCP task status without waiting behind the active Revit command lock. Includes runtimeVersion, schemaVersion, toolSurfaceVersion, processStartedAtUtc, buildTimestampUtc, buildHash, and bridge resultContractVersion when available so agents can verify the active runtime identity and bridge contract.", {
        ...connectionTargetSchema(z),
        includeRecentTasks: z.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),
        recentLimit: z.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),
        includeDiagnostics: z.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),
        timeoutMs: z.number().int().positive().max(10000).optional().describe("Connection timeout in milliseconds. Defaults 3000."),
    }, async (args) => {
        try {
            const timeoutMs = args.timeoutMs || 3000;
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
            }, {
                ...connectionOptionsFromArgs(args),
                skipLock: true,
                connectTimeoutMs: timeoutMs,
            });
            const compactStatus = compactMcpStatusPayload(normalizeRevitExecutionResponse(response), {
                includeRecentTasks: args.includeRecentTasks,
                recentLimit: args.recentLimit,
                includeDiagnostics: args.includeDiagnostics,
            });
            recordLiveRevitStatus(response);
            const statusPayload = compactStatus && typeof compactStatus === "object" && !Array.isArray(compactStatus)
                ? compactStatus
                : { status: compactStatus };
            return formatJsonContent({
                ...statusPayload,
                runtimeIdentity: getRuntimeIdentity(),
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                runtimeIdentity: getRuntimeIdentity(),
            });
        }
    });
}
