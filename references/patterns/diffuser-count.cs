// Diffuser count — by system classification + level.
// Body of Execute(Document document, object[] parameters).

try
{
    System.Collections.Generic.Dictionary<string, int> counts =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfCategory(BuiltInCategory.OST_DuctTerminal)
        .OfClass(typeof(FamilyInstance))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        FamilyInstance fi = elem as FamilyInstance;
        if (fi == null) continue;

        Parameter sysP = fi.LookupParameter("System Classification");
        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";

        ElementId lvlId = fi.LevelId;
        string lvl = (lvlId != null && lvlId != ElementId.InvalidElementId && document.GetElement(lvlId) != null)
            ? document.GetElement(lvlId).Name
            : "?";

        string key = string.Format("{0} | {1}", sys, lvl);
        if (!counts.ContainsKey(key)) counts[key] = 0;
        counts[key]++;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SYSTEM | LEVEL | COUNT");
    lines.Add(new string('-', 40));
    foreach (System.Collections.Generic.KeyValuePair<string, int> kv in counts)
        lines.Add(string.Format("{0}: {1}", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
