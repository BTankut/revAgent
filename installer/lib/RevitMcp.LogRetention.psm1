function Invoke-RevitMcpLogRetention {
    [CmdletBinding()]
    param(
        [string]$LogsRoot,
        [int]$KeepLast = 10,
        [string]$ActiveLogPath = ""
    )

    if ([string]::IsNullOrWhiteSpace($LogsRoot) -or -not (Test-Path -LiteralPath $LogsRoot -PathType Container)) {
        return
    }

    $limit = [Math]::Max(1, $KeepLast)
    $activeFullName = ""
    if (-not [string]::IsNullOrWhiteSpace($ActiveLogPath)) {
        try {
            $activeFullName = [System.IO.Path]::GetFullPath($ActiveLogPath)
        }
        catch {
            $activeFullName = $ActiveLogPath
        }
    }

    try {
        $files = @(Get-ChildItem -LiteralPath $LogsRoot -File -Filter "*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc, Name -Descending)
        if ($files.Count -le $limit) {
            return
        }

        $keep = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($file in ($files | Select-Object -First $limit)) {
            [void]$keep.Add($file.FullName)
        }
        if (-not [string]::IsNullOrWhiteSpace($activeFullName)) {
            [void]$keep.Add($activeFullName)
        }

        $removed = 0
        foreach ($file in $files) {
            if ($keep.Contains($file.FullName)) {
                continue
            }

            try {
                Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
                $removed++
            }
            catch {
            }
        }

        if ($removed -gt 0) {
            Write-Host ("Log cleanup    : removed {0} old log file(s); kept latest {1}" -f $removed, $limit) -ForegroundColor Green
        }
    }
    catch {
        Write-Warning "Could not clean old log files: $($_.Exception.Message)"
    }
}

function Invoke-RevitMcpDirectoryRetention {
    [CmdletBinding()]
    param(
        [string]$Root,
        [string]$Filter,
        [int]$KeepLast = 3
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Filter) -or
        -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return
    }

    $limit = [Math]::Max(1, $KeepLast)
    try {
        $directories = @(Get-ChildItem -LiteralPath $Root -Directory -Filter $Filter -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc, Name -Descending)
        if ($directories.Count -le $limit) {
            return
        }

        $removed = 0
        foreach ($directory in ($directories | Select-Object -Skip $limit)) {
            try {
                Remove-Item -LiteralPath $directory.FullName -Recurse -Force -ErrorAction Stop
                $removed++
            }
            catch {
            }
        }

        if ($removed -gt 0) {
            Write-Host ("Backup cleanup : removed {0} old backup directories; kept latest {1}" -f $removed, $limit) -ForegroundColor Green
        }
    }
    catch {
        Write-Warning "Could not clean old backup directories: $($_.Exception.Message)"
    }
}

function Invoke-RevitMcpBackupRootReset {
    param(
        [Parameter(Mandatory = $true)][string]$BackupRoot,
        [string]$CacheRoot = "",
        [string]$CacheFilter = "revit-mcp-skill-*.zip"
    )

    $result = [ordered]@{
        backupRoot = $BackupRoot
        cacheRoot = $CacheRoot
        removedBackupItemCount = 0
        failedBackupItemCount = 0
        removedCacheItemCount = 0
        failedCacheItemCount = 0
        failures = @()
    }

    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }

    foreach ($item in @(Get-ChildItem -LiteralPath $BackupRoot -Force -ErrorAction SilentlyContinue)) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            $result.removedBackupItemCount++
        }
        catch {
            $result.failedBackupItemCount++
            $result.failures += [ordered]@{
                path = $item.FullName
                kind = "backup"
                error = $_.Exception.Message
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($CacheRoot) -and
        (Test-Path -LiteralPath $CacheRoot -PathType Container) -and
        -not [string]::IsNullOrWhiteSpace($CacheFilter)) {
        foreach ($item in @(Get-ChildItem -LiteralPath $CacheRoot -File -Filter $CacheFilter -Force -ErrorAction SilentlyContinue)) {
            try {
                Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
                $result.removedCacheItemCount++
            }
            catch {
                $result.failedCacheItemCount++
                $result.failures += [ordered]@{
                    path = $item.FullName
                    kind = "cache"
                    error = $_.Exception.Message
                }
            }
        }
    }

    return [pscustomobject]$result
}

Export-ModuleMember -Function Invoke-RevitMcpLogRetention, Invoke-RevitMcpDirectoryRetention, Invoke-RevitMcpBackupRootReset
