# revAgent Self-Contained Installation

This folder contains the installable workstation payload for revAgent. End
users should normally install through the NAS updater rather than running these
scripts manually.

The implementation still uses exact internal names such as `RevitMCP*` and
`C:\ProgramData\DPE\RevitMCP`; do not rename those when documenting commands
or paths. Codex-facing MCP entries should appear as `revAgent` and
`revAgent-api-docs`.

## Contents

- `install-self-contained.ps1`: installs the local payload into standard Windows machine locations.
- `nas/`: NAS release publishing and workstation updater tools.
- `revit-plugin/`: bundled Revit add-in payload for Revit 2022.
- `runtime-mcp-server/`: bundled runtime MCP server build for live Revit execution.
- `revit-api-docs-mcp/`: required companion MCP server for local Revit API documentation lookup.
- `command-payload/`: dynamic command execution DLL and exact runtime dependencies.

## Requirements

- Autodesk Revit 2022.
- Node.js 20 or newer.
- Git for Windows for development machines.
- Codex Desktop app for the current office installer flow, or another MCP-capable host if registered manually. The NAS GUI pauses for manual Codex Desktop install/sign-in when it is not ready yet.

## Recommended Office Install

On a workstation, close Revit and run the NAS updater installer:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-revAgent-Updater-GUI.cmd
```

The updater installs into:

```text
C:\ProgramData\DPE\RevitMCP
```

It writes install and update logs under:

```text
C:\ProgramData\DPE\RevitMCP\updater\logs
```

Automatic update checks run once daily at 12:00 local time. Manual update and
install/repair remain available from the NAS GUI and command launchers. The
managed log folder is pruned automatically to keep the latest 10 `.log` files.
The NAS deployment report bridge also keeps per-machine latest status JSON and
the latest two copied operation logs under `reports\machines\<computer>`.
To hold a production rollout before verification, temporarily disable the
`revAgent Auto Update` scheduled task on affected machines and re-enable it
after the signed stable release is accepted.

## Manual Repo-Root Install

Use this only for development or emergency repair. Close Revit first.

```powershell
$RepoRoot = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022

cd C:\ProgramData\DPE\RevitMCP\runtime
npm install --omit=dev --no-audit --no-fund
codex mcp add revAgent -- node "C:\ProgramData\DPE\RevitMCP\runtime\build\index.js"

cd "$RepoRoot\installer\revit-api-docs-mcp"
npm install --omit=dev --no-audit --no-fund
powershell -ExecutionPolicy Bypass -File ".\scripts\build-index.ps1" -RevitRoot "C:\Program Files\Autodesk\Revit 2022" -OutputPath "C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache\revit-api-docs-2022.json"
codex mcp add revAgent-api-docs -- node "$RepoRoot\installer\revit-api-docs-mcp\build\index.js"
```

Both MCP servers are required:

- `revAgent`: live Revit execution and inspection.
- `revAgent-api-docs`: local Revit API class/member lookup.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022 -Uninstall
```

Use `-RemoveAgents` with `-Uninstall` only when the workstation-wide `AGENTS.md`
and skill integration should also be removed.

## Safety Notes

- Revit must be closed before a full install/repair or any update that replaces
  add-in or command DLLs. Non-Revit revAgent payload updates may be applied by
  the NAS updater while Revit is open.
- The installer manages only known revAgent/RevitMCP paths.
- Autodesk Revit program files, Windows system folders, and broad user folders are not deleted.
- Revit 2022 is detected from explicit input, environment variables, standard install paths, and registry candidates.
- If Revit cannot be found, the installer stops with a clear error.

## Release Publishing

Production release ZIPs normally publish through the signed source-free GitHub
Actions CD workflow. Protected `main` updates build and validate a signed
source-free release; production NAS publish requires an explicit manual workflow
dispatch with `publish_to_nas=true`. Use the manual publish command only for
controlled recovery/backstop work from a clean development checkout:

```powershell
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
$PrivateKeyPath = "C:\ProgramData\DPE\revAgentReleaseSigning\private\revagent-prod-rsa-2026q3-private.xml"
$TrustedKeysPath = "C:\ProgramData\DPE\revAgentReleaseSigning\public\release-trusted-keys.json"
powershell -ExecutionPolicy Bypass -File ".\installer\nas\publish-nas-release.ps1" `
  -ReleaseRoot $ReleaseRoot `
  -Channel stable `
  -RequireSigning `
  -SigningPrivateKeyPath $PrivateKeyPath `
  -SigningKeyId "revagent-prod-rsa-2026q3" `
  -TrustedReleaseKeysPath $TrustedKeysPath
```

`revagent-prod-rsa-2026q3` is the current rotation example; update both the key
id and private-key path together when rotating production release-signing keys.

See `installer\nas\README.md` for the full NAS deployment workflow.
