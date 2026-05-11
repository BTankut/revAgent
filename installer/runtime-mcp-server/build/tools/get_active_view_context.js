import { z } from "zod";
import { connectionTargetSchema, csharpStringArray, executeRevitCode, executionOptionsFromArgs, formatJsonContent, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
function buildActiveViewContextCode(args) {
    const includeSheetViewports = args.includeSheetViewports !== false ? "true" : "false";
    const includeModelElements = args.includeModelElements === true ? "true" : "false";
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 100;
    const categories = csharpStringArray(args.modelCategoryList || []);
    return `
bool includeSheetViewports = ${includeSheetViewports};
bool includeModelElements = ${includeModelElements};
int limit = ${limit};
string[] modelCategoryNames = ${categories};

System.Func<Element, object> ElementSummary = delegate(Element elem)
{
    string categoryName = elem.Category != null ? elem.Category.Name : "";
    string typeName = "";
    Element typeElem = document.GetElement(elem.GetTypeId());
    if (typeElem != null) typeName = typeElem.Name;
    return new {
        id = elem.Id.IntegerValue,
        uniqueId = elem.UniqueId,
        name = elem.Name,
        category = categoryName,
        className = elem.GetType().FullName,
        typeName = typeName
    };
};

try
{
    View view = document.ActiveView;
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<object> viewports = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> modelElements = new System.Collections.Generic.List<object>();

    if (includeSheetViewports && view.ViewType == ViewType.DrawingSheet)
    {
        FilteredElementCollector vpCollector = new FilteredElementCollector(document, view.Id)
            .OfClass(typeof(Viewport))
            .WhereElementIsNotElementType();
        foreach (Element vpElem in vpCollector.ToElements())
        {
            Viewport vp = vpElem as Viewport;
            if (vp == null) continue;
            View placedView = document.GetElement(vp.ViewId) as View;
            viewports.Add(new {
                viewportId = vp.Id.IntegerValue,
                viewId = vp.ViewId.IntegerValue,
                viewName = placedView != null ? placedView.Name : "",
                viewType = placedView != null ? placedView.ViewType.ToString() : "",
                scale = placedView != null ? placedView.Scale : 0
            });
        }
        if (includeModelElements)
        {
            warnings.Add("Active view is a DrawingSheet; model elements are not collected directly from the sheet. Choose a placed view first.");
        }
    }
    else if (includeModelElements)
    {
        int added = 0;
        if (modelCategoryNames.Length == 0)
        {
            warnings.Add("includeModelElements was true but no modelCategoryList was supplied.");
        }
        foreach (string categoryName in modelCategoryNames)
        {
            if (added >= limit) break;
            try
            {
                BuiltInCategory bic = (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), categoryName);
                FilteredElementCollector col = new FilteredElementCollector(document, view.Id)
                    .OfCategory(bic)
                    .WhereElementIsNotElementType();
                foreach (Element elem in col.ToElements())
                {
                    if (added >= limit) break;
                    modelElements.Add(ElementSummary(elem));
                    added++;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("Could not collect category " + categoryName + ": " + ex.Message);
            }
        }
    }

    return new {
        success = true,
        activeView = new {
            id = view.Id.IntegerValue,
            name = view.Name,
            viewType = view.ViewType.ToString(),
            scale = view.Scale,
            isTemplate = view.IsTemplate
        },
        sheet = new {
            isSheet = view.ViewType == ViewType.DrawingSheet,
            viewports = viewports.ToArray()
        },
        modelElements = modelElements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
export function registerGetActiveViewContextTool(server) {
    server.tool("get_active_view_context", "Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data instead of pretending MEP model elements are directly visible.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        includeSheetViewports: z.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),
        includeModelElements: z.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),
        modelCategoryList: z.array(z.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),
        limit: z.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100."),
    }, async (args) => {
        try {
            const response = await executeRevitCode(buildActiveViewContextCode(args), {
                ...executionOptionsFromArgs(args, "Read active Revit view context"),
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
