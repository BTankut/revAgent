import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { executeRevitCode } from "../../utils/revitToolHelpers.js";
import { sizePipeByVelocityOrFriction } from "./calculations.js";

export async function analyzeHydronic({ includeRevitRead = true, officeStandards = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("hydronic", officeStandards);
    const base = {
        discipline: "hydronic",
        engine: "hydronic-pipe-foundation",
        status: "foundation",
        requiresOfficeStandard: missingStandards.length > 0,
        missingStandards,
        assumptions: [
            "Read-only pipe network summary only; pressure loss and pump head are proposals until office pipe criteria are configured.",
        ],
        engineeringMethods: [
            "pipe system summary",
            "pipe pressure loss by Darcy-Weisbach",
            "velocity/friction pipe sizing proposal",
        ],
        calculationExamples: {
            pipeSizing: sizePipeByVelocityOrFriction({
                flowLs: 1.0,
                maxVelocityMps: officeStandards.hydronic?.pipeVelocityLimitsMps?.main,
                maxPressureLossPaPerM: officeStandards.hydronic?.pipeFrictionLimitPaPerM,
            }),
        },
        canCommit: false,
    };
    if (!includeRevitRead) return base;
    try {
        const response = await executeRevitCode(buildPipeReadCode(), { transactionMode: "none" });
        return { ...base, revitRead: response && response.result ? response.result : response };
    }
    catch (error) {
        return { ...base, warnings: [error instanceof Error ? error.message : String(error)] };
    }
}

function buildPipeReadCode() {
    return `
int CountCategory(BuiltInCategory category)
{
    try
    {
        return new FilteredElementCollector(document)
            .OfCategory(category)
            .WhereElementIsNotElementType()
            .ToElementIds()
            .Count;
    }
    catch { return -1; }
}

try
{
    double totalLength = 0.0;
    System.Collections.Generic.Dictionary<string, int> systems = new System.Collections.Generic.Dictionary<string, int>();
    FilteredElementCollector collector = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
        .WhereElementIsNotElementType();
    foreach (Element elem in collector.ToElements())
    {
        Parameter length = elem.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        if (length != null && length.HasValue)
            totalLength += UnitUtils.ConvertFromInternalUnits(length.AsDouble(), UnitTypeId.Meters);
        Parameter systemName = elem.LookupParameter("System Name");
        string key = systemName != null && systemName.HasValue ? systemName.AsString() : "";
        if (string.IsNullOrEmpty(key)) key = "(unassigned)";
        if (!systems.ContainsKey(key)) systems[key] = 0;
        systems[key]++;
    }
    return new {
        success = true,
        counts = new {
            pipes = CountCategory(BuiltInCategory.OST_PipeCurves),
            flexPipes = CountCategory(BuiltInCategory.OST_FlexPipeCurves),
            pipeFittings = CountCategory(BuiltInCategory.OST_PipeFitting),
            pipeAccessories = CountCategory(BuiltInCategory.OST_PipeAccessory),
            mechanicalEquipment = CountCategory(BuiltInCategory.OST_MechanicalEquipment)
        },
        pipeLengthMeters = totalLength,
        systemPipeCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
