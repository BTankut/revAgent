import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { executeRevitCode } from "../../utils/revitToolHelpers.js";
import { checkSprinklerCoverage } from "./calculations.js";

export async function analyzeFireProtection({ includeRevitRead = true, officeStandards = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("fire", officeStandards);
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
        ],
        calculationExamples: {
            sprinklerCoverage: checkSprinklerCoverage({
                roomWidthM: 6,
                roomLengthM: 6,
                sprinklers: [{ x: 3, y: 3 }],
                maxSpacingM: officeStandards.fire?.sprinklerSpacingRules?.[0]?.maxSpacingM,
                maxCoverageM2: officeStandards.fire?.sprinklerSpacingRules?.[0]?.maxCoverageM2,
            }),
        },
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
