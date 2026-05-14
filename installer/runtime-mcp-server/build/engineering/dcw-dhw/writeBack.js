import { computeApprovalToken } from "./sizingAudit.js";
import { csharpString } from "../../utils/revitToolHelpers.js";
export const WRITEBACK_CONFIRM_TEXT = "APPLY_DCW_DHW_WRITEBACK";
export function normalizeWriteBackActions(actions) {
    return (Array.isArray(actions) ? actions : [])
        .filter((action) => action && action.elementId)
        .map((action) => ({
        actionId: String(action.actionId || `${action.writeKind || "write"}:${action.elementId}`),
        writeKind: String(action.writeKind || "diameter"),
        nodeId: action.nodeId ? String(action.nodeId) : null,
        elementId: Number.parseInt(String(action.elementId), 10),
        parameterName: action.parameterName ? String(action.parameterName) : null,
        targetDiameterMm: action.targetDiameterMm === undefined || action.targetDiameterMm === null ? null : Number(action.targetDiameterMm),
        parameterValue: action.parameterValue === undefined || action.parameterValue === null ? null : action.parameterValue,
        parameterUnit: action.parameterUnit ? String(action.parameterUnit) : null,
        trace: action.trace || {},
    }))
        .filter((action) => Number.isFinite(action.elementId) && action.elementId > 0);
}
export function validateWriteBackApproval(actions, approvalToken, confirmWriteBack) {
    const normalizedActions = normalizeWriteBackActions(actions);
    const expectedToken = computeApprovalToken(normalizedActions);
    const errors = [];
    if (normalizedActions.length === 0) {
        errors.push("No write-back actions were provided.");
    }
    for (const action of normalizedActions) {
        if (action.writeKind === "diameter" && (!Number.isFinite(action.targetDiameterMm) || action.targetDiameterMm <= 0)) {
            errors.push(`Diameter action '${action.actionId}' has no positive targetDiameterMm.`);
        }
        if (action.writeKind === "parameter" && !action.parameterName) {
            errors.push(`Parameter action '${action.actionId}' has no parameterName.`);
        }
        if (!["diameter", "parameter"].includes(action.writeKind)) {
            errors.push(`Action '${action.actionId}' has unsupported writeKind '${action.writeKind}'.`);
        }
    }
    if (!approvalToken || approvalToken !== expectedToken) {
        errors.push("approvalToken does not match the provided actions.");
    }
    if (confirmWriteBack !== WRITEBACK_CONFIRM_TEXT) {
        errors.push(`confirmWriteBack must equal '${WRITEBACK_CONFIRM_TEXT}'.`);
    }
    return {
        ok: errors.length === 0,
        errors,
        expectedToken,
        normalizedActions,
    };
}
function csharpStringArray(values) {
    return `new string[] { ${values.map((value) => csharpString(value === null || value === undefined ? "" : String(value))).join(", ")} }`;
}
function csharpIntArray(values) {
    return `new int[] { ${values.map((value) => Number.parseInt(String(value), 10)).join(", ")} }`;
}
function csharpDoubleArray(values) {
    return `new double[] { ${values
        .map((value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? String(numeric) : "0";
    })
        .join(", ")} }`;
}
function parameterValueToString(value) {
    if (value === undefined || value === null) {
        return "";
    }
    if (typeof value === "object") {
        return JSON.stringify(value);
    }
    return String(value);
}
export function createWriteBackCode(actions) {
    const normalizedActions = normalizeWriteBackActions(actions);
    const actionIds = csharpStringArray(normalizedActions.map((action) => action.actionId));
    const writeKinds = csharpStringArray(normalizedActions.map((action) => action.writeKind));
    const elementIds = csharpIntArray(normalizedActions.map((action) => action.elementId));
    const parameterNames = csharpStringArray(normalizedActions.map((action) => action.parameterName || ""));
    const targetDiameterMms = csharpDoubleArray(normalizedActions.map((action) => action.targetDiameterMm || 0));
    const parameterValues = csharpStringArray(normalizedActions.map((action) => parameterValueToString(action.parameterValue)));
    const parameterUnits = csharpStringArray(normalizedActions.map((action) => action.parameterUnit || ""));
    return `
System.Func<string, string> __escapeJson = delegate(string value)
{
    if (value == null)
    {
        return "";
    }
    return value
        .Replace("\\\\", "\\\\\\\\")
        .Replace("\\\"", "\\\\\\\"")
        .Replace("\\r", "\\\\r")
        .Replace("\\n", "\\\\n")
        .Replace("\\t", "\\\\t");
};

try
{
    string[] actionIds = ${actionIds};
    string[] writeKinds = ${writeKinds};
    int[] elementIds = ${elementIds};
    string[] parameterNames = ${parameterNames};
    double[] targetDiameterMms = ${targetDiameterMms};
    string[] parameterValues = ${parameterValues};
    string[] parameterUnits = ${parameterUnits};

    System.Text.StringBuilder results = new System.Text.StringBuilder();
    results.Append("[");
    bool firstResult = true;
    int resultCount = 0;
    System.Action<string, int, string, string, string, string, double, double, string, string> addResult =
        delegate(string actionId, int elementIdValue, string writeKind, string status, string reason, string parameterName, double beforeDiameterMm, double afterDiameterMm, string before, string after)
    {
        if (!firstResult)
        {
            results.Append(",");
        }
        firstResult = false;
        resultCount++;

        results.Append("{");
        results.Append("\\\"actionId\\\":\\\"").Append(__escapeJson(actionId)).Append("\\\"");
        results.Append(",\\\"elementId\\\":").Append(elementIdValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
        results.Append(",\\\"writeKind\\\":\\\"").Append(__escapeJson(writeKind)).Append("\\\"");
        results.Append(",\\\"status\\\":\\\"").Append(__escapeJson(status)).Append("\\\"");
        if (!string.IsNullOrEmpty(reason))
        {
            results.Append(",\\\"reason\\\":\\\"").Append(__escapeJson(reason)).Append("\\\"");
        }
        if (!string.IsNullOrEmpty(parameterName))
        {
            results.Append(",\\\"parameterName\\\":\\\"").Append(__escapeJson(parameterName)).Append("\\\"");
        }
        if (!System.Double.IsNaN(beforeDiameterMm))
        {
            results.Append(",\\\"beforeDiameterMm\\\":").Append(System.Math.Round(beforeDiameterMm, 3).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        if (!System.Double.IsNaN(afterDiameterMm))
        {
            results.Append(",\\\"afterDiameterMm\\\":").Append(System.Math.Round(afterDiameterMm, 3).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        if (before != null)
        {
            results.Append(",\\\"before\\\":\\\"").Append(__escapeJson(before)).Append("\\\"");
        }
        if (after != null)
        {
            results.Append(",\\\"after\\\":\\\"").Append(__escapeJson(after)).Append("\\\"");
        }
        results.Append("}");
    };

    for (int i = 0; i < actionIds.Length; i++)
    {
        string actionId = actionIds[i];
        string writeKind = (writeKinds[i] ?? "").ToLowerInvariant();
        int elementIdValue = elementIds[i];

        Autodesk.Revit.DB.Element element = document.GetElement(new Autodesk.Revit.DB.ElementId(elementIdValue));
        if (element == null)
        {
            addResult(actionId, elementIdValue, writeKind, "skipped", "element_not_found", null, System.Double.NaN, System.Double.NaN, null, null);
            continue;
        }

        if (writeKind == "diameter")
        {
            Autodesk.Revit.DB.Plumbing.Pipe pipe = element as Autodesk.Revit.DB.Plumbing.Pipe;
            if (pipe == null)
            {
                addResult(actionId, elementIdValue, writeKind, "skipped", "element_is_not_pipe", null, System.Double.NaN, System.Double.NaN, null, null);
                continue;
            }

            double targetDiameterMm = targetDiameterMms[i];
            Autodesk.Revit.DB.Parameter diameterParameter = pipe.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
            if (diameterParameter == null || diameterParameter.IsReadOnly)
            {
                addResult(actionId, elementIdValue, writeKind, "skipped", "diameter_parameter_missing_or_readonly", null, System.Double.NaN, System.Double.NaN, null, null);
                continue;
            }

            double beforeMm = Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(diameterParameter.AsDouble(), Autodesk.Revit.DB.UnitTypeId.Millimeters);
            double targetInternal = Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(targetDiameterMm, Autodesk.Revit.DB.UnitTypeId.Millimeters);
            bool changed = diameterParameter.Set(targetInternal);
            double afterMm = Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(diameterParameter.AsDouble(), Autodesk.Revit.DB.UnitTypeId.Millimeters);
            addResult(actionId, elementIdValue, writeKind, changed ? "changed" : "unchanged", null, null, beforeMm, afterMm, null, null);
            continue;
        }

        if (writeKind == "parameter")
        {
            string parameterName = parameterNames[i];
            Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(parameterName);
            if (parameter == null || parameter.IsReadOnly)
            {
                addResult(actionId, elementIdValue, writeKind, "skipped", "parameter_missing_or_readonly", parameterName, System.Double.NaN, System.Double.NaN, null, null);
                continue;
            }

            string valueText = parameterValues[i];
            string before = parameter.AsValueString();
            if (before == null)
            {
                before = parameter.AsString();
            }

            bool changed = false;
            if (parameter.StorageType == Autodesk.Revit.DB.StorageType.Double)
            {
                double numericValue = 0;
                if (!System.Double.TryParse(valueText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out numericValue))
                {
                    addResult(actionId, elementIdValue, writeKind, "skipped", "parameter_value_not_numeric", parameterName, System.Double.NaN, System.Double.NaN, null, null);
                    continue;
                }
                string unit = (parameterUnits[i] ?? "").ToLowerInvariant();
                double internalValue = numericValue;
                if (unit == "mm")
                {
                    internalValue = Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(numericValue, Autodesk.Revit.DB.UnitTypeId.Millimeters);
                }
                else if (unit == "l/s" || unit == "lps")
                {
                    internalValue = Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(numericValue, Autodesk.Revit.DB.UnitTypeId.LitersPerSecond);
                }
                changed = parameter.Set(internalValue);
            }
            else if (parameter.StorageType == Autodesk.Revit.DB.StorageType.Integer)
            {
                int integerValue = 0;
                if (!System.Int32.TryParse(valueText, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out integerValue))
                {
                    addResult(actionId, elementIdValue, writeKind, "skipped", "parameter_value_not_integer", parameterName, System.Double.NaN, System.Double.NaN, null, null);
                    continue;
                }
                changed = parameter.Set(integerValue);
            }
            else
            {
                changed = parameter.Set(valueText ?? "");
            }

            string after = parameter.AsValueString();
            if (after == null)
            {
                after = parameter.AsString();
            }
            addResult(actionId, elementIdValue, writeKind, changed ? "changed" : "unchanged", null, parameterName, System.Double.NaN, System.Double.NaN, before, after);
            continue;
        }

        addResult(actionId, elementIdValue, writeKind, "skipped", "unsupported_write_kind", null, System.Double.NaN, System.Double.NaN, null, null);
    }

    results.Append("]");
    return "{\\\"success\\\":true,\\\"schemaVersion\\\":\\\"dcw-dhw-writeback-result.v1\\\",\\\"resultCount\\\":" + resultCount.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\\\"results\\\":" + results.ToString() + "}";
}
catch (System.Exception ex)
{
    return "{\\\"success\\\":false,\\\"error\\\":\\\"" + __escapeJson(ex.GetType().FullName + ": " + ex.Message) + "\\\"}";
}
`;
}
