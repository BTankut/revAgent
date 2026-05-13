// Spatial zone extraction pattern for early MEP routing context.
// Read-only: collects target-level rooms/spaces, ceiling/plenum envelope,
// shaft candidates, and host-coordinate obstacle AABBs from host and links.
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
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        bool parsed;
        if (bool.TryParse(value, out parsed))
        {
            return parsed;
        }

        string normalized = value.Trim().ToLowerInvariant();
        if (normalized == "1" || normalized == "yes" || normalized == "y" || normalized == "evet")
        {
            return true;
        }
        if (normalized == "0" || normalized == "no" || normalized == "n" || normalized == "hayir")
        {
            return false;
        }

        return fallback;
    }

    double GetDoubleOption(string key, double fallback)
    {
        string value = GetOption(key, null);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        double parsed;
        if (double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out parsed))
        {
            return parsed;
        }

        if (double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.CurrentCulture, out parsed))
        {
            return parsed;
        }

        warnings.Add("Could not parse numeric option '" + key + "' value '" + value + "'. Using fallback " + fallback.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
        return fallback;
    }

    System.Collections.Generic.List<string> SplitListOption(string key)
    {
        System.Collections.Generic.List<string> values = new System.Collections.Generic.List<string>();
        string value = GetOption(key, null);
        if (string.IsNullOrWhiteSpace(value))
        {
            return values;
        }

        string[] parts = value.Split(new char[] { '|', ',', ';' }, System.StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i < parts.Length; i++)
        {
            string item = parts[i].Trim();
            if (item.Length > 0)
            {
                values.Add(item);
            }
        }
        return values;
    }

    string NormalizeText(string value)
    {
        if (value == null)
        {
            return string.Empty;
        }
        return value.Trim().ToLowerInvariant();
    }

    bool ContainsAnyToken(string value, System.Collections.Generic.List<string> tokens)
    {
        string normalized = NormalizeText(value);
        if (normalized.Length == 0)
        {
            return false;
        }

        for (int i = 0; i < tokens.Count; i++)
        {
            string token = NormalizeText(tokens[i]);
            if (token.Length > 0 && normalized.Contains(token))
            {
                return true;
            }
        }
        return false;
    }

    bool ContainsAnyTokenFromArray(string value, string[] tokens)
    {
        string normalized = NormalizeText(value);
        if (normalized.Length == 0)
        {
            return false;
        }

        for (int i = 0; i < tokens.Length; i++)
        {
            string token = NormalizeText(tokens[i]);
            if (token.Length > 0 && normalized.Contains(token))
            {
                return true;
            }
        }
        return false;
    }

    string SafeElementName(Autodesk.Revit.DB.Element element)
    {
        if (element == null)
        {
            return string.Empty;
        }
        try
        {
            string name = element.Name;
            return name == null ? string.Empty : name;
        }
        catch
        {
            return string.Empty;
        }
    }

    string CategoryName(Autodesk.Revit.DB.Element element)
    {
        if (element == null || element.Category == null)
        {
            return string.Empty;
        }
        try
        {
            return element.Category.Name;
        }
        catch
        {
            return string.Empty;
        }
    }

    string ParameterText(Autodesk.Revit.DB.Element element, string parameterName)
    {
        if (element == null)
        {
            return string.Empty;
        }

        try
        {
            Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(parameterName);
            if (parameter == null)
            {
                return string.Empty;
            }

            string value = parameter.AsString();
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }

            value = parameter.AsValueString();
            return value == null ? string.Empty : value;
        }
        catch
        {
            return string.Empty;
        }
    }

    double ToMm(double internalFeet)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(internalFeet, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double FromMm(double millimeters)
    {
        return Autodesk.Revit.DB.UnitUtils.ConvertToInternalUnits(millimeters, Autodesk.Revit.DB.UnitTypeId.Millimeters);
    }

    double Round3(double value)
    {
        return System.Math.Round(value, 3);
    }

    System.Collections.Generic.List<object> PointMm(Autodesk.Revit.DB.XYZ point)
    {
        System.Collections.Generic.List<object> result = new System.Collections.Generic.List<object>();
        result.Add(Round3(ToMm(point.X)));
        result.Add(Round3(ToMm(point.Y)));
        result.Add(Round3(ToMm(point.Z)));
        return result;
    }

    System.Collections.Generic.List<object> Point2dMm(Autodesk.Revit.DB.XYZ point)
    {
        System.Collections.Generic.List<object> result = new System.Collections.Generic.List<object>();
        result.Add(Round3(ToMm(point.X)));
        result.Add(Round3(ToMm(point.Y)));
        return result;
    }

    System.Collections.Generic.Dictionary<string, object> TransformRecord(Autodesk.Revit.DB.Transform transform)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        if (transform == null)
        {
            transform = Autodesk.Revit.DB.Transform.Identity;
        }

        record["origin_mm"] = PointMm(transform.Origin);

        System.Collections.Generic.List<object> basisX = new System.Collections.Generic.List<object>();
        basisX.Add(Round3(transform.BasisX.X));
        basisX.Add(Round3(transform.BasisX.Y));
        basisX.Add(Round3(transform.BasisX.Z));
        record["basis_x"] = basisX;

        System.Collections.Generic.List<object> basisY = new System.Collections.Generic.List<object>();
        basisY.Add(Round3(transform.BasisY.X));
        basisY.Add(Round3(transform.BasisY.Y));
        basisY.Add(Round3(transform.BasisY.Z));
        record["basis_y"] = basisY;

        System.Collections.Generic.List<object> basisZ = new System.Collections.Generic.List<object>();
        basisZ.Add(Round3(transform.BasisZ.X));
        basisZ.Add(Round3(transform.BasisZ.Y));
        basisZ.Add(Round3(transform.BasisZ.Z));
        record["basis_z"] = basisZ;

        return record;
    }

    string ElementKey(string sourceName, Autodesk.Revit.DB.Element element)
    {
        string prefix = string.IsNullOrWhiteSpace(sourceName) ? "Host" : sourceName;
        if (element == null)
        {
            return prefix + ":unknown";
        }
        return prefix + ":" + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    string SafeUniqueId(Autodesk.Revit.DB.Element element)
    {
        if (element == null)
        {
            return string.Empty;
        }

        try
        {
            return element.UniqueId;
        }
        catch
        {
            return string.Empty;
        }
    }

    void AddIdentityFields(System.Collections.Generic.Dictionary<string, object> record, Autodesk.Revit.DB.Element element, Autodesk.Revit.DB.Document sourceDocument, string sourceType, int linkInstanceId)
    {
        record["element_id"] = element == null ? 0 : element.Id.IntegerValue;
        record["unique_id"] = SafeUniqueId(element);
        record["source_document_title"] = sourceDocument == null ? string.Empty : sourceDocument.Title;
        record["source_type"] = sourceType;
        record["link_instance_id"] = linkInstanceId > 0 ? (object)linkInstanceId : null;
    }

    string JsonEscape(string value)
    {
        if (value == null)
        {
            return string.Empty;
        }

        System.Text.StringBuilder escaped = new System.Text.StringBuilder();
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch == '\\')
            {
                escaped.Append("\\\\");
            }
            else if (ch == '"')
            {
                escaped.Append("\\\"");
            }
            else if (ch == '\b')
            {
                escaped.Append("\\b");
            }
            else if (ch == '\f')
            {
                escaped.Append("\\f");
            }
            else if (ch == '\n')
            {
                escaped.Append("\\n");
            }
            else if (ch == '\r')
            {
                escaped.Append("\\r");
            }
            else if (ch == '\t')
            {
                escaped.Append("\\t");
            }
            else if (ch < 32)
            {
                escaped.Append("\\u");
                escaped.Append(((int)ch).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
            }
            else
            {
                escaped.Append(ch);
            }
        }
        return escaped.ToString();
    }

    string SerializeJson(object value)
    {
        if (value == null)
        {
            return "null";
        }

        string stringValue = value as string;
        if (stringValue != null)
        {
            return "\"" + JsonEscape(stringValue) + "\"";
        }

        if (value is bool)
        {
            return ((bool)value) ? "true" : "false";
        }

        if (value is double)
        {
            double number = (double)value;
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                return "null";
            }
            return number.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        if (value is float)
        {
            float number = (float)value;
            if (float.IsNaN(number) || float.IsInfinity(number))
            {
                return "null";
            }
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
                if (!first)
                {
                    objectBuilder.Append(",");
                }
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
                if (!first)
                {
                    arrayBuilder.Append(",");
                }
                first = false;
                arrayBuilder.Append(SerializeJson(item));
            }
            arrayBuilder.Append("]");
            return arrayBuilder.ToString();
        }

        return "\"" + JsonEscape(value.ToString()) + "\"";
    }

    System.Collections.Generic.List<string> SplitTopLevelJson(string text, char separator)
    {
        System.Collections.Generic.List<string> parts = new System.Collections.Generic.List<string>();
        if (text == null)
        {
            return parts;
        }

        int depth = 0;
        bool inString = false;
        bool escaped = false;
        int start = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (ch == '\\')
            {
                escaped = true;
                continue;
            }
            if (ch == '"')
            {
                inString = !inString;
                continue;
            }
            if (inString)
            {
                continue;
            }
            if (ch == '{' || ch == '[')
            {
                depth++;
            }
            else if (ch == '}' || ch == ']')
            {
                depth--;
            }
            else if (ch == separator && depth == 0)
            {
                parts.Add(text.Substring(start, i - start));
                start = i + 1;
            }
        }
        parts.Add(text.Substring(start));
        return parts;
    }

    int IndexOfTopLevelJsonColon(string text)
    {
        int depth = 0;
        bool inString = false;
        bool escaped = false;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (ch == '\\')
            {
                escaped = true;
                continue;
            }
            if (ch == '"')
            {
                inString = !inString;
                continue;
            }
            if (inString)
            {
                continue;
            }
            if (ch == '{' || ch == '[')
            {
                depth++;
            }
            else if (ch == '}' || ch == ']')
            {
                depth--;
            }
            else if (ch == ':' && depth == 0)
            {
                return i;
            }
        }
        return -1;
    }

    string UnquoteJsonScalar(string rawValue)
    {
        if (rawValue == null)
        {
            return string.Empty;
        }

        string text = rawValue.Trim();
        if (text.Equals("null", System.StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        if (text.Length >= 2 && text[0] == '"' && text[text.Length - 1] == '"')
        {
            text = text.Substring(1, text.Length - 2);
            System.Text.StringBuilder unescaped = new System.Text.StringBuilder();
            bool escaped = false;
            for (int i = 0; i < text.Length; i++)
            {
                char ch = text[i];
                if (!escaped)
                {
                    if (ch == '\\')
                    {
                        escaped = true;
                    }
                    else
                    {
                        unescaped.Append(ch);
                    }
                    continue;
                }

                if (ch == 'n') unescaped.Append('\n');
                else if (ch == 'r') unescaped.Append('\r');
                else if (ch == 't') unescaped.Append('\t');
                else if (ch == 'b') unescaped.Append('\b');
                else if (ch == 'f') unescaped.Append('\f');
                else if (ch == 'u' && i + 4 < text.Length)
                {
                    string hex = text.Substring(i + 1, 4);
                    int code;
                    if (int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out code))
                    {
                        unescaped.Append((char)code);
                        i += 4;
                    }
                }
                else
                {
                    unescaped.Append(ch);
                }
                escaped = false;
            }
            return unescaped.ToString();
        }

        return text;
    }

    void StoreFlatJsonOption(string key, string rawValue)
    {
        if (string.IsNullOrWhiteSpace(key) || rawValue == null)
        {
            return;
        }

        string value = rawValue.Trim();
        if (value.StartsWith("[") && value.EndsWith("]"))
        {
            string inner = value.Substring(1, value.Length - 2);
            System.Collections.Generic.List<string> items = new System.Collections.Generic.List<string>();
            System.Collections.Generic.List<string> rawItems = SplitTopLevelJson(inner, ',');
            for (int i = 0; i < rawItems.Count; i++)
            {
                string item = UnquoteJsonScalar(rawItems[i]);
                if (!string.IsNullOrWhiteSpace(item))
                {
                    items.Add(item.Trim());
                }
            }
            options[key] = string.Join("|", items.ToArray());
            return;
        }

        options[key] = UnquoteJsonScalar(value);
    }

    void ParseFlatJsonOptions(string rawJson)
    {
        string text = rawJson.Trim();
        if (!text.StartsWith("{") || !text.EndsWith("}"))
        {
            throw new System.ArgumentException("Expected a JSON object.");
        }

        string inner = text.Substring(1, text.Length - 2);
        System.Collections.Generic.List<string> pairs = SplitTopLevelJson(inner, ',');
        for (int i = 0; i < pairs.Count; i++)
        {
            string pair = pairs[i];
            if (string.IsNullOrWhiteSpace(pair))
            {
                continue;
            }

            int colonIndex = IndexOfTopLevelJsonColon(pair);
            if (colonIndex <= 0)
            {
                continue;
            }

            string key = UnquoteJsonScalar(pair.Substring(0, colonIndex));
            string value = pair.Substring(colonIndex + 1);
            StoreFlatJsonOption(key, value);
        }
    }

    if (parameters != null)
    {
        for (int i = 0; i < parameters.Length; i++)
        {
            object parameter = parameters[i];
            if (parameter == null)
            {
                continue;
            }

            string raw = parameter.ToString();
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }

            raw = raw.Trim();
            if (raw.StartsWith("{"))
            {
                try
                {
                    ParseFlatJsonOptions(raw);
                }
                catch (System.Exception parseEx)
                {
                    warnings.Add("Could not parse JSON parameter block: " + parseEx.Message);
                }
                continue;
            }

            string cleaned = raw;
            if (cleaned.StartsWith("--"))
            {
                cleaned = cleaned.Substring(2);
            }

            int equalsIndex = cleaned.IndexOf('=');
            if (equalsIndex > 0)
            {
                string key = cleaned.Substring(0, equalsIndex).Trim();
                string value = cleaned.Substring(equalsIndex + 1).Trim();
                if (key.Length > 0)
                {
                    options[key] = value;
                }
            }
        }
    }

    if (!options.ContainsKey("levelName") && options.ContainsKey("target_level"))
    {
        options["levelName"] = options["target_level"];
    }
    if (!options.ContainsKey("levelId") && options.ContainsKey("target_level_id"))
    {
        options["levelId"] = options["target_level_id"];
    }

    double defaultCeilingHeightMm = GetDoubleOption("default_ceiling_height_mm", 2700.0);
    double defaultPlenumHeightMm = GetDoubleOption("default_plenum_height_mm", 600.0);
    double levelToleranceMm = GetDoubleOption("level_elevation_tolerance_mm", 100.0);
    bool includeExistingMep = GetBoolOption("include_existing_mep", false);
    bool useActiveViewLevel = GetBoolOption("activeViewLevel", true);
    System.Collections.Generic.List<string> preferredRoomNames = SplitListOption("preferred_room_names");
    System.Collections.Generic.List<string> forbiddenRoomNames = SplitListOption("forbidden_room_names");
    System.Collections.Generic.List<string> shaftIds = SplitListOption("shaft_ids");
    System.Collections.Generic.List<string> architecturalLinkNames = SplitListOption("architectural_link_names");
    System.Collections.Generic.List<string> structuralLinkNames = SplitListOption("structural_link_names");

    System.Collections.Generic.HashSet<string> explicitShaftIds =
        new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
    for (int i = 0; i < shaftIds.Count; i++)
    {
        if (!string.IsNullOrWhiteSpace(shaftIds[i]))
        {
            explicitShaftIds.Add(shaftIds[i].Trim());
        }
    }

    Autodesk.Revit.DB.Level targetLevel = null;
    string targetLevelSource = "unresolved";
    string levelIdOption = GetOption("levelId", null);
    if (!string.IsNullOrWhiteSpace(levelIdOption))
    {
        int levelIdValue;
        if (int.TryParse(levelIdOption, out levelIdValue))
        {
            targetLevel = document.GetElement(new Autodesk.Revit.DB.ElementId(levelIdValue)) as Autodesk.Revit.DB.Level;
            if (targetLevel != null)
            {
                targetLevelSource = "levelId";
            }
        }
    }

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
        if (level != null)
        {
            hostLevels.Add(level);
        }
    }

    hostLevels.Sort(delegate(Autodesk.Revit.DB.Level left, Autodesk.Revit.DB.Level right)
    {
        return left.Elevation.CompareTo(right.Elevation);
    });

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

    if (targetLevel == null && !string.IsNullOrWhiteSpace(levelElevationOption) && hostLevels.Count > 0)
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
                }
            }
        }
        else
        {
            warnings.Add("Could not parse target_level_elevation_mm value '" + levelElevationOption + "'.");
        }
    }

    if (targetLevel == null && useActiveViewLevel && !hasAnyExplicitLevelSelector)
    {
        try
        {
            targetLevel = document.ActiveView.GenLevel;
            if (targetLevel != null)
            {
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
        warnings.Add("No target level was supplied or resolved from the active view. Using first host level by elevation.");
    }

    if (targetLevel == null)
    {
        errors.Add("No Revit level could be resolved in the host model.");
        System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
        failed["schema_version"] = "spatial-zone-extract.v1";
        failed["source"] = new System.Collections.Generic.Dictionary<string, object>();
        failed["ceiling_zones"] = new System.Collections.Generic.List<object>();
        failed["rooms"] = new System.Collections.Generic.List<object>();
        failed["shafts"] = new System.Collections.Generic.List<object>();
        failed["obstacles"] = new System.Collections.Generic.List<object>();
        failed["preferred_zones"] = new System.Collections.Generic.List<object>();
        failed["forbidden_zones"] = new System.Collections.Generic.List<object>();
        failed["warnings"] = warnings;
        failed["errors"] = errors;
        return SerializeJson(failed);
    }

    double targetElevation = targetLevel.Elevation;
    double levelTolerance = FromMm(levelToleranceMm);
    double defaultCeilingHeight = FromMm(defaultCeilingHeightMm);
    double defaultPlenumHeight = FromMm(defaultPlenumHeightMm);

    bool LevelMatchesTarget(Autodesk.Revit.DB.Level sourceLevel, Autodesk.Revit.DB.Transform transform)
    {
        if (sourceLevel == null)
        {
            return false;
        }

        if (transform == null)
        {
            transform = Autodesk.Revit.DB.Transform.Identity;
        }

        try
        {
            Autodesk.Revit.DB.XYZ sourcePoint = new Autodesk.Revit.DB.XYZ(0.0, 0.0, sourceLevel.Elevation);
            double hostElevation = transform.OfPoint(sourcePoint).Z;
            if (System.Math.Abs(hostElevation - targetElevation) <= levelTolerance)
            {
                return true;
            }
        }
        catch
        {
        }

        return NormalizeText(sourceLevel.Name) == NormalizeText(targetLevel.Name);
    }

    Autodesk.Revit.DB.Level ElementLevel(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Element element)
    {
        if (element == null)
        {
            return null;
        }

        try
        {
            Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
            if (spatial != null)
            {
                return spatial.Level;
            }
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
        if (box == null)
        {
            return null;
        }
        if (sourceToHost == null)
        {
            sourceToHost = Autodesk.Revit.DB.Transform.Identity;
        }

        Autodesk.Revit.DB.Transform totalTransform = sourceToHost;
        try
        {
            if (box.Transform != null)
            {
                totalTransform = sourceToHost.Multiply(box.Transform);
            }
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

        if (double.IsInfinity(minX) || double.IsInfinity(maxX))
        {
            return null;
        }

        return new double[] { minX, minY, minZ, maxX, maxY, maxZ };
    }

    System.Collections.Generic.Dictionary<string, object> AabbRecord(double[] aabbFeet)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        System.Collections.Generic.List<object> min = new System.Collections.Generic.List<object>();
        System.Collections.Generic.List<object> max = new System.Collections.Generic.List<object>();
        min.Add(Round3(ToMm(aabbFeet[0])));
        min.Add(Round3(ToMm(aabbFeet[1])));
        min.Add(Round3(ToMm(aabbFeet[2])));
        max.Add(Round3(ToMm(aabbFeet[3])));
        max.Add(Round3(ToMm(aabbFeet[4])));
        max.Add(Round3(ToMm(aabbFeet[5])));
        record["min_mm"] = min;
        record["max_mm"] = max;
        record["min"] = min;
        record["max"] = max;
        return record;
    }

    System.Collections.Generic.Dictionary<string, object> BboxBoundaryRecord(double[] aabbFeet)
    {
        System.Collections.Generic.Dictionary<string, object> boundary = new System.Collections.Generic.Dictionary<string, object>();
        boundary["type"] = "bbox";
        System.Collections.Generic.List<object> points = new System.Collections.Generic.List<object>();
        double z = aabbFeet[2];

        Autodesk.Revit.DB.XYZ p1 = new Autodesk.Revit.DB.XYZ(aabbFeet[0], aabbFeet[1], z);
        Autodesk.Revit.DB.XYZ p2 = new Autodesk.Revit.DB.XYZ(aabbFeet[3], aabbFeet[1], z);
        Autodesk.Revit.DB.XYZ p3 = new Autodesk.Revit.DB.XYZ(aabbFeet[3], aabbFeet[4], z);
        Autodesk.Revit.DB.XYZ p4 = new Autodesk.Revit.DB.XYZ(aabbFeet[0], aabbFeet[4], z);
        points.Add(Point2dMm(p1));
        points.Add(Point2dMm(p2));
        points.Add(Point2dMm(p3));
        points.Add(Point2dMm(p4));
        points.Add(Point2dMm(p1));
        boundary["points_mm"] = points;
        return boundary;
    }

    System.Collections.Generic.Dictionary<string, object> SpatialBoundaryRecord(Autodesk.Revit.DB.SpatialElement spatial, Autodesk.Revit.DB.Transform sourceToHost)
    {
        System.Collections.Generic.Dictionary<string, object> boundary = new System.Collections.Generic.Dictionary<string, object>();
        try
        {
            Autodesk.Revit.DB.SpatialElementBoundaryOptions boundaryOptions = new Autodesk.Revit.DB.SpatialElementBoundaryOptions();
            System.Collections.Generic.IList<System.Collections.Generic.IList<Autodesk.Revit.DB.BoundarySegment>> loops = spatial.GetBoundarySegments(boundaryOptions);
            if (loops != null && loops.Count > 0)
            {
                System.Collections.Generic.IList<Autodesk.Revit.DB.BoundarySegment> selectedLoop = null;
                int selectedCount = 0;
                for (int i = 0; i < loops.Count; i++)
                {
                    if (loops[i] != null && loops[i].Count > selectedCount)
                    {
                        selectedLoop = loops[i];
                        selectedCount = loops[i].Count;
                    }
                }

                if (selectedLoop != null && selectedLoop.Count > 0)
                {
                    System.Collections.Generic.List<object> points = new System.Collections.Generic.List<object>();
                    Autodesk.Revit.DB.XYZ firstPoint = null;
                    Autodesk.Revit.DB.XYZ lastPoint = null;
                    for (int i = 0; i < selectedLoop.Count; i++)
                    {
                        Autodesk.Revit.DB.Curve curve = selectedLoop[i].GetCurve();
                        if (curve == null)
                        {
                            continue;
                        }

                        Autodesk.Revit.DB.XYZ start = sourceToHost.OfPoint(curve.GetEndPoint(0));
                        Autodesk.Revit.DB.XYZ end = sourceToHost.OfPoint(curve.GetEndPoint(1));
                        if (firstPoint == null)
                        {
                            firstPoint = start;
                        }
                        lastPoint = end;
                        points.Add(Point2dMm(start));
                    }

                    if (lastPoint != null)
                    {
                        points.Add(Point2dMm(lastPoint));
                    }
                    else if (firstPoint != null)
                    {
                        points.Add(Point2dMm(firstPoint));
                    }

                    if (points.Count >= 3)
                    {
                        boundary["type"] = "polygon";
                        boundary["points_mm"] = points;
                        return boundary;
                    }
                }
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Boundary extraction failed for spatial element " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message);
        }

        try
        {
            Autodesk.Revit.DB.BoundingBoxXYZ box = spatial.get_BoundingBox(null);
            double[] aabb = ComputeAabbFeet(box, sourceToHost);
            if (aabb != null)
            {
                warnings.Add("Boundary loops unavailable for spatial element " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ". Using bounding box fallback.");
                return BboxBoundaryRecord(aabb);
            }
        }
        catch
        {
        }

        warnings.Add("Boundary unavailable for spatial element " + spatial.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
        boundary["type"] = "unknown";
        boundary["points_mm"] = new System.Collections.Generic.List<object>();
        return boundary;
    }

    Autodesk.Revit.DB.XYZ CentroidForElement(Autodesk.Revit.DB.Element element, Autodesk.Revit.DB.Transform sourceToHost)
    {
        try
        {
            Autodesk.Revit.DB.LocationPoint locationPoint = element.Location as Autodesk.Revit.DB.LocationPoint;
            if (locationPoint != null)
            {
                return sourceToHost.OfPoint(locationPoint.Point);
            }
        }
        catch
        {
        }

        try
        {
            Autodesk.Revit.DB.BoundingBoxXYZ box = element.get_BoundingBox(null);
            double[] aabb = ComputeAabbFeet(box, sourceToHost);
            if (aabb != null)
            {
                return new Autodesk.Revit.DB.XYZ((aabb[0] + aabb[3]) / 2.0, (aabb[1] + aabb[4]) / 2.0, (aabb[2] + aabb[5]) / 2.0);
            }
        }
        catch
        {
        }

        return new Autodesk.Revit.DB.XYZ(0.0, 0.0, targetElevation);
    }

    bool HasCategoryElements(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.BuiltInCategory category)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element ignored in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
            {
                return true;
            }
        }
        catch
        {
        }
        return false;
    }

    string ClassifyLink(Autodesk.Revit.DB.Document linkDocument, string instanceName, string documentTitle)
    {
        string combinedName = (instanceName + " " + documentTitle).Trim();
        if (ContainsAnyToken(combinedName, architecturalLinkNames))
        {
            return "architecture";
        }
        if (ContainsAnyToken(combinedName, structuralLinkNames))
        {
            return "structure";
        }

        if (ContainsAnyTokenFromArray(combinedName, new string[] { "struct", "str", "statik", "structure", "tasiyici" }))
        {
            return "structure";
        }
        if (ContainsAnyTokenFromArray(combinedName, new string[] { "arch", "arc", "mimari", "architecture", "room" }))
        {
            return "architecture";
        }

        bool hasStructural = HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming) ||
                             HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns);
        bool hasSpatial = HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_Rooms) ||
                          HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces);
        bool hasArchitecturalEnvelope = HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_Walls) ||
                                        HasCategoryElements(linkDocument, Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings);

        if (hasStructural && !hasSpatial && !hasArchitecturalEnvelope)
        {
            return "structure";
        }
        if (hasSpatial || hasArchitecturalEnvelope)
        {
            return "architecture";
        }
        if (hasStructural)
        {
            return "structure";
        }
        return "unknown";
    }

    System.Collections.Generic.List<System.Tuple<string, Autodesk.Revit.DB.Document, Autodesk.Revit.DB.Transform, string, int>> sources =
        new System.Collections.Generic.List<System.Tuple<string, Autodesk.Revit.DB.Document, Autodesk.Revit.DB.Transform, string, int>>();
    sources.Add(new System.Tuple<string, Autodesk.Revit.DB.Document, Autodesk.Revit.DB.Transform, string, int>("Host", document, Autodesk.Revit.DB.Transform.Identity, "host", 0));

    System.Collections.Generic.List<object> sourceLinks = new System.Collections.Generic.List<object>();
    foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(document).OfClass(typeof(Autodesk.Revit.DB.RevitLinkInstance)))
    {
        Autodesk.Revit.DB.RevitLinkInstance linkInstance = element as Autodesk.Revit.DB.RevitLinkInstance;
        if (linkInstance == null)
        {
            continue;
        }

        Autodesk.Revit.DB.Document linkDocument = null;
        try
        {
            linkDocument = linkInstance.GetLinkDocument();
        }
        catch
        {
        }

        string instanceName = SafeElementName(linkInstance);
        string linkDocumentTitle = linkDocument == null ? string.Empty : linkDocument.Title;
        string sourceName = string.IsNullOrWhiteSpace(instanceName) ? linkDocumentTitle : instanceName;
        if (string.IsNullOrWhiteSpace(sourceName))
        {
            sourceName = "Link " + linkInstance.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        Autodesk.Revit.DB.Transform transform = Autodesk.Revit.DB.Transform.Identity;
        try
        {
            transform = linkInstance.GetTransform();
        }
        catch
        {
        }

        System.Collections.Generic.Dictionary<string, object> linkRecord = new System.Collections.Generic.Dictionary<string, object>();
        linkRecord["id"] = linkInstance.Id.IntegerValue;
        linkRecord["name"] = sourceName;
        linkRecord["document_title"] = linkDocumentTitle;
        linkRecord["is_loaded"] = linkDocument != null;
        linkRecord["transform_to_host"] = TransformRecord(transform);

        if (linkDocument == null)
        {
            linkRecord["classification"] = "unloaded";
            linkRecord["type"] = "unloaded";
            warnings.Add("Linked model is not loaded and was skipped: " + sourceName);
            sourceLinks.Add(linkRecord);
            continue;
        }

        string classification = ClassifyLink(linkDocument, sourceName, linkDocumentTitle);
        linkRecord["classification"] = classification;
        linkRecord["type"] = classification;
        sourceLinks.Add(linkRecord);
        sources.Add(new System.Tuple<string, Autodesk.Revit.DB.Document, Autodesk.Revit.DB.Transform, string, int>(sourceName, linkDocument, transform, classification, linkInstance.Id.IntegerValue));
    }

    System.Collections.Generic.List<object> rooms = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> shafts = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> obstacles = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> preferredZones = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> forbiddenZones = new System.Collections.Generic.List<object>();
    System.Collections.Generic.HashSet<string> roomKeys = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.HashSet<string> shaftKeys = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.HashSet<string> obstacleKeys = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.Dictionary<string, int> obstacleTypeBreakdown = new System.Collections.Generic.Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase);
    System.Collections.Generic.Dictionary<string, int> obstacleCategoryBreakdown = new System.Collections.Generic.Dictionary<string, int>(System.StringComparer.OrdinalIgnoreCase);

    bool hasFootprint = false;
    double footprintMinX = double.PositiveInfinity;
    double footprintMinY = double.PositiveInfinity;
    double footprintMaxX = double.NegativeInfinity;
    double footprintMaxY = double.NegativeInfinity;

    void ExpandFootprint(double[] aabbFeet)
    {
        if (aabbFeet == null)
        {
            return;
        }

        hasFootprint = true;
        footprintMinX = System.Math.Min(footprintMinX, aabbFeet[0]);
        footprintMinY = System.Math.Min(footprintMinY, aabbFeet[1]);
        footprintMaxX = System.Math.Max(footprintMaxX, aabbFeet[3]);
        footprintMaxY = System.Math.Max(footprintMaxY, aabbFeet[4]);
    }

    bool AabbOverlapsFootprint(double[] aabbFeet, double paddingFeet)
    {
        if (aabbFeet == null || !hasFootprint)
        {
            return true;
        }

        return aabbFeet[3] >= footprintMinX - paddingFeet &&
               aabbFeet[0] <= footprintMaxX + paddingFeet &&
               aabbFeet[4] >= footprintMinY - paddingFeet &&
               aabbFeet[1] <= footprintMaxY + paddingFeet;
    }

    void IncrementBreakdown(System.Collections.Generic.Dictionary<string, int> breakdown, string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            key = "unknown";
        }

        if (!breakdown.ContainsKey(key))
        {
            breakdown[key] = 0;
        }
        breakdown[key]++;
    }

    System.Collections.Generic.Dictionary<string, object> BreakdownRecord(System.Collections.Generic.Dictionary<string, int> sourceBreakdown, string[] expectedKeys)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        for (int i = 0; i < expectedKeys.Length; i++)
        {
            string key = expectedKeys[i];
            record[key] = sourceBreakdown.ContainsKey(key) ? sourceBreakdown[key] : 0;
        }

        foreach (System.Collections.Generic.KeyValuePair<string, int> pair in sourceBreakdown)
        {
            if (!record.ContainsKey(pair.Key))
            {
                record[pair.Key] = pair.Value;
            }
        }

        return record;
    }

    bool IsShaftLikeText(string value)
    {
        return ContainsAnyTokenFromArray(value, new string[] { "shaft", "riser", "mechanical shaft", "mep shaft", "tesisat", "saft", "sapt", "servis" });
    }

    bool IsExplicitShaftElement(Autodesk.Revit.DB.Element element)
    {
        if (element == null || explicitShaftIds.Count == 0)
        {
            return false;
        }

        string id = element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return explicitShaftIds.Contains(id);
    }

    void AddShaftFromElement(Autodesk.Revit.DB.Element element, Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, string detectionMethod, System.Collections.Generic.Dictionary<string, object> boundary)
    {
        string key = ElementKey(sourceName, element);
        if (shaftKeys.Contains(key))
        {
            return;
        }

        double[] shaftAabb = null;
        try
        {
            shaftAabb = ComputeAabbFeet(element.get_BoundingBox(null), sourceToHost);
        }
        catch
        {
        }

        shaftKeys.Add(key);
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["id"] = key;
        AddIdentityFields(record, element, sourceDocument, sourceType, linkInstanceId);
        record["name"] = SafeElementName(element);
        record["category"] = CategoryName(element);
        record["source_link"] = sourceName;
        record["detection_method"] = detectionMethod;
        record["centroid_mm"] = PointMm(CentroidForElement(element, sourceToHost));
        if (shaftAabb != null)
        {
            record["z_min_mm"] = Round3(ToMm(shaftAabb[2]));
            record["z_max_mm"] = Round3(ToMm(shaftAabb[5]));
        }
        if (boundary != null)
        {
            record["boundary"] = boundary;
        }
        else
        {
            record["boundary"] = shaftAabb == null ? new System.Collections.Generic.Dictionary<string, object>() : BboxBoundaryRecord(shaftAabb);
        }

        shafts.Add(record);
    }

    System.Collections.Generic.Dictionary<string, object> SpatialRecord(Autodesk.Revit.DB.SpatialElement spatial, Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, string spatialType)
    {
        string key = ElementKey(sourceName, spatial);
        System.Collections.Generic.Dictionary<string, object> room = new System.Collections.Generic.Dictionary<string, object>();
        string name = SafeElementName(spatial);
        string number = ParameterText(spatial, "Number");
        if (string.IsNullOrWhiteSpace(number))
        {
            try
            {
                Autodesk.Revit.DB.Architecture.Room roomElement = spatial as Autodesk.Revit.DB.Architecture.Room;
                if (roomElement != null)
                {
                    number = roomElement.Number;
                }
            }
            catch
            {
            }
        }

        Autodesk.Revit.DB.Level sourceLevel = ElementLevel(sourceDocument, spatial);
        System.Collections.Generic.Dictionary<string, object> boundary = SpatialBoundaryRecord(spatial, sourceToHost);
        Autodesk.Revit.DB.XYZ centroid = CentroidForElement(spatial, sourceToHost);
        double[] aabb = null;
        try
        {
            aabb = ComputeAabbFeet(spatial.get_BoundingBox(null), sourceToHost);
            ExpandFootprint(aabb);
        }
        catch
        {
        }

        room["id"] = key;
        AddIdentityFields(room, spatial, sourceDocument, sourceType, linkInstanceId);
        room["source_link"] = sourceName;
        room["type"] = spatialType;
        room["name"] = name;
        room["number"] = number;
        room["level"] = sourceLevel == null ? string.Empty : sourceLevel.Name;
        room["level_name"] = sourceLevel == null ? string.Empty : sourceLevel.Name;
        room["centroid_mm"] = PointMm(centroid);
        room["boundary"] = boundary;
        if (aabb != null)
        {
            room["bbox_mm"] = AabbRecord(aabb);
        }

        System.Collections.Generic.Dictionary<string, object> roomParameters = new System.Collections.Generic.Dictionary<string, object>();
        try
        {
            room["area_m2"] = Round3(Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(spatial.Area, Autodesk.Revit.DB.UnitTypeId.SquareMeters));
            roomParameters["area_m2"] = room["area_m2"];
        }
        catch
        {
            room["area_m2"] = null;
            roomParameters["area_m2"] = null;
        }

        string department = ParameterText(spatial, "Department");
        if (!string.IsNullOrWhiteSpace(department))
        {
            room["department"] = department;
        }
        roomParameters["department"] = department;
        string occupancy = ParameterText(spatial, "Occupancy");
        if (!string.IsNullOrWhiteSpace(occupancy))
        {
            room["occupancy"] = occupancy;
        }
        roomParameters["occupancy"] = occupancy;
        room["parameters"] = roomParameters;

        if (IsShaftLikeText(name) || IsShaftLikeText(number) || IsExplicitShaftElement(spatial))
        {
            AddShaftFromElement(spatial, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, IsExplicitShaftElement(spatial) ? "explicit_id" : "room_or_space_name", boundary);
        }

        string searchText = name + " " + number + " " + department;
        if (ContainsAnyToken(searchText, preferredRoomNames))
        {
            System.Collections.Generic.Dictionary<string, object> preferred = new System.Collections.Generic.Dictionary<string, object>();
            preferred["id"] = key;
            preferred["source_room_id"] = key;
            preferred["source_link"] = sourceName;
            preferred["name"] = name;
            preferred["type"] = "user_rule";
            preferred["reason"] = "matched preferred_room_names";
            preferred["boundary"] = boundary;
            preferredZones.Add(preferred);
        }

        if (ContainsAnyToken(searchText, forbiddenRoomNames))
        {
            System.Collections.Generic.Dictionary<string, object> forbidden = new System.Collections.Generic.Dictionary<string, object>();
            forbidden["id"] = key;
            forbidden["source_room_id"] = key;
            forbidden["source_link"] = sourceName;
            forbidden["name"] = name;
            forbidden["type"] = "user_rule";
            forbidden["reason"] = "matched forbidden_room_names";
            forbidden["boundary"] = boundary;
            forbiddenZones.Add(forbidden);
        }

        return room;
    }

    void ExtractSpatialCategory(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, Autodesk.Revit.DB.BuiltInCategory category, string spatialType)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
            {
                Autodesk.Revit.DB.SpatialElement spatial = element as Autodesk.Revit.DB.SpatialElement;
                if (spatial == null)
                {
                    continue;
                }

                Autodesk.Revit.DB.Level sourceLevel = ElementLevel(sourceDocument, spatial);
                if (!LevelMatchesTarget(sourceLevel, sourceToHost))
                {
                    continue;
                }

                string key = ElementKey(sourceName, spatial);
                if (roomKeys.Contains(key))
                {
                    continue;
                }

                roomKeys.Add(key);
                rooms.Add(SpatialRecord(spatial, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, spatialType));
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Spatial extraction failed for " + sourceName + " category " + category.ToString() + ": " + ex.Message);
        }
    }

    for (int i = 0; i < sources.Count; i++)
    {
        string sourceName = sources[i].Item1;
        Autodesk.Revit.DB.Document sourceDocument = sources[i].Item2;
        Autodesk.Revit.DB.Transform sourceToHost = sources[i].Item3;
        string classification = sources[i].Item4;
        int linkInstanceId = sources[i].Item5;

        if (classification == "host" || classification == "architecture" || classification == "unknown")
        {
            ExtractSpatialCategory(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_Rooms, "room");
            ExtractSpatialCategory(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_MEPSpaces, "space");
        }
    }

    bool hasArchitectureLink = false;
    bool hasStructureLink = false;
    for (int i = 0; i < sources.Count; i++)
    {
        if (sources[i].Item4 == "architecture")
        {
            hasArchitectureLink = true;
        }
        if (sources[i].Item4 == "structure")
        {
            hasStructureLink = true;
        }
    }
    if (!hasArchitectureLink)
    {
        warnings.Add("No loaded architectural link was classified. Host rooms/spaces and unknown links were still checked.");
    }
    if (rooms.Count == 0)
    {
        warnings.Add("No rooms or MEP spaces matched target level '" + targetLevel.Name + "'.");
    }

    double FindLowestCategoryBottom(System.Collections.Generic.List<string> allowedClassifications, Autodesk.Revit.DB.BuiltInCategory category, double searchMinZ, double searchMaxZ, out string sourceDescription)
    {
        sourceDescription = string.Empty;
        bool found = false;
        double best = 0.0;
        for (int i = 0; i < sources.Count; i++)
        {
            string classification = sources[i].Item4;
            if (!allowedClassifications.Contains(classification))
            {
                continue;
            }

            Autodesk.Revit.DB.Document sourceDocument = sources[i].Item2;
            Autodesk.Revit.DB.Transform sourceToHost = sources[i].Item3;
            string sourceName = sources[i].Item1;
            try
            {
                foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
                {
                    double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), sourceToHost);
                    if (aabb == null)
                    {
                        continue;
                    }

                    double bottom = aabb[2];
                    if (bottom < searchMinZ || bottom > searchMaxZ)
                    {
                        continue;
                    }
                    if (!AabbOverlapsFootprint(aabb, FromMm(1000.0)))
                    {
                        continue;
                    }

                    if (!found || bottom < best)
                    {
                        found = true;
                        best = bottom;
                        sourceDescription = sourceName + ":" + element.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    }
                }
            }
            catch
            {
            }
        }

        if (!found)
        {
            return double.NaN;
        }
        return best;
    }

    System.Collections.Generic.List<string> architectureOrHost = new System.Collections.Generic.List<string>();
    architectureOrHost.Add("architecture");
    architectureOrHost.Add("host");
    architectureOrHost.Add("unknown");
    System.Collections.Generic.List<string> structureArchitectureOrHost = new System.Collections.Generic.List<string>();
    structureArchitectureOrHost.Add("structure");
    structureArchitectureOrHost.Add("architecture");
    structureArchitectureOrHost.Add("host");
    structureArchitectureOrHost.Add("unknown");

    string ceilingSourceElement;
    string slabSourceElement;
    double searchMinZ = targetElevation + FromMm(1800.0);
    double searchMaxZ = targetElevation + FromMm(7000.0);
    double modelCeilingBottom = FindLowestCategoryBottom(architectureOrHost, Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings, searchMinZ, searchMaxZ, out ceilingSourceElement);
    bool hasModelCeiling = !double.IsNaN(modelCeilingBottom);

    double ceilingZMin = hasModelCeiling ? modelCeilingBottom : targetElevation + defaultCeilingHeight;
    string ceilingZSource = hasModelCeiling ? "model_ceiling_bottom" : "fallback_default_ceiling_height";
    if (!hasModelCeiling)
    {
        warnings.Add("No ceiling element was found above target level. Using default_ceiling_height_mm=" + defaultCeilingHeightMm.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
    }

    double slabSearchMinZ = ceilingZMin + FromMm(100.0);
    double slabSearchMaxZ = targetElevation + FromMm(9000.0);
    double modelSlabBottom = FindLowestCategoryBottom(structureArchitectureOrHost, Autodesk.Revit.DB.BuiltInCategory.OST_Floors, slabSearchMinZ, slabSearchMaxZ, out slabSourceElement);
    bool hasModelSlab = !double.IsNaN(modelSlabBottom);
    double ceilingZMax = hasModelSlab ? modelSlabBottom : ceilingZMin + defaultPlenumHeight;
    string slabZSource = hasModelSlab ? "model_slab_bottom" : "fallback_default_plenum_height";
    if (!hasModelSlab)
    {
        warnings.Add("No slab/floor bottom was found above target level. Using default_plenum_height_mm=" + defaultPlenumHeightMm.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
    }

    System.Collections.Generic.Dictionary<string, object> ceilingZone = new System.Collections.Generic.Dictionary<string, object>();
    ceilingZone["id"] = "host-level-" + targetLevel.Id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-ceiling-zone";
    ceilingZone["name"] = targetLevel.Name + " Ceiling Plenum";
    ceilingZone["zone_type"] = "level_plenum";
    ceilingZone["level_id"] = targetLevel.Id.IntegerValue;
    ceilingZone["level_name"] = targetLevel.Name;
    ceilingZone["z_min_mm"] = Round3(ToMm(ceilingZMin));
    ceilingZone["z_max_mm"] = Round3(ToMm(ceilingZMax));
    ceilingZone["z_source"] = hasModelCeiling && hasModelSlab ? "model" : (!hasModelCeiling && !hasModelSlab ? "fallback" : "mixed");
    ceilingZone["z_source_detail"] = ceilingZSource + "/" + slabZSource;
    ceilingZone["ceiling_source_element"] = hasModelCeiling ? ceilingSourceElement : null;
    ceilingZone["slab_source_element"] = hasModelSlab ? slabSourceElement : null;
    ceilingZone["notes"] = new System.Collections.Generic.List<object>();

    if (hasFootprint)
    {
        double[] footprint = new double[] { footprintMinX, footprintMinY, ceilingZMin, footprintMaxX, footprintMaxY, ceilingZMax };
        ceilingZone["boundary"] = BboxBoundaryRecord(footprint);
    }
    else
    {
        System.Collections.Generic.Dictionary<string, object> unknownBoundary = new System.Collections.Generic.Dictionary<string, object>();
        unknownBoundary["type"] = "unknown";
        unknownBoundary["points_mm"] = new System.Collections.Generic.List<object>();
        ceilingZone["boundary"] = unknownBoundary;
    }

    System.Collections.Generic.List<object> ceilingZones = new System.Collections.Generic.List<object>();
    ceilingZones.Add(ceilingZone);

    int structuralFramingObstacleCount = 0;
    int structuralColumnObstacleCount = 0;

    void AddObstacle(Autodesk.Revit.DB.Element element, Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, string obstacleType)
    {
        if (element == null)
        {
            return;
        }

        try
        {
            string obstacleKey = ElementKey(sourceName, element);
            if (obstacleKeys.Contains(obstacleKey))
            {
                return;
            }

            double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), sourceToHost);
            if (aabb == null)
            {
                return;
            }

            double bandPadding = FromMm(500.0);
            if (aabb[5] < ceilingZMin - bandPadding || aabb[2] > ceilingZMax + bandPadding)
            {
                return;
            }
            if (!AabbOverlapsFootprint(aabb, FromMm(1000.0)))
            {
                return;
            }

            obstacleKeys.Add(obstacleKey);
            System.Collections.Generic.Dictionary<string, object> obstacle = new System.Collections.Generic.Dictionary<string, object>();
            obstacle["id"] = obstacleKey;
            AddIdentityFields(obstacle, element, sourceDocument, sourceType, linkInstanceId);
            obstacle["source_link"] = sourceName;
            obstacle["name"] = SafeElementName(element);
            obstacle["category"] = CategoryName(element);
            obstacle["obstacle_type"] = obstacleType;
            obstacle["aabb_mm"] = AabbRecord(aabb);
            obstacles.Add(obstacle);
            IncrementBreakdown(obstacleTypeBreakdown, obstacleType);
            IncrementBreakdown(obstacleCategoryBreakdown, CategoryName(element));
            if (obstacleType == "beam")
            {
                structuralFramingObstacleCount++;
            }
            if (obstacleType == "column")
            {
                structuralColumnObstacleCount++;
            }

            if (IsExplicitShaftElement(element) || IsShaftLikeText(SafeElementName(element)) || IsShaftLikeText(CategoryName(element)))
            {
                AddShaftFromElement(element, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, IsExplicitShaftElement(element) ? "explicit_id" : "element_name_or_category", BboxBoundaryRecord(aabb));
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Obstacle extraction failed for " + ElementKey(sourceName, element) + ": " + ex.Message);
        }
    }

    void ExtractObstacles(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, Autodesk.Revit.DB.BuiltInCategory category, string obstacleType)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
            {
                AddObstacle(element, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, obstacleType);
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Obstacle category extraction failed for " + sourceName + " category " + category.ToString() + ": " + ex.Message);
        }
    }

    void ExtractShaftCategory(Autodesk.Revit.DB.Document sourceDocument, Autodesk.Revit.DB.Transform sourceToHost, string sourceName, string sourceType, int linkInstanceId, Autodesk.Revit.DB.BuiltInCategory category, string detectionMethod)
    {
        try
        {
            foreach (Autodesk.Revit.DB.Element element in new Autodesk.Revit.DB.FilteredElementCollector(sourceDocument).OfCategory(category).WhereElementIsNotElementType())
            {
                double[] aabb = ComputeAabbFeet(element.get_BoundingBox(null), sourceToHost);
                if (aabb == null)
                {
                    AddShaftFromElement(element, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, detectionMethod, null);
                    continue;
                }

                if (aabb[5] < targetElevation - FromMm(500.0) || aabb[2] > ceilingZMax + FromMm(3000.0))
                {
                    continue;
                }
                if (!AabbOverlapsFootprint(aabb, FromMm(1000.0)))
                {
                    continue;
                }

                AddShaftFromElement(element, sourceDocument, sourceToHost, sourceName, sourceType, linkInstanceId, detectionMethod, BboxBoundaryRecord(aabb));
            }
        }
        catch (System.Exception ex)
        {
            warnings.Add("Shaft category extraction failed for " + sourceName + " category " + category.ToString() + ": " + ex.Message);
        }
    }

    for (int i = 0; i < sources.Count; i++)
    {
        string sourceName = sources[i].Item1;
        Autodesk.Revit.DB.Document sourceDocument = sources[i].Item2;
        Autodesk.Revit.DB.Transform sourceToHost = sources[i].Item3;
        string classification = sources[i].Item4;
        int linkInstanceId = sources[i].Item5;
        bool isStructuralSource = classification == "structure" || classification == "host" || classification == "unknown";
        bool isArchitecturalSource = classification == "architecture" || classification == "host" || classification == "unknown";

        if (isStructuralSource)
        {
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralFraming, "beam");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_StructuralColumns, "column");
        }

        if (classification == "structure")
        {
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_Floors, "structural_slab");
        }

        if (isArchitecturalSource)
        {
            ExtractShaftCategory(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_ShaftOpening, "shaft_opening_category");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_Walls, "wall_or_partition");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_Floors, "slab_or_floor");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_Ceilings, "ceiling");
        }

        if (classification == "host" && includeExistingMep)
        {
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_DuctCurves, "existing_duct");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_PipeCurves, "existing_pipe");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_MechanicalEquipment, "existing_mechanical_equipment");
            ExtractObstacles(sourceDocument, sourceToHost, sourceName, classification, linkInstanceId, Autodesk.Revit.DB.BuiltInCategory.OST_DuctTerminal, "existing_air_terminal");
        }
    }

    if (!hasStructureLink)
    {
        if (structuralFramingObstacleCount > 0 || structuralColumnObstacleCount > 0)
        {
            warnings.Add("No loaded structural link was classified; structural framing/column obstacles were extracted from host or unknown sources.");
        }
        else
        {
            warnings.Add("No loaded structural link was classified and no host/unknown structural framing or column obstacles were found. Structural obstacles may be incomplete.");
        }
    }

    if (hasStructureLink && structuralFramingObstacleCount == 0)
    {
        warnings.Add("No structural framing obstacles were found in the target ceiling band.");
    }
    if (hasStructureLink && structuralColumnObstacleCount == 0)
    {
        warnings.Add("No structural column obstacles were found in the target ceiling band.");
    }

    if (!includeExistingMep)
    {
        warnings.Add("Existing MEP obstacle extraction was skipped because include_existing_mep=false.");
    }

    System.Collections.Generic.Dictionary<string, object> source = new System.Collections.Generic.Dictionary<string, object>();
    source["host_document"] = document.Title;
    source["host_document_title"] = document.Title;
    source["target_level_id"] = targetLevel.Id.IntegerValue;
    source["target_level_name"] = targetLevel.Name;
    source["target_level_elevation_mm"] = Round3(ToMm(targetElevation));
    System.Collections.Generic.Dictionary<string, object> targetLevelRecord = new System.Collections.Generic.Dictionary<string, object>();
    targetLevelRecord["id"] = targetLevel.Id.IntegerValue;
    targetLevelRecord["name"] = targetLevel.Name;
    targetLevelRecord["elevation_mm"] = Round3(ToMm(targetElevation));
    source["target_level"] = targetLevelRecord;
    source["target_level_resolution"] = targetLevelSource;
    source["units"] = "millimeters";
    source["include_existing_mep"] = includeExistingMep;
    source["links"] = sourceLinks;

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["room_count"] = rooms.Count;
    summary["ceiling_zone_count"] = ceilingZones.Count;
    summary["shaft_count"] = shafts.Count;
    summary["obstacle_count"] = obstacles.Count;
    summary["obstacle_type_breakdown"] = BreakdownRecord(
        obstacleTypeBreakdown,
        new string[] { "beam", "column", "wall_or_partition", "slab_or_floor", "structural_slab", "ceiling", "existing_duct", "existing_pipe", "existing_mechanical_equipment", "existing_air_terminal" });
    summary["obstacle_category_breakdown"] = BreakdownRecord(
        obstacleCategoryBreakdown,
        new string[] { "Structural Framing", "Structural Columns", "Walls", "Floors", "Ceilings" });

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "spatial-zone-extract.v1";
    result["summary"] = summary;
    result["source"] = source;
    result["ceiling_zones"] = ceilingZones;
    result["rooms"] = rooms;
    result["shafts"] = shafts;
    result["obstacles"] = obstacles;
    result["preferred_zones"] = preferredZones;
    result["forbidden_zones"] = forbiddenZones;
    result["warnings"] = warnings;
    result["errors"] = errors;

    return SerializeJson(result);
}
catch (System.Exception ex)
{
    System.Collections.Generic.Dictionary<string, object> failed = new System.Collections.Generic.Dictionary<string, object>();
    failed["schema_version"] = "spatial-zone-extract.v1";
    failed["source"] = new System.Collections.Generic.Dictionary<string, object>();
    failed["ceiling_zones"] = new System.Collections.Generic.List<object>();
    failed["rooms"] = new System.Collections.Generic.List<object>();
    failed["shafts"] = new System.Collections.Generic.List<object>();
    failed["obstacles"] = new System.Collections.Generic.List<object>();
    failed["preferred_zones"] = new System.Collections.Generic.List<object>();
    failed["forbidden_zones"] = new System.Collections.Generic.List<object>();

    System.Collections.Generic.List<object> warnings = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> errors = new System.Collections.Generic.List<object>();
    errors.Add(ex.GetType().FullName + ": " + ex.Message);
    failed["warnings"] = warnings;
    failed["errors"] = errors;

    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"spatial-zone-extract.v1\",\"source\":{},\"ceiling_zones\":[],\"rooms\":[],\"shafts\":[],\"obstacles\":[],\"preferred_zones\":[],\"forbidden_zones\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
