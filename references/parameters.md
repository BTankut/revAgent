# Parameter Lookup

## Ducts — use `LookupParameter`

Most duct `BuiltInParameter` values are unreliable inside the dynamic
compiler. Default to `LookupParameter(name)` for ordinary duct
parameters, but do not rely on `LookupParameter("Level")` for duct level
resolution.

Common duct parameter names:

- `Diameter`
- `Width`
- `Height`
- `Length`
- `Flow`
- `Velocity`
- `Friction`
- `Pressure Drop`
- `Insulation Thickness`
- `System Type`
- `System Classification`
- `System Name`
- `Size`
- `Area`

## Duct and pipe level resolution

For `Duct` and `Pipe`, live testing showed:

- `LookupParameter("Level")` can be `null`.
- `LevelId` can be `ElementId.InvalidElementId`.
- `ReferenceLevel.Name` can return the correct level.
- `BuiltInParameter.RBS_START_LEVEL_PARAM` can also resolve the level.

Use this order for duct/pipe level names:

1. `mepCurve.ReferenceLevel`
2. `RBS_START_LEVEL_PARAM` as an `ElementId`
3. `RBS_START_LEVEL_PARAM.AsValueString()`
4. `"N/A"`

```csharp
Autodesk.Revit.DB.Mechanical.Duct duct =
    elem as Autodesk.Revit.DB.Mechanical.Duct;

string levelName = "N/A";
if (duct != null)
{
    if (duct.ReferenceLevel != null)
    {
        levelName = duct.ReferenceLevel.Name;
    }
    else
    {
        Parameter levelP = duct.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
        if (levelP != null && levelP.HasValue)
        {
            Element levelElem = document.GetElement(levelP.AsElementId());
            levelName = (levelElem != null) ? levelElem.Name : levelP.AsValueString();
        }
    }
}
```

For pipes, use the same pattern with
`Autodesk.Revit.DB.Plumbing.Pipe pipe`.

## Pipes — prefer `BuiltInParameter`

These pipe BIPs are typically reliable in the dynamic compiler:

- `RBS_PIPE_OUTER_DIAMETER`
- `RBS_PIPE_INNER_DIAM_PARAM`
- `RBS_PIPE_DIAMETER_PARAM`
- `RBS_PIPE_FLOW_PARAM`
- `RBS_VELOCITY`
- `RBS_FRICTION`
- `RBS_SYSTEM_NAME_PARAM`
- `CURVE_ELEM_LENGTH`
- `RBS_PRESSURE_DROP`
- `RBS_REFERENCE_INSULATION_THICKNESS`

Pipe BIPs that fail to compile — fall back to `LookupParameter(...)`:

- `RBS_PIPE_SLOPE_PARAM` -> `LookupParameter("Slope")`
- `RBS_SYSTEM_TYPE_PARAM` -> `LookupParameter("System Type")`

## FamilyInstance — Level resolution

```csharp
Parameter p = fi.LookupParameter("System Type");
if (p != null && p.HasValue)
{
    string val = p.AsValueString();
}

ElementId lvlId = fi.LevelId;
string levelName =
    (lvlId != null && lvlId != ElementId.InvalidElementId && document.GetElement(lvlId) != null)
    ? document.GetElement(lvlId).Name
    : "N/A";
```

## Lookup Order

When reading any parameter, try in this order:

1. `LookupParameter("ExactName")`
2. common casing variants
3. instance parameter
4. type parameter via `fi.Symbol.LookupParameter(...)`
5. `AsString()`
6. `AsValueString()`
7. numeric fallback with `AsDouble()` / `AsInteger()`

Watch out for:

- `FAM_Text2`
- `fam_text2`
- shared parameters
- parameters that only appear after sync
