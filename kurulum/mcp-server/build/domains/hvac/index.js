import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { exampleAirsideTreeNetwork } from "../network/calculations.js";
import { executeRevitCode } from "../../utils/revitToolHelpers.js";
import { sizeRectangularDuctEqualFriction } from "./calculations.js";

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
        engineeringMethods: [
            "connector/open connector summary",
            "element-to-element connector graph summary",
            "rooted tree branch airflow aggregation",
            "critical path by accumulated edge loss",
            "duct friction loss by Darcy-Weisbach",
            "equal-friction rectangular duct sizing proposal",
        ],
        calculationExamples: {
            equalFrictionSizing: sizeRectangularDuctEqualFriction({
                flowM3h: 3600,
                targetPaPerM: officeStandards.hvac?.ductEqualFrictionTargetPaPerM,
                maxVelocityMps: officeStandards.hvac?.ductVelocityLimitsMps?.main,
            }),
            branchFlowAndCriticalPath: exampleAirsideTreeNetwork(),
        },
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

string SystemNameFor(Element elem)
{
    try
    {
        Parameter systemName = elem.LookupParameter("System Name");
        string key = systemName != null && systemName.HasValue ? systemName.AsString() : "";
        if (!string.IsNullOrEmpty(key)) return key;
    }
    catch {}
    return "(unassigned)";
}

object ConnectorGraphSummary(BuiltInCategory[] categories)
{
    System.Collections.Generic.List<Element> elements = new System.Collections.Generic.List<Element>();
    System.Collections.Generic.HashSet<int> elementIds = new System.Collections.Generic.HashSet<int>();
    System.Collections.Generic.HashSet<string> edges = new System.Collections.Generic.HashSet<string>();
    System.Collections.Generic.Dictionary<string, int> edgeCountsBySystem = new System.Collections.Generic.Dictionary<string, int>();
    System.Collections.Generic.List<object> openSamples = new System.Collections.Generic.List<object>();
    int connectorCount = 0;
    int openConnectorCount = 0;
    int connectorOwnerCount = 0;
    int allRefsErrors = 0;

    foreach (BuiltInCategory category in categories)
    {
        FilteredElementCollector collector = new FilteredElementCollector(document)
            .OfCategory(category)
            .WhereElementIsNotElementType();
        foreach (Element elem in collector.ToElements())
        {
            ConnectorSet connectors = ConnectorsFor(elem);
            if (connectors == null) continue;
            elements.Add(elem);
            elementIds.Add(elem.Id.IntegerValue);
            connectorOwnerCount++;
        }
    }

    foreach (Element elem in elements)
    {
        int ownerId = elem.Id.IntegerValue;
        string systemName = SystemNameFor(elem);
        ConnectorSet connectors = ConnectorsFor(elem);
        if (connectors == null) continue;
        foreach (Connector connector in connectors)
        {
            connectorCount++;
            bool isOpen = false;
            try { isOpen = !connector.IsConnected; } catch { isOpen = false; }
            if (isOpen)
            {
                openConnectorCount++;
                if (openSamples.Count < 25)
                {
                    string origin = "";
                    try
                    {
                        XYZ p = connector.Origin;
                        origin = string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0},{1},{2}", p.X, p.Y, p.Z);
                    }
                    catch {}
                    openSamples.Add(new {
                        elementId = ownerId,
                        category = elem.Category != null ? elem.Category.Name : "",
                        systemName = systemName,
                        origin = origin
                    });
                }
            }

            try
            {
                ConnectorSet refs = connector.AllRefs;
                if (refs == null) continue;
                foreach (Connector other in refs)
                {
                    if (other == null || other.Owner == null) continue;
                    int otherId = other.Owner.Id.IntegerValue;
                    if (otherId == ownerId || !elementIds.Contains(otherId)) continue;
                    int a = ownerId < otherId ? ownerId : otherId;
                    int b = ownerId < otherId ? otherId : ownerId;
                    string edgeKey = a.ToString() + ":" + b.ToString();
                    if (edges.Add(edgeKey))
                    {
                        if (!edgeCountsBySystem.ContainsKey(systemName)) edgeCountsBySystem[systemName] = 0;
                        edgeCountsBySystem[systemName]++;
                    }
                }
            }
            catch
            {
                allRefsErrors++;
            }
        }
    }

    return new {
        elementNodeCount = connectorOwnerCount,
        connectorCount = connectorCount,
        openConnectorCount = openConnectorCount,
        uniqueElementEdgeCount = edges.Count,
        edgeCountsBySystem = edgeCountsBySystem,
        openConnectorSamples = openSamples.ToArray(),
        allRefsErrors = allRefsErrors
    };
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
        connectorGraph = ConnectorGraphSummary(categories),
        systemElementCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
