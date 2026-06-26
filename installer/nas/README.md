# NAS Deployment for revAgent

This folder contains the tools used to publish revAgent releases to the NAS and
keep office workstations updated from that single deployment source.

Use `revAgent` for product-facing wording. Codex MCP entries should appear as
`revAgent` and `revAgent-api-docs`. Keep `revit-mcp-skill`, `RevitMCP*`,
`revit-mcp`, `mcp-servers-for-revit`, and `C:\ProgramData\DPE\RevitMCP` only
as exact release, server, assembly, manifest, or path identifiers.

## Deployment Model

GitHub is the source history. The NAS share is the deployment source read by
office workstations.

```text
Code change
-> topic branch / pull request
-> Engineering gates + GitGuardian + automatic Claude Code Review
-> protected main update
-> signed-source-free-cd.yml builds, signs, and validates without publishing
-> manual workflow_dispatch with publish_to_nas=true updates NAS stable
-> workstations run update-from-nas.ps1 manually or by scheduled task
```

A normal feature-branch `git commit` or `git push` does not update the office by
itself. A protected `main` update builds and validates the signed source-free
release root, but production NAS stable publish requires an explicit
`workflow_dispatch` run with `publish_to_nas=true`.

The stable channel is also consumed by the daily workstation scheduled task. If
verification must finish before any workstation installs the new stable release,
hold the `revAgent Auto Update` scheduled task on affected machines or publish
to a non-stable test channel until the release is accepted.

## NAS Layout

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\
  channels\
    stable.json
    stable.sig.json
  releases\
    2026.05.08.1500-a1b2c3d4\
      revit-mcp-skill-2026.05.08.1500-a1b2c3d4.zip
      manifest.json
      manifest.sig.json
  reports\
    PC-01_USER22.json
  tools\
    Install-revAgent-Updater.cmd
    Install-revAgent-Updater-GUI.cmd
    revAgent Updater STABLE.cmd
    Install-Revit-MCP-Updater.cmd
    Install-Revit-MCP-Updater-GUI.cmd
    Install-Revit-MCP-Updater-GUI.ps1
    lib\
      RevitMcp.*.psm1
    config\
      revit-versions.json
    dependencies\
      node-v24.14.1-x64.msi
    install-updater-task.ps1
    update-from-nas.ps1
    show-installed-version.ps1
```

## Manual Publish Fallback

The normal production path is GitHub Actions signed source-free CD. Use
`publish-nas-release.ps1` directly only for controlled recovery/backstop work
from a clean repo root on the development machine:

```powershell
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
powershell -ExecutionPolicy Bypass -File ".\installer\nas\publish-nas-release.ps1" `
  -ReleaseRoot $ReleaseRoot `
  -Channel stable
```

Detached release signing is required for production stable. When using the
manual fallback, pass both `-SigningPrivateKeyPath` and `-SigningKeyId`; the
script writes `manifest.sig.json` and `stable.sig.json`, verifies them before
finishing, and rejects private keys stored under the repo or NAS `tools` root.
Pass `-TrustedReleaseKeysPath` to copy the public release key set into
`tools\config\release-trusted-keys.json` for workstation updaters. Do not store
private signing keys in Git, the user ZIP, or NAS tools.

## GitHub Actions CD

The protected workflow `.github/workflows/signed-source-free-cd.yml` is the
preferred CD producer for signed source-free releases. It runs from `main`,
uses the protected `revagent-release-signing` environment to build and validate
a signed release root, and stores that root in local staging under the
self-hosted runner workspace.

When protected `main` is updated, the workflow builds and validates the signed
release root, then removes the staged root if no publish was requested.
Production NAS publish is a separate explicit `workflow_dispatch` run with
`publish_to_nas=true`. The publish job reads the validated staged release root
and runs `scripts/publish-signed-source-free-release-to-nas.ps1`, which copies
the release and tools to NAS, validates `stable.candidate.json`, blocks stable
`releaseSequence` rollback or equal-sequence repair unless `-AllowRollback` is
passed deliberately, then promotes `stable.sig.json` and `stable.json` with
channel and payload rollback backups kept until the post-publish readiness
check passes. The legacy direct publisher also blocks stable `releaseSequence`
rollback/equal-sequence repair unless its own `-AllowRollback` flag is passed.
It does not
rebuild or re-sign the artifact. The local runner staging handoff avoids GitHub
Actions artifact storage quota, so the selected runner labels must resolve to
the office runner that owns both signing-key and NAS access.

Candidate and final stable readiness checks use active-release artifact
hygiene. They verify the candidate release package and current `tools\`
payload, but do not block on historical legacy release ZIPs that may already
exist under the NAS `releases\` archive. Use the default full-root readiness
scan separately when auditing or cleaning those historical archives.

Required protected variables:

```text
REVAGENT_RELEASE_SIGNING_PRIVATE_KEY_PATH
REVAGENT_RELEASE_SIGNING_KEY_ID
REVAGENT_TRUSTED_RELEASE_KEYS_PATH
REVAGENT_NAS_RELEASE_ROOT
```

Keep the private signing key path on the approved self-hosted Windows runner,
outside the Git checkout and outside NAS `tools`. Only public trusted release
keys belong in `release-trusted-keys.json`.

Current production signing setup on this workstation uses key id
`revagent-prod-rsa-2026q3`, private key path
`C:\ProgramData\DPE\revAgentReleaseSigning\private\revagent-prod-rsa-2026q3-private.xml`,
and public trusted keys path
`C:\ProgramData\DPE\revAgentReleaseSigning\public\release-trusted-keys.json`.
The key id and private-key filename are current rotation examples; rotate them
together and publish the new public key before signing with the new private
key.
The public key fingerprint is
`32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33`.

The GitHub environments exist and the workflow variables are configured, but
reviewer/wait-timer protection rules are unavailable on the current GitHub
repo plan. The repository-side gate is therefore protected `main` plus passing
CI/review before merge; after merge, signed CD validates automatically, and
production NAS publish requires manual workflow dispatch. The NAS publish
wrapper still validates a candidate channel on the NAS root before replacing
`channels\stable.json`.

## Install The Workstation Updater

Workstation prerequisites handled by the installer:

- Autodesk Revit 2022 must already be installed.
- Office internet proxy is configured automatically as
  `http://192.168.90.10:6588` for PowerShell/terminal child processes, user and
  machine environment variables, current-user Windows internet settings,
  WinHTTP, npm, and Git where those tools are available. Repeated updates skip
  the slower proxy commands when the existing settings already match and log
  each proxy step as `ok`, `updated`, or `skipped`.
- Node.js/npm is installed automatically. The updater first tries the internet
  command-line install path, then falls back to the bundled NAS MSI under
  `tools\dependencies`.
- `C:\Projects` is created before the Codex setup step so it can be selected as
  the Codex working folder.
- Codex Desktop is installed and signed in manually by the user. During the
  first install, after proxy and `C:\Projects` are ready, the installer pauses
  and asks the user to install/open Codex Desktop and continue. The updater then
  registers MCP servers using Codex Desktop's own command under the current
  user profile. Older managed `codex_app` and `codex_command_payload` folders
  are removed from workstation installs.

Large dependency payloads are intentionally kept out of Git under
`installer\nas\dependencies\`. The publish step copies that local folder to
NAS `tools\dependencies\`; the release ZIP does not include those binaries.

On each workstation, close Revit and run:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-revAgent-Updater-GUI.cmd
```

The GUI shows the live install/update log and provides a button to open the log
folder if something fails. The GUI launchers start PowerShell hidden, so a
separate terminal window should not remain beside the installer.

The GUI requests admin rights as soon as it opens. The updater then registers a
per-user Scheduled Task that checks silently once per day at 12:00 local time.
Scheduled background checks are launched through a hidden single-line WScript
wrapper so PowerShell does not flash a terminal window or steal focus, and the
wrapper returns the child PowerShell exit code. Manual update and install/repair remain
available from the GUI and command launchers.
The Scheduled Task does not use Windows `StartWhenAvailable`: GUI update runs
already execute an immediate `RunNow` check, so missed daily checks must not
start a second updater process in parallel.
The elevated install also repairs permissions on the managed revAgent install
root and the exact `mcp-servers-for-revit.addin` manifest so that the per-user
task can update the local package, runtime, add-in payload, cache, reports,
logs, and hidden launcher files without another UAC prompt. Permission repair
is targeted to the managed roots, known updater files, and active payload
folders; it must not scan large `node_modules` or backup trees. If Windows
still blocks Scheduled Task registration, the installer creates a Startup
fallback that waits until the next daily 12:00 check time and then repeats once
per day.

If you want to copy a single launcher to a workstation desktop, copy the
standalone launcher instead:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\revAgent Updater STABLE.cmd
```

Do not copy `Install-revAgent-Updater-GUI.cmd` by itself. That file is meant
to run from the NAS `tools\` folder and expects
`Install-Revit-MCP-Updater-GUI.ps1` beside it.

The non-GUI bootstrap is also available:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-revAgent-Updater.cmd
```

The updater uses the standard machine-wide root:

```text
C:\ProgramData\DPE\RevitMCP\
  package\
  runtime\
  updater\
    lib\
  state\
  revit-plugin\
  codex\
```

Logs are written to:

```text
C:\ProgramData\DPE\RevitMCP\updater\logs\
```

Updater log retention is automatic. Install and update runs keep the latest
10 `.log` files in the managed log folder and remove older logs.

Each workstation also publishes its latest install/update state and copied
operation logs to the NAS report bridge:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports\machines\<computer>\
  latest.json
  install-latest.json
  update-latest.json
  logs\
```

The NAS machine folder keeps the latest two copied operation logs. The JSON
records include `operationMethod`, so support can distinguish GUI install,
GUI update, scheduled update, manual update, and install/repair runs. The
`latest.json` file also includes release version/commit/package SHA, status,
update diagnostics, NAS log path, and a local install-state summary for future
dashboard use.

Before closing a source-free office rollout, run the repository-side read-only
audit from a developer checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-rollout-closure-audit.ps1 `
  -ConfigPath "C:\ProgramData\DPE\revAgentOps\rollout-readiness.json"
```

That wrapper writes a timestamped JSON snapshot under
`C:\ProgramData\DPE\revAgentOps\readiness` and only reads NAS stable, machine
reports, migration evidence, copied logs, live heartbeat files, and optional
live Revit smoke evidence. It does not install, update, migrate, or publish
anything. Use
`config\rollout-readiness.sample.json` as the template for the office-specific
config file; keep that real config outside Git, use
`outOfScopeMachines[].reason` to record retired or intentionally excluded
workstations, and record the representative current-stable smoke result in
`liveSmokeEvidence` or `reports\rollout\live-smoke-latest.json`.

## Update Behavior

- Reads the target version from `channels\stable.json`.
- Shows the installed version and target version as `old -> new`.
- Copies the versioned ZIP from NAS.
- Verifies the package SHA256 hash before install.
- Replaces the managed local package copy under `C:\ProgramData\DPE\RevitMCP\package`.
- Runs `install-self-contained.ps1`, but skips unchanged payload surfaces when
  the release manifest proves they are identical. Revit add-in/command files
  are left untouched whenever their component hashes are unchanged, even if
  Revit is closed. The runtime server payload is also left untouched when the
  release-level runtime directory fingerprint matches the installed package.
  If runtime/docs entry points are unchanged, runtime dependency refresh, docs
  index rebuild, and MCP registration refresh are skipped. The docs server
  dependency junction is still restored after package replacement because the
  docs server lives inside the managed package folder.
- Checks the runtime and docs server npm dependency fingerprints before running
  `npm install --omit=dev --no-audit --no-fund`; if `node_modules` and the
  stored lockfile marker already match, or the same lockfile exists in the
  managed local npm dependency cache, npm install is skipped and logged.
- Re-registers Codex MCP entries through the current user's Codex Desktop command when available, otherwise by updating `%USERPROFILE%\.codex\config.toml` directly.
- Enforces the standard Codex memory settings in `%USERPROFILE%\.codex\config.toml`
  idempotently and removes legacy `.codex` backup artifacts created by older
  installers.
- Uses `codexInstructionPolicy=managed-user-pack` by default, which refreshes
  machine/user Codex `SKILL.md` and `AGENTS.md` from the user pack. Developer
  workstations may set `codexInstructionPolicy=preserve-local` in
  `updater-config.json` or pass `-CodexInstructionPolicy preserve-local` to
  preserve local developer Codex instruction files and links while still
  allowing runtime, Revit payload, updater, signing, report, and MCP
  registration work.
- Writes local and NAS report JSON files.
- Repairs older workstation scheduled-task triggers so legacy logon/repeated
  checks are replaced by the daily 12:00 schedule.

This is still a full package download and local package replacement. It is not
a byte-level delta patch. The install phase is incremental for the Revit payload
and runtime payload when their fingerprints are unchanged.

### Update Scope Matrix

The updater decides from the release manifest, not from the version number
alone. Each release stores component hashes and directory fingerprints, and the
workstation compares them with the installed package before choosing an install
path.

| Change in release | Install path | Revit may stay open? | Notes |
| --- | --- | --- | --- |
| No change already installed | Current/no-op | Yes | Returns before proxy, task, Codex Desktop, npm, and package work after lightweight Codex config/backup hygiene. |
| Updater or installer scripts only | Fast package-only update | Yes | Refreshes the managed package and updater tools, then restores the docs server dependency junction from cache. `install-self-contained.ps1` is skipped. If the fast step fails, the updater warns and falls back to the full repair/install path. |
| Runtime MCP server/tool code | Runtime payload update | Yes, if Revit payload is unchanged | Refreshes `C:\ProgramData\DPE\RevitMCP\runtime`, checks npm fingerprints/cache, and refreshes MCP registration when entry points changed. |
| Revit add-in, command set, command payload, or add-in manifest | Revit payload update | No | If `Revit.exe` is running, the update is deferred and the user is told to save/sync, close Revit, and run update again. |
| `SKILL.md` or `AGENTS.md` | Codex skill/workstation role refresh | Yes, if Revit payload is unchanged | Refreshes the machine Codex payload and user-profile junction/hardlink integration under `managed-user-pack`. Under `preserve-local`, this instruction payload is skipped and reported while other update scopes continue. |
| Revit API docs MCP server | Docs payload update | Yes, if Revit payload is unchanged | Refreshes docs server dependencies/index only when the docs payload fingerprint changed. |
| Mixed changes | Combined path | Depends on Revit payload | Any Revit payload change makes the release Revit-close-required. Non-Revit changes are applied together after that gate passes. |

Fast package-only updates are intentionally narrow. They are allowed only when
all of these are true: Revit payload unchanged, runtime payload unchanged, docs
payload unchanged, Codex skill/AGENTS unchanged, and MCP entry points unchanged.
If any one of those checks is false, the updater uses the normal installer path
for that scope. Because every update replaces the managed package folder, the
fast path still restores `installer\revit-api-docs-mcp\node_modules` and its
`.revagent-npm-dependencies.json` marker from the managed npm cache.

The updater and installer share helper modules under `installer\lib` in the
release package. When tools are copied to NAS `tools\`, the matching
`tools\lib` and `tools\config` folders must be copied with them. Local updater
installs copy those folders to:

```text
C:\ProgramData\DPE\RevitMCP\updater\lib
C:\ProgramData\DPE\RevitMCP\updater\config
```

The updater loads public release-verification material from its local updater
config or from local `config\release-trusted-keys.json`. Only public key XML and
fingerprints belong there. When trusted keys are present, the default policy is
`enforce`: valid `stable.sig.json` plus `manifest.sig.json` files are verified
before the ZIP is cached, and unsigned releases are rejected. Keys-free
`compatibility` remains only for legacy bootstrap/test paths. After a
workstation accepts any signed release sequence, unsigned legacy fallback is
blocked even if compatibility is requested. `-DistributionIntegrityPolicy
compatibility` is not an emergency escape hatch once trusted keys are pinned or
a signed sequence has been accepted.

Signed releases carry a monotonic `releaseSequence` in both the channel and
release manifest. The updater stores `highestAcceptedReleaseSequence` locally
and never lowers that high-watermark on later runs. Older signed channel replay
is blocked during normal runs. Emergency rollback requires a manual updater run
with `-AllowSignedReleaseRollback`; the scheduled task and GUI update path do
not pass that flag.

License/seat verification is optional and disabled unless configured. When
enabled, the updater verifies `revagent-license.json` with
`revagent-license.sig.json` using public keys from updater config or
`config\license-trusted-keys.json`. `audit` records invalid or missing license
evidence without blocking; `enforce` blocks before package replacement.
License private keys must never be shipped to workstations or NAS `tools\`.

## Local No-Deploy Validation

Before manual fallback publishing, run the local checks from the repo root.
Normal production publishes run the equivalent gates inside signed source-free
CD:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

Optional aggregate command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

The aggregate gate includes the TypeScript `@ts-nocheck` policy, both MCP
package tests, usage/live-dashboard smoke checks, and committed MCP/Revit
payload freshness verification. The NAS publish script also runs the payload
freshness preflight before staging a release.

For a C# source build check without refreshing bundled payload binaries:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

These commands do not publish to NAS and do not edit `channels\stable.json`.

## Safety

- Revit-loaded add-in and command files are not replaced while `Revit.exe` is
  running; those updates are deferred so the user can save/sync and close
  Revit. Non-Revit payload updates may still be applied while Revit is open.
- Missing Node.js/npm or missing Codex Desktop install is detected before local
  revAgent files are replaced. Manual GUI installs can pause for Codex setup;
  background update checks do not block waiting for user setup. If Codex
  Desktop is installed but its command helper is missing, MCP entries are
  written directly to `%USERPROFILE%\.codex\config.toml`.
- Codex memory settings are written idempotently. Existing `[features]` and
  `[memories]` sections are reused; the updater does not append duplicate
  memory blocks on repeated runs.
- Older timestamped `.codex` backup files from prior installers are deleted
  during update/repair. Managed package backups under the updater work folder
  are retained only for the latest 3 package replacements.
- Pending updates that require the user to close Revit show a throttled user
  notification instead of failing silently in the background. Status output
  reports these as `Pending update`, not as completed version transitions.
- Normal GUI updates run the local trusted `update-from-nas.ps1` after the
  updater is already installed. If an installed workstation is missing that
  local updater, normal update is blocked until `Install/Repair` restores the
  local updater wrapper, task registration, permissions, and the full package.
- Normal GUI and updater runs check managed source/developer artifact inventory
  before install/update work starts. If an older workstation still needs
  source-free migration, the GUI shows a one-time migration path. If the local
  updater already supports migration, the GUI runs
  `update-from-nas.ps1 -SourceFreeMigration` after operator confirmation. If the
  local updater toolchain is too old or missing the migration helper, the GUI
  runs `install-updater-task.ps1 -RunSourceFreeMigration` so the current updater
  tools are installed first and migration runs immediately after that same
  operator confirmation. If the inventory is already clean, migration does not
  run again. Non-GUI updater runs still report
  `source-free-migration-required` and stop instead of replacing the package
  without explicit migration mode.
- On developer workstations with `codexInstructionPolicy=preserve-local`, the
  migration inventory and cleanup omit local Codex instruction roots and report
  `codexInstructionCleanupSkipped=true`. This is not a source-free bypass for
  production workstations; package/runtime/updater backup cleanup and signed
  release verification still apply.
- Already-current update checks return before proxy, scheduled-task,
  Node/Codex Desktop, and npm preparation work after the lightweight Codex
  config/backup hygiene step.
- Official Autodesk Revit and Windows system folders are not deleted.
- Cleanup is limited to known revAgent/RevitMCP-owned install paths.
- The managed package target is refused if it is a Git working tree unless
  `-AllowReplaceGitPackageTarget` is explicitly passed.
- Release ZIPs use the canonical `installer/` layout only; removed compatibility
  aliases are not regenerated in new releases.
- Release signature verification uses public keys only. Private signing keys
  must never be placed in the repo, package, NAS `tools\`, updater config, or
  local updater folder.
- A fail-closed signed stable rollout must first deploy the public key material
  and publish a signed stable channel with `releaseSequence`. Do not flip
  normal office update policy to `enforce` against an unsigned stable channel.
- License/seat enforcement is separate from release signing. Use public license
  keys and signed license files only; do not place license-signing private keys
  in the release root, package, updater config, or local updater folder.
- Revit version metadata is centralized in `config\revit-versions.json`. The
  current office deployment payload supports Revit 2022 only. Revit
  2023/2024/2025 are modeled for future expansion and must remain blocked until
  real payload artifacts are built and validated.
