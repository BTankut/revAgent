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
    bool showCeilingZone = GetBoolOption("show_ceiling_zone", true);
    bool showObstacles = GetBoolOption("show_obstacles", true);
    bool showShafts = GetBoolOption("show_shafts", true);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    int maxObstaclesToDraw = (int)GetDoubleOption("max_obstacles_to_draw", 300.0);
    double ceilingZMin = targetLevel.Elevation + FromMm(GetDoubleOption("default_ceiling_height_mm", 2700.0));
    double ceilingZMax = ceilingZMin + FromMm(GetDoubleOption("default_plenum_height_mm", 600.0));
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

    Autodesk.Revit.DB.Solid MakeBox(double minX, double minY, double minZ, double maxX, double maxY, double maxZ)
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
        return Autodesk.Revit.DB.GeometryCreationUtilities.CreateExtrusionGeometry(loops, Autodesk.Revit.DB.XYZ.BasisZ, maxZ - minZ);
    }

    int previewElementsCreated = 0;
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

    void CreatePreviewBox(double[] aabb, string label)
    {
        Autodesk.Revit.DB.Solid solid = MakeBox(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]);
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

    if (!document.IsModifiable)
    {
        transaction = new Autodesk.Revit.DB.Transaction(document, "Spatial Zone Preview");
        transaction.Start();
        startedOwnTransaction = true;
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
                if (showRooms)
                {
                    double z = targetLevel.Elevation + FromMm(30.0);
                    CreatePreviewBox(new double[] { aabb[0], aabb[1], z, aabb[3], aabb[4], z + FromMm(30.0) }, label + " " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
                if (showRoomCenters)
                {
                    double cx = (aabb[0] + aabb[3]) / 2.0;
                    double cy = (aabb[1] + aabb[4]) / 2.0;
                    double cz = targetLevel.Elevation + FromMm(120.0);
                    double r = FromMm(120.0);
                    CreatePreviewBox(new double[] { cx - r, cy - r, cz, cx + r, cy + r, cz + r }, label + "-center " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
                if (isSpace) spacesPreviewed++;
                else roomsPreviewed++;
            }
        }

        PreviewSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Rooms, "room", false);
        PreviewSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces, "space", true);

        if (showCeilingZone && hasFootprint)
        {
            CreatePreviewBox(new double[] { footprintMinX, footprintMinY, ceilingZMin, footprintMaxX, footprintMaxY, ceilingZMin + FromMm(50.0) }, "ceiling-zone " + targetLevel.Name);
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
                if (hasFootprint && (aabb[3] < footprintMinX - FromMm(1000.0) || aabb[0] > footprintMaxX + FromMm(1000.0) || aabb[4] < footprintMinY - FromMm(1000.0) || aabb[1] > footprintMaxY + FromMm(1000.0))) continue;
                CreatePreviewBox(aabb, label + " " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
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
                CreatePreviewBox(aabb, "shaft " + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
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
    summary["rooms_previewed"] = roomsPreviewed;
    summary["spaces_previewed"] = spacesPreviewed;
    summary["spatial_elements_previewed"] = roomsPreviewed + spacesPreviewed;
    summary["obstacles_previewed"] = obstaclesPreviewed;
    summary["shafts_previewed"] = shaftsPreviewed;
    summary["ceiling_zones_previewed"] = ceilingZonesPreviewed;
    summary["max_obstacles_to_draw"] = maxObstaclesToDraw;
    summary["truncated_obstacles"] = truncatedObstacles;
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
