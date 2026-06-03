import { z } from "zod";
import { connectionOptionsFromArgs, connectionTargetSchema, executeRevitCode, formatJsonContent, getSelectionElementIds, taskMetadataSchema, taskOptionsFromArgs, } from "../utils/revitToolHelpers.js";
function payloadFromExecution(response) {
    if (response && typeof response === "object" && response.result && typeof response.result === "object") {
        return response.result;
    }
    return response;
}
function buildSessionContextCode(options) {
    const detailLevel = String(options.detailLevel || "minimal").toLowerCase();
    const includeCounts = (options.includeCategoryCounts === true || detailLevel === "counts" || detailLevel === "full") ? "true" : "false";
    const includeLinkSummary = options.includeLinks !== false ? "true" : "false";
    const includeLinkDetails = (options.includeLinks === true && detailLevel === "full") || detailLevel === "full" ? "true" : "false";
    return `
bool includeCounts = ${includeCounts};
bool includeLinkSummary = ${includeLinkSummary};
bool includeLinkDetails = ${includeLinkDetails};
string detailLevel = "${detailLevel}";
try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.Dictionary<string, int> counts = new System.Collections.Generic.Dictionary<string, int>();
    int linkInstances = 0;
    int loadedLinks = 0;
    int linkedRooms = 0;
    int linkedSpaces = 0;

    if (includeCounts)
    {
        System.Collections.Generic.Dictionary<string, BuiltInCategory> categories =
            new System.Collections.Generic.Dictionary<string, BuiltInCategory>();
        categories["ducts"] = BuiltInCategory.OST_DuctCurves;
        categories["flexDucts"] = BuiltInCategory.OST_FlexDuctCurves;
        categories["ductFittings"] = BuiltInCategory.OST_DuctFitting;
        categories["ductAccessories"] = BuiltInCategory.OST_DuctAccessory;
        categories["airTerminals"] = BuiltInCategory.OST_DuctTerminal;
        categories["mechanicalEquipment"] = BuiltInCategory.OST_MechanicalEquipment;
        categories["pipes"] = BuiltInCategory.OST_PipeCurves;
        categories["flexPipes"] = BuiltInCategory.OST_FlexPipeCurves;
        categories["pipeFittings"] = BuiltInCategory.OST_PipeFitting;
        categories["pipeAccessories"] = BuiltInCategory.OST_PipeAccessory;
        categories["plumbingFixtures"] = BuiltInCategory.OST_PlumbingFixtures;
        categories["sprinklers"] = BuiltInCategory.OST_Sprinklers;
        categories["hostRooms"] = BuiltInCategory.OST_Rooms;
        categories["hostMepSpaces"] = BuiltInCategory.OST_MEPSpaces;

        foreach (System.Collections.Generic.KeyValuePair<string, BuiltInCategory> kv in categories)
        {
            try
            {
                using (FilteredElementCollector collector = new FilteredElementCollector(document))
                {
                    counts[kv.Key] = collector
                        .OfCategory(kv.Value)
                        .WhereElementIsNotElementType()
                        .GetElementCount();
                }
            }
            catch (Exception ex)
            {
                counts[kv.Key] = -1;
                warnings.Add("Count failed for " + kv.Key + ": " + ex.Message);
            }
        }
    }

    if (includeLinkSummary)
    {
        using (FilteredElementCollector linkCollector = new FilteredElementCollector(document))
        {
            foreach (RevitLinkInstance link in linkCollector
                .OfClass(typeof(RevitLinkInstance))
                .WhereElementIsNotElementType()
                .OfType<RevitLinkInstance>())
            {
                linkInstances++;
                Document linkDoc = link.GetLinkDocument();
                if (linkDoc == null) continue;
                loadedLinks++;
                if (includeLinkDetails)
                {
                    try
                    {
                        using (FilteredElementCollector linkedRoomCollector = new FilteredElementCollector(linkDoc))
                        {
                            linkedRooms += linkedRoomCollector
                                .OfCategory(BuiltInCategory.OST_Rooms)
                                .WhereElementIsNotElementType()
                                .GetElementCount();
                        }
                    }
                    catch {}
                    try
                    {
                        using (FilteredElementCollector linkedSpaceCollector = new FilteredElementCollector(linkDoc))
                        {
                            linkedSpaces += linkedSpaceCollector
                                .OfCategory(BuiltInCategory.OST_MEPSpaces)
                                .WhereElementIsNotElementType()
                                .GetElementCount();
                        }
                    }
                    catch {}
                }
            }
        }
    }

    View activeView = document.ActiveView;
    return new {
        success = true,
        revit = new {
            version = document.Application.VersionNumber,
            build = document.Application.VersionBuild,
            culture = System.Globalization.CultureInfo.CurrentCulture.Name,
            decimalSeparator = System.Globalization.CultureInfo.CurrentCulture.NumberFormat.NumberDecimalSeparator
        },
        document = new {
            title = document.Title,
            isWorkshared = document.IsWorkshared,
            isReadOnly = document.IsReadOnly
        },
        apiProbeState = new {
            sampledInsideReadOnlyTool = true,
            documentIsModifiableDuringProbe = document.IsModifiable,
            meaning = "Internal Revit API state sampled while this read-only tool is executing. This is not the idle UI editability state.",
            currentUiStateSource = "Use get_ui_state.document.isModifiable for the current idle UI document state."
        },
        activeView = new {
            id = activeView.Id.IntegerValue,
            name = activeView.Name,
            viewType = activeView.ViewType.ToString(),
            scale = activeView.Scale,
            isTemplate = activeView.IsTemplate
        },
        detailLevel = detailLevel,
        counts = counts,
        links = new {
            instances = linkInstances,
            loaded = loadedLinks,
            linkedRooms = includeLinkDetails ? (int?)linkedRooms : null,
            linkedSpaces = includeLinkDetails ? (int?)linkedSpaces : null,
            detailsIncluded = includeLinkDetails
        },
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
export function registerGetRevitSessionContextTool(server) {
    server.tool("get_revit_session_context", "Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        detailLevel: z.enum(["minimal", "counts", "full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),
        includeCategoryCounts: z.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),
        includeLinks: z.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),
        includeSelection: z.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true."),
    }, async (args) => {
        const connectionOptions = connectionOptionsFromArgs(args);
        try {
            const response = await executeRevitCode(buildSessionContextCode(args), {
                ...connectionOptions,
                ...taskOptionsFromArgs(args, "Read Revit session context"),
                transactionMode: "none",
            });
            const payload = payloadFromExecution(response);
            if (args.includeSelection !== false && payload && typeof payload === "object") {
                const ids = await getSelectionElementIds(100, {
                    ...connectionOptions,
                    taskName: args.taskName ? `${args.taskName}: selection` : "Read Revit selection",
                    taskId: args.taskId,
                });
                payload.selection = {
                    count: ids.length,
                    elementIds: ids,
                };
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
