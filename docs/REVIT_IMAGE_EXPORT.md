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
  - Output: each generated file reports `bytes`, `width`, and `height`. Treat
    `pixelSize` as the requested final size. By default, PNG/JPEG/BMP/TIFF
    exports are normalized after Revit export so the requested fit-direction
    dimension equals `pixelSize`. TARGA reports Revit's actual output size.

- `export_revit_coordination_image`
  - Purpose: create or reuse a dedicated visual QA 3D view, optionally focus a
    section box around selected elements, apply high-contrast overrides, and
    export the result.
  - Revit write action: review view settings only.
  - Best for: dense MEP coordination review where the model view is too noisy
    for an LLM to inspect reliably.
  - Output: each generated file reports `bytes`, `width`, and `height`. Single
    target exports use a tighter default section-box margin and recenter the 3D
    camera on the target section box. If Revit still exports a wide 3D frame,
    the tool post-crops around the green target override pixels before final
    pixel-size normalization. If Revit's exported colors do not match the
    target-pixel detector, a single-target export falls back to a model
    bounding-box-centered crop.

Neither tool creates ducts, pipes, fittings, terminals, sprinklers, or other
physical MEP model elements.

## Recommended Use

For quick evidence from the current plan:

```json
{
  "range": "current_view",
  "format": "png",
  "pixelSize": 6000,
  "dpi": "300"
}
```

For technical reading, first zoom/focus the active Revit UI view to the area of
interest, then export the visible region:

```json
{
  "range": "visible_region",
  "format": "png",
  "pixelSize": 2400,
  "fitDirection": "horizontal",
  "enforcePixelSize": true,
  "zoom": 100,
  "dpi": "300"
}
```

For a selected view without changing the active UI tab:

```json
{
  "viewName": "Level 1 HVAC Plan",
  "range": "set_of_views",
  "format": "png",
  "pixelSize": 8000,
  "dpi": "300"
}
```

For coordination review around known element ids:

```json
{
  "intent": "coordination_overlay",
  "elementIds": [12345, 67890],
  "viewName": "DPE Visual QA - Coordination Export",
  "marginMm": 2000,
  "singleElementMarginMm": 300,
  "contextTransparency": 65,
  "format": "png",
  "pixelSize": 4000,
  "enforcePixelSize": true,
  "cropToTargetHighlight": true,
  "targetMinFillRatio": 0.4,
  "highlightCropPaddingPx": 24,
  "dpi": "300"
}
```

## Format Notes

The smoke-tested export matrix covers:

- Export ranges: `current_view`, `visible_region`, `set_of_views`
- Fit directions: `horizontal`, `vertical`
- Pixel sizes: 1600 and 2400
- DPI: 150 and 300
- Formats: PNG, JPEG lossless, JPEG medium, TIFF, BMP, TARGA

PNG at 300 DPI is the default because it keeps linework sharp and file sizes
reasonable for Revit line drawings. Low-byte exports are not the default goal:
LLM review needs readable text, tags, duct sizes, dimensions, grids, and
leaders.
For `visible_region`, Revit can initially preserve the visible viewport aspect
and return dimensions larger or taller than the requested `pixelSize`. With the
default `enforcePixelSize=true`, the tool post-processes PNG/JPEG/BMP/TIFF
files so `files[].width == pixelSize` for `fitDirection="horizontal"` or
`files[].height == pixelSize` for `fitDirection="vertical"`. Verify
`files[].width`, `files[].height`, and `files[].resizedToRequestedPixelSize`
before judging whether an export is useful for technical review.
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
around the issue being reviewed. When exactly one element is supplied,
`singleElementMarginMm` caps the section-box margin independently from the
multi-element `marginMm` default. The tool also sets a deterministic 3D camera
orientation centered on the target section box and reports
`framing.cameraFramedToTargets`. Because Revit can still keep a wide 3D export
canvas, `cropToTargetHighlight=true` first tries to post-crop around the green
target override pixels. Revit can anti-alias or transform override colors in a
way that prevents exact pixel matching, so a single-target export falls back to
a model bounding-box-centered crop when no target pixels are detected. The crop
is constrained by `targetMinFillRatio` so the largest target dimension should
occupy at least the requested share of the final crop side, defaulting to 0.4.
The response reports `files[].croppedToTargetHighlight`,
`files[].highlightPixelCount`, `files[].actualHighlightFillRatio`,
`files[].cropBasis`, and `files[].highlightCrop.cropBasis`.

Do not use `export_revit_coordination_image` as the primary tool for live
Revit view navigation, selected-element zoom, or opening an element in a new
view. For that workflow, use `create_3d_view_for_elements` or
`show_element_in_plan_and_3d` first, then export the active view with
`export_revit_view_image` if an image artifact is still required.

For production review, keep the generated image path in the task notes or PR
comment so reviewers can reproduce the visual evidence.

## LLM Review Quality Guidance

Do not rely on a single low-resolution full-plan export for engineering review.
Use a small image pack instead:

1. Overview: full plan at `pixelSize` 6000-8000 and 300 DPI.
2. Detail: focus/zoom the active view to the dense system area and export
   `visible_region` at 300 DPI.
3. Coordination: use `export_revit_coordination_image` for selected local
   elements, not long system-wide element runs.
4. Tile/crop very large visible-region outputs before asking an LLM to inspect
   text. A 15000 px export can be excellent evidence, but it may be too large
   for direct display in some clients.
