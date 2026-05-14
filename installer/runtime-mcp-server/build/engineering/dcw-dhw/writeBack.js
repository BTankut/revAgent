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
export function createWriteBackCode(actions) {
    const payload = JSON.stringify(normalizeWriteBackActions(actions));
    return `
try
{
    string payload = ${csharpString(payload)};
    Newtonsoft.Json.Linq.JArray actions = Newtonsoft.Json.Linq.JArray.Parse(payload);
    Newtonsoft.Json.Linq.JArray results = new Newtonsoft.Json.Linq.JArray();
    foreach (Newtonsoft.Json.Linq.JObject action in actions)
    {
        string actionId = (string)action["actionId"];
        string writeKind = ((string)action["writeKind"] ?? "").ToLowerInvariant();
        int elementIdValue = (int)action["elementId"];
        Newtonsoft.Json.Linq.JObject record = new Newtonsoft.Json.Linq.JObject();
        record["actionId"] = actionId;
        record["elementId"] = elementIdValue;
        record["writeKind"] = writeKind;

        Autodesk.Revit.DB.Element element = document.GetElement(new Autodesk.Revit.DB.ElementId(elementIdValue));
        if (element == null)
        {
            record["status"] = "skipped";
            record["reason"] = "element_not_found";
            results.Add(record);
            continue;
        }

        if (writeKind == "diameter")
        {
            Autodesk.Revit.DB.Plumbing.Pipe pipe = element as Autodesk.Revit.DB.Plumbing.Pipe;
            if (pipe == null)
            {
                record["status"] = "skipped";
                record["reason"] = "element_is_not_pipe";
                results.Add(record);
                continue;
            }

            double targetDiameterMm = (double)action["targetDiameterMm"];
            Autodesk.Revit.DB.Parameter diameterParameter = pipe.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
            if (diameterParameter == null || diameterParameter.IsReadOnly)
            {
                record["status"] = "skipped";
                record["reason"] = "diameter_parameter_missing_or_readonly";
                results.Add(record);
                continue;
            }

            double beforeMm = Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(diameterParameter.AsDouble(), Autodesk.Revit.DB.UnitTypeId.Millimeters);
            double targetInternal = Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(targetDiameterMm, Autodesk.Revit.DB.UnitTypeId.Millimeters);
            bool changed = diameterParameter.Set(targetInternal);
            double afterMm = Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(diameterParameter.AsDouble(), Autodesk.Revit.DB.UnitTypeId.Millimeters);
            record["status"] = changed ? "changed" : "unchanged";
            record["beforeDiameterMm"] = System.Math.Round(beforeMm, 3);
            record["afterDiameterMm"] = System.Math.Round(afterMm, 3);
            results.Add(record);
            continue;
        }

        if (writeKind == "parameter")
        {
            string parameterName = (string)action["parameterName"];
            Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(parameterName);
            if (parameter == null || parameter.IsReadOnly)
            {
                record["status"] = "skipped";
                record["reason"] = "parameter_missing_or_readonly";
                record["parameterName"] = parameterName;
                results.Add(record);
                continue;
            }

            Newtonsoft.Json.Linq.JToken valueToken = action["parameterValue"];
            string before = parameter.AsValueString();
            if (before == null)
            {
                before = parameter.AsString();
            }

            bool changed = false;
            if (parameter.StorageType == Autodesk.Revit.DB.StorageType.Double)
            {
                double numericValue = (double)valueToken;
                string unit = ((string)action["parameterUnit"] ?? "").ToLowerInvariant();
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
                changed = parameter.Set((int)valueToken);
            }
            else
            {
                changed = parameter.Set(valueToken == null ? "" : valueToken.ToString());
            }

            string after = parameter.AsValueString();
            if (after == null)
            {
                after = parameter.AsString();
            }
            record["status"] = changed ? "changed" : "unchanged";
            record["parameterName"] = parameterName;
            record["before"] = before;
            record["after"] = after;
            results.Add(record);
            continue;
        }

        record["status"] = "skipped";
        record["reason"] = "unsupported_write_kind";
        results.Add(record);
    }

    Newtonsoft.Json.Linq.JObject summary = new Newtonsoft.Json.Linq.JObject();
    summary["success"] = true;
    summary["schemaVersion"] = "dcw-dhw-writeback-result.v1";
    summary["resultCount"] = results.Count;
    summary["results"] = results;
    return summary.ToString(Newtonsoft.Json.Formatting.None);
}
catch (System.Exception ex)
{
    Newtonsoft.Json.Linq.JObject error = new Newtonsoft.Json.Linq.JObject();
    error["success"] = false;
    error["error"] = ex.GetType().FullName + ": " + ex.Message;
    return error.ToString(Newtonsoft.Json.Formatting.None);
}
`;
}
