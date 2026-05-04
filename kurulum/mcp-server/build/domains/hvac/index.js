import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { executeRevitCode } from "../../utils/revitToolHelpers.js";

export async function analyzeHvacAirside({ includeRevitRead = true, officeStandards = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("hvac", officeStandards);
    const base = {
        discipline: "hvac",
        engine: "hvac-airside-foundation",
        status: "foundation",
        requiresOfficeStandard: missingStandards.length > 0,
        missingStandards,
        assumptions: [
            "Read-only collector and connector summary only; sizing remains a proposal until office friction and velocity standards are configured.",
        ],
        canCommit: false,
    };
    if (!includeRevitRead) {
        return base;
    }
    try {
        const response = await executeRevitCode(buildHvacReadCode(), { transactionMode: "none" });
        return {
            ...base,
            revitRead: response && response.result ? response.result : response,
        };
    }
    catch (error) {
        return {
            ...base,
            warnings: [error instanceof Error ? error.message : String(error)],
        };
    }
}

function buildHvacReadCode() {
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

double DuctLengthMeters()
{
    double total = 0.0;
    FilteredElementCollector collector = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();
    foreach (Element elem in collector.ToElements())
    {
        Parameter p = elem.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        if (p != null && p.HasValue)
        {
            total += UnitUtils.ConvertFromInternalUnits(p.AsDouble(), UnitTypeId.Meters);
        }
    }
    return total;
}

ConnectorSet ConnectorsFor(Element elem)
{
    Autodesk.Revit.DB.MEPCurve curve = elem as Autodesk.Revit.DB.MEPCurve;
    if (curve != null && curve.ConnectorManager != null) return curve.ConnectorManager.Connectors;
    FamilyInstance fi = elem as FamilyInstance;
    if (fi != null && fi.MEPModel != null && fi.MEPModel.ConnectorManager != null)
        return fi.MEPModel.ConnectorManager.Connectors;
    return null;
}

try
{
    int connectorCount = 0;
    int openConnectorCount = 0;
    System.Collections.Generic.Dictionary<string, int> systems = new System.Collections.Generic.Dictionary<string, int>();
    BuiltInCategory[] categories = new BuiltInCategory[] {
        BuiltInCategory.OST_DuctCurves,
        BuiltInCategory.OST_DuctFitting,
        BuiltInCategory.OST_DuctAccessory,
        BuiltInCategory.OST_DuctTerminal,
        BuiltInCategory.OST_MechanicalEquipment
    };
    foreach (BuiltInCategory category in categories)
    {
        FilteredElementCollector collector = new FilteredElementCollector(document)
            .OfCategory(category)
            .WhereElementIsNotElementType();
        foreach (Element elem in collector.ToElements())
        {
            Parameter systemName = elem.LookupParameter("System Name");
            string key = systemName != null && systemName.HasValue ? systemName.AsString() : "";
            if (string.IsNullOrEmpty(key)) key = "(unassigned)";
            if (!systems.ContainsKey(key)) systems[key] = 0;
            systems[key]++;
            ConnectorSet connectors = ConnectorsFor(elem);
            if (connectors == null) continue;
            foreach (Connector connector in connectors)
            {
                connectorCount++;
                if (!connector.IsConnected) openConnectorCount++;
            }
        }
    }
    return new {
        success = true,
        counts = new {
            ducts = CountCategory(BuiltInCategory.OST_DuctCurves),
            flexDucts = CountCategory(BuiltInCategory.OST_FlexDuctCurves),
            ductFittings = CountCategory(BuiltInCategory.OST_DuctFitting),
            ductAccessories = CountCategory(BuiltInCategory.OST_DuctAccessory),
            airTerminals = CountCategory(BuiltInCategory.OST_DuctTerminal),
            mechanicalEquipment = CountCategory(BuiltInCategory.OST_MechanicalEquipment)
        },
        ductLengthMeters = DuctLengthMeters(),
        connectorCount = connectorCount,
        openConnectorCount = openConnectorCount,
        systemElementCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
