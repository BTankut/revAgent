# HANDOFF — C1 Updater Hotfix (for Windows Claude Code)

> **You (the Windows Claude Code) are running on the real development machine** that has the actual local repo, Windows PowerShell, and Revit. The brief was prepared on a disconnected macOS clone that has **no pwsh and no Revit**, so it could not run the `.ps1` test suites. **You can and MUST run them.** This document is fully self-contained — you do not need any other file.

---

## 0. How to do this — methodology

Execute this with **Subagent-Driven Development** (`superpowers:subagent-driven-development`): dispatch a fresh implementer subagent for the single task below, then a spec-compliance review, then a code-quality review, fixing until both pass. Then finish the branch.

**Hard rules:**
- **Do NOT work on `main`.** Create the feature branch in Section 2 first.
- **Run the real PowerShell tests** (Section 3, Steps 2/4/5). Do not skip them — this is a fail-closed/availability bug and the tests are the safety net.
- Match the code blocks below **by content**, not by line number.
- Commit only when tests pass. Push / open the PR only per Section 5 (confirm with the human first if unsure).

---

## 1. Background — what we're fixing and why

An audit of the un-reviewed PRs #74–#101 found that **PR #101 introduced a HIGH-severity regression** in the updater's trusted-key auto-discovery. (External/supply-chain hardening — bootstrap key pinning, Authenticode, HSM/KMS, TUF — is **intentionally deferred** to a future commercial-security track; the pilot runs on an isolated single-office network with trusted NAS + local-admin. This fix is **not** an external-threat mitigation; it is a functional bug that breaks the team's own enforce-mode update path.)

**The bug.** In `installer/nas/update-from-nas.ps1`, function `Initialize-DistributionIntegrityConfig` loads trusted release keys from two sources:
1. `updater-config.json` → `trustedKeysPath` / `trustedKeyPaths`
2. an auto-discovery sweep of `config\release-trusted-keys.json` in three roots.

PR #101 added an emptiness guard that throws when a discovered file adds **no new keys to the cumulative set**:
```powershell
$beforeCount = $trustedKeys.Count
$sourcePath  = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate -Required
if ($trustedKeys.Count -le $beforeCount) { ...throw "did not contain any trusted keys"... }
```
Keys are stored in a hashtable keyed by `keyId`, so re-loading the same file overwrites without growing `.Count`.

**Why it breaks the standard install.** `installer/nas/install-updater-task.ps1` writes
`distributionIntegrity.trustedKeysPath = $WorkRoot\config\release-trusted-keys.json`
— which is the **same file** as auto-discovery candidate #1
(`Join-Path $WorkRoot "config\release-trusted-keys.json"`). So at runtime:
1. the configured-path loader loads it → `Count = 1`
2. the auto-discovery loop reloads the **same** file → `Count` stays `1`
3. `Count -le beforeCount` is **true** → **throws `trusted_keys_empty`**

**Impact:** every enforce-mode workstation (the ones that received the signing/keys) **hard-fails its next update**. Latent only because keys-absent (compatibility) workstations don't have keys yet; the moment keys are deployed, updates stop.

**The fix (this task):** judge emptiness **per file** (using the loader's own parsed key count) and **skip candidates whose resolved path was already consumed** by an earlier loader. Keep failing closed for genuinely corrupt or genuinely empty/keyless files.

---

## 2. Pre-flight

```bash
# from the repo root on the Windows machine
git fetch origin
git checkout main
git merge --ff-only origin/main            # main should be at 2328221 (PR #101 merged)
git rev-parse HEAD                          # expect: 232822169545daa74e1327ba161abfca21f08321
git checkout -b fix/updater-c1-key-discovery-regression
```
If `main` is ahead of `2328221`, that's fine — branch off current `main`; the code blocks below are content-anchored.

---

## 3. The task — per-file emptiness + consumed-path dedup (TDD)

**Files:**
- Modify: `installer/nas/update-from-nas.ps1` (functions `Add-TrustedReleaseKeysFromFile`, `Initialize-DistributionIntegrityConfig`)
- Test: `scripts/test-installer-smoke.ps1`

### Step 1 — Write the failing test

In `scripts/test-installer-smoke.ps1`, insert these three assertions immediately **after** the existing assertion whose message ends with `"...trusted release keys make unsigned compatibility impossible."` (it matches `$trustedKeys\.Count -gt 0 -and \[string\]::Equals\(\$policy, "compatibility"`) and **before** the next line `$distributionInitIndex = $updateText.IndexOf('Initialize-DistributionIntegrityConfig -Config $config')`:

```powershell
    Assert-True ($updateText -notmatch '\$trustedKeys\.Count -le \$beforeCount') "Updater must not judge auto-discovered key files empty by cumulative count (C1 regression: collides with configured trustedKeysPath)."
    Assert-True ($updateText -match '\$consumedKeyPaths') "Updater must track already-consumed trusted-key file paths to skip duplicate auto-discovery candidates."
    Assert-True ($updateText -match '\.KeyCount -le 0') "Updater must judge auto-discovered key files empty by that file's own parsed key count."
```

### Step 2 — Run it; confirm it FAILS

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-installer-smoke.ps1 -RepoRoot .
```
Expected: FAIL — the first new assertion fails because the source still contains `$trustedKeys.Count -le $beforeCount`.

### Step 3 — Apply the implementation changes

**Change A — `Add-TrustedReleaseKeysFromFile` returns the per-file key count.**
In `installer/nas/update-from-nas.ps1`, the success path of `Add-TrustedReleaseKeysFromFile` currently ends with:
```powershell
    [void](Add-TrustedReleaseKeys -Target $Target -Source $trustedKeys)
    return $fullPath
```
Replace those two lines with:
```powershell
    $keyCount = Add-TrustedReleaseKeys -Target $Target -Source $trustedKeys
    return [pscustomobject]@{ Path = $fullPath; KeyCount = [int]$keyCount }
```
Leave the two early `return $null` paths (empty `$Path`; not-found-when-not-`$Required`) UNCHANGED.

**Change B — declare the consumed-path set.**
In `Initialize-DistributionIntegrityConfig`, immediately after the line
`$sources = [System.Collections.Generic.List[string]]::new()` add:
```powershell
    $consumedKeyPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
```

**Change C — configured `trustedKeysPath` caller.** Find:
```powershell
            try {
                $sourcePath = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path $trustedKeysPath
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if (-not [string]::IsNullOrWhiteSpace($sourcePath)) {
                [void]$sources.Add($sourcePath)
            }
```
Replace with (only the `try` first line and the trailing `if` change):
```powershell
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path $trustedKeysPath
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
```

**Change D — `trustedKeyPaths` array caller.** Find:
```powershell
            try {
                $sourcePath = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path ([string]$path) -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path ([string]$path)
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if (-not [string]::IsNullOrWhiteSpace($sourcePath)) {
                [void]$sources.Add($sourcePath)
            }
```
Replace with:
```powershell
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path ([string]$path) -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path ([string]$path)
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
```

**Change E — rewrite the auto-discovery loop.** Find:
```powershell
    foreach ($candidate in @(
            (Join-Path $WorkRoot "config\release-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\release-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\release-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $beforeCount = $trustedKeys.Count
        try {
            $sourcePath = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate -Required
        }
        catch {
            $message = "Auto-discovered trusted release keys could not be loaded from '$candidate'. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_invalid" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        if ($trustedKeys.Count -le $beforeCount) {
            $message = "Auto-discovered trusted release keys file '$candidate' did not contain any trusted keys. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_empty" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        if (-not [string]::IsNullOrWhiteSpace($sourcePath)) {
            [void]$sources.Add($sourcePath)
        }
    }
```
Replace ENTIRELY with:
```powershell
    foreach ($candidate in @(
            (Join-Path $WorkRoot "config\release-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\release-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\release-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $candidateFullPath = [System.IO.Path]::GetFullPath($candidate)
        if ($consumedKeyPaths.Contains($candidateFullPath)) {
            continue
        }
        try {
            $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate -Required
        }
        catch {
            $message = "Auto-discovered trusted release keys could not be loaded from '$candidate'. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_invalid" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        if ($null -eq $loaded -or $loaded.KeyCount -le 0) {
            $message = "Auto-discovered trusted release keys file '$candidate' did not contain any trusted keys. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_empty" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        [void]$consumedKeyPaths.Add($candidateFullPath)
        [void]$consumedKeyPaths.Add($loaded.Path)
        [void]$sources.Add($loaded.Path)
    }
```

What this preserves vs. fixes:
- **Fixes** the standard collision — candidate #1 is skipped because the configured `trustedKeysPath` already consumed that exact resolved path → no false `trusted_keys_empty`.
- **Fixes** a distinct-but-duplicate-key file — emptiness now uses `$loaded.KeyCount` (keys parsed from *that* file).
- **Keeps** fail-closed on corrupt (`trusted_keys_invalid`) and genuinely empty/keyless (`trusted_keys_empty`) files.
- **Keeps** a genuinely-absent file as a benign skip.

### Step 4 — Run the smoke test; confirm it PASSES

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-installer-smoke.ps1 -RepoRoot .
```
Expected: PASS — all three new assertions satisfied; existing assertions still pass.

### Step 5 — Run the regression suites

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-distribution-integrity.ps1 -RepoRoot .
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-ci.ps1 -RepoRoot .
```
Expected: PASS. `test-ci.ps1` is the project's gate; it must be green.

### Step 6 — (Recommended) behavioural sanity check of the real collision

Confirm the exact failing scenario is gone and a truly-empty file still fails closed. In an isolated scratch dir, build a config where `trustedKeysPath` equals auto-discovery candidate #1 and assert init does NOT throw with one key, then DOES throw `trusted_keys_empty` after replacing the file contents with `{}`. (You have pwsh + the real functions — exercise `Initialize-DistributionIntegrityConfig` however is cleanest in this repo; if the function isn't import-isolated, a focused harness or a careful trace is acceptable, but prefer real execution.)

### Step 7 — Commit

```bash
git add installer/nas/update-from-nas.ps1 scripts/test-installer-smoke.ps1
git commit -m "fix(updater): judge auto-discovered trusted-key files empty per-file, dedup consumed paths

PR #101's cumulative-count emptiness guard threw on the standard install where
distributionIntegrity.trustedKeysPath equals auto-discovery candidate #1
(\$WorkRoot\config\release-trusted-keys.json), hard-blocking updates on every
enforce-mode workstation. Now skips already-consumed paths and judges emptiness
by each file's own parsed key count; corrupt/empty files still fail closed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 4. Two-stage review (subagent-driven)

After the implementer reports DONE:
1. **Spec-compliance review** — a fresh subagent checks the change matches this brief exactly (per-file count + dedup; the three asserts; nothing extra; existing asserts intact). Fix any gap, re-review.
2. **Code-quality review** — a fresh subagent checks PowerShell correctness: brace balance, `$loaded` used consistently, no stray `$sourcePath`/`$beforeCount` left in the edited blocks, `Add-TrustedReleaseKeysFromFile` still returns `$null` on its early paths, all three callers updated. Fix, re-review.

Only proceed when both are clean **and** Section 3 tests are green.

---

## 5. Finish

```bash
git push -u origin fix/updater-c1-key-discovery-regression
gh pr create --base main --title "fix(updater): C1 key-discovery regression (per-file emptiness + dedup)" \
  --body "Fixes the PR #101 regression that hard-blocked updates on enforce-mode workstations where distributionIntegrity.trustedKeysPath equals auto-discovery candidate #1. Per-file key-count emptiness + consumed-path dedup; corrupt/empty files still fail closed. Tests: test-installer-smoke.ps1 (3 new asserts), test-distribution-integrity.ps1, test-ci.ps1 all green."
```
The PR will trigger the repo's Claude Code Review workflow (now runs on draft/non-fork PRs). Address any review notes, then merge.

---

## Appendix — context only (NOT part of this task)

**On-mission / reliability backlog (separate small PRs later):**
- **F11** — unify cleanup logic: `installer/install-self-contained.ps1` duplicates the rules in `installer/lib/RevitMcp.SourceFreeMigration.psm1`; drift could leave source/dev artifacts on a workstation (against the source-free goal).
- **F20** — migration deletes user/source artifacts before the install completes with no rollback (data-loss risk in the office).
- **F28** — add `<DebugType>none</DebugType>` / `<DebugSymbols>false</DebugSymbols>` to `revit-mcp-plugin.csproj` and `RevitMCPCommandSet.csproj` so .NET symbols are never produced for release builds (currently only scrubbed reactively).

**Deferred — commercial security roadmap (risk-accepted for the isolated pilot):** bootstrap key fingerprint pinning out-of-band (F4/F5), signed installer/updater binaries, verifier self-integrity, Authenticode, HSM/KMS key storage, TUF-like metadata/rotation, license hardening (F17–F19), review-gate blocking (F12). Keep docs from claiming tamper-resistance the current NAS-rooted trust model doesn't yet provide.
