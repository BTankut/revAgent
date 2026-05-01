// Pressure loss — per duct system, summed from segment friction * length.
// Body of Execute(Document document, object[] parameters).

try
{
    System.Collections.Generic.Dictionary<string, double> sysPa =
        new System.Collections.Generic.Dictionary<string, double>();
    System.Collections.Generic.Dictionary<string, int> sysCnt =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter fricP = duct.LookupParameter("Friction");
        Parameter lenP = duct.LookupParameter("Length");
        Parameter sysP = duct.LookupParameter("System Name");

        if (fricP == null || !fricP.HasValue) continue;
        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        double pam = UnitUtils.ConvertFromInternalUnits(fricP.AsDouble(), UnitTypeId.PascalsPerMeter);
        double m = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        if (!sysPa.ContainsKey(sys))
        {
            sysPa[sys] = 0.0;
            sysCnt[sys] = 0;
        }
        sysPa[sys] += pam * m;
        sysCnt[sys] += 1;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SYSTEM | TOTAL PRESSURE LOSS (Pa) | SEGMENTS");
    lines.Add(new string('-', 60));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in sysPa)
        lines.Add(string.Format("{0} -> {1:F1} Pa ({2} seg)", kv.Key, kv.Value, sysCnt[kv.Key]));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
