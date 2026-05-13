// Diffuser candidate preview pattern.
// Creates SZ_PREVIEW_DIFFUSER DirectShape markers only; does not place real diffuser families.
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
    if (!options.ContainsKey("spatial_id") && options.ContainsKey("room_id")) options["spatial_id"] = options["room_id"];

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
    string levelElevationOption = GetOption("target_level_elevation_mm", GetOption("level_elevation_mm", null));
    double levelToleranceMm = GetDoubleOption("level_elevation_tolerance_mm", 100.0);

    if (!string.IsNullOrWhiteSpace(levelIdOption))
    {
        int parsedLevelId;
        if (int.TryParse(levelIdOption, out parsedLevelId))
        {
            Autodesk.Revit.DB.Level level = document.GetElement(new Autodesk.Revit.DB.ElementId(parsedLevelId)) as Autodesk.Revit.DB.Level;
            if (level != null)
            {
                targetLevel = level;
                targetLevelSource = "levelId";
            }
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
    if (targetLevel == null && !string.IsNullOrWhiteSpace(levelElevationOption))
    {
        double elevationMm;
        if (double.TryParse(levelElevationOption, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out elevationMm) ||
            double.TryParse(levelElevationOption, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.CurrentCulture, out elevationMm))
        {
            double elevationFeet = FromMm(elevationMm);
            double bestDistance = double.PositiveInfinity;
            for (int i = 0; i < hostLevels.Count; i++)
            {
                double distance = System.Math.Abs(hostLevels[i].Elevation - elevationFeet);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    targetLevel = hostLevels[i];
                }
            }
            if (targetLevel != null && bestDistance <= FromMm(levelToleranceMm))
            {
                targetLevelSource = "levelElevation";
            }
            else
            {
                targetLevel = null;
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
    if (targetLevel == null)
    {
        errors.Add("No target level could be resolved.");
        System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
        failed["schema_version"] = "diffuser-candidate-preview.v1";
        failed["status"] = "fail";
        failed["summary"] = new System.Collections.Generic.Dictionary<string, object>();
        failed["candidate_diffusers"] = new System.Collections.Generic.List<object>();
        failed["warnings"] = warnings;
        failed["errors"] = errors;
        return SerializeJson(failed);
    }

    string previewPrefix = GetOption("preview_prefix", "SZ_PREVIEW_DIFFUSER");
    string marker = previewPrefix + " diffuser-candidate-preview.v1";
    bool previewMode = GetBoolOption("preview_mode", true);
    bool clearExistingPreview = GetBoolOption("clear_existing_preview", true);
    bool includeRooms = GetBoolOption("include_rooms", true);
    bool includeSpaces = GetBoolOption("include_spaces", true);
    bool avoidObstacles = GetBoolOption("avoid_obstacles", true);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    string targetSpatialIdOption = GetOption("spatial_id", null);
    string targetElementIdOption = GetOption("element_id", null);
    string targetNumberOption = GetOption("room_number", GetOption("number", null));
    string placementRule = NormalizeText(GetOption("placement_rule", "auto"));
    if (placementRule != "auto" && placementRule != "center" && placementRule != "grid" && placementRule != "perimeter")
    {
        warnings.Add("Unknown placement_rule '" + placementRule + "'; using auto.");
        placementRule = "auto";
    }

    double airflowLps = GetDoubleOption("airflow_lps", double.NaN);
    double airflowM3h = GetDoubleOption("airflow_m3h", double.NaN);
    if ((double.IsNaN(airflowLps) || airflowLps <= 0.0) && !double.IsNaN(airflowM3h) && airflowM3h > 0.0)
    {
        airflowLps = airflowM3h / 3.6;
    }
    double airflowPerAreaLpsM2 = GetDoubleOption("airflow_per_area_lps_m2", 0.0);
    double maxDiffuserAirflowLps = System.Math.Max(1.0, GetDoubleOption("max_diffuser_airflow_lps", 150.0));
    int defaultDiffuserCount = System.Math.Max(1, (int)System.Math.Round(GetDoubleOption("default_diffuser_count", 1.0)));
    int maxCandidatesPerSpatial = System.Math.Max(1, (int)System.Math.Round(GetDoubleOption("max_candidates_per_spatial", 12.0)));
    double minWallDistanceMm = System.Math.Max(0.0, GetDoubleOption("min_wall_distance_mm", 600.0));
    double obstacleClearanceMm = System.Math.Max(0.0, GetDoubleOption("obstacle_clearance_mm", 300.0));
    double markerSizeMm = System.Math.Max(50.0, GetDoubleOption("marker_size_mm", 250.0));
    double markerHeightMm = System.Math.Max(20.0, GetDoubleOption("marker_height_mm", 80.0));
    double defaultCeilingHeightMm = GetDoubleOption("default_ceiling_height_mm", 2700.0);
    double defaultPlenumHeightMm = GetDoubleOption("default_plenum_height_mm", 600.0);
    double ceilingZMin = targetLevel.Elevation + FromMm(defaultCeilingHeightMm);
    double ceilingZMax = ceilingZMin + FromMm(defaultPlenumHeightMm);
    string ceilingZSource = "fallback_default_ceiling_height";
    string slabZSource = "fallback_default_plenum_height";
    string ceilingSourceElement = string.Empty;
    string slabSourceElement = string.Empty;

    Autodesk.Revit.DB.ElementId previewCategoryId = new Autodesk.Revit.DB.ElementId(Autodesk.Revit.DB.BuiltInCategory.OST_GenericModel);
    if (previewMode && !Autodesk.Revit.DB.DirectShape.IsValidCategoryId(previewCategoryId, document))
    {
        errors.Add("DirectShape category OST_GenericModel is not valid for this document.");
        System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
        failed["schema_version"] = "diffuser-candidate-preview.v1";
        failed["status"] = "fail";
        failed["summary"] = new System.Collections.Generic.Dictionary<string, object>();
        failed["candidate_diffusers"] = new System.Collections.Generic.List<object>();
        failed["warnings"] = warnings;
        failed["errors"] = errors;
        return SerializeJson(failed);
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

    bool LevelMatches(Autodesk.Revit.DB.Level sourceLevel)
    {
        if (sourceLevel == null) return false;
        if (NormalizeText(sourceLevel.Name) == NormalizeText(targetLevel.Name)) return true;
        return System.Math.Abs(sourceLevel.Elevation - targetLevel.Elevation) <= FromMm(levelToleranceMm);
    }

    string ParameterText(Autodesk.Revit.DB.Element element, string name)
    {
        if (element == null || string.IsNullOrWhiteSpace(name)) return string.Empty;
        try
        {
            Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(name);
            if (parameter == null || !parameter.HasValue) return string.Empty;
            string valueString = parameter.AsValueString();
            if (!string.IsNullOrWhiteSpace(valueString)) return valueString;
            return parameter.AsString() ?? string.Empty;
        }
        catch
        {
        }
        return string.Empty;
    }

    double SpatialAreaM2(Autodesk.Revit.DB.SpatialElement spatial)
    {
        try
        {
            return Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(spatial.Area, Autodesk.Revit.DB.UnitTypeId.SquareMeters);
        }
        catch
        {
        }
        return 0.0;
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
            warnings.Add("Boundary extraction failed for spatial element " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message);
        }
        return null;
    }

    bool PointInsidePolygon(Autodesk.Revit.DB.XYZ point, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon)
    {
        if (point == null || polygon == null || polygon.Count < 3) return false;
        bool inside = false;
        for (int i = 0, j = polygon.Count - 1; i < polygon.Count; j = i++)
        {
            Autodesk.Revit.DB.XYZ pi = polygon[i];
            Autodesk.Revit.DB.XYZ pj = polygon[j];
            bool intersects = ((pi.Y > point.Y) != (pj.Y > point.Y)) &&
                (point.X < (pj.X - pi.X) * (point.Y - pi.Y) / (pj.Y - pi.Y + 1e-12) + pi.X);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    double DistanceToSegment2d(Autodesk.Revit.DB.XYZ point, Autodesk.Revit.DB.XYZ start, Autodesk.Revit.DB.XYZ end)
    {
        double dx = end.X - start.X;
        double dy = end.Y - start.Y;
        double lengthSquared = dx * dx + dy * dy;
        if (lengthSquared <= 1e-12)
        {
            double sx = point.X - start.X;
            double sy = point.Y - start.Y;
            return System.Math.Sqrt(sx * sx + sy * sy);
        }
        double t = ((point.X - start.X) * dx + (point.Y - start.Y) * dy) / lengthSquared;
        t = System.Math.Max(0.0, System.Math.Min(1.0, t));
        double px = start.X + t * dx;
        double py = start.Y + t * dy;
        double rx = point.X - px;
        double ry = point.Y - py;
        return System.Math.Sqrt(rx * rx + ry * ry);
    }

    double DistanceToBoundary(Autodesk.Revit.DB.XYZ point, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon, double[] aabb)
    {
        if (polygon != null && polygon.Count >= 3)
        {
            double best = double.PositiveInfinity;
            for (int i = 0; i < polygon.Count; i++)
            {
                Autodesk.Revit.DB.XYZ start = polygon[i];
                Autodesk.Revit.DB.XYZ end = polygon[(i + 1) % polygon.Count];
                best = System.Math.Min(best, DistanceToSegment2d(point, start, end));
            }
            return best;
        }
        if (aabb == null) return double.PositiveInfinity;
        return System.Math.Min(
            System.Math.Min(point.X - aabb[0], aabb[3] - point.X),
            System.Math.Min(point.Y - aabb[1], aabb[4] - point.Y));
    }

    bool PointInsideFootprint(Autodesk.Revit.DB.XYZ point, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon, double[] aabb)
    {
        if (polygon != null && polygon.Count >= 3) return PointInsidePolygon(point, polygon);
        if (aabb == null) return false;
        return point.X >= aabb[0] && point.X <= aabb[3] && point.Y >= aabb[1] && point.Y <= aabb[4];
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
        try
        {
            material.Color = new Autodesk.Revit.DB.Color((byte)255, (byte)190, (byte)0);
            material.Transparency = 15;
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

    Autodesk.Revit.DB.Solid MakeBox(double centerX, double centerY, double centerZ, double size, double height, Autodesk.Revit.DB.ElementId materialId)
    {
        double half = size / 2.0;
        double minX = centerX - half;
        double minY = centerY - half;
        double minZ = centerZ - height / 2.0;
        double maxX = centerX + half;
        double maxY = centerY + half;
        double maxZ = centerZ + height / 2.0;
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

    bool hasFootprint = false;
    double footprintMinX = double.PositiveInfinity;
    double footprintMinY = double.PositiveInfinity;
    double footprintMaxX = double.NegativeInfinity;
    double footprintMaxY = double.NegativeInfinity;

    void ExpandFootprint(double[] aabb)
    {
        if (aabb == null) return;
        hasFootprint = true;
        footprintMinX = System.Math.Min(footprintMinX, aabb[0]);
        footprintMinY = System.Math.Min(footprintMinY, aabb[1]);
        footprintMaxX = System.Math.Max(footprintMaxX, aabb[3]);
        footprintMaxY = System.Math.Max(footprintMaxY, aabb[4]);
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

    System.Collections.Generic.List<object[]> spatialRecords = new System.Collections.Generic.List<object[]>();
    int roomsProcessed = 0;
    int spacesProcessed = 0;
    int skippedSpatialFilterCount = 0;

    void CollectSpatialCategory(Autodesk.Revit.DB.BuiltInCategory category, string spatialType)
    {
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
        {
            Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
            if (spatial == null) continue;
            if (!LevelMatches(ElementLevel(document, spatial))) continue;
            string spatialId = "Host:" + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
            string elementIdText = spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
            string number = ParameterText(spatial, "Number");
            if (string.IsNullOrWhiteSpace(number))
            {
                try
                {
                    Autodesk.Revit.DB.Architecture.Room roomElement = spatial as Autodesk.Revit.DB.Architecture.Room;
                    if (roomElement != null) number = roomElement.Number;
                }
                catch
                {
                }
            }
            if (!string.IsNullOrWhiteSpace(targetSpatialIdOption) &&
                NormalizeText(targetSpatialIdOption) != NormalizeText(spatialId) &&
                NormalizeText(targetSpatialIdOption) != NormalizeText(elementIdText))
            {
                skippedSpatialFilterCount++;
                continue;
            }
            if (!string.IsNullOrWhiteSpace(targetElementIdOption) && NormalizeText(targetElementIdOption) != NormalizeText(elementIdText))
            {
                skippedSpatialFilterCount++;
                continue;
            }
            if (!string.IsNullOrWhiteSpace(targetNumberOption) && NormalizeText(targetNumberOption) != NormalizeText(number))
            {
                skippedSpatialFilterCount++;
                continue;
            }

            double[] aabb = ComputeAabbFeet(spatial.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
            if (aabb == null) continue;
            System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon = SpatialBoundaryPoints(spatial);
            double areaM2 = SpatialAreaM2(spatial);
            string boundarySource = polygon != null && polygon.Count >= 3 ? "polygon" : "bbox_fallback";
            spatialRecords.Add(new object[] { spatial, spatialType, aabb, polygon, areaM2, boundarySource, number });
            ExpandFootprint(aabb);
            if (spatialType == "space") spacesProcessed++;
            else roomsProcessed++;
        }
    }

    if (includeRooms) CollectSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_Rooms, "room");
    if (includeSpaces) CollectSpatialCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces, "space");

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

    double candidateZ = ceilingZMin + System.Math.Min(FromMm(150.0), System.Math.Max(FromMm(40.0), (ceilingZMax - ceilingZMin) / 2.0));
    System.Collections.Generic.List<object[]> obstacleRecords = new System.Collections.Generic.List<object[]>();

    void CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory category, string label)
    {
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(category).WhereElementIsNotElementType())
        {
            double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), Autodesk.Revit.DB.Transform.Identity);
            if (aabb == null) continue;
            if (aabb[5] < ceilingZMin - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(500.0)) continue;
            if (!AabbOverlapsFootprint(aabb, FromMm(1000.0))) continue;
            obstacleRecords.Add(new object[] { aabb, label, element.Id.IntegerValue });
        }
    }

    if (avoidObstacles)
    {
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming, "beam");
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns, "column");
        CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_ShaftOpening, "shaft");
        if (includeExistingMep)
        {
            CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves, "existing_duct");
            CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_PipeCurves, "existing_pipe");
            CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_MechanicalEquipment, "existing_mechanical_equipment");
            CollectObstacleCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal, "existing_air_terminal");
        }
    }

    bool PointConflictsObstacle(Autodesk.Revit.DB.XYZ point)
    {
        if (!avoidObstacles) return false;
        double clearance = FromMm(obstacleClearanceMm);
        for (int i = 0; i < obstacleRecords.Count; i++)
        {
            double[] aabb = obstacleRecords[i][0] as double[];
            if (aabb == null) continue;
            if (aabb[5] < ceilingZMin || aabb[2] > ceilingZMax) continue;
            if (point.X >= aabb[0] - clearance && point.X <= aabb[3] + clearance &&
                point.Y >= aabb[1] - clearance && point.Y <= aabb[4] + clearance)
            {
                return true;
            }
        }
        return false;
    }

    bool HasDuplicate(System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> points, Autodesk.Revit.DB.XYZ candidate)
    {
        double minDistance = FromMm(150.0);
        for (int i = 0; i < points.Count; i++)
        {
            double dx = points[i].X - candidate.X;
            double dy = points[i].Y - candidate.Y;
            if (System.Math.Sqrt(dx * dx + dy * dy) < minDistance) return true;
        }
        return false;
    }

    bool TryAcceptPoint(Autodesk.Revit.DB.XYZ point, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon, double[] aabb, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> accepted, out string rejectionReason)
    {
        rejectionReason = string.Empty;
        if (!PointInsideFootprint(point, polygon, aabb))
        {
            rejectionReason = "outside_footprint";
            return false;
        }
        if (DistanceToBoundary(point, polygon, aabb) < FromMm(minWallDistanceMm))
        {
            rejectionReason = "wall_distance";
            return false;
        }
        if (PointConflictsObstacle(point))
        {
            rejectionReason = "obstacle";
            return false;
        }
        if (HasDuplicate(accepted, point))
        {
            rejectionReason = "duplicate";
            return false;
        }
        return true;
    }

    System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> GenerateCandidatePoints(double[] aabb, System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon, int requestedCount, string rule, out int obstacleRejects, out int wallRejects, out int outsideRejects)
    {
        int obstacleRejectsLocal = 0;
        int wallRejectsLocal = 0;
        int outsideRejectsLocal = 0;
        System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> accepted = new System.Collections.Generic.List<Autodesk.Revit.DB.XYZ>();
        if (aabb == null || requestedCount <= 0)
        {
            obstacleRejects = obstacleRejectsLocal;
            wallRejects = wallRejectsLocal;
            outsideRejects = outsideRejectsLocal;
            return accepted;
        }

        System.Action<Autodesk.Revit.DB.XYZ> tryAdd = delegate(Autodesk.Revit.DB.XYZ candidate)
        {
            if (accepted.Count >= requestedCount) return;
            string reason;
            if (TryAcceptPoint(candidate, polygon, aabb, accepted, out reason))
            {
                accepted.Add(candidate);
            }
            else if (reason == "obstacle")
            {
                obstacleRejectsLocal++;
            }
            else if (reason == "wall_distance")
            {
                wallRejectsLocal++;
            }
            else if (reason == "outside_footprint")
            {
                outsideRejectsLocal++;
            }
        };

        Autodesk.Revit.DB.XYZ center = new Autodesk.Revit.DB.XYZ((aabb[0] + aabb[3]) / 2.0, (aabb[1] + aabb[4]) / 2.0, candidateZ);
        if (rule == "center" || rule == "auto" || requestedCount == 1)
        {
            tryAdd(center);
        }
        if (accepted.Count >= requestedCount || rule == "center")
        {
            obstacleRejects = obstacleRejectsLocal;
            wallRejects = wallRejectsLocal;
            outsideRejects = outsideRejectsLocal;
            return accepted;
        }

        double inset = FromMm(minWallDistanceMm);
        double minX = aabb[0] + inset;
        double maxX = aabb[3] - inset;
        double minY = aabb[1] + inset;
        double maxY = aabb[4] - inset;
        if (maxX <= minX)
        {
            minX = aabb[0];
            maxX = aabb[3];
        }
        if (maxY <= minY)
        {
            minY = aabb[1];
            maxY = aabb[4];
        }

        int baseGrid = System.Math.Max(1, (int)System.Math.Ceiling(System.Math.Sqrt((double)requestedCount)));
        for (int grid = baseGrid; grid <= baseGrid + 8 && accepted.Count < requestedCount; grid++)
        {
            for (int iy = 0; iy < grid && accepted.Count < requestedCount; iy++)
            {
                for (int ix = 0; ix < grid && accepted.Count < requestedCount; ix++)
                {
                    double x = minX + ((double)ix + 0.5) * (maxX - minX) / (double)grid;
                    double y = minY + ((double)iy + 0.5) * (maxY - minY) / (double)grid;
                    if (rule == "perimeter")
                    {
                        bool nearPerimeterSlot = ix == 0 || iy == 0 || ix == grid - 1 || iy == grid - 1;
                        if (!nearPerimeterSlot) continue;
                    }
                    tryAdd(new Autodesk.Revit.DB.XYZ(x, y, candidateZ));
                }
            }
        }

        obstacleRejects = obstacleRejectsLocal;
        wallRejects = wallRejectsLocal;
        outsideRejects = outsideRejectsLocal;
        return accepted;
    }

    int CandidateCountForSpatial(double areaM2, out double assignedAirflowLps)
    {
        assignedAirflowLps = 0.0;
        if (!double.IsNaN(airflowLps) && airflowLps > 0.0)
        {
            assignedAirflowLps = airflowLps;
        }
        else if (airflowPerAreaLpsM2 > 0.0 && areaM2 > 0.0)
        {
            assignedAirflowLps = airflowPerAreaLpsM2 * areaM2;
        }

        int count = assignedAirflowLps > 0.0
            ? (int)System.Math.Ceiling(assignedAirflowLps / maxDiffuserAirflowLps)
            : defaultDiffuserCount;
        count = System.Math.Max(1, count);
        count = System.Math.Min(maxCandidatesPerSpatial, count);
        return count;
    }

    Autodesk.Revit.DB.ElementId previewMaterialId = Autodesk.Revit.DB.ElementId.InvalidElementId;
    if (previewMode)
    {
        if (!document.IsModifiable)
        {
            transaction = new Autodesk.Revit.DB.Transaction(document, "Diffuser Candidate Preview");
            transaction.Start();
            startedOwnTransaction = true;
        }
        previewMaterialId = EnsurePreviewMaterial(previewPrefix + " Candidate", 255, 190, 0, 15);
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
    }

    System.Collections.Generic.List<object> candidateRecords = new System.Collections.Generic.List<object>();
    int markersCreated = 0;
    int spatialWithCandidates = 0;
    int spatialWithoutCandidates = 0;
    int obstacleRejectCount = 0;
    int wallRejectCount = 0;
    int outsideRejectCount = 0;
    int truncatedByMaxCount = 0;
    int polygonBoundaryCount = 0;
    int bboxFallbackCount = 0;

    for (int i = 0; i < spatialRecords.Count; i++)
    {
        Autodesk.Revit.DB.SpatialElement spatial = spatialRecords[i][0] as Autodesk.Revit.DB.SpatialElement;
        string spatialType = spatialRecords[i][1] as string;
        double[] aabb = spatialRecords[i][2] as double[];
        System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> polygon = spatialRecords[i][3] as System.Collections.Generic.List<Autodesk.Revit.DB.XYZ>;
        double areaM2 = (double)spatialRecords[i][4];
        string boundarySource = spatialRecords[i][5] as string;
        string number = spatialRecords[i][6] as string;
        if (spatial == null || aabb == null) continue;
        if (boundarySource == "polygon") polygonBoundaryCount++;
        else bboxFallbackCount++;

        double assignedAirflowLps;
        int requestedCount = CandidateCountForSpatial(areaM2, out assignedAirflowLps);
        if (requestedCount >= maxCandidatesPerSpatial) truncatedByMaxCount++;
        int localObstacleRejects;
        int localWallRejects;
        int localOutsideRejects;
        string effectivePlacementRule = placementRule == "auto" ? "auto" : placementRule;
        System.Collections.Generic.List<Autodesk.Revit.DB.XYZ> points = GenerateCandidatePoints(aabb, polygon, requestedCount, effectivePlacementRule, out localObstacleRejects, out localWallRejects, out localOutsideRejects);
        obstacleRejectCount += localObstacleRejects;
        wallRejectCount += localWallRejects;
        outsideRejectCount += localOutsideRejects;
        if (points.Count == 0)
        {
            spatialWithoutCandidates++;
            warnings.Add("No diffuser candidate could be generated for " + spatialType + " " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
            continue;
        }
        spatialWithCandidates++;

        for (int candidateIndex = 0; candidateIndex < points.Count; candidateIndex++)
        {
            Autodesk.Revit.DB.XYZ point = points[candidateIndex];
            int markerElementId = 0;
            if (previewMode)
            {
                Autodesk.Revit.DB.Solid markerSolid = MakeBox(point.X, point.Y, point.Z, FromMm(markerSizeMm), FromMm(markerHeightMm), previewMaterialId);
                Autodesk.Revit.DB.DirectShape directShape = Autodesk.Revit.DB.DirectShape.CreateElement(document, previewCategoryId);
                directShape.ApplicationId = previewPrefix;
                directShape.ApplicationDataId = marker + " | diffuser-candidate " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + (candidateIndex + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject> geometry = new System.Collections.Generic.List<Autodesk.Revit.DB.GeometryObject>();
                geometry.Add(markerSolid);
                directShape.SetShape(geometry);
                try
                {
                    Autodesk.Revit.DB.Parameter comments = directShape.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                    if (comments != null && !comments.IsReadOnly) comments.Set(marker + " | diffuser-candidate");
                }
                catch
                {
                }
                markerElementId = directShape.Id.IntegerValue;
                markersCreated++;
            }

            System.Collections.Generic.Dictionary<string, object> candidate = new System.Collections.Generic.Dictionary<string, object>();
            candidate["id"] = "Host:" + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":diffuser-candidate:" + (candidateIndex + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            candidate["source_spatial_id"] = "Host:" + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
            candidate["source_type"] = spatialType;
            candidate["source_element_id"] = spatial.Id.IntegerValue;
            candidate["name"] = spatial.Name;
            candidate["number"] = number;
            candidate["level_name"] = targetLevel.Name;
            candidate["candidate_index"] = candidateIndex + 1;
            candidate["candidate_count_for_spatial"] = points.Count;
            candidate["requested_count_for_spatial"] = requestedCount;
            candidate["assigned_airflow_lps"] = assignedAirflowLps > 0.0 ? (object)Round3(assignedAirflowLps) : null;
            candidate["max_diffuser_airflow_lps"] = Round3(maxDiffuserAirflowLps);
            candidate["placement_rule"] = effectivePlacementRule;
            candidate["boundary_source"] = boundarySource;
            candidate["point_mm"] = PointMm(point);
            candidate["marker_element_id"] = markerElementId == 0 ? null : (object)markerElementId;
            candidate["status"] = "preview";
            candidateRecords.Add(candidate);
        }
    }

    if (startedOwnTransaction && transaction != null)
    {
        transaction.Commit();
        transaction = null;
        startedOwnTransaction = false;
    }

    if (spatialRecords.Count == 0)
    {
        warnings.Add("No host rooms or MEP spaces matched the target level and filters.");
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["target_level_name"] = targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;
    summary["spatial_elements_processed"] = spatialRecords.Count;
    summary["rooms_processed"] = roomsProcessed;
    summary["spaces_processed"] = spacesProcessed;
    summary["skipped_spatial_filter_count"] = skippedSpatialFilterCount;
    summary["candidate_count"] = candidateRecords.Count;
    summary["markers_created"] = markersCreated;
    summary["spatial_with_candidates"] = spatialWithCandidates;
    summary["spatial_without_candidates"] = spatialWithoutCandidates;
    summary["polygon_boundary_count"] = polygonBoundaryCount;
    summary["bbox_fallback_count"] = bboxFallbackCount;
    summary["placement_rule"] = placementRule;
    summary["avoid_obstacles"] = avoidObstacles;
    summary["obstacles_considered"] = obstacleRecords.Count;
    summary["obstacle_avoidance_rejections"] = obstacleRejectCount;
    summary["wall_distance_rejections"] = wallRejectCount;
    summary["outside_footprint_rejections"] = outsideRejectCount;
    summary["truncated_by_max_candidates"] = truncatedByMaxCount;
    summary["min_wall_distance_mm"] = Round3(minWallDistanceMm);
    summary["obstacle_clearance_mm"] = Round3(obstacleClearanceMm);
    summary["max_diffuser_airflow_lps"] = Round3(maxDiffuserAirflowLps);
    summary["default_diffuser_count"] = defaultDiffuserCount;
    summary["preview_mode"] = previewMode;
    summary["preview_prefix"] = previewPrefix;
    summary["plenum_volume_bottom_mm"] = Round3(ToMm(ceilingZMin));
    summary["plenum_volume_top_mm"] = Round3(ToMm(ceilingZMax));
    summary["candidate_z_mm"] = Round3(ToMm(candidateZ));
    summary["plenum_z_source_detail"] = ceilingZSource + "/" + slabZSource;
    summary["ceiling_source_element"] = string.IsNullOrWhiteSpace(ceilingSourceElement) ? null : (object)ceilingSourceElement;
    summary["slab_source_element"] = string.IsNullOrWhiteSpace(slabSourceElement) ? null : (object)slabSourceElement;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "diffuser-candidate-preview.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["candidate_diffusers"] = candidateRecords;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    try
    {
        if (startedOwnTransaction && transaction != null)
        {
            transaction.RollBack();
        }
    }
    catch
    {
    }
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"diffuser-candidate-preview.v1\",\"status\":\"fail\",\"summary\":{},\"candidate_diffusers\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
