import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    getCandidateRevitTargets,
    withRevitConnection,
} from "../utils/ConnectionManager.js";
import {
    compactMcpStatusPayload,
    formatJsonContent,
    normalizeRevitExecutionResponse,
} from "../utils/revitToolHelpers.js";

type JsonObject = Record<string, any>;

const INSTANCE_INFO_CODE = `
try
{
    System.Diagnostics.Process proc = System.Diagnostics.Process.GetCurrentProcess();
    View activeView = document.ActiveView;
    return new {
        success = true,
        process = new {
            id = proc.Id,
            startTime = proc.StartTime.ToString("o")
        },
        document = new {
            title = document.Title,
            pathName = document.PathName,
            isWorkshared = document.IsWorkshared,
            isReadOnly = document.IsReadOnly
        },
        apiProbeState = new {
            sampledInsideReadOnlyTool = true,
            documentIsModifiableDuringProbe = document.IsModifiable,
            meaning = "Internal Revit API state sampled while this read-only instance probe is executing. This is not the idle UI editability state.",
            currentUiStateSource = "Use get_ui_state.document.isModifiable on the target instance for the current idle UI document state."
        },
        activeView = new {
            id = activeView.Id.IntegerValue,
            name = activeView.Name,
            viewType = activeView.ViewType.ToString(),
            scale = activeView.Scale
        },
        revit = new {
            version = document.Application.VersionNumber,
            build = document.Application.VersionBuild
        }
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;

function payloadFromResponse(response: any) {
    const normalized = normalizeRevitExecutionResponse(response);
    if (normalized && typeof normalized === "object" && normalized.result) {
        return normalized.result;
    }
    return normalized;
}

async function probeTarget(target: JsonObject, timeoutMs: number) {
    let status: any = null;
    try {
        status = await withRevitConnection(async (revitClient) => {
            return await revitClient.sendCommand("mcp_status", {}, {
                timeoutMs,
                statusPreflight: false,
            });
        }, {
            host: target.host,
            port: target.port,
            connectTimeoutMs: timeoutMs,
            lockWaitMs: Math.max(timeoutMs, 500),
            logSocketErrors: false,
            skipLock: true,
        });
    }
    catch (error) {
        return {
            reachable: false,
            target: {
                name: target.name,
                host: target.host,
                port: target.port,
                source: target.source,
            },
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const infoTimeoutMs = Math.max(timeoutMs, 10000);
    try {
        const response = await withRevitConnection(async (revitClient, resolvedTarget) => {
            return await revitClient.sendCommand("send_code_to_revit", {
                code: INSTANCE_INFO_CODE,
                parameters: [`${resolvedTarget.host}:${resolvedTarget.port}`],
                transactionMode: "none",
                taskName: "Probe Revit instance",
            }, { timeoutMs: infoTimeoutMs });
        }, {
            host: target.host,
            port: target.port,
            connectTimeoutMs: timeoutMs,
            lockWaitMs: Math.max(infoTimeoutMs, 500),
            logSocketErrors: false,
        });
        return {
            reachable: true,
            target: {
                name: target.name,
                host: target.host,
                port: target.port,
                source: target.source,
            },
            status: compactMcpStatusPayload(status, {
                recentLimit: 3,
                includeDiagnostics: false,
            }),
            info: payloadFromResponse(response),
        };
    }
    catch (error) {
        return {
            reachable: true,
            target: {
                name: target.name,
                host: target.host,
                port: target.port,
                source: target.source,
            },
            status: compactMcpStatusPayload(status, {
                recentLimit: 3,
                includeDiagnostics: false,
            }),
            info: null as any,
            infoError: error instanceof Error ? error.message : String(error),
        };
    }
}

export function registerListRevitInstancesTool(server: ToolServer) {
    server.tool("list_revit_instances", "Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.", {
        host: z.string().optional().describe("Host to scan. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),
        ports: z.array(z.union([z.number(), z.string()])).optional().describe("Ports to scan. Defaults to REVAGENT_PORTS, then legacy REVIT_MCP_PORTS, or 8080-8085."),
        includeRegistry: z.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),
        includeUnreachable: z.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),
        timeoutMs: z.number().int().positive().max(15000).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000."),
    }, async (args) => {
        const timeoutMs = args.timeoutMs || 3000;
        const targets = getCandidateRevitTargets({
            host: args.host,
            ports: args.ports,
            includeRegistry: args.includeRegistry,
        });
        const results: JsonObject[] = [];
        for (const target of targets) {
            const result = await probeTarget(target, timeoutMs);
            if (result.reachable || args.includeUnreachable) {
                results.push(result);
            }
        }
        return formatJsonContent({
            success: true,
            count: results.filter((item) => item.reachable).length,
            scanned: targets.length,
            instances: results,
        });
    });
}
