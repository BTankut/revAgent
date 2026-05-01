// BOQ — duct system + size-based quantity takeoff.
// Body of Execute(Document document, object[] parameters).

try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter lenP = duct.LookupParameter("Length");
        Parameter sysP = duct.LookupParameter("System Classification");
        Parameter sizeP = duct.LookupParameter("Size");

        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        string size = (sizeP != null && sizeP.HasValue) ? sizeP.AsValueString() : "?";
        double lenM = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | {1}", sys, size);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SYSTEM | SIZE | LENGTH (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
