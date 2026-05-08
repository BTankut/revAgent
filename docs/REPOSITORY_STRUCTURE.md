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
|   `-- REPOSITORY_STRUCTURE.md
|-- references/
|-- scripts/
|   `-- build-revit-plugin.ps1
|-- src/
|   `-- revit-plugin/
|       |-- README.md
|       |-- revit-mcp-plugin.sln
|       |-- revit-mcp-plugin/
|       `-- SampleCommandSet/
`-- kurulum/
    |-- KURULUM.md
    |-- install-self-contained.ps1
    |-- deploy/
    |-- mcp-server/
    |-- revit-api-docs-mcp/
    |-- Custom_DLL/
    `-- revit-plugin/
```

## Source vs Install Payload

`src/revit-plugin` is source code. It is where Revit add-in development happens.

`kurulum/revit-plugin` is install payload. Production installers copy from this
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

## Deployment

NAS releases are still produced with:

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\deploy\publish-nas-release.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy" `
  -Channel stable
```

The generated release ZIP remains self-contained for office workstations.
