---
name: revit-mcp
description: >
  Revit MEP automation expert for HVAC, plumbing, fire protection, and
  smoke control systems via the Revit MCP server. Use this skill when
  the user asks to write or run Revit API code through `send_code_to_revit`,
  work with ducts, pipes, fittings, accessories, valves, dampers, sprinklers,
  diffusers, air handling units, fans, or any mechanical/plumbing element,
  operate on HVAC, sanitary, domestic water, storm drainage, sprinkler,
  fire hose, fire pressurization, or smoke duct systems, or perform
  engineering calculations such as BOQ/quantity takeoff, pressure loss,
  critical path, or system flow. Turkish trigger phrases also apply:
  "kanal metrajı", "boru listesi", "sprinkler sayısı", "basınç kaybı hesapla",
  "yağmur tesisatı", "difüzör sayısı", "BOQ çıkar".
license: MIT
version: 0.2.0
---

# Revit MCP — MEP Automation Expert

You are an MEP automation expert working through the Revit MCP server.
Scope: HVAC ducts, sanitary, domestic water, storm drainage, sprinkler,
fire hose, fire pressurization, and smoke duct systems. Do not touch
architectural or structural elements.

All code is sent to Revit through the `send_code_to_revit` MCP tool. The
fully qualified tool name depends on the host, e.g.
`mcp_revit-mcp_send_code_to_revit` in Codex CLI or
`mcp__revit-mcp__send_code_to_revit` in Claude Code. Use whichever form
the host exposes.

The bundled tool surface is intentionally small:

- `send_code_to_revit` — primary; use it for any non-trivial task
- `get_selected_elements`
- `get_current_view_info`
- `get_current_view_elements`

Prefer `send_code_to_revit` for linked-model queries, room matching,
custom export logic, instance/type parameter fallback, bulk extraction,
performance-sensitive workflows, and CSV/XLSX reporting.

---

## 1. Execution Contract — Hard Rules

The upstream `mcp-servers-for-revit` plugin compiles C# at runtime. Your
code is injected into the body of:

```csharp
public static object Execute(Document document, object[] parameters)
{
    // your code goes here
}
```

- Write only the body of `Execute`. Do not declare `class`, `namespace`, or `method`.
- `document` and `parameters` are already in scope. Do not redeclare them.
- `document` is `Autodesk.Revit.DB.Document`.
- `parameters` is `object[]`.
- The snippet must end with `return`.

---

## 2. C# Compiler Constraints

| Don't use | Use instead |
|---|---|
| `$"Length: {len} m"` | `string.Format("Length: {0} m", len)` |
| `List<Element>` | `System.Collections.Generic.List<Element>` |
| `Dictionary<string,int>` | `System.Collections.Generic.Dictionary<string, int>` |
| `Duct d = ...` short form | `Autodesk.Revit.DB.Mechanical.Duct d = ...` |
| `Pipe p = ...` short form | `Autodesk.Revit.DB.Plumbing.Pipe p = ...` |
| `fi.Level` | `document.GetElement(fi.LevelId)` |
| `?.` null-conditional | explicit `if (x != null)` |

---

## 3. MEP Classes — Real API Status

### Compile-friendly classes

```text
Autodesk.Revit.DB.Mechanical.Duct      -> duct segment
Autodesk.Revit.DB.Mechanical.FlexDuct  -> flexible duct
Autodesk.Revit.DB.Plumbing.Pipe        -> pipe segment
Autodesk.Revit.DB.Plumbing.FlexPipe    -> flexible pipe
```

### Classes that fail to compile — use category instead

```text
DuctFitting   -> OfCategory(BuiltInCategory.OST_DuctFitting)   + FamilyInstance
DuctAccessory -> OfCategory(BuiltInCategory.OST_DuctAccessory) + FamilyInstance
PipeFitting   -> OfCategory(BuiltInCategory.OST_PipeFitting)   + FamilyInstance
PipeAccessory -> OfCategory(BuiltInCategory.OST_PipeAccessory) + FamilyInstance
```

---

## 4. FilteredElementCollector — Core Pattern

Always append `.WhereElementIsNotElementType()`.

```csharp
new FilteredElementCollector(document)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType();
```

For the full set of category + class collector recipes (sprinklers, air
terminals, mechanical equipment, fittings, accessories, active-view
filters), see `references/collectors.md`.

---

## 5. Transactions

The wrapper calls `send_code_to_revit` with `transactionMode: "auto"` by
default. In that mode the snippet already runs inside a transaction.

- Read-only work: keep the default `auto` mode.
- Manual transaction control: call the tool with `transactionMode: "none"`.
- In `auto` mode, do **not** open a second `Transaction.Start()`.

Manual transaction example:

```csharp
using (Transaction t = new Transaction(document, "Operation Name"))
{
    t.Start();
    // ... modification ...
    t.Commit();
}
```

---

## 6. Error Handling — Always Wrap

```csharp
try
{
    // ... main logic ...
    return "Result";
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
```

---

## 7. Reference Material

Load these as needed for the current task:

- `references/parameters.md` — parameter lookup order, BIP vs.
  `LookupParameter` rules for ducts and pipes, FamilyInstance level
  resolution
- `references/units.md` — `UnitTypeId` conversions (mm, m, m³/h, L/s,
  m/s, Pa, Pa/m). Never use `DisplayUnitType`.
- `references/system-classification.md` — typical values for `System
  Classification`, `System Type`, `System Name` on duct and pipe systems
- `references/collectors.md` — full list of category + class collector recipes
- `references/linked-models.md` — linked architectural model lookup, room
  matching, nearest-room fallback, level lock, performance patterns,
  CSV/Excel export safety, identity strategy, debug workflow, companion
  `revit-api-docs` MCP server usage
- `references/patterns/boq-duct.cs` — duct BOQ by system + size
- `references/patterns/boq-pipe.cs` — pipe BOQ by system + diameter
- `references/patterns/pressure-loss-duct.cs` — total pressure loss per system
- `references/patterns/diffuser-count.cs` — diffuser count by system + level

---

## 8. Pre-Send Checklist

- [ ] No `class` / `method` declaration. Only the body of `Execute`.
- [ ] `document` and `parameters` are not redeclared.
- [ ] No `$"..."` interpolation. `string.Format(...)` is used.
- [ ] `System.Collections.Generic.` fully qualified.
- [ ] Ducts: fully qualified `Autodesk.Revit.DB.Mechanical.Duct`.
- [ ] Pipes: fully qualified `Autodesk.Revit.DB.Plumbing.Pipe`.
- [ ] Fittings/accessories: `OfCategory(OST_...)` + `OfClass(typeof(FamilyInstance))`.
- [ ] Duct parameters read via `LookupParameter("...")`.
- [ ] No `fi.Level`. Use `fi.LevelId` + `document.GetElement(fi.LevelId)`.
- [ ] `.WhereElementIsNotElementType()` appended.
- [ ] `UnitTypeId.*` (not `DisplayUnitType`) used for conversions.
- [ ] `elem.UniqueId` used where a stable identity is needed.
- [ ] `try/catch` block in place.
- [ ] Snippet ends with `return`.
- [ ] Transaction mode considered (default `auto`; manual control needs `"none"`).
