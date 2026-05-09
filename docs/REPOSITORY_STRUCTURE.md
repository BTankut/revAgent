# Repository Structure

This repository is the single canonical source for the Revit MCP workstation
package.

## Main Areas

```text
.
|-- SKILL.md
|-- AGENTS.md
|-- CHANGELOG.md
|-- README.md
|-- docs/
|   |-- DEVELOPER_RUNBOOK.md
|   |-- REPOSITORY_STRUCTURE.md
|   `-- MONOREPO_MIGRATION.md
|-- references/
|-- scripts/
|   `-- build-revit-plugin.ps1
|-- src/
|   `-- revit-plugin/
|       |-- README.md
|       |-- revit-mcp-plugin.sln
|       |-- revit-mcp-plugin/
|       `-- SampleCommandSet/
`-- installer/
    |-- INSTALLATION.md
    |-- install-self-contained.ps1
    |-- nas/
    |-- runtime-mcp-server/
    |-- revit-api-docs-mcp/
    |-- command-payload/
    `-- revit-plugin/
```

## Source vs Install Payload

`src/revit-plugin` is source code. It is where Revit add-in development happens.

`installer/revit-plugin` is install payload. Production installers copy from this
folder into `C:\ProgramData\DPE\RevitMCP`. Do not edit the binary payload by
hand. Build the source and refresh the payload binaries with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Then commit both the source change and the refreshed payload binaries.

## Release Rule

Development and production release both happen from `main` only.

Feature/experiment branches that exist on GitHub are historical and should not
be used for office deployment. NAS deployment reads only packages published from
this repository's `main` branch.

For the full developer and code-assistant workflow, including clone recovery,
local testing, commit/push, NAS beta publishing, stable promotion, updater
diagnostics, and Revit-close policy, read `docs/DEVELOPER_RUNBOOK.md`.

## Deployment

NAS releases are still produced with:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\nas\publish-nas-release.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy" `
  -Channel stable
```

The generated release ZIP remains self-contained for office workstations. During
packaging, `publish-nas-release.ps1` also adds a legacy `kurulum/` alias inside
the ZIP so older workstation updaters can install the renamed layout safely.
