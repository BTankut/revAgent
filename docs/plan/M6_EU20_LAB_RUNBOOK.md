# EU-20 / M6-V1 — Clean-machine install to live read: lab runbook

> Part of the RevAgent implementation plan. Normativity:
> `docs/TARGET_ARCHITECTURE.md` → `docs/implementation-plan/00-INDEX.md`
> resolutions → `docs/implementation-plan/03-bridge-addin-installer.md` →
> this runbook. Where this runbook conflicts with those, they win.

## Status

This is the **repo-preparation** artifact for EU-20. The two true gates
below (machine selection/destructive lab authorization, and bounded live
Revit read) are **not granted** and were **not exercised** while preparing
this runbook or the scripts it drives. Every step in this document is a
plan the operator executes later, in a separately approved gated session,
against a disposable lab machine.

Do **not** run the mutating steps below (Steps 3-11) against `PETRUCCI` (the
known Revit 2022 workstation — not confirmed disposable) or against
`DESKTOP-OKNV128` (explicitly excluded; do not look for Revit there) without
a fresh, explicit operator authorization naming the exact target machine for
that session.

## Scripts this runbook drives

- `installer/bridge/Install-RevAgentBridge.ps1` (P3-T9)
- `installer/bridge/Uninstall-RevAgentBridge.ps1` (P3-T10)
- `installer/bridge/lib/RevAgent.BridgeInstall.psm1` (shared primitives)
- Machine report schema: `config/bridge-machine-report.schema.json`

Every machine-mutating action in both scripts is routed through the single
guarded choke point `Invoke-RevAgentBridgeGuardedMutation`; `-WhatIf` or
`-DryRun` makes every step below a `skipped_dry_run` plan entry instead of a
real action. **Run every step once with `-DryRun` first** and read the
emitted report before the committed run.

## Prerequisites

| # | Prerequisite | How to verify | Acceptance clause |
|---|---|---|---|
| P1 | Operator has named and authorized one specific disposable Windows/Revit 2022 lab machine for this session. | Written authorization naming the exact machine (hostname + confirmation it is disposable). | True gate (below) |
| P2 | The signed Bridge release payload (`bridge-release.json` + `.json.sig`, host/worker/addin binaries) is available and its `trusted-keys.json` is the pinned production/lab key set. | `Test-RevitMcpDetachedJsonSignatureFile` succeeds against the payload (the installer performs this itself and fails closed if not). | P-INST-2, P3-T9 |
| P3 | A single-use P-ENROLL-1 enrollment token has been minted by an admin against the EU-11 Gateway (short TTL, ≤ 24h) and its exact expiry (UTC) is known. | Token string + expiry handed to the operator out-of-band (never committed to the repo). | P-ENROLL-1, R9 |
| P4 | Target machine has Revit 2022 installed at a location `Resolve-RevitMcpInstallRoot -Version 2022` can find (registry or `config/revit-versions.json` candidate paths). | `installer/bridge/Install-RevAgentBridge.ps1` step 3 (Revit detection) succeeds without `-SkipRevitDetection`. | P3-T9 |
| P5 | Operator has local Administrator rights on the target machine (service registration + ACL lockdown require it). | `whoami /groups` shows `BUILTIN\Administrators` enabled. | P-INST-1 |
| P6 | Machine identity verified: confirm the actual `$env:COMPUTERNAME` on the console matches the machine named in P1, and is **not** `DESKTOP-OKNV128`. | `$env:COMPUTERNAME` on the target console. | Card "Environment" clause |

## Step 1 — Machine identity verification

On the target console (not this repo's dev machine):

```powershell
$env:COMPUTERNAME
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version
```

Confirm the hostname matches the operator's P1 authorization exactly and is
not `DESKTOP-OKNV128`. Stop here if it does not match — do not proceed on an
unconfirmed machine.

**Evidence:** console transcript of the hostname/OS query.
**Satisfies:** Card "Environment" clause; True gate precondition.

## Step 2 — Dry-run install (zero mutation)

```powershell
$Report = & "installer\bridge\Install-RevAgentBridge.ps1" `
  -PackageRoot "<path to the extracted signed payload>" `
  -TrustedKeysPath "<path to trusted-keys.json>" `
  -EnrollmentToken "<the P-ENROLL-1 token>" `
  -EnrollmentTokenExpiresAtUtc (Get-Date "<token expiry, UTC>") `
  -RevitVersion "2022" `
  -GatewayHostName "<gateway.dpe.internal-style DNS name, never an IP>" `
  -MachineReportPath "C:\Temp\eu20-install-dryrun-report.json" `
  -DryRun
$Report.status               # expect: success
$Report.steps | Format-Table # expect: every mutating step 'skipped_dry_run'
```

Confirm no `C:\Program Files\revAgent`, `C:\ProgramData\revAgent`, or
`C:\ProgramData\Autodesk\Revit\Addins\2022\revAgent.addin` were created.

**Evidence:** `eu20-install-dryrun-report.json`, directory-listing
before/after showing no new paths.
**Satisfies:** Deliverable A ("dry-run performs zero mutations"); Acceptance
"uninstaller dry-run" sibling clause for install.

## Step 3 — Committed install (true gate)

Remove `-DryRun` from Step 2's command. This is the first machine-mutating
action and requires the P1 authorization to be in force.

**Evidence:** `eu20-install-report.json` with `status: "success"`; every
step `applied`, `verified`, or an idempotency `skipped_*` reason.
**Satisfies:** P-INST-1 (disjoint roots), P3-T2 (service install), P3-T9
(installer end state).

## Step 4 — Expected roots and ACLs

```powershell
Test-Path "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe"
Test-Path "C:\Program Files\revAgent\Bridge\versions\current\revagent-bridge.exe"
Test-Path "C:\ProgramData\revAgent\bridge\bridge-config.json"
Test-Path "C:\ProgramData\revAgent\bridge\credentials"
icacls "C:\ProgramData\revAgent\bridge\credentials"
icacls "C:\Program Files\revAgent\Bridge"
```

Confirm the credential directory's ACL is protected with exactly SYSTEM +
BUILTIN\Administrators FullControl (no other principal), and the install
root/add-in root are protected with SYSTEM + Administrators FullControl plus
BUILTIN\Users ReadAndExecute.

**Evidence:** `icacls` output captured to the session log.
**Satisfies:** P-INST-1; P3-T8 (device-token storage root).

## Step 5 — One-time enrollment

Enrollment is driven by Step 3 itself: the installer writes
`C:\ProgramData\revAgent\bridge\credentials\enrollment.json` (the exact M4
artifact contract `BridgeEnrollmentArtifactConsumer` expects) before
starting the service. On first start the bridge worker consumes and deletes
that file and persists a DPAPI-protected device credential.

```powershell
Get-Service revAgentBridge
Test-Path "C:\ProgramData\revAgent\bridge\credentials\enrollment.json"   # expect: False (consumed)
Test-Path "C:\ProgramData\revAgent\bridge\credentials\device-credential.dpapi"  # expect: True
& "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe" doctor
```

`doctor` output must show a device id/machine fingerprint (non-secret) and
no enrollment error.

**Evidence:** `doctor` console output; artifact-absence check.
**Satisfies:** P-ENROLL-1, P3-T8 acceptance ("fresh machine enrolls with a
single-use token").

## Step 6 — Token reuse is rejected

Re-run Step 2's dry-run command again with the **same** token and expiry
(now already consumed). Expect the installer to report
`install.alreadyEnrolled = true` and skip enrollment — the token is not
re-sent to the Gateway. If a genuinely fresh single-use-token-reuse probe is
required, that is a Gateway-side (EU-11) test, not this installer's surface.

**Evidence:** report showing `alreadyEnrolled: true`,
`enrollmentAttempted: false`.
**Satisfies:** P3-T8 acceptance ("token reuse rejected").

## Step 7 — Gateway session registration (Bridge connect)

```powershell
& "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe" doctor
```

Confirm `doctor` reports the Gateway connection as established (WSS primary
or the capability-gated fallback) and the local add-in TCP client's bounded
port scan found the running Revit 2022 add-in session.

**Evidence:** `doctor` output.
**Satisfies:** P3-T4 (session registration); the card's "remote MCP
registration" outcome bullet — see **Decision** below.

> **Decision (scope boundary):** "remote MCP client registration" in this
> step means the Bridge registering its own session with the Gateway
> (P3-T4/O3 device+session flow), verified via `doctor`. It does **not**
> include re-registering the ChatGPT/Codex Desktop application's remote MCP
> URL against the Gateway north surface — that is WP9/P-CODEX-1's own
> procedure (`docs/implementation-plan/03-bridge-addin-installer.md`
> P-CODEX-1, P3-T14), owned separately and explicitly out of EU-20/P3-T9's
> row in the work breakdown.

## Step 8 — One live Revit read (true gate)

With Revit 2022 open on the lab machine and a document loaded, drive one
read-only invocation through the connected session (e.g. the equivalent of
`get_current_view_info`) from the Gateway side / a connected MCP client.

**Evidence:** the tool response payload (redacted of any project-sensitive
content as appropriate) plus the Bridge's structured log line showing the
round trip.
**Satisfies:** Card "Outcome" ("one live read"); P3-T9 acceptance
("bridge connected + one round-trip tool call").

## Step 9 — Idempotent re-run

Re-run Step 3's **committed** install command unchanged (same PackageRoot,
same/no token).

```powershell
$Report2 = & "installer\bridge\Install-RevAgentBridge.ps1" -PackageRoot ... -TrustedKeysPath ... -MachineReportPath "C:\Temp\eu20-install-rerun-report.json"
$Report2.status                          # expect: success
$Report2.install.alreadyEnrolled         # expect: True
$Report2.install.serviceAlreadyInstalled # expect: True
```

Confirm the service was not re-registered and no new enrollment artifact was
written; the manifest/binaries may be safely rewritten (deterministic
content, same hash).

**Evidence:** `eu20-install-rerun-report.json`.
**Satisfies:** P3-T9 acceptance ("re-run is a no-op").

## Step 10 — Uninstall dry-run

```powershell
$UninstallDryRun = & "installer\bridge\Uninstall-RevAgentBridge.ps1" `
  -CodexConfigPath "<path to the machine's Codex config.toml>" `
  -MachineReportPath "C:\Temp\eu20-uninstall-dryrun-report.json" `
  -DryRun
$UninstallDryRun.status                    # expect: success
$UninstallDryRun.uninstall.anchors | Format-Table  # expect: all preserved=true
```

**Evidence:** `eu20-uninstall-dryrun-report.json`.
**Satisfies:** Card Acceptance "uninstaller dry-run".

## Step 11 — Committed uninstall (true gate, lab removal)

Remove `-DryRun`.

**Evidence:** `eu20-uninstall-report.json` (`wipe-report.json`-equivalent)
with per-item found/removed/kept/failed dispositions.
**Satisfies:** P-INST-3, P3-T10 acceptance.

## Step 12 — Anchor verification

```powershell
Test-Path "C:\ProgramData\DPE\revAgent\bootstrap"
Test-Path "C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1"
Test-Path "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
Get-FileHash "C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1"
Get-FileHash "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
```

Compare hashes against the pre-uninstall baseline captured before Step 11.
All three must be present and byte-identical; the uninstall report's
`uninstall.anchors[].preserved` must be `true` for all three (the script
throws — status `failed` — if any anchor changed, so `status: success`
already proves this, but re-verify independently).

**Evidence:** hash comparison; report `anchors` array.
**Satisfies:** P-SEQ-2; Card Acceptance "rollback anchors preserved".

## Step 13 — Unrelated user configuration untouched

Diff the target machine's Codex `config.toml` before/after Step 11 (outside
the two managed `[mcp_servers.revAgent]` / `[mcp_servers.revAgent-api-docs]`
sections) and confirm no other section, `AGENTS.md`, skill directory, or
PowerShell profile content changed. The uninstall script's own
`unchangedElsewhere` flag in `uninstall.codexConfig` proves this
structurally (the script throws otherwise), but a manual diff is the
independent check.

**Evidence:** `diff` output (or equivalent) showing zero unrelated changes.
**Satisfies:** Card Acceptance "unrelated user config untouched"; R4.

## Step 14 — Report collection

Collect into the session evidence folder:

- `eu20-install-dryrun-report.json`, `eu20-install-report.json`,
  `eu20-install-rerun-report.json`
- `eu20-uninstall-dryrun-report.json`, `eu20-uninstall-report.json`
- `doctor` console transcripts from Steps 5, 7
- The Step 8 live-read evidence
- The Step 12/13 hash and diff evidence

Validate every report JSON against `config/bridge-machine-report.schema.json`
before filing it as gate evidence.

**Satisfies:** Card Acceptance "machine report and exact review/checks
green".

---

## True gate request

This runbook cannot be executed to completion by an autonomous agent. Two
explicit operator authorizations are required before Steps 3, 5-9, and
11-13 may run:

1. **Machine selection / destructive lab authorization.** Name the exact
   disposable Windows/Revit 2022 lab machine for this session (not
   `PETRUCCI` unless separately confirmed disposable; never
   `DESKTOP-OKNV128`), and confirm the operator accepts that Steps 3 and
   11 install a Windows service, write to `C:\Program Files` and
   `C:\ProgramData`, and remove the legacy stack named in P-INST-3 on that
   machine.
2. **Bounded live Revit read authorization.** Confirm Revit 2022 may be
   opened with a specific (named, non-sensitive) document on the lab
   machine for Step 8's one read-only round trip, and name the Gateway/MCP
   client that will drive it.

Until both are granted, this document remains a plan; EU-20's repo
preparation (installer script, uninstaller script, tests, this runbook,
and the machine-report schema) is complete and gated behind these two
approvals.

## Rollback reference

If Step 3 or Step 11 leaves the machine in an unexpected state, the
existing frozen NAS-restore procedure remains the fallback (Section 8 step
4 of the target architecture; `docs/ROLLBACK_CRITERION_DRAFT.md`). This
package does not introduce a new rollback mechanism; it only guarantees
(via Step 12) that the anchors that procedure depends on were never
touched.
