# Revit MCP Platform Architecture

This repo is a self-contained workstation deployment platform for Revit MCP.
The production technology choices stay the same: C# Revit add-in, local Node
MCP servers, and PowerShell installer/updater orchestration.

## Runtime Components

- `src/revit-plugin/`: C# Revit add-in source. The add-in hosts the local Revit
  socket service, command registry, status window, and command execution bridge.
- `installer/revit-plugin/`: bundled Revit add-in payload copied to
  `C:\ProgramData\DPE\RevitMCP\revit-plugin`.
- `installer/command-payload/`: bundled dynamic command set and Roslyn runtime
  assemblies used by `send_code_to_revit`.
- `installer/revit-plugin/revit_mcp_plugin/Commands/RevitMCPViewCommandSet/`:
  bundled UI view commands for listing, activating, and closing Revit view
  tabs, focusing elements in a view, and applying 3D section boxes around
  elements. Focus/view activation commands avoid the dynamic code transaction
  wrapper; section box changes use a normal Revit transaction against the
  target 3D view.
- `installer/runtime-mcp-server/src/`: TypeScript source for the live Revit MCP
  runtime server. `npm run build` emits `build/`, which remains the installer
  and Codex registration contract.
- `installer/revit-api-docs-mcp/src/`: TypeScript source for the Revit API docs
  MCP server. It indexes local Revit API DLL/XML files and serves API lookup
  tools from `build/index.js`.

## Runtime Transport And Status

The Node runtime and Revit add-in communicate over the local Revit MCP socket.
New clients send length-prefixed JSON-RPC frames: a 4-byte big-endian payload
length followed by the UTF-8 JSON payload. The add-in keeps legacy raw JSON
support so older clients can still reach the socket during rolling updates.

The default request frame limit is 16 MB. It can be raised per workstation with
`REVIT_MCP_MAX_MESSAGE_BYTES`, capped at 128 MB. Oversized or invalid frames
return a clear JSON-RPC error and close the client connection instead of
leaving the caller waiting for the generic command timeout.

Every completed task records transport metrics in the status model:

- `framing`
- `requestBytes`
- `receiveMs`
- `parseMs`
- `executeMs`
- `responseBytes`

The Revit status window intentionally shows only the state symbol, task name,
total Revit-side duration, and request size. Detailed metrics are written to
the add-in log under the installed payload `Logs\` folder.

## Deployment Components

- `installer/install-self-contained.ps1`: repo/package installer. Public
  parameters and file name are kept stable.
- `installer/nas/install-updater-task.ps1`: workstation updater bootstrap and
  scheduled task registration.
- `installer/nas/update-from-nas.ps1`: NAS channel updater.
- `installer/nas/Install-Revit-MCP-Updater-GUI.ps1`: GUI bootstrap wrapper.
- `installer/nas/Revit MCP Updater STABLE.cmd`: standalone stable launcher.
- `installer/nas/publish-nas-release.ps1`: release packaging tool. Do not run
  it during local modernization or smoke-test work.

## Shared PowerShell Modules

Shared helpers live under `installer/lib/` and are copied beside local updater
tools under `C:\ProgramData\DPE\RevitMCP\updater\lib` and NAS `tools\lib`.
The Revit version matrix is copied beside those tools as `config\`.

- `RevitMcp.HiddenLauncher.psm1`: single-line VBS hidden launcher generation
  with child exit-code propagation.
- `RevitMcp.ScheduledTask.psm1`: scheduled task action repair to WScript.
- `RevitMcp.Permissions.psm1`: targeted permission repair plan and execution.
- `RevitMcp.Package.psm1`: release path, package layout, and ZIP extraction.
- `RevitMcp.RevitVersions.psm1`: Revit version matrix loading and install-root
  discovery.
- `RevitMcp.UpdatePolicy.psm1`: Revit-open defer vs non-Revit update decision.
- `RevitMcp.Proxy.psm1`: proxy URL normalization helpers.
- `RevitMcp.CodexRegistration.psm1`: Codex `config.toml` MCP registration
  helpers.
- `RevitMcp.Reporting.psm1`: JSON report helpers.

## Revit Version Matrix

`config/revit-versions.json` is the central model for Revit version metadata:

- Revit version and label
- target framework and build configuration
- install-root candidate patterns and registry roots
- all-users add-in path pattern
- API package mapping
- installer payload path expectations
- `installerPayloadAvailable` gate

This branch and the stable deploy line currently support only the Revit 2022
payload. Revit 2023/2024/2025 are modeled for future expansion; installer and
deploy gates must stay closed for those versions until real artifacts are
produced and validated.

## Compatibility Entrypoints

These public entrypoints must keep their names and existing 2022 behavior:

- `installer/nas/Revit MCP Updater STABLE.cmd`
- `installer/nas/Install-Revit-MCP-Updater-GUI.ps1`
- `installer/nas/install-updater-task.ps1`
- `installer/nas/update-from-nas.ps1`
- `installer/install-self-contained.ps1`
- `scripts/build-revit-plugin.ps1`

## Local Validation

No-deploy validation for this platform layer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

Optional aggregate command from repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

Revit add-in build check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

The full payload-refresh build without `-SkipPayloadCopy` should be reserved for
intentional payload update work.
