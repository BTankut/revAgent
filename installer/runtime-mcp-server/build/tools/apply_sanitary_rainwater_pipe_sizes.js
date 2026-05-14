import { z } from "zod";
import { calculateSanitaryRainwater, createWriteBackPlan, SANITARY_RAINWATER_WRITEBACK_CONFIRM_TEXT, } from "../calculations/sanitary-rainwater/calculator.js";
import { connectionOptionsFromArgs, connectionTargetSchema, executeRevitCode, formatJsonContent, normalizeRevitExecutionResponse, taskMetadataSchema, truncateText, } from "../utils/revitToolHelpers.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
const COMMIT_TOKEN = "APPLY_SANITARY_RAINWATER_DIAMETERS";
async function readRevitStatus(args) {
    const timeoutMs = args.statusTimeoutMs || 3000;
    return await withRevitConnection(async (revitClient) => {
        return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
    }, {
        ...connectionOptionsFromArgs(args),
        skipLock: true,
        connectTimeoutMs: timeoutMs,
    });
}
function activeTaskFromStatus(status) {
    const normalized = normalizeRevitExecutionResponse(status);
    if (!normalized || typeof normalized !== "object") {
        return null;
    }
    return normalized.activeTask || normalized.ActiveTask || null;
}
function validateManualApproval(args, plan) {
    const errors = [];
    if (args.approvalToken !== plan.approvalToken) {
        errors.push("approvalToken does not match the current sanitary/rainwater write-back plan.");
    }
    if (args.confirmWriteBack !== SANITARY_RAINWATER_WRITEBACK_CONFIRM_TEXT) {
        errors.push(`confirmWriteBack must equal '${SANITARY_RAINWATER_WRITEBACK_CONFIRM_TEXT}'.`);
    }
    if (plan?.manualApproval?.warningReviewRequired && args.allowWarnings !== true) {
        errors.push("The sizing report contains warnings; set allowWarnings=true only after reviewing table/profile and data warnings.");
    }
    return {
        ok: errors.length === 0,
        errors,
    };
}
function writeBackCode() {
    return `
try
{
    System.Collections.Generic.List<object> changes = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> warnings = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> errors = new System.Collections.Generic.List<object>();

    string JsonEscape(string value)
    {
        if (value == null) return string.Empty;
        System.Text.StringBuilder escaped = new System.Text.StringBuilder();
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch == '\\\\') escaped.Append("\\\\\\\\");
            else if (ch == '"') escaped.Append("\\\\\"");
            else if (ch == '\\n') escaped.Append("\\\\n");
            else if (ch == '\\r') escaped.Append("\\\\r");
            else if (ch == '\\t') escaped.Append("\\\\t");
            else escaped.Append(ch);
        }
        return escaped.ToString();
    }

    string SerializeJson(object value)
    {
        if (value == null) return "null";
        string stringValue = value as string;
        if (stringValue != null) return "\\\"" + JsonEscape(stringValue) + "\\\"";
        if (value is bool) return ((bool)value) ? "true" : "false";
        if (value is double)
        {
            double number = (double)value;
            if (double.IsNaN(number) || double.IsInfinity(number)) return "null";
            return number.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        if (value is int || value is long || value is uint || value is ulong || value is short || value is ushort || value is byte || value is sbyte || value is decimal)
        {
            return System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        System.Collections.IDictionary dictionary = value as System.Collections.IDictionary;
        if (dictionary != null)
        {
            System.Text.StringBuilder objectBuilder = new System.Text.StringBuilder();
            objectBuilder.Append("{");
            bool first = true;
            foreach (System.Collections.DictionaryEntry entry in dictionary)
            {
                if (!first) objectBuilder.Append(",");
                first = false;
                objectBuilder.Append("\\\"");
                objectBuilder.Append(JsonEscape(System.Convert.ToString(entry.Key, System.Globalization.CultureInfo.InvariantCulture)));
                objectBuilder.Append("\\\":");
                objectBuilder.Append(SerializeJson(entry.Value));
            }
            objectBuilder.Append("}");
            return objectBuilder.ToString();
        }
        System.Collections.IEnumerable enumerable = value as System.Collections.IEnumerable;
        if (enumerable != null)
        {
            System.Text.StringBuilder arrayBuilder = new System.Text.StringBuilder();
            arrayBuilder.Append("[");
            bool first = true;
            foreach (object item in enumerable)
            {
                if (!first) arrayBuilder.Append(",");
                first = false;
                arrayBuilder.Append(SerializeJson(item));
            }
            arrayBuilder.Append("]");
            return arrayBuilder.ToString();
        }
        return "\\\"" + JsonEscape(value.ToString()) + "\\\"";
    }

    double ToMm(double internalFeet)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(internalFeet, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double FromMm(double millimeters)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(millimeters, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double Round3(double value)
    {
        return System.Math.Round(value, 3);
    }

    if (parameters == null || parameters.Length == 0)
    {
        errors.Add("No pipe diameter changes were supplied.");
    }

    for (int i = 0; parameters != null && i < parameters.Length; i++)
    {
        string raw = parameters[i] == null ? string.Empty : parameters[i].ToString();
        string[] parts = raw.Split('|');
        if (parts.Length < 2)
        {
            warnings.Add("Skipped malformed change row: " + raw);
            continue;
        }

        int elementIdValue;
        double targetDiameterMm;
        if (!int.TryParse(parts[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out elementIdValue) ||
            !double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out targetDiameterMm))
        {
            warnings.Add("Skipped unparsable change row: " + raw);
            continue;
        }

        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["element_id"] = elementIdValue;
        record["target_diameter_mm"] = Round3(targetDiameterMm);

        Autodesk.Revit.DB.Element element = document.GetElement(new Autodesk.Revit.DB.ElementId(elementIdValue));
        Autodesk.Revit.DB.Plumbing.Pipe pipe = element as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe == null)
        {
            record["status"] = "skipped";
            record["reason"] = "Element is not a Revit pipe.";
            warnings.Add("Skipped element " + elementIdValue + ": Element is not a Revit pipe.");
            changes.Add(record);
            continue;
        }

        Autodesk.Revit.DB.Parameter diameter = pipe.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
        if (diameter == null || diameter.IsReadOnly)
        {
            record["status"] = "skipped";
            record["reason"] = "Pipe diameter parameter is missing or read-only.";
            warnings.Add("Skipped element " + elementIdValue + ": Pipe diameter parameter is missing or read-only.");
            changes.Add(record);
            continue;
        }

        double beforeMm = ToMm(diameter.AsDouble());
        record["before_diameter_mm"] = Round3(beforeMm);
        if (System.Math.Abs(beforeMm - targetDiameterMm) <= 0.1)
        {
            record["status"] = "unchanged";
            record["reason"] = "Diameter already matches target.";
            changes.Add(record);
            continue;
        }

        diameter.Set(FromMm(targetDiameterMm));
        double afterMm = ToMm(diameter.AsDouble());
        record["after_diameter_mm"] = Round3(afterMm);
        record["status"] = System.Math.Abs(afterMm - targetDiameterMm) <= 0.1 ? "updated" : "updated_with_rounding";
        changes.Add(record);
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["requested_count"] = parameters == null ? 0 : parameters.Length;
    summary["change_count"] = changes.Count;
    summary["error_count"] = errors.Count;
    summary["warning_count"] = warnings.Count;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "sanitary-rainwater-revit-writeback.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["changes"] = changes;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\\\", "\\\\\\\\").Replace("\\\"", "\\\\\\\"").Replace("\\r", "\\\\r").Replace("\\n", "\\\\n");
    return "{\\\"schema_version\\\":\\\"sanitary-rainwater-revit-writeback.v1\\\",\\\"status\\\":\\\"fail\\\",\\\"summary\\\":{},\\\"changes\\\":[],\\\"warnings\\\":[],\\\"errors\\\":[\\\"" + message + "\\\"]}";
}`;
}
export function registerApplySanitaryRainwaterPipeSizesTool(server) {
    server.tool("apply_sanitary_rainwater_pipe_sizes", "Create a sanitary/rainwater pipe diameter dry-run plan from connector graph JSON, or write approved pipe diameter changes back to Revit. Write-back requires a plan-specific approval token, explicit confirm text, warning acknowledgement, and a Revit MCP status preflight.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        graph: z.union([z.string(), z.record(z.any())]).describe("Connector graph JSON object or JSON string using schemaVersion mep.connector-graph.v1."),
        mode: z.enum(["dryRun", "writeBack"]).optional().describe("dryRun returns the planned pipe diameter changes. writeBack applies them to Revit only after all manual approval gates pass."),
        commitToken: z.string().optional().describe(`Required for writeBack mode: ${COMMIT_TOKEN}`),
        approvalToken: z.string().optional().describe("Required for writeBack mode: exact token from dryRun writeBackPlan.approvalToken."),
        confirmWriteBack: z.string().optional().describe(`Required for writeBack mode: ${SANITARY_RAINWATER_WRITEBACK_CONFIRM_TEXT}`),
        allowWarnings: z.boolean().optional().describe("Required true for writeBack when writeBackPlan.manualApproval.warningReviewRequired is true."),
        systemMode: z.enum(["auto", "sanitary", "rainwater"]).optional().describe("Limit calculation to one drainage family, or infer from graph system data."),
        tableConfig: z.any().optional().describe("Optional project-approved table config. If omitted, the bundled generic metric profile is used and reported as review-required."),
        respectExistingUpstreamDiameters: z.boolean().optional().describe("When true, downstream recommendations are not allowed below upstream existing pipe diameters. Defaults true."),
        maxWrites: z.number().int().positive().optional().describe("Optional cap on write-back changes for staged commits."),
        timeoutMs: z.number().int().positive().optional().describe("Socket timeout in milliseconds for the Revit write-back command. Defaults to 120000."),
        statusTimeoutMs: z.number().int().positive().max(10000).optional().describe("Status preflight timeout in milliseconds. Defaults to 3000."),
        maxReturnedChars: z.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),
    }, async (args) => {
        try {
            const report = calculateSanitaryRainwater(args.graph, {
                systemMode: args.systemMode || "auto",
                tableConfig: args.tableConfig,
                respectExistingUpstreamDiameters: args.respectExistingUpstreamDiameters,
            });
            const plan = createWriteBackPlan(report, { maxWrites: args.maxWrites });
            const mode = args.mode || "dryRun";
            if (mode !== "writeBack") {
                return formatJsonContent({
                    mode,
                    report,
                    writeBackPlan: plan,
                });
            }
            if (args.commitToken !== COMMIT_TOKEN) {
                return formatJsonContent({
                    success: false,
                    error: `writeBack mode requires commitToken=${COMMIT_TOKEN}.`,
                    report,
                    writeBackPlan: plan,
                });
            }
            const approval = validateManualApproval(args, plan);
            if (!approval.ok) {
                return formatJsonContent({
                    success: false,
                    schemaVersion: "sanitary-rainwater-writeback-preflight.v1",
                    errors: approval.errors,
                    expectedApprovalToken: plan.approvalToken,
                    expectedConfirmWriteBack: SANITARY_RAINWATER_WRITEBACK_CONFIRM_TEXT,
                    report,
                    writeBackPlan: plan,
                });
            }
            if (plan.status === "blocked") {
                return formatJsonContent({
                    success: false,
                    error: "Write-back is blocked by sizing/report errors.",
                    report,
                    writeBackPlan: plan,
                });
            }
            if (plan.changes.length === 0) {
                return formatJsonContent({
                    success: true,
                    message: "No pipe diameter changes are required.",
                    report,
                    writeBackPlan: plan,
                });
            }
            const status = await readRevitStatus(args);
            const activeTask = activeTaskFromStatus(status);
            if (activeTask) {
                return formatJsonContent({
                    success: false,
                    schemaVersion: "sanitary-rainwater-writeback-preflight.v1",
                    error: "Revit MCP is busy; sanitary/rainwater write-back was not sent.",
                    activeTask,
                    report,
                    writeBackPlan: plan,
                });
            }
            const parameters = plan.changes.map((change) => `${change.elementId}|${change.targetDiameterMm}`);
            const response = await executeRevitCode(writeBackCode(), {
                ...connectionOptionsFromArgs(args),
                parameters,
                transactionMode: "auto",
                taskName: args.taskName || "Write sanitary/rainwater pipe sizes",
                taskId: args.taskId,
                timeoutMs: args.timeoutMs,
            });
            const revitWriteStatus = response?.result?.status || response?.status || null;
            const success = response?.success !== false && (revitWriteStatus === "pass" || revitWriteStatus === "warn");
            const payload = {
                success,
                mode,
                report,
                writeBackPlan: plan,
                revitResponse: response,
            };
            const serialized = JSON.stringify(payload, null, 2);
            const trimmed = truncateText(serialized, args.maxReturnedChars);
            if (trimmed.truncated) {
                return { content: [{ type: "text", text: trimmed.text }] };
            }
            return formatJsonContent(payload);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
