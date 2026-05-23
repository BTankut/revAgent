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
  server.tool(
    "export_revit_coordination_image",
    "Create or reuse a visual QA 3D view, optionally section-box target elements, apply high-contrast coordination graphics, and export an image. It only writes review view settings; it does not create or modify MEP model elements.",
    {
      ...connectionTargetSchema(z),
      intent: intentSchema.optional().default("coordination_overlay"),
      elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),
      viewName: z.string().optional().default("DPE Visual QA - Coordination Export"),
      marginMm: z.number().min(0).max(20000).optional().default(2000),
      singleElementMarginMm: z.number().min(0).max(20000).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),
      contextTransparency: z.number().int().min(0).max(90).optional().default(65),
      pixelSize: z.number().int().min(200).max(10000).optional().default(4000),
      enforcePixelSize: z.boolean().optional().default(true).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),
      cropToTargetHighlight: z.boolean().optional().default(true).describe("When true, post-processes coordination images around the green target override pixels so single targets do not remain tiny in a wide 3D export."),
      targetMinFillRatio: z.number().min(0.1).max(0.9).optional().default(0.4).describe("Minimum final crop occupancy for the largest target-highlight dimension. Defaults to 0.4, meaning the target highlight should occupy at least 40% of the cropped image side."),
      highlightCropPaddingPx: z.number().int().min(0).max(2000).optional().default(24).describe("Maximum context padding around target-highlight pixels. The minimum target fill ratio takes precedence over this padding."),
      dpi: dpiSchema.optional().default("300"),
      fitDirection: fitDirectionSchema.optional().default("horizontal"),
      format: formatSchema.optional().default("png"),
      outputDir: z.string().optional(),
      filePrefix: z.string().optional(),
      ...taskMetadataSchema(z),
      timeoutMs: z.number().int().positive().optional(),
    },
    async (args) => {
      const outputDir = path.resolve(args.outputDir || defaultOutputDir());
      const filePrefix = safePrefix(args.filePrefix);
      const fileType = fileTypeByFormat[args.format || "png"];
      const resolution = resolutionByDpi[String(args.dpi || "150")];
      const fitDirection = fitDirectionByInput[args.fitDirection || "horizontal"];
      const pixelSize = Math.trunc(args.pixelSize || 4000);
      const marginMm = Number.isFinite(Number(args.marginMm)) ? Number(args.marginMm) : 2000;
      const singleElementMarginMm = Number.isFinite(Number(args.singleElementMarginMm)) ? Number(args.singleElementMarginMm) : 300;
      const enforcePixelSize = args.enforcePixelSize !== false;
      const cropToTargetHighlight = args.cropToTargetHighlight !== false;
      const targetMinFillRatio = Number.isFinite(Number(args.targetMinFillRatio)) ? Math.max(0.1, Math.min(0.9, Number(args.targetMinFillRatio))) : 0.4;
      const highlightCropPaddingPx = Number.isFinite(Number(args.highlightCropPaddingPx)) ? Math.trunc(args.highlightCropPaddingPx) : 24;
      const transparency = Math.trunc(args.contextTransparency ?? 65);

      const code = `
var warnings = new List<string>();
string outputDir = ${csharpString(outputDir)};
string filePrefix = ${csharpString(filePrefix)};
string desiredViewName = ${csharpString(args.viewName || "DPE Visual QA - Coordination Export")};
string intent = ${csharpString(args.intent || "coordination_overlay")};
var requestedElementIds = ${csharpIntList(args.elementIds)};
double marginFeet = ${marginMm} / 304.8;
double singleElementMarginFeet = ${singleElementMarginMm} / 304.8;
int contextTransparency = ${transparency};
int requestedPixelSize = ${pixelSize};
string requestedFitDirection = ${csharpString(args.fitDirection || "horizontal")};
bool enforcePixelSize = ${enforcePixelSize ? "true" : "false"};
bool cropToTargetHighlight = ${cropToTargetHighlight ? "true" : "false"};
double targetMinFillRatio = ${targetMinFillRatio};
int highlightCropPaddingPx = ${highlightCropPaddingPx};

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
    cameraFramedToTargets = true;
  }
  catch (Exception ex) {
    warnings.Add("coordination_camera_frame_failed:" + ex.Message);
  }
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

Func<string, object[]> cropImageToTargetHighlight = (f) => {
  if (!cropToTargetHighlight || targetElements.Count == 0) {
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0 };
  }

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_highlight_crop_unsupported_format:" + System.IO.Path.GetFileName(f));
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0 };
  }

  string tempFile = f + ".crop-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
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
        bool isTargetGreen = g >= 135 && g > r + 45 && g > b + 25 && r <= 150 && b <= 190;
        if (!isTargetGreen) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        highlightCount++;
      }
    }

    if (highlightCount < 8 || maxX < minX || maxY < minY) {
      warnings.Add("image_highlight_crop_target_pixels_not_found:" + System.IO.Path.GetFileName(f));
      return new object[] { false, width, height, 0, 0, 0, 0, 0, highlightCount, 0, targetMinFillRatio, 0.0 };
    }

    int highlightWidth = Math.Max(1, maxX - minX + 1);
    int highlightHeight = Math.Max(1, maxY - minY + 1);
    int maxHighlightDimension = Math.Max(highlightWidth, highlightHeight);
    double safeFillRatio = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
    int ratioLimitedSide = Math.Max(maxHighlightDimension, (int)Math.Ceiling((double)maxHighlightDimension / safeFillRatio));
    int paddedSide = maxHighlightDimension + (2 * Math.Max(0, highlightCropPaddingPx));
    int desiredSide = Math.Max(maxHighlightDimension + 2, Math.Min(ratioLimitedSide, paddedSide));
    int cropWidth = Math.Min(width, desiredSide);
    int cropHeight = Math.Min(height, desiredSide);
    if (cropWidth < highlightWidth) cropWidth = Math.Min(width, highlightWidth);
    if (cropHeight < highlightHeight) cropHeight = Math.Min(height, highlightHeight);

    double centerX = ((double)minX + (double)maxX) / 2.0;
    double centerY = ((double)minY + (double)maxY) / 2.0;
    int cropX = (int)Math.Round(centerX - ((double)cropWidth / 2.0));
    int cropY = (int)Math.Round(centerY - ((double)cropHeight / 2.0));
    if (cropX < 0) cropX = 0;
    if (cropY < 0) cropY = 0;
    if (cropX + cropWidth > width) cropX = Math.Max(0, width - cropWidth);
    if (cropY + cropHeight > height) cropY = Math.Max(0, height - cropHeight);
    double actualFillRatio = (double)maxHighlightDimension / (double)Math.Max(cropWidth, cropHeight);

    if (cropWidth <= 0 || cropHeight <= 0 ||
        (cropWidth >= width * 0.98 && cropHeight >= height * 0.98)) {
      if (actualFillRatio < safeFillRatio) warnings.Add("image_highlight_crop_fill_ratio_not_met:" + System.IO.Path.GetFileName(f));
      return new object[] { false, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, maxHighlightDimension, safeFillRatio, actualFillRatio };
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
    if (actualFillRatio < safeFillRatio) warnings.Add("image_highlight_crop_fill_ratio_not_met:" + System.IO.Path.GetFileName(f));
    return new object[] { true, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, maxHighlightDimension, safeFillRatio, actualFillRatio };
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_highlight_crop_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0 };
  }
};

Func<string, object> buildFileSummary = (f) => {
  int? width = null;
  int? height = null;
  bool resizedToRequestedPixelSize = false;
  bool croppedToTargetHighlight = false;
  int highlightPixelCount = 0;
  double actualHighlightFillRatio = 0.0;
  object highlightCrop = null;
  try {
    object[] crop = cropImageToTargetHighlight(f);
    if (crop != null && crop.Length >= 12) {
      croppedToTargetHighlight = crop[0] is bool && (bool)crop[0];
      highlightPixelCount = Convert.ToInt32(crop[8]);
      actualHighlightFillRatio = Convert.ToDouble(crop[11], System.Globalization.CultureInfo.InvariantCulture);
      if (croppedToTargetHighlight) {
        highlightCrop = new {
          originalWidth = Convert.ToInt32(crop[1]),
          originalHeight = Convert.ToInt32(crop[2]),
          x = Convert.ToInt32(crop[3]),
          y = Convert.ToInt32(crop[4]),
          width = Convert.ToInt32(crop[5]),
          height = Convert.ToInt32(crop[6]),
          maxHighlightDimension = Convert.ToInt32(crop[9]),
          targetMinFillRatio = Convert.ToDouble(crop[10], System.Globalization.CultureInfo.InvariantCulture),
          actualHighlightFillRatio = actualHighlightFillRatio
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
    resizedToRequestedPixelSize = resizedToRequestedPixelSize,
    croppedToTargetHighlight = croppedToTargetHighlight,
    highlightPixelCount = highlightPixelCount,
    targetMinFillRatio = targetMinFillRatio,
    actualHighlightFillRatio = actualHighlightFillRatio,
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

return new {
  success = files.Count > 0,
  tool = "export_revit_coordination_image",
  revitWriteAction = "review_view_only",
  intent = intent,
  view = new { id = reviewView.Id.IntegerValue, name = reviewView.Name, created = createdView, sectionBoxActive = reviewView.IsSectionBoxActive },
  framing = new {
    mode = framingMode,
    sectionBoxApplied = sectionBoxApplied,
    cameraFramedToTargets = cameraFramedToTargets,
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
  enforcePixelSize = enforcePixelSize,
  cropToTargetHighlight = cropToTargetHighlight,
  targetMinFillRatio = targetMinFillRatio,
  highlightCropPaddingPx = highlightCropPaddingPx,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  marginMm = ${marginMm},
  singleElementMarginMm = ${singleElementMarginMm},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${csharpString(String(args.dpi || "300"))},
  fitDirection = ${csharpString(args.fitDirection || "horizontal")},
  files = files,
  warnings = warnings
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
