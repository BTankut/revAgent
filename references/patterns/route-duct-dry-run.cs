// Duct routing dry-run pattern.
// Creates SZ_PREVIEW_ROUTE DirectShape route markers only; does not create real ducts.
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
        if (options.ContainsKey(key) && !string.IsNullOrWhiteSpace(options[key])) return options[key];
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

    string NormalizeText(string value)
    {
        return value == null ? string.Empty : value.Trim().ToLowerInvariant();
    }

    System.Collections.Generic.List<object> PointMm(Autodesk.Revit.DB.XYZ point)
    {
        System.Collections.Generic.List<object> record = new System.Collections.Generic.List<object>();
        record.Add(Round3(ToMm(point.X)));
        record.Add(Round3(ToMm(point.Y)));
        record.Add(Round3(ToMm(point.Z)));
        return record;
    }

    System.Collections.Generic.Dictionary<string, object> AabbMmRecord(double[] aabb)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        System.Collections.Generic.List<object> min = new System.Collections.Generic.List<object>();
        System.Collections.Generic.List<object> max = new System.Collections.Generic.List<object>();
        min.Add(Round3(ToMm(aabb[0])));
        min.Add(Round3(ToMm(aabb[1])));
        min.Add(Round3(ToMm(aabb[2])));
        max.Add(Round3(ToMm(aabb[3])));
        max.Add(Round3(ToMm(aabb[4])));
        max.Add(Round3(ToMm(aabb[5])));
        record["min_mm"] = min;
        record["max_mm"] = max;
        record["min"] = min;
        record["max"] = max;
        return record;
    }

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

    Autodesk.Revit.DB.Level targetLevel = null;
    string targetLevelSource = "unresolved";
    string levelIdOption = GetOption("levelId", null);
    string levelNameOption = GetOption("levelName", null);
    if (!string.IsNullOrWhiteSpace(levelIdOption))
    {
        int parsedLevelId;
        if (int.TryParse(levelIdOption, out parsedLevelId))
        {
            targetLevel = document.GetElement(new Autodesk.Revit.DB.ElementId(parsedLevelId)) as Autodesk.Revit.DB.Level;
            if (targetLevel != null) targetLevelSource = "levelId";
        }
    }
    if (targetLevel == null && !string.IsNullOrWhiteSpace(levelNameOption))
    {
        for (int i = 0; i < hostLevels.Count; i++)
        {
            if (NormalizeText(hostLevels[i].Name) == NormalizeText(levelNameOption))
            {
                targetLevel = hostLevels[i];
                targetLevelSource = "levelName";
                break;
            }
        }
    }
    if (targetLevel == null)
    {
        try
        {
            if (document.ActiveView != null && document.ActiveView.GenLevel != null)
            {
                targetLevel = document.ActiveView.GenLevel;
                targetLevelSource = "activeView";
            }
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

    string candidatePrefix = GetOption("candidate_prefix", "SZ_PREVIEW_DIFFUSER");
    string previewPrefix = GetOption("preview_prefix", "SZ_PREVIEW_ROUTE");
    string routeAxis = NormalizeText(GetOption("route_axis", "auto"));
    if (routeAxis != "auto" && routeAxis != "x" && routeAxis != "y")
    {
        warnings.Add("Unknown route_axis '" + routeAxis + "'; using auto.");
        routeAxis = "auto";
    }
    bool previewMode = GetBoolOption("preview_mode", true);
    bool clearExistingPreview = GetBoolOption("clear_existing_preview", true);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    int maxCandidates = System.Math.Max(1, (int)System.Math.Round(GetDoubleOption("max_candidates", 200.0)));
    double routeWidthMm = System.Math.Max(50.0, GetDoubleOption("route_width_mm", 450.0));
    double routeHeightMm = System.Math.Max(30.0, GetDoubleOption("route_height_mm", 120.0));
    double shaftOffsetMm = System.Math.Max(500.0, GetDoubleOption("shaft_offset_mm", 1500.0));
    double routeZMm = GetDoubleOption("route_z_mm", double.NaN);
    double shaftXMm = GetDoubleOption("shaft_x_mm", double.NaN);
    double shaftYMm = GetDoubleOption("shaft_y_mm", double.NaN);
    double shaftZMm = GetDoubleOption("shaft_z_mm", double.NaN);
    double obstacleClearanceMm = System.Math.Max(0.0, GetDoubleOption("obstacle_clearance_mm", 100.0));

    Autodesk.Revit.DB.ElementId previewCategoryId = new Autodesk.Revit.DB.ElementId(Autodesk.Revit.DB.BuiltInCategory.OST_GenericModel);
    if (previewMode && !Autodesk.Revit.DB.DirectShape.IsValidCategoryId(previewCategoryId, document))
    {
        errors.Add("DirectShape category OST_GenericModel is not valid for this document.");
    }

    System.Collections.Generic.List<object[]> candidates = new System.Collections.Generic.List<object[]>();
    foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.DirectShape)).WhereElementIsNotElementType())
    {
        Autodesk.Revit.DB.DirectShape directShape = element as Autodesk.Revit.DB.DirectShape;
        if (directShape == null) continue;
        string appId = string.Empty;
        string appDataId = string.Empty;
        try { appId = directShape.ApplicationId; } catch { }
        try { appDataId = directShape.ApplicationDataId; } catch { }
        string text = (appId ?? string.Empty) + " " + (appDataId ?? string.Empty);
        if (!text.Contains(candidatePrefix)) continue;
        Autodesk.Revit.DB.BoundingBoxXYZ box = directShape.get_BoundingBox(null);
        if (box == null) continue;
        Autodesk.Revit.DB.XYZ point = new Autodesk.Revit.DB.XYZ(
            (box.Min.X + box.Max.X) / 2.0,
            (box.Min.Y + box.Max.Y) / 2.0,
            (box.Min.Z + box.Max.Z) / 2.0);
        candidates.Add(new object[] { directShape.Id.IntegerValue, point });
    }
    candidates.Sort(delegate(object[] left, object[] right)
    {
        return ((int)left[0]).CompareTo((int)right[0]);
    });
    if (candidates.Count > maxCandidates)
    {
        warnings.Add("Candidate markers were limited by max_candidates.");
        candidates.RemoveRange(maxCandidates, candidates.Count - maxCandidates);
    }
    if (candidates.Count == 0)
    {
        errors.Add("No diffuser candidate markers were found for candidate_prefix=" + candidatePrefix + ".");
    }

    double minX = double.PositiveInfinity;
    double minY = double.PositiveInfinity;
    double minZ = double.PositiveInfinity;
    double maxX = double.NegativeInfinity;
    double maxY = double.NegativeInfinity;
    double maxZ = double.NegativeInfinity;
    for (int i = 0; i < candidates.Count; i++)
    {
        Autodesk.Revit.DB.XYZ point = candidates[i][1] as Autodesk.Revit.DB.XYZ;
        if (point == null) continue;
        minX = System.Math.Min(minX, point.X);
        minY = System.Math.Min(minY, point.Y);
        minZ = System.Math.Min(minZ, point.Z);
        maxX = System.Math.Max(maxX, point.X);
        maxY = System.Math.Max(maxY, point.Y);
        maxZ = System.Math.Max(maxZ, point.Z);
    }

    if (routeAxis == "auto" && candidates.Count > 0)
    {
        routeAxis = (maxX - minX) >= (maxY - minY) ? "x" : "y";
    }
    if (routeAxis == "auto") routeAxis = "x";

    double routeZ = !double.IsNaN(routeZMm)
        ? FromMm(routeZMm)
        : (candidates.Count > 0 ? (minZ + maxZ) / 2.0 : (targetLevel == null ? 0.0 : targetLevel.Elevation + FromMm(3000.0)));
    double shaftX = !double.IsNaN(shaftXMm) ? FromMm(shaftXMm) : 0.0;
    double shaftY = !double.IsNaN(shaftYMm) ? FromMm(shaftYMm) : 0.0;
    double shaftZ = !double.IsNaN(shaftZMm) ? FromMm(shaftZMm) : routeZ;
    if (candidates.Count > 0)
    {
        if (double.IsNaN(shaftXMm))
        {
            shaftX = routeAxis == "x" ? minX - FromMm(shaftOffsetMm) : (minX + maxX) / 2.0;
        }
        if (double.IsNaN(shaftYMm))
        {
            shaftY = routeAxis == "y" ? minY - FromMm(shaftOffsetMm) : (minY + maxY) / 2.0;
        }
    }
    Autodesk.Revit.DB.XYZ shaftPoint = new Autodesk.Revit.DB.XYZ(shaftX, shaftY, shaftZ);

    double[] ComputeAabbFeet(Autodesk.Revit.DB.BoundingBoxXYZ box)
    {
        if (box == null) return null;
        return new double[] { box.Min.X, box.Min.Y, box.Min.Z, box.Max.X, box.Max.Y, box.Max.Z };
    }

    bool AabbOverlap(double[] left, double[] right)
    {
        if (left == null || right == null) return false;
        return left[3] >= right[0] && left[0] <= right[3] &&
            left[4] >= right[1] && left[1] <= right[4] &&
            left[5] >= right[2] && left[2] <= right[5];
    }

    System.Collections.Generic.List<object[]> obstacles = new System.Collections.Generic.List<object[]>();
    void CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory category, string label)
    {
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
        {
            double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null));
            if (aabb == null) continue;
            if (candidates.Count > 0)
            {
                double pad = FromMm(2000.0);
                if (aabb[3] < minX - pad || aabb[0] > maxX + pad || aabb[4] < minY - pad || aabb[1] > maxY + pad) continue;
            }
            obstacles.Add(new object[] { aabb, label, element.Id.IntegerValue });
        }
    }
    CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming, "beam");
    CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns, "column");
    CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Walls, "wall_or_partition");
    CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_ShaftOpening, "shaft");
    if (includeExistingMep)
    {
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves, "existing_duct");
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_PipeCurves, "existing_pipe");
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MechanicalEquipment, "existing_mechanical_equipment");
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal, "existing_air_terminal");
    }

    double halfWidth = FromMm(routeWidthMm) / 2.0;
    double halfHeight = FromMm(routeHeightMm) / 2.0;
    double obstacleClearance = FromMm(obstacleClearanceMm);

    double[] SegmentAabb(Autodesk.Revit.DB.XYZ start, Autodesk.Revit.DB.XYZ end)
    {
        double minSegX = System.Math.Min(start.X, end.X) - halfWidth;
        double minSegY = System.Math.Min(start.Y, end.Y) - halfWidth;
        double minSegZ = System.Math.Min(start.Z, end.Z) - halfHeight;
        double maxSegX = System.Math.Max(start.X, end.X) + halfWidth;
        double maxSegY = System.Math.Max(start.Y, end.Y) + halfWidth;
        double maxSegZ = System.Math.Max(start.Z, end.Z) + halfHeight;
        return new double[] { minSegX, minSegY, minSegZ, maxSegX, maxSegY, maxSegZ };
    }

    Autodesk.Revit.DB.ElementId EnsurePreviewMaterial(string materialName)
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
        try
        {
            material.Color = new Autodesk.Revit.DB.Color((byte)230, (byte)40, (byte)170);
            material.Transparency = 20;
            material.UseRenderAppearanceForShading = false;
        }
        catch
        {
        }
        return material.Id;
    }

    Autodesk.Revit.DB.Solid CreateBox(double[] aabb, Autodesk.Revit.DB.ElementId materialId)
    {
        Autodesk.Revit.DB.CurveLoop loop = new Autodesk.Revit.DB.CurveLoop();
        Autodesk.Revit.DB.XYZ p1 = new Autodesk.Revit.DB.XYZ(aabb[0], aabb[1], aabb[2]);
        Autodesk.Revit.DB.XYZ p2 = new Autodesk.Revit.DB.XYZ(aabb[3], aabb[1], aabb[2]);
        Autodesk.Revit.DB.XYZ p3 = new Autodesk.Revit.DB.XYZ(aabb[3], aabb[4], aabb[2]);
        Autodesk.Revit.DB.XYZ p4 = new Autodesk.Revit.DB.XYZ(aabb[0], aabb[4], aabb[2]);
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p1, p2));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p2, p3));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p3, p4));
        loop.Append(Autodesk.Revit.DB.Line.CreateBound(p4, p1));
        System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop> loops = new System.Collections.Generic.List<Autodesk.Revit.DB.CurveLoop>();
        loops.Add(loop);
        if (materialId != null && materialId != Autodesk.Revit.DB.ElementId.InvalidElementId)
        {
            Autodesk.Revit.DB.SolidOptions solidOptions = new Autodesk.Revit.DB.SolidOptions(materialId, Autodesk.Revit.DB.ElementId.InvalidElementId);
            try
            {
                return Autodesk.Revit.DB.GeometryCreationUtilities.CreateExtrusionGeometry(loops, Autodesk.Revit.DB.XYZ.BasisZ, aabb[5] - aabb[2], solidOptions);
            }
            finally
            {
                solidOptions.Dispose();
            }
        }
        return Autodesk.Revit.DB.GeometryCreationUtilities.CreateExtrusionGeometry(loops, Autodesk.Revit.DB.XYZ.BasisZ, aabb[5] - aabb[2]);
    }

    System.Collections.Generic.List<object> segments = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> branchTree = new System.Collections.Generic.List<object>();
    double estimatedLengthMm = 0.0;
    int estimatedElbowCount = 0;
    int routeIntersectionCount = 0;

    void AddSegment(string segmentType, int sourceMarkerId, Autodesk.Revit.DB.XYZ start, Autodesk.Revit.DB.XYZ end)
    {
        double lengthFeet = start.DistanceTo(end);
        if (lengthFeet <= FromMm(10.0)) return;
        double[] aabb = SegmentAabb(start, end);
        int segmentIntersections = 0;
        System.Collections.Generic.List<object> obstacleHits = new System.Collections.Generic.List<object>();
        for (int i = 0; i < obstacles.Count; i++)
        {
            double[] obstacleAabb = obstacles[i][0] as double[];
            if (obstacleAabb == null) continue;
            double[] paddedObstacle = new double[] {
                obstacleAabb[0] - obstacleClearance,
                obstacleAabb[1] - obstacleClearance,
                obstacleAabb[2] - obstacleClearance,
                obstacleAabb[3] + obstacleClearance,
                obstacleAabb[4] + obstacleClearance,
                obstacleAabb[5] + obstacleClearance
            };
            if (!AabbOverlap(aabb, paddedObstacle)) continue;
            segmentIntersections++;
            if (obstacleHits.Count < 20)
            {
                System.Collections.Generic.Dictionary<string, object> hit = new System.Collections.Generic.Dictionary<string, object>();
                hit["obstacle_id"] = obstacles[i][2];
                hit["obstacle_type"] = obstacles[i][1];
                obstacleHits.Add(hit);
            }
        }

        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["id"] = "route-segment-" + (segments.Count + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        record["segment_type"] = segmentType;
        record["source_marker_id"] = sourceMarkerId == 0 ? null : (object)sourceMarkerId;
        record["start_mm"] = PointMm(start);
        record["end_mm"] = PointMm(end);
        record["length_mm"] = Round3(ToMm(lengthFeet));
        record["aabb_mm"] = AabbMmRecord(aabb);
        record["obstacle_intersection_count"] = segmentIntersections;
        record["obstacle_hits"] = obstacleHits;
        segments.Add(record);
        estimatedLengthMm += ToMm(lengthFeet);
        routeIntersectionCount += segmentIntersections;
    }

    if (errors.Count == 0 && candidates.Count > 0)
    {
        if (routeAxis == "x")
        {
            double trunkMinX = System.Math.Min(shaftPoint.X, minX);
            double trunkMaxX = System.Math.Max(shaftPoint.X, maxX);
            Autodesk.Revit.DB.XYZ trunkStart = new Autodesk.Revit.DB.XYZ(trunkMinX, shaftPoint.Y, routeZ);
            Autodesk.Revit.DB.XYZ trunkEnd = new Autodesk.Revit.DB.XYZ(trunkMaxX, shaftPoint.Y, routeZ);
            AddSegment("trunk", 0, trunkStart, trunkEnd);
            for (int i = 0; i < candidates.Count; i++)
            {
                int markerId = (int)candidates[i][0];
                Autodesk.Revit.DB.XYZ candidatePoint = candidates[i][1] as Autodesk.Revit.DB.XYZ;
                if (candidatePoint == null) continue;
                Autodesk.Revit.DB.XYZ branchStart = new Autodesk.Revit.DB.XYZ(candidatePoint.X, shaftPoint.Y, routeZ);
                Autodesk.Revit.DB.XYZ branchEnd = new Autodesk.Revit.DB.XYZ(candidatePoint.X, candidatePoint.Y, routeZ);
                AddSegment("branch", markerId, branchStart, branchEnd);
                if (branchStart.DistanceTo(branchEnd) > FromMm(10.0)) estimatedElbowCount++;
                System.Collections.Generic.Dictionary<string, object> branch = new System.Collections.Generic.Dictionary<string, object>();
                branch["source_marker_id"] = markerId;
                branch["connection_point_mm"] = PointMm(branchStart);
                branch["terminal_point_mm"] = PointMm(branchEnd);
                branchTree.Add(branch);
            }
        }
        else
        {
            double trunkMinY = System.Math.Min(shaftPoint.Y, minY);
            double trunkMaxY = System.Math.Max(shaftPoint.Y, maxY);
            Autodesk.Revit.DB.XYZ trunkStart = new Autodesk.Revit.DB.XYZ(shaftPoint.X, trunkMinY, routeZ);
            Autodesk.Revit.DB.XYZ trunkEnd = new Autodesk.Revit.DB.XYZ(shaftPoint.X, trunkMaxY, routeZ);
            AddSegment("trunk", 0, trunkStart, trunkEnd);
            for (int i = 0; i < candidates.Count; i++)
            {
                int markerId = (int)candidates[i][0];
                Autodesk.Revit.DB.XYZ candidatePoint = candidates[i][1] as Autodesk.Revit.DB.XYZ;
                if (candidatePoint == null) continue;
                Autodesk.Revit.DB.XYZ branchStart = new Autodesk.Revit.DB.XYZ(shaftPoint.X, candidatePoint.Y, routeZ);
                Autodesk.Revit.DB.XYZ branchEnd = new Autodesk.Revit.DB.XYZ(candidatePoint.X, candidatePoint.Y, routeZ);
                AddSegment("branch", markerId, branchStart, branchEnd);
                if (branchStart.DistanceTo(branchEnd) > FromMm(10.0)) estimatedElbowCount++;
                System.Collections.Generic.Dictionary<string, object> branch = new System.Collections.Generic.Dictionary<string, object>();
                branch["source_marker_id"] = markerId;
                branch["connection_point_mm"] = PointMm(branchStart);
                branch["terminal_point_mm"] = PointMm(branchEnd);
                branchTree.Add(branch);
            }
        }
    }

    int previewSegmentsCreated = 0;
    if (previewMode && errors.Count == 0)
    {
        if (!document.IsModifiable)
        {
            transaction = new Autodesk.Revit.DB.Transaction(document, "Duct Route Dry Run Preview");
            transaction.Start();
            startedOwnTransaction = true;
        }
        Autodesk.Revit.DB.ElementId materialId = EnsurePreviewMaterial(previewPrefix + " Material");
        if (clearExistingPreview)
        {
            System.Collections.Generic.List<Autodesk.Revit.DB.ElementId> deleteIds = new System.Collections.Generic.List<Autodesk.Revit.DB.ElementId>();
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.DirectShape)).WhereElementIsNotElementType())
            {
                Autodesk.Revit.DB.DirectShape directShape = element as Autodesk.Revit.DB.DirectShape;
                if (directShape == null) continue;
                string appId = string.Empty;
                string appDataId = string.Empty;
                try { appId = directShape.ApplicationId; } catch { }
                try { appDataId = directShape.ApplicationDataId; } catch { }
                if ((!string.IsNullOrWhiteSpace(appId) && appId == previewPrefix) ||
                    (!string.IsNullOrWhiteSpace(appDataId) && appDataId.Contains(previewPrefix)))
                {
                    deleteIds.Add(element.Id);
                }
            }
            if (deleteIds.Count > 0) document.Delete(deleteIds);
        }
        for (int i = 0; i < segments.Count; i++)
        {
            System.Collections.Generic.Dictionary<string, object> segment = segments[i] as System.Collections.Generic.Dictionary<string, object>;
            if (segment == null || !segment.ContainsKey("aabb_mm")) continue;
            System.Collections.Generic.Dictionary<string, object> aabbMm = segment["aabb_mm"] as System.Collections.Generic.Dictionary<string, object>;
            if (aabbMm == null) continue;
            System.Collections.IList minList = aabbMm["min_mm"] as System.Collections.IList;
            System.Collections.IList maxList = aabbMm["max_mm"] as System.Collections.IList;
            if (minList == null || maxList == null || minList.Count < 3 || maxList.Count < 3) continue;
            double[] aabbFeet = new double[] {
                FromMm(System.Convert.ToDouble(minList[0], System.Globalization.CultureInfo.InvariantCulture)),
                FromMm(System.Convert.ToDouble(minList[1], System.Globalization.CultureInfo.InvariantCulture)),
                FromMm(System.Convert.ToDouble(minList[2], System.Globalization.CultureInfo.InvariantCulture)),
                FromMm(System.Convert.ToDouble(maxList[0], System.Globalization.CultureInfo.InvariantCulture)),
                FromMm(System.Convert.ToDouble(maxList[1], System.Globalization.CultureInfo.InvariantCulture)),
                FromMm(System.Convert.ToDouble(maxList[2], System.Globalization.CultureInfo.InvariantCulture))
            };
            Autodesk.Revit.DB.Solid solid = CreateBox(aabbFeet, materialId);
            Autodesk.Revit.DB.DirectShape directShape = Autodesk.Revit.DB.DirectShape.CreateElement(document, previewCategoryId);
            directShape.ApplicationId = previewPrefix;
            directShape.ApplicationDataId = previewPrefix + " route-duct-dry-run.v1 | " + System.Convert.ToString(segment["id"], System.Globalization.CultureInfo.InvariantCulture);
            System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject> geometry = new System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject>();
            geometry.Add(solid);
            directShape.SetShape(geometry);
            try
            {
                Autodesk.Revit.DB.Parameter comments = directShape.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                if (comments != null && !comments.IsReadOnly) comments.Set(previewPrefix + " | route-dry-run");
            }
            catch
            {
            }
            previewSegmentsCreated++;
        }
        if (startedOwnTransaction && transaction != null)
        {
            transaction.Commit();
            transaction = null;
            startedOwnTransaction = false;
        }
    }

    if (routeIntersectionCount > 0)
    {
        warnings.Add("Dry-run route has AABB obstacle intersections; review obstacle_hits before real duct routing.");
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["candidate_marker_count"] = candidates.Count;
    summary["route_axis"] = routeAxis;
    summary["segment_count"] = segments.Count;
    summary["branch_count"] = branchTree.Count;
    summary["preview_segments_created"] = previewSegmentsCreated;
    summary["estimated_length_mm"] = Round3(estimatedLengthMm);
    summary["estimated_length_m"] = Round3(estimatedLengthMm / 1000.0);
    summary["estimated_elbow_count"] = estimatedElbowCount;
    summary["route_obstacle_intersection_count"] = routeIntersectionCount;
    summary["obstacles_considered"] = obstacles.Count;
    summary["route_width_mm"] = Round3(routeWidthMm);
    summary["route_height_mm"] = Round3(routeHeightMm);
    summary["route_z_mm"] = Round3(ToMm(routeZ));
    summary["shaft_point_mm"] = PointMm(shaftPoint);
    summary["target_level_name"] = targetLevel == null ? string.Empty : targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;
    summary["preview_prefix"] = previewPrefix;
    summary["candidate_prefix"] = candidatePrefix;
    summary["preview_mode"] = previewMode;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "route-duct-dry-run.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["segments"] = segments;
    result["branch_tree"] = branchTree;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    try
    {
        if (startedOwnTransaction && transaction != null) transaction.RollBack();
    }
    catch
    {
    }
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"route-duct-dry-run.v1\",\"status\":\"fail\",\"summary\":{},\"segments\":[],\"branch_tree\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
