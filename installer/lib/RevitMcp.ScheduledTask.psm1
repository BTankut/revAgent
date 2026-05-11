Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot "RevitMcp.HiddenLauncher.psm1")

function Repair-RevitMcpHiddenScheduledTaskAction {
    param(
        [string]$Name = "Revit MCP Auto Update",
        [Parameter(Mandatory = $true)]
        [string]$UpdaterPath,
        [Parameter(Mandatory = $true)]
        [string]$UpdaterConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($UpdaterConfigPath) -or
        [string]::IsNullOrWhiteSpace($UpdaterPath) -or
        -not (Test-Path -LiteralPath $UpdaterConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return
    }

    try {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if (-not $task) {
            return
        }

        $launcherPath = Get-RevitMcpHiddenUpdaterLauncherPath -ConfigPath $UpdaterConfigPath
        Write-RevitMcpHiddenPowerShellLauncher `
            -LauncherPath $launcherPath `
            -ScriptPath $UpdaterPath `
            -ScriptArguments @("-ConfigPath", $UpdaterConfigPath, "-NotifyUser") `
            -WaitForExit
        $desiredExecute = Resolve-RevitMcpWScriptPath
        $desiredArgs = "//B //Nologo `"$launcherPath`""
        $currentAction = @($task.Actions | Select-Object -First 1)
        $currentArgs = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Arguments } else { "" }
        $currentExecute = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Execute } else { "" }
        $currentExecuteMatches = [string]::Equals($currentExecute, $desiredExecute, [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($currentExecute, "wscript.exe", [System.StringComparison]::OrdinalIgnoreCase)
        if ([string]::Equals($currentArgs, $desiredArgs, [System.StringComparison]::OrdinalIgnoreCase) -and $currentExecuteMatches) {
            return
        }

        $action = New-RevitMcpHiddenUpdaterScheduledTaskAction -LauncherPath $launcherPath
        Set-ScheduledTask -TaskName $Name -Action $action | Out-Null
        Write-Host "Scheduled task action repaired for hidden background checks: $Name"
    }
    catch {
        Write-Warning "Could not repair scheduled task action for hidden background checks: $($_.Exception.Message)"
    }
}

Export-ModuleMember -Function Repair-RevitMcpHiddenScheduledTaskAction
