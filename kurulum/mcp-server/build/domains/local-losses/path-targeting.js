import { buildLocalLossOnlyCode } from "./revit-read.js";
import { connectorPathElementIds, selectCriticalConnectorPath } from "./calculations.js";

export async function readPathTargetedLocalLosses({
    pathCode,
    executeRevitCode,
    categories = [],
    sampleLimit = 25,
} = {}) {
    if (typeof executeRevitCode !== "function") {
        throw new Error("executeRevitCode function is required for path-targeted local-loss reads.");
    }
    const pathResponse = await executeRevitCode(pathCode, { transactionMode: "none" });
    const pathRead = unwrapRevitResult(pathResponse);
    const parsedSampleLimit = Number.parseInt(String(sampleLimit || 25), 10);
    const baseSampleLimit = Number.isFinite(parsedSampleLimit) ? parsedSampleLimit : 25;
    const candidateTargetElementIds = connectorPathElementIds({
        connectorPathfinding: pathRead?.connectorPathfinding,
    });
    const rankingSampleLimit = Math.max(baseSampleLimit, candidateTargetElementIds.length);
    const rankingLocalLossRead = candidateTargetElementIds.length > 0
        ? unwrapRevitResult(await executeRevitCode(buildLocalLossOnlyCode({
            sampleLimit: rankingSampleLimit,
            targetElementIds: candidateTargetElementIds,
            categories,
        }), { transactionMode: "none" }))
        : { localLossSamples: [] };
    const criticalPathSelection = selectCriticalConnectorPath({
        connectorPathfinding: pathRead?.connectorPathfinding,
        localLossSamples: rankingLocalLossRead?.localLossSamples || [],
    });
    const targetElementIds = criticalPathSelection.pathElementIds || [];
    const selectedSampleLimit = Math.max(baseSampleLimit, targetElementIds.length);
    const localLossRead = targetElementIds.length > 0
        ? unwrapRevitResult(await executeRevitCode(buildLocalLossOnlyCode({
            sampleLimit: selectedSampleLimit,
            targetElementIds,
            categories,
        }), { transactionMode: "none" }))
        : { localLossSamples: [] };
    const warnings = [
        ...targetedReadWarnings("Candidate path local-loss ranking read", rankingLocalLossRead),
        ...targetedReadWarnings("Selected path local-loss read", localLossRead),
    ];
    return {
        pathRead,
        candidateTargetElementIds,
        rankingLocalLossRead,
        criticalPathSelection,
        targetElementIds,
        localLossRead,
        localLossSamples: localLossRead?.localLossSamples || [],
        warnings,
    };
}

function unwrapRevitResult(response) {
    return response && response.result ? response.result : response;
}

function targetedReadWarnings(label, read) {
    if (!read?.truncatedBySampleLimit) return [];
    const uninspected = Number.isFinite(Number(read.uninspectedTargetCount))
        ? Number(read.uninspectedTargetCount)
        : undefined;
    const requested = Number.isFinite(Number(read.requestedTargetCount))
        ? Number(read.requestedTargetCount)
        : undefined;
    const suffix = [
        requested !== undefined ? `requested ${requested}` : "",
        uninspected !== undefined ? `uninspected ${uninspected}` : "",
    ].filter(Boolean).join(", ");
    return [`${label} was truncated by sample limit${suffix ? ` (${suffix})` : ""}.`];
}
