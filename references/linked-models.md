# Linked Models, Room Matching, Performance, Export

## Linked architectural model — room matching

In MEP models, room data usually lives in a linked architectural model
rather than in the host document.

Default workflow:

1. Find the target `RevitLinkInstance`.
2. Call `GetLinkDocument()` once and verify it is loaded.
3. Convert the host point into link coordinates with
   `linkInstance.GetTransform().Inverse.OfPoint(...)`.
4. Try `GetRoomAtPoint(...)` first.
5. If that fails, apply a nearest-room fallback.
6. If the active view is a plan view, lock the match to the active level.
7. Filter rooms by level so equipment does not jump to the wrong floor.

Important:

- In an `L05` workflow, matching to an `L06` room is usually a bug.
- Prefer XY distance on the same level for nearest-room fallback.
- Free 3D distance often produces incorrect floor-to-floor matches.

## Performance — bulk queries

Anti-patterns to avoid in large models:

- scanning every room again for each equipment instance
- resolving the same link in every loop
- resolving the same parameter names repeatedly
- rescanning every linked model for each FCU

Preferred pattern:

1. Resolve the target link once.
2. Build the target-level room list once.
3. Cache room centers, `Room_Number`, and `ATP_Room_Number`.
4. Match equipment against that cache.

## CSV / Excel export safety

- Use `;` as the delimiter for Turkish Excel compatibility.
- Keep locale-sensitive numeric columns numeric.
- Keep date-like room identifiers as text.

Usually keep these fields as text:

- `ATP_Room_Number`
- `Room_Number`
- `Mark`
- unique identity fields

Usually keep these fields numeric:

- `Cooling_kW`
- flow
- pressure
- area
- length

## Identity and round-trip keys

`Mark` is not always unique. For exports that may be edited later, include:

- `Mark`
- `ElementId`
- `Unique_Mark = Mark_ElementId`

## Debug workflow

For extraction and room-matching tasks:

1. Verify the active view.
2. Verify the selected element.
3. Check whether the target parameter is instance or type.
4. Verify that the link is loaded.
5. Verify point extraction.
6. Inspect the direct `GetRoomAtPoint(...)` result.
7. Verify level lock behavior.
8. Test nearest-room fallback on one element.
9. Validate on a small sample.
10. Run the full export only after the sample is correct.

## Required `revit-api-docs` server workflow

The `revit-api-docs` MCP server is a hard dependency of this skill, not
an optional fallback. It indexes the locally installed Revit API DLLs
and matching XML doc files and exposes them as the authoritative source
for class/member signatures.

If the docs server is not connected, stop and surface the missing
dependency instead of guessing API names.

Use the docs server for:

- exact class discovery
- method overload lookup
- property/event verification
- namespace exploration
- parameter and return type confirmation
- XML summary or remarks lookup

Tool order:

1. `search_api` — broad discovery
2. `get_type_details` — when the target type is known
3. `get_member_details` — verify an exact method, property, field,
   constructor, or event
4. `list_namespace` — explore an API area

Default workflow for any non-trivial task:

1. Determine the active Revit version before docs lookup. Prefer
   `get_current_view_info` if it exposes the version; otherwise run a
   read-only `send_code_to_revit` snippet that returns
   `document.Application.VersionNumber`.
2. Resolve the exact API symbol with `search_api` /
   `get_type_details` / `get_member_details`, passing that version as
   `revit_version`.
3. Confirm signatures, parameters, return types, and XML summary.
4. Write the Revit snippet and run it via `send_code_to_revit`.

Skip docs lookup only when the API surface is already trivially known —
e.g. the bundled patterns under `references/patterns/` or anything
explicitly enumerated in `SKILL.md` (collectors, units, parameter
names).

Version probe snippet:

```csharp
try
{
    return document.Application.VersionNumber;
}
catch (Exception ex)
{
    return "ERROR: " + ex.ToString();
}
```
