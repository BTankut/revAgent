<#
.SYNOPSIS
    Fail-closed change classifier for scoped Gateway gates.

.DESCRIPTION
    Decides whether the RBP conformance suite must run for the current CI event
    and emits `run_rbp=<true|false>` plus a human-readable `summary=` line to
    $GITHUB_OUTPUT. Every decision is logged as a single "[scoped] ..." line.

    Rules (fail-closed by construction):
      R1  Only pull_request events are classifiable. push, workflow_dispatch,
          any other event, a missing/failed fetch or merge base, a failed diff,
          or an empty diff always run everything.
      R2  DEFAULT DENY: any path not explicitly recognized below runs
          everything.
      R3  Trust set: .github/**, scripts/** (including this script), and the
          root manifests package.json / package-lock.json / tsconfig.base.json
          / eslint.config.js always run everything.
      R4  Skip classes: only docs/**/*.md, packages/bridge/** (C# bridge), and
          installer/** may combine to skip the RBP conformance suite. Nothing
          else may.
      R6  Trigger set: packages/rbp-conformance/**, packages/protocol/**, and
          packages/gateway/** always run everything.
      R8  Scoping MUST stay at step level: this classifier feeds exactly one
          step-level `if: steps.classify.outputs.run_rbp == 'true'` in
          .github/workflows/ci.yml. Never move the condition to a
          workflow-level `paths:` filter (the required "Gateway gates" context
          would never report and the PR blocks forever - RES-32,
          docs/decisions/DP-log.md, PR #310) and never move it to a job-level
          `if:` (GitHub reports a skipped job as Success, which SATISFIES a
          required check - silent fail-open).
      R9  Every decision is logged as one "[scoped] ..." line and re-echoed by
          the always-run "Report scope decision" step via the `summary` output.

    packages/bridge-simulator, packages/gateway-stub, and
    packages/addin-loopback-fixture are intentionally NOT skip classes:
    whether rbp-conformance's globalSetup consumes their build outputs is
    unverified, so they fall through to R2 default-deny. Extend the skip set
    only after auditing packages/rbp-conformance/tests/globalSetup.ts imports.

    Matching is deliberately asymmetric: run-everything rules (trust, trigger)
    match case-insensitively (broader = more conservative), skip-class rules
    match case-sensitively (narrower = more conservative).

    The pure decision logic lives in Get-CiRbpDecision (file list in, decision
    out; no git, no environment). Git acquisition is separated into
    Get-CiChangedFiles. Dot-source this script to load the functions without
    executing the classification (scripts/test-ci-classifier.ps1 does this).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:CiRootManifests = @(
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "eslint.config.js"
)

function Get-CiRbpDecision {
    <#
    .SYNOPSIS
        Pure classification: changed-file list in, scope decision out.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]
        [AllowEmptyCollection()]
        [string[]]$Files
    )

    $fileList = @($Files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($fileList.Count -eq 0) {
        # R1: an empty diff is unclassifiable -> run everything.
        return [pscustomobject]@{
            RunRbp  = $true
            Reason  = "empty-diff"
            Classes = @()
            Summary = "[scoped] running everything (empty diff)"
        }
    }

    $hasTrust = $false
    $hasTrigger = $false
    $hasUnrecognized = $false
    $classes = @()

    foreach ($file in $fileList) {
        if ($file -match '^\.github/') { $hasTrust = $true }                                       # R3
        elseif ($file -match '^scripts/') { $hasTrust = $true }                                    # R3
        elseif ($file -in $script:CiRootManifests) { $hasTrust = $true }                           # R3
        elseif ($file -match '^packages/(rbp-conformance|protocol|gateway)/') { $hasTrigger = $true } # R6
        elseif ($file -cmatch '^docs/.*\.md$') { $classes += "docs" }                              # R4
        elseif ($file -cmatch '^packages/bridge/') { $classes += "bridge-cs" }                     # R4
        elseif ($file -cmatch '^installer/') { $classes += "installer" }                           # R4
        else { $hasUnrecognized = $true }                                                          # R2 default deny
    }

    $runRbp = $hasTrust -or $hasTrigger -or $hasUnrecognized
    $classes = @($classes | Sort-Object -Unique)

    if ($runRbp) {
        $reason = if ($hasTrust) { "trust" } elseif ($hasTrigger) { "trigger" } else { "unrecognized" }
        $summary = "[scoped] running everything (trigger/trust/unknown path in diff)"
    }
    else {
        $reason = "skip-classes"
        $summary = "[scoped] skipped rbp-conformance because only $($classes -join ' ') changed"
    }

    return [pscustomobject]@{
        RunRbp  = $runRbp
        Reason  = $reason
        Classes = $classes
        Summary = $summary
    }
}

function Get-CiChangedFiles {
    <#
    .SYNOPSIS
        Git acquisition, separated from the decision logic. Any failure is
        reported as Ok=$false so the caller can fail closed (run everything).
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$BaseRef
    )

    if ([string]::IsNullOrWhiteSpace($BaseRef)) {
        return [pscustomobject]@{
            Ok             = $false
            Files          = @()
            FailureSummary = "[scoped] running everything (no merge base)"
        }
    }

    try {
        # Fetch pattern proven at claude-review.yml:80. ci.yml checkouts may be
        # shallow (default fetch-depth), so unshallow first when needed or the
        # merge base cannot exist and every PR would fail closed to a full run.
        $isShallow = (& git rev-parse --is-shallow-repository 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Ok = $false; Files = @(); FailureSummary = "[scoped] running everything (no merge base)" }
        }
        if ($isShallow -eq "true") {
            & git fetch --no-tags --unshallow origin $BaseRef 2>&1 | Out-Null
        }
        else {
            & git fetch --no-tags origin $BaseRef 2>&1 | Out-Null
        }
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Ok = $false; Files = @(); FailureSummary = "[scoped] running everything (no merge base)" }
        }

        & git merge-base "origin/$BaseRef" HEAD 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Ok = $false; Files = @(); FailureSummary = "[scoped] running everything (no merge base)" }
        }

        $files = @(& git diff --name-only "origin/$BaseRef...HEAD" 2>$null)
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Ok = $false; Files = @(); FailureSummary = "[scoped] running everything (git diff failed)" }
        }

        return [pscustomobject]@{
            Ok             = $true
            Files          = @($files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            FailureSummary = ""
        }
    }
    catch {
        return [pscustomobject]@{
            Ok             = $false
            Files          = @()
            FailureSummary = "[scoped] running everything (git acquisition failed)"
        }
    }
}

function Write-CiScopeDecision {
    <#
    .SYNOPSIS
        Emit run_rbp and summary to $GITHUB_OUTPUT (when present) and log the
        "[scoped] ..." audit line.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [bool]$RunRbp,

        [Parameter(Mandatory = $true)]
        [string]$Summary
    )

    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
        Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "run_rbp=$($RunRbp.ToString().ToLowerInvariant())"
        Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "summary=$Summary"
    }
    Write-Host $Summary
}

# When dot-sourced (unit tests), expose the functions only.
if ($MyInvocation.InvocationName -eq ".") { return }

# R1: only pull_request events are classifiable; everything else runs everything.
if ($env:GITHUB_EVENT_NAME -ne "pull_request") {
    Write-CiScopeDecision -RunRbp $true -Summary "[scoped] running everything (non-PR event)"
    exit 0
}

$acquisition = Get-CiChangedFiles -BaseRef $env:GITHUB_BASE_REF
if (-not $acquisition.Ok) {
    Write-CiScopeDecision -RunRbp $true -Summary $acquisition.FailureSummary
    exit 0
}

$decision = Get-CiRbpDecision -Files $acquisition.Files
Write-CiScopeDecision -RunRbp $decision.RunRbp -Summary $decision.Summary
exit 0
