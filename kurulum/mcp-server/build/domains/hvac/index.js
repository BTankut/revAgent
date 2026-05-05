import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { exampleAirsideFlowDirections, exampleAirsideTreeNetwork, exampleAirsideWeightedNetwork } from "../network/calculations.js";
import { connectorPathElementIds, selectCriticalConnectorPath, summarizeLocalLossSamples } from "../local-losses/calculations.js";
import { buildLocalLossOnlyCode } from "../local-losses/revit-read.js";
import { csharpIntArray, executeRevitCode } from "../../utils/revitToolHelpers.js";
import { calculateFanPressureBasis, sizeRectangularDuctEqualFriction } from "./calculations.js";

export async function analyzeHvacAirside({ includeRevitRead = true, officeStandards = {}, networkPathRequest = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("hvac", officeStandards);
    const fanPressureNetwork = exampleFanPressureNetwork();
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
            "weighted graph shortest path traversal",
            "least-loss flow direction inference",
            "rooted tree branch airflow aggregation",
            "critical path by accumulated edge loss",
            "fan flow/pressure basis from critical path",
            "duct friction loss by Darcy-Weisbach",
            "equal-friction rectangular duct sizing proposal",
            "live fitting/accessory/equipment local-loss parameter extraction",
        ],
        calculationExamples: {
            equalFrictionSizing: sizeRectangularDuctEqualFriction({
                flowM3h: 3600,
                targetPaPerM: officeStandards.hvac?.ductEqualFrictionTargetPaPerM,
                maxVelocityMps: officeStandards.hvac?.ductVelocityLimitsMps?.main,
            }),
            branchFlowAndCriticalPath: exampleAirsideTreeNetwork(),
            weightedPathfinding: exampleAirsideWeightedNetwork(),
            flowDirectionInference: exampleAirsideFlowDirections(),
            fanPressureBasis: calculateFanPressureBasis({
                network: fanPressureNetwork,
                equipmentLossPa: 80,
                terminalAllowancePa: 40,
                safetyFactor: 1.1,
            }),
        },
        canCommit: false,
    };
    if (!includeRevitRead) {
        return base;
    }
    try {
        if (networkPathRequest.localLossFromNetworkPath === true) {
            const pathResponse = await executeRevitCode(buildHvacReadCode({
                ...networkPathRequest,
                pathfindingOnly: true,
                localLossOnly: false,
            }), { transactionMode: "none" });
            const pathRead = pathResponse && pathResponse.result ? pathResponse.result : pathResponse;
            const sampleLimit = Number.parseInt(String(networkPathRequest.localLossSampleLimit || 25), 10);
            const candidateTargetElementIds = connectorPathElementIds({
                connectorPathfinding: pathRead?.connectorPathfinding,
            });
            const rankingSampleLimit = Math.max(
                Number.isFinite(sampleLimit) ? sampleLimit : 25,
                candidateTargetElementIds.length,
            );
            const rankingLossResponse = candidateTargetElementIds.length > 0
                ? await executeRevitCode(buildLocalLossOnlyCode({
                    sampleLimit: rankingSampleLimit,
                    targetElementIds: candidateTargetElementIds,
                    categories: ["OST_DuctFitting", "OST_DuctAccessory", "OST_DuctTerminal", "OST_MechanicalEquipment"],
                }), { transactionMode: "none" })
                : { localLossSamples: [] };
            const rankingLocalLossRead = rankingLossResponse && rankingLossResponse.result ? rankingLossResponse.result : rankingLossResponse;
            const criticalPathSelection = selectCriticalConnectorPath({
                connectorPathfinding: pathRead?.connectorPathfinding,
                localLossSamples: rankingLocalLossRead?.localLossSamples || [],
            });
            const targetElementIds = criticalPathSelection.pathElementIds || [];
            const selectedSampleLimit = Math.max(
                Number.isFinite(sampleLimit) ? sampleLimit : 25,
                targetElementIds.length,
            );
            const lossResponse = targetElementIds.length > 0
                ? await executeRevitCode(buildLocalLossOnlyCode({
                    sampleLimit: selectedSampleLimit,
                    targetElementIds,
                    categories: ["OST_DuctFitting", "OST_DuctAccessory", "OST_DuctTerminal", "OST_MechanicalEquipment"],
                }), { transactionMode: "none" })
                : { localLossSamples: [] };
            const localLossRead = lossResponse && lossResponse.result ? lossResponse.result : lossResponse;
            const revitRead = {
                ...pathRead,
                localLossFromNetworkPath: true,
                localLossRankingRead: rankingLocalLossRead,
                localLossCandidateTargetElementIds: candidateTargetElementIds,
                criticalPathLocalLossTargetElementIds: targetElementIds,
                localLossRead,
                localLossSamples: localLossRead?.localLossSamples || [],
            };
            const localLossExtraction = summarizeLocalLossSamples({
                discipline: "hvac",
                samples: revitRead.localLossSamples,
                sampleLimit: networkPathRequest.localLossSampleLimit,
                criticalPathSelection,
            });
            const liveLocalLossFanPressureBasis = calculateFanPressureBasis({
                network: fanPressureNetwork,
                equipmentLossPa: 80,
                localLossPressurePa: localLossExtraction.pressureContribution.totalPressureDropPa,
                terminalAllowancePa: 40,
                safetyFactor: 1.1,
            });
            return {
                ...base,
                revitRead,
                localLossExtraction,
                liveLocalLossFanPressureBasis,
                warnings: [
                    ...(base.warnings || []),
                    ...(criticalPathSelection.warnings || []),
                    ...(localLossExtraction.warnings || []),
                ],
            };
        }
        const response = await executeRevitCode(buildHvacReadCode(networkPathRequest), { transactionMode: "none" });
        const revitRead = response && response.result ? response.result : response;
        const localLossExtraction = revitRead?.localLossSamples
            ? summarizeLocalLossSamples({
                discipline: "hvac",
                samples: revitRead.localLossSamples,
                sampleLimit: networkPathRequest.localLossSampleLimit,
            })
            : undefined;
        const liveLocalLossFanPressureBasis = localLossExtraction
            ? calculateFanPressureBasis({
                network: fanPressureNetwork,
                equipmentLossPa: 80,
                localLossPressurePa: localLossExtraction.pressureContribution.totalPressureDropPa,
                terminalAllowancePa: 40,
                safetyFactor: 1.1,
            })
            : undefined;
        return {
            ...base,
            revitRead,
            ...(localLossExtraction ? {
                localLossExtraction,
                liveLocalLossFanPressureBasis,
                warnings: [...(base.warnings || []), ...(localLossExtraction.warnings || [])],
            } : {}),
        };
    }
    catch (error) {
        return {
            ...base,
            warnings: [error instanceof Error ? error.message : String(error)],
        };
    }
}

function exampleFanPressureNetwork() {
    return {
        rootNodeId: "fan",
        nodes: ["fan", "main", "branch-a", "branch-b", "term-a", "term-b"],
        edges: [
            { from: "fan", to: "main", pressureLossPa: 35 },
            { from: "main", to: "branch-a", pressureLossPa: 18 },
            { from: "main", to: "branch-b", pressureLossPa: 22 },
            { from: "branch-a", to: "term-a", pressureLossPa: 40 },
            { from: "branch-b", to: "term-b", pressureLossPa: 55 },
        ],
        terminalDemands: {
            "term-a": 180,
            "term-b": 220,
        },
    };
}

function buildHvacReadCode(networkPathRequest = {}) {
    const rootElementId = Number.parseInt(String(networkPathRequest.rootElementId || 0), 10);
    const terminalElementIds = csharpIntArray(networkPathRequest.terminalElementIds || []);
    const includeConnectorGraph = networkPathRequest.includeConnectorGraph !== false ? "true" : "false";
    const networkPathfindingOnly = networkPathRequest.pathfindingOnly === true ? "true" : "false";
    if (networkPathRequest.localLossOnly === true) {
        const sampleLimit = Number.parseInt(String(networkPathRequest.localLossSampleLimit || 25), 10);
        return buildLocalLossOnlyCode({
            sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : 25,
            targetElementIds: networkPathRequest.localLossElementIds || [],
            categories: ["OST_DuctFitting", "OST_DuctAccessory", "OST_DuctTerminal", "OST_MechanicalEquipment"],
        });
    }
    if (networkPathRequest.boqOnly === true) {
        return buildHvacBoqOnlyCode();
    }
    if (networkPathRequest.pathfindingOnly === true) {
        return buildHvacPathfindingOnlyCode(rootElementId, terminalElementIds);
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
    if (networkPathfindingOnly)
    {
        return new {
            success = true,
            counts = (object)null,
            ductLengthMeters = 0.0,
            connectorCount = 0,
            openConnectorCount = 0,
            connectorGraph = (object)null,
            connectorPathfinding = ConnectorPathSummary(categories, networkRootElementId, networkTerminalElementIds),
            systemElementCounts = new System.Collections.Generic.Dictionary<string, int>()
        };
    }
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
        connectorGraph = includeConnectorGraph ? ConnectorGraphSummary(categories) : null,
        connectorPathfinding = ConnectorPathSummary(categories, networkRootElementId, networkTerminalElementIds),
        systemElementCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function buildHvacBoqOnlyCode() {
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
            string key = SystemNameFor(elem);
            if (!systems.ContainsKey(key)) systems[key] = 0;
            systems[key]++;
        }
    }
    return new {
        success = true,
        boqOnly = true,
        counts = new {
            ducts = CountCategory(BuiltInCategory.OST_DuctCurves),
            flexDucts = CountCategory(BuiltInCategory.OST_FlexDuctCurves),
            ductFittings = CountCategory(BuiltInCategory.OST_DuctFitting),
            ductAccessories = CountCategory(BuiltInCategory.OST_DuctAccessory),
            airTerminals = CountCategory(BuiltInCategory.OST_DuctTerminal),
            mechanicalEquipment = CountCategory(BuiltInCategory.OST_MechanicalEquipment)
        },
        ductLengthMeters = DuctLengthMeters(),
        connectorGraph = (object)null,
        connectorPathfinding = (object)null,
        systemElementCounts = systems
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function buildHvacPathfindingOnlyCode(rootElementId, terminalElementIds) {
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
    BuiltInCategory[] categories = new BuiltInCategory[] {
        BuiltInCategory.OST_DuctCurves,
        BuiltInCategory.OST_DuctFitting,
        BuiltInCategory.OST_DuctAccessory,
        BuiltInCategory.OST_DuctTerminal,
        BuiltInCategory.OST_MechanicalEquipment
    };
    return new {
        success = true,
        connectorGraph = (object)null,
        connectorPathfinding = ConnectorPathSummary(categories, networkRootElementId, networkTerminalElementIds)
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
