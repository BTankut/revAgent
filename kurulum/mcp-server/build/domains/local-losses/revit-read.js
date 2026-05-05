export function buildLocalLossOnlyCode({ categories = [], sampleLimit = 25, targetElementIds = [] } = {}) {
    const targetIds = (Array.isArray(targetElementIds) ? targetElementIds : [])
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    const requestedLimit = Number.parseInt(String(sampleLimit), 10);
    const baseLimit = Number.isFinite(requestedLimit) ? requestedLimit : 25;
    const limit = targetIds.length > 0
        ? Math.max(1, Math.min(2000, Math.max(baseLimit, targetIds.length)))
        : Math.max(1, Math.min(200, baseLimit));
    const categoryList = categories
        .filter((category) => /^OST_[A-Za-z0-9_]+$/.test(String(category || "")))
        .map((category) => `BuiltInCategory.${category}`)
        .join(",\n        ");
    const safeCategoryList = categoryList || "BuiltInCategory.OST_MechanicalEquipment";
    const targetIdList = targetIds.join(", ");
    return `
string SystemNameFor(Element elem)
{
    try
    {
        Parameter systemName = elem.LookupParameter("System Name");
        string key = systemName != null && systemName.HasValue ? systemName.AsString() : "";
        if (!string.IsNullOrEmpty(key)) return key;
    }
    catch {}
    return "(unassigned)";
}

string DisplayValue(Parameter parameter)
{
    if (parameter == null) return "";
    try
    {
        string value = parameter.AsValueString();
        if (!string.IsNullOrEmpty(value)) return value;
    }
    catch {}
    try
    {
        if (parameter.StorageType == StorageType.String) return parameter.AsString() ?? "";
        if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (parameter.StorageType == StorageType.Double) return parameter.AsDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

double ConvertDoubleValue(Parameter parameter, string valueKind)
{
    double raw = parameter.AsDouble();
    if (valueKind == "pressure_drop_pa")
    {
        try { return UnitUtils.ConvertFromInternalUnits(raw, UnitTypeId.Pascals); }
        catch { return raw; }
    }
    if (valueKind == "equivalent_length_m")
    {
        try { return UnitUtils.ConvertFromInternalUnits(raw, UnitTypeId.Meters); }
        catch { return raw; }
    }
    return raw;
}

bool TryNumericString(string text, out double value)
{
    value = 0.0;
    if (string.IsNullOrWhiteSpace(text)) return false;
    return double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value);
}

string ValueKindFor(string lowerName)
{
    bool coefficientLike = lowerName.Contains("coefficient") || lowerName.Contains("k factor") || lowerName.Contains("k-factor") || lowerName.Contains("kcoef") || lowerName == "k";
    bool equivalentLengthLike = lowerName.Contains("equivalent length") || lowerName.Contains("equiv length") || lowerName.Contains("eq length");
    bool methodLike = lowerName.Contains("method");
    bool pressureLike = lowerName.Contains("pressure") || lowerName.Contains("drop") || lowerName.Contains("basinc");
    bool lossLike = lowerName.Contains("loss") || lowerName.Contains("kayip");
    bool resistanceLike = lowerName.Contains("resistance") || lowerName.Contains("friction");
    if (coefficientLike) return "loss_coefficient";
    if (equivalentLengthLike) return "equivalent_length_m";
    if (methodLike && lossLike) return "loss_method";
    if (pressureLike || lossLike) return "pressure_drop_pa";
    if (resistanceLike) return "resistance";
    return "";
}

void AddLossParameters(Element owner, string parameterSource, System.Collections.Generic.List<object> output)
{
    if (owner == null) return;
    foreach (Parameter parameter in owner.Parameters)
    {
        if (parameter == null || parameter.Definition == null) continue;
        string name = parameter.Definition.Name;
        if (string.IsNullOrWhiteSpace(name)) continue;
        string lower = name.ToLowerInvariant();
        string valueKind = ValueKindFor(lower);
        if (string.IsNullOrEmpty(valueKind)) continue;
        string storageType = parameter.StorageType.ToString();
        double numericValue = double.NaN;
        bool hasNumeric = false;
        try
        {
            if (parameter.StorageType == StorageType.Double)
            {
                numericValue = ConvertDoubleValue(parameter, valueKind);
                hasNumeric = true;
            }
            else if (parameter.StorageType == StorageType.Integer)
            {
                numericValue = parameter.AsInteger();
                hasNumeric = true;
            }
            else if (parameter.StorageType == StorageType.String)
            {
                double parsed;
                if (TryNumericString(parameter.AsString(), out parsed))
                {
                    numericValue = parsed;
                    hasNumeric = true;
                }
            }
        }
        catch {}
        output.Add(new {
            parameterName = name,
            parameterSource = parameterSource,
            storageType = storageType,
            valueKind = valueKind,
            numericValue = hasNumeric ? (object)numericValue : null,
            displayValue = DisplayValue(parameter)
        });
    }
}

object LocalLossSample(Element elem)
{
    string familyName = "";
    string typeName = "";
    try
    {
        FamilyInstance fi = elem as FamilyInstance;
        if (fi != null && fi.Symbol != null)
        {
            familyName = fi.Symbol.FamilyName;
            typeName = fi.Symbol.Name;
        }
        else
        {
            ElementType elementType = document.GetElement(elem.GetTypeId()) as ElementType;
            if (elementType != null) typeName = elementType.Name;
        }
    }
    catch {}
    System.Collections.Generic.List<object> lossParameters = new System.Collections.Generic.List<object>();
    AddLossParameters(elem, "instance", lossParameters);
    try
    {
        Element typeElement = document.GetElement(elem.GetTypeId());
        AddLossParameters(typeElement, "type", lossParameters);
    }
    catch {}
    return new {
        elementId = elem.Id.IntegerValue,
        uniqueId = elem.UniqueId,
        category = elem.Category != null ? elem.Category.Name : "",
        systemName = SystemNameFor(elem),
        familyName = familyName,
        typeName = typeName,
        lossParameters = lossParameters.ToArray()
    };
}

bool IsAllowedCategory(Element elem, BuiltInCategory[] categories)
{
    if (elem == null || elem.Category == null) return false;
    int categoryId = elem.Category.Id.IntegerValue;
    foreach (BuiltInCategory category in categories)
    {
        if (categoryId == (int)category) return true;
    }
    return false;
}

try
{
    int sampleLimit = ${limit};
    int[] targetElementIds = new int[] { ${targetIdList} };
    int inspected = 0;
    int skippedTargetCount = 0;
    int uninspectedTargetCount = 0;
    bool sampleLimitReached = false;
    System.Collections.Generic.List<object> samples = new System.Collections.Generic.List<object>();
    BuiltInCategory[] categories = new BuiltInCategory[] {
        ${safeCategoryList}
    };
    if (targetElementIds.Length > 0)
    {
        foreach (int elementId in targetElementIds)
        {
            Element elem = document.GetElement(new ElementId(elementId));
            inspected++;
            if (elem == null || !IsAllowedCategory(elem, categories))
            {
                skippedTargetCount++;
                continue;
            }
            samples.Add(LocalLossSample(elem));
            if (samples.Count >= sampleLimit)
            {
                sampleLimitReached = true;
                break;
            }
        }
        uninspectedTargetCount = Math.Max(0, targetElementIds.Length - inspected);
    }
    else
    {
        foreach (BuiltInCategory category in categories)
        {
            FilteredElementCollector collector = new FilteredElementCollector(document)
                .OfCategory(category)
                .WhereElementIsNotElementType();
            foreach (Element elem in collector.ToElements())
            {
                inspected++;
                samples.Add(LocalLossSample(elem));
                if (samples.Count >= sampleLimit)
                {
                    sampleLimitReached = true;
                    break;
                }
            }
            if (samples.Count >= sampleLimit) break;
        }
    }
    return new {
        success = true,
        localLossOnly = true,
        targeted = targetElementIds.Length > 0,
        requestedTargetCount = targetElementIds.Length,
        skippedTargetCount = skippedTargetCount,
        uninspectedTargetCount = uninspectedTargetCount,
        sampleLimitReached = sampleLimitReached,
        truncatedBySampleLimit = targetElementIds.Length > 0 && uninspectedTargetCount > 0,
        targetedReadComplete = targetElementIds.Length == 0 || uninspectedTargetCount == 0,
        inspectedElementCount = inspected,
        localLossSamples = samples.ToArray(),
        canCommit = false
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;
}
