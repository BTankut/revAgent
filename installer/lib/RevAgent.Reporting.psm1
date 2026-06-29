Set-StrictMode -Version Latest

function Write-RevitMcpJsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [int]$Depth = 12
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

function New-RevitMcpUpdateReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string]$PreviousVersion = "",
        [string]$InstalledVersion = "",
        [object]$Channel = $null,
        [object]$InstalledState = $null
    )

    return [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        status = $Status
        message = $Message
        previousVersion = $PreviousVersion
        installedVersion = $InstalledVersion
        channel = $Channel
        installedState = $InstalledState
        reportedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
}

function ConvertTo-RevitMcpSafePathSegment {
    param(
        [string]$Value,
        [string]$Fallback = "unknown"
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Fallback
    }

    $invalidCharacters = [System.IO.Path]::GetInvalidFileNameChars()
    $builder = [System.Text.StringBuilder]::new()
    foreach ($character in $Value.Trim().ToCharArray()) {
        if ([char]::IsControl($character) -or [char]::IsWhiteSpace($character) -or [Array]::IndexOf($invalidCharacters, $character) -ge 0) {
            [void]$builder.Append("_")
            continue
        }

        [void]$builder.Append($character)
    }

    $safe = [System.Text.RegularExpressions.Regex]::Replace($builder.ToString(), "_{2,}", "_").Trim("._-")
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return $Fallback
    }

    return $safe
}

function Get-RevitMcpReportValue {
    param(
        [object]$Report,
        [string]$Name
    )

    if ($null -eq $Report -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }

    if ($Report -is [System.Collections.IDictionary] -and $Report.Contains($Name)) {
        return $Report[$Name]
    }

    $property = $Report.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Copy-RevitMcpReportToOrderedMap {
    param([object]$Report)

    $copy = [ordered]@{}
    if ($null -eq $Report) {
        return $copy
    }

    if ($Report -is [System.Collections.IDictionary]) {
        foreach ($key in $Report.Keys) {
            $copy[[string]$key] = $Report[$key]
        }
        return $copy
    }

    foreach ($property in $Report.PSObject.Properties) {
        $copy[$property.Name] = $property.Value
    }

    return $copy
}

function Invoke-RevitMcpRemoteLogRetention {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LogsRoot,
        [int]$KeepLast = 2
    )

    if ($KeepLast -lt 1 -or -not (Test-Path -LiteralPath $LogsRoot -PathType Container)) {
        return
    }

    $logs = @(Get-ChildItem -LiteralPath $LogsRoot -File -Filter "*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc, Name -Descending)
    if ($logs.Count -le $KeepLast) {
        return
    }

    $logs | Select-Object -Skip $KeepLast | ForEach-Object {
        try {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove old remote install log '$($_.FullName)': $($_.Exception.Message)"
        }
    }
}

function Publish-RevitMcpMachineRunReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReportsRoot,
        [Parameter(Mandatory = $true)]
        [object]$Report,
        [string]$Operation = "update",
        [string]$OperationMethod = "",
        [string]$LogPath = "",
        [int]$KeepLastLogs = 2,
        [switch]$WriteCompatibilityReport
    )

    if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
        return $null
    }

    $safeComputer = ConvertTo-RevitMcpSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
    $safeUser = ConvertTo-RevitMcpSafePathSegment -Value $env:USERNAME -Fallback "unknown-user"
    $safeOperation = ConvertTo-RevitMcpSafePathSegment -Value $Operation -Fallback "operation"
    $safeMethod = ConvertTo-RevitMcpSafePathSegment -Value $OperationMethod -Fallback "method"
    $status = [string](Get-RevitMcpReportValue -Report $Report -Name "status")
    $safeStatus = ConvertTo-RevitMcpSafePathSegment -Value $status -Fallback "status"
    $version = [string](Get-RevitMcpReportValue -Report $Report -Name "installedVersion")
    if ([string]::IsNullOrWhiteSpace($version)) {
        $version = [string](Get-RevitMcpReportValue -Report $Report -Name "targetVersion")
    }
    $safeVersion = ConvertTo-RevitMcpSafePathSegment -Value $version -Fallback "version"

    $machineRoot = Join-Path (Join-Path $ReportsRoot "machines") $safeComputer
    $logsRoot = Join-Path $machineRoot "logs"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $published = Copy-RevitMcpReportToOrderedMap -Report $Report
    $published["operation"] = $Operation
    $published["operationMethod"] = $OperationMethod
    $published["publishedAtUtc"] = (Get-Date).ToUniversalTime().ToString("o")

    $remoteLogPath = $null
    if (-not [string]::IsNullOrWhiteSpace($LogPath) -and (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        $remoteLogPath = Join-Path $logsRoot ("{0}-{1}-{2}-{3}-{4}.log" -f $stamp, $safeOperation, $safeMethod, $safeStatus, $safeVersion)
        Copy-Item -LiteralPath $LogPath -Destination $remoteLogPath -Force
        Invoke-RevitMcpRemoteLogRetention -LogsRoot $logsRoot -KeepLast $KeepLastLogs
    }

    $published["machineReport"] = [ordered]@{
        machineRoot = $machineRoot
        logPath = $remoteLogPath
        keepLastLogs = $KeepLastLogs
    }

    $latestPath = Join-Path $machineRoot "latest.json"
    $operationLatestPath = Join-Path $machineRoot ("{0}-latest.json" -f $safeOperation)
    Write-RevitMcpJsonFile -Path $latestPath -Value $published
    Write-RevitMcpJsonFile -Path $operationLatestPath -Value $published

    $compatibilityPath = $null
    if ($WriteCompatibilityReport) {
        New-Item -ItemType Directory -Path $ReportsRoot -Force | Out-Null
        $compatibilityPath = Join-Path $ReportsRoot ("{0}_{1}.json" -f $safeComputer, $safeUser)
        Write-RevitMcpJsonFile -Path $compatibilityPath -Value $published
    }

    return [pscustomobject]@{
        MachineRoot = $machineRoot
        LatestPath = $latestPath
        OperationLatestPath = $operationLatestPath
        LogPath = $remoteLogPath
        CompatibilityPath = $compatibilityPath
    }
}

$revAgentFunctionAliases = @{
    "ConvertTo-RevAgentSafePathSegment" = "ConvertTo-RevitMcpSafePathSegment"
    "Invoke-RevAgentRemoteLogRetention" = "Invoke-RevitMcpRemoteLogRetention"
    "New-RevAgentUpdateReport" = "New-RevitMcpUpdateReport"
    "Publish-RevAgentMachineRunReport" = "Publish-RevitMcpMachineRunReport"
    "Write-RevAgentJsonFile" = "Write-RevitMcpJsonFile"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Write-RevitMcpJsonFile, `
    New-RevitMcpUpdateReport, `
    ConvertTo-RevitMcpSafePathSegment, `
    Publish-RevitMcpMachineRunReport, `
    Invoke-RevitMcpRemoteLogRetention
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
