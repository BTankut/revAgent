# NAS Deployment for revAgent

This folder contains the tools used to publish revAgent releases to the NAS and
keep office workstations updated from that single deployment source.

Use `revAgent` for product-facing wording. Codex MCP entries should appear as
`revAgent` and `revAgent-api-docs`. Keep `revit-mcp-skill`, `RevitMCP*`,
`revit-mcp`, `mcp-servers-for-revit`, and `C:\ProgramData\DPE\revAgent` only
as exact release, server, legacy cleanup, or deep source identifiers.

## Deployment Model

GitHub is the source history. The NAS share carries signed release data read by
office workstations, but it is not an independently authenticated elevated
trust anchor. Installed workstations start from the administrator-protected
local bootstrap under `C:\ProgramData\DPE\revAgent\bootstrap`. Only a current,
verified bootstrap follows the normal local GUI path. On a clean workstation,
or when that bootstrap is stale, the exact-managed
`tools\revAgent Updater STABLE.cmd` enters Refresh and returns exit 84 before
UAC. It directs the operator to the supervised IT prestage kit and does not
perform self-service bootstrap elevation. The long manual procedure remains an
emergency fallback.

```text
Code change
-> topic branch / pull request
-> Engineering gates + GitGuardian + automatic Claude Code Review
-> protected main update
-> signed-source-free-cd.yml builds, signs, and validates without publishing
-> manual workflow_dispatch with publish_to_pilot=true updates only the signed
   DESKTOP-OKNV128/NET01 pilot channel
-> a later, separately approved publish_to_nas=true updates NAS stable/fleet
-> scheduled tasks audit; current/prestaged workstations update through the
   split-privilege GUI
```

A normal feature-branch `git commit` or `git push` does not update the office by
itself. A protected `main` update builds and validates the signed source-free
release root but publishes neither channel. Pilot and stable publication are
separate, mutually exclusive manual workflow dispatches.

The daily workstation task reads stable in `-AuditOnly` mode and may notify the
operator, but cannot install it. After the protected bootstrap is current and
verified, production uptake begins only when an operator runs the
split-privilege GUI and approves the bounded machine phase.

## NAS Layout

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\
  Install-revAgent-Updater-GUI.cmd
  Install-Revit-MCP-Updater-GUI.cmd
  Install-revAgent-Updater.cmd
  Install-Revit-MCP-Updater.cmd
  channels\
    stable.json
    stable.sig.json
  releases\
    2026.05.08.1500-a1b2c3d4\
      revAgent-2026.05.08.1500-a1b2c3d4.zip
      manifest.json
      manifest.sig.json
  reports\
    PC-01_USER22.json
  tools\
    revAgent Updater STABLE.cmd
    Revit MCP Updater STABLE.cmd
    Refresh-revAgent-LocalBootstrap-STABLE.cmd
    Refresh-revAgent-LocalBootstrap-STABLE.ps1
    Install-revAgent-Updater-GUI.cmd
    Install-Revit-MCP-Updater-GUI.cmd
    Install-revAgent-Updater.cmd
    Install-Revit-MCP-Updater.cmd
    Start-revAgent-Update.ps1
    Install-revAgent-Updater-GUI.ps1
    Install-Revit-MCP-Updater-GUI.ps1
    lib\
      RevAgent.LocalBootstrap.psm1
      RevitMcp.*.psm1
    config\
      release-trusted-keys.json
      revit-versions.json
    dependencies\
      node-v24.14.1-x64.msi
    install-updater-task.ps1
    update-from-nas.ps1
    show-installed-version.ps1
    publish-desktop-launcher-evidence.ps1
    collect-rollout-evidence.ps1
    test-commandset-live.ps1
```

The signed source-free CD root deliberately contains no `.cmd` first-hop files.
During an approved stable publish, the NAS publisher materializes the exact
managed operator surface shown above: the two STABLE launcher names, the
refresh CMD/PowerShell pair, the verified public trusted-key document, and four
legacy compatibility stubs in both `tools\` and the NAS root. The legacy stubs
contain no independent updater logic; they delegate to `revAgent Updater
STABLE.cmd`. The publisher writes or repairs these files through held exact
handles, verifies their SHA-256 identities before completing the channel
promotion, and rolls them back through the same handles on failure. Pilot
publication does not change this shared stable surface.

The canonical published surface contains exactly 13 managed files: two STABLE
launchers, the refresh CMD/PowerShell pair, one trusted-key document, and four
legacy stub names in each of `tools\` and the NAS root. Eleven of those files
are the complete CMD allowlist; no other CMD entry point is permitted. Do not
manually delete the legacy names after publication: they are managed
compatibility delegates, not frozen updater implementations. O2/O3 closure is
proved by canonical published-surface readiness, not by ad-hoc file cleanup.

`scripts\check-signed-stable-readiness.ps1 -RequirePublishedSurface` is the
post-publication gate. It requires every managed file and exact hash, requires
`tools\config\release-trusted-keys.json` to match the verified publisher input
(and the pinned production key identity), and rejects unmanaged `.cmd` entry
points. Do not use this mode against the source CD root; ordinary source-release
readiness remains CMD-free and validates the signed payload before publication.
The same gate is enabled automatically when `-ReleaseRoot` resolves to the
canonical production `revAgent-deploy` root, so an operator cannot accidentally
omit the published-surface check there. `-RequirePublishedSurface` remains the
explicit form for disposable fixtures and noncanonical audit copies.

After NAS root migration, the old
`\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy` root is not a default
publish target or launcher fallback. Keep it only for explicit diagnostics,
rollback reference, or data-gated physical cleanup/freeze.

## Signed Publish Boundary

The production path is GitHub Actions signed source-free CD.
`installer\nas\publish-nas-release.ps1` is a local artifact producer only: its
release root must be on an eligible local drive below the controlled staging
root, with no reparse ancestor. It may not write the canonical NAS path, a UNC
path, a mapped network drive, or a redirected staging root. This remains true
for recovery and backstop work.

Every canonical NAS write must consume an already signed and validated local
release root through
`scripts\publish-signed-source-free-release-to-nas.ps1`. Detached production
signatures use the pinned key outside the repo and NAS; never put a private key
in Git, the release ZIP, the staging output, or NAS tools.

## GitHub Actions CD

The protected workflow `.github/workflows/signed-source-free-cd.yml` is the
preferred CD producer for signed source-free releases. It runs from `main`,
uses the protected `revagent-release-signing` environment to build and validate
a signed release root, and for an explicit publish dispatch uploads that root
as one immutable, one-day GitHub Actions artifact. The build job exposes the
exact artifact id, artifact digest, and signed source-channel SHA-256 to the
publish job; an ordinary `main` push performs build/validation without an
artifact upload.

An explicit dispatch also creates a separate one-day
`revagent-supervised-prestage-kit-<run>-<attempt>` artifact below local
`RUNNER_TEMP`. Its deterministic ZIP contains exactly five public/runtime
files and its SHA-256 is written to the protected run summary. The artifact is
IT-only: it is not a signed-release artifact, is not linked into the publish
job, and must never be copied into NAS `tools`, a signed release ZIP/root, or a
standard-user-writable share. For a prestage-only run, leave both publish
inputs false.

When protected `main` is updated, the workflow builds and validates the signed
release root. Before publish, the second job verifies through GitHub REST that
the exact artifact belongs to the same repository, run, and commit, downloads
it by exact id with digest-mismatch failure enabled, and requires an absent,
job-unique local landing leaf below `RUNNER_TEMP` with no reparse ancestor.
Production NAS publish is a separate explicit manual dispatch. Set
`publish_to_pilot=true` to publish only an exact signed pilot cohort containing
DESKTOP-OKNV128 and NET01. The publisher creates a unique pilot-namespaced
release and updates only `channels\pilot.json` plus its signature; it proves the
stable pair, active stable release tree, and shared tools tree were unchanged.
Set `publish_to_nas=true` only in a later, separately approved stable/fleet
window. The two inputs are mutually exclusive. Stable publication now uses the
active transactional exact-handle replacement path for the complete 13-file
managed shared-tools/operator surface. The release tree is created through
handle-bound create-new operations, the signed stable channel pair uses
same-handle compare-and-swap/rollback, and final identity checks close the
transaction. Publication is no longer disabled by the former shared-tools gap.

The publish job reads the exact downloaded and digest-verified release root and
runs `scripts/publish-signed-source-free-release-to-nas.ps1`; it does not
rebuild or re-sign the artifact. It also passes the build-bound signed
source-channel SHA-256 to the publisher, so a different valid release tree
cannot be substituted at the handoff. The selected runner labels must still
resolve to the office runner that owns signing-key access for the build job and
NAS access for the publish job.

The manual dispatch also exposes `release_identity`. The default identity is
now `revAgent`, which produces matching `revAgent` channel app ids and release
ZIP names. Select `revit-mcp-skill` only for a deliberate legacy compatibility
recovery publish.

Before changing a producer identity in either direction, keep this gate in the
rollout readiness config and require the readiness summary state to be
`verified`. The gate normally checks every in-scope machine. For a deliberate
pilot-gated switch, set `requiredMachines` to the machines that have live
compatibility evidence:

```json
"releaseIdentityProducerSwitch": {
  "enabled": true,
  "targetIdentity": "revAgent",
  "compatibleStableVersion": "2026.06.30.xxx-xxxxxxxx",
  "compatibleStableCommit": "commit-that-contains-dual-app-identity-consumers",
  "requiredMachines": ["NET01", "OGUZHAN", "HAFIZE"]
}
```

For production NAS publish, set `REVAGENT_NAS_RELEASE_ROOT` to the canonical
`revAgent-deploy` path. The publish job writes the signed release only to that
canonical root. Legacy `revit-mcp-deploy` roots are no longer default publish
targets after compatibility-root retirement.

Candidate and final stable readiness checks use active-release artifact
hygiene. They verify the candidate release package and current `tools\`
payload, but do not block on historical legacy release ZIPs that may already
exist under the NAS `releases\` archive. Use the default full-root readiness
scan separately when auditing or cleaning those historical archives.

Protected variables:

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
The key id and fingerprint are pinned production values, not rotation
examples. The production trusted-key document contains exactly this one key;
do not publish an old-plus-new overlap document. Rotation requires the
coordinated code-and-bootstrap-prestage procedure in
`docs\DEVELOPER_RUNBOOK.md` before the replacement-key release is promoted to
stable. The public key fingerprint is
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
- Node.js/npm is installed automatically. If the authenticated machine already
  has a supported trusted Node runtime, no Node installer is launched. Otherwise
  the updater may use the MSI copied from the authenticated execution snapshot.
  The source MSI is a versioned release sidecar; shared NAS `tools` is not its
  trust boundary.
- `C:\Projects` is created before the Codex setup step so it can be selected as
  the Codex working folder.
- ChatGPT/Codex is installed and signed in manually by the user. During the
  first install, after proxy and `C:\Projects` are ready, the installer pauses
  and asks the user to install/open the app and continue. The unelevated phase
  then selects a signed capable Codex CLI and registers MCP under the captured
  interactive profile/`CODEX_HOME`. Older managed `codex_app` and
  `codex_command_payload` folders are removed from workstation installs.

Large dependency payloads remain outside Git and outside the release ZIP. Signed
CD downloads the exact official Node MSI, verifies its pinned SHA-256, byte size,
and Authenticode signer, then writes it as
`releases\<version>\external\node-v24.14.1-x64.msi`. The signed release manifest
binds that exact relative path and identity. Pilot publication copies the
versioned sidecar while proving shared NAS `tools` byte-identical. If a local CD
root already contains the compatibility copy under `tools\dependencies`, it is
reused only after exact ordinary-file, single-link, hash, size, and signer
revalidation; a mismatch fails closed without replacing the existing file.

That OpenJS Authenticode check authenticates a third-party dependency only. The
revAgent repository/workflow currently has no Windows code-signing
certificate/service and no Authenticode-signed bootstrap EXE/MSI. Its production
release signature is detached RS256 JSON metadata and cannot serve as Windows
code-signing trust for the first elevated hop.

On a clean workstation, a standard user runs only
`\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\revAgent Updater
STABLE.cmd`. If the protected state is absent or stale, any NAS Refresh path
that would elevate returns exit 84 before UAC and points to
`docs/BOOTSTRAP_PRESTAGE.md`; direct `-ElevatedApply` is disabled by the same
guard. It does not copy release inputs into an elevated bootstrap attempt. Exit
codes 79, 80, 81, and 82 describe UAC decline, an existing coordinator, timeout,
and disabled/non-de-elevatable UAC only after a future independent elevation
anchor re-enables that coordinator path. Current missing-or-stale Refresh does
not reach those outcomes.

Existing protected-bootstrap operation remains normal only while that
bootstrap is current and verified: STABLE bypasses Refresh and the protected
local launcher opens the split-privilege GUI. A stale protected verifier/key
may not authorize its own replacement. The locked-file verifier and associated
staging/hash/nonce controls remain defense-in-depth for a future independently
anchored coordinator; they are not current elevation authorization.

Current bootstrap freshness is a byte-binding contract over these eight signed
release components:

- `installer\nas\Start-revAgent-Update.ps1`
- `installer\nas\Start-revAgent-Update.cmd`
- `installer\nas\Install-revAgent-Updater-GUI.ps1`
- `installer\lib\RevAgent.DistributionIntegrity.psm1`
- `installer\lib\RevAgent.Permissions.psm1`
- `installer\lib\RevAgent.SourceFreeMigration.psm1`
- `installer\lib\RevAgent.ReleaseSnapshot.psm1`
- `installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1`

If any one changes, an older protected bootstrap reports
`bootstrap_refresh_required` and enters Refresh. Until the E2 machine trust
core and broker are live, Refresh stops at exit 84, so such a stable publication
requires an explicit fleet re-prestage/refresh plan. The current
`2026.07.20.574-11020d1a` stable release already has this condition armed for
older workstation bootstraps because #258/#259 changed the bootstrap script,
launcher, updater GUI, and privileged-snapshot updater. Installed revAgent
operation continues, but the next operator-started STABLE/GUI update path is
blocked until supervised rebind. Use the E1 kit only for an urgent individual
machine: verify its ZIP SHA-256 against the protected CD run summary,
distribute it through an IT-controlled channel, preserve the exact five-file
layout, and double-click `IT-Prestage-revAgent.cmd` for one UAC and an
under-five-minute supervised rebind. It requires no repo checkout, pasted
block, or copied hash literals; its sealed wrapper copies hash-pinned inputs to
an administrator-only local staging directory before elevated execution. Do
not run it from a standard-user-writable Downloads/Desktop/share path. Defer
the general fleet pass until E2. Do not publish another
eight-component change before E2 without the same warning in the PR and
changelog and a separately approved rollout window.

Self-service bootstrap install/refresh may be re-enabled only when an
Authenticode-signed bootstrap broker, or an equivalent IT-prestaged verifier
and pinned key, independently revalidates the detached release signature after
elevation. Until then, use the primary supervised IT kit in
`docs/BOOTSTRAP_PRESTAGE.md`; use its manual high-assurance block only for
emergency recovery. The repository-side `scripts\install-revagent-local-bootstrap.ps1`
is source material, never a repo- or NAS-side elevated entrypoint.

After prestage, close Revit and run:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

The GUI shows the live install/update log and provides a button to open the log
folder if something fails. The protected bootstrap starts the absolute trusted
Windows PowerShell executable directly, without shell association, from the
canonical Windows PowerShell host directory under System32. It keeps the
PowerShell console hidden, so a separate terminal window should not remain
beside the installer.

The GUI starts unelevated, captures the interactive account, SID, profile, and
effective `CODEX_HOME`, and then runs two explicit phases. Windows UAC is used
only for the machine phase; after that child exits, the original GUI process
runs the user phase without elevation. The elevated phase never executes
`%LOCALAPPDATA%`, `%APPDATA%`, npm shims, or another user-writable executable,
and it never writes Codex user configuration or skills.

After trust is established, first-install and legacy bootstrap code runs only
from the protected local bootstrap root. The root includes both
`lib\RevAgent.SourceFreeMigration.psm1` and its required authenticated sibling
`lib\RevAgent.Permissions.psm1`; their separate state hashes must match the
current `installerLibSourceFreeMigration` and `installerLibPermissions` signed
manifest components before the GUI starts. That bootstrap acquires the signed
canonical release set into an administrator-protected local snapshot,
re-attests the signed channel/manifest and every pre-import component there,
and only then launches the local GUI. If the local bootstrap/GUI/verifiers or
either protected migration dependency do not match the current signed
manifest, the current managed Refresh path returns exit 84 before UAC and fails
closed to supervised administrator prestage/refresh. A future independently
authenticated broker may re-enable that path. Do not elevate a copied desktop
script body, NAS GUI, or local user-writable updater. After installation,
machine code, package,
runtime, updater libraries/config, Revit payload, and machine Codex source are
administrator-owned and read/execute-only for standard users. User write ACLs
are limited to updater `logs`, `user-state`, the product data `state` root, and
declared add-on state roots; they must not extend to executable or config trees.

The per-user Scheduled Task and Startup fallback run `-AuditOnly` at 12:00.
They may report availability or notify the operator, but cannot install or
replace payloads. Every update/install/repair is a manual GUI action: the
operator starts the normal launcher, approves UAC for the bounded machine
phase, and the GUI resumes the unelevated user phase afterward. The task does
not use `StartWhenAvailable`, avoiding parallel missed-run processes.

If you want to copy a single launcher to a workstation desktop, copy the
standalone launcher instead:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

The NAS STABLE launcher delegates to
`%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1` only when the
protected bootstrap is current and verified; the canonical `revAgent-deploy`
channel remains data rather than executable trust. A missing or stale bootstrap
enters Refresh, stops with exit 84 before UAC, and requires supervised manual
prestage/refresh. Direct `-ElevatedApply` is likewise disabled. No path permits
elevating a loose NAS GUI/script.

Production NAS `tools` publishes the exact managed CMD allowlist described in
the NAS Layout section. After a current, verified bootstrap is installed,
prefer the protected local launcher for desktop shortcuts and ordinary repeat
use.

The updater uses the standard machine-wide root:

```text
C:\ProgramData\DPE\revAgent\
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
C:\ProgramData\DPE\revAgent\updater\logs\
```

Updater log retention is automatic. Install and update runs keep the latest
10 `.log` files in the managed log folder and remove older logs.

Each workstation also publishes its latest install/update state and copied
operation logs to the NAS report bridge:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports\machines\<computer>\
  latest.json
  install-latest.json
  update-latest.json
  logs\
```

The NAS machine folder keeps the latest two copied operation logs. The JSON
records include `operationMethod`, so support can distinguish GUI install,
GUI update, scheduled audit, manual update, and install/repair runs. The
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
`liveSmokeEvidence` or `reports\rollout\live-smoke-latest.json`. The same
audit also classifies each machine's latest `paths.channelManifestPath` as
canonical, legacy, or unknown. The default production publish and STABLE
launcher no longer target `revit-mcp-deploy`; use the audit evidence before any
physical old-root cleanup or freeze.
The NAS `tools` copy is transport/reference material and a bounded non-elevated
coordinator surface, not an elevated execution or trust root.
Run `scripts\test-commandset-live.ps1` from a clean repository checkout or an
independently protected local coordinator copy, with `-ReleaseRoot`, to write
`reports\rollout\live-smoke-latest.json`.
For the standard NET01 smoke, run the repo-side coordinator SSH wrapper in two
steps: first `scripts\invoke-live-smoke-over-ssh.ps1 -Computer NET01 -ReleaseRoot
<root> -OpenOnly` to open the installed Revit 2022 sample model in the
logged-on workstation session and verify the expected active document through
revAgent, then rerun without `-OpenOnly` to run the helper and write the same
rollout evidence.
Record the launcher audit in `desktopLauncherEvidence` or
`reports\rollout\desktop-launcher-latest.json`. The supported path is to run
the repo/protected-local `scripts\publish-desktop-launcher-evidence.ps1 -Mode ScanLocal` on each
in-scope machine, then `-Mode Aggregate` from the coordinator with the rollout
config. The same script is also available from the repo `scripts\` folder for
developer-side audits. The readiness audit also reads per-machine
`reports\machines\<machine>\desktop-launcher-latest.json` records, so current
machine scans can complete coverage even if the rollout aggregate is stale or
partial. Non-zero legacy launcher/root counts, missing machine evidence, or
failed machine evidence block compatibility-root retirement. `ScanLocal`
checks the current user Desktop, public Desktop, and readable
`C:\Users\*\Desktop` or `C:\Users\*\OneDrive*\Desktop` folders by default so
SSH/admin runs still inspect normal operator launchers.
If source-free evidence is missing, run `migrate-source-free-install.ps1` in
`dryRun` mode with `-ReportsRoot` set to the canonical reports root. The dry-run
publishes `source-free-migration-latest.json` for readiness without replacing
the dashboard `latest.json` version report. The standalone script is
inventory-only: its retained `-Mode commit` compatibility value fails closed.
Start
`C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd` and choose
the GUI `Migrate` action for mutation; use `Install/Repair` there when the local
updater must first be bootstrapped. That route is required so the authenticated
snapshot broker can run the administrator-only machine phase and return to the
original unelevated user phase safely.

The GUI `Install/Repair` action is the canonical hard-rebaseline path. It
refreshes the signed managed payload and performs bounded legacy cleanup in both
phases: exact retired machine roots/add-ins/npm namespace in the administrator
phase, then exact per-user add-ins/Startup launchers/retired-machine Codex link
in the unelevated phase. Unknown legacy-root children and custom or real Codex
skill directories are reported and preserved. Unsafe exact managed remnants,
inventory failures, and removal failures are action-required and prevent a
successful terminal attestation. Revit must be closed because this path can
remove retired Revit add-in surfaces even when current payload hashes match.
On `preserve-local` developer machines it does not traverse or replace the
current Codex instruction tree; it can unlink only the exact legacy
`.codex\skills\revit-mcp` reparse leaf when it targets the retired machine
skill root. Every shipped updater tool is required and length/SHA-256 verified,
while `lib` and `config` are staged and swapped as complete verified trees.
Reparse points, non-unit hardlinks, missing shipped config, or conflicting
write/delete handles stop the rebaseline. The canonical Revit `Addins` parent,
exact year root, and `revAgent.addin` receive protected SYSTEM/Admin write and
Users read/execute ACLs without recursively changing other vendors' children.
Updater install/repair and update runs remove managed legacy desktop launcher
shortcuts that use old `Revit MCP` names from local and OneDrive desktop
folders. The cleanup is reported as `diagnostics.desktopLauncherCleanup`; rerun
stable update before recollecting launcher evidence when stale desktop
shortcuts are reported.
For SSH-managed workstations, prefer the repo/protected-local
`scripts\collect-rollout-evidence.ps1` coordinator over
the install/repair deploy script. It stages only read-only evidence tools,
runs source-free inventory in `dryRun`, scans desktop launchers, retrieves the
staged JSON evidence files back to the coordinator, publishes the per-machine
NAS evidence centrally, and aggregates launcher evidence without installing,
repairing, updating, or committing migration cleanup. SSH targets do not need
direct NAS write access for this evidence path.

### Pilot And Stable Gates

Updater/security changes follow the normal protected delivery order: refresh
generated payloads, run `test-all.ps1` and local `test-ci.ps1`, open a draft
PR, pass protected engineering/review checks, merge to `main`, and let signed
source-free CD build and validate. Only then may an operator manually dispatch
`publish_to_pilot=true` for the exact developer/NET01 cohort.

Verify both pilot machines against the exact signed pilot version/hash:
machine/user phase reports, administrator-owned machine ACLs and bounded
user-state ACLs, `mcp get` readback, both MCP handshakes, and a genuinely new
ChatGPT task that sees MCP, AGENTS, and the expected skill policy/attestation.
This closes the pilot task without changing stable or contacting the general
fleet. Broad rollout remains a later, separately approved stable action.

## Update Behavior

- Reads the target version from `channels\stable.json`.
- Shows the installed version and target version as `old -> new`.
- Copies the versioned ZIP from NAS.
- Verifies the package SHA256 hash before install.
- Replaces the managed local package copy under `C:\ProgramData\DPE\revAgent\package`.
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
- Runs Codex integration only in the original unelevated interactive-user
  phase. The target SID/profile must match the current token; explicit
  `CODEX_HOME`, the user environment override, and finally
  `%USERPROFILE%\.codex` are resolved in that order.
- Selects Codex CLI and Node by origin, Authenticode signer, version, and
  capability probes. The persisted MCP Node command must be the signed
  system-managed runtime under Program Files; unsigned npm/user shims are not
  executed as a trusted integration path.
- Updates `config.toml` under an exclusive lock with expected-SHA comparison
  and same-directory atomic replacement. The standard memory/service-tier
  normalization remains idempotent. Readback requires `codex mcp get --json`,
  then both servers must pass MCP `initialize` and `tools/list` over stdio.
- Uses `codexInstructionPolicy=managed-user-pack` by default, which refreshes
  machine/user Codex `SKILL.md` and `AGENTS.md` from the user pack. The user
  skill is a copied managed payload at `%USERPROFILE%\.agents\skills\revAgent`;
  verified managed `.codex\skills` duplicates are removed without following
  untrusted reparse points. Developer
  workstations may set `codexInstructionPolicy=preserve-local` in
  `updater-config.json` or pass `-CodexInstructionPolicy preserve-local` to
  preserve local developer Codex instruction files and links while reporting
  instruction `present`, `loaded`, safe path, and SHA-256 attestation, while still
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
| No change already installed | Current/no-op | Yes | Returns before proxy, task, ChatGPT/Codex CLI, npm, and package work after lightweight Codex config/backup hygiene. |
| Updater or installer scripts only | Fast package-only update | Yes | Refreshes the managed package and updater tools, then restores the docs server dependency junction from cache. `install-self-contained.ps1` is skipped. If the fast step fails, the updater warns and falls back to the full repair/install path. |
| Runtime MCP server/tool code | Runtime payload update | Yes, if Revit payload is unchanged | Refreshes `C:\ProgramData\DPE\revAgent\runtime`, checks npm fingerprints/cache, and refreshes MCP registration when entry points changed. |
| Revit add-in, command set, command payload, or add-in manifest | Revit payload update | No | If `Revit.exe` is running, the update is deferred and the user is told to save/sync, close Revit, and run update again. |
| `SKILL.md` or `AGENTS.md` | Codex skill/workstation role refresh | Yes, if Revit payload is unchanged | Machine sources refresh in the elevated phase; the unelevated phase copies the canonical `.agents\skills\revAgent` payload and AGENTS file after path/link guards. Under `preserve-local`, instruction writes are skipped and attested while other update scopes continue. |
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
C:\ProgramData\DPE\revAgent\updater\lib
C:\ProgramData\DPE\revAgent\updater\config
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
- Missing system Node.js or missing ChatGPT/Codex setup is detected by the
  appropriate phase. Audit-only background checks never install dependencies
  or pause for user setup. A manual run may ask the user to finish ChatGPT
  setup before the unelevated integration phase continues.
- User-root writes reject reparse components and unexpected hardlinks. Codex
  config uses lock + compare-and-swap SHA + atomic replacement; skill/AGENTS
  managed markers must match the payload hash before replacement or cleanup.
- Older timestamped `.codex` backup files from prior installers are deleted
  during update/repair.
- Workstation rollback uses the signed NAS release archive, not local package
  backups. Normal updater runs clear updater package backups and stale cached
  release ZIPs before package replacement, then remove the current managed
  package without creating a timestamped local package backup. During the
  revAgent brand transition, `revagent-clean-install-transition.json` records
  the one-time full managed repair, but local package backups remain disabled
  afterward.
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
- Direct `migrate-source-free-install.ps1 -Mode commit` execution is disabled.
  It does not launch the local updater or attempt elevation. Use the protected
  local GUI `Migrate` flow (or its `Install/Repair` bootstrap path) for all
  mutating source-free migration work; `-Mode dryRun` remains available for
  read-only inventory and rollout evidence.
- On developer workstations with `codexInstructionPolicy=preserve-local`, the
  migration inventory and cleanup omit local Codex instruction roots and report
  `codexInstructionCleanupSkipped=true`. This is not a source-free bypass for
  production workstations; package/runtime/updater backup cleanup and signed
  release verification still apply.
- Already-current audit checks remain read-only. Manual already-current runs
  may execute the unelevated Codex attestation/readback path, but do not grant
  payload-write authority to the scheduled task.
- Official Autodesk Revit and Windows system folders are not deleted.
- Cleanup is limited to known revAgent/RevitMCP-owned install paths.
- The managed package target is refused if it is a Git working tree unless
  `-AllowReplaceGitPackageTarget` is explicitly passed.
- Release ZIPs use the canonical `installer/` layout only; removed compatibility
  aliases are not regenerated in new releases.
- Acceptance fixtures must prove that unsigned executable candidates are not
  run; user-root reparse/hardlink paths fail closed; a different UAC credential
  cannot redirect integration to the administrator profile; `CODEX_HOME`
  override/default cases work; and both ChatGPT-open and ChatGPT-closed runs
  finish. Existing ChatGPT tasks may retain old MCP/skill descriptors, so open
  a genuinely new task after update (restart ChatGPT if needed) and verify MCP,
  AGENTS, and skill visibility there.
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
