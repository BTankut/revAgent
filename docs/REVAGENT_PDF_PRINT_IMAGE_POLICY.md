# revAgent PDF, print, and image workflow policy

This policy closes the `pdf_print_settings_policy` and
`view_image_asset_workflow` usage signals from the 2026-06-29 to 2026-07-05
evidence window. It does not implement PDF, print, or image-asset mutation
tools.

## Decision

revAgent must keep these workflows separate:

1. Evidence image export.
2. PDF/print output and print setting control.
3. Placed image asset mutation on sheets or views.

The current product surface supports evidence image export through existing
export tools. It does not support Revit `PrintManager` mutation, office PDF
driver orchestration, or sheet/view image asset placement, reload, crop,
resize, or replacement.

## Evidence Image Export

Supported intent:

- export a Revit view, sheet, schedule, visible region, or coordination QA image
  as PNG/JPEG/TIFF/BMP/TARGA evidence
- use existing `export_revit_view_image` and
  `export_revit_coordination_image`
- keep schedule/sheet evidence image export separate from schedule visual
  formatting writes

Policy:

- Evidence image export is not a PDF substitute when the user asks for official
  print output, print color policy, or office PDF deliverables.
- Evidence image export must not mutate print settings.
- View/image export tools should report output paths, pixel dimensions, and
  warnings, but should not save the Revit model.

## PDF And Print

Current decision: PDF/print output is not part of the current core runtime
surface. It may become an office-profile add-on only after the office print
policy is explicit.

A future PDF/print workflow must be separately named and must not be hidden
inside image export, schedule formatting, or model cleanup tools.

Minimum future input contract:

```json
{
  "mode": "dryRun",
  "confirmPrint": false,
  "scope": {
    "sheetIds": [456],
    "viewIds": []
  },
  "output": {
    "folderPath": "C:/Exports",
    "fileNamePattern": "{sheetNumber}-{sheetName}.pdf"
  },
  "printProfile": {
    "profileName": "Office PDF blackline",
    "colorMode": "blackline",
    "paperSize": "A1",
    "driverName": "approved office PDF driver"
  }
}
```

Minimum future result contract:

```json
{
  "success": true,
  "guarded": false,
  "state": "completed",
  "action": "export_revit_pdf",
  "mode": "dryRun",
  "committed": false,
  "outputFiles": [],
  "printSettingsChanged": false,
  "printSettingsRestored": true,
  "warnings": []
}
```

Guarded cases:

- no exact sheet/view scope
- missing approved office PDF driver/profile
- request to change global print defaults without a temporary-and-restore plan
- mixed color/blackline policy without a named profile
- output path outside approved writable folders
- request to save the model as part of PDF export
- broad project-wide print/export without an explicit sheet set contract

## Placed Image Asset Mutation

Current decision: placed image asset mutation is not part of the current core
runtime surface. It is a model write and requires a separate contract from PDF,
print, and evidence export.

Examples that belong here:

- place an image on a sheet
- reload or replace an image type
- crop, resize, move, or align a placed raster image
- change image type/source used by title blocks, legends, or report sheets

Minimum future input contract:

```json
{
  "mode": "dryRun",
  "confirmCommit": false,
  "scope": {
    "sheetId": 456,
    "viewId": null,
    "imageInstanceId": 789
  },
  "operation": {
    "type": "replace_image_source",
    "imagePath": "C:/Exports/new-image.png",
    "placementPointMm": [100, 50],
    "widthMm": 120,
    "heightMm": 80
  },
  "verification": {
    "exportEvidenceImage": true
  }
}
```

Required guards:

- exact sheet/view and image instance or exact new placement target
- image path exists and extension is approved
- file size and pixel dimensions are within office limits
- no silent replacement of all instances of an image type
- dry-run preview of affected instances before commit
- post-commit visual evidence export when requested
- no model save

## Non-Goals

- no Revit `PrintManager` mutation in existing image export tools
- no PDF output hidden behind `export_revit_view_image`
- no placed-image mutation hidden behind coordination/evidence export
- no schedule visual formatting in PDF/image policy
- no model save after export, print, or image placement
- no broad sheet/image scan without an explicit scope contract

## Analyst Guidance

Usage-intelligence reports should not treat high-resolution image export,
PDF/print output, and placed image asset mutation as one backlog item. They
have different safety profiles, Revit API surfaces, office dependencies, and
verification needs. Classify evidence image requests as export workflow
tuning when existing export tools nearly cover the need; keep PDF/print and
image asset mutation as policy/design signals until a separate contract is
approved.
