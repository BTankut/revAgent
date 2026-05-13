// Deterministic duct sizing from airflow.
// Computes rectangular or round duct dimensions; does not create Revit elements.
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

    if (!options.ContainsKey("airflow_lps") && options.ContainsKey("flow_lps")) options["airflow_lps"] = options["flow_lps"];
    if (!options.ContainsKey("airflow_lps") && options.ContainsKey("total_flow_lps")) options["airflow_lps"] = options["total_flow_lps"];
    if (!options.ContainsKey("terminal_flow_lps") && options.ContainsKey("diffuser_flow_lps")) options["terminal_flow_lps"] = options["diffuser_flow_lps"];
    if (!options.ContainsKey("duct_shape") && options.ContainsKey("shape")) options["duct_shape"] = options["shape"];

    string GetOption(string key, string fallback)
    {
        if (options.ContainsKey(key) && !string.IsNullOrWhiteSpace(options[key])) return options[key];
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

    string NormalizeText(string value)
    {
        return value == null ? string.Empty : value.Trim().ToLowerInvariant();
    }

    double Round3(double value)
    {
        return System.Math.Round(value, 3);
    }

    double Round6(double value)
    {
        return System.Math.Round(value, 6);
    }

    double StepUp(double value, double step)
    {
        if (step <= 0.0) return value;
        return System.Math.Ceiling(value / step) * step;
    }

    double PositiveOption(string key, double fallback, string label)
    {
        double value = GetDoubleOption(key, fallback);
        if (value <= 0.0)
        {
            warnings.Add(label + " must be positive; using " + fallback.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + ".");
            return fallback;
        }
        return value;
    }

    double AirflowLpsFromOptions()
    {
        double airflowLps = GetDoubleOption("airflow_lps", double.NaN);
        if (!double.IsNaN(airflowLps)) return airflowLps;
        double airflowM3h = GetDoubleOption("airflow_m3h", double.NaN);
        if (!double.IsNaN(airflowM3h)) return airflowM3h / 3.6;
        double airflowCfm = GetDoubleOption("airflow_cfm", double.NaN);
        if (!double.IsNaN(airflowCfm)) return airflowCfm * 0.47194745;
        return double.NaN;
    }

    double PressureLossPaPerM(double hydraulicDiameterM, double velocityMps, double roughnessMm, double airDensityKgM3, double airViscosityPaS)
    {
        if (hydraulicDiameterM <= 0.0 || velocityMps <= 0.0 || airDensityKgM3 <= 0.0 || airViscosityPaS <= 0.0) return 0.0;
        double reynolds = airDensityKgM3 * velocityMps * hydraulicDiameterM / airViscosityPaS;
        double roughnessM = System.Math.Max(0.0, roughnessMm) / 1000.0;
        double frictionFactor;
        if (reynolds > 0.0 && reynolds < 2300.0)
        {
            frictionFactor = 64.0 / reynolds;
        }
        else
        {
            double term = roughnessM / (3.7 * hydraulicDiameterM) + 5.74 / System.Math.Pow(System.Math.Max(reynolds, 1.0), 0.9);
            frictionFactor = 0.25 / System.Math.Pow(System.Math.Log10(term), 2.0);
        }
        return frictionFactor * (airDensityKgM3 * velocityMps * velocityMps / 2.0) / hydraulicDiameterM;
    }

    System.Collections.Generic.Dictionary<string, object> SizeRectangular(
        string label,
        double airflowLps,
        double maxVelocityMps,
        double minWidthMm,
        double maxWidthMm,
        double minHeightMm,
        double maxHeightMm,
        double widthStepMm,
        double heightStepMm,
        double aspectRatioLimit,
        double preferredAspectRatio,
        double roughnessMm,
        double airDensityKgM3,
        double airViscosityPaS)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["label"] = label;
        record["shape"] = "rectangular";
        record["airflow_lps"] = Round3(airflowLps);
        record["max_velocity_mps"] = Round3(maxVelocityMps);

        if (airflowLps <= 0.0 || maxVelocityMps <= 0.0)
        {
            record["status"] = "fail";
            record["error"] = "Airflow and max_velocity_mps must be positive.";
            return record;
        }

        double airflowM3s = airflowLps / 1000.0;
        double requiredAreaM2 = airflowM3s / maxVelocityMps;
        double bestWidthMm = 0.0;
        double bestHeightMm = 0.0;
        double bestAreaM2 = 0.0;
        double bestVelocityMps = 0.0;
        double bestScoreArea = double.PositiveInfinity;
        double bestScoreAspect = double.PositiveInfinity;
        double bestScoreHeight = double.PositiveInfinity;

        double widthStart = StepUp(minWidthMm, widthStepMm);
        double heightStart = StepUp(minHeightMm, heightStepMm);
        for (double widthMm = widthStart; widthMm <= maxWidthMm + 0.001; widthMm += widthStepMm)
        {
            for (double heightMm = heightStart; heightMm <= maxHeightMm + 0.001; heightMm += heightStepMm)
            {
                double aspectRatio = System.Math.Max(widthMm / heightMm, heightMm / widthMm);
                if (aspectRatio > aspectRatioLimit + 0.000001) continue;
                double areaM2 = (widthMm / 1000.0) * (heightMm / 1000.0);
                if (areaM2 <= 0.0) continue;
                double velocityMps = airflowM3s / areaM2;
                if (velocityMps > maxVelocityMps + 0.000001) continue;
                double aspectScore = System.Math.Abs((widthMm / heightMm) - preferredAspectRatio);
                bool better =
                    areaM2 < bestScoreArea - 0.000000001 ||
                    (System.Math.Abs(areaM2 - bestScoreArea) <= 0.000000001 && aspectScore < bestScoreAspect - 0.000001) ||
                    (System.Math.Abs(areaM2 - bestScoreArea) <= 0.000000001 && System.Math.Abs(aspectScore - bestScoreAspect) <= 0.000001 && heightMm < bestScoreHeight - 0.001);
                if (!better) continue;
                bestWidthMm = widthMm;
                bestHeightMm = heightMm;
                bestAreaM2 = areaM2;
                bestVelocityMps = velocityMps;
                bestScoreArea = areaM2;
                bestScoreAspect = aspectScore;
                bestScoreHeight = heightMm;
            }
        }

        record["required_area_m2"] = Round6(requiredAreaM2);
        if (bestWidthMm <= 0.0 || bestHeightMm <= 0.0)
        {
            record["status"] = "fail";
            record["error"] = "No rectangular duct size satisfies airflow, velocity, dimension, and aspect-ratio constraints.";
            return record;
        }

        double hydraulicDiameterM = 2.0 * (bestWidthMm / 1000.0) * (bestHeightMm / 1000.0) / ((bestWidthMm / 1000.0) + (bestHeightMm / 1000.0));
        double pressureLoss = PressureLossPaPerM(hydraulicDiameterM, bestVelocityMps, roughnessMm, airDensityKgM3, airViscosityPaS);

        record["status"] = "pass";
        record["width_mm"] = Round3(bestWidthMm);
        record["height_mm"] = Round3(bestHeightMm);
        record["area_m2"] = Round6(bestAreaM2);
        record["velocity_mps"] = Round3(bestVelocityMps);
        record["hydraulic_diameter_mm"] = Round3(hydraulicDiameterM * 1000.0);
        record["aspect_ratio"] = Round3(System.Math.Max(bestWidthMm / bestHeightMm, bestHeightMm / bestWidthMm));
        record["pressure_loss_pa_per_m"] = Round3(pressureLoss);
        return record;
    }

    System.Collections.Generic.Dictionary<string, object> SizeRound(
        string label,
        double airflowLps,
        double maxVelocityMps,
        double minDiameterMm,
        double maxDiameterMm,
        double diameterStepMm,
        double roughnessMm,
        double airDensityKgM3,
        double airViscosityPaS)
    {
        System.Collections.Generic.Dictionary<string, object> record = new System.Collections.Generic.Dictionary<string, object>();
        record["label"] = label;
        record["shape"] = "round";
        record["airflow_lps"] = Round3(airflowLps);
        record["max_velocity_mps"] = Round3(maxVelocityMps);

        if (airflowLps <= 0.0 || maxVelocityMps <= 0.0)
        {
            record["status"] = "fail";
            record["error"] = "Airflow and max_velocity_mps must be positive.";
            return record;
        }

        double airflowM3s = airflowLps / 1000.0;
        double requiredAreaM2 = airflowM3s / maxVelocityMps;
        double diameterStart = StepUp(minDiameterMm, diameterStepMm);
        double bestDiameterMm = 0.0;
        double bestAreaM2 = 0.0;
        double bestVelocityMps = 0.0;
        for (double diameterMm = diameterStart; diameterMm <= maxDiameterMm + 0.001; diameterMm += diameterStepMm)
        {
            double diameterM = diameterMm / 1000.0;
            double areaM2 = System.Math.PI * diameterM * diameterM / 4.0;
            if (areaM2 <= 0.0) continue;
            double velocityMps = airflowM3s / areaM2;
            if (velocityMps > maxVelocityMps + 0.000001) continue;
            bestDiameterMm = diameterMm;
            bestAreaM2 = areaM2;
            bestVelocityMps = velocityMps;
            break;
        }

        record["required_area_m2"] = Round6(requiredAreaM2);
        if (bestDiameterMm <= 0.0)
        {
            record["status"] = "fail";
            record["error"] = "No round duct diameter satisfies airflow, velocity, and diameter constraints.";
            return record;
        }

        double pressureLoss = PressureLossPaPerM(bestDiameterMm / 1000.0, bestVelocityMps, roughnessMm, airDensityKgM3, airViscosityPaS);
        record["status"] = "pass";
        record["diameter_mm"] = Round3(bestDiameterMm);
        record["area_m2"] = Round6(bestAreaM2);
        record["velocity_mps"] = Round3(bestVelocityMps);
        record["hydraulic_diameter_mm"] = Round3(bestDiameterMm);
        record["pressure_loss_pa_per_m"] = Round3(pressureLoss);
        return record;
    }

    string ductShape = NormalizeText(GetOption("duct_shape", "rectangular"));
    if (ductShape == "rect" || ductShape == "rectangle") ductShape = "rectangular";
    if (ductShape == "circular" || ductShape == "circle") ductShape = "round";
    if (ductShape != "rectangular" && ductShape != "round")
    {
        warnings.Add("Unknown duct_shape '" + ductShape + "'; using rectangular.");
        ductShape = "rectangular";
    }

    double maxVelocityMps = PositiveOption("max_velocity_mps", 5.0, "max_velocity_mps");
    double branchMaxVelocityMps = PositiveOption("branch_max_velocity_mps", maxVelocityMps, "branch_max_velocity_mps");
    double trunkMaxVelocityMps = PositiveOption("trunk_max_velocity_mps", maxVelocityMps, "trunk_max_velocity_mps");
    double minWidthMm = PositiveOption("min_width_mm", 150.0, "min_width_mm");
    double maxWidthMm = PositiveOption("max_width_mm", 2000.0, "max_width_mm");
    double minHeightMm = PositiveOption("min_height_mm", 100.0, "min_height_mm");
    double maxHeightMm = PositiveOption("max_height_mm", 1000.0, "max_height_mm");
    double widthStepMm = PositiveOption("width_step_mm", 50.0, "width_step_mm");
    double heightStepMm = PositiveOption("height_step_mm", 50.0, "height_step_mm");
    double aspectRatioLimit = PositiveOption("aspect_ratio_limit", 4.0, "aspect_ratio_limit");
    double preferredAspectRatio = PositiveOption("preferred_aspect_ratio", 2.0, "preferred_aspect_ratio");
    double minDiameterMm = PositiveOption("min_diameter_mm", 100.0, "min_diameter_mm");
    double maxDiameterMm = PositiveOption("max_diameter_mm", 1600.0, "max_diameter_mm");
    double diameterStepMm = PositiveOption("diameter_step_mm", 25.0, "diameter_step_mm");
    double roughnessMm = PositiveOption("roughness_mm", 0.09, "roughness_mm");
    double airDensityKgM3 = PositiveOption("air_density_kg_m3", 1.2, "air_density_kg_m3");
    double airViscosityPaS = PositiveOption("air_viscosity_pa_s", 0.0000181, "air_viscosity_pa_s");
    int terminalCount = GetIntOption("terminal_count", 0);
    double terminalFlowLps = GetDoubleOption("terminal_flow_lps", double.NaN);
    double explicitAirflowLps = AirflowLpsFromOptions();

    if (maxWidthMm < minWidthMm)
    {
        errors.Add("max_width_mm must be greater than or equal to min_width_mm.");
    }
    if (maxHeightMm < minHeightMm)
    {
        errors.Add("max_height_mm must be greater than or equal to min_height_mm.");
    }
    if (maxDiameterMm < minDiameterMm)
    {
        errors.Add("max_diameter_mm must be greater than or equal to min_diameter_mm.");
    }
    if (terminalCount < 0)
    {
        errors.Add("terminal_count cannot be negative.");
    }
    if (double.IsNaN(explicitAirflowLps) && !(terminalCount > 0 && !double.IsNaN(terminalFlowLps)))
    {
        errors.Add("Provide airflow_lps/airflow_m3h/airflow_cfm, or provide terminal_count and terminal_flow_lps.");
    }

    System.Collections.Generic.List<object> sizes = new System.Collections.Generic.List<object>();
    if (errors.Count == 0)
    {
        if (!double.IsNaN(explicitAirflowLps))
        {
            System.Collections.Generic.Dictionary<string, object> single = ductShape == "round"
                ? SizeRound("single", explicitAirflowLps, maxVelocityMps, minDiameterMm, maxDiameterMm, diameterStepMm, roughnessMm, airDensityKgM3, airViscosityPaS)
                : SizeRectangular("single", explicitAirflowLps, maxVelocityMps, minWidthMm, maxWidthMm, minHeightMm, maxHeightMm, widthStepMm, heightStepMm, aspectRatioLimit, preferredAspectRatio, roughnessMm, airDensityKgM3, airViscosityPaS);
            sizes.Add(single);
            if (System.Convert.ToString(single["status"], System.Globalization.CultureInfo.InvariantCulture) == "fail") errors.Add(System.Convert.ToString(single["error"], System.Globalization.CultureInfo.InvariantCulture));
        }

        if (terminalCount > 0 && !double.IsNaN(terminalFlowLps))
        {
            System.Collections.Generic.Dictionary<string, object> branch = ductShape == "round"
                ? SizeRound("branch", terminalFlowLps, branchMaxVelocityMps, minDiameterMm, maxDiameterMm, diameterStepMm, roughnessMm, airDensityKgM3, airViscosityPaS)
                : SizeRectangular("branch", terminalFlowLps, branchMaxVelocityMps, minWidthMm, maxWidthMm, minHeightMm, maxHeightMm, widthStepMm, heightStepMm, aspectRatioLimit, preferredAspectRatio, roughnessMm, airDensityKgM3, airViscosityPaS);
            sizes.Add(branch);
            if (System.Convert.ToString(branch["status"], System.Globalization.CultureInfo.InvariantCulture) == "fail") errors.Add(System.Convert.ToString(branch["error"], System.Globalization.CultureInfo.InvariantCulture));

            double totalFlowLps = terminalFlowLps * terminalCount;
            System.Collections.Generic.Dictionary<string, object> trunk = ductShape == "round"
                ? SizeRound("trunk", totalFlowLps, trunkMaxVelocityMps, minDiameterMm, maxDiameterMm, diameterStepMm, roughnessMm, airDensityKgM3, airViscosityPaS)
                : SizeRectangular("trunk", totalFlowLps, trunkMaxVelocityMps, minWidthMm, maxWidthMm, minHeightMm, maxHeightMm, widthStepMm, heightStepMm, aspectRatioLimit, preferredAspectRatio, roughnessMm, airDensityKgM3, airViscosityPaS);
            sizes.Add(trunk);
            if (System.Convert.ToString(trunk["status"], System.Globalization.CultureInfo.InvariantCulture) == "fail") errors.Add(System.Convert.ToString(trunk["error"], System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    System.Collections.Generic.Dictionary<string, object> summary = new System.Collections.Generic.Dictionary<string, object>();
    summary["duct_shape"] = ductShape;
    summary["max_velocity_mps"] = Round3(maxVelocityMps);
    summary["branch_max_velocity_mps"] = Round3(branchMaxVelocityMps);
    summary["trunk_max_velocity_mps"] = Round3(trunkMaxVelocityMps);
    summary["terminal_count"] = terminalCount;
    summary["terminal_flow_lps"] = double.IsNaN(terminalFlowLps) ? null : (object)Round3(terminalFlowLps);
    summary["total_terminal_flow_lps"] = (terminalCount > 0 && !double.IsNaN(terminalFlowLps)) ? (object)Round3(terminalCount * terminalFlowLps) : null;
    summary["explicit_airflow_lps"] = double.IsNaN(explicitAirflowLps) ? null : (object)Round3(explicitAirflowLps);
    summary["roughness_mm"] = Round3(roughnessMm);
    summary["air_density_kg_m3"] = Round3(airDensityKgM3);
    summary["air_viscosity_pa_s"] = airViscosityPaS;
    summary["size_count"] = sizes.Count;

    System.Collections.Generic.Dictionary<string, object> result = new System.Collections.Generic.Dictionary<string, object>();
    result["schema_version"] = "duct-sizing-from-flow.v1";
    result["status"] = errors.Count > 0 ? "fail" : (warnings.Count > 0 ? "warn" : "pass");
    result["summary"] = summary;
    result["sizes"] = sizes;
    result["warnings"] = warnings;
    result["errors"] = errors;
    return SerializeJson(result);
}
catch (System.Exception ex)
{
    string message = ex.GetType().FullName + ": " + ex.Message;
    message = message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    return "{\"schema_version\":\"duct-sizing-from-flow.v1\",\"status\":\"fail\",\"summary\":{},\"sizes\":[],\"warnings\":[],\"errors\":[\"" + message + "\"]}";
}
