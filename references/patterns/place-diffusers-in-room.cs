// Place diffusers from SZ_PREVIEW_DIFFUSER candidate markers.
// Default is dry-run: real FamilyInstance placement only happens with --commit=true.
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
    if (!options.ContainsKey("commit") && options.ContainsKey("write_commit")) options["commit"] = options["write_commit"];

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
    double levelToleranceMm = GetDoubleOption("level_elevation_tolerance_mm", 100.0);
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
    if (targetLevel == null)
    {
        errors.Add("No target level could be resolved.");
    }

    string previewPrefix = GetOption("preview_prefix", "SZ_PREVIEW_DIFFUSER");
    string placementMarker = GetOption("placement_marker", "DPE_DIFFUSER_PLACEMENT");
    bool commit = GetBoolOption("commit", false);
    bool clearExistingPlaced = GetBoolOption("clear_existing_placed", false);
    int maxToPlace = System.Math.Max(1, (int)System.Math.Round(GetDoubleOption("max_to_place", 200.0)));
    string familyName = GetOption("family_name", "M_Supply Diffuser - Rectangular Face Round Neck");
    string typeName = GetOption("type_name", "600x600 - 200 Neck");
    string typeIdOption = GetOption("type_id", null);
    string flowParameterName = GetOption("flow_parameter", "Flow");
    double flowLps = GetDoubleOption("flow_lps", double.NaN);
    double flowM3h = GetDoubleOption("flow_m3h", double.NaN);
    if ((double.IsNaN(flowLps) || flowLps <= 0.0) && !double.IsNaN(flowM3h) && flowM3h > 0.0)
    {
        flowLps = flowM3h / 3.6;
    }

    Autodesk.Revit.DB.FamilySymbol selectedSymbol = null;
    if (!string.IsNullOrWhiteSpace(typeIdOption))
    {
        int typeId;
        if (int.TryParse(typeIdOption, out typeId))
        {
            selectedSymbol = document.GetElement(new Autodesk.Revit.DB.ElementId(typeId)) as Autodesk.Revit.DB.FamilySymbol;
        }
    }
    if (selectedSymbol == null)
    {
        foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal).WhereElementIsElementType())
        {
            Autodesk.Revit.DB.FamilySymbol symbol = element as Autodesk.Revit.DB.FamilySymbol;
            if (symbol == null) continue;
            if (NormalizeText(symbol.FamilyName) == NormalizeText(familyName) && NormalizeText(symbol.Name) == NormalizeText(typeName))
            {
                selectedSymbol = symbol;
                break;
            }
        }
    }
    if (selectedSymbol == null)
    {
        errors.Add("No Air Terminal family symbol matched family_name/type_name/type_id.");
    }

    System.Collections.Generic.List<object[]> markerRecords = new System.Collections.Generic.List<object[]>();
    foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.DirectShape)).WhereElementIsNotElementType())
    {
        Autodesk.Revit.DB.DirectShape directShape = element as Autodesk.Revit.DB.DirectShape;
        if (directShape == null) continue;
        string appId = string.Empty;
        string appDataId = string.Empty;
        try { appId = directShape.ApplicationId; } catch { }
        try { appDataId = directShape.ApplicationDataId; } catch { }
        string text = (appId ?? string.Empty) + " " + (appDataId ?? string.Empty);
        if (!text.Contains(previewPrefix)) continue;
        Autodesk.Revit.DB.BoundingBoxXYZ box = directShape.get_BoundingBox(null);
        if (box == null) continue;
        Autodesk.Revit.DB.XYZ point = new Autodesk.Revit.DB.XYZ(
            (box.Min.X + box.Max.X) / 2.0,
            (box.Min.Y + box.Max.Y) / 2.0,
            (box.Min.Z + box.Max.Z) / 2.0);
        markerRecords.Add(new object[] { directShape.Id.IntegerValue, point });
    }
    markerRecords.Sort(delegate(object[] left, object[] right)
    {
        return ((int)left[0]).CompareTo((int)right[0]);
    });

    if (markerRecords.Count == 0)
    {
        warnings.Add("No diffuser candidate markers were found for preview_prefix=" + previewPrefix + ".");
    }
    if (markerRecords.Count > maxToPlace)
    {
        warnings.Add("Candidate markers were limited by max_to_place.");
    }

    System.Collections.Generic.List<object> placementRecords = new System.Collections.Generic.List<object>();
    int existingPlacedDeleted = 0;
    int placedCount = 0;
    int flowSetCount = 0;
    int flowSkippedCount = 0;

    if (commit && errors.Count == 0)
    {
        if (!document.IsModifiable)
        {
            transaction = new Autodesk.Revit.DB.Transaction(document, "Place Diffusers From Candidates");
            transaction.Start();
            startedOwnTransaction = true;
        }

        if (clearExistingPlaced)
        {
            System.Collections.Generic.List<Autodesk.Revit.DB.ElementId> deleteIds = new System.Collections.Generic.List<Autodesk.Revit.DB.ElementId>();
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfCategory(Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal).WhereElementIsNotElementType())
            {
                Autodesk.Revit.DB.Parameter comments = element.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                string commentText = comments == null ? string.Empty : (comments.AsString() ?? string.Empty);
                if (commentText.Contains(placementMarker)) deleteIds.Add(element.Id);
            }
            if (deleteIds.Count > 0)
            {
                existingPlacedDeleted = deleteIds.Count;
                document.Delete(deleteIds);
            }
        }

        if (selectedSymbol != null && !selectedSymbol.IsActive)
        {
            selectedSymbol.Activate();
            document.Regenerate();
        }
    }

    int limit = System.Math.Min(maxToPlace, markerRecords.Count);
    for (int i = 0; i < limit; i++)
    {
        int markerId = (int)markerRecords[i][0];
        Autodesk.Revit.DB.XYZ point = markerRecords[i][1] as Autodesk.Revit.DB.XYZ;
        int placedElementId = 0;
        string status = commit ? "planned" : "dry_run";
        string flowStatus = (!double.IsNaN(flowLps) && flowLps > 0.0) ? "planned" : "not_requested";

        if (commit && errors.Count == 0 && selectedSymbol != null && targetLevel != null)
        {
            Autodesk.Revit.DB.FamilyInstance instance = document.Create.NewFamilyInstance(
                point,
                selectedSymbol,
                targetLevel,
                Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
            placedElementId = instance.Id.IntegerValue;
            placedCount++;
            status = "placed";

            try
            {
                Autodesk.Revit.DB.Parameter comments = instance.get_Parameter(Autodesk.Revit.DB.BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                if (comments != null && !comments.IsReadOnly) comments.Set(placementMarker + " | source_marker=" + markerId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            catch
            {
            }

            if (!double.IsNaN(flowLps) && flowLps > 0.0)
            {
                Autodesk.Revit.DB.Parameter flowParameter = instance.LookupParameter(flowParameterName);
                if (flowParameter != null && !flowParameter.IsReadOnly && flowParameter.StorageType == Autodesk.Revit.DB.StorageType.Double)
                {
                    double internalFlow = Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(flowLps, Autodesk.Revit.DB.UnitTypeId.LitersPerSecond);
                    flowParameter.Set(internalFlow);
                    flowSetCount++;
                    flowStatus = "set";
                }
                else
                {
                    flowSkippedCount++;
                    flowStatus = "unavailable_or_readonly";
                }
            }
        }

        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["source_marker_id"] = markerId;
        record["planned_point_mm"] = PointMm(point);
        record["family_symbol_id"] = selectedSymbol == null ? null : (object)selectedSymbol.Id.IntegerValue;
        record["family_name"] = selectedSymbol == null ? familyName : selectedSymbol.FamilyName;
        record["type_name"] = selectedSymbol == null ? typeName : selectedSymbol.Name;
        record["target_level_name"] = targetLevel == null ? string.Empty : targetLevel.Name;
        record["placed_element_id"] = placedElementId == 0 ? null : (object)placedElementId;
        record["flow_lps"] = (!double.IsNaN(flowLps) && flowLps > 0.0) ? (object)Round3(flowLps) : null;
        record["flow_parameter"] = flowParameterName;
        record["flow_status"] = flowStatus;
        record["status"] = status;
        placementRecords.Add(record);
    }

    if (startedOwnTransaction && transaction != null)
    {
        transaction.Commit();
        transaction = null;
        startedOwnTransaction = false;
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["commit"] = commit;
    summary["preview_prefix"] = previewPrefix;
    summary["candidate_marker_count"] = markerRecords.Count;
    summary["planned_count"] = placementRecords.Count;
    summary["placed_count"] = placedCount;
    summary["existing_placed_deleted"] = existingPlacedDeleted;
    summary["max_to_place"] = maxToPlace;
    summary["family_symbol_id"] = selectedSymbol == null ? null : (object)selectedSymbol.Id.IntegerValue;
    summary["family_name"] = selectedSymbol == null ? familyName : selectedSymbol.FamilyName;
    summary["type_name"] = selectedSymbol == null ? typeName : selectedSymbol.Name;
    summary["target_level_name"] = targetLevel == null ? string.Empty : targetLevel.Name;
    summary["target_level_resolution"] = targetLevelSource;
    summary["flow_parameter"] = flowParameterName;
    summary["flow_lps"] = (!double.IsNaN(flowLps) && flowLps > 0.0) ? (object)Round3(flowLps) : null;
    summary["flow_set_count"] = flowSetCount;
    summary["flow_skipped_count"] = flowSkippedCount;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "place-diffusers-in-room.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["placements"] = placementRecords;
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
    return "{\"schema_version\":\"place-diffusers-in-room.v1\",\"status\":\"fail\",\"summary\":{},\"placements\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
