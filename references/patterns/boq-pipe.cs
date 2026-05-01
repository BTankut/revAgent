// BOQ — pipe system + diameter-based quantity takeoff.
// Body of Execute(Document document, object[] parameters).

try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Plumbing.Pipe pipe = elem as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe == null) continue;

        Parameter lenP = pipe.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        Parameter diamP = pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
        Parameter sysP = pipe.LookupParameter("System Type");

        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        double diamMm = (diamP != null && diamP.HasValue)
            ? UnitUtils.ConvertFromInternalUnits(diamP.AsDouble(), UnitTypeId.Millimeters)
            : 0;
        double lenM = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | DN{1:F0}", sys, diamMm);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SYSTEM | DIAMETER | LENGTH (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
