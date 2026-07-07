# revAgent model-save policy

This policy closes the `model_save_policy` usage signal from the 2026-06-29 to
2026-07-05 evidence window. It does not implement a save tool.

## Decision

revAgent must not save a Revit model implicitly as part of any normal read,
write, export, schedule, image, or cleanup workflow.

revAgent should not expose a native model-save tool in the current product
surface. The usage evidence shows that users and Codex reached for
`Document.Save()` after table/schedule edits, but a model save is a model-wide
office workflow action, not a local cleanup step. It can affect worksharing,
cloud models, detached models, read-only files, local/central ownership, and
human coordination expectations.

For now, the approved behavior is:

- write tools may report that the model may need normal Revit save handling
- assistant guidance may tell the operator to save manually in Revit when that
  is the appropriate office workflow
- `send_code_to_revit` snippets that call `Document.Save()` remain policy-gap
  evidence and should not be treated as missing native tool proof
- no existing write workflow may append an automatic save step

## Future Tool Gate

If revAgent later exposes a save tool, it must be a separately named explicit
workflow, not an option on unrelated write tools.

Minimum input contract:

```json
{
  "mode": "dryRun",
  "confirmSave": false,
  "expectedDocumentTitle": "Project.rvt",
  "expectedDocumentPath": "C:/Projects/Project.rvt",
  "policy": {
    "allowWorksharedLocalSave": false,
    "allowCloudModelSave": false,
    "allowDetachedModelSave": false,
    "allowFamilyDocumentSave": false
  }
}
```

Minimum result contract:

```json
{
  "success": true,
  "guarded": false,
  "state": "completed",
  "action": "save_revit_document",
  "mode": "dryRun",
  "committed": false,
  "document": {
    "title": "Project.rvt",
    "path": "C:/Projects/Project.rvt",
    "isModified": true,
    "isWorkshared": false,
    "isCloudModel": false,
    "isDetached": false,
    "isReadOnly": false,
    "isFamilyDocument": false
  },
  "warnings": []
}
```

The first implementation, if approved later, must default to `dryRun`, require
`confirmSave=true` for commit, verify document identity before saving, and
return whether a save was actually committed.

## Guarded Cases

A future save tool must block, not warn-and-continue, for these cases until a
specific policy is written:

- unsaved documents that would require `SaveAs`
- cloud/ACC/BIM 360 models
- detached models
- central model or sync-with-central behavior
- workshared local files unless office policy explicitly permits local save
- read-only files or missing write permission
- family documents unless separately approved
- active Revit transactions or active MCP tasks
- document title/path mismatch against caller expectations

## Non-Goals

- no `SaveAs`
- no sync with central
- no compact, audit, relinquish, or reload latest behavior
- no save bundled into schedule visual structure, schedule-cell writes,
  parameter writes, image export, PDF/print, cleanup, or review-view workflows
- no background save launched without the operator understanding the model-wide
  side effect

## Analyst Guidance

Usage-intelligence reports should keep `model_save_policy` as a policy signal.
Repeated save snippets may justify training or a future explicit-save design
review, but they do not authorize raw `Document.Save()` generation and do not
make save behavior part of another tool's acceptance criteria.
