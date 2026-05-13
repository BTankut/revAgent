// Spatial zone validation companion pattern.
// Read-only: checks target-level spatial state consistency before manual preview or routing.
try
{
    System.Collections.Generic.Dictionary<string, string> options =
        new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.List<object> checks = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> warnings = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> errors = new System.Collections.Generic.List<object>();
    bool hasFail = false;
    bool hasWarn = false;

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
        hasWarn = true;
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
            else if (ch < 32)
            {
                escaped.Append("\\u");
                escaped.Append(((int)ch).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
            }
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
        if (value is float)
        {
            float number = (float)value;
            if (float.IsNaN(number) || float.IsInfinity(number)) return "null";
            return number.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        if (value is decimal || value is byte || value is sbyte || value is short || value is ushort ||
            value is int || value is uint || value is long || value is ulong)
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

    void AddCheck(string id, string status, string message)
    {
        System.Collections.Generic.Dictionary<string, object> check = new System.Collections.Generic.Dictionary<string, object>();
        check["id"] = id;
        check["status"] = status;
        check["message"] = message;
        checks.Add(check);
        if (status == "fail") hasFail = true;
        if (status == "warn") hasWarn = true;
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

    double ToMm(double feet)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(feet, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double FromMm(double millimeters)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(millimeters, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double Round3(double value)
    {
        return System.Math.Round(value, 3);
    }

    string CategoryName(Autodesk.Revit.DB.Element element)
    {
        try
        {
            return element != null && element.Category != null ? element.Category.Name : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    string SafeUniqueId(Autodesk.Revit.DB.Element element)
    {
        try
        {
            return element == null ? string.Empty : element.UniqueId;
        }
        catch
        {
            return string.Empty;
        }
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

    void Increment(System.Collections.Generic.Dictionary<string, int> dictionary, string key)
    {
        if (string.IsNullOrWhiteSpace(key)) key = "unknown";
        if (!dictionary.ContainsKey(key)) dictionary[key] = 0;
        dictionary[key]++;
    }

    System.Collections.Generic.Dictionary<string, object> BreakdownRecord(System.Collections.Generic.Dictionary<string, int> source, string[] expectedKeys)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        for (int i = 0; i < expectedKeys.Length; i++)
        {
            string key = expectedKeys[i];
            record[key] = source.ContainsKey(key) ? source[key] : 0;
        }
        foreach (System.Collections.Generic.KeyValuePair<string, int> pair in source)
        {
            if (!record.ContainsKey(pair.Key)) record[pair.Key] = pair.Value;
        }
        return record;
    }

    int CountCategory(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.BuiltInCategory category)
    {
        int count = 0;
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
            {
                count++;
            }
        }
        catch
        {
        }
        return count;
    }

    double levelToleranceMm = GetDoubleOption("level_elevation_tolerance_mm", 100.0);
    double defaultCeilingHeightMm = GetDoubleOption("default_ceiling_height_mm", 2700.0);
    double defaultPlenumHeightMm = GetDoubleOption("default_plenum_height_mm", 600.0);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    bool useActiveViewLevel = GetBoolOption("activeViewLevel", true);
    int expectedMinRooms = (int)GetDoubleOption("expected_min_rooms", 1.0);
    int expectedMinObstacles = (int)GetDoubleOption("expected_min_obstacles", 1.0);
    int expectedMinColumns = (int)GetDoubleOption("expected_min_columns", 0.0);
    int expectedMinBeams = (int)GetDoubleOption("expected_min_beams", 0.0);
    int expectedMinCeilingZones = (int)GetDoubleOption("expected_min_ceiling_zones", 1.0);

    Autodesk.Revit.DB.Level targetLevel = null;
    string targetLevelSource = "unresolved";
    string levelIdOption = GetOption("levelId", null);
    string levelNameOption = GetOption("levelName", null);
    string levelElevationOption = GetOption("target_level_elevation_mm", GetOption("level_elevation_mm", null));
    bool hasExplicitLevelId = !string.IsNullOrWhiteSpace(levelIdOption);
    bool hasExplicitLevelName = !string.IsNullOrWhiteSpace(levelNameOption);
    bool hasExplicitLevelElevation = !string.IsNullOrWhiteSpace(levelElevationOption);
    bool hasAnyExplicitLevelSelector = hasExplicitLevelId || hasExplicitLevelName || hasExplicitLevelElevation;

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

    if (hasExplicitLevelId)
    {
        int levelIdValue;
        if (int.TryParse(levelIdOption, out levelIdValue))
        {
            targetLevel = document.GetElement(new Autodesk.Revit.DB.ElementId(levelIdValue)) as Autodesk.Revit.DB.Level;
            if (targetLevel != null) targetLevelSource = "levelId";
        }
    }

    if (targetLevel == null && hasExplicitLevelName)
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

    if (targetLevel == null && hasExplicitLevelElevation)
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
            if (targetLevel != null)
            {
                targetLevelSource = "nearestLevelByElevation";
                if (bestDistance > FromMm(levelToleranceMm))
                {
                    warnings.Add("Nearest host level by elevation is outside level_elevation_tolerance_mm.");
                    hasWarn = true;
                }
            }
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
        hasWarn = true;
    }

    if (targetLevel == null)
    {
        errors.Add("No target level could be resolved.");
        AddCheck("target_level_resolved", "fail", "No target level could be resolved.");
    }
    else
    {
        AddCheck("target_level_resolved", "pass", "Resolved target level '" + targetLevel.Name + "' via " + targetLevelSource + ".");
    }
    if (hasExplicitLevelElevation)
    {
        AddCheck("explicit_elevation_priority", targetLevelSource == "nearestLevelByElevation" ? "pass" : "fail", "Explicit elevation selector resolved via " + targetLevelSource + ".");
    }

    double targetElevation = targetLevel == null ? 0.0 : targetLevel.Elevation;
    double ceilingZMin = targetElevation + FromMm(defaultCeilingHeightMm);
    double ceilingZMax = ceilingZMin + FromMm(defaultPlenumHeightMm);
    double plenumHeightMm = defaultPlenumHeightMm;

    System.Collections.Generic.List<object> roomRecords = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> obstacleRecords = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> shaftRecords = new System.Collections.Generic.List<object>();
    System.Collections.Generic.Dictionary<string, int> obstacleTypeBreakdown = new System.Collections.Generic.Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.Dictionary<string, int> obstacleCategoryBreakdown = new System.Collections.Generic.Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase);
    int bboxBoundaryCount = 0;
    int unknownBoundaryCount = 0;
    int invalidObstacleBoxes = 0;
    int unexpectedObstacleCategories = 0;

    bool LevelMatches(Autodesk.Revit.DB.Level sourceLevel)
    {
        if (targetLevel == null || sourceLevel == null) return false;
        if (NormalizeText(sourceLevel.Name) == NormalizeText(targetLevel.Name)) return true;
        return System.Math.Abs(sourceLevel.Elevation - targetLevel.Elevation) <= FromMm(levelToleranceMm);
    }

    void AddRoomRecord(Autodesk.Revit.DB.SpatialElement spatial, string spatialType)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["id"] = "Host:" + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        record["element_id"] = spatial.Id.IntegerValue;
        record["unique_id"] = SafeUniqueId(spatial);
        record["source_type"] = "host";
        record["source_document_title"] = document.Title;
        record["source_link"] = "Host";
        record["type"] = spatialType;
        record["centroid_mm"] = new System.Collections.Generic.List<object>();
        System.Collections.Generic.Dictionary<string, object> boundary = new System.Collections.Generic.Dictionary<string, object>();
        try
        {
            Autodesk.Revit.DB.BoundingBoxXYZ box = spatial.get_BoundingBox(null);
            double[] aabb = ComputeAabbFeet(box, Autodesk.Revit.DB.Transform.Identity);
            if (aabb != null)
            {
                boundary["type"] = "bbox";
                bboxBoundaryCount++;
                System.Collections.Generic.List<object> centroid = new System.Collections.Generic.List<object>();
                centroid.Add(Round3(ToMm((aabb[0] + aabb[3]) / 2.0)));
                centroid.Add(Round3(ToMm((aabb[1] + aabb[4]) / 2.0)));
                centroid.Add(Round3(ToMm((aabb[2] + aabb[5]) / 2.0)));
                record["centroid_mm"] = centroid;
            }
            else
            {
                boundary["type"] = "unknown";
                unknownBoundaryCount++;
            }
        }
        catch
        {
            boundary["type"] = "unknown";
            unknownBoundaryCount++;
        }
        boundary["points_mm"] = new System.Collections.Generic.List<object>();
        record["boundary"] = boundary;
        roomRecords.Add(record);
    }

    void ExtractSpatial(Autodesk.Revit.DB.BuiltInCategory category, string spatialType)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
            {
                Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
                if (spatial == null) continue;
                Autodesk.Revit.DB.Level sourceLevel = ElementLevel(document, spatial);
                if (!LevelMatches(sourceLevel)) continue;
                AddRoomRecord(spatial, spatialType);
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Spatial validation collector failed: " + ex.Message);
            hasWarn = true;
        }
    }

    bool CategoryExpected(string categoryName)
    {
        return categoryName == "Structural Framing" || categoryName == "Structural Columns" ||
            categoryName == "Walls" || categoryName == "Floors" || categoryName == "Ceilings" ||
            categoryName == "Ducts" || categoryName == "Pipes" ||
            categoryName == "Mechanical Equipment" || categoryName == "Air Terminals";
    }

    void AddObstacle(Autodesk.Revit.DB.Element element, string obstacleType)
    {
        double[] aabb = null;
        try
        {
            aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
        }
        catch
        {
        }
        if (aabb == null) return;
        if (aabb[5] < ceilingZMin - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(500.0)) return;
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["id"] = "Host:" + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        record["element_id"] = element.Id.IntegerValue;
        record["unique_id"] = SafeUniqueId(element);
        record["source_type"] = "host";
        record["source_document_title"] = document.Title;
        record["source_link"] = "Host";
        record["obstacle_type"] = obstacleType;
        string categoryName = CategoryName(element);
        record["category"] = categoryName;
        System.Collections.Generic.Dictionary<string, object> aabbRecord = new System.Collections.Generic.Dictionary<string, object>();
        System.Collections.Generic.List<object> min = new System.Collections.Generic.List<object>();
        System.Collections.Generic.List<object> max = new System.Collections.Generic.List<object>();
        min.Add(Round3(ToMm(aabb[0])));
        min.Add(Round3(ToMm(aabb[1])));
        min.Add(Round3(ToMm(aabb[2])));
        max.Add(Round3(ToMm(aabb[3])));
        max.Add(Round3(ToMm(aabb[4])));
        max.Add(Round3(ToMm(aabb[5])));
        aabbRecord["min_mm"] = min;
        aabbRecord["max_mm"] = max;
        record["aabb_mm"] = aabbRecord;
        obstacleRecords.Add(record);
        Increment(obstacleTypeBreakdown, obstacleType);
        Increment(obstacleCategoryBreakdown, categoryName);
        if (aabb[0] >= aabb[3] || aabb[1] >= aabb[4] || aabb[2] >= aabb[5]) invalidObstacleBoxes++;
        if (!CategoryExpected(categoryName)) unexpectedObstacleCategories++;
    }

    void ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory category, string obstacleType)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
            {
                AddObstacle(element, obstacleType);
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Obstacle validation collector failed for " + category.ToString() + ": " + ex.Message);
            hasWarn = true;
        }
    }

    void AddShaftRecord(Autodesk.Revit.DB.Element element)
    {
        double[] aabb = null;
        try
        {
            aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
        }
        catch
        {
        }
        if (aabb == null) return;
        if (aabb[5] < targetElevation - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(500.0)) return;
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["id"] = "Host:" + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        record["element_id"] = element.Id.IntegerValue;
        record["unique_id"] = SafeUniqueId(element);
        record["source_type"] = "host";
        record["source_document_title"] = document.Title;
        record["source_link"] = "Host";
        record["category"] = CategoryName(element);
        shaftRecords.Add(record);
    }

    void ExtractShafts()
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(Autodesk.Revit.DB.BuiltInCategory.OST_ShaftOpening).WhereElementIsNotElementType())
            {
                AddShaftRecord(element);
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Shaft opening validation collector failed: " + ex.Message);
            hasWarn = true;
        }
    }

    ExtractSpatial(Autodesk.Revit.DB.BuiltInCategory.OST_Rooms, "room");
    ExtractSpatial(Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces, "space");
    ExtractShafts();
    ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming, "beam");
    ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns, "column");
    ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Walls, "wall_or_partition");
    ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Floors, "slab_or_floor");
    ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings, "ceiling");
    if (includeExistingMep)
    {
        ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves, "existing_duct");
        ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_PipeCurves, "existing_pipe");
        ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MechanicalEquipment, "existing_mechanical_equipment");
        ExtractObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal, "existing_air_terminal");
    }

    int hostStructuralFramingTotal = CountCategory(document, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming);
    int hostStructuralColumnsTotal = CountCategory(document, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns);
    int beamCount = obstacleTypeBreakdown.ContainsKey("beam") ? obstacleTypeBreakdown["beam"] : 0;
    int columnCount = obstacleTypeBreakdown.ContainsKey("column") ? obstacleTypeBreakdown["column"] : 0;

    AddCheck("room_count", roomRecords.Count >= expectedMinRooms ? "pass" : "fail", "Rooms/spaces found: " + roomRecords.Count.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("ceiling_zone_count", expectedMinCeilingZones <= 1 ? "pass" : "fail", "Single target-level ceiling zone is expected by this diagnostic.");
    AddCheck("plenum_height", plenumHeightMm < 150.0 || plenumHeightMm > 2000.0 ? "warn" : "pass", "Plenum height is " + plenumHeightMm.ToString(System.Globalization.CultureInfo.InvariantCulture) + " mm.");
    AddCheck("obstacle_count", obstacleRecords.Count >= expectedMinObstacles ? "pass" : "fail", "Obstacles found: " + obstacleRecords.Count.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("room_identity_fields", roomRecords.Count > 0 ? "pass" : "fail", "Room records include element_id, unique_id, source_type, source_document_title.");
    AddCheck("room_boundary_quality", bboxBoundaryCount > 0 || unknownBoundaryCount > 0 ? "warn" : "pass", "Room bbox boundaries: " + bboxBoundaryCount.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", unknown: " + unknownBoundaryCount.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("obstacle_identity_fields", obstacleRecords.Count > 0 ? "pass" : "fail", "Obstacle records include element_id, unique_id, source_type, source_document_title.");
    AddCheck("obstacle_aabb_valid", invalidObstacleBoxes == 0 ? "pass" : "fail", "Invalid obstacle AABBs: " + invalidObstacleBoxes.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("obstacle_category_sanity", unexpectedObstacleCategories == 0 ? "pass" : "warn", "Unexpected obstacle categories: " + unexpectedObstacleCategories.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("existing_mep_policy", includeExistingMep ? "pass" : "pass", includeExistingMep ? "Existing MEP categories were included." : "Existing MEP categories were excluded.");
    AddCheck("structural_columns", columnCount >= expectedMinColumns ? "pass" : "fail", "Column obstacles: " + columnCount.ToString(System.Globalization.CultureInfo.InvariantCulture) + "; host StructuralColumns total: " + hostStructuralColumnsTotal.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("structural_framing", beamCount >= expectedMinBeams ? "pass" : (hostStructuralFramingTotal == 0 ? "warn" : "fail"), "Beam obstacles: " + beamCount.ToString(System.Globalization.CultureInfo.InvariantCulture) + "; host StructuralFraming total: " + hostStructuralFramingTotal.ToString(System.Globalization.CultureInfo.InvariantCulture));
    AddCheck("determinism_manual", "warn", "Run extraction twice and compare stable counts before downstream automation if model content changes during validation.");

    if (errors.Count > 0) hasFail = true;

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["room_count"] = roomRecords.Count;
    summary["ceiling_zone_count"] = targetLevel == null ? 0 : 1;
    summary["shaft_count"] = shaftRecords.Count;
    summary["obstacle_count"] = obstacleRecords.Count;
    summary["obstacle_type_breakdown"] = BreakdownRecord(obstacleTypeBreakdown, new string[] { "beam", "column", "wall_or_partition", "slab_or_floor", "structural_slab", "ceiling", "existing_duct", "existing_pipe", "existing_mechanical_equipment", "existing_air_terminal" });
    summary["obstacle_category_breakdown"] = BreakdownRecord(obstacleCategoryBreakdown, new string[] { "Structural Framing", "Structural Columns", "Walls", "Floors", "Ceilings", "Ducts", "Pipes", "Mechanical Equipment", "Air Terminals" });
    summary["target_level_name"] = targetLevel == null ? string.Empty : targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;
    summary["host_structural_framing_total"] = hostStructuralFramingTotal;
    summary["host_structural_columns_total"] = hostStructuralColumnsTotal;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "spatial-zone-validate.v1";
    result["status"] = hasFail ? "fail" : (hasWarn ? "warn" : "pass");
    result["summary"] = summary;
    result["checks"] = checks;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"spatial-zone-validate.v1\",\"status\":\"fail\",\"summary\":{},\"checks\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
