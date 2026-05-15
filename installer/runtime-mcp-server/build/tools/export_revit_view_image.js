import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { connectionTargetSchema, csharpString, executeRevitCode, executionOptionsFromArgs, formatJsonContent, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
const rangeSchema = z.enum(["current_view", "visible_region", "set_of_views"]);
const formatSchema = z.enum(["png", "jpg_lossless", "jpg_medium", "tiff", "bmp", "targa"]);
const dpiSchema = z.enum(["72", "150", "300", "600"]);
const fitDirectionSchema = z.enum(["horizontal", "vertical"]);
const fileTypeByFormat = {
    png: "PNG",
    jpg_lossless: "JPEGLossless",
    jpg_medium: "JPEGMedium",
    tiff: "TIFF",
    bmp: "BMP",
    targa: "TARGA",
};
const resolutionByDpi = {
    "72": "DPI_72",
    "150": "DPI_150",
    "300": "DPI_300",
    "600": "DPI_600",
};
const fitDirectionByInput = {
    horizontal: "Horizontal",
    vertical: "Vertical",
};
function defaultOutputDir() {
    return path.join(os.tmpdir(), "revit-mcp-image-export");
}
function safePrefix(value) {
    const raw = value && value.trim() ? value.trim() : `revit-view-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    return raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}
function csharpNullableInt(value) {
    if (value === undefined || value === null || value === "")
        return "null";
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return "null";
    return String(Math.trunc(parsed));
}
export function registerExportRevitViewImageTool(server) {
    server.tool("export_revit_view_image", "Export the active Revit view or a selected Revit view to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Read-only: it does not create or modify Revit elements or views.", {
        ...connectionTargetSchema(z),
        viewId: z.union([z.number(), z.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),
        viewName: z.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),
        exactName: z.boolean().optional().default(true),
        range: rangeSchema.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),
        format: formatSchema.optional().default("png"),
        pixelSize: z.number().int().min(200).max(10000).optional().default(2400),
        zoom: z.number().int().min(1).max(1000).optional().default(100),
        dpi: dpiSchema.optional().default("150"),
        fitDirection: fitDirectionSchema.optional().default("horizontal"),
        outputDir: z.string().optional(),
        filePrefix: z.string().optional(),
        ...taskMetadataSchema(z),
        timeoutMs: z.number().int().positive().optional(),
    }, async (args) => {
        const viewSelectorProvided = args.viewId !== undefined || !!args.viewName;
        const range = args.range ?? (viewSelectorProvided ? "set_of_views" : "current_view");
        const outputDir = path.resolve(args.outputDir || defaultOutputDir());
        const filePrefix = safePrefix(args.filePrefix);
        const fileType = fileTypeByFormat[args.format || "png"];
        const resolution = resolutionByDpi[String(args.dpi || "150")];
        const fitDirection = fitDirectionByInput[args.fitDirection || "horizontal"];
        const pixelSize = Math.trunc(args.pixelSize || 2400);
        const zoom = Math.trunc(args.zoom || 100);
        const code = `
var warnings = new List<string>();
string requestedRange = ${csharpString(range)};
string outputDir = ${csharpString(outputDir)};
string filePrefix = ${csharpString(filePrefix)};
string viewNameInput = ${csharpString(args.viewName || "")};
int? viewIdInput = ${csharpNullableInt(args.viewId)};
bool exactName = ${args.exactName === false ? "false" : "true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);

System.IO.Directory.CreateDirectory(outputDir);

Func<string, string> sanitize = (value) => {
  if (String.IsNullOrWhiteSpace(value)) return "revit-view-image";
  var invalid = System.IO.Path.GetInvalidFileNameChars();
  var chars = value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray();
  return new string(chars);
};

View activeView = document.ActiveView;
View selectedView = activeView;

if (requestedRange == "set_of_views" && viewIdInput.HasValue) {
  selectedView = document.GetElement(new ElementId(viewIdInput.Value)) as View;
}
else if (requestedRange == "set_of_views" && !String.IsNullOrWhiteSpace(viewNameInput)) {
  var views = new FilteredElementCollector(document)
    .OfClass(typeof(View))
    .Cast<View>()
    .Where(v => !v.IsTemplate)
    .Where(v => exactName
      ? String.Equals(v.Name, viewNameInput, System.StringComparison.OrdinalIgnoreCase)
      : v.Name.IndexOf(viewNameInput, System.StringComparison.OrdinalIgnoreCase) >= 0)
    .OrderBy(v => v.Name)
    .ToList();
  selectedView = views.FirstOrDefault();
  if (views.Count > 1) warnings.Add("view_name_matched_multiple_views:first_match_used");
}
else if (selectorProvided) {
  warnings.Add("view_selector_ignored_for_active_view_range:use_set_of_views_for_viewId_or_viewName");
}

if (selectedView == null) {
  return new { success = false, error = "view_not_found", viewId = viewIdInput, viewName = viewNameInput };
}
if (selectedView is ViewSchedule || selectedView is ViewSheet) {
  return new { success = false, error = "unsupported_view_type_for_image_export", viewId = selectedView.Id.IntegerValue, viewName = selectedView.Name, viewType = selectedView.ViewType.ToString() };
}
if ((requestedRange == "current_view" || requestedRange == "visible_region") && activeView == null) {
  return new { success = false, error = "active_view_not_available" };
}

var before = new HashSet<string>(System.IO.Directory.GetFiles(outputDir).Select(f => System.IO.Path.GetFullPath(f)), System.StringComparer.OrdinalIgnoreCase);

var options = new ImageExportOptions();
options.FilePath = System.IO.Path.Combine(outputDir, sanitize(filePrefix));
options.HLRandWFViewsFileType = ImageFileType.${fileType};
options.ShadowViewsFileType = ImageFileType.${fileType};
options.ImageResolution = ImageResolution.${resolution};
options.PixelSize = ${pixelSize};
options.Zoom = ${zoom};
options.FitDirection = FitDirectionType.${fitDirection};
options.ShouldCreateWebSite = false;

if (requestedRange == "visible_region") {
  options.ExportRange = ExportRange.VisibleRegionOfCurrentView;
  options.ZoomType = ZoomFitType.Zoom;
}
else if (requestedRange == "set_of_views") {
  options.ExportRange = ExportRange.SetOfViews;
  options.ZoomType = ZoomFitType.FitToPage;
  var ids = new List<ElementId> { selectedView.Id };
  options.SetViewsAndSheets(ids);
}
else {
  options.ExportRange = ExportRange.CurrentView;
  options.ZoomType = ZoomFitType.FitToPage;
}

document.ExportImage(options);

var files = System.IO.Directory.GetFiles(outputDir)
  .Select(f => System.IO.Path.GetFullPath(f))
  .Where(f => !before.Contains(f))
  .OrderBy(f => f)
  .Select(f => new {
    path = f,
    fileName = System.IO.Path.GetFileName(f),
    bytes = new System.IO.FileInfo(f).Length
  })
  .ToList();

return new {
  success = files.Count > 0,
  tool = "export_revit_view_image",
  revitWriteAction = "none",
  exportRange = requestedRange,
  format = ${csharpString(args.format || "png")},
  pixelSize = ${pixelSize},
  dpi = ${csharpString(String(args.dpi || "150"))},
  fitDirection = ${csharpString(args.fitDirection || "horizontal")},
  view = new { id = selectedView.Id.IntegerValue, name = selectedView.Name, type = selectedView.ViewType.ToString() },
  activeView = activeView == null ? null : new { id = activeView.Id.IntegerValue, name = activeView.Name, type = activeView.ViewType.ToString() },
  outputDir = outputDir,
  filePrefix = filePrefix,
  files = files,
  warnings = warnings
};`;
        const response = await executeRevitCode(code, {
            ...executionOptionsFromArgs(args),
            taskType: "export_revit_view_image",
            transactionMode: "none",
        });
        return formatJsonContent(response?.result ?? response);
    });
}
