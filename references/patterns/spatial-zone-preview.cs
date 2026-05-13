// Spatial zone preview pattern.
// Creates temporary SZ_PREVIEW DirectShape graphics for manual visual validation.
Autodesk.Revit.DB.Transaction transaction = null;
bool startedOwnTransaction = false;
try
{
    System.Collections.Generic.Dictionary<string, string> options =
        new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.List<object> warnings = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> errors = new System.Collections.Generic.List<object>();

    string GetOption(string key, string fallback)
    {
        if (options.ContainsKey(key) && !string.IsNullOrWhiteSpace(options[key]))
        {
            return options[key];
        }
        return fallback;
    }

    bool GetBoolOption(string key, bool fallback)
    {
        string value = GetOption(key, null);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        bool parsed;
        if (bool.TryParse(value, out parsed)) return parsed;
        string normalized = value.Trim().ToLowerInvariant();
        if (normalized == "1" || normalized == "yes" || normalized == "y" || normalized == "evet") return true;
        if (normalized == "0" || normalized == "no" || normalized == "n" || normalized == "hayir") return false;
        return fallback;
    }

    double GetDoubleOption(string key, double fallback)
    {
        string value = GetOption(key, null);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        double parsed;
        if (double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out parsed)) return parsed;
        if (double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.CurrentCulture, out parsed)) return parsed;
        warnings.Add("Could not parse numeric option '" + key + "'.");
        return fallback;
    }

    string JsonEscape(string value)
    {
        if (value == null) return string.Empty;
        System.Text.StringBuilder escaped = new System.Text.StringBuilder();
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch == '\\') escaped.Append("\\\\");
            else if (ch == '"') escaped.Append("\\\"");
            else if (ch == '\n') escaped.Append("\\n");
            else if (ch == '\r') escaped.Append("\\r");
            else if (ch == '\t') escaped.Append("\\t");
            else escaped.Append(ch);
        }
        return escaped.ToString();
    }

    string SerializeJson(object value)
    {
        if (value == null) return "null";
        string stringValue = value as string;
        if (stringValue != null) return "\"" + JsonEscape(stringValue) + "\"";
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
                objectBuilder.Append("\"");
                objectBuilder.Append(JsonEscape(System.Convert.ToString(entry.Key, System.Globalization.CultureInfo.InvariantCulture)));
                objectBuilder.Append("\":");
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
        return "\"" + JsonEscape(value.ToString()) + "\"";
    }

    string NormalizeText(string value)
    {
        return value == null ? string.Empty : value.Trim().ToLowerInvariant();
    }

    void ParseParameter(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return;
        string cleaned = raw.Trim();
        if (cleaned.StartsWith("--")) cleaned = cleaned.Substring(2);
        int equalsIndex = cleaned.IndexOf('=');
        if (equalsIndex > 0)
        {
            string key = cleaned.Substring(0, equalsIndex).Trim();
            string value = cleaned.Substring(equalsIndex + 1).Trim();
            if (key.Length > 0) options[key] = value;
        }
    }

    if (parameters != null)
    {
        for (int i = 0; i < parameters.Length; i++)
        {
            if (parameters[i] != null) ParseParameter(parameters[i].ToString());
        }
    }
    if (!options.ContainsKey("levelName") && options.ContainsKey("target_level")) options["levelName"] = options["target_level"];
    if (!options.ContainsKey("levelId") && options.ContainsKey("target_level_id")) options["levelId"] = options["target_level_id"];

    double FromMm(double millimeters)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(millimeters, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double ToMm(double feet)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(feet, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double Round3(double value)
    {
        return System.Math.Round(value, 3);
    }

    Autodesk.Revit.DB.Level ElementLevel(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Element element)
    {
        if (element == null) return null;
        try
        {
            Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
            if (spatial != null) return spatial.Level;
        }
        catch
        {
        }
        try
        {
            Autodesk.Revit.DB.Parameter levelParameter = element.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.LEVEL_PARAM);
            if (levelParameter != null && levelParameter.AsElementId() != Autodesk.Revit.DB.ElementId.InvalidElementId)
            {
                return sourceDocument.GetElement(levelParameter.AsElementId()) as Autodesk.Revit.DB.Level;
            }
        }
        catch
        {
        }
        try
        {
            Autodesk.Revit.DB.Parameter levelParameter = element.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.FAMILY_LEVEL_PARAM);
            if (levelParameter != null && levelParameter.AsElementId() != Autodesk.Revit.DB.ElementId.InvalidElementId)
            {
                return sourceDocument.GetElement(levelParameter.AsElementId()) as Autodesk.Revit.DB.Level;
            }
        }
        catch
        {
        }
        return null;
    }

    double[] ComputeAabbFeet(Autodesk.Revit.DB.BoundingBoxXYZ box, Autodesk.Revit.DB.Transform sourceToHost)
    {
        if (box == null) return null;
        if (sourceToHost == null) sourceToHost = Autodesk.Revit.DB.Transform.Identity;
        Autodesk.Revit.DB.Transform totalTransform = sourceToHost;
        try
        {
            if (box.Transform != null) totalTransform = sourceToHost.Multiply(box.Transform);
        }
        catch
        {
        }
        double minX = double.PositiveInfinity;
        double minY = double.PositiveInfinity;
        double minZ = double.PositiveInfinity;
        double maxX = double.NegativeInfinity;
        double maxY = double.NegativeInfinity;
        double maxZ = double.NegativeInfinity;
        double[] xs = new double[] { box.Min.X, box.Max.X };
        double[] ys = new double[] { box.Min.Y, box.Max.Y };
        double[] zs = new double[] { box.Min.Z, box.Max.Z };
        for (int ix = 0; ix < xs.Length; ix++)
        {
            for (int iy = 0; iy < ys.Length; iy++)
            {
                for (int iz = 0; iz < zs.Length; iz++)
                {
                    Autodesk.Revit.DB.XYZ point = totalTransform.OfPoint(new Autodesk.Revit.DB.XYZ(xs[ix], ys[iy], zs[iz]));
                    minX = System.Math.Min(minX, point.X);
                    minY = System.Math.Min(minY, point.Y);
                    minZ = System.Math.Min(minZ, point.Z);
                    maxX = System.Math.Max(maxX, point.X);
                    maxY = System.Math.Max(maxY, point.Y);
                    maxZ = System.Math.Max(maxZ, point.Z);
                }
            }
        }
        if (double.IsInfinity(minX) || double.IsInfinity(maxX)) return null;
        return new double[] { minX, minY, minZ, maxX, maxY, maxZ };
    }

    Autodesk.Revit.DB.Level targetLevel = null;
    string targetLevelSource = "unresolved";
    string levelIdOption = GetOption("levelId", null);
    string levelNameOption = GetOption("levelName", null);
    string levelElevationOption = GetOption("target_level_elevation_mm", GetOption("level_elevation_mm", null));
    bool hasAnyExplicitLevelSelector = !string.IsNullOrWhiteSpace(levelIdOption) || !string.IsNullOrWhiteSpace(levelNameOption) || !string.IsNullOrWhiteSpace(levelElevationOption);
    double levelToleranceMm = GetDoubleOption("level_elevation_tolerance_mm", 100.0);
    bool useActiveViewLevel = GetBoolOption("activeViewLevel", true);

    System.Collections.Generic.List<Autodesk.Revit.DB.Level> hostLevels = new System.Collections.Generic.List<Autodesk.Revit.DB.Level>();
    foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.Level)))
    {
        Autodesk.Revit.DB.Level level = element as Autodesk.Revit.DB.Level;
        if (level != null) hostLevels.Add(level);
    }
    hostLevels.Sort(delegate(Autodesk.Revit.DB.Level left, Autodesk.Revit.DB.Level right)
    {
        return left.Elevation.CompareTo(right.Elevation);
    });

    if (!string.IsNullOrWhiteSpace(levelIdOption))
    {
        int levelIdValue;
        if (int.TryParse(levelIdOption, out levelIdValue))
        {
            targetLevel = document.GetElement(new Autodesk.Revit.DB.ElementId(levelIdValue)) as Autodesk.Revit.DB.Level;
            if (targetLevel != null) targetLevelSource = "levelId";
        }
    }
    if (targetLevel == null && !string.IsNullOrWhiteSpace(levelNameOption))
    {
        string requestedLevelName = NormalizeText(levelNameOption);
        for (int i = 0; i < hostLevels.Count; i++)
        {
            if (NormalizeText(hostLevels[i].Name) == requestedLevelName)
            {
                targetLevel = hostLevels[i];
                targetLevelSource = "levelName";
                break;
            }
        }
        if (targetLevel == null)
        {
            for (int i = 0; i < hostLevels.Count; i++)
            {
                if (NormalizeText(hostLevels[i].Name).Contains(requestedLevelName))
                {
                    targetLevel = hostLevels[i];
                    targetLevelSource = "levelNameContains";
                    break;
                }
            }
        }
    }
    if (targetLevel == null && !string.IsNullOrWhiteSpace(levelElevationOption))
    {
        double requestedElevationMm;
        if (double.TryParse(levelElevationOption, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out requestedElevationMm) ||
            double.TryParse(levelElevationOption, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.CurrentCulture, out requestedElevationMm))
        {
            double requestedElevation = FromMm(requestedElevationMm);
            double bestDistance = double.PositiveInfinity;
            for (int i = 0; i < hostLevels.Count; i++)
            {
                double distance = System.Math.Abs(hostLevels[i].Elevation - requestedElevation);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    targetLevel = hostLevels[i];
                }
            }
            if (targetLevel != null) targetLevelSource = "nearestLevelByElevation";
        }
    }
    if (targetLevel == null && useActiveViewLevel && !hasAnyExplicitLevelSelector)
    {
        try
        {
            targetLevel = document.ActiveView.GenLevel;
            if (targetLevel != null) targetLevelSource = "activeView";
        }
        catch
        {
        }
    }
    if (targetLevel == null && hostLevels.Count > 0)
    {
        targetLevel = hostLevels[0];
        targetLevelSource = "firstHostLevelFallback";
        warnings.Add("Using first host level fallback.");
    }
    if (targetLevel == null)
    {
        errors.Add("No target level could be resolved.");
        System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
        failed["schema_version"] = "spatial-zone-preview.v1";
        failed["status"] = "fail";
        failed["summary"] = new System.Collections.Generic.Dictionary<string, object>();
        failed["warnings"] = warnings;
        failed["errors"] = errors;
        return SerializeJson(failed);
    }

    string previewPrefix = GetOption("preview_prefix", "SZ_PREVIEW");
    string marker = previewPrefix + " spatial-zone-preview.v1";
    bool previewMode = GetBoolOption("preview_mode", true);
    bool clearExistingPreview = GetBoolOption("clear_existing_preview", true);
    bool showRooms = GetBoolOption("show_rooms", true);
    bool showRoomCenters = GetBoolOption("show_room_centers", true);
    bool showPlenumVolume = GetBoolOption("show_plenum_volume", previewMode);
    bool showCeilingZone = GetBoolOption("show_ceiling_zone", true);
    bool showObstacles = GetBoolOption("show_obstacles", true);
    bool showShafts = GetBoolOption("show_shafts", true);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    int maxObstaclesToDraw = (int)GetDoubleOption("max_obstacles_to_draw", 300.0);
    double defaultCeilingHeightMm = GetDoubleOption("default_ceiling_height_mm", 2700.0);
    double defaultPlenumHeightMm = GetDoubleOption("default_plenum_height_mm", 600.0);
    double ceilingZMin = targetLevel.Elevation + FromMm(defaultCeilingHeightMm);
    double ceilingZMax = ceilingZMin + FromMm(defaultPlenumHeightMm);
    string ceilingZSource = "fallback_default_ceiling_height";
    string slabZSource = "fallback_default_plenum_height";
    string ceilingSourceElement = string.Empty;
    string slabSourceElement = string.Empty;
    Autodesk.Revit.DB.ElementId previewCategoryId = new Autodesk.Revit.DB.ElementId(Autodesk.Revit.DB.BuiltInCategory.OST_GenericModel);
    if (!Autodesk.Revit.DB.DirectShape.IsValidCategoryId(previewCategoryId, document))
    {
        errors.Add("DirectShape category OST_GenericModel is not valid for this document.");
        System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
        failed["schema_version"] = "spatial-zone-preview.v1";
        failed["status"] = "fail";
        failed["summary"] = new System.Collections.Generic.Dictionary<string, object>();
        failed["warnings"] = warnings;
        failed["errors"] = errors;
        return SerializeJson(failed);
    }

    bool LevelMatches(Autodesk.Revit.DB.Level sourceLevel)
    {
        if (sourceLevel == null) return false;
        if (NormalizeText(sourceLevel.Name) == NormalizeText(targetLevel.Name)) return true;
        return System.Math.Abs(sourceLevel.Elevation - targetLevel.Elevation) <= FromMm(levelToleranceMm);
    }

    Autodesk.Revit.DB.ElementId EnsurePreviewMaterial(string materialName, int red, int green, int blue, int transparency)
    {
        Autodesk.Revit.DB.Material material = null;
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.Material)))
        {
            Autodesk.Revit.DB.Material candidate = element as Autodesk.Revit.DB.Material;
            if (candidate != null && candidate.Name == materialName)
            {
                material = candidate;
                break;
            }
        }
        if (material == null)
        {
            Autodesk.Revit.DB.ElementId materialId = Autodesk.Revit.DB.Material.Create(document, materialName);
            material = document.GetElement(materialId) as Autodesk.Revit.DB.Material;
        }
        if (material == null) return Autodesk.Revit.DB.ElementId.InvalidElementId;

        int safeRed = System.Math.Max(0, System.Math.Min(255, red));
        int safeGreen = System.Math.Max(0, System.Math.Min(255, green));
        int safeBlue = System.Math.Max(0, System.Math.Min(255, blue));
        int safeTransparency = System.Math.Max(0, System.Math.Min(100, transparency));
        try
        {
            material.Color = new Autodesk.Revit.DB.Color((byte)safeRed, (byte)safeGreen, (byte)safeBlue);
            material.Transparency = safeTransparency;
            material.UseRenderAppearanceForShading = false;
        }
        catch (System.Exception ex)
        {
            warnings.Add("Could not update preview material '" + materialName + "': " + ex.Message);
        }
        return material.Id;
    }

    Autodesk.Revit.DB.Solid CreateExtrusion(System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop> loops, double height, Autodesk.Revit.DB.ElementId materialId)
    {
        if (materialId != null && materialId != Autodesk.Revit.DB.ElementId.InvalidElementId)
        {
            Autodesk.Revit.DB.SolidOptions solidOptions = new Autodesk.Revit.DB.SolidOptions(materialId, Autodesk.Revit.DB.ElementId.InvalidElementId);
            try
            {
                return Autodesk.Revit.DB.GeometryCreationUtilities.CreateExtrusionGeometry(loops, Autodesk.Revit.DB.XYZ.BasisZ, height, solidOptions);
            }
            finally
            {
                solidOptions.Dispose();
            }
        }
        return Autodesk.Revit.DB.GeometryCreationUtilities.CreateExtrusionGeometry(loops, Autodesk.Revit.DB.XYZ.BasisZ, height);
    }

    Autodesk.Revit.DB.Solid MakeBox(double minX, double minY, double minZ, double maxX, double maxY, double maxZ, Autodesk.Revit.DB.ElementId materialId)
    {
        double minSize = FromMm(20.0);
        if (maxX - minX < minSize)
        {
            double center = (minX + maxX) / 2.0;
            minX = center - minSize / 2.0;
            maxX = center + minSize / 2.0;
        }
        if (maxY - minY < minSize)
        {
            double center = (minY + maxY) / 2.0;
            minY = center - minSize / 2.0;
            maxY = center + minSize / 2.0;
        }
        if (maxZ - minZ < minSize)
        {
            maxZ = minZ + minSize;
        }

        Autodesk.Revit.DB.CurveLoop loop = new Autodesk.Revit.DB.CurveLoop();
        Autodesk.Revit.DB.XYZ p1 = new Autodesk.Revit.DB.XYZ(minX, minY, minZ);
        Autodesk.Revit.DB.XYZ p2 = new Autodesk.Revit.DB.XYZ(maxX, minY, minZ);
        Autodesk.Revit.DB.XYZ p3 = new Autodesk.Revit.DB.XYZ(maxX, maxY, minZ);
        Autodesk.Revit.DB.XYZ p4 = new Autodesk.Revit.DB.XYZ(minX, maxY, minZ);
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p1, p2));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p2, p3));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p3, p4));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p4, p1));
        System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop> loops = new System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop>();
        loops.Add(loop);
        return CreateExtrusion(loops, maxZ - minZ, materialId);
    }

    bool SamePoint2d(Autodesk.Revit.DB.XYZ left, Autodesk.Revit.DB.XYZ right)
    {
        if (left == null || right == null) return false;
        double tolerance = FromMm(1.0);
        return System.Math.Abs(left.X - right.X) <= tolerance && System.Math.Abs(left.Y - right.Y) <= tolerance;
    }

    double PolygonArea(System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> points)
    {
        if (points == null || points.Count < 3) return 0.0;
        double area = 0.0;
        for (int i = 0; i < points.Count; i++)
        {
            Autodesk.Revit.DB.XYZ a = points[i];
            Autodesk.Revit.DB.XYZ b = points[(i + 1) % points.Count];
            area += a.X * b.Y - b.X * a.Y;
        }
        return System.Math.Abs(area) / 2.0;
    }

    System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> SpatialBoundaryPoints(Autodesk.Revit.DB.SpatialElement spatial)
    {
        try
        {
            Autodesk.Revit.DB.SpatialElementBoundaryOptions boundaryOptions = new Autodesk.Revit.DB.SpatialElementBoundaryOptions();
            System.Collections.Generic.IList<System.Collections.Generic.IList<Autodesk.Revit.DB.BoundarySegment>> loops = spatial.GetBoundarySegments(boundaryOptions);
            if (loops == null || loops.Count == 0) return null;

            System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> bestPoints = null;
            double bestArea = 0.0;
            for (int loopIndex = 0; loopIndex < loops.Count; loopIndex++)
            {
                if (loops[loopIndex] == null || loops[loopIndex].Count == 0) continue;
                System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> points = new System.Collections.Generic.List<Autodesk.Revit.DB.XYZ>();
                for (int segmentIndex = 0; segmentIndex < loops[loopIndex].Count; segmentIndex++)
                {
                    Autodesk.Revit.DB.Curve curve = loops[loopIndex][segmentIndex].GetCurve();
                    if (curve == null) continue;
                    System.Collections.Generic.IList<Autodesk.Revit.DB.XYZ> tessellated = curve.Tessellate();
                    for (int pointIndex = 0; pointIndex < tessellated.Count; pointIndex++)
                    {
                        Autodesk.Revit.DB.XYZ point = new Autodesk.Revit.DB.XYZ(tessellated[pointIndex].X, tessellated[pointIndex].Y, 0.0);
                        if (points.Count == 0 || !SamePoint2d(points[points.Count - 1], point))
                        {
                            points.Add(point);
                        }
                    }
                }
                if (points.Count > 1 && SamePoint2d(points[0], points[points.Count - 1]))
                {
                    points.RemoveAt(points.Count - 1);
                }
                double area = PolygonArea(points);
                if (points.Count >= 3 && area > bestArea)
                {
                    bestArea = area;
                    bestPoints = points;
                }
            }
            return bestPoints;
        }
        catch (System.Exception ex)
        {
            warnings.Add("Plenum polygon boundary extraction failed for spatial element " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message);
        }
        return null;
    }

    Autodesk.Revit.DB.Solid MakePolygonPrism(System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> points, double minZ, double maxZ, Autodesk.Revit.DB.ElementId materialId)
    {
        if (points == null || points.Count < 3) return null;
        Autodesk.Revit.DB.CurveLoop loop = new Autodesk.Revit.DB.CurveLoop();
        int segmentCount = 0;
        for (int i = 0; i < points.Count; i++)
        {
            Autodesk.Revit.DB.XYZ sourceStart = points[i];
            Autodesk.Revit.DB.XYZ sourceEnd = points[(i + 1) % points.Count];
            if (SamePoint2d(sourceStart, sourceEnd)) continue;
            Autodesk.Revit.DB.XYZ start = new Autodesk.Revit.DB.XYZ(sourceStart.X, sourceStart.Y, minZ);
            Autodesk.Revit.DB.XYZ end = new Autodesk.Revit.DB.XYZ(sourceEnd.X, sourceEnd.Y, minZ);
            loop.Append(Autodesk.Revit.DB.Line.CreateBound(start, end));
            segmentCount++;
        }
        if (segmentCount < 3) return null;
        System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop> loops = new System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop>();
        loops.Add(loop);
        return CreateExtrusion(loops, maxZ - minZ, materialId);
    }

    int previewElementsCreated = 0;
    int plenumVolumesPreviewed = 0;
    int plenumPolygonCount = 0;
    int plenumBboxFallbackCount = 0;
    int roomsPreviewed = 0;
    int spacesPreviewed = 0;
    int obstaclesPreviewed = 0;
    int shaftsPreviewed = 0;
    int ceilingZonesPreviewed = 0;
    bool truncatedObstacles = false;
    bool hasFootprint = false;
    double footprintMinX = double.PositiveInfinity;
    double footprintMinY = double.PositiveInfinity;
    double footprintMaxX = double.NegativeInfinity;
    double footprintMaxY = double.NegativeInfinity;
    System.Collections.Generic.List<object[]> spatialPreviewRecords = new System.Collections.Generic.List<object[]>();
    Autodesk.Revit.DB.ElementId defaultMaterialId = Autodesk.Revit.DB.ElementId.InvalidElementId;
    Autodesk.Revit.DB.ElementId plenumMaterialId = Autodesk.Revit.DB.ElementId.InvalidElementId;

    void CreatePreviewSolid(Autodesk.Revit.DB.Solid solid, string label)
    {
        if (solid == null) return;
        Autodesk.Revit.DB.DirectShape directShape = Autodesk.Revit.DB.DirectShape.CreateElement(document, previewCategoryId);
        directShape.ApplicationId = previewPrefix;
        directShape.ApplicationDataId = marker + " | " + label;
        System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject> geometry = new System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject>();
        geometry.Add(solid);
        directShape.SetShape(geometry);
        try
        {
            Autodesk.Revit.DB.Parameter comments = directShape.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
            if (comments != null && !comments.IsReadOnly) comments.Set(marker + " | " + label);
        }
        catch
        {
        }
        previewElementsCreated++;
    }

    void CreatePreviewBox(double[] aabb, string label, Autodesk.Revit.DB.ElementId materialId)
    {
        Autodesk.Revit.DB.Solid solid = MakeBox(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5], materialId);
        CreatePreviewSolid(solid, label);
    }

    bool AabbOverlapsFootprint(double[] aabb, double padding)
    {
        if (!hasFootprint || aabb == null) return true;
        return !(aabb[3] < footprintMinX - padding || aabb[0] > footprintMaxX + padding ||
            aabb[4] < footprintMinY - padding || aabb[1] > footprintMaxY + padding);
    }

    double FindLowestCategoryBottom(Autodesk.Revit.DB.BuiltInCategory category, double searchMinZ, double searchMaxZ, out string sourceDescription)
    {
        sourceDescription = string.Empty;
        bool found = false;
        double best = 0.0;
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
            {
                double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
                if (aabb == null) continue;
                double bottom = aabb[2];
                if (bottom < searchMinZ || bottom > searchMaxZ) continue;
                if (!AabbOverlapsFootprint(aabb, FromMm(1000.0))) continue;
                if (!found || bottom < best)
                {
                    found = true;
                    best = bottom;
                    sourceDescription = "Host:" + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Could not search " + category.ToString() + " for plenum z source: " + ex.Message);
        }
        return found ? best : double.NaN;
    }

    if (!document.IsModifiable)
    {
        transaction = new Autodesk.Revit.DB.Transaction(document, "Spatial Zone Preview");
        transaction.Start();
        startedOwnTransaction = true;
    }
    if (showPlenumVolume)
    {
        plenumMaterialId = EnsurePreviewMaterial(previewPrefix + " Plenum Volume", 0, 190, 220, 78);
    }

    if (clearExistingPreview)
    {
        System.Collections.Generic.List<Autodesk.Revit.DB.ElementId> deleteIds = new System.Collections.Generic.List<Autodesk.Revit.DB.ElementId>();
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.DirectShape)).WhereElementIsNotElementType())
        {
            Autodesk.Revit.DB.DirectShape directShape = element as Autodesk.Revit.DB.DirectShape;
            if (directShape == null) continue;
            string applicationId = string.Empty;
            string applicationDataId = string.Empty;
            try { applicationId = directShape.ApplicationId; } catch { }
            try { applicationDataId = directShape.ApplicationDataId; } catch { }
            if ((!string.IsNullOrWhiteSpace(applicationId) && applicationId == previewPrefix) ||
                (!string.IsNullOrWhiteSpace(applicationDataId) && applicationDataId.Contains(marker)))
            {
                deleteIds.Add(element.Id);
            }
        }
        if (deleteIds.Count > 0)
        {
            document.Delete(deleteIds);
        }
    }

    if (previewMode)
    {
        void PreviewSpatialCategory(Autodesk.Revit.DB.BuiltInCategory category, string label, bool isSpace)
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
            {
                Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
                if (spatial == null) continue;
                if (!LevelMatches(ElementLevel(document, spatial))) continue;
                double[] aabb = ComputeAabbFeet(spatial.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
                if (aabb == null) continue;
                hasFootprint = true;
                footprintMinX = System.Math.Min(footprintMinX, aabb[0]);
                footprintMinY = System.Math.Min(footprintMinY, aabb[1]);
                footprintMaxX = System.Math.Max(footprintMaxX, aabb[3]);
                footprintMaxY = System.Math.Max(footprintMaxY, aabb[4]);
                spatialPreviewRecords.Add(new object[] { aabb, SpatialBoundaryPoints(spatial), label, element.Id.IntegerValue });
                if (showRooms)
                {
                    double z = targetLevel.Elevation + FromMm(30.0);
                    CreatePreviewBox(new double[] { aabb[0], aabb[1], z, aabb[3], aabb[4], z + FromMm(30.0) }, label + " " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture), defaultMaterialId);
                }
                if (showRoomCenters)
                {
                    double cx = (aabb[0] + aabb[3]) / 2.0;
                    double cy = (aabb[1] + aabb[4]) / 2.0;
                    double cz = targetLevel.Elevation + FromMm(120.0);
                    double r = FromMm(120.0);
                    CreatePreviewBox(new double[] { cx - r, cy - r, cz, cx + r, cy + r, cz + r }, label + "-center " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture), defaultMaterialId);
                }
                if (isSpace) spacesPreviewed++;
                else roomsPreviewed++;
            }
        }

        PreviewSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Rooms, "room", false);
        PreviewSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces, "space", true);

        double searchMinZ = targetLevel.Elevation + FromMm(1800.0);
        double searchMaxZ = targetLevel.Elevation + FromMm(7000.0);
        double modelCeilingBottom = FindLowestCategoryBottom(Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings, searchMinZ, searchMaxZ, out ceilingSourceElement);
        if (!double.IsNaN(modelCeilingBottom))
        {
            ceilingZMin = modelCeilingBottom;
            ceilingZSource = "model_ceiling_bottom";
        }
        else
        {
            warnings.Add("No ceiling element was found above target level. Using default_ceiling_height_mm=" + defaultCeilingHeightMm.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
        }

        double slabSearchMinZ = ceilingZMin + FromMm(100.0);
        double slabSearchMaxZ = targetLevel.Elevation + FromMm(9000.0);
        double modelSlabBottom = FindLowestCategoryBottom(Autodesk.Revit.DB.BuiltInCategory.OST_Floors, slabSearchMinZ, slabSearchMaxZ, out slabSourceElement);
        if (!double.IsNaN(modelSlabBottom))
        {
            ceilingZMax = modelSlabBottom;
            slabZSource = "model_slab_bottom";
        }
        else
        {
            warnings.Add("No slab/floor bottom was found above target level. Using default_plenum_height_mm=" + defaultPlenumHeightMm.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
        }

        if (showPlenumVolume)
        {
            for (int i = 0; i < spatialPreviewRecords.Count; i++)
            {
                double[] aabb = spatialPreviewRecords[i][0] as double[];
                System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygonPoints = spatialPreviewRecords[i][1] as System.Collections.Generic.List<Autodesk.Revit.DB.XYZ>;
                string label = spatialPreviewRecords[i][2] as string;
                int elementId = (int)spatialPreviewRecords[i][3];
                string source = "polygon";
                Autodesk.Revit.DB.Solid solid = null;
                if (polygonPoints != null && polygonPoints.Count >= 3)
                {
                    try
                    {
                        solid = MakePolygonPrism(polygonPoints, ceilingZMin, ceilingZMax, plenumMaterialId);
                    }
                    catch (System.Exception ex)
                    {
                        warnings.Add("Could not create polygon plenum volume for spatial element " + elementId.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message);
                    }
                }
                if (solid == null)
                {
                    source = "bbox_fallback";
                    solid = MakeBox(aabb[0], aabb[1], ceilingZMin, aabb[3], aabb[4], ceilingZMax, plenumMaterialId);
                    plenumBboxFallbackCount++;
                }
                else
                {
                    plenumPolygonCount++;
                }
                CreatePreviewSolid(solid, label + "-plenum-volume " + elementId.ToString(System.Globalization.CultureInfo.InvariantCulture) + " " + source);
                plenumVolumesPreviewed++;
            }
        }

        if (showCeilingZone && hasFootprint)
        {
            CreatePreviewBox(new double[] { footprintMinX, footprintMinY, ceilingZMin, footprintMaxX, footprintMaxY, ceilingZMin + FromMm(50.0) }, "ceiling-zone " + targetLevel.Name, defaultMaterialId);
            ceilingZonesPreviewed = 1;
        }

        void PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory category, string label)
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
            {
                if (obstaclesPreviewed >= maxObstaclesToDraw)
                {
                    truncatedObstacles = true;
                    return;
                }
                double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
                if (aabb == null) continue;
                if (aabb[5] < ceilingZMin - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(500.0)) continue;
                if (!AabbOverlapsFootprint(aabb, FromMm(1000.0))) continue;
                CreatePreviewBox(aabb, label + " " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture), defaultMaterialId);
                obstaclesPreviewed++;
            }
        }

        if (showObstacles)
        {
            PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming, "beam");
            PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns, "column");
            PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Walls, "wall");
            PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Floors, "floor");
            PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings, "ceiling");
            if (includeExistingMep)
            {
                PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves, "duct");
                PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_PipeCurves, "pipe");
                PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MechanicalEquipment, "mechanical-equipment");
                PreviewObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal, "air-terminal");
            }
        }

        if (showShafts)
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(Autodesk.Revit.DB.BuiltInCategory.OST_ShaftOpening).WhereElementIsNotElementType())
            {
                double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
                if (aabb == null) continue;
                if (aabb[5] < targetLevel.Elevation - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(3000.0)) continue;
                CreatePreviewBox(aabb, "shaft " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture), defaultMaterialId);
                shaftsPreviewed++;
            }
        }
    }

    if (startedOwnTransaction && transaction != null)
    {
        transaction.Commit();
        transaction = null;
        startedOwnTransaction = false;
    }

    if (truncatedObstacles)
    {
        warnings.Add("Obstacle preview was truncated at max_obstacles_to_draw.");
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["preview_elements_created"] = previewElementsCreated;
    summary["plenum_volumes_previewed"] = plenumVolumesPreviewed;
    summary["plenum_boundary_source"] = plenumVolumesPreviewed == 0 ? "none" : (plenumBboxFallbackCount > 0 ? "bbox_fallback" : "polygon");
    summary["plenum_polygon_count"] = plenumPolygonCount;
    summary["plenum_bbox_fallback_count"] = plenumBboxFallbackCount;
    summary["rooms_previewed"] = roomsPreviewed;
    summary["spaces_previewed"] = spacesPreviewed;
    summary["spatial_elements_previewed"] = roomsPreviewed + spacesPreviewed;
    summary["obstacles_previewed"] = obstaclesPreviewed;
    summary["shafts_previewed"] = shaftsPreviewed;
    summary["ceiling_zones_previewed"] = ceilingZonesPreviewed;
    summary["max_obstacles_to_draw"] = maxObstaclesToDraw;
    summary["truncated_obstacles"] = truncatedObstacles;
    summary["plenum_volume_bottom_mm"] = Round3(ToMm(ceilingZMin));
    summary["plenum_volume_top_mm"] = Round3(ToMm(ceilingZMax));
    summary["plenum_z_source_detail"] = ceilingZSource + "/" + slabZSource;
    summary["ceiling_source_element"] = string.IsNullOrWhiteSpace(ceilingSourceElement) ? null : ceilingSourceElement;
    summary["slab_source_element"] = string.IsNullOrWhiteSpace(slabSourceElement) ? null : slabSourceElement;
    summary["target_level_name"] = targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "spatial-zone-preview.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    if (startedOwnTransaction && transaction != null && transaction.HasStarted())
    {
        try { transaction.RollBack(); } catch { }
    }
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"spatial-zone-preview.v1\",\"status\":\"fail\",\"summary\":{},\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
