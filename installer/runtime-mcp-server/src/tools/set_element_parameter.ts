// @ts-nocheck
import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    csharpString,
    executeRevitCode,
    formatJsonContent,
    getSelectionElementIds,
    taskMetadataSchema,
    taskOptionsFromArgs,
} from "../utils/revitToolHelpers.js";

function valueToText(value) {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    return String(value ?? "");
}

async function resolveSingleElementId(args, connectionOptions) {
    if (args.elementId !== undefined && args.elementId !== null && String(args.elementId).trim() !== "") {
        const parsed = Number.parseInt(String(args.elementId), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (args.useSelection === true) {
        const selected = await getSelectionElementIds(2, connectionOptions);
        if (selected.length === 1) {
            return selected[0];
        }
        return {
            success: false,
            state: "guarded",
            guarded: true,
            guardReason: "single_selection_required",
            error: selected.length === 0
                ? "No selected Revit element was found. Provide elementId or select exactly one element."
                : "Multiple selected elements were found. Provide one explicit elementId for a production parameter write.",
            selectedElementIds: selected,
        };
    }
    return null;
}

function buildSetElementParameterCode(args, elementId) {
    const parameterName = csharpString(args.parameterName || "");
    const parameterSource = csharpString(args.parameterSource || "instance");
    const valueText = csharpString(valueToText(args.value));
    const valueMode = csharpString(args.valueMode || "raw");
    const mode = csharpString(args.mode === "commit" ? "commit" : "dryRun");
    const builtInParameterId = Number.isInteger(args.builtInParameterId)
        ? String(args.builtInParameterId)
        : "null";
    const expectedStorageType = csharpString(args.expectedStorageType || "");
    const expectedCurrentRaw = csharpString(args.expectedCurrentRaw === undefined || args.expectedCurrentRaw === null ? "" : valueToText(args.expectedCurrentRaw));
    const hasExpectedCurrentRaw = args.expectedCurrentRaw === undefined || args.expectedCurrentRaw === null ? "false" : "true";
    const allowTypeParameterWrite = args.allowTypeParameterWrite === true ? "true" : "false";
    return `
int elementId = ${elementId};
string parameterName = ${parameterName};
string parameterSource = ${parameterSource};
string requestedValueText = ${valueText};
string valueMode = ${valueMode};
string mode = ${mode};
int? expectedBuiltInParameterId = ${builtInParameterId};
string expectedStorageType = ${expectedStorageType};
bool hasExpectedCurrentRaw = ${hasExpectedCurrentRaw};
string expectedCurrentRaw = ${expectedCurrentRaw};
bool allowTypeParameterWrite = ${allowTypeParameterWrite};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);

string RawValue(Parameter p)
{
    if (p == null || !p.HasValue) return "";
    try
    {
        if (p.StorageType == StorageType.String) return p.AsString() ?? "";
        if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.Double) return p.AsDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.ElementId) return p.AsElementId().IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

string ValueString(Parameter p)
{
    try { return p.AsValueString() ?? ""; } catch { return ""; }
}

int? BuiltInId(Parameter p)
{
    try
    {
        InternalDefinition idef = p.Definition as InternalDefinition;
        if (idef == null) return null;
        int id = (int)idef.BuiltInParameter;
        return id == -1 ? (int?)null : id;
    }
    catch { return null; }
}

string SharedGuid(Parameter p)
{
    try
    {
        if (!p.IsShared) return "";
        ExternalDefinition externalDefinition = p.Definition as ExternalDefinition;
        if (externalDefinition != null) return externalDefinition.GUID.ToString();
    }
    catch {}
    return "";
}

int? ReflectedParameterElementId(Parameter p)
{
    try
    {
        System.Reflection.PropertyInfo prop = p.GetType().GetProperty("Id");
        if (prop == null) return null;
        ElementId id = prop.GetValue(p, null) as ElementId;
        if (id == null || id == ElementId.InvalidElementId) return null;
        return id.IntegerValue;
    }
    catch { return null; }
}

object ParameterIdentity(Parameter p, string source)
{
    string name = p.Definition != null ? p.Definition.Name : "";
    string valueString = ValueString(p);
    string dataType = "";
    string unitType = "";
    bool isShared = false;
    try { dataType = p.Definition.GetDataType().TypeId; } catch {}
    try { unitType = p.GetUnitTypeId().TypeId; } catch {}
    try { isShared = p.IsShared; } catch {}
    int? builtInId = BuiltInId(p);
    return new {
        source = source,
        name = name,
        storageType = p.StorageType.ToString(),
        isReadOnly = p.IsReadOnly,
        isShared = isShared,
        sharedGuid = SharedGuid(p),
        builtInParameterId = builtInId,
        parameterElementId = ReflectedParameterElementId(p),
        dataType = dataType,
        unitType = unitType,
        hasValue = p.HasValue,
        raw = RawValue(p),
        valueString = valueString
    };
}

System.Collections.Generic.List<Parameter> ExactDisplayNameMatches(Element owner)
{
    System.Collections.Generic.List<Parameter> matches = new System.Collections.Generic.List<Parameter>();
    foreach (Parameter p in owner.Parameters)
    {
        if (p == null || p.Definition == null) continue;
        if (string.Equals(p.Definition.Name, parameterName, StringComparison.OrdinalIgnoreCase))
        {
            matches.Add(p);
        }
    }
    return matches;
}

bool TryParseInteger(string text, out int value)
{
    if (string.Equals(text, "true", StringComparison.OrdinalIgnoreCase))
    {
        value = 1;
        return true;
    }
    if (string.Equals(text, "false", StringComparison.OrdinalIgnoreCase))
    {
        value = 0;
        return true;
    }
    return int.TryParse(text, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out value);
}

string ExpectedRawAfterSet(Parameter p)
{
    if (p.StorageType == StorageType.String) return requestedValueText;
    if (p.StorageType == StorageType.Integer)
    {
        int intValue;
        if (!TryParseInteger(requestedValueText, out intValue))
            throw new Exception("Requested value cannot be parsed as an integer parameter value.");
        return intValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    if (p.StorageType == StorageType.Double)
    {
        if (string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase))
            return null;
        double doubleValue;
        if (!double.TryParse(requestedValueText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out doubleValue))
            throw new Exception("Requested value cannot be parsed as a raw internal Revit double.");
        return doubleValue.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    }
    if (p.StorageType == StorageType.ElementId)
    {
        int idValue;
        if (!TryParseInteger(requestedValueText, out idValue))
            throw new Exception("Requested value cannot be parsed as an ElementId integer.");
        return idValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    throw new Exception("Unsupported parameter storage type: " + p.StorageType.ToString());
}

bool SetParameterValue(Parameter p)
{
    if (p.StorageType == StorageType.String)
    {
        return p.Set(requestedValueText);
    }
    if (p.StorageType == StorageType.Integer)
    {
        int intValue;
        if (!TryParseInteger(requestedValueText, out intValue))
            throw new Exception("Requested value cannot be parsed as an integer parameter value.");
        return p.Set(intValue);
    }
    if (p.StorageType == StorageType.Double)
    {
        if (string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase))
        {
            return p.SetValueString(requestedValueText);
        }
        double doubleValue;
        if (!double.TryParse(requestedValueText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out doubleValue))
            throw new Exception("Requested value cannot be parsed as a raw internal Revit double.");
        return p.Set(doubleValue);
    }
    if (p.StorageType == StorageType.ElementId)
    {
        int idValue;
        if (!TryParseInteger(requestedValueText, out idValue))
            throw new Exception("Requested value cannot be parsed as an ElementId integer.");
        return p.Set(new ElementId(idValue));
    }
    throw new Exception("Unsupported parameter storage type: " + p.StorageType.ToString());
}

object Blocked(string reason, string message, object extra = null)
{
    return new {
        success = false,
        state = "guarded",
        guarded = true,
        guardReason = reason,
        error = message,
        tool = "set_element_parameter",
        mode = mode,
        preflight = new {
            requiredPreflight = "inspect_parameter_schema exact identity resolution",
            blockedBeforeWrite = true
        },
        details = extra
    };
}

try
{
    if (string.IsNullOrWhiteSpace(parameterName))
    {
        return Blocked("parameter_name_required", "parameterName is required for exact schema preflight.");
    }
    if (expectedBuiltInParameterId.HasValue && expectedBuiltInParameterId.Value == -1)
    {
        return Blocked("invalid_builtin_parameter_id", "builtInParameterId=-1 is not a stable write identity.");
    }

    Element elem = document.GetElement(new ElementId(elementId));
    if (elem == null)
    {
        return Blocked("element_not_found", "Element was not found: " + elementId.ToString());
    }

    string normalizedSource = string.Equals(parameterSource, "type", StringComparison.OrdinalIgnoreCase) ? "type" : "instance";
    Element owner = elem;
    if (normalizedSource == "type")
    {
        owner = document.GetElement(elem.GetTypeId());
        if (owner == null)
        {
            return Blocked("type_element_not_found", "The element does not have a writable type element.");
        }
        if (!dryRun && !allowTypeParameterWrite)
        {
            return Blocked(
                "type_parameter_write_requires_allowTypeParameterWrite",
                "Type parameter writes can affect every instance using this type. Set allowTypeParameterWrite=true to commit intentionally.",
                new { elementId = elementId, typeId = owner.Id.IntegerValue });
        }
    }

    System.Collections.Generic.List<Parameter> displayMatches = ExactDisplayNameMatches(owner);
    if (displayMatches.Count == 0)
    {
        return Blocked("parameter_not_found", "No exact parameter display-name match was found on the selected " + normalizedSource + " owner.");
    }
    if (displayMatches.Count > 1)
    {
        return Blocked(
            "duplicate_display_name_blocked",
            "Duplicate parameter display names were found. Display name alone is ambiguous and this tool will not write until the schema is made unambiguous.",
            new {
                elementId = elementId,
                ownerId = owner.Id.IntegerValue,
                parameterName = parameterName,
                matches = displayMatches.Select(p => ParameterIdentity(p, normalizedSource)).ToArray()
            });
    }

    Parameter target = displayMatches[0];
    int? targetBuiltInId = BuiltInId(target);
    if (expectedBuiltInParameterId.HasValue && targetBuiltInId != expectedBuiltInParameterId.Value)
    {
        return Blocked(
            "builtin_parameter_identity_mismatch",
            "The exact display-name match does not have the requested builtInParameterId.",
            new { requestedBuiltInParameterId = expectedBuiltInParameterId.Value, actualBuiltInParameterId = targetBuiltInId });
    }

    if (!string.IsNullOrWhiteSpace(expectedStorageType) &&
        !string.Equals(target.StorageType.ToString(), expectedStorageType, StringComparison.OrdinalIgnoreCase))
    {
        return Blocked(
            "storage_type_mismatch",
            "The resolved parameter storage type does not match expectedStorageType.",
            new { expectedStorageType = expectedStorageType, actualStorageType = target.StorageType.ToString() });
    }

    object before = ParameterIdentity(target, normalizedSource);
    string beforeRaw = RawValue(target);
    string beforeValueString = ValueString(target);

    if (hasExpectedCurrentRaw && !string.Equals(beforeRaw, expectedCurrentRaw, StringComparison.Ordinal))
    {
        return Blocked(
            "expected_current_raw_mismatch",
            "The current raw parameter value does not match expectedCurrentRaw. Re-inspect before writing.",
            new { expectedCurrentRaw = expectedCurrentRaw, actualCurrentRaw = beforeRaw });
    }

    if (target.IsReadOnly)
    {
        return Blocked(
            "read_only_parameter_blocked",
            "The resolved parameter is read-only and cannot be written.",
            new { parameter = before });
    }

    string expectedRaw = ExpectedRawAfterSet(target);
    string valueSetApi = target.StorageType == StorageType.Double && string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase)
        ? "SetValueString"
        : "Set";

    if (dryRun)
    {
        return new {
            success = true,
            state = "dry_run",
            committed = false,
            tool = "set_element_parameter",
            revitWriteAction = "element_parameter",
            mode = mode,
            element = new {
                id = elem.Id.IntegerValue,
                uniqueId = elem.UniqueId,
                category = elem.Category != null ? elem.Category.Name : "",
                name = elem.Name
            },
            owner = new {
                source = normalizedSource,
                id = owner.Id.IntegerValue,
                name = owner.Name
            },
            preflight = new {
                requiredPreflight = "inspect_parameter_schema exact identity resolution",
                exactDisplayNameMatchCount = displayMatches.Count,
                duplicateDisplayNamesBlocked = false,
                readOnlyBlocked = false
            },
            parameter = before,
            requested = new {
                value = requestedValueText,
                valueMode = valueMode,
                expectedRawAfterSet = expectedRaw,
                valueSetApi = valueSetApi
            },
            before = before,
            verification = new {
                wouldVerifyAfterWrite = true,
                verificationMode = expectedRaw == null ? "SetValueString readback" : "raw readback"
            },
            warnings = new string[] {}
        };
    }

    bool setSucceeded = SetParameterValue(target);
    document.Regenerate();
    string afterRaw = RawValue(target);
    string afterValueString = ValueString(target);
    object after = ParameterIdentity(target, normalizedSource);
    bool rawVerified = expectedRaw == null
        ? setSucceeded && (!string.Equals(beforeRaw, afterRaw, StringComparison.Ordinal) || string.Equals(beforeValueString, afterValueString, StringComparison.OrdinalIgnoreCase))
        : string.Equals(afterRaw, expectedRaw, StringComparison.Ordinal);
    if (!rawVerified)
    {
        throw new Exception("Parameter write verification failed. Expected raw value '" + (expectedRaw ?? requestedValueText) + "' but read back raw value '" + afterRaw + "'.");
    }

    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    if (target.StorageType == StorageType.String && beforeRaw.Length == 0 && requestedValueText.Length == 0)
    {
        warnings.Add("empty_string_write_may_leave_revit_has_value_true");
    }

    return new {
        success = true,
        state = "committed",
        committed = true,
        tool = "set_element_parameter",
        revitWriteAction = "element_parameter",
        mode = mode,
        element = new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            category = elem.Category != null ? elem.Category.Name : "",
            name = elem.Name
        },
        owner = new {
            source = normalizedSource,
            id = owner.Id.IntegerValue,
            name = owner.Name
        },
        preflight = new {
            requiredPreflight = "inspect_parameter_schema exact identity resolution",
            exactDisplayNameMatchCount = displayMatches.Count,
            duplicateDisplayNamesBlocked = false,
            readOnlyBlocked = false
        },
        requested = new {
            value = requestedValueText,
            valueMode = valueMode,
            expectedRawAfterSet = expectedRaw,
            valueSetApi = valueSetApi
        },
        before = before,
        after = after,
        changed = !string.Equals(beforeRaw, afterRaw, StringComparison.Ordinal) || !string.Equals(beforeValueString, afterValueString, StringComparison.Ordinal),
        verification = new {
            verified = rawVerified,
            verificationMode = expectedRaw == null ? "SetValueString readback" : "raw readback",
            setApiReturned = setSucceeded
        },
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new {
        success = false,
        state = "failed",
        guarded = false,
        tool = "set_element_parameter",
        mode = mode,
        error = ex.Message
    };
}`;
}

export function registerSetElementParameterTool(server) {
    server.tool("set_element_parameter", "[PRODUCTION_PARAMETER_WRITE] Safely write one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, and unapproved type-parameter writes are blocked before commit. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementId: z.union([z.number(), z.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),
        useSelection: z.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),
        parameterName: z.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),
        parameterSource: z.enum(["instance", "type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),
        builtInParameterId: z.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),
        expectedStorageType: z.enum(["String", "Integer", "Double", "ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),
        expectedCurrentRaw: z.union([z.string(), z.number(), z.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Requested value. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),
        valueMode: z.enum(["raw", "valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),
        mode: z.enum(["dryRun", "commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),
        allowTypeParameterWrite: z.boolean().optional().default(false).describe("Required to commit a type-parameter write because it can affect all instances of that type."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default."),
    }, async (args) => {
        const connectionOptions = connectionOptionsFromArgs(args);
        try {
            const resolvedElementId = await resolveSingleElementId(args, connectionOptions);
            if (!resolvedElementId || typeof resolvedElementId === "object") {
                return formatJsonContent(resolvedElementId || {
                    success: false,
                    state: "guarded",
                    guarded: true,
                    guardReason: "element_id_required",
                    error: "Provide elementId or set useSelection=true with exactly one selected element.",
                    tool: "set_element_parameter",
                });
            }
            const mode = args.mode === "commit" ? "commit" : "dryRun";
            const response = await executeRevitCode(buildSetElementParameterCode(args, resolvedElementId), {
                ...connectionOptions,
                ...taskOptionsFromArgs(args, mode === "commit" ? "Set Revit element parameter" : "Dry-run Revit element parameter write"),
                transactionMode: mode === "commit" ? "auto" : "none",
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                state: "failed",
                tool: "set_element_parameter",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
