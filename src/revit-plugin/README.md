# Revit Plugin Source

This folder contains the Revit add-in source that used to live in the separate
`BTankut/revit-mcp-plugin` repository.

The canonical production payload is still kept under:

```text
kurulum\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll
```

Do not edit those binaries by hand. Change the source here, then refresh the
payload:

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Commit the source changes and the refreshed payload binaries in the same commit.

Historical branches in the old plugin repository are not part of the production
release flow. Work on `main` in the monorepo unless a temporary branch is
explicitly agreed first.
