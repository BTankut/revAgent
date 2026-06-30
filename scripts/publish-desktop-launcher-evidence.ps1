<#
.SYNOPSIS
    Audit revAgent desktop launchers and publish rollout evidence.

.DESCRIPTION
    ScanLocal mode inspects local desktop launcher files and writes per-machine
    evidence under reports\machines\<machine>\desktop-launcher-latest.json.
    Aggregate mode combines per-machine evidence for the expected rollout
    machines and writes reports\rollout\desktop-launcher-latest.json.

    The script is read-only with respect to desktop files. It does not replace
    or delete launchers.
#>

[CmdletBinding()]
param(
    [ValidateSet("ScanLocal", "Aggregate")]
    [string]$Mode = "ScanLocal",

    [string]$ReportsRoot = "",

    [string]$ConfigPath = "",

    [string]$MachineName = "",

    [string[]]$ExpectedMachines = @(),

    [string[]]$OutOfScopeMachines = @(),

    [string[]]$LauncherPath = @(),

    [switch]$Recurse,

    [string]$OutputPath = "",

    [datetime]$NowUtc = [datetime]::MinValue,

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$defaultCanonicalReportsRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports"
$candidateExtensions = @(".cmd", ".bat", ".ps1", ".vbs", ".lnk", ".url")
$legacyRootPatterns = @("revit-mcp-deploy")
$canonicalRootPatterns = @("revAgent-deploy")
$legacyLauncherPatterns = @(
    "Revit MCP Updater STABLE",
    "Revit MCP",
    "Install-Revit-MCP",
    "Update-Revit-MCP",
    "Show-Revit-MCP",
    "Run-Revit-MCP",
    "RevitMCP",
    "C:\ProgramData\DPE\RevitMCP"
)
$productLauncherPatterns = @(
    "revAgent",
    "revAgent-deploy",
    "Install-revAgent-Updater",
    "Revit MCP",
    "RevitMCP",
    "revit-mcp-deploy"
)

if ($NowUtc -eq [datetime]::MinValue) {
    $NowUtc = (Get-Date).ToUniversalTime()
}
else {
    $NowUtc = $NowUtc.ToUniversalTime()
}

function Normalize-RevAgentMachineName {
    param([string]$Value)

    return ([string]$Value).Trim().ToUpperInvariant()
}

function ConvertTo-RevAgentSafePathSegment {
    param([string]$Value)

    $normalized = Normalize-RevAgentMachineName -Value $Value
    foreach ($invalid in [System.IO.Path]::GetInvalidFileNameChars()) {
        $normalized = $normalized.Replace([string]$invalid, "_")
    }
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "UNKNOWN"
    }
    return $normalized
}

function Get-RevAgentValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Read-RevAgentJsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}

function Expand-RevAgentMachineNames {
    param([object[]]$Values)

    $expanded = [System.Collections.Generic.List[string]]::new()
    foreach ($value in $Values) {
        if ($null -eq $value) {
            continue
        }

        $rawValue = ""
        if ($value -is [string]) {
            $rawValue = [string]$value
        }
        elseif ($value -is [System.Collections.IDictionary]) {
            foreach ($nameKey in @("name", "machine", "machineName", "computerName")) {
                if ($value.Contains($nameKey) -and -not [string]::IsNullOrWhiteSpace([string]$value[$nameKey])) {
                    $rawValue = [string]$value[$nameKey]
                    break
                }
            }
        }
        else {
            foreach ($nameKey in @("name", "machine", "machineName", "computerName")) {
                $property = $value.PSObject.Properties[$nameKey]
                if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                    $rawValue = [string]$property.Value
                    break
                }
            }
            if ([string]::IsNullOrWhiteSpace($rawValue)) {
                $rawValue = [string]$value
            }
        }

        if ([string]::IsNullOrWhiteSpace($rawValue)) {
            continue
        }

        foreach ($part in ($rawValue -split '[,;]')) {
            $normalized = Normalize-RevAgentMachineName -Value $part
            if (-not [string]::IsNullOrWhiteSpace($normalized)) {
                [void]$expanded.Add($normalized)
            }
        }
    }
    return @($expanded.ToArray() | Select-Object -Unique)
}

function Test-RevAgentTextContainsAny {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }
    foreach ($pattern in $Patterns) {
        if ($Text.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Select-RevAgentMatchedPatterns {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    $matches = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return @()
    }
    foreach ($pattern in $Patterns) {
        if ($Text.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$matches.Add($pattern)
        }
    }
    return @($matches.ToArray() | Select-Object -Unique)
}

function Get-RevAgentDefaultLauncherPaths {
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($folder in @("DesktopDirectory", "CommonDesktopDirectory")) {
        try {
            $specialFolder = [Enum]::Parse([Environment+SpecialFolder], $folder)
            $value = [Environment]::GetFolderPath($specialFolder)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                [void]$paths.Add($value)
            }
        }
        catch {
            continue
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        [void]$paths.Add((Join-Path $env:USERPROFILE "Desktop"))
    }
    return @($paths.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Get-RevAgentLauncherFiles {
    param(
        [string[]]$Paths,
        [switch]$Recursive
    )

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $files = [System.Collections.Generic.List[object]]::new()
    foreach ($path in $Paths) {
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $item = Get-Item -LiteralPath $path -ErrorAction Stop
            if ($candidateExtensions -contains $item.Extension.ToLowerInvariant() -and $seen.Add($item.FullName)) {
                [void]$files.Add($item)
            }
            continue
        }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            continue
        }

        $getChildArgs = @{
            LiteralPath = $path
            File = $true
            ErrorAction = "SilentlyContinue"
        }
        if ($Recursive) {
            $getChildArgs.Recurse = $true
        }
        foreach ($item in @(Get-ChildItem @getChildArgs)) {
            if ($candidateExtensions -contains $item.Extension.ToLowerInvariant() -and $seen.Add($item.FullName)) {
                [void]$files.Add($item)
            }
        }
    }
    return @($files.ToArray() | Sort-Object FullName)
}

function Read-RevAgentLauncherText {
    param([System.IO.FileInfo]$File)

    $details = [ordered]@{
        targetPath = ""
        arguments = ""
        workingDirectory = ""
        description = ""
        iconLocation = ""
        readWarning = ""
    }
    $parts = [System.Collections.Generic.List[string]]::new()
    [void]$parts.Add($File.Name)
    [void]$parts.Add($File.FullName)

    $extension = $File.Extension.ToLowerInvariant()
    if ($extension -eq ".lnk") {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($File.FullName)
            $details.targetPath = [string]$shortcut.TargetPath
            $details.arguments = [string]$shortcut.Arguments
            $details.workingDirectory = [string]$shortcut.WorkingDirectory
            $details.description = [string]$shortcut.Description
            $details.iconLocation = [string]$shortcut.IconLocation
            foreach ($field in @($details.targetPath, $details.arguments, $details.workingDirectory, $details.description, $details.iconLocation)) {
                if (-not [string]::IsNullOrWhiteSpace($field)) {
                    [void]$parts.Add($field)
                }
            }
        }
        catch {
            $details.readWarning = $_.Exception.Message
        }
    }
    else {
        try {
            $text = Get-Content -Raw -LiteralPath $File.FullName -ErrorAction Stop
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                [void]$parts.Add($text)
            }
        }
        catch {
            $details.readWarning = $_.Exception.Message
        }
    }

    return [pscustomobject][ordered]@{
        text = [string]::Join("`n", @($parts.ToArray()))
        details = [pscustomobject]$details
    }
}

function New-RevAgentLocalLauncherEvidence {
    param(
        [string]$Machine,
        [string[]]$Paths,
        [switch]$Recursive
    )

    if ([string]::IsNullOrWhiteSpace($Machine)) {
        if (-not [string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) {
            $Machine = $env:COMPUTERNAME
        }
        else {
            $Machine = "UNKNOWN"
        }
    }

    if ($Paths.Count -eq 0) {
        $Paths = @(Get-RevAgentDefaultLauncherPaths)
    }

    $files = @(Get-RevAgentLauncherFiles -Paths $Paths -Recursive:$Recursive)
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $read = Read-RevAgentLauncherText -File $file
        $text = [string]$read.text
        $isProductCandidate = Test-RevAgentTextContainsAny -Text $text -Patterns $productLauncherPatterns
        $hasLegacyLauncher = Test-RevAgentTextContainsAny -Text $text -Patterns $legacyLauncherPatterns
        $hasLegacyRoot = Test-RevAgentTextContainsAny -Text $text -Patterns $legacyRootPatterns
        $hasCanonicalRoot = Test-RevAgentTextContainsAny -Text $text -Patterns $canonicalRootPatterns
        if (-not $isProductCandidate -and -not $hasLegacyLauncher -and -not $hasLegacyRoot -and -not $hasCanonicalRoot) {
            continue
        }

        [void]$records.Add([pscustomobject][ordered]@{
                path = $file.FullName
                name = $file.Name
                extension = $file.Extension
                productLauncher = $isProductCandidate
                legacyLauncher = $hasLegacyLauncher
                legacyRootReference = $hasLegacyRoot
                canonicalRootReference = $hasCanonicalRoot
                matchedLegacyLauncherTerms = @(Select-RevAgentMatchedPatterns -Text $text -Patterns $legacyLauncherPatterns)
                matchedLegacyRootTerms = @(Select-RevAgentMatchedPatterns -Text $text -Patterns $legacyRootPatterns)
                targetPath = [string]$read.details.targetPath
                arguments = [string]$read.details.arguments
                workingDirectory = [string]$read.details.workingDirectory
                readWarning = [string]$read.details.readWarning
            })
    }

    $legacyLaunchers = @($records.ToArray() | Where-Object { [bool]$_.legacyLauncher })
    $legacyRootRefs = @($records.ToArray() | Where-Object { [bool]$_.legacyRootReference })
    $passed = ($legacyLaunchers.Count -eq 0 -and $legacyRootRefs.Count -eq 0)

    return [pscustomobject][ordered]@{
        schemaVersion = "revagent.desktopLauncherEvidence.v1"
        mode = "ScanLocal"
        machine = (Normalize-RevAgentMachineName -Value $Machine)
        passed = $passed
        expectedMachineCount = 1
        checkedMachineCount = 1
        missingMachineCount = 0
        failedMachineCount = $(if ($passed) { 0 } else { 1 })
        checkedLauncherCount = $files.Count
        productLauncherCount = $records.Count
        legacyLauncherCount = $legacyLaunchers.Count
        legacyRootReferenceCount = $legacyRootRefs.Count
        canonicalRootReferenceCount = @($records.ToArray() | Where-Object { [bool]$_.canonicalRootReference }).Count
        scannedPaths = @($Paths)
        recursive = [bool]$Recursive
        completedAtUtc = $NowUtc.ToString("o")
        note = "Local desktop launcher evidence. Aggregate it before compatibility-root retirement."
        launchers = @($records.ToArray())
    }
}

function Test-RevAgentEvidencePassed {
    param([object]$Evidence)

    if ($null -eq $Evidence) {
        return $false
    }
    $passed = Get-RevAgentValue -Object $Evidence -Name "passed"
    if ($passed -is [bool]) {
        return [bool]$passed
    }
    return ([string]$passed).Trim().ToLowerInvariant() -in @("true", "1", "yes", "passed")
}

function ConvertTo-RevAgentInt {
    param(
        [object]$Value,
        [int]$Fallback = 0
    )

    if ($null -eq $Value) {
        return $Fallback
    }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $Fallback
}

function New-RevAgentAggregateLauncherEvidence {
    param(
        [string]$Root,
        [string[]]$Expected,
        [string[]]$Excluded
    )

    if ([string]::IsNullOrWhiteSpace($Root)) {
        throw "ReportsRoot is required for Aggregate mode."
    }

    $excludedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($machine in $Excluded) {
        if (-not [string]::IsNullOrWhiteSpace($machine)) {
            [void]$excludedSet.Add((Normalize-RevAgentMachineName -Value $machine))
        }
    }

    $expectedNames = @(Expand-RevAgentMachineNames -Values $Expected | Where-Object { -not $excludedSet.Contains($_) } | Select-Object -Unique)
    if ($expectedNames.Count -eq 0) {
        $machineRoot = Join-Path $Root "machines"
        if (Test-Path -LiteralPath $machineRoot -PathType Container) {
            $expectedNames = @(
                Get-ChildItem -LiteralPath $machineRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { -not $excludedSet.Contains((Normalize-RevAgentMachineName -Value $_.Name)) } |
                    ForEach-Object { Normalize-RevAgentMachineName -Value $_.Name } |
                    Select-Object -Unique
            )
        }
    }

    $machineResults = [System.Collections.Generic.List[object]]::new()
    foreach ($machine in $expectedNames) {
        $machineSegment = ConvertTo-RevAgentSafePathSegment -Value $machine
        $evidencePath = Join-Path (Join-Path (Join-Path $Root "machines") $machineSegment) "desktop-launcher-latest.json"
        $evidence = Read-RevAgentJsonFile -Path $evidencePath
        if ($null -eq $evidence) {
            [void]$machineResults.Add([pscustomobject][ordered]@{
                    machine = $machine
                    evidencePath = $evidencePath
                    state = "missing"
                    passed = $false
                    legacyLauncherCount = 0
                    legacyRootReferenceCount = 0
                })
            continue
        }

        $legacyLauncherCount = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $evidence -Name "legacyLauncherCount")
        $legacyRootReferenceCount = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $evidence -Name "legacyRootReferenceCount")
        $machinePassed = (Test-RevAgentEvidencePassed -Evidence $evidence) -and $legacyLauncherCount -eq 0 -and $legacyRootReferenceCount -eq 0
        [void]$machineResults.Add([pscustomobject][ordered]@{
                machine = $machine
                evidencePath = $evidencePath
                state = $(if ($machinePassed) { "passed" } else { "failed" })
                passed = $machinePassed
                legacyLauncherCount = $legacyLauncherCount
                legacyRootReferenceCount = $legacyRootReferenceCount
                checkedLauncherCount = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $evidence -Name "checkedLauncherCount")
                productLauncherCount = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $evidence -Name "productLauncherCount")
                completedAtUtc = [string](Get-RevAgentValue -Object $evidence -Name "completedAtUtc")
            })
    }

    $missing = @($machineResults.ToArray() | Where-Object { $_.state -eq "missing" })
    $failed = @($machineResults.ToArray() | Where-Object { $_.state -eq "failed" })
    $legacyLauncherCountTotal = 0
    $legacyRootReferenceCountTotal = 0
    foreach ($result in @($machineResults.ToArray())) {
        $legacyLauncherCountTotal += [int]$result.legacyLauncherCount
        $legacyRootReferenceCountTotal += [int]$result.legacyRootReferenceCount
    }

    $checkedMachineCount = $expectedNames.Count - $missing.Count
    $passed = (
        $expectedNames.Count -gt 0 -and
        $missing.Count -eq 0 -and
        $failed.Count -eq 0 -and
        $legacyLauncherCountTotal -eq 0 -and
        $legacyRootReferenceCountTotal -eq 0
    )

    return [pscustomobject][ordered]@{
        schemaVersion = "revagent.desktopLauncherEvidence.v1"
        mode = "Aggregate"
        passed = $passed
        expectedMachineCount = $expectedNames.Count
        checkedMachineCount = $checkedMachineCount
        missingMachineCount = $missing.Count
        failedMachineCount = $failed.Count
        legacyLauncherCount = $legacyLauncherCountTotal
        legacyRootReferenceCount = $legacyRootReferenceCountTotal
        completedAtUtc = $NowUtc.ToString("o")
        note = "Aggregate desktop launcher evidence for compatibility-root retirement."
        expectedMachines = @($expectedNames)
        missingMachines = @($missing | ForEach-Object { $_.machine })
        failedMachines = @($failed | ForEach-Object { $_.machine })
        machines = @($machineResults.ToArray())
    }
}

function Publish-RevAgentEvidence {
    param(
        [object]$Evidence,
        [string]$Path,
        [string]$TimestampedPath = ""
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $json = $Evidence | ConvertTo-Json -Depth 20
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8

    if (-not [string]::IsNullOrWhiteSpace($TimestampedPath)) {
        $timestampDirectory = Split-Path -Parent $TimestampedPath
        if (-not [string]::IsNullOrWhiteSpace($timestampDirectory)) {
            New-Item -ItemType Directory -Path $timestampDirectory -Force | Out-Null
        }
        Set-Content -LiteralPath $TimestampedPath -Value $json -Encoding UTF8
    }
}

$config = $null
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Desktop launcher evidence config file was not found: $ConfigPath"
    }
    $config = Read-RevAgentJsonFile -Path $ConfigPath
}

if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $configReportsRoot = [string](Get-RevAgentValue -Object $config -Name "reportsRoot")
    if (-not [string]::IsNullOrWhiteSpace($configReportsRoot)) {
        $ReportsRoot = $configReportsRoot
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_REPORTS_ROOT)) {
        $ReportsRoot = $env:REVAGENT_REPORTS_ROOT
    }
    else {
        $ReportsRoot = $defaultCanonicalReportsRoot
    }
}

$configExpectedMachines = @(Get-RevAgentValue -Object $config -Name "expectedMachines")
$configOutOfScopeMachines = @(Get-RevAgentValue -Object $config -Name "outOfScopeMachines")

if ($Mode -eq "ScanLocal") {
    $evidence = New-RevAgentLocalLauncherEvidence -Machine $MachineName -Paths $LauncherPath -Recursive:$Recurse
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $machineSegment = ConvertTo-RevAgentSafePathSegment -Value ([string]$evidence.machine)
        $machineRoot = Join-Path (Join-Path $ReportsRoot "machines") $machineSegment
        $OutputPath = Join-Path $machineRoot "desktop-launcher-latest.json"
        $stamp = $NowUtc.ToString("yyyyMMdd-HHmmss")
        $timestampedPath = Join-Path $machineRoot ("desktop-launcher-{0}.json" -f $stamp)
    }
    else {
        $timestampedPath = ""
    }
}
else {
    $expected = @(Expand-RevAgentMachineNames -Values @($configExpectedMachines + $ExpectedMachines))
    $excluded = @(Expand-RevAgentMachineNames -Values @($configOutOfScopeMachines + $OutOfScopeMachines))
    $evidence = New-RevAgentAggregateLauncherEvidence -Root $ReportsRoot -Expected $expected -Excluded $excluded
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $rolloutRoot = Join-Path $ReportsRoot "rollout"
        $OutputPath = Join-Path $rolloutRoot "desktop-launcher-latest.json"
        $stamp = $NowUtc.ToString("yyyyMMdd-HHmmss")
        $timestampedPath = Join-Path $rolloutRoot ("desktop-launcher-{0}.json" -f $stamp)
    }
    else {
        $timestampedPath = ""
    }
}

Publish-RevAgentEvidence -Evidence $evidence -Path $OutputPath -TimestampedPath $timestampedPath

if ($OutputJson) {
    $evidence | ConvertTo-Json -Depth 20
}
else {
    Write-Host ("Desktop launcher evidence: {0}" -f $OutputPath)
    Write-Host ("Mode: {0}; passed: {1}; legacy launchers: {2}; legacy root references: {3}" -f $evidence.mode, $evidence.passed, $evidence.legacyLauncherCount, $evidence.legacyRootReferenceCount)
    if ($Mode -eq "Aggregate") {
        Write-Host ("Machines: {0} expected, {1} checked, {2} missing, {3} failed" -f $evidence.expectedMachineCount, $evidence.checkedMachineCount, $evidence.missingMachineCount, $evidence.failedMachineCount)
    }
}
