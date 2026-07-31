<#
.SYNOPSIS
    Unit tests for the fail-closed CI change classifier.

.DESCRIPTION
    Dot-sources scripts/ci-classify-changes.ps1 (which exposes its pure
    decision function without executing the classification) and runs a table
    of (file list -> expected run_rbp) cases covering rules R1-R6 plus mixed
    and unknown paths. Reasons are asserted too so a regression that keeps the
    boolean but changes the matched rule (for example packages/gateway-stub
    matching the packages/gateway trigger) is still caught.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$classifierPath = Join-Path $RepoRoot "scripts\ci-classify-changes.ps1"
if (-not (Test-Path -LiteralPath $classifierPath -PathType Leaf)) {
    throw "Missing classifier script: $classifierPath"
}

. $classifierPath

$cases = @(
    # R1: empty diff is unclassifiable -> run everything.
    [pscustomobject]@{ Name = "R1 empty file list";            Files = @();                                              Expected = $true;  Reason = "empty-diff" }
    [pscustomobject]@{ Name = "R1 whitespace-only entries";    Files = @("", "   ");                                     Expected = $true;  Reason = "empty-diff" }

    # R3: trust set -> run everything.
    [pscustomobject]@{ Name = "R3 workflow file";              Files = @(".github/workflows/ci.yml");                    Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 any .github path";           Files = @(".github/dependabot.yml");                      Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 the classifier itself";      Files = @("scripts/ci-classify-changes.ps1");             Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 any scripts path";           Files = @("scripts/test-bridge-service.ps1");             Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 root package.json";          Files = @("package.json");                                Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 root package-lock.json";     Files = @("package-lock.json");                           Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 root tsconfig.base.json";    Files = @("tsconfig.base.json");                          Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "R3 root eslint.config.js";      Files = @("eslint.config.js");                            Expected = $true;  Reason = "trust" }

    # R6: trigger set -> run everything.
    [pscustomobject]@{ Name = "R6 rbp-conformance";            Files = @("packages/rbp-conformance/tests/globalSetup.ts"); Expected = $true; Reason = "trigger" }
    [pscustomobject]@{ Name = "R6 protocol";                   Files = @("packages/protocol/src/index.ts");              Expected = $true;  Reason = "trigger" }
    [pscustomobject]@{ Name = "R6 gateway";                    Files = @("packages/gateway/src/server.ts");              Expected = $true;  Reason = "trigger" }

    # R4: skip classes, alone and combined -> skip rbp.
    [pscustomobject]@{ Name = "R4 docs markdown";              Files = @("docs/decisions/DP-log.md");                    Expected = $false; Reason = "skip-classes" }
    [pscustomobject]@{ Name = "R4 docs top-level markdown";    Files = @("docs/README.md");                              Expected = $false; Reason = "skip-classes" }
    [pscustomobject]@{ Name = "R4 bridge C#";                  Files = @("packages/bridge/RevAgent.Bridge/Service.cs");  Expected = $false; Reason = "skip-classes" }
    [pscustomobject]@{ Name = "R4 installer";                  Files = @("installer/runtime-mcp-server/src/index.ts");   Expected = $false; Reason = "skip-classes" }
    [pscustomobject]@{ Name = "R4 all skip classes combined";  Files = @("docs/a.md", "packages/bridge/x.cs", "installer/y.ps1"); Expected = $false; Reason = "skip-classes" }

    # Mixed: any trust/trigger/unknown path outweighs skip classes.
    [pscustomobject]@{ Name = "Mixed docs + protocol";         Files = @("docs/a.md", "packages/protocol/x.ts");         Expected = $true;  Reason = "trigger" }
    [pscustomobject]@{ Name = "Mixed bridge + scripts";        Files = @("packages/bridge/x.cs", "scripts/test-ci.ps1"); Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "Mixed installer + workflow";    Files = @("installer/y.ps1", ".github/workflows/ci.yml"); Expected = $true;  Reason = "trust" }
    [pscustomobject]@{ Name = "Mixed docs + unknown";          Files = @("docs/a.md", "src/revit-plugin/Foo.cs");        Expected = $true;  Reason = "unrecognized" }

    # R2: default deny for anything unrecognized.
    [pscustomobject]@{ Name = "R2 revit plugin source";        Files = @("src/revit-plugin/Foo.cs");                     Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 root README.md not docs";    Files = @("README.md");                                   Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 non-markdown under docs";    Files = @("docs/notes.txt");                              Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 evals metadata";             Files = @("evals/evals.json");                            Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 brand-new packages dir";     Files = @("packages/new-workspace/index.ts");             Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 backslash path not skipped"; Files = @("docs\guide\intro.md");                         Expected = $true;  Reason = "unrecognized" }

    # R2 boundary: globalSetup-dependency workspaces are NOT skip classes and
    # must fall through to default deny, not match bridge/gateway prefixes.
    [pscustomobject]@{ Name = "R2 bridge-simulator not bridge"; Files = @("packages/bridge-simulator/src/x.ts");         Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 gateway-stub not gateway";   Files = @("packages/gateway-stub/src/x.ts");              Expected = $true;  Reason = "unrecognized" }
    [pscustomobject]@{ Name = "R2 addin-loopback-fixture";     Files = @("packages/addin-loopback-fixture/src/x.ts");    Expected = $true;  Reason = "unrecognized" }
)

$failures = @()
foreach ($case in $cases) {
    $decision = Get-CiRbpDecision -Files $case.Files
    if ($decision.RunRbp -ne $case.Expected) {
        $failures += "[$($case.Name)] expected run_rbp=$($case.Expected) but got $($decision.RunRbp) for files: $($case.Files -join ', ')"
        continue
    }
    if ($decision.Reason -ne $case.Reason) {
        $failures += "[$($case.Name)] expected reason '$($case.Reason)' but got '$($decision.Reason)' for files: $($case.Files -join ', ')"
        continue
    }
    if (-not ($decision.Summary -is [string]) -or -not $decision.Summary.StartsWith("[scoped] ")) {
        $failures += "[$($case.Name)] summary must start with '[scoped] ' but was '$($decision.Summary)'"
    }
}

# Skip-decision summaries must name every skip class exactly once (R9 audit line).
$skipDecision = Get-CiRbpDecision -Files @("installer/y.ps1", "docs/a.md", "docs/b.md", "packages/bridge/x.cs")
if ($skipDecision.Summary -ne "[scoped] skipped rbp-conformance because only bridge-cs docs installer changed") {
    $failures += "[R9 skip summary] unexpected summary: '$($skipDecision.Summary)'"
}
$runDecision = Get-CiRbpDecision -Files @("packages/protocol/x.ts")
if ($runDecision.Summary -ne "[scoped] running everything (trigger/trust/unknown path in diff)") {
    $failures += "[R9 run summary] unexpected summary: '$($runDecision.Summary)'"
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw "CI classifier tests failed: $($failures.Count) of $($cases.Count + 2) assertions."
}

Write-Host "CI classifier tests passed ($($cases.Count) table cases + 2 summary assertions)." -ForegroundColor Green
