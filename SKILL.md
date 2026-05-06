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
version: 0.5.0
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

**Runtime server (`revit-mcp`)** — write-plan platform, dynamic execution, and read-only context:

- `send_code_to_revit` — expert raw dynamic execution fallback for explicit,
  broad control
- `send_code_to_revit_safe` — read/preview execution with write-looking code
  rejection, JSON result parsing, output trimming, and forced
  `transactionMode: "none"`
- `get_revit_mcp_status` — read the Revit MCP command gate/status and local
  command registry/manifest diagnostics without queueing behind normal model
  commands
- `get_revit_session_context` — first-call context for version/build/culture,
  document state, active view, selection, MEP counts, and link counts
- `get_active_view_context` — model-view vs sheet-view context; sheets return
  placed viewports instead of direct model-category assumptions
- `inspect_elements` — targeted/selection element inspection: class,
  category, type, level, key parameters, connector counts
- `inspect_parameter_schema` — parameter schema for element ids or category
  samples: BIP, storage type, unit, shared/read-only, raw/display values.
  Use `parameterNameMatchMode: "contains"` for broad discovery and
  `parameterNameMatchMode: "exact"` for write-preflight.
- `analyze_mep_system` — read-only MEP analysis foundation with assumptions,
  missing office standards, proposal readiness, optional targeted connector
  pathfinding (`networkRootElementId` / `networkTerminalElementIds`), and
  deterministic report/BOQ rows. Use `boqOnly: true` for short live count and
  length report population without connector graph traversal. Use
  `hydraulicResistanceOnly: true` for short live hydronic pipe length/diameter
  sampling and resistance report rows. Use `localLossOnly: true` for short
  live HVAC/hydronic fitting, accessory, terminal, and equipment local-loss
  parameter extraction, local-loss report rows, local-loss pressure summaries,
  and explicit local-loss contribution to fan pressure / pump head basis. Use
  `localLossElementIds` when a pathfinding/critical-path step has already
  identified the exact fitting/accessory/equipment ids to audit. Optional
  `placementRequests` for devices such as air terminals, dampers, valves,
  pumps, fire cabinets, or equipment produce proposal-only
  `place_family_instance` write-plan steps; preview/approval/verify is still
  required before any placement commit. Optional
  `domesticWaterPipeSizingRequests`, `sanitaryStormPipeSizingRequests`, and
  `firePipeSizingRequests` produce proposal-only `resize_pipe` handoff steps
  when exact pipe identity, demand basis, and office standards are supplied;
  fire protection resize proposals remain critical-risk and require
  fire-engineer review before any commit. Clash analysis separates horizontal
  main/branch distribution blockers from small vertical drops and equipment
  connection details, so a model can report main distribution coordination
  separately from local offset/fitting work.
- `prepare_write_plan` — create/validate typed JSON plans; never writes
- `preview_write_plan` — native or runtime-only preview; never writes
- `commit_write_plan` — native deterministic commit; requires explicit
  approval or a commit token. Report export plans write CSV/JSON files through
  the runtime and do not mutate the Revit model.
- `verify_write_plan` — read model state back after a commit/proposal
- `get_workflow_state` — inspect local `planId`/`stepId`/`eId` mappings
- `clear_workflow_state` — clear local workflow state by plan or all state

**API docs server (`revit-api-docs`)** — required companion:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

For field symbols such as `BuiltInParameter.RBS_START_LEVEL_PARAM`, use
`resolve_api_symbols_bulk` with `mode: "search"` and `kind: "field"`.
Do not use `mode: "field"`; valid modes are `search`, `type`, `member`,
and `namespace`.

The two servers are designed to work together: `revit-api-docs`
resolves the exact API surface against the locally installed Revit DLLs
and XML, then the runtime either prepares a typed write-plan or runs a
verified expert fallback snippet. Treat the
docs server as a hard dependency, not an optional add-on. If it is not
connected, surface that as a setup problem before writing code that
guesses API names.

Default workflow for any non-trivial task:

1. Do not intentionally run multiple Revit MCP model commands in parallel.
   The runtime and add-in gate overlapping commands, but sequential calls keep
   Revit responsive. If a command appears stuck, call `get_revit_mcp_status`.
   If `pluginDiagnostics.ok` is false, treat it as an installation/package
   issue before sending model commands.
2. Call `get_revit_session_context` first to learn Revit version/build,
   culture, active view type, document state, selection, MEP counts, and links.
3. If the active view is a sheet or the task depends on view visibility, call
   `get_active_view_context` before making view-level assumptions.
4. Resolve API symbols with `resolve_api_symbols_bulk` and pass the active
   `revit_version`. Use the single-symbol docs tools only for follow-up detail.
5. Before writes or localized/shared parameter work, call
   `inspect_parameter_schema` with `parameterNameMatchMode: "exact"`; for
   element-specific tasks call `inspect_elements`.
6. For model-changing work, generate a typed write-plan with
   `prepare_write_plan`, run `preview_write_plan`, get explicit user commit
   approval, then call `commit_write_plan` and `verify_write_plan`.
7. Use `send_code_to_revit_safe` for read-only probes and expert previews. It
   rejects `transactionMode: "auto"` and always executes with
   `transactionMode: "none"`. Use raw `send_code_to_revit` only as an expert
   fallback when the user explicitly asks for broad dynamic execution or the
   typed write-plan path cannot express the task.

Connector stitching safety: do not commit blind duct/pipe endpoint batches
through raw dynamic code. Live Revit 2022 testing showed invalid same-direction
or otherwise unsuitable pairs can timeout during commit finalization even when
nearby rollback probes pass. Endpoint stitching should be represented as
`connect_ducts` or `connect_pipes` write-plan preview data with exactly one
pair per risky commit, rollback preview evidence, heartbeat, timeout recovery,
and post-commit audit. If raw expert fallback is explicitly used, first filter
to same-system/same-size/opposite endpoint pairs or verified fitting candidates,
skip known timeout pairs, and save/audit after small batches.

Overlapping pipe-header normalization is not endpoint stitching. Live Revit
2022 testing on same-direction overlapping pipe residuals showed
`PlumbingUtils.BreakCurve` can split a header in rollback, but
`Document.Create.NewTeeFitting` rejects a branch connector whose owner is a
pipe fitting (`The owner should be (flex) duct or pipe`). Use the native
`normalize_pipe_header_overlap` write-plan command for these cases, one pair
per preview/commit. The native normalizer supports direct fitting-to-branch
pipe tees, short pipe-offset branches, and orphan open fitting cleanup; it
projects a real pipe-owned branch connector to the header centerline, adjusts
only collinear branch endpoints, deletes the obsolete overlap/fitting/offset
geometry, runs `PlumbingUtils.BreakCurve`, creates the tee, and rolls back the
single transaction on failure. Do not use broad raw dynamic commits for these
pairs; audit device connectivity, pipe/duct clashes, ceiling crossings, and
remaining overlap pairs after each batch.

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
- For level-based MEP family placement with
  `NewFamilyInstance(XYZ, symbol, level, ...)`, live Revit 2022 testing showed
  the placement Z behaves as a level-relative offset for the tested air terminal
  and sprinkler symbols. Pass the intended offset above the supplied level, not
  absolute project elevation. `Duct.Create` and `Pipe.Create` endpoints remain
  absolute model coordinates.

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

- [ ] `get_revit_session_context` called first and active Revit version
      passed as `revit_version` to docs server calls.
- [ ] Resolved symbols via `resolve_api_symbols_bulk` before writing the
      snippet; single-symbol docs tools used only for follow-up detail.

**Production write or localized/shared parameter work:**

- [ ] Model-changing requests represented as typed write-plans first:
      `prepare_write_plan` -> `preview_write_plan` -> explicit approval ->
      `commit_write_plan` -> `verify_write_plan`.
- [ ] `inspect_parameter_schema` run before generating any write snippet.
- [ ] Any write targeting localized, shared, or user-visible parameters first
      uses `parameterNameMatchMode: "exact"` or explicitly selects exactly one
      returned parameter by `name` + `source` + `builtInParameter` +
      `storageType`.
- [ ] `send_code_to_revit_safe` used for read-only probes and previews; it must
      not be used with `transactionMode: "auto"`.
- [ ] Raw `send_code_to_revit` write used only as an expert fallback after
      explicit user commit instruction and when the typed write-plan operation
      catalog cannot express the change.
- [ ] Fire/sprinkler/hydraulic results state assumptions, missing standards,
      method, source data, and risk level; unresolved standards block commit.
- [ ] Clash/reroute work never auto-commits; it must preview and verify no new
      clash was introduced.

**Active view / sheet-sensitive work:**

- [ ] `get_active_view_context` called before assuming visible model elements
      when the active view may be a sheet.

**Linked model / room matching:**

- [ ] `RevitLinkInstance` resolved once, `GetLinkDocument()` validated.
- [ ] Host point converted via `linkInstance.GetTransform().Inverse.OfPoint(...)`.
- [ ] Level lock applied if the active view is a plan view.
