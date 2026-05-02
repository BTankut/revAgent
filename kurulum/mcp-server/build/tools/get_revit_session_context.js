import { z } from "zod";
import {
    executeRevitCode,
    formatJsonContent,
    getSelectionElementIds,
} from "../utils/revitToolHelpers.js";

function payloadFromExecution(response) {
    if (response && typeof response === "object" && response.result && typeof response.result === "object") {
        return response.result;
    }
    return response;
}

function buildSessionContextCode(options) {
    const includeCounts = options.includeCategoryCounts !== false ? "true" : "false";
    const includeLinks = options.includeLinks !== false ? "true" : "false";
    return `
bool includeCounts = ${includeCounts};
bool includeLinks = ${includeLinks};
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
                counts[kv.Key] = new FilteredElementCollector(document)
                    .OfCategory(kv.Value)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Count;
            }
            catch (Exception ex)
            {
                counts[kv.Key] = -1;
                warnings.Add("Count failed for " + kv.Key + ": " + ex.Message);
            }
        }
    }

    if (includeLinks)
    {
        FilteredElementCollector linkCollector = new FilteredElementCollector(document)
            .OfClass(typeof(RevitLinkInstance))
            .WhereElementIsNotElementType();
        foreach (Element linkElem in linkCollector.ToElements())
        {
            linkInstances++;
            RevitLinkInstance link = linkElem as RevitLinkInstance;
            if (link == null) continue;
            Document linkDoc = link.GetLinkDocument();
            if (linkDoc == null) continue;
            loadedLinks++;
            try
            {
                linkedRooms += new FilteredElementCollector(linkDoc)
                    .OfCategory(BuiltInCategory.OST_Rooms)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Count;
            }
            catch {}
            try
            {
                linkedSpaces += new FilteredElementCollector(linkDoc)
                    .OfCategory(BuiltInCategory.OST_MEPSpaces)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Count;
            }
            catch {}
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
            isReadOnly = document.IsReadOnly,
            isModifiable = document.IsModifiable
        },
        activeView = new {
            id = activeView.Id.IntegerValue,
            name = activeView.Name,
            viewType = activeView.ViewType.ToString(),
            scale = activeView.Scale,
            isTemplate = activeView.IsTemplate
        },
        counts = counts,
        links = new {
            instances = linkInstances,
            loaded = loadedLinks,
            linkedRooms = linkedRooms,
            linkedSpaces = linkedSpaces
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
    server.tool("get_revit_session_context", "Read-only Revit session summary: version/build/culture/document state/active view/MEP counts/link counts/selection IDs.", {
        includeCategoryCounts: z.boolean().optional().describe("Include known MEP category counts. Defaults true."),
        includeLinks: z.boolean().optional().describe("Include Revit link and linked room/space counts. Defaults true."),
        includeSelection: z.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true."),
    }, async (args) => {
        try {
            const response = await executeRevitCode(buildSessionContextCode(args), { transactionMode: "none" });
            const payload = payloadFromExecution(response);
            if (args.includeSelection !== false && payload && typeof payload === "object") {
                const ids = await getSelectionElementIds(100);
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
