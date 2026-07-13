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

Codex discovery is bound to the current registered `OpenAI.Codex` Store
package, its exact family/publisher/status/WindowsApps files, the signed block
map, and its allowlisted `app\resources\codex.exe` content. The machine phase
copies that verified binary, without executing it, into the deterministic
administrator-protected `ProgramData` Store-cache path. The unelevated user
phase independently re-attests the Store package and executes only the matching
protected copy. A `%LOCALAPPDATA%` mirror is diagnostic-only. AppX inventory
must complete successfully and return exactly one valid package. Query/access
errors and an absent package fail closed.

The desktop task/model contract and CLI config contract are separate. The
unelevated phase first tests the selected protected CLI with root-level
`model_reasoning_effort = "ultra"` in a disposable `CODEX_HOME`. If accepted,
the real value is preserved. Only a CLI that rejects `ultra` but accepts
`xhigh` triggers a root-only atomic compatibility migration to `"xhigh"`;
profile-local and unrelated settings remain unchanged. The protected CLI must
then accept the real `CODEX_HOME`; there is no direct-edit fallback. Desktop
task-level `Ultra` selection is not treated as invalid and is checked in the
new-task pilot.

No Windows standalone package receipt or persistent signed full-file hash
chain is currently available for revAgent to authenticate after installation.
Therefore user-writable standalone layouts, legacy
`%LOCALAPPDATA%\OpenAI\Codex`, npm shims, custom `CODEX_INSTALL_DIR`, arbitrary
Program Files binaries, and copied signed executables are never executable
origins. Installing the supported Store/ChatGPT desktop package is the recovery
path; a plausible directory/JSON layout is not origin evidence.

Every accepted Codex/Node probe and final MCP readback holds no-delete/no-rename
handles on the exact executable and its directory chain through process start.
The process is created suspended, assigned to a kill-on-close Job Object, and
resumed only after assignment; its working directory is the protected executable
directory. The final server handshake applies the same guarded launch contract
to the protected Node runtime and installed MCP entrypoint.

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

Production release ZIPs publish through the signed source-free GitHub Actions
CD workflow. Protected `main` updates build and validate a signed source-free
release without publishing. A manual dispatch may set
`publish_to_pilot=true` for the signed DESKTOP-OKNV128/NET01 pilot channel;
that operation must leave stable metadata, the active stable release, and the
shared NAS tools tree unchanged. General stable/fleet publication remains a
separate `publish_to_nas=true` action and is fail-closed until its shared-tools
replacement transaction has the same handle-bound guarantees.

`installer\nas\publish-nas-release.ps1` may produce only a local signed staging
root. It must never target the canonical NAS path, including for recovery or
backstop work. Every canonical NAS write must consume an already signed and
validated local staging root through
`scripts\publish-signed-source-free-release-to-nas.ps1`; the protected workflow
is the normal entrypoint.

`revagent-prod-rsa-2026q3` is the currently pinned production key id, with
public-key fingerprint
`32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33`.
Production accepts a single-key trusted-key document. Do not add a second key
for live overlap; follow the coordinated code-and-bootstrap-prestage rotation
procedure in `docs\DEVELOPER_RUNBOOK.md`.

See `installer\nas\README.md` for the full NAS deployment workflow.
