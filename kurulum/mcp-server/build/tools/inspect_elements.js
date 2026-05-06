import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    csharpIntArray,
    csharpStringArray,
    executeRevitCode,
    formatJsonContent,
    getSelectionElementIds,
} from "../utils/revitToolHelpers.js";

async function resolveElementIds(args, connectionOptions) {
    const explicit = Array.isArray(args.elementIds) ? args.elementIds : [];
    let ids = explicit
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (args.useSelection) {
        ids = ids.concat(await getSelectionElementIds(args.limit || 20, connectionOptions));
    }
    return [...new Set(ids)].slice(0, args.limit || 20);
}

function buildInspectElementsCode(ids, args) {
    const idArray = csharpIntArray(ids);
    const includeParameters = args.includeParameters !== false ? "true" : "false";
    const includeTypeParameters = args.includeTypeParameters === true ? "true" : "false";
    const includeConnectors = args.includeConnectors !== false ? "true" : "false";
    const parameterNames = csharpStringArray(args.parameterNames || []);
    return `
int[] elementIds = ${idArray};
bool includeParameters = ${includeParameters};
bool includeTypeParameters = ${includeTypeParameters};
bool includeConnectors = ${includeConnectors};
string[] requestedParameterNames = ${parameterNames};

System.Collections.Generic.List<string> DefaultParameterNames()
{
    System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
    names.Add("System Name");
    names.Add("System Type");
    names.Add("System Classification");
    names.Add("Size");
    names.Add("Length");
    names.Add("Diameter");
    names.Add("Width");
    names.Add("Height");
    names.Add("Flow");
    names.Add("Mark");
    names.Add("Comments");
    return names;
}

string RawValue(Parameter p)
{
    if (p == null || !p.HasValue) return "";
    try
    {
        if (p.StorageType == StorageType.String) return p.AsString();
        if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.Double) return p.AsDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.ElementId) return p.AsElementId().IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

object ParameterSummary(Parameter p, string source)
{
    if (p == null) return null;
    string valueString = "";
    try { valueString = p.AsValueString(); } catch {}
    return new {
        source = source,
        name = p.Definition != null ? p.Definition.Name : "",
        storageType = p.StorageType.ToString(),
        hasValue = p.HasValue,
        isReadOnly = p.IsReadOnly,
        raw = RawValue(p),
        valueString = valueString
    };
}

string LevelName(Element elem)
{
    try
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct != null && duct.ReferenceLevel != null) return duct.ReferenceLevel.Name;
        Autodesk.Revit.DB.Plumbing.Pipe pipe = elem as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe != null && pipe.ReferenceLevel != null) return pipe.ReferenceLevel.Name;
        FamilyInstance fi = elem as FamilyInstance;
        if (fi != null && fi.LevelId != null && fi.LevelId != ElementId.InvalidElementId)
        {
            Element level = document.GetElement(fi.LevelId);
            if (level != null) return level.Name;
        }
        Parameter levelP = elem.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
        if (levelP != null && levelP.HasValue)
        {
            Element level = document.GetElement(levelP.AsElementId());
            if (level != null) return level.Name;
            string text = levelP.AsValueString();
            if (!string.IsNullOrEmpty(text)) return text;
        }
    }
    catch {}
    return "N/A";
}

ConnectorSet ConnectorSetFor(Element elem)
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
    System.Collections.Generic.List<object> elements = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<string> names = requestedParameterNames.Length > 0
        ? new System.Collections.Generic.List<string>(requestedParameterNames)
        : DefaultParameterNames();

    foreach (int id in elementIds)
    {
        Element elem = document.GetElement(new ElementId(id));
        if (elem == null)
        {
            warnings.Add("Element not found: " + id.ToString());
            continue;
        }

        string categoryName = elem.Category != null ? elem.Category.Name : "";
        string categoryId = elem.Category != null ? elem.Category.Id.IntegerValue.ToString() : "";
        string familyName = "";
        string typeName = "";
        Element typeElem = document.GetElement(elem.GetTypeId());
        if (typeElem != null) typeName = typeElem.Name;
        FamilyInstance fi = elem as FamilyInstance;
        if (fi != null && fi.Symbol != null)
        {
            typeName = fi.Symbol.Name;
            if (fi.Symbol.Family != null) familyName = fi.Symbol.Family.Name;
        }

        int connectorCount = 0;
        int openConnectorCount = 0;
        if (includeConnectors)
        {
            ConnectorSet connectors = ConnectorSetFor(elem);
            if (connectors != null)
            {
                foreach (Connector c in connectors)
                {
                    connectorCount++;
                    if (!c.IsConnected) openConnectorCount++;
                }
            }
        }

        System.Collections.Generic.List<object> parameterSummaries = new System.Collections.Generic.List<object>();
        if (includeParameters)
        {
            foreach (string parameterName in names)
            {
                Parameter p = elem.LookupParameter(parameterName);
                object summary = ParameterSummary(p, "instance");
                if (summary != null) parameterSummaries.Add(summary);
                if (includeTypeParameters && typeElem != null)
                {
                    Parameter tp = typeElem.LookupParameter(parameterName);
                    object typeSummary = ParameterSummary(tp, "type");
                    if (typeSummary != null) parameterSummaries.Add(typeSummary);
                }
            }
        }

        elements.Add(new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            name = elem.Name,
            category = categoryName,
            categoryId = categoryId,
            className = elem.GetType().FullName,
            familyName = familyName,
            typeName = typeName,
            levelName = LevelName(elem),
            connectorCount = connectorCount,
            openConnectorCount = openConnectorCount,
            parameters = parameterSummaries.ToArray()
        });
    }

    return new {
        success = true,
        elements = elements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

export function registerInspectElementsTool(server) {
    server.tool("inspect_elements", "Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.", {
        ...connectionTargetSchema(z),
        elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Element ids to inspect."),
        useSelection: z.boolean().optional().describe("When true, inspect the current Revit selection."),
        limit: z.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),
        includeParameters: z.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),
        includeTypeParameters: z.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),
        includeConnectors: z.boolean().optional().describe("Include connector counts when available. Defaults true."),
        parameterNames: z.array(z.string()).optional().describe("Optional targeted parameter names."),
    }, async (args) => {
        const connectionOptions = connectionOptionsFromArgs(args);
        try {
            const ids = await resolveElementIds(args, connectionOptions);
            if (ids.length === 0) {
                return formatJsonContent({
                    success: true,
                    elements: [],
                    warnings: ["No element ids supplied and no selected elements found."],
                });
            }
            const response = await executeRevitCode(buildInspectElementsCode(ids, args), {
                ...connectionOptions,
                transactionMode: "none",
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
