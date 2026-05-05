import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { exampleHydronicTreeNetwork } from "../network/calculations.js";
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
            "element-to-element connector graph summary",
            "rooted tree branch flow aggregation",
            "critical circuit by accumulated edge loss",
            "pipe pressure loss by Darcy-Weisbach",
            "velocity/friction pipe sizing proposal",
        ],
        calculationExamples: {
            pipeSizing: sizePipeByVelocityOrFriction({
                flowLs: 1.0,
                maxVelocityMps: officeStandards.hydronic?.pipeVelocityLimitsMps?.main,
                maxPressureLossPaPerM: officeStandards.hydronic?.pipeFrictionLimitPaPerM,
            }),
            branchFlowAndCriticalPath: exampleHydronicTreeNetwork(),
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
    double totalLength = 0.0;
    System.Collections.Generic.Dictionary<string, int> systems = new System.Collections.Generic.Dictionary<string, int>();
    BuiltInCategory[] graphCategories = new BuiltInCategory[] {
        BuiltInCategory.OST_PipeCurves,
        BuiltInCategory.OST_FlexPipeCurves,
        BuiltInCategory.OST_PipeFitting,
        BuiltInCategory.OST_PipeAccessory,
        BuiltInCategory.OST_MechanicalEquipment
    };
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
        connectorGraph = ConnectorGraphSummary(graphCategories),
        systemPipeCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
