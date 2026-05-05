import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { executeRevitCode } from "../../utils/revitToolHelpers.js";
import { buildFireProtectionPipeResizeProposal, calculateFireCabinetDemand, calculateFirePumpBasis, checkFireCabinetCoverage, checkSprinklerCoverage } from "./calculations.js";

export async function analyzeFireProtection({ includeRevitRead = true, officeStandards = {}, pipeSizingRequests = [] } = {}) {
    const missingStandards = missingStandardsForDiscipline("fire", officeStandards);
    const pipeSizingProposal = buildFireProtectionPipeResizeProposal({
        pipeSizingRequests,
        flowLpmPerCabinet: officeStandards.fire?.fireCabinetFlowLpm,
        simultaneousFireCabinetCount: officeStandards.fire?.simultaneousFireCabinetCount,
        maxVelocityMps: officeStandards.fire?.pipeVelocityLimitMps,
        maxPressureLossPaPerM: officeStandards.fire?.pipeFrictionLimitPaPerM,
        diametersMm: officeStandards.fire?.pipeDiametersMm,
    });
    const base = {
        discipline: "fire",
        engine: "fire-sprinkler-foundation",
        status: "foundation",
        requiresOfficeStandard: missingStandards.length > 0,
        missingStandards,
        assumptions: [
            "Sprinkler/fire hydraulic decisions are assumptions-only until the applicable office/fire code basis is supplied.",
        ],
        engineeringMethods: [
            "sprinkler collector",
            "rectangular room spacing/coverage screening",
            "fire cabinet hose reach screening",
            "fire cabinet demand basis",
            "fire pump flow/pressure basis",
            "resize_pipe write-plan proposal from fire pipe sizing requests",
        ],
        calculationExamples: {
            sprinklerCoverage: checkSprinklerCoverage({
                roomWidthM: 6,
                roomLengthM: 6,
                sprinklers: [{ x: 3, y: 3 }],
                maxSpacingM: officeStandards.fire?.sprinklerSpacingRules?.[0]?.maxSpacingM,
                maxCoverageM2: officeStandards.fire?.sprinklerSpacingRules?.[0]?.maxCoverageM2,
            }),
            fireCabinetCoverage: checkFireCabinetCoverage({
                cabinets: [{ x: 0, y: 0 }],
                targetPoints: [{ x: 15, y: 0 }],
                maxHoseReachM: officeStandards.fire?.fireCabinetMaxHoseReachM,
            }),
            fireCabinetDemand: calculateFireCabinetDemand({
                cabinetCount: 2,
                flowLpmPerCabinet: officeStandards.fire?.fireCabinetFlowLpm,
                simultaneousCabinetCount: officeStandards.fire?.simultaneousFireCabinetCount,
            }),
            firePumpBasis: calculateFirePumpBasis({
                cabinetDemand: calculateFireCabinetDemand({
                    cabinetCount: 2,
                    flowLpmPerCabinet: officeStandards.fire?.fireCabinetFlowLpm,
                    simultaneousCabinetCount: officeStandards.fire?.simultaneousFireCabinetCount,
                }),
                residualPressureBar: officeStandards.fire?.fireCabinetPressureBar,
                staticLiftM: 12,
                pipeLossKPa: 25,
                safetyFactor: 1.1,
            }),
        },
        ...(Array.isArray(pipeSizingRequests) && pipeSizingRequests.length > 0 ? { pipeSizingProposal } : {}),
        canCommit: false,
    };
    if (!includeRevitRead) return base;
    try {
        const response = await executeRevitCode(`
try
{
    int sprinklers = new FilteredElementCollector(document)
        .OfCategory(BuiltInCategory.OST_Sprinklers)
        .WhereElementIsNotElementType()
        .ToElementIds()
        .Count;
    int pipes = new FilteredElementCollector(document)
        .OfCategory(BuiltInCategory.OST_PipeCurves)
        .WhereElementIsNotElementType()
        .ToElementIds()
        .Count;
    return new { success = true, counts = new { sprinklers = sprinklers, pipes = pipes } };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`, { transactionMode: "none" });
        return { ...base, revitRead: response && response.result ? response.result : response };
    }
    catch (error) {
        return { ...base, warnings: [error instanceof Error ? error.message : String(error)] };
    }
}
