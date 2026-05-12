# Platform Modernization Summary

This document summarizes the modernization branch relative to `main` for human
review. It is not a deploy instruction and does not replace the stable release
runbook.

## Branch Scope

- Branch: `feature/platform-modernization-foundation`
- Base branch: `main`
- Production deploy path: still `main` only
- Stable/NAS deploy status: not performed
- NAS stable manifest status: not changed by this branch

Implementation commits included in the branch before this summary document:

- `74e218d Modernize Revit MCP platform foundation`
- `5f01e7e Clean up platform modernization followups`
- `8ab3bb3 Remove legacy Revit project configurations`

## What Changed From Main

### TypeScript-first MCP servers

- Added canonical `src/` TypeScript source trees for both bundled MCP servers:
  `installer/runtime-mcp-server` and `installer/revit-api-docs-mcp`.
- Added `tsconfig.json`, build scripts, and local smoke tests.
- Kept generated `build/` output as the installer/runtime contract so existing
  Codex registration and package layout keep working.

### PowerShell installer and updater modules

- Split shared installer/updater behavior into `installer/lib` modules:
  hidden launcher generation, scheduled task action repair, targeted
  permissions, package layout/extraction, Revit version metadata, update policy,
  proxy normalization, Codex config registration, and reporting.
- Kept the public entry scripts and their parameters in place.
- Removed duplicated permission helper logic from entry scripts. The single
  source is now `installer/lib/RevitMcp.Permissions.psm1`.

### Revit version strategy

- Added `config/revit-versions.json` as the central Revit version matrix.
- Removed Revit 2020/2021 from installer/deploy configuration and C# solution
  configuration records.
- Revit 2022 remains the only installer payload currently enabled.
- Revit 2023/2024/2025 remain modeled for future expansion but are blocked from
  installer/deploy use until real artifacts are produced and validated.

### Build and test safety

- Added `scripts/test-installer-smoke.ps1` for non-admin local validation of
  installer/updater helper behavior.
- Added `scripts/test-all.ps1` to run PowerShell smoke tests plus both MCP
  server build/smoke suites.
- Extended smoke coverage to catch accidental return of Revit 2020/2021 C#
  build configurations.
- Updated `scripts/build-revit-plugin.ps1` to use the central Revit version
  matrix while preserving the Revit 2022 build path.

### Documentation and decisions

- Added `docs/PLATFORM_ARCHITECTURE.md` for the new platform structure.
- Updated `docs/DEVELOPER_RUNBOOK.md` and `installer/nas/README.md`.
- Added `docs/ADR-0001-UPDATER-DOTNET-HELPER.md`; this branch does not add a
  .NET updater helper.
- Added an Unreleased changelog entry summarizing the modernization.

## What Did Not Change

- No merge to `main`.
- No stable deploy.
- No `publish-nas-release.ps1` execution.
- No NAS `stable.json` update.
- No change to the public installer/updater entrypoint names.
- No intentional change to existing Revit 2022 workstation install behavior.
- No Revit 2023/2024/2025 payload is enabled for installer/deploy.

## Validation Run

Commands run on this branch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

Result: passed. This covered installer/updater smoke tests, runtime MCP build
and smoke tests, Revit API docs MCP build and smoke tests, and guard tests.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

Result: passed. The plugin built with `Release R22`.

Additional source check:

```powershell
rg -n "2020|2021|R20|R21" -g "*.sln" -g "*.csproj" .
```

Result: no matches. C# solution/project files no longer expose Revit 2020/2021
build configurations.

## Remaining Risks

- The branch was validated with local non-Revit smoke tests and a Revit 2022
  source build. A live workstation install/update smoke test should still be
  performed before merging to `main`.
- The TypeScript migration keeps generated `build/` output committed. Reviewers
  should check source and generated output together when MCP behavior changes.
- Revit 2023/2024/2025 are modeled only. Enabling them later requires producing
  and validating real installer payload artifacts first.
- Stable deploy must remain a separate, explicit operation after merge review.

## Manual Review Checklist

- Confirm the branch diff does not touch NAS stable channel data.
- Confirm `publish-nas-release.ps1` was not run as part of this branch work.
- Review public entrypoints for parameter compatibility:
  `installer/install-self-contained.ps1`,
  `installer/nas/install-updater-task.ps1`,
  `installer/nas/update-from-nas.ps1`,
  `installer/nas/Install-Revit-MCP-Updater-GUI.ps1`, and
  `installer/nas/Revit MCP Updater STABLE.cmd`.
- Review `installer/lib/RevitMcp.Permissions.psm1` as the single permission
  helper source.
- Confirm `config/revit-versions.json` keeps only Revit 2022 payload available.
- Run a local Revit 2022 install/update smoke test on a non-production
  workstation before merge.
- Merge to `main` only after review; perform stable deploy as a separate
  deliberate step using the runbook.
