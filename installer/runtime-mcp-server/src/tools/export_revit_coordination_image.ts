// @ts-nocheck
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  connectionTargetSchema,
  csharpString,
  executeRevitCode,
  executionOptionsFromArgs,
  formatJsonContent,
  taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

const intentSchema = z.enum(["raw_evidence", "coordination_overlay", "system_focus", "clash_clearance"]);
const formatSchema = z.enum(["png", "jpg_lossless", "jpg_medium", "tiff", "bmp", "targa"]);
const dpiSchema = z.enum(["72", "150", "300", "600"]);
const fitDirectionSchema = z.enum(["horizontal", "vertical"]);
const targetVisualStyleSchema = z.enum(["auto", "qa_high_contrast", "technical_report", "outline_only", "raw"]);

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

export function resolveAutoTargetVisualStyle(intent) {
  if (intent === "raw_evidence") return "raw";
  if (intent === "coordination_overlay") return "outline_only";
  if (intent === "system_focus") return "technical_report";
  if (intent === "clash_clearance") return "technical_report";
  return "technical_report";
}

export function registerExportRevitCoordinationImageTool(server) {
  server.tool(
    "export_revit_coordination_image",
    "[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",
    {
      ...connectionTargetSchema(z),
      intent: intentSchema.optional().default("coordination_overlay"),
      targetVisualStyle: targetVisualStyleSchema.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),
      elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),
      viewName: z.string().optional().default("DPE Visual QA - Coordination Export"),
      marginMm: z.number().min(0).max(20000).optional().default(2000),
      singleElementMarginMm: z.number().min(0).max(20000).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),
      contextTransparency: z.number().int().min(0).max(90).optional().default(65),
      pixelSize: z.number().int().min(200).max(10000).optional().default(4000).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),
      preExportPixelSize: z.number().int().min(0).max(20000).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),
      maxAutoPreExportPixelSize: z.number().int().min(1000).max(20000).optional().default(10000).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),
      allowFinalUpscale: z.boolean().optional().default(false).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),
      enforcePixelSize: z.boolean().optional().default(true).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),
      cropToTargetHighlight: z.boolean().optional().default(true).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),
      targetMinFillRatio: z.number().min(0.1).max(0.9).optional().default(0.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),
      highlightCropPaddingPx: z.number().int().min(0).max(2000).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),
      dpi: dpiSchema.optional().default("300"),
      fitDirection: fitDirectionSchema.optional().default("horizontal"),
      format: formatSchema.optional().default("png"),
      outputDir: z.string().optional(),
      filePrefix: z.string().optional(),
      cleanupAfterExport: z.boolean().optional().default(false).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),
      ...taskMetadataSchema(z),
      timeoutMs: z.number().int().positive().optional(),
    },
    async (args) => {
      const outputDir = path.resolve(args.outputDir || defaultOutputDir());
      const filePrefix = safePrefix(args.filePrefix);
      const requestedIntent = args.intent || "coordination_overlay";
      const requestedTargetVisualStyle = args.targetVisualStyle || "auto";
      const resolvedTargetVisualStyle = requestedTargetVisualStyle === "auto"
        ? resolveAutoTargetVisualStyle(requestedIntent)
        : requestedTargetVisualStyle;
      const fileType = fileTypeByFormat[args.format || "png"];
      const resolution = resolutionByDpi[String(args.dpi || "150")];
      const fitDirection = fitDirectionByInput[args.fitDirection || "horizontal"];
      const pixelSize = Math.trunc(args.pixelSize || 4000);
      const preExportPixelSize = Number.isFinite(Number(args.preExportPixelSize)) ? Math.max(0, Math.trunc(Number(args.preExportPixelSize))) : 0;
      const maxAutoPreExportPixelSize = Number.isFinite(Number(args.maxAutoPreExportPixelSize)) ? Math.max(1000, Math.min(20000, Math.trunc(Number(args.maxAutoPreExportPixelSize)))) : 10000;
      const allowFinalUpscale = args.allowFinalUpscale === true;
      const marginMm = Number.isFinite(Number(args.marginMm)) ? Number(args.marginMm) : 2000;
      const singleElementMarginMm = Number.isFinite(Number(args.singleElementMarginMm)) ? Number(args.singleElementMarginMm) : 300;
      const enforcePixelSize = args.enforcePixelSize !== false;
      const cropToTargetHighlight = args.cropToTargetHighlight !== false;
      const targetMinFillRatio = Number.isFinite(Number(args.targetMinFillRatio)) ? Math.max(0.1, Math.min(0.9, Number(args.targetMinFillRatio))) : 0.4;
      const highlightCropPaddingPx = Number.isFinite(Number(args.highlightCropPaddingPx)) ? Math.trunc(args.highlightCropPaddingPx) : 24;
      const transparency = Math.trunc(args.contextTransparency ?? 65);
      const cleanupAfterExport = args.cleanupAfterExport === true;

      const code = `
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${csharpString(outputDir)};
string filePrefix = ${csharpString(filePrefix)};
string desiredViewName = ${csharpString(args.viewName || "DPE Visual QA - Coordination Export")};
string intent = ${csharpString(requestedIntent)};
string targetVisualStyle = ${csharpString(resolvedTargetVisualStyle)};
var requestedElementIds = ${csharpIntList(args.elementIds)};
double marginFeet = ${marginMm} / 304.8;
double singleElementMarginFeet = ${singleElementMarginMm} / 304.8;
int contextTransparency = ${transparency};
int requestedPixelSize = ${pixelSize};
int requestedPreExportPixelSize = ${preExportPixelSize};
int maxAutoPreExportPixelSize = ${maxAutoPreExportPixelSize};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${csharpString(args.fitDirection || "horizontal")};
bool enforcePixelSize = ${enforcePixelSize ? "true" : "false"};
bool cropToTargetHighlight = ${cropToTargetHighlight ? "true" : "false"};
bool allowFinalUpscale = ${allowFinalUpscale ? "true" : "false"};
double targetMinFillRatio = ${targetMinFillRatio};
int highlightCropPaddingPx = ${highlightCropPaddingPx};
bool cleanupAfterExport = ${cleanupAfterExport ? "true" : "false"};

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

bool sectionBoxApplied = false;
bool cameraFramedToTargets = false;
double framingDistanceFeet = 0.0;
string framingMode = "full_3d_view";
bool targetCropEstimateAvailable = false;
double targetCropCenterXRatio = 0.5;
double targetCropCenterYRatio = 0.5;
double targetCropFillRatioEstimate = 0.0;
bool modelCropBoxApplied = false;
double modelCropBoxTargetFillRatio = 0.0;

Func<BoundingBoxXYZ, XYZ, double> projectedExtentOnAxis = (box, axis) => {
  if (box == null || axis == null) return 0.0;
  var points = new List<XYZ> {
    new XYZ(box.Min.X, box.Min.Y, box.Min.Z),
    new XYZ(box.Min.X, box.Min.Y, box.Max.Z),
    new XYZ(box.Min.X, box.Max.Y, box.Min.Z),
    new XYZ(box.Min.X, box.Max.Y, box.Max.Z),
    new XYZ(box.Max.X, box.Min.Y, box.Min.Z),
    new XYZ(box.Max.X, box.Min.Y, box.Max.Z),
    new XYZ(box.Max.X, box.Max.Y, box.Min.Z),
    new XYZ(box.Max.X, box.Max.Y, box.Max.Z)
  };
  double min = Double.MaxValue;
  double max = Double.MinValue;
  foreach (var point in points) {
    double value = point.DotProduct(axis);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max < min) return 0.0;
  return max - min;
};

if (merged != null) {
  double effectiveMarginFeet = targetElements.Count == 1 ? Math.Min(marginFeet, singleElementMarginFeet) : marginFeet;
  var section = new BoundingBoxXYZ();
  section.Min = new XYZ(merged.Min.X - effectiveMarginFeet, merged.Min.Y - effectiveMarginFeet, merged.Min.Z - effectiveMarginFeet);
  section.Max = new XYZ(merged.Max.X + effectiveMarginFeet, merged.Max.Y + effectiveMarginFeet, merged.Max.Z + effectiveMarginFeet);
  reviewView.IsSectionBoxActive = true;
  reviewView.SetSectionBox(section);
  sectionBoxApplied = true;
  framingMode = "section_box_and_camera";

  try {
    XYZ center = new XYZ(
      (section.Min.X + section.Max.X) / 2.0,
      (section.Min.Y + section.Max.Y) / 2.0,
      (section.Min.Z + section.Max.Z) / 2.0);
    double dx = Math.Max(0.1, section.Max.X - section.Min.X);
    double dy = Math.Max(0.1, section.Max.Y - section.Min.Y);
    double dz = Math.Max(0.1, section.Max.Z - section.Min.Z);
    double diagonal = Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz));
    XYZ forward = new XYZ(-0.60, -0.60, -0.50).Normalize();
    XYZ right = XYZ.BasisZ.CrossProduct(forward);
    if (right.GetLength() < 0.000001) right = XYZ.BasisX;
    right = right.Normalize();
    XYZ up = forward.CrossProduct(right).Normalize();

    framingDistanceFeet = Math.Max(diagonal * 2.25, 10.0);
    XYZ eye = center.Subtract(forward.Multiply(framingDistanceFeet));
    reviewView.SetOrientation(new ViewOrientation3D(eye, up, forward));
    try { reviewView.CropBoxActive = true; } catch {}
    try { reviewView.CropBoxVisible = false; } catch {}
    try {
      var viewCrop = reviewView.CropBox;
      if (viewCrop != null && viewCrop.Transform != null) {
        var inverseCropTransform = viewCrop.Transform.Inverse;
        var targetPoints = new List<XYZ> {
          new XYZ(merged.Min.X, merged.Min.Y, merged.Min.Z),
          new XYZ(merged.Min.X, merged.Min.Y, merged.Max.Z),
          new XYZ(merged.Min.X, merged.Max.Y, merged.Min.Z),
          new XYZ(merged.Min.X, merged.Max.Y, merged.Max.Z),
          new XYZ(merged.Max.X, merged.Min.Y, merged.Min.Z),
          new XYZ(merged.Max.X, merged.Min.Y, merged.Max.Z),
          new XYZ(merged.Max.X, merged.Max.Y, merged.Min.Z),
          new XYZ(merged.Max.X, merged.Max.Y, merged.Max.Z)
        };
        double minLocalX = Double.MaxValue;
        double maxLocalX = Double.MinValue;
        double minLocalY = Double.MaxValue;
        double maxLocalY = Double.MinValue;
        foreach (var point in targetPoints) {
          var local = inverseCropTransform.OfPoint(point);
          if (local.X < minLocalX) minLocalX = local.X;
          if (local.X > maxLocalX) maxLocalX = local.X;
          if (local.Y < minLocalY) minLocalY = local.Y;
          if (local.Y > maxLocalY) maxLocalY = local.Y;
        }
        if (cropToTargetHighlight && targetElements.Count == 1) {
          try {
            double safeFillRatioForViewCrop = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
            double targetLocalSpanX = Math.Max(0.000001, maxLocalX - minLocalX);
            double targetLocalSpanY = Math.Max(0.000001, maxLocalY - minLocalY);
            double desiredLocalSpan = Math.Max(targetLocalSpanX, targetLocalSpanY) / safeFillRatioForViewCrop;
            double centerLocalXForCrop = (minLocalX + maxLocalX) / 2.0;
            double centerLocalYForCrop = (minLocalY + maxLocalY) / 2.0;
            var tightenedCrop = new BoundingBoxXYZ();
            tightenedCrop.Transform = viewCrop.Transform;
            tightenedCrop.Min = new XYZ(
              centerLocalXForCrop - (desiredLocalSpan / 2.0),
              centerLocalYForCrop - (desiredLocalSpan / 2.0),
              viewCrop.Min.Z);
            tightenedCrop.Max = new XYZ(
              centerLocalXForCrop + (desiredLocalSpan / 2.0),
              centerLocalYForCrop + (desiredLocalSpan / 2.0),
              viewCrop.Max.Z);
            reviewView.CropBox = tightenedCrop;
            modelCropBoxApplied = true;
            viewCrop = reviewView.CropBox;
            inverseCropTransform = viewCrop.Transform.Inverse;
            minLocalX = Double.MaxValue;
            maxLocalX = Double.MinValue;
            minLocalY = Double.MaxValue;
            maxLocalY = Double.MinValue;
            foreach (var point in targetPoints) {
              var local = inverseCropTransform.OfPoint(point);
              if (local.X < minLocalX) minLocalX = local.X;
              if (local.X > maxLocalX) maxLocalX = local.X;
              if (local.Y < minLocalY) minLocalY = local.Y;
              if (local.Y > maxLocalY) maxLocalY = local.Y;
            }
          }
          catch (Exception ex) {
            warnings.Add("coordination_model_crop_box_tighten_failed:" + ex.Message);
          }
        }
        double cropSpanX = Math.Max(0.000001, viewCrop.Max.X - viewCrop.Min.X);
        double cropSpanY = Math.Max(0.000001, viewCrop.Max.Y - viewCrop.Min.Y);
        double centerLocalX = (minLocalX + maxLocalX) / 2.0;
        double centerLocalY = (minLocalY + maxLocalY) / 2.0;
        targetCropCenterXRatio = Math.Max(0.02, Math.Min(0.98, (centerLocalX - viewCrop.Min.X) / cropSpanX));
        targetCropCenterYRatio = Math.Max(0.02, Math.Min(0.98, 1.0 - ((centerLocalY - viewCrop.Min.Y) / cropSpanY)));
        targetCropFillRatioEstimate = Math.Max((maxLocalX - minLocalX) / cropSpanX, (maxLocalY - minLocalY) / cropSpanY);
        modelCropBoxTargetFillRatio = targetCropFillRatioEstimate;
        targetCropEstimateAvailable = targetCropFillRatioEstimate > 0.0;
      }
    }
    catch (Exception ex) {
      warnings.Add("coordination_bbox_crop_estimate_failed:" + ex.Message);
    }
    cameraFramedToTargets = true;
  }
  catch (Exception ex) {
    warnings.Add("coordination_camera_frame_failed:" + ex.Message);
  }
}

bool targetOverrideApplied = false;
string targetOverrideMode = targetVisualStyle;
int targetOverrideResetCount = 0;
foreach (var element in targetElements) {
  try {
    reviewView.SetElementOverrides(element.Id, new OverrideGraphicSettings());
    targetOverrideResetCount++;
  }
  catch { warnings.Add("coordination_element_override_reset_failed:" + element.Id.IntegerValue.ToString()); }
}

if (!String.Equals(targetVisualStyle, "raw", System.StringComparison.OrdinalIgnoreCase)) {
  var targetGraphics = new OverrideGraphicSettings();
  bool isQaHighContrast = String.Equals(targetVisualStyle, "qa_high_contrast", System.StringComparison.OrdinalIgnoreCase);
  bool isTechnicalReport = String.Equals(targetVisualStyle, "technical_report", System.StringComparison.OrdinalIgnoreCase);
  bool isOutlineOnly = String.Equals(targetVisualStyle, "outline_only", System.StringComparison.OrdinalIgnoreCase);
  var targetColor = isQaHighContrast
    ? new Color(0, 255, 128)
    : new Color(0, 170, 255);
  int lineWeight = isQaHighContrast ? 12 : 1;
  int surfaceTransparency = isQaHighContrast ? 1 : (isOutlineOnly ? 100 : 85);
  bool applySurfaceFill =
    isQaHighContrast ||
    isTechnicalReport;

  targetGraphics.SetProjectionLineColor(targetColor);
  targetGraphics.SetCutLineColor(targetColor);
  targetGraphics.SetProjectionLineWeight(lineWeight);
  targetGraphics.SetCutLineWeight(lineWeight);
  try { targetGraphics.SetHalftone(false); } catch {}
  try { targetGraphics.SetSurfaceTransparency(surfaceTransparency); } catch {}
  if (applySurfaceFill) {
    try {
      var solidFill = new FilteredElementCollector(document)
        .OfClass(typeof(FillPatternElement))
        .Cast<FillPatternElement>()
        .FirstOrDefault(fp => fp.GetFillPattern() != null && fp.GetFillPattern().IsSolidFill);
      if (solidFill != null) {
        targetGraphics.SetSurfaceForegroundPatternId(solidFill.Id);
        targetGraphics.SetSurfaceForegroundPatternColor(targetColor);
        targetGraphics.SetSurfaceForegroundPatternVisible(true);
        targetGraphics.SetCutForegroundPatternId(solidFill.Id);
        targetGraphics.SetCutForegroundPatternColor(targetColor);
        targetGraphics.SetCutForegroundPatternVisible(true);
      }
    }
    catch (Exception ex) {
      warnings.Add("coordination_target_surface_override_failed:" + ex.Message);
    }
  }

  foreach (var element in targetElements) {
    try {
      reviewView.SetElementOverrides(element.Id, targetGraphics);
      targetOverrideApplied = true;
    }
    catch { warnings.Add("coordination_element_override_failed:" + element.Id.IntegerValue.ToString()); }
  }
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

if (requestedPreExportPixelSize > 0) {
  revitExportPixelSize = Math.Max(200, Math.Min(20000, requestedPreExportPixelSize));
  preExportPixelSizeReason = "explicit_pre_export_pixel_size";
}
else if (cropToTargetHighlight && targetElements.Count == 1 && targetCropEstimateAvailable && targetCropFillRatioEstimate > 0.000001) {
  double safeFillRatioForSource = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
  int neededSourceSize = (int)Math.Ceiling((double)requestedPixelSize * safeFillRatioForSource / Math.Max(0.000001, targetCropFillRatioEstimate));
  revitExportPixelSize = Math.Max(requestedPixelSize, Math.Min(maxAutoPreExportPixelSize, neededSourceSize));
  preExportPixelSizeReason = revitExportPixelSize > requestedPixelSize
    ? "auto_model_bbox_projection_source_resolution"
    : "auto_same_as_final_pixel_size";
}

var options = new ImageExportOptions();
options.FilePath = System.IO.Path.Combine(outputDir, sanitize(filePrefix));
options.ExportRange = ExportRange.SetOfViews;
options.ZoomType = ZoomFitType.FitToPage;
options.PixelSize = revitExportPixelSize;
options.FitDirection = FitDirectionType.${fitDirection};
options.ImageResolution = ImageResolution.${resolution};
options.HLRandWFViewsFileType = ImageFileType.${fileType};
options.ShadowViewsFileType = ImageFileType.${fileType};
options.ShouldCreateWebSite = false;
options.SetViewsAndSheets(new List<ElementId> { reviewView.Id });
document.ExportImage(options);

Func<byte[], int, int> readInt32BigEndian = (bytes, offset) =>
  (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
Func<byte[], int, int> readInt16BigEndian = (bytes, offset) =>
  (bytes[offset] << 8) | bytes[offset + 1];
Func<byte[], int, int> readInt16LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8);
Func<byte[], int, int> readInt32LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
Func<string, int[]> readImageSize = (f) => {
  byte[] bytes = System.IO.File.ReadAllBytes(f);
  if (bytes.Length >= 24 &&
      bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
    return new int[] { readInt32BigEndian(bytes, 16), readInt32BigEndian(bytes, 20) };
  }
  if (bytes.Length >= 26 && bytes[0] == 0x42 && bytes[1] == 0x4D) {
    return new int[] { readInt32LittleEndian(bytes, 18), Math.Abs(readInt32LittleEndian(bytes, 22)) };
  }
  if (bytes.Length >= 18) {
    string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
    if (extension == ".tga" || extension == ".targa") {
      int tgaWidth = readInt16LittleEndian(bytes, 12);
      int tgaHeight = readInt16LittleEndian(bytes, 14);
      if (tgaWidth > 0 && tgaHeight > 0) return new int[] { tgaWidth, tgaHeight };
    }
  }
  if (bytes.Length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8) {
    int offset = 2;
    while (offset + 9 < bytes.Length) {
      if (bytes[offset] != 0xFF) { offset++; continue; }
      byte marker = bytes[offset + 1];
      if (marker == 0xD8 || marker == 0xD9) { offset += 2; continue; }
      int segmentLength = readInt16BigEndian(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.Length) break;
      bool isSof = (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC);
      if (isSof && offset + 8 < bytes.Length) {
        return new int[] { readInt16BigEndian(bytes, offset + 7), readInt16BigEndian(bytes, offset + 5) };
      }
      offset += 2 + segmentLength;
    }
  }
  if (bytes.Length >= 16 &&
      ((bytes[0] == 0x49 && bytes[1] == 0x49) || (bytes[0] == 0x4D && bytes[1] == 0x4D))) {
    bool little = bytes[0] == 0x49;
    Func<int, int> read16 = (offset) => little ? readInt16LittleEndian(bytes, offset) : readInt16BigEndian(bytes, offset);
    Func<int, int> read32 = (offset) => little ? readInt32LittleEndian(bytes, offset) : readInt32BigEndian(bytes, offset);
    int ifdOffset = read32(4);
    if (ifdOffset > 0 && ifdOffset + 2 < bytes.Length) {
      int entries = read16(ifdOffset);
      int width = 0;
      int height = 0;
      for (int i = 0; i < entries; i++) {
        int entryOffset = ifdOffset + 2 + (i * 12);
        if (entryOffset + 12 > bytes.Length) break;
        int tag = read16(entryOffset);
        int value = read32(entryOffset + 8);
        if (tag == 256) width = value;
        if (tag == 257) height = value;
      }
      if (width > 0 && height > 0) return new int[] { width, height };
    }
  }
  return null;
};

Func<string, int[], bool> resizeImageToRequestedPixelSize = (f, size) => {
  if (!enforcePixelSize || requestedPixelSize <= 0 || size == null || size.Length != 2) return false;
  int originalWidth = size[0];
  int originalHeight = size[1];
  if (originalWidth <= 0 || originalHeight <= 0) return false;

  int targetWidth = originalWidth;
  int targetHeight = originalHeight;
  if (String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)) {
    targetHeight = requestedPixelSize;
    targetWidth = Math.Max(1, (int)Math.Round((double)originalWidth * (double)targetHeight / (double)originalHeight));
  }
  else {
    targetWidth = requestedPixelSize;
    targetHeight = Math.Max(1, (int)Math.Round((double)originalHeight * (double)targetWidth / (double)originalWidth));
  }

  if (targetWidth == originalWidth && targetHeight == originalHeight) return false;

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_resize_unsupported_format:" + System.IO.Path.GetFileName(f));
    return false;
  }

  string tempFile = f + ".resize-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
    source.CreateOptions = System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreImageCache;
    source.UriSource = new Uri(f, UriKind.Absolute);
    source.EndInit();
    source.Freeze();

    double scaleX = (double)targetWidth / (double)source.PixelWidth;
    double scaleY = (double)targetHeight / (double)source.PixelHeight;
    var resized = new System.Windows.Media.Imaging.TransformedBitmap(source, new System.Windows.Media.ScaleTransform(scaleX, scaleY));
    resized.Freeze();

    var encoder = createEncoder();
    encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(resized));
    using (var stream = new System.IO.FileStream(tempFile, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
      encoder.Save(stream);
    }
    System.IO.File.Delete(f);
    System.IO.File.Move(tempFile, f);
    return true;
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_resize_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return false;
  }
};

Func<string, object[]> analyzeCoordinationImageQuality = (f) => {
  if (!cropToTargetHighlight || targetElements.Count == 0) {
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_highlight_crop_unsupported_format:" + System.IO.Path.GetFileName(f));
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }

  string tempFile = f + ".crop-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
    source.CreateOptions = System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreImageCache;
    source.UriSource = new Uri(f, UriKind.Absolute);
    source.EndInit();
    source.Freeze();

    var converted = new System.Windows.Media.Imaging.FormatConvertedBitmap(source, System.Windows.Media.PixelFormats.Bgra32, null, 0);
    converted.Freeze();
    int width = converted.PixelWidth;
    int height = converted.PixelHeight;
    int stride = width * 4;
    byte[] pixels = new byte[stride * height];
    converted.CopyPixels(pixels, stride, 0);

    int minX = width;
    int minY = height;
    int maxX = -1;
    int maxY = -1;
    int highlightCount = 0;
    for (int y = 0; y < height; y++) {
      int row = y * stride;
      for (int x = 0; x < width; x++) {
        int offset = row + (x * 4);
        int b = pixels[offset];
        int g = pixels[offset + 1];
        int r = pixels[offset + 2];
        bool isTargetGreen =
          (g >= 135 && g > r + 45 && g > b + 25 && r <= 150 && b <= 190) ||
          (g >= 105 && g > r + 25 && g > b + 10 && r <= 190 && b <= 220);
        bool isTargetYellow =
          (r >= 135 && g >= 110 && b <= 190 && r > b + 35 && g > b + 25);
        bool isTargetCyan =
          (g >= 115 && b >= 95 && r <= 180 && g > r + 20 && b > r + 10);
        int maxChannel = Math.Max(r, Math.Max(g, b));
        int minChannel = Math.Min(r, Math.Min(g, b));
        bool isTargetHighChroma =
          (maxChannel >= 140 && (maxChannel - minChannel) >= 80 && g >= 95 && r <= 245 && b <= 245);
        bool isTargetHighlight = isTargetGreen || isTargetYellow || isTargetCyan || isTargetHighChroma;
        if (!isTargetHighlight) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        highlightCount++;
      }
    }

    bool highlightPixelsDetected = highlightCount >= 8 && maxX >= minX && maxY >= minY;
    if (!highlightPixelsDetected) {
      if (String.Equals(targetVisualStyle, "raw", System.StringComparison.OrdinalIgnoreCase) ||
          String.Equals(targetVisualStyle, "outline_only", System.StringComparison.OrdinalIgnoreCase)) {
        notices.Add("target_highlight_pixels_not_detected_visual_style_expected:" + targetVisualStyle + ":" + System.IO.Path.GetFileName(f));
      }
      else {
        warnings.Add("target_highlight_pixels_not_detected:" + System.IO.Path.GetFileName(f));
      }
    }

    bool modelProjectionAvailable = targetCropEstimateAvailable && targetElements.Count == 1;
    bool allowPostProcessCrop = !modelCropBoxApplied;
    int cropX = 0;
    int cropY = 0;
    int cropWidth = width;
    int cropHeight = height;
    int estimatedMaxTargetDimension = 0;
    double estimatedTargetFillRatio = 0.0;
    string cropBasis = "none";

    if (modelProjectionAvailable && allowPostProcessCrop) {
      double safeFillRatio = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
      int minImageSide = Math.Max(1, Math.Min(width, height));
      estimatedMaxTargetDimension = Math.Max(8, (int)Math.Round(Math.Max(0.01, Math.Min(1.0, targetCropFillRatioEstimate)) * (double)minImageSide));
      int projectionDesiredSide = Math.Max(24, (int)Math.Ceiling((double)estimatedMaxTargetDimension / safeFillRatio));
      int contextGuardSide = Math.Max(24, (int)Math.Round((double)minImageSide * Math.Max(0.02, Math.Min(0.18, 0.04 / safeFillRatio))));
      int desiredSide = Math.Min(minImageSide, Math.Max(24, Math.Min(projectionDesiredSide, contextGuardSide)));
      cropWidth = Math.Min(width, desiredSide);
      cropHeight = Math.Min(height, desiredSide);
      if (enforcePixelSize && !allowFinalUpscale) {
        int minimumSourceCropSide = Math.Min(minImageSide, Math.Max(1, requestedPixelSize));
        if (cropWidth < minimumSourceCropSide || cropHeight < minimumSourceCropSide) {
          cropWidth = Math.Min(width, Math.Max(cropWidth, minimumSourceCropSide));
          cropHeight = Math.Min(height, Math.Max(cropHeight, minimumSourceCropSide));
          if (projectionDesiredSide < minimumSourceCropSide) {
            warnings.Add("target_fill_limited_by_source_resolution:" + System.IO.Path.GetFileName(f));
          }
        }
      }
      double centerX = Math.Max(0.0, Math.Min(1.0, targetCropCenterXRatio)) * (double)width;
      double centerY = Math.Max(0.0, Math.Min(1.0, targetCropCenterYRatio)) * (double)height;
      cropX = (int)Math.Round(centerX - ((double)cropWidth / 2.0));
      cropY = (int)Math.Round(centerY - ((double)cropHeight / 2.0));
      if (cropX < 0) cropX = 0;
      if (cropY < 0) cropY = 0;
      if (cropX + cropWidth > width) cropX = Math.Max(0, width - cropWidth);
      if (cropY + cropHeight > height) cropY = Math.Max(0, height - cropHeight);
      estimatedTargetFillRatio = (double)estimatedMaxTargetDimension / (double)Math.Max(cropWidth, cropHeight);
      cropBasis = "model_bbox_projection_post_crop";
    }
    else if (!modelProjectionAvailable && allowPostProcessCrop && highlightPixelsDetected) {
      int highlightWidth = Math.Max(1, maxX - minX + 1);
      int highlightHeight = Math.Max(1, maxY - minY + 1);
      int maxHighlightDimensionForCrop = Math.Max(highlightWidth, highlightHeight);
      double safeFillRatio = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
      int ratioLimitedSide = Math.Max(maxHighlightDimensionForCrop, (int)Math.Ceiling((double)maxHighlightDimensionForCrop / safeFillRatio));
      int paddedSide = maxHighlightDimensionForCrop + (2 * Math.Max(0, highlightCropPaddingPx));
      int desiredSide = Math.Max(maxHighlightDimensionForCrop + 2, Math.Min(ratioLimitedSide, paddedSide));
      cropWidth = Math.Min(width, desiredSide);
      cropHeight = Math.Min(height, desiredSide);
      if (cropWidth < highlightWidth) cropWidth = Math.Min(width, highlightWidth);
      if (cropHeight < highlightHeight) cropHeight = Math.Min(height, highlightHeight);
      double centerX = ((double)minX + (double)maxX) / 2.0;
      double centerY = ((double)minY + (double)maxY) / 2.0;
      cropX = (int)Math.Round(centerX - ((double)cropWidth / 2.0));
      cropY = (int)Math.Round(centerY - ((double)cropHeight / 2.0));
      if (cropX < 0) cropX = 0;
      if (cropY < 0) cropY = 0;
      if (cropX + cropWidth > width) cropX = Math.Max(0, width - cropWidth);
      if (cropY + cropHeight > height) cropY = Math.Max(0, height - cropHeight);
      cropBasis = "highlight_pixels_post_crop_fallback";
    }
    else if (modelProjectionAvailable) {
      int fullImageHighlightDimension = 0;
      double fullImageHighlightFillRatio = 0.0;
      if (highlightPixelsDetected) {
        int highlightWidth = Math.Max(1, maxX - minX + 1);
        int highlightHeight = Math.Max(1, maxY - minY + 1);
        fullImageHighlightDimension = Math.Max(highlightWidth, highlightHeight);
        fullImageHighlightFillRatio = (double)fullImageHighlightDimension / (double)Math.Max(width, height);
      }
      return new object[] { false, width, height, 0, 0, width, height, 0, highlightCount, fullImageHighlightDimension, targetMinFillRatio, fullImageHighlightFillRatio, "model_bbox_projection", targetCropFillRatioEstimate, highlightPixelsDetected };
    }

    if (cropWidth <= 0 || cropHeight <= 0 ||
        (cropWidth >= width * 0.98 && cropHeight >= height * 0.98)) {
      int fullImageHighlightDimension = 0;
      double fullImageHighlightFillRatio = 0.0;
      if (highlightPixelsDetected) {
        int highlightWidth = Math.Max(1, maxX - minX + 1);
        int highlightHeight = Math.Max(1, maxY - minY + 1);
        fullImageHighlightDimension = Math.Max(highlightWidth, highlightHeight);
        fullImageHighlightFillRatio = (double)fullImageHighlightDimension / (double)Math.Max(width, height);
      }
      string nonRasterCropBasis = modelProjectionAvailable ? "model_bbox_projection" : "none";
      return new object[] { false, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, fullImageHighlightDimension, targetMinFillRatio, fullImageHighlightFillRatio, nonRasterCropBasis, estimatedTargetFillRatio, highlightPixelsDetected };
    }

    int maxHighlightDimension = 0;
    double actualHighlightFillRatio = 0.0;
    if (highlightPixelsDetected) {
      int overlapMinX = Math.Max(minX, cropX);
      int overlapMinY = Math.Max(minY, cropY);
      int overlapMaxX = Math.Min(maxX, cropX + cropWidth - 1);
      int overlapMaxY = Math.Min(maxY, cropY + cropHeight - 1);
      if (overlapMaxX >= overlapMinX && overlapMaxY >= overlapMinY) {
        int overlapWidth = overlapMaxX - overlapMinX + 1;
        int overlapHeight = overlapMaxY - overlapMinY + 1;
        maxHighlightDimension = Math.Max(overlapWidth, overlapHeight);
        actualHighlightFillRatio = (double)maxHighlightDimension / (double)Math.Max(cropWidth, cropHeight);
        if (cropBasis.StartsWith("model_bbox_projection") && actualHighlightFillRatio < targetMinFillRatio) {
          warnings.Add("target_highlight_pixels_below_requested_fill:" + System.IO.Path.GetFileName(f));
        }
      }
      else {
        warnings.Add("target_highlight_pixels_outside_model_crop:" + System.IO.Path.GetFileName(f));
      }
    }

    var cropped = new System.Windows.Media.Imaging.CroppedBitmap(converted, new System.Windows.Int32Rect(cropX, cropY, cropWidth, cropHeight));
    cropped.Freeze();
    var encoder = createEncoder();
    encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(cropped));
    using (var stream = new System.IO.FileStream(tempFile, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
      encoder.Save(stream);
    }
    System.IO.File.Delete(f);
    System.IO.File.Move(tempFile, f);
    return new object[] { true, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, maxHighlightDimension, targetMinFillRatio, actualHighlightFillRatio, cropBasis, estimatedTargetFillRatio, highlightPixelsDetected };
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_coordination_quality_analysis_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }
};

Func<string, object> buildFileSummary = (f) => {
  int? width = null;
  int? height = null;
  bool resizedToRequestedPixelSize = false;
  bool croppedToTargetHighlight = false;
  int highlightPixelCount = 0;
  bool highlightPixelsDetected = false;
  double actualHighlightFillRatio = 0.0;
  double estimatedTargetFillRatio = 0.0;
  bool sourceCropUpscaledToFinal = false;
  bool postProcessedCropApplied = false;
  bool rasterPostCropApplied = false;
  string cropBasis = "none";
  object highlightCrop = null;
  try {
    object[] crop = analyzeCoordinationImageQuality(f);
    if (crop != null && crop.Length >= 12) {
      croppedToTargetHighlight = crop[0] is bool && (bool)crop[0];
      postProcessedCropApplied = croppedToTargetHighlight;
      highlightPixelCount = Convert.ToInt32(crop[8]);
      actualHighlightFillRatio = Convert.ToDouble(crop[11], System.Globalization.CultureInfo.InvariantCulture);
      if (crop.Length >= 13 && crop[12] != null) cropBasis = crop[12].ToString();
      rasterPostCropApplied = croppedToTargetHighlight && cropBasis.StartsWith("highlight_pixels");
      if (crop.Length >= 14 && crop[13] != null) estimatedTargetFillRatio = Convert.ToDouble(crop[13], System.Globalization.CultureInfo.InvariantCulture);
      if (crop.Length >= 15 && crop[14] != null) highlightPixelsDetected = Convert.ToBoolean(crop[14]);
      if (croppedToTargetHighlight) {
        int sourceCropWidth = Convert.ToInt32(crop[5]);
        int sourceCropHeight = Convert.ToInt32(crop[6]);
        int sourceFitDimension = String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)
          ? sourceCropHeight
          : sourceCropWidth;
        sourceCropUpscaledToFinal = enforcePixelSize && sourceFitDimension > 0 && sourceFitDimension < requestedPixelSize;
        if (sourceCropUpscaledToFinal) {
          warnings.Add("image_source_crop_below_final_pixel_size:" + System.IO.Path.GetFileName(f));
        }
        highlightCrop = new {
          originalWidth = Convert.ToInt32(crop[1]),
          originalHeight = Convert.ToInt32(crop[2]),
          x = Convert.ToInt32(crop[3]),
          y = Convert.ToInt32(crop[4]),
          width = sourceCropWidth,
          height = sourceCropHeight,
          maxHighlightDimension = Convert.ToInt32(crop[9]),
          targetMinFillRatio = Convert.ToDouble(crop[10], System.Globalization.CultureInfo.InvariantCulture),
          actualHighlightFillRatio = actualHighlightFillRatio,
          estimatedTargetFillRatio = estimatedTargetFillRatio,
          sourceCropUpscaledToFinal = sourceCropUpscaledToFinal,
          cropBasis = cropBasis
        };
      }
    }
    int[] size = readImageSize(f);
    resizedToRequestedPixelSize = resizeImageToRequestedPixelSize(f, size);
    if (resizedToRequestedPixelSize) size = readImageSize(f);
    if (size != null && size.Length == 2) {
      width = size[0];
      height = size[1];
    }
  }
  catch (Exception ex) {
    warnings.Add("image_dimension_probe_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
  }

  return new {
    path = f,
    fileName = System.IO.Path.GetFileName(f),
    bytes = new System.IO.FileInfo(f).Length,
    width = width,
    height = height,
    requestedPixelSize = requestedPixelSize,
    preExportPixelSize = revitExportPixelSize,
    requestedPreExportPixelSize = requestedPreExportPixelSize,
    autoPreExportPixelSize = autoPreExportPixelSize,
    preExportPixelSizeReason = preExportPixelSizeReason,
    resizedToRequestedPixelSize = resizedToRequestedPixelSize,
    sourceCropUpscaledToFinal = sourceCropUpscaledToFinal,
    croppedToTargetHighlight = croppedToTargetHighlight,
    postProcessedCropApplied = postProcessedCropApplied,
    rasterPostCropApplied = rasterPostCropApplied,
    croppedToModelProjection = cropBasis.StartsWith("model_bbox_projection"),
    highlightPixelCount = highlightPixelCount,
    highlightPixelsDetected = highlightPixelsDetected,
    targetMinFillRatio = targetMinFillRatio,
    actualHighlightFillRatio = actualHighlightFillRatio,
    estimatedTargetFillRatio = estimatedTargetFillRatio,
    cropBasis = cropBasis,
    highlightCrop = highlightCrop
  };
};

var files = System.IO.Directory.GetFiles(outputDir)
  .Select(f => System.IO.Path.GetFullPath(f))
  .Where(f => !before.Contains(f))
  .OrderBy(f => f)
  .Select(f => buildFileSummary(f))
  .ToList();

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${marginMm}, ${singleElementMarginMm}) : ${marginMm};
int reviewViewIdForReport = reviewView.Id.IntegerValue;
string reviewViewNameForReport = reviewView.Name;
bool reviewViewSectionBoxActiveForReport = reviewView.IsSectionBoxActive;
bool cleanupAfterExportApplied = false;
bool cleanupDeletedCreatedView = false;
string cleanupNote = createdView
  ? "A reusable review view was created and kept for audit/reuse. Delete it manually only if this QA view is no longer needed."
  : "Existing reusable review view was updated and kept.";

if (cleanupAfterExport) {
  if (createdView) {
    try {
      document.Delete(reviewView.Id);
      document.Regenerate();
      cleanupAfterExportApplied = document.GetElement(new ElementId(reviewViewIdForReport)) == null;
      cleanupDeletedCreatedView = cleanupAfterExportApplied;
      cleanupNote = cleanupAfterExportApplied
        ? "The review view created by this export was deleted after the image file was produced."
        : "cleanupAfterExport was requested, but the created review view still appears to exist. Check warnings.";
      if (!cleanupAfterExportApplied) warnings.Add("coordination_cleanup_created_view_not_confirmed");
    }
    catch (Exception ex) {
      cleanupNote = "cleanupAfterExport was requested, but deleting the created review view failed.";
      warnings.Add("coordination_cleanup_created_view_failed:" + ex.Message);
    }
  }
  else {
    cleanupNote = "cleanupAfterExport was requested, but the review view already existed and was kept to avoid deleting operator-owned project data.";
    notices.Add("coordination_cleanup_skipped_existing_review_view");
  }
}

return new {
  success = files.Count > 0,
  tool = "export_revit_coordination_image",
  revitWriteAction = cleanupDeletedCreatedView ? "temporary_review_view_export" : "review_view_only",
  intent = intent,
  targetVisualStyle = targetVisualStyle,
  targetOverrideApplied = targetOverrideApplied,
  targetOverrideMode = targetOverrideMode,
  targetOverrideResetCount = targetOverrideResetCount,
  view = new { id = reviewViewIdForReport, name = reviewViewNameForReport, created = createdView, sectionBoxActive = reviewViewSectionBoxActiveForReport, deletedAfterExport = cleanupDeletedCreatedView },
  createdViews = createdView
    ? new object[] { new { id = reviewViewIdForReport, name = reviewViewNameForReport, purpose = "coordination_image_review_view", deletedAfterExport = cleanupDeletedCreatedView } }
    : new object[] {},
  cleanup = new {
    cleanupAfterExportRequested = cleanupAfterExport,
    cleanupAfterExportApplied = cleanupAfterExportApplied,
    deletedCreatedView = cleanupDeletedCreatedView,
    note = cleanupNote
  },
  framing = new {
    mode = framingMode,
    sectionBoxApplied = sectionBoxApplied,
    cameraFramedToTargets = cameraFramedToTargets,
    modelCropBoxApplied = modelCropBoxApplied,
    modelCropBoxTargetFillRatio = modelCropBoxTargetFillRatio,
    framingDistanceFeet = framingDistanceFeet
  },
  requestedElementCount = requestedElementIds.Count,
  foundElementCount = targetElements.Count,
  missingElementIds = missingIds,
  outputDir = outputDir,
  filePrefix = filePrefix,
  format = ${csharpString(args.format || "png")},
  pixelSize = ${pixelSize},
  requestedPixelSize = ${pixelSize},
  preExportPixelSize = revitExportPixelSize,
  requestedPreExportPixelSize = requestedPreExportPixelSize,
  maxAutoPreExportPixelSize = maxAutoPreExportPixelSize,
  autoPreExportPixelSize = autoPreExportPixelSize,
  preExportPixelSizeReason = preExportPixelSizeReason,
  enforcePixelSize = enforcePixelSize,
  cropToTargetHighlight = cropToTargetHighlight,
  allowFinalUpscale = allowFinalUpscale,
  targetMinFillRatio = targetMinFillRatio,
  highlightCropPaddingPx = highlightCropPaddingPx,
  pixelSizeNote = enforcePixelSize
    ? "For coordination crops, Revit may export a higher-resolution source first, crop that source, then downsample to requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the final request, and preExportPixelSize is the Revit source export request. Check files[].width and files[].height for actual output dimensions.",
  marginMm = ${marginMm},
  singleElementMarginMm = ${singleElementMarginMm},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${csharpString(String(args.dpi || "300"))},
  fitDirection = ${csharpString(args.fitDirection || "horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;

      const response = await executeRevitCode(code, {
        ...executionOptionsFromArgs(args),
        taskType: "export_revit_coordination_image",
        transactionMode: "auto",
      });
      return formatJsonContent(response?.result ?? response);
    },
  );
}
