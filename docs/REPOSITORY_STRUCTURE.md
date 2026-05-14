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
|   |-- MEP_PRODUCTION_PACKAGES.md
|   |-- connector-graph/
|   |-- dcw-dhw/
|   |-- fire-piping/
|   |-- sanitary-rainwater/
|   |-- engineering-plans/
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- REPOSITORY_STRUCTURE.md
|   `-- MONOREPO_MIGRATION.md
|-- references/
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- test-all.ps1
|   |-- test-connector-graph.ps1
|   `-- test-installer-smoke.ps1
|-- tests/
|   `-- fixtures/
|       `-- connector-graph/
|-- src/
|   `-- revit-plugin/
|       |-- README.md
|       |-- revit-mcp-plugin.sln
|       |-- MepConnectorGraph/
|       |-- MepConnectorGraph.Tests/
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
`src/revit-plugin/MepConnectorGraph` is the shared .NET Framework 4.8 connector
graph foundation used by MEP system feature branches. It contains pure schema,
deterministic JSON serialization, Revit internal unit conversion helpers, and
topology validation that can be tested without Revit.

The main add-in host is `src/revit-plugin/revit-mcp-plugin`. The production
dynamic command source is `src/revit-plugin/RevitMCPCommandSet`; it backs
`send_code_to_revit` and the low-level read-only context commands. UI view tools
are implemented as the separate `src/revit-plugin/RevitMCPViewCommandSet`
project so view activation/close, element focus, existing-plan focus, 3D view
creation, and section box behavior stay outside the dynamic code transaction
wrapper. There is no production `SampleCommandSet` source in this repo.

`installer/revit-plugin` is install payload. Production installers copy from this
folder into `C:\ProgramData\DPE\RevitMCP`. Do not edit the binary payload by
hand. Build the source and refresh the payload binaries with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Then commit both the source change and the refreshed payload binaries.

The build script validates `RevitMCPCommandSet` source by default, but it keeps
the stable dynamic command payload unchanged unless
`-RefreshCommandSetPayload` is passed intentionally.

`installer/runtime-mcp-server/src` and `installer/revit-api-docs-mcp/src` are
the TypeScript MCP source trees. Their `build/` folders remain the runtime
payload contract consumed by installer and Codex MCP registrations.

The runtime MCP server also contains the MEP production packages documented in
`docs/MEP_PRODUCTION_PACKAGES.md`. These packages are Node MCP tools, not Revit
ribbon commands. They consume shared connector graph JSON for ducting,
hydronic, DCW/DHW, sanitary/rainwater, and fire-piping engineering checks, and
only the DCW/DHW plus sanitary/rainwater packages include manually gated Revit
write-back helpers.

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
