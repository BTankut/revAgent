// Commit route preview segments into real Revit ducts.
// Default is dry-run: real Duct creation only happens with --commit=true.
Autodesk.Revit.DB.Transaction transaction = null;
bool startedOwnTransaction = false;
try
{
    System.Collections.Generic.Dictionary<string, string> options =
        new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.List<object> warnings = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> errors = new System.Collections.Generic.List<object>();

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

    if (!options.ContainsKey("route_prefix") && options.ContainsKey("preview_prefix")) options["route_prefix"] = options["preview_prefix"];
    if (!options.ContainsKey("levelName") && options.ContainsKey("target_level")) options["levelName"] = options["target_level"];
    if (!options.ContainsKey("levelId") && options.ContainsKey("target_level_id")) options["levelId"] = options["target_level_id"];
    if (!options.ContainsKey("duct_type_id") && options.ContainsKey("ductTypeId")) options["duct_type_id"] = options["ductTypeId"];
    if (!options.ContainsKey("system_type_id") && options.ContainsKey("systemTypeId")) options["system_type_id"] = options["systemTypeId"];

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

    int GetIntOption(string key, int fallback)
    {
        string value = GetOption(key, null);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        int parsed;
        if (int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out parsed)) return parsed;
        if (int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.CurrentCulture, out parsed)) return parsed;
        warnings.Add("Could not parse integer option '" + key + "'.");
        return fallback;
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

    int ParseRouteSegmentIndex(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return 0;
        string marker = "route-segment-";
        int markerIndex = text.IndexOf(marker, System.StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0) return 0;
        int start = markerIndex + marker.Length;
        System.Text.StringBuilder digits = new System.Text.StringBuilder();
        for (int i = start; i < text.Length; i++)
        {
            if (!char.IsDigit(text[i])) break;
            digits.Append(text[i]);
        }
        int parsed;
        if (int.TryParse(digits.ToString(), out parsed)) return parsed;
        return 0;
    }

    System.Collections.Generic.Dictionary<string, string> ParseMetadataTokens(string text)
    {
        System.Collections.Generic.Dictionary<string, string> tokens =
            new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(text)) return tokens;
        string[] parts = text.Split('|');
        for (int i = 0; i < parts.Length; i++)
        {
            string part = parts[i] == null ? string.Empty : parts[i].Trim();
            int equalsIndex = part.IndexOf('=');
            if (equalsIndex <= 0) continue;
            string key = part.Substring(0, equalsIndex).Trim();
            string value = part.Substring(equalsIndex + 1).Trim();
            if (key.Length > 0) tokens[key] = value;
        }
        return tokens;
    }

    bool TryParsePointMm(string text, out Autodesk.Revit.DB.XYZ point)
    {
        point = null;
        if (string.IsNullOrWhiteSpace(text)) return false;
        string[] parts = text.Split(',');
        if (parts.Length < 3) return false;
        double xMm;
        double yMm;
        double zMm;
        if (!double.TryParse(parts[0].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out xMm)) return false;
        if (!double.TryParse(parts[1].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out yMm)) return false;
        if (!double.TryParse(parts[2].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out zMm)) return false;
        point = new Autodesk.Revit.DB.XYZ(FromMm(xMm), FromMm(yMm), FromMm(zMm));
        return true;
    }

    bool commit = GetBoolOption("commit", false);
    bool clearExistingPlaced = GetBoolOption("clear_existing_placed", false);
    string routePrefix = GetOption("route_prefix", "SZ_PREVIEW_ROUTE");
    int maxSegments = GetIntOption("max_segments", 0);
    double defaultWidthMm = System.Math.Max(25.0, GetDoubleOption("width_mm", 450.0));
    double defaultHeightMm = System.Math.Max(25.0, GetDoubleOption("height_mm", 120.0));
    double trunkWidthMm = System.Math.Max(25.0, GetDoubleOption("trunk_width_mm", defaultWidthMm));
    double trunkHeightMm = System.Math.Max(25.0, GetDoubleOption("trunk_height_mm", defaultHeightMm));
    double branchWidthMm = System.Math.Max(25.0, GetDoubleOption("branch_width_mm", defaultWidthMm));
    double branchHeightMm = System.Math.Max(25.0, GetDoubleOption("branch_height_mm", defaultHeightMm));
    double minSegmentLengthMm = System.Math.Max(10.0, GetDoubleOption("min_segment_length_mm", 100.0));
    string commentsMarker = "DPE_DUCT_NETWORK_COMMIT";

    if (commit)
    {
        warnings.Add("This first commit pattern creates independent duct segments from route preview boxes; fitting and connector solving are intentionally not performed here.");
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

    Autodesk.Revit.DB.ElementId ductTypeId = Autodesk.Revit.DB.ElementId.InvalidElementId;
    string ductTypeName = string.Empty;
    string ductTypeIdOption = GetOption("duct_type_id", null);
    if (!string.IsNullOrWhiteSpace(ductTypeIdOption))
    {
        int parsedDuctTypeId;
        if (int.TryParse(ductTypeIdOption, out parsedDuctTypeId))
        {
            Autodesk.Revit.DB.ElementId candidateId = new Autodesk.Revit.DB.ElementId(parsedDuctTypeId);
            if (Autodesk.Revit.DB.Mechanical.Duct.IsDuctTypeId(document, candidateId))
            {
                ductTypeId = candidateId;
            }
        }
    }
    if (ductTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId)
    {
        string ductTypeNameOption = NormalizeText(GetOption("duct_type_name", null));
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.Mechanical.DuctType)))
        {
            Autodesk.Revit.DB.Mechanical.DuctType ductType = element as Autodesk.Revit.DB.Mechanical.DuctType;
            if (ductType == null) continue;
            if (!string.IsNullOrWhiteSpace(ductTypeNameOption) && !NormalizeText(ductType.Name).Contains(ductTypeNameOption)) continue;
            if (!Autodesk.Revit.DB.Mechanical.Duct.IsDuctTypeId(document, ductType.Id)) continue;
            ductTypeId = ductType.Id;
            break;
        }
    }
    Autodesk.Revit.DB.Mechanical.DuctType selectedDuctType = document.GetElement(ductTypeId) as Autodesk.Revit.DB.Mechanical.DuctType;
    if (selectedDuctType != null) ductTypeName = selectedDuctType.Name;

    Autodesk.Revit.DB.ElementId systemTypeId = Autodesk.Revit.DB.ElementId.InvalidElementId;
    string systemTypeName = string.Empty;
    string systemTypeIdOption = GetOption("system_type_id", null);
    if (!string.IsNullOrWhiteSpace(systemTypeIdOption))
    {
        int parsedSystemTypeId;
        if (int.TryParse(systemTypeIdOption, out parsedSystemTypeId))
        {
            Autodesk.Revit.DB.ElementId candidateId = new Autodesk.Revit.DB.ElementId(parsedSystemTypeId);
            if (Autodesk.Revit.DB.Mechanical.Duct.IsHvacSystemTypeId(document, candidateId))
            {
                systemTypeId = candidateId;
            }
        }
    }
    if (systemTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId)
    {
        string systemTypeNameOption = NormalizeText(GetOption("system_type_name", "Supply Air"));
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.Mechanical.MechanicalSystemType)))
        {
            Autodesk.Revit.DB.Mechanical.MechanicalSystemType systemType = element as Autodesk.Revit.DB.Mechanical.MechanicalSystemType;
            if (systemType == null) continue;
            string normalizedName = NormalizeText(systemType.Name);
            bool nameMatches = string.IsNullOrWhiteSpace(systemTypeNameOption) || normalizedName.Contains(systemTypeNameOption);
            bool supplyAir = systemType.SystemClassification == Autodesk.Revit.DB.MEPSystemClassification.SupplyAir;
            if (!nameMatches && !supplyAir) continue;
            if (!Autodesk.Revit.DB.Mechanical.Duct.IsHvacSystemTypeId(document, systemType.Id)) continue;
            systemTypeId = systemType.Id;
            break;
        }
    }
    Autodesk.Revit.DB.Mechanical.MechanicalSystemType selectedSystemType = document.GetElement(systemTypeId) as Autodesk.Revit.DB.Mechanical.MechanicalSystemType;
    if (selectedSystemType != null) systemTypeName = selectedSystemType.Name;

    System.Collections.Generic.List<object> segmentRows = new System.Collections.Generic.List<object>();
    foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.DirectShape)).WhereElementIsNotElementType())
    {
        Autodesk.Revit.DB.DirectShape directShape = element as Autodesk.Revit.DB.DirectShape;
        if (directShape == null) continue;
        string appId = string.Empty;
        string appDataId = string.Empty;
        string commentsValue = string.Empty;
        try { appId = directShape.ApplicationId; } catch { }
        try { appDataId = directShape.ApplicationDataId; } catch { }
        try
        {
            Autodesk.Revit.DB.Parameter comments = directShape.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
            if (comments != null) commentsValue = comments.AsString() ?? string.Empty;
        }
        catch
        {
        }
        if (appId != routePrefix && !appDataId.Contains(routePrefix) && !commentsValue.Contains(routePrefix)) continue;
        System.Collections.Generic.Dictionary<string, string> metadata = ParseMetadataTokens(appDataId + " | " + commentsValue);
        Autodesk.Revit.DB.XYZ start = null;
        Autodesk.Revit.DB.XYZ end = null;
        bool hasCenterlineMetadata = metadata.ContainsKey("start_mm") &&
            metadata.ContainsKey("end_mm") &&
            TryParsePointMm(metadata["start_mm"], out start) &&
            TryParsePointMm(metadata["end_mm"], out end);
        string sourceGeometry = hasCenterlineMetadata ? "centerline_metadata" : "bbox_fallback";
        double spanZ = 0.0;
        if (!hasCenterlineMetadata)
        {
            Autodesk.Revit.DB.BoundingBoxXYZ box = element.get_BoundingBox(null);
            if (box == null) continue;
            double spanX = System.Math.Abs(box.Max.X - box.Min.X);
            double spanY = System.Math.Abs(box.Max.Y - box.Min.Y);
            spanZ = System.Math.Abs(box.Max.Z - box.Min.Z);
            if (System.Math.Max(spanX, spanY) < FromMm(minSegmentLengthMm)) continue;
            bool xAxis = spanX >= spanY;
            double centerX = (box.Min.X + box.Max.X) / 2.0;
            double centerY = (box.Min.Y + box.Max.Y) / 2.0;
            double centerZ = (box.Min.Z + box.Max.Z) / 2.0;
            start = xAxis
                ? new Autodesk.Revit.DB.XYZ(box.Min.X, centerY, centerZ)
                : new Autodesk.Revit.DB.XYZ(centerX, box.Min.Y, centerZ);
            end = xAxis
                ? new Autodesk.Revit.DB.XYZ(box.Max.X, centerY, centerZ)
                : new Autodesk.Revit.DB.XYZ(centerX, box.Max.Y, centerZ);
        }
        if (start == null || end == null) continue;
        double lengthFeet = start.DistanceTo(end);
        if (lengthFeet < FromMm(minSegmentLengthMm)) continue;
        int segmentIndex = metadata.ContainsKey("segment_id") ? ParseRouteSegmentIndex(metadata["segment_id"]) : ParseRouteSegmentIndex(appDataId);
        string segmentType = metadata.ContainsKey("segment_type") && !string.IsNullOrWhiteSpace(metadata["segment_type"])
            ? metadata["segment_type"]
            : (segmentIndex == 1 ? "trunk" : "branch");
        System.Collections.Generic.List<object> row = new System.Collections.Generic.List<object>();
        row.Add(segmentIndex == 0 ? 1000000 + segmentRows.Count : segmentIndex);
        row.Add(element.Id.IntegerValue);
        row.Add(segmentType);
        row.Add(start);
        row.Add(end);
        row.Add(lengthFeet);
        row.Add(spanZ);
        row.Add(appDataId);
        row.Add(sourceGeometry);
        segmentRows.Add(row);
    }

    segmentRows.Sort(delegate(object leftObj, object rightObj)
    {
        System.Collections.Generic.List<object> left = leftObj as System.Collections.Generic.List<object>;
        System.Collections.Generic.List<object> right = rightObj as System.Collections.Generic.List<object>;
        int leftIndex = left == null ? 0 : (int)left[0];
        int rightIndex = right == null ? 0 : (int)right[0];
        return leftIndex.CompareTo(rightIndex);
    });

    if (targetLevel == null) errors.Add("Target level could not be resolved. Provide levelName or levelId.");
    if (ductTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId) errors.Add("Duct type could not be resolved. Provide duct_type_id or duct_type_name.");
    if (systemTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId) errors.Add("HVAC system type could not be resolved. Provide system_type_id or system_type_name.");
    if (segmentRows.Count == 0) errors.Add("No route preview DirectShape segments found for prefix '" + routePrefix + "'.");

    int plannedCount = 0;
    int placedCount = 0;
    int existingPlacedDeleted = 0;
    System.Collections.Generic.List<object> committedSegments = new System.Collections.Generic.List<object>();

    if (commit && errors.Count == 0)
    {
        if (!document.IsModifiable)
        {
            transaction = new Autodesk.Revit.DB.Transaction(document, "Commit Duct Network");
            transaction.Start();
            startedOwnTransaction = true;
        }
        if (clearExistingPlaced)
        {
            System.Collections.Generic.List<Autodesk.Revit.DB.ElementId> deleteIds = new System.Collections.Generic.List<Autodesk.Revit.DB.ElementId>();
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document)
                .OfCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves)
                .WhereElementIsNotElementType())
            {
                string commentsValue = string.Empty;
                try
                {
                    Autodesk.Revit.DB.Parameter comments = element.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                    if (comments != null) commentsValue = comments.AsString() ?? string.Empty;
                }
                catch
                {
                }
                if (commentsValue.Contains(commentsMarker)) deleteIds.Add(element.Id);
            }
            if (deleteIds.Count > 0)
            {
                document.Delete(deleteIds);
                existingPlacedDeleted = deleteIds.Count;
            }
        }
    }

    int limit = maxSegments > 0 ? System.Math.Min(maxSegments, segmentRows.Count) : segmentRows.Count;
    for (int i = 0; i < limit && errors.Count == 0; i++)
    {
        System.Collections.Generic.List<object> row = segmentRows[i] as System.Collections.Generic.List<object>;
        if (row == null || row.Count < 9) continue;
        int segmentIndex = (int)row[0];
        int sourceRouteId = (int)row[1];
        string segmentType = row[2] as string;
        Autodesk.Revit.DB.XYZ start = row[3] as Autodesk.Revit.DB.XYZ;
        Autodesk.Revit.DB.XYZ end = row[4] as Autodesk.Revit.DB.XYZ;
        double lengthFeet = (double)row[5];
        string appDataId = row[7] as string;
        string sourceGeometry = row[8] as string;
        if (start == null || end == null) continue;

        plannedCount++;
        double widthMm = segmentType == "trunk" ? trunkWidthMm : branchWidthMm;
        double heightMm = segmentType == "trunk" ? trunkHeightMm : branchHeightMm;
        int placedElementId = 0;
        string status = commit ? "planned" : "dry_run";
        string error = string.Empty;

        if (commit)
        {
            try
            {
                Autodesk.Revit.DB.Mechanical.Duct duct = Autodesk.Revit.DB.Mechanical.Duct.Create(document, systemTypeId, ductTypeId, targetLevel.Id, start, end);
                if (duct == null)
                {
                    status = "fail";
                    error = "Duct.Create returned null.";
                }
                else
                {
                    Autodesk.Revit.DB.Parameter widthParam = duct.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
                    Autodesk.Revit.DB.Parameter heightParam = duct.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
                    if (widthParam != null && !widthParam.IsReadOnly) widthParam.Set(FromMm(widthMm));
                    if (heightParam != null && !heightParam.IsReadOnly) heightParam.Set(FromMm(heightMm));
                    Autodesk.Revit.DB.Parameter comments = duct.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                    if (comments != null && !comments.IsReadOnly)
                    {
                        comments.Set(commentsMarker + " | source_route=" + routePrefix + " | source_id=" + sourceRouteId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    }
                    placedElementId = duct.Id.IntegerValue;
                    placedCount++;
                    status = "placed";
                }
            }
            catch (System.Exception segmentEx)
            {
                status = "fail";
                error = segmentEx.GetType().Name + ": " + segmentEx.Message;
                warnings.Add("Could not place duct for route source id " + sourceRouteId.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + error);
            }
        }

        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["source_route_id"] = sourceRouteId;
        record["source_route_data"] = appDataId;
        record["source_geometry"] = sourceGeometry;
        record["segment_index"] = segmentIndex >= 1000000 ? null : (object)segmentIndex;
        record["segment_type"] = segmentType;
        record["status"] = status;
        record["placed_element_id"] = placedElementId == 0 ? null : (object)placedElementId;
        record["start_mm"] = PointMm(start);
        record["end_mm"] = PointMm(end);
        record["length_mm"] = Round3(ToMm(lengthFeet));
        record["width_mm"] = Round3(widthMm);
        record["height_mm"] = Round3(heightMm);
        if (!string.IsNullOrWhiteSpace(error)) record["error"] = error;
        committedSegments.Add(record);
    }

    if (commit && startedOwnTransaction && transaction != null)
    {
        transaction.Commit();
        transaction = null;
        startedOwnTransaction = false;
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["commit"] = commit;
    summary["route_prefix"] = routePrefix;
    summary["route_preview_count"] = segmentRows.Count;
    summary["planned_count"] = plannedCount;
    summary["placed_count"] = placedCount;
    summary["existing_placed_deleted"] = existingPlacedDeleted;
    summary["max_segments"] = maxSegments;
    summary["duct_type_id"] = ductTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId ? null : (object)ductTypeId.IntegerValue;
    summary["duct_type_name"] = ductTypeName;
    summary["system_type_id"] = systemTypeId == Autodesk.Revit.DB.ElementId.InvalidElementId ? null : (object)systemTypeId.IntegerValue;
    summary["system_type_name"] = systemTypeName;
    summary["target_level_name"] = targetLevel == null ? string.Empty : targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;
    summary["default_width_mm"] = Round3(defaultWidthMm);
    summary["default_height_mm"] = Round3(defaultHeightMm);
    summary["trunk_width_mm"] = Round3(trunkWidthMm);
    summary["trunk_height_mm"] = Round3(trunkHeightMm);
    summary["branch_width_mm"] = Round3(branchWidthMm);
    summary["branch_height_mm"] = Round3(branchHeightMm);

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "commit-duct-network.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["segments"] = committedSegments;
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
    return "{\"schema_version\":\"commit-duct-network.v1\",\"status\":\"fail\",\"summary\":{},\"segments\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
