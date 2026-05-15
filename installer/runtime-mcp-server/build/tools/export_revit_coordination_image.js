import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { connectionTargetSchema, csharpString, executeRevitCode, executionOptionsFromArgs, formatJsonContent, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
const intentSchema = z.enum(["raw_evidence", "coordination_overlay", "system_focus", "clash_clearance"]);
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
    const raw = value && value.trim() ? value.trim() : `revit-coordination-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    return raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}
function csharpIntList(values) {
    const ints = (values || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.trunc(value));
    return `new List<int> { ${ints.join(", ")} }`;
}
export function registerExportRevitCoordinationImageTool(server) {
    server.tool("export_revit_coordination_image", "Create or reuse a visual QA 3D view, optionally section-box target elements, apply high-contrast coordination graphics, and export an image. It only writes review view settings; it does not create or modify MEP model elements.", {
        ...connectionTargetSchema(z),
        intent: intentSchema.optional().default("coordination_overlay"),
        elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),
        viewName: z.string().optional().default("DPE Visual QA - Coordination Export"),
        marginMm: z.number().min(0).max(20000).optional().default(2000),
        contextTransparency: z.number().int().min(0).max(90).optional().default(65),
        pixelSize: z.number().int().min(200).max(10000).optional().default(4000),
        dpi: dpiSchema.optional().default("300"),
        fitDirection: fitDirectionSchema.optional().default("horizontal"),
        format: formatSchema.optional().default("png"),
        outputDir: z.string().optional(),
        filePrefix: z.string().optional(),
        ...taskMetadataSchema(z),
        timeoutMs: z.number().int().positive().optional(),
    }, async (args) => {
        const outputDir = path.resolve(args.outputDir || defaultOutputDir());
        const filePrefix = safePrefix(args.filePrefix);
        const fileType = fileTypeByFormat[args.format || "png"];
        const resolution = resolutionByDpi[String(args.dpi || "150")];
        const fitDirection = fitDirectionByInput[args.fitDirection || "horizontal"];
        const pixelSize = Math.trunc(args.pixelSize || 4000);
        const marginMm = Number.isFinite(Number(args.marginMm)) ? Number(args.marginMm) : 2000;
        const transparency = Math.trunc(args.contextTransparency ?? 65);
        const code = `
var warnings = new List<string>();
string outputDir = ${csharpString(outputDir)};
string filePrefix = ${csharpString(filePrefix)};
string desiredViewName = ${csharpString(args.viewName || "DPE Visual QA - Coordination Export")};
string intent = ${csharpString(args.intent || "coordination_overlay")};
var requestedElementIds = ${csharpIntList(args.elementIds)};
double marginFeet = ${marginMm} / 304.8;
int contextTransparency = ${transparency};

System.IO.Directory.CreateDirectory(outputDir);

Func<string, string> sanitize = (value) => {
  if (String.IsNullOrWhiteSpace(value)) return "revit-coordination-image";
  var invalid = System.IO.Path.GetInvalidFileNameChars();
  var chars = value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray();
  return new string(chars);
};

var viewFamilyType = new FilteredElementCollector(document)
  .OfClass(typeof(ViewFamilyType))
  .Cast<ViewFamilyType>()
  .FirstOrDefault(vft => vft.ViewFamily == ViewFamily.ThreeDimensional);
if (viewFamilyType == null) {
  return new { success = false, error = "three_dimensional_view_family_type_not_found" };
}

View3D reviewView = new FilteredElementCollector(document)
  .OfClass(typeof(View3D))
  .Cast<View3D>()
  .FirstOrDefault(v => !v.IsTemplate && String.Equals(v.Name, desiredViewName, System.StringComparison.OrdinalIgnoreCase));

bool createdView = false;
if (reviewView == null) {
  reviewView = View3D.CreateIsometric(document, viewFamilyType.Id);
  createdView = true;
  try { reviewView.Name = desiredViewName; }
  catch { reviewView.Name = desiredViewName + " " + reviewView.Id.IntegerValue.ToString(); }
}

reviewView.DetailLevel = ViewDetailLevel.Fine;
reviewView.DisplayStyle = DisplayStyle.ShadingWithEdges;

var targetElements = new List<Element>();
var missingIds = new List<int>();
foreach (int rawId in requestedElementIds) {
  var element = document.GetElement(new ElementId(rawId));
  if (element == null) missingIds.Add(rawId);
  else targetElements.Add(element);
}
if (missingIds.Count > 0) warnings.Add("coordination_element_ids_not_found:" + String.Join(",", missingIds));
if (targetElements.Count == 0) warnings.Add("coordination_no_element_scope_full_3d_view_exported");

BoundingBoxXYZ merged = null;
foreach (var element in targetElements) {
  var box = element.get_BoundingBox(null);
  if (box == null) continue;
  if (merged == null) {
    merged = new BoundingBoxXYZ();
    merged.Min = box.Min;
    merged.Max = box.Max;
  }
  else {
    merged.Min = new XYZ(Math.Min(merged.Min.X, box.Min.X), Math.Min(merged.Min.Y, box.Min.Y), Math.Min(merged.Min.Z, box.Min.Z));
    merged.Max = new XYZ(Math.Max(merged.Max.X, box.Max.X), Math.Max(merged.Max.Y, box.Max.Y), Math.Max(merged.Max.Z, box.Max.Z));
  }
}

if (merged != null) {
  var section = new BoundingBoxXYZ();
  section.Min = new XYZ(merged.Min.X - marginFeet, merged.Min.Y - marginFeet, merged.Min.Z - marginFeet);
  section.Max = new XYZ(merged.Max.X + marginFeet, merged.Max.Y + marginFeet, merged.Max.Z + marginFeet);
  reviewView.IsSectionBoxActive = true;
  reviewView.SetSectionBox(section);
}

var targetGraphics = new OverrideGraphicSettings();
targetGraphics.SetProjectionLineColor(new Color(0, 255, 128));
targetGraphics.SetCutLineColor(new Color(0, 255, 128));
targetGraphics.SetProjectionLineWeight(7);
targetGraphics.SetCutLineWeight(7);

foreach (var element in targetElements) {
  try { reviewView.SetElementOverrides(element.Id, targetGraphics); }
  catch { warnings.Add("coordination_element_override_failed:" + element.Id.IntegerValue.ToString()); }
}

var contextGraphics = new OverrideGraphicSettings();
contextGraphics.SetSurfaceTransparency(contextTransparency);
contextGraphics.SetHalftone(true);

var contextCategories = new List<BuiltInCategory> {
  BuiltInCategory.OST_Walls,
  BuiltInCategory.OST_Floors,
  BuiltInCategory.OST_Ceilings,
  BuiltInCategory.OST_StructuralColumns,
  BuiltInCategory.OST_StructuralFraming,
  BuiltInCategory.OST_Roofs
};
foreach (var bic in contextCategories) {
  var category = Category.GetCategory(document, bic);
  if (category == null) continue;
  try { reviewView.SetCategoryOverrides(category.Id, contextGraphics); }
  catch { warnings.Add("coordination_category_override_failed:" + bic.ToString()); }
}

var before = new HashSet<string>(System.IO.Directory.GetFiles(outputDir).Select(f => System.IO.Path.GetFullPath(f)), System.StringComparer.OrdinalIgnoreCase);
var options = new ImageExportOptions();
options.FilePath = System.IO.Path.Combine(outputDir, sanitize(filePrefix));
options.ExportRange = ExportRange.SetOfViews;
options.ZoomType = ZoomFitType.FitToPage;
options.PixelSize = ${pixelSize};
options.FitDirection = FitDirectionType.${fitDirection};
options.ImageResolution = ImageResolution.${resolution};
options.HLRandWFViewsFileType = ImageFileType.${fileType};
options.ShadowViewsFileType = ImageFileType.${fileType};
options.ShouldCreateWebSite = false;
options.SetViewsAndSheets(new List<ElementId> { reviewView.Id });
document.ExportImage(options);

var files = System.IO.Directory.GetFiles(outputDir)
  .Select(f => System.IO.Path.GetFullPath(f))
  .Where(f => !before.Contains(f))
  .OrderBy(f => f)
  .Select(f => new { path = f, fileName = System.IO.Path.GetFileName(f), bytes = new System.IO.FileInfo(f).Length })
  .ToList();

return new {
  success = files.Count > 0,
  tool = "export_revit_coordination_image",
  revitWriteAction = "review_view_only",
  intent = intent,
  view = new { id = reviewView.Id.IntegerValue, name = reviewView.Name, created = createdView, sectionBoxActive = reviewView.IsSectionBoxActive },
  requestedElementCount = requestedElementIds.Count,
  foundElementCount = targetElements.Count,
  missingElementIds = missingIds,
  outputDir = outputDir,
  filePrefix = filePrefix,
  format = ${csharpString(args.format || "png")},
  pixelSize = ${pixelSize},
  dpi = ${csharpString(String(args.dpi || "300"))},
  files = files,
  warnings = warnings
};`;
        const response = await executeRevitCode(code, {
            ...executionOptionsFromArgs(args),
            taskType: "export_revit_coordination_image",
            transactionMode: "auto",
        });
        return formatJsonContent(response?.result ?? response);
    });
}
