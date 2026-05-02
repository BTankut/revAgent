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
version: 0.3.0
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

1. Resolve the exact symbol with the docs server
   (`search_api` → `get_type_details` / `get_member_details`).
2. Confirm signatures, overloads, parameter and return types.
3. Write the snippet and execute it via `send_code_to_revit`.

Use `send_code_to_revit` directly (skipping step 1) only when the API
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
  CSV/Excel export safety, identity strategy, debug workflow, and the
  required `revit-api-docs` server workflow
- `references/patterns/boq-duct.cs` — duct BOQ by system + size
- `references/patterns/boq-pipe.cs` — pipe BOQ by system + diameter
- `references/patterns/pressure-loss-duct.cs` — total pressure loss per system
- `references/patterns/diffuser-count.cs` — diffuser count by system + level

---

## 8. Pre-Send Checklist

Universal rules — check every snippet against this list:

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
- [ ] `try/catch` block in place.
- [ ] Snippet ends with `return`.
- [ ] Transaction mode considered (default `auto`; manual control needs `"none"`).

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

- [ ] Resolved the symbol via `search_api` / `get_type_details` /
      `get_member_details` before writing the snippet.

**Linked model / room matching:**

- [ ] `RevitLinkInstance` resolved once, `GetLinkDocument()` validated.
- [ ] Host point converted via `linkInstance.GetTransform().Inverse.OfPoint(...)`.
- [ ] Level lock applied if the active view is a plan view.
