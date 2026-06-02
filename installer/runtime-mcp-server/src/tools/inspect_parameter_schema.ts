import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    csharpIntArray,
    csharpString,
    csharpStringArray,
    executeRevitCode,
    executionOptionsFromArgs,
    formatJsonContent,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

function buildInspectParameterSchemaCode(args) {
    const explicitIds = csharpIntArray(args.elementIds || []);
    const category = csharpString(args.category || "");
    const sampleLimit = Number.isFinite(args.sampleLimit) ? Math.max(1, Math.min(25, args.sampleLimit)) : 5;
    const includeTypeParameters = args.includeTypeParameters === true ? "true" : "false";
    const filters = csharpStringArray(args.parameterNameFilter || []);
    const matchMode = args.parameterNameMatchMode === "exact" ? "exact" : "contains";
    return `
int[] explicitElementIds = ${explicitIds};
string categoryName = ${category};
int sampleLimit = ${sampleLimit};
bool includeTypeParameters = ${includeTypeParameters};
string[] parameterNameFilter = ${filters};
string parameterNameMatchMode = "${matchMode}";

bool ParameterNameMatches(string parameterName, string filter)
{
    if (parameterNameMatchMode == "exact")
        return string.Equals(parameterName, filter, StringComparison.OrdinalIgnoreCase);
    return parameterName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
}

bool IncludeParameter(Parameter p)
{
    if (p == null || p.Definition == null) return false;
    if (parameterNameFilter.Length == 0) return true;
    foreach (string filter in parameterNameFilter)
    {
        if (ParameterNameMatches(p.Definition.Name, filter)) return true;
    }
    return false;
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

object ParameterSchema(Parameter p, string source)
{
    string builtIn = "";
    int? builtInParameterId = null;
    string displayBuiltInParameter = "";
    string builtInParameterNote = "";
    bool isShared = false;
    string dataType = "";
    string unitType = "";
    string valueString = "";
    try
    {
        InternalDefinition idef = p.Definition as InternalDefinition;
        if (idef != null)
        {
            builtIn = idef.BuiltInParameter.ToString();
            builtInParameterId = (int)idef.BuiltInParameter;
            displayBuiltInParameter = builtIn;
        }
    }
    catch {}
    string parameterName = p.Definition != null ? p.Definition.Name : "";
    if (!string.IsNullOrWhiteSpace(builtIn))
    {
        if (string.Equals(parameterName, "Mark", StringComparison.OrdinalIgnoreCase))
        {
            displayBuiltInParameter = "ALL_MODEL_MARK";
        }
        else if (string.Equals(parameterName, "Type Mark", StringComparison.OrdinalIgnoreCase))
        {
            displayBuiltInParameter = "ALL_MODEL_TYPE_MARK";
        }

        string normalizedName = parameterName.Replace(" ", "_");
        if (!string.Equals(displayBuiltInParameter, builtIn, StringComparison.OrdinalIgnoreCase) ||
            (!string.IsNullOrWhiteSpace(normalizedName) &&
             builtIn.IndexOf(normalizedName, StringComparison.OrdinalIgnoreCase) < 0 &&
             displayBuiltInParameter.IndexOf(normalizedName, StringComparison.OrdinalIgnoreCase) < 0))
        {
            builtInParameterNote = "Revit BuiltInParameter enum names may stringify as aliases. Use builtInParameterId for exact API identity and displayBuiltInParameter for human review.";
        }
    }
    try { isShared = p.IsShared; } catch {}
    try { dataType = p.Definition.GetDataType().TypeId; } catch {}
    try { unitType = p.GetUnitTypeId().TypeId; } catch {}
    try { valueString = p.AsValueString(); } catch {}

    return new {
        source = source,
        name = parameterName,
        displayBuiltInParameter = displayBuiltInParameter,
        builtInParameter = displayBuiltInParameter,
        builtInParameterId = builtInParameterId,
        rawBuiltInParameterAlias = builtIn,
        builtInParameterNote = builtInParameterNote,
        storageType = p.StorageType.ToString(),
        hasValue = p.HasValue,
        isReadOnly = p.IsReadOnly,
        isShared = isShared,
        dataType = dataType,
        unitType = unitType,
        raw = RawValue(p),
        valueString = valueString
    };
}

void AddParameterSchemas(Element elem, string source, System.Collections.Generic.List<object> output)
{
    foreach (Parameter p in elem.Parameters)
    {
        if (!IncludeParameter(p)) continue;
        output.Add(ParameterSchema(p, source));
    }
}

try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<Element> samples = new System.Collections.Generic.List<Element>();

    foreach (int id in explicitElementIds)
    {
        if (samples.Count >= sampleLimit) break;
        Element elem = document.GetElement(new ElementId(id));
        if (elem != null) samples.Add(elem);
        else warnings.Add("Element not found: " + id.ToString());
    }

    if (samples.Count == 0 && !string.IsNullOrEmpty(categoryName))
    {
        try
        {
            BuiltInCategory bic = (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), categoryName);
            FilteredElementCollector col = new FilteredElementCollector(document)
                .OfCategory(bic)
                .WhereElementIsNotElementType();
            foreach (Element elem in col.ToElements())
            {
                if (samples.Count >= sampleLimit) break;
                samples.Add(elem);
            }
        }
        catch (Exception ex)
        {
            warnings.Add("Could not collect category " + categoryName + ": " + ex.Message);
        }
    }

    System.Collections.Generic.List<object> elements = new System.Collections.Generic.List<object>();
    foreach (Element elem in samples)
    {
        string category = elem.Category != null ? elem.Category.Name : "";
        string typeName = "";
        Element typeElem = document.GetElement(elem.GetTypeId());
        if (typeElem != null) typeName = typeElem.Name;

        System.Collections.Generic.List<object> parameterSchemas = new System.Collections.Generic.List<object>();
        AddParameterSchemas(elem, "instance", parameterSchemas);
        if (includeTypeParameters && typeElem != null)
        {
            AddParameterSchemas(typeElem, "type", parameterSchemas);
        }

        elements.Add(new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            category = category,
            className = elem.GetType().FullName,
            typeName = typeName,
            parameters = parameterSchemas.ToArray()
        });
    }

    return new {
        success = true,
        matchMode = parameterNameMatchMode,
        sampleCount = samples.Count,
        elements = elements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}

function summarizeParameterIdentity(parameter) {
    if (!parameter || typeof parameter !== "object") {
        return {};
    }
    return {
        source: parameter.source,
        displayBuiltInParameter: parameter.displayBuiltInParameter,
        builtInParameterId: parameter.builtInParameterId,
        rawBuiltInParameterAlias: parameter.rawBuiltInParameterAlias,
        storageType: parameter.storageType,
        isShared: parameter.isShared,
        isReadOnly: parameter.isReadOnly,
        dataType: parameter.dataType,
        unitType: parameter.unitType,
    };
}

function withDuplicateDisplayNameWarnings(payload, args) {
    if (args.parameterNameMatchMode !== "exact" ||
        !payload ||
        typeof payload !== "object" ||
        !Array.isArray(payload.elements)) {
        return payload;
    }

    const duplicateDisplayNameWarnings = [];
    const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];

    for (const element of payload.elements) {
        const parameters = Array.isArray(element?.parameters) ? element.parameters : [];
        const byDisplayName = new Map();
        for (const parameter of parameters) {
            const name = typeof parameter?.name === "string" ? parameter.name.trim() : "";
            if (!name) {
                continue;
            }
            const key = name.toLocaleLowerCase("en-US");
            if (!byDisplayName.has(key)) {
                byDisplayName.set(key, { name, matches: [] });
            }
            byDisplayName.get(key).matches.push(parameter);
        }

        for (const group of byDisplayName.values()) {
            if (group.matches.length < 2) {
                continue;
            }
            const warning = {
                elementId: element?.id,
                parameterName: group.name,
                count: group.matches.length,
                severity: "write_preflight_warning",
                message: `Duplicate display name '${group.name}' matched ${group.matches.length} parameters on element ${element?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,
                matches: group.matches.map(summarizeParameterIdentity),
            };
            duplicateDisplayNameWarnings.push(warning);
            warnings.push(`duplicate_display_name: elementId=${element?.id}; parameterName=${group.name}; count=${group.matches.length}; display name alone is ambiguous for write-back.`);
        }
    }

    if (duplicateDisplayNameWarnings.length === 0) {
        return payload;
    }

    return {
        ...payload,
        warnings,
        duplicateDisplayNameWarnings,
    };
}

export function registerInspectParameterSchemaTool(server: ToolServer) {
    server.tool("inspect_parameter_schema", "Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw and display values.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Element ids to inspect."),
        category: z.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),
        sampleLimit: z.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),
        includeTypeParameters: z.boolean().optional().describe("Include type parameters. Defaults false."),
        parameterNameFilter: z.array(z.string()).optional().describe("Optional parameter name filters."),
        parameterNameMatchMode: z.enum(["contains", "exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode."),
    }, async (args) => {
        if ((!args.elementIds || args.elementIds.length === 0) && !args.category) {
            return formatJsonContent({
                success: true,
                matchMode: args.parameterNameMatchMode === "exact" ? "exact" : "contains",
                sampleCount: 0,
                elements: [],
                warnings: ["Provide elementIds or category."],
            });
        }
        try {
            const response = await executeRevitCode(buildInspectParameterSchemaCode(args), {
                ...executionOptionsFromArgs(args, "Inspect Revit parameter schema"),
                transactionMode: "none",
            });
            const payload = response && response.result ? response.result : response;
            return formatJsonContent(withDuplicateDisplayNameWarnings(payload, args));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
