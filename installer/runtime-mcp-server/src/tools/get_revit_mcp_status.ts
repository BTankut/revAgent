import type { ToolServer } from "./types.js";
import path from "node:path";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    compactMcpStatusPayload,
    formatJsonContent,
    normalizeRevitExecutionResponse,
} from "../utils/revitToolHelpers.js";
import { getLiveRuntimeActivityStatus, recordLiveRevitStatus } from "../utils/telemetry.js";
import {
    getRuntimeRoot,
    parseBuildHash,
    readInstalledState,
    readJsonFile,
} from "../utils/runtimeIdentity.js";
import { getSpatialStoreCapability } from "../spatial/spatialStoreManager.js";

const RUNTIME_PROCESS_STARTED_AT_UTC = new Date().toISOString();
const STATUS_SCHEMA_VERSION = "revit-mcp-status.v3";
const TOOL_SURFACE_VERSION = "revit-mcp-runtime-tools.42";

function readPackageMetadata() {
    const packageJson = readJsonFile(path.join(getRuntimeRoot(), "package.json"));
    return {
        packageName: packageJson?.name || "revagent-runtime",
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

export function registerGetRevitMcpStatusTool(server: ToolServer) {
    server.tool("get_revit_mcp_status", "Read the revAgent task status without waiting behind the active Revit command lock. Includes runtime identity, the durable spatial-store/R*Tree capability state, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.", {
        ...connectionTargetSchema(z),
        includeRecentTasks: z.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),
        recentLimit: z.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),
        includeRuntimeActivity: z.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),
        runtimeActivityLimit: z.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),
        runtimeActivityMode: z.enum(["summary", "full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),
        includeDiagnostics: z.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),
        timeoutMs: z.number().int().positive().max(10000).optional().describe("Connection timeout in milliseconds. Defaults 3000."),
    }, async (args) => {
        const runtimeActivity = args.includeRuntimeActivity === false
            ? undefined
            : getLiveRuntimeActivityStatus(args.runtimeActivityLimit ?? 10, args.runtimeActivityMode || "summary");
        try {
            const timeoutMs = args.timeoutMs || 3000;
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
            }, {
                ...connectionOptionsFromArgs(args),
                skipLock: true,
                connectTimeoutMs: timeoutMs,
            });

            const compactStatus = compactMcpStatusPayload(
                normalizeRevitExecutionResponse(response),
                {
                    includeRecentTasks: args.includeRecentTasks,
                    recentLimit: args.recentLimit,
                    includeDiagnostics: args.includeDiagnostics,
                },
            );
            recordLiveRevitStatus(response);
            const statusPayload = compactStatus && typeof compactStatus === "object" && !Array.isArray(compactStatus)
                ? compactStatus
                : { status: compactStatus };
            return formatJsonContent({
                ...statusPayload,
                ...(runtimeActivity ? { runtimeActivity } : {}),
                spatialStore: getSpatialStoreCapability(),
                runtimeIdentity: getRuntimeIdentity(),
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                ...(runtimeActivity ? { runtimeActivity } : {}),
                spatialStore: getSpatialStoreCapability(),
                runtimeIdentity: getRuntimeIdentity(),
            });
        }
    });
}
