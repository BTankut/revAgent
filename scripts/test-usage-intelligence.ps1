[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$target = Join-Path $PSScriptRoot "..\addons\usage-intelligence\tests\test-usage-intelligence.ps1"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    & $target
}
else {
    & $target -RepoRoot $RepoRoot
}
