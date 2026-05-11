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

Export-ModuleMember -Function Write-RevitMcpJsonFile, New-RevitMcpUpdateReport
