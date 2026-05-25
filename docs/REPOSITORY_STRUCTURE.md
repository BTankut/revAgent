# revAgent Repository Structure

This repository is the single canonical source for the revAgent workstation
package. Internal implementation names such as `revit-mcp`, `RevitMCP*`,
`mcp-servers-for-revit`, and `C:\ProgramData\DPE\RevitMCP` remain exact names
for servers, assemblies, manifests, and installed paths.

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
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- DEVELOPER_RUNBOOK.md
|   |-- MONOREPO_MIGRATION.md
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- PLATFORM_MODERNIZATION_SUMMARY.md
|   |-- REPOSITORY_STRUCTURE.md
|   `-- REVIT_IMAGE_EXPORT.md
|-- references/
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- test-all.ps1
|   |-- test-commandset-live.ps1
|   `-- test-installer-smoke.ps1
|-- src/
|   `-- revit-plugin/
|       |-- README.md
|       |-- revit-mcp-plugin.sln
|       |-- revit-mcp-plugin/
|       |-- RevitMCPCommandSet/
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
The main add-in host is `src/revit-plugin/revit-mcp-plugin`.

The shared bridge command source lives in
`src/revit-plugin/RevitMCPCommandSet`. Keep this project limited to the
registered production bridge commands: `send_code_to_revit`,
`get_current_view_elements`, `get_current_view_info`,
`get_selected_elements`, `list_open_views`, `activate_view`, `close_view`,
`get_ui_state`, `find_elements`, `open_existing_plan_for_element_level`,
`focus_elements`, `section_box_elements`, and
`create_3d_view_for_elements`. This command set owns dynamic execution behavior
such as `transactionMode`, guarded manual-transaction handling, dynamic compile
metadata reference selection, view activation/close, element focus, and 3D
section box behavior.

`SampleCommandSet` and the old unregistered create/edit/filter/tag/data
extraction command sources are intentionally not kept in this repository
because they are not used by the installed production payload, make command
assembly scanning noisier, and have historically carried localized or mojibake
strings into developer-facing source.

`installer/revit-plugin` is install payload. Production installers copy from this
folder into `C:\ProgramData\DPE\RevitMCP`. Do not edit the binary payload by
hand. Build the host and shared bridge source, then refresh those payload
binaries with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Then commit both the source change and the refreshed payload binaries.

When `src/revit-plugin/RevitMCPCommandSet` changes, validate it explicitly:

```powershell
dotnet build .\src\revit-plugin\RevitMCPCommandSet\RevitMCPCommandSet.csproj -c "Release R22" /p:RevitMcpDeployCommandSet=false
```

The stable shared bridge payload under `installer/command-payload` is refreshed
by `scripts/build-revit-plugin.ps1`. When the command set changes, commit both
the refreshed `installer/command-payload` copy and the installed Revit
command-set payload copy before release validation.
The smoke tests also assert that the Revit plug-in source remains English-only
and that the command-set source surface does not grow beyond the registered
production bridge commands.

The Revit add-in Settings window lists the installed shared bridge command set.
That screen is expected to show fewer entries than the runtime MCP server
because it does not list Node-side MCP wrappers, dynamic-snippet tools, status
tools, image export tools, or workflow orchestration tools. Treat the bridge as
the shared base for all future discipline modules; add architectural,
structural, electrical, and MEP-specific capabilities in the runtime MCP tool
layer unless they require a reusable native Revit bridge primitive.

`installer/runtime-mcp-server/src` and `installer/revit-api-docs-mcp/src` are
the TypeScript MCP source trees. Their `build/` folders remain the runtime
payload contract consumed by installer and Codex MCP registrations.

`scripts/test-commandset-live.ps1` is the optional live Revit commandset gate.
It is not part of `test-all` because it requires a running Revit session, but it
should be used when shared bridge command payload behavior changes.

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

The generated release ZIP remains self-contained for office workstations. The
package uses the canonical `installer/` layout only; removed compatibility
aliases are not regenerated in new releases.
