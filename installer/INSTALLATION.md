# revAgent Self-Contained Installation

This folder contains the installable workstation payload for revAgent. End
users should normally install through the NAS updater rather than running these
scripts manually.

The implementation still contains legacy cleanup names and external SDK names
such as `RevitMCPSDK`; do not rename those when documenting exact compatibility
or package identities. Installed paths and Codex-facing MCP entries should
appear as `C:\ProgramData\DPE\revAgent`, `revAgent`, and `revAgent-api-docs`.

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
- The current ChatGPT desktop app with Codex enabled, or another MCP-capable
  host if registered manually. The NAS GUI pauses for the user to install/open
  and sign in to ChatGPT when the signed capable Codex CLI is not ready.

## Recommended Office Install

The production NAS `tools` tree publishes no CMD launcher. Before the first run (and
after any `bootstrap_refresh_required` result), a coordinator must copy the
hash-authenticated prestage installer itself to
`C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1`
with OS/admin-only commands, protect that path, and only then execute the staged
copy with the independently authenticated SHA-256 evidence document. Never
elevate the repository-side script. The staged installer places the signed
bootstrap and clickable launcher under
`C:\ProgramData\DPE\revAgent\bootstrap`.
Follow [`docs/BOOTSTRAP_PRESTAGE.md`](../docs/BOOTSTRAP_PRESTAGE.md) for the
exact pre-elevation evidence command and built-in-only administrative staging
block. The evidence producer, schema, and example are signed user-pack
components.

On a workstation, close Revit and run the protected local updater launcher:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

The updater installs into:

```text
C:\ProgramData\DPE\revAgent
```

It writes install and update logs under:

```text
C:\ProgramData\DPE\revAgent\updater\logs
```

Automatic audit-only update checks run once daily at 12:00 local time. Manual
update and install/repair remain available from the protected local GUI. The
managed log folder is pruned automatically to keep the latest 10 `.log` files.
The NAS deployment report bridge also keeps per-machine latest status JSON and
the latest two copied operation logs under `reports\machines\<computer>`.
The `revAgent Auto Update` scheduled task cannot install or mutate payloads; it
only reports availability, so rollout holds do not require disabling it.

## Developer/Emergency Repair

Do not run `installer\install-self-contained.ps1` elevated from a repository,
Desktop, download, or other user-writable directory. Normal install/repair uses
the protected local launcher above, which runs the signed canonical machine
phase and then returns to the original unelevated user for Codex integration.
The self-contained installer now rejects every noncanonical elevated origin.

Do not call a PATH-resolved `npm`, `node`, or `codex` from an elevated repair.
The supported NAS updater installs the pinned system Node runtime in its bounded
machine phase and performs CLI/MCP work only in the original unelevated user
phase after signer, origin, version, and capability checks.

Both MCP servers are required:

- `revAgent`: live Revit execution and inspection.
- `revAgent-api-docs`: local Revit API class/member lookup.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" `
  -RevitVersion 2022 `
  -Uninstall `
  -SkipCodexUserIntegration `
  -SkipUserProfileCleanup `
  -SkipLegacyCleanup
```

User `AGENTS.md` and skill cleanup is intentionally not part of the elevated
machine uninstall. Perform it only in a separate explicit unelevated workflow.

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
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
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
