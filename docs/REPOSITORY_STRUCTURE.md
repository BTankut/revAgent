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
|-- config/
|   `-- revit-versions.json
|-- docs/
|   |-- DEVELOPER_RUNBOOK.md
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- REPOSITORY_STRUCTURE.md
|   `-- MONOREPO_MIGRATION.md
|-- references/
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- test-all.ps1
|   `-- test-installer-smoke.ps1
|-- src/
|   `-- revit-plugin/
|       |-- README.md
|       |-- revit-mcp-plugin.sln
|       |-- revit-mcp-plugin/
|       |-- RevitMCPCommandSet/
|       |-- RevitMCPViewCommandSet/
`-- installer/
    |-- INSTALLATION.md
    |-- install-self-contained.ps1
    |-- lib/
    |-- nas/
    |-- runtime-mcp-server/
    |-- revit-api-docs-mcp/
    |-- command-payload/
    `-- revit-plugin/
```

## Source vs Install Payload

`src/revit-plugin` is source code. It is where Revit add-in development happens.
The main add-in host is `src/revit-plugin/revit-mcp-plugin`. UI view tools are
implemented as the separate
`src/revit-plugin/RevitMCPViewCommandSet` project so the dynamic
`send_code_to_revit` command payload stays isolated. This command set owns view
activation/close, element focus, and 3D section box behavior.

The dynamic execution and low-level context command source lives in
`src/revit-plugin/RevitMCPCommandSet`. `SampleCommandSet` is intentionally not
kept in this repository because it is not used by the installed production
payload and causes source-layout confusion.

`installer/revit-plugin` is install payload. Production installers copy from this
folder into `C:\ProgramData\DPE\RevitMCP`. Do not edit the binary payload by
hand. Build the host/view source and refresh those payload binaries with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Then commit both the source change and the refreshed payload binaries.

When `src/revit-plugin/RevitMCPCommandSet` changes, validate it explicitly:

```powershell
dotnet build .\src\revit-plugin\RevitMCPCommandSet\RevitMCPCommandSet.csproj -c "Release R22" /p:RevitMcpDeployCommandSet=false
```

The stable dynamic command payload under `installer/command-payload` is not
refreshed by default; replacing it is an explicit release task.

`installer/runtime-mcp-server/src` and `installer/revit-api-docs-mcp/src` are
the TypeScript MCP source trees. Their `build/` folders remain the runtime
payload contract consumed by installer and Codex MCP registrations.

`installer/lib` contains shared PowerShell helper modules for updater/installer
behavior. `config/revit-versions.json` is the central Revit version matrix.

## Release Rule

Production releases happen from `main` only.

Feature/experiment branches that exist on GitHub are historical and should not
be used for office deployment. NAS deployment reads only packages published from
this repository's `main` branch. Modernization or test branches may be used for
local build/smoke work, but must not run `publish-nas-release.ps1` or update the
stable NAS channel.

For the full developer and code-assistant workflow, including clone recovery,
local testing, commit/push, NAS stable publishing, updater diagnostics, and
Revit-close policy, read `docs/DEVELOPER_RUNBOOK.md`.

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
