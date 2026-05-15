# Revit Image Export Tools

This repo includes two runtime MCP tools for visual QA from live Revit models.
Both tools use the Revit API image export path and follow the normal Revit MCP
status preflight and single-command rule.

## Tools

- `export_revit_view_image`
  - Purpose: export the active view or a selected view as evidence.
  - Revit write action: none.
  - Best for: raw screenshots, active plan evidence, exported visible region,
    high-resolution PNG/JPEG/TIFF/BMP/TARGA output.

- `export_revit_coordination_image`
  - Purpose: create or reuse a dedicated visual QA 3D view, optionally focus a
    section box around selected elements, apply high-contrast overrides, and
    export the result.
  - Revit write action: review view settings only.
  - Best for: dense MEP coordination review where the model view is too noisy
    for an LLM to inspect reliably.

Neither tool creates ducts, pipes, fittings, terminals, sprinklers, or other
physical MEP model elements.

## Recommended Use

For quick evidence from the current plan:

```json
{
  "range": "current_view",
  "format": "png",
  "pixelSize": 2400,
  "dpi": "150"
}
```

For the visible area of the current UI view:

```json
{
  "range": "visible_region",
  "format": "png",
  "zoom": 100,
  "dpi": "150"
}
```

For a selected view without changing the active UI tab:

```json
{
  "viewName": "Level 1 HVAC Plan",
  "range": "set_of_views",
  "format": "png",
  "pixelSize": 2400
}
```

For coordination review around known element ids:

```json
{
  "intent": "coordination_overlay",
  "elementIds": [12345, 67890],
  "viewName": "DPE Visual QA - Coordination Export",
  "marginMm": 2000,
  "contextTransparency": 65,
  "format": "png",
  "pixelSize": 2400
}
```

## Format Notes

The smoke-tested export matrix covers:

- Export ranges: `current_view`, `visible_region`, `set_of_views`
- Fit directions: `horizontal`, `vertical`
- Pixel sizes: 1600 and 2400
- DPI: 150 and 300
- Formats: PNG, JPEG lossless, JPEG medium, TIFF, BMP, TARGA

PNG is the default because it keeps linework sharp and file sizes reasonable.
Use JPEG only when smaller files matter more than exact line fidelity. BMP and
TARGA are available because Revit supports them, but they are much larger and
are not the preferred coordination format.

## Dense MEP Coordination Guidance

When a view contains ducts, pipes, cable tray, sprinklers, equipment, and
architectural backgrounds at the same time, prefer the coordination tool:

1. Inspect or select the elements that matter.
2. Use `export_revit_coordination_image` with those element ids.
3. Review the generated 3D QA view and exported image.
4. If the image is still noisy, reduce the element scope or create a more
   focused view before exporting.

Element scope matters. If the selected ducts or pipes are long and spread
across the model, their combined bounding box will intentionally create a large
review region. For tight coordination evidence, pass only the local elements
around the issue being reviewed.

For production review, keep the generated image path in the task notes or PR
comment so reviewers can reproduce the visual evidence.
