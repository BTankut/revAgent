[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$workflowRoot = Join-Path $resolvedRoot '.github\workflows'
if (-not (Test-Path -LiteralPath $workflowRoot -PathType Container)) {
    throw "Workflow directory is missing: $workflowRoot"
}

function Get-ActionManifestFiles {
    param([string]$Root)

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    $files = [System.Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($entry.PSIsContainer) {
                if ($entry.Name -notin @('.git', 'node_modules')) {
                    $pending.Push($entry.FullName)
                }
                continue
            }

            if ($entry.Name -in @('action.yml', 'action.yaml')) {
                $files.Add($entry.FullName)
            }
        }
    }
    return $files
}

$filePaths = [System.Collections.Generic.List[string]]::new()
foreach ($file in @(Get-ChildItem -LiteralPath $workflowRoot -Recurse -File -Force -ErrorAction Stop | Where-Object {
            $_.Extension -in @('.yml', '.yaml')
        })) {
    $filePaths.Add($file.FullName)
}
foreach ($file in @(Get-ActionManifestFiles -Root $resolvedRoot)) {
    $filePaths.Add($file)
}

$relativeFiles = @(
    $filePaths |
        Sort-Object -Unique |
        ForEach-Object {
            [System.IO.Path]::GetRelativePath($resolvedRoot, $_).Replace('\', '/')
        } |
        Sort-Object
)

$errors = [System.Collections.Generic.List[string]]::new()
$externalCount = 0
$localCount = 0
$usesPattern = '^(?<indent>\s*)(?:-\s*)?uses\s*:\s*(?<value>.*)$'
$externalPattern = '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*@[0-9a-f]{40}$'
$localPattern = '^\./[A-Za-z0-9._/-]+$'

foreach ($relativePath in $relativeFiles) {
    $absolutePath = Join-Path $resolvedRoot ($relativePath.Replace('/', '\'))
    $lineNumber = 0
    foreach ($line in @(Get-Content -LiteralPath $absolutePath -ErrorAction Stop)) {
        $lineNumber++
        $match = [regex]::Match($line, $usesPattern)
        if (-not $match.Success) {
            continue
        }

        $rawValue = $match.Groups['value'].Value.Trim()
        $location = '{0}:{1}' -f $relativePath, $lineNumber
        if ([string]::IsNullOrWhiteSpace($rawValue) -or $rawValue -match '[|>\[\]{},&*"'']' -or $rawValue -match '\$\{\{') {
            $errors.Add("$location invalid uses value: multiline, ambiguous, quoted, or dynamic values are forbidden")
            continue
        }

        $valueMatch = [regex]::Match($rawValue, '^(?<token>\S+)(?:\s+#.*)?$')
        if (-not $valueMatch.Success) {
            $errors.Add("$location invalid uses value: exactly one literal token is required")
            continue
        }

        $token = $valueMatch.Groups['token'].Value
        if ($token -match '^\./') {
            if ($token -notmatch $localPattern -or $token -match '(^|/)\.\.(/|$)') {
                $errors.Add("$location invalid local uses path: $token")
            }
            else {
                $localCount++
            }
            continue
        }

        if ($token -match $externalPattern) {
            $externalCount++
            continue
        }

        $errors.Add("$location invalid external uses reference: $token; expected owner/repo@lowercase-40-hex or ./local-path")
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    throw "Immutable GitHub Action pin validation failed with $($errors.Count) violation(s)."
}

Write-Host "Immutable GitHub Action pins passed: external=$externalCount local=$localCount files=$($relativeFiles.Count)."
