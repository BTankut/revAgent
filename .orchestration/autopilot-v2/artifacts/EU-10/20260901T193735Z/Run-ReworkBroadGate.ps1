[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$NodeBin
)
$ErrorActionPreference = "Stop"
$artifactRoot = $PSScriptRoot
$rawPath = Join-Path $artifactRoot "broad-rework-final.raw.log"
$evidencePath = Join-Path $artifactRoot "broad-rework-final.json"
$temporaryRawPath = Join-Path ([System.IO.Path]::GetTempPath()) "revagent-eu10-broad-$PID.raw.log"
$started = (Get-Date).ToUniversalTime()
$nodeExe = Join-Path $NodeBin "node.exe"
$nodeVersion = (& $nodeExe --version).Trim()
$npmVersion = (& $nodeExe "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" --version).Trim()
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$npmCli = "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
$psi.FileName = $nodeExe
$psi.WorkingDirectory = $RepoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.ArgumentList.Add($npmCli)
$psi.ArgumentList.Add("test")
$psi.Environment["Path"] = "$NodeBin;$([Environment]::GetEnvironmentVariable('Path'))"
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $psi
if (-not $process.Start()) { throw "failed to start broad gate" }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
$raw = $stdout + $(if ($stderr) { "`n--- STDERR ---`n$stderr" } else { "" })
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($temporaryRawPath, $raw, $utf8)
$testMatches = [regex]::Matches($raw, '(?m)^\s*Tests\s+(?:(?<failed>\d+) failed\s*\|\s*)?(?<passed>\d+) passed(?:\s*\|\s*(?<skipped>\d+) skipped)?')
$fileMatches = [regex]::Matches($raw, '(?m)^\s*Test Files\s+(?:(?<failed>\d+) failed\s*\|\s*)?(?<passed>\d+) passed(?:\s*\|\s*(?<skipped>\d+) skipped)?')
if ($testMatches.Count -eq 0 -or $fileMatches.Count -eq 0) { throw "broad gate produced no parseable test totals" }
function Sum-Group([System.Text.RegularExpressions.MatchCollection]$Matches, [string]$Name) {
    $sum = 0
    foreach ($match in $Matches) {
        $value = $match.Groups[$Name].Value
        if ($value) { $sum += [int]$value }
    }
    return $sum
}
$completed = (Get-Date).ToUniversalTime()
$sha256 = [System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($temporaryRawPath))
$evidence = [ordered]@{
    schema = "revagent.autopilot.eu10-broad-gate/v1"
    command = "npm test"
    workingDirectory = [System.IO.Path]::GetFullPath($RepoRoot)
    nodeVersion = $nodeVersion
    npmVersion = $npmVersion
    startedAtUtc = $started.ToString("o")
    completedAtUtc = $completed.ToString("o")
    durationMs = [int64]($completed - $started).TotalMilliseconds
    exitCode = $process.ExitCode
    success = ($process.ExitCode -eq 0)
    testTotals = [ordered]@{
        passed = Sum-Group $testMatches "passed"
        failed = Sum-Group $testMatches "failed"
        skipped = Sum-Group $testMatches "skipped"
    }
    testFileTotals = [ordered]@{
        passed = Sum-Group $fileMatches "passed"
        failed = Sum-Group $fileMatches "failed"
        skipped = Sum-Group $fileMatches "skipped"
    }
    rawLog = "broad-rework-final.raw.log"
    rawLogSha256 = [Convert]::ToHexString($sha256).ToLowerInvariant()
}
[System.IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Depth 5) + "`n", $utf8)
[System.IO.File]::Copy($temporaryRawPath, $rawPath, $true)
Remove-Item -LiteralPath $temporaryRawPath -Force
Write-Host "EU10_BROAD_GATE_EXIT=$($process.ExitCode) TESTS=$($evidence.testTotals.passed)/$($evidence.testTotals.failed)/$($evidence.testTotals.skipped)"
exit $process.ExitCode
