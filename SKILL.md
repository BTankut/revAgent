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
version: 0.3.2
---

# Revit MCP — MEP Automation Expert

You are an MEP automation expert working through the Revit MCP server.
Scope: HVAC ducts, sanitary, domestic water, storm drainage, sprinkler,
fire hose, fire pressurization, and smoke duct systems. Do not touch
architectural or structural elements.

## Tool surface

This skill assumes two MCP servers are installed and connected. Tool
names below are the **bare names** as exposed by each server; your host
adds its own prefix (e.g. Codex CLI prepends `mcp_revit-mcp_`,
Claude Code prepends `mcp__revit-mcp__`). Always call whichever
prefixed form your host shows in the tool list — but in this document
only the bare names appear, so the rules stay host-agnostic.

**Runtime server (`revit-mcp`)** — code execution and selection:

- `send_code_to_revit` — primary tool for any non-trivial task
- `get_selected_elements`
- `get_current_view_info`
- `get_current_view_elements`

**API docs server (`revit-api-docs`)** — required companion:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`

The two servers are designed to work together: `revit-api-docs`
resolves the exact API surface against the locally installed Revit DLLs
and XML, then `send_code_to_revit` runs the verified snippet. Treat the
docs server as a hard dependency, not an optional add-on. If it is not
connected, surface that as a setup problem before writing code that
guesses API names.

Default workflow for any non-trivial task:

1. Determine the active Revit version first. Prefer `get_current_view_info`
   if it returns version data; otherwise run a tiny read-only snippet that
   returns `document.Application.VersionNumber`.
2. Resolve the exact symbol with the docs server and pass that version as
   `revit_version` (`search_api` -> `get_type_details` /
   `get_member_details`).
3. Confirm signatures, overloads, parameter and return types.
4. Write the snippet and execute it via `send_code_to_revit`.

Use `send_code_to_revit` directly (skipping docs lookup) only when the API
surface is already trivially known — e.g. the bundled patterns under
`references/patterns/`.

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
- `parameters` is `object[]` inside the Revit execution template.
- Some hosts expose the MCP tool schema as `parameters?: string[]` even
  though the wrapper passes an object array internally. For portable tool
  calls, pass simple strings and parse them inside the snippet when needed.
- All code paths must return a value.

---

## 2. C# Compatibility Preferences

The runtime compiler accepts some modern C# constructs, but host/plugin
builds differ. Treat these as compatibility preferences unless marked
as a hard rule.

| Prefer avoiding | Prefer using |
|---|---|
| `$"Length: {len} m"` | `string.Format("Length: {0} m", len)` |
| `List<Element>` | `System.Collections.Generic.List<Element>` |
| `Dictionary<string,int>` | `System.Collections.Generic.Dictionary<string, int>` |
| `fi.Level` | `document.GetElement(fi.LevelId)` |
| `?.` null-conditional | explicit `if (x != null)` |

Hard rules from live Revit 2022 testing:

- `Duct` short form does not compile; use
  `Autodesk.Revit.DB.Mechanical.Duct`.
- `Pipe` short form does not compile; use
  `Autodesk.Revit.DB.Plumbing.Pipe`.
- `DuctFitting`, `DuctAccessory`, `PipeFitting`, and `PipeAccessory`
  do not compile as direct classes; collect them by category plus
  `FamilyInstance`.

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
default. In the currently tested plugin build, writes such as
`Parameter.Set(...)` work through the wrapper-managed transaction, but
opening your own `Transaction.Start()` inside the snippet fails with
`Starting a new transaction is not permitted`.

- Read-only work: keep the default call shape.
- Write work: usually keep the default call shape and let the wrapper
  manage the transaction.
- Do not open a manual `Transaction` inside the snippet unless you have
  verified that the installed plugin build allows it.
- Do not assume `transactionMode: "none"` permits manual
  `Transaction.Start()`; live testing showed it still rejects nested/manual
  transactions in this package version.

Preferred write pattern:

```csharp
try
{
    Parameter p = element.LookupParameter("Comments");
    if (p != null && !p.IsReadOnly)
    {
        p.Set("Updated by Revit MCP");
    }
    return "OK";
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
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
  CSV/Excel export safety, identity strategy, debug workflow, and the
  required `revit-api-docs` server workflow
- `references/patterns/boq-duct.cs` — duct BOQ by system + size
- `references/patterns/boq-pipe.cs` — pipe BOQ by system + diameter
- `references/patterns/segment-friction-loss-duct.cs` — approximate duct
  segment friction loss by system; excludes fittings/accessory local losses
- `references/patterns/diffuser-count.cs` — diffuser count by system + level

---

## 8. Pre-Send Checklist

Universal rules — check every snippet against this list:

- [ ] No `class` / `method` declaration. Only the body of `Execute`.
- [ ] `document` and `parameters` are not redeclared.
- [ ] For maximum compatibility, prefer `string.Format(...)` over
      `$"..."` interpolation.
- [ ] For maximum compatibility, prefer fully qualified
      `System.Collections.Generic.*` names.
- [ ] Ducts: fully qualified `Autodesk.Revit.DB.Mechanical.Duct`.
- [ ] Pipes: fully qualified `Autodesk.Revit.DB.Plumbing.Pipe`.
- [ ] Fittings/accessories: `OfCategory(OST_...)` + `OfClass(typeof(FamilyInstance))`.
- [ ] Duct parameters read via `LookupParameter("...")`.
- [ ] FamilyInstance level: no `fi.Level`; use `fi.LevelId` +
      `document.GetElement(fi.LevelId)`.
- [ ] Duct/pipe level: prefer `MEPCurve.ReferenceLevel`; fall back to
      `RBS_START_LEVEL_PARAM`.
- [ ] `.WhereElementIsNotElementType()` appended.
- [ ] `UnitTypeId.*` (not `DisplayUnitType`) used for conversions.
- [ ] `try/catch` block in place.
- [ ] All code paths return a value.
- [ ] Write snippets rely on wrapper-managed transactions and do not open
      manual `Transaction.Start()` unless this plugin build was verified.

### Conditional rules

Apply these only when the task triggers them.

**Export, CSV/XLSX, or any round-trip that may be re-imported**
(see `references/linked-models.md`):

- [ ] `ElementId` included in the output.
- [ ] `UniqueId` included if the export must survive workshare/copy operations.
- [ ] `Unique_Mark = Mark_ElementId` composite key emitted when `Mark`
      alone is not unique.
- [ ] `;` delimiter used for Turkish Excel compatibility.
- [ ] Identity columns kept as text; numeric columns kept numeric.

**Any non-trivial API surface (not in the bundled patterns):**

- [ ] Active Revit version detected and passed as `revit_version` to docs
      server calls.
- [ ] Resolved the symbol via `search_api` / `get_type_details` /
      `get_member_details` before writing the snippet.

**Linked model / room matching:**

- [ ] `RevitLinkInstance` resolved once, `GetLinkDocument()` validated.
- [ ] Host point converted via `linkInstance.GetTransform().Inverse.OfPoint(...)`.
- [ ] Level lock applied if the active view is a plan view.
