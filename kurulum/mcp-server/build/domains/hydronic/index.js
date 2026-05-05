import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { exampleHydronicFlowDirections, exampleHydronicTreeNetwork, exampleHydronicWeightedNetwork } from "../network/calculations.js";
import { summarizeLocalLossSamples } from "../local-losses/calculations.js";
import { buildLocalLossOnlyCode } from "../local-losses/revit-read.js";
import { csharpIntArray, executeRevitCode } from "../../utils/revitToolHelpers.js";
import { calibratePipeResistanceSamples, calculateHydronicBalance, calculatePumpHeadBasis, pipeResistanceCoefficient, sizePipeByVelocityOrFriction, solveHardyCrossLoop, solveHardyCrossNetwork } from "./calculations.js";

export async function analyzeHydronic({ includeRevitRead = true, officeStandards = {}, networkPathRequest = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("hydronic", officeStandards);
    const pumpHeadNetwork = examplePumpHeadNetwork();
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
            "weighted graph shortest path traversal",
            "least-loss flow direction inference",
            "rooted tree branch flow aggregation",
            "critical circuit by accumulated edge loss",
            "terminal balancing loss by critical-circuit equalization",
            "single-loop Hardy-Cross hydraulic balancing",
            "coupled multi-loop Hardy-Cross hydraulic balancing",
            "pump flow/head basis from critical circuit",
            "pipe pressure loss by Darcy-Weisbach",
            "velocity/friction pipe sizing proposal",
            "live pipe resistance coefficient calibration from Revit length/diameter samples",
            "live fitting/accessory/equipment local-loss parameter extraction",
        ],
        calculationExamples: {
            pipeSizing: sizePipeByVelocityOrFriction({
                flowLs: 1.0,
                maxVelocityMps: officeStandards.hydronic?.pipeVelocityLimitsMps?.main,
                maxPressureLossPaPerM: officeStandards.hydronic?.pipeFrictionLimitPaPerM,
            }),
            branchFlowAndCriticalPath: exampleHydronicTreeNetwork(),
            weightedPathfinding: exampleHydronicWeightedNetwork(),
            flowDirectionInference: exampleHydronicFlowDirections(),
            pumpHeadBasis: calculatePumpHeadBasis({
                network: pumpHeadNetwork,
                equipmentLossKPa: 12,
                terminalLossKPa: 8,
                safetyFactor: 1.1,
            }),
            hydraulicBalance: calculateHydronicBalance({
                network: {
                    rootNodeId: "pump",
                    nodes: ["pump", "riser", "coil-a", "coil-b"],
                    edges: [
                        { from: "pump", to: "riser", pressureLossPa: 1200 },
                        { from: "riser", to: "coil-a", pressureLossPa: 2400 },
                        { from: "riser", to: "coil-b", pressureLossPa: 3100 },
                    ],
                    terminalDemands: {
                        "coil-a": 0.35,
                        "coil-b": 0.42,
                    },
                },
                pumpHeadKPa: 30,
                terminalPressureAllowanceKPa: 8,
            }),
            hardyCrossLoop: solveHardyCrossLoop({
                loopEdges: [
                    { edgeId: "loop-a", resistancePaPerFlowN: 1, initialFlow: 1 },
                    { edgeId: "loop-b", resistancePaPerFlowN: 4, initialFlow: 1 },
                    { edgeId: "loop-c", resistancePaPerFlowN: 1, initialFlow: -1 },
                ],
                tolerancePa: 0.001,
                maxIterations: 25,
            }),
            hardyCrossNetwork: solveHardyCrossNetwork({
                edges: [
                    { edgeId: "e1", resistancePaPerFlowN: 1, initialFlow: 1 },
                    { edgeId: "e2", resistancePaPerFlowN: 3, initialFlow: 1 },
                    { edgeId: "e3", resistancePaPerFlowN: 2, initialFlow: -0.5 },
                    { edgeId: "e4", resistancePaPerFlowN: 4, initialFlow: 1 },
                    { edgeId: "e5", resistancePaPerFlowN: 1, initialFlow: -1 },
                ],
                loops: [
                    { loopId: "L1", edges: [{ edgeId: "e1", orientation: 1 }, { edgeId: "e2", orientation: 1 }, { edgeId: "e3", orientation: 1 }] },
                    { loopId: "L2", edges: [{ edgeId: "e3", orientation: -1 }, { edgeId: "e4", orientation: 1 }, { edgeId: "e5", orientation: 1 }] },
                ],
                tolerancePa: 0.001,
                maxIterations: 100,
            }),
            pipeResistanceCoefficient: pipeResistanceCoefficient({
                lengthM: 12,
                diameterMm: 50,
                referenceFlowLs: 1,
            }),
        },
        canCommit: false,
    };
    if (!includeRevitRead) return base;
    try {
        const response = await executeRevitCode(buildPipeReadCode(networkPathRequest), { transactionMode: "none" });
        const revitRead = response && response.result ? response.result : response;
        const resistanceCalibration = revitRead?.pipeResistanceSamples
            ? calibratePipeResistanceSamples({
                pipeSamples: revitRead.pipeResistanceSamples,
                referenceFlowLs: networkPathRequest.referenceFlowLs || 1,
            })
            : undefined;
        const localLossExtraction = revitRead?.localLossSamples
            ? summarizeLocalLossSamples({
                discipline: "hydronic",
                samples: revitRead.localLossSamples,
                sampleLimit: networkPathRequest.localLossSampleLimit,
            })
            : undefined;
        const liveLocalLossPumpHeadBasis = localLossExtraction
            ? calculatePumpHeadBasis({
                network: pumpHeadNetwork,
                equipmentLossKPa: 12,
                localLossPressurePa: localLossExtraction.pressureContribution.totalPressureDropPa,
                terminalLossKPa: 8,
                safetyFactor: 1.1,
            })
            : undefined;
        return {
            ...base,
            revitRead,
            ...(resistanceCalibration ? { resistanceCalibration } : {}),
            ...(localLossExtraction ? {
                localLossExtraction,
                liveLocalLossPumpHeadBasis,
                warnings: [...(base.warnings || []), ...(localLossExtraction.warnings || [])],
            } : {}),
        };
    }
    catch (error) {
        return { ...base, warnings: [error instanceof Error ? error.message : String(error)] };
    }
}

function examplePumpHeadNetwork() {
    return {
        rootNodeId: "pump",
        nodes: ["pump", "riser", "coil-a", "coil-b"],
        edges: [
            { from: "pump", to: "riser", pressureLossPa: 1200 },
            { from: "riser", to: "coil-a", pressureLossPa: 2400 },
            { from: "riser", to: "coil-b", pressureLossPa: 3100 },
        ],
        terminalDemands: {
            "coil-a": 0.35,
            "coil-b": 0.42,
        },
    };
}

function buildPipeReadCode(networkPathRequest = {}) {
    const rootElementId = Number.parseInt(String(networkPathRequest.rootElementId || 0), 10);
    const terminalElementIds = csharpIntArray(networkPathRequest.terminalElementIds || []);
    const includeConnectorGraph = networkPathRequest.includeConnectorGraph !== false ? "true" : "false";
    const networkPathfindingOnly = networkPathRequest.pathfindingOnly === true ? "true" : "false";
    if (networkPathRequest.localLossOnly === true) {
        const sampleLimit = Number.parseInt(String(networkPathRequest.localLossSampleLimit || 25), 10);
        return buildLocalLossOnlyCode({
            sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : 25,
            targetElementIds: networkPathRequest.localLossElementIds || [],
            categories: ["OST_PipeFitting", "OST_PipeAccessory", "OST_MechanicalEquipment"],
        });
    }
    if (networkPathRequest.hydraulicResistanceOnly === true) {
        const sampleLimit = Number.parseInt(String(networkPathRequest.sampleLimit || 25), 10);
        return buildHydronicResistanceOnlyCode(Number.isFinite(sampleLimit) ? sampleLimit : 25);
    }
    if (networkPathRequest.boqOnly === true) {
        return buildHydronicBoqOnlyCode();
    }
    if (networkPathRequest.pathfindingOnly === true) {
        return buildHydronicPathfindingOnlyCode(rootElementId, terminalElementIds);
    }
    return `
int networkRootElementId = ${Number.isFinite(rootElementId) ? rootElementId : 0};
int[] networkTerminalElementIds = ${terminalElementIds};
bool includeConnectorGraph = ${includeConnectorGraph};
bool networkPathfindingOnly = ${networkPathfindingOnly};

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

object ConnectorPathSummary(BuiltInCategory[] categories, int rootElementId, int[] terminalElementIds)
{
    if (rootElementId <= 0) return null;
    Element root = document.GetElement(new ElementId(rootElementId));
    if (root == null || !IsAllowedConnectorPathElement(root, categories) || ConnectorsFor(root) == null)
    {
        return new { success = false, error = "root element is not an allowed connector owner in this graph", rootElementId = rootElementId };
    }

    System.Collections.Generic.HashSet<int> requestedTerminals = new System.Collections.Generic.HashSet<int>();
    foreach (int terminalId in terminalElementIds)
    {
        if (terminalId > 0) requestedTerminals.Add(terminalId);
    }
    System.Collections.Generic.Dictionary<int, int> parent = new System.Collections.Generic.Dictionary<int, int>();
    System.Collections.Generic.Dictionary<int, int> hop = new System.Collections.Generic.Dictionary<int, int>();
    System.Collections.Generic.Dictionary<int, Element> elementsById = new System.Collections.Generic.Dictionary<int, Element>();
    System.Collections.Generic.Queue<int> queue = new System.Collections.Generic.Queue<int>();
    elementsById[rootElementId] = root;
    parent[rootElementId] = -1;
    hop[rootElementId] = 0;
    queue.Enqueue(rootElementId);
    int foundTerminalCount = requestedTerminals.Contains(rootElementId) ? 1 : 0;
    while (queue.Count > 0)
    {
        if (requestedTerminals.Count > 0 && foundTerminalCount >= requestedTerminals.Count) break;
        int current = queue.Dequeue();
        if (!elementsById.ContainsKey(current)) continue;
        ConnectorSet connectors = ConnectorsFor(elementsById[current]);
        if (connectors == null) continue;
        foreach (Connector connector in connectors)
        {
            try
            {
                ConnectorSet refs = connector.AllRefs;
                if (refs == null) continue;
                foreach (Connector other in refs)
                {
                    if (other == null || other.Owner == null) continue;
                    int next = other.Owner.Id.IntegerValue;
                    if (next == current || parent.ContainsKey(next)) continue;
                    if (!IsAllowedConnectorPathElement(other.Owner, categories) || ConnectorsFor(other.Owner) == null) continue;
                    elementsById[next] = other.Owner;
                    parent[next] = current;
                    hop[next] = hop[current] + 1;
                    if (requestedTerminals.Contains(next)) foundTerminalCount++;
                    queue.Enqueue(next);
                }
            }
            catch {}
        }
    }

    System.Collections.Generic.List<object> terminalPaths = new System.Collections.Generic.List<object>();
    int reachableTerminalCount = 0;
    foreach (int terminalId in terminalElementIds)
    {
        if (terminalId <= 0) continue;
        bool reachable = parent.ContainsKey(terminalId);
        if (reachable) reachableTerminalCount++;
        System.Collections.Generic.List<int> path = new System.Collections.Generic.List<int>();
        if (reachable)
        {
            int current = terminalId;
            int guard = 0;
            while (current > 0 && guard < 10000)
            {
                path.Add(current);
                if (current == rootElementId) break;
                current = parent[current];
                guard++;
            }
            path.Reverse();
        }
        terminalPaths.Add(new {
            elementId = terminalId,
            reachable = reachable,
            hopCount = reachable ? hop[terminalId] : -1,
            pathElementIds = path.ToArray()
        });
    }

    return new {
        success = true,
        method = "Read-only BFS over live Revit Connector.AllRefs element graph",
        rootElementId = rootElementId,
        requestedTerminalCount = terminalElementIds.Length,
        reachableTerminalCount = reachableTerminalCount,
        reachableNodeCount = parent.Count,
        terminalPaths = terminalPaths.ToArray(),
        canCommit = false
    };
}

bool IsAllowedConnectorPathElement(Element elem, BuiltInCategory[] categories)
{
    if (elem == null || elem.Category == null) return false;
    int categoryId = elem.Category.Id.IntegerValue;
    foreach (BuiltInCategory category in categories)
    {
        if (categoryId == (int)category) return true;
    }
    return false;
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
    if (networkPathfindingOnly)
    {
        return new {
            success = true,
            counts = (object)null,
            pipeLengthMeters = 0.0,
            connectorGraph = (object)null,
            connectorPathfinding = ConnectorPathSummary(graphCategories, networkRootElementId, networkTerminalElementIds),
            systemPipeCounts = new System.Collections.Generic.Dictionary<string, int>()
        };
    }
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
        connectorGraph = includeConnectorGraph ? ConnectorGraphSummary(graphCategories) : null,
        connectorPathfinding = ConnectorPathSummary(graphCategories, networkRootElementId, networkTerminalElementIds),
        systemPipeCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function buildHydronicBoqOnlyCode() {
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
        string key = SystemNameFor(elem);
        if (!systems.ContainsKey(key)) systems[key] = 0;
        systems[key]++;
    }
    return new {
        success = true,
        boqOnly = true,
        counts = new {
            pipes = CountCategory(BuiltInCategory.OST_PipeCurves),
            flexPipes = CountCategory(BuiltInCategory.OST_FlexPipeCurves),
            pipeFittings = CountCategory(BuiltInCategory.OST_PipeFitting),
            pipeAccessories = CountCategory(BuiltInCategory.OST_PipeAccessory),
            mechanicalEquipment = CountCategory(BuiltInCategory.OST_MechanicalEquipment)
        },
        pipeLengthMeters = totalLength,
        connectorGraph = (object)null,
        connectorPathfinding = (object)null,
        systemPipeCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function buildHydronicResistanceOnlyCode(sampleLimit) {
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(sampleLimit), 10) || 25));
    return `
double AsMeters(Parameter parameter)
{
    if (parameter == null || !parameter.HasValue) return 0.0;
    try { return UnitUtils.ConvertFromInternalUnits(parameter.AsDouble(), UnitTypeId.Meters); }
    catch { return 0.0; }
}

double AsMillimeters(Parameter parameter)
{
    if (parameter == null || !parameter.HasValue) return 0.0;
    try { return UnitUtils.ConvertFromInternalUnits(parameter.AsDouble(), UnitTypeId.Millimeters); }
    catch { return 0.0; }
}

double PipeDiameterMm(Element elem)
{
    try
    {
        Parameter p = elem.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
        double value = AsMillimeters(p);
        if (value > 0) return value;
    }
    catch {}
    try
    {
        Parameter p = elem.LookupParameter("Diameter");
        double value = AsMillimeters(p);
        if (value > 0) return value;
    }
    catch {}
    return 0.0;
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

try
{
    int sampleLimit = ${limit};
    int inspected = 0;
    System.Collections.Generic.List<object> samples = new System.Collections.Generic.List<object>();
    FilteredElementCollector collector = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
        .WhereElementIsNotElementType();
    foreach (Element elem in collector.ToElements())
    {
        inspected++;
        Parameter length = elem.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        double lengthM = AsMeters(length);
        double diameterMm = PipeDiameterMm(elem);
        if (lengthM <= 0 || diameterMm <= 0) continue;
        samples.Add(new {
            elementId = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            systemName = SystemNameFor(elem),
            lengthM = lengthM,
            diameterMm = diameterMm
        });
        if (samples.Count >= sampleLimit) break;
    }
    return new {
        success = true,
        hydraulicResistanceOnly = true,
        inspectedPipeCount = inspected,
        pipeResistanceSamples = samples.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function buildHydronicPathfindingOnlyCode(rootElementId, terminalElementIds) {
    return `
int networkRootElementId = ${Number.isFinite(rootElementId) ? rootElementId : 0};
int[] networkTerminalElementIds = ${terminalElementIds};

ConnectorSet ConnectorsFor(Element elem)
{
    Autodesk.Revit.DB.MEPCurve curve = elem as Autodesk.Revit.DB.MEPCurve;
    if (curve != null && curve.ConnectorManager != null) return curve.ConnectorManager.Connectors;
    FamilyInstance fi = elem as FamilyInstance;
    if (fi != null && fi.MEPModel != null && fi.MEPModel.ConnectorManager != null)
        return fi.MEPModel.ConnectorManager.Connectors;
    return null;
}

bool IsAllowedConnectorPathElement(Element elem, BuiltInCategory[] categories)
{
    if (elem == null || elem.Category == null) return false;
    int categoryId = elem.Category.Id.IntegerValue;
    foreach (BuiltInCategory category in categories)
    {
        if (categoryId == (int)category) return true;
    }
    return false;
}

object ConnectorPathSummary(BuiltInCategory[] categories, int rootElementId, int[] terminalElementIds)
{
    if (rootElementId <= 0) return null;
    Element root = document.GetElement(new ElementId(rootElementId));
    if (root == null || !IsAllowedConnectorPathElement(root, categories) || ConnectorsFor(root) == null)
    {
        return new { success = false, error = "root element is not an allowed connector owner in this graph", rootElementId = rootElementId };
    }

    System.Collections.Generic.HashSet<int> requestedTerminals = new System.Collections.Generic.HashSet<int>();
    foreach (int terminalId in terminalElementIds)
    {
        if (terminalId > 0) requestedTerminals.Add(terminalId);
    }
    System.Collections.Generic.Dictionary<int, int> parent = new System.Collections.Generic.Dictionary<int, int>();
    System.Collections.Generic.Dictionary<int, int> hop = new System.Collections.Generic.Dictionary<int, int>();
    System.Collections.Generic.Dictionary<int, Element> elementsById = new System.Collections.Generic.Dictionary<int, Element>();
    System.Collections.Generic.Queue<int> queue = new System.Collections.Generic.Queue<int>();
    elementsById[rootElementId] = root;
    parent[rootElementId] = -1;
    hop[rootElementId] = 0;
    queue.Enqueue(rootElementId);
    int foundTerminalCount = requestedTerminals.Contains(rootElementId) ? 1 : 0;
    while (queue.Count > 0)
    {
        if (requestedTerminals.Count > 0 && foundTerminalCount >= requestedTerminals.Count) break;
        int current = queue.Dequeue();
        if (!elementsById.ContainsKey(current)) continue;
        ConnectorSet connectors = ConnectorsFor(elementsById[current]);
        if (connectors == null) continue;
        foreach (Connector connector in connectors)
        {
            try
            {
                ConnectorSet refs = connector.AllRefs;
                if (refs == null) continue;
                foreach (Connector other in refs)
                {
                    if (other == null || other.Owner == null) continue;
                    int next = other.Owner.Id.IntegerValue;
                    if (next == current || parent.ContainsKey(next)) continue;
                    if (!IsAllowedConnectorPathElement(other.Owner, categories) || ConnectorsFor(other.Owner) == null) continue;
                    elementsById[next] = other.Owner;
                    parent[next] = current;
                    hop[next] = hop[current] + 1;
                    if (requestedTerminals.Contains(next)) foundTerminalCount++;
                    queue.Enqueue(next);
                }
            }
            catch {}
        }
    }

    System.Collections.Generic.List<object> terminalPaths = new System.Collections.Generic.List<object>();
    int reachableTerminalCount = 0;
    foreach (int terminalId in terminalElementIds)
    {
        if (terminalId <= 0) continue;
        bool reachable = parent.ContainsKey(terminalId);
        if (reachable) reachableTerminalCount++;
        System.Collections.Generic.List<int> path = new System.Collections.Generic.List<int>();
        if (reachable)
        {
            int current = terminalId;
            int guard = 0;
            while (current > 0 && guard < 10000)
            {
                path.Add(current);
                if (current == rootElementId) break;
                current = parent[current];
                guard++;
            }
            path.Reverse();
        }
        terminalPaths.Add(new {
            elementId = terminalId,
            reachable = reachable,
            hopCount = reachable ? hop[terminalId] : -1,
            pathElementIds = path.ToArray()
        });
    }

    return new {
        success = true,
        method = "Read-only BFS over live Revit Connector.AllRefs element graph",
        rootElementId = rootElementId,
        requestedTerminalCount = terminalElementIds.Length,
        reachableTerminalCount = reachableTerminalCount,
        reachableNodeCount = parent.Count,
        terminalPaths = terminalPaths.ToArray(),
        canCommit = false
    };
}

try
{
    BuiltInCategory[] graphCategories = new BuiltInCategory[] {
        BuiltInCategory.OST_PipeCurves,
        BuiltInCategory.OST_FlexPipeCurves,
        BuiltInCategory.OST_PipeFitting,
        BuiltInCategory.OST_PipeAccessory,
        BuiltInCategory.OST_MechanicalEquipment
    };
    return new {
        success = true,
        connectorGraph = (object)null,
        connectorPathfinding = ConnectorPathSummary(graphCategories, networkRootElementId, networkTerminalElementIds)
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
