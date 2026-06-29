Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot "RevAgent.HiddenLauncher.psm1")

function New-RevitMcpDailyUpdateTrigger {
    param(
        [string]$DailyAt = "12:00"
    )

    $time = [datetime]::Parse($DailyAt)
    return New-ScheduledTaskTrigger -Daily -At $time
}

function Repair-RevitMcpHiddenScheduledTaskAction {
    param(
        [string]$Name = "revAgent Auto Update",
        [string[]]$LegacyNames = @("Revit MCP Auto Update"),
        [Parameter(Mandatory = $true)]
        [string]$UpdaterPath,
        [Parameter(Mandatory = $true)]
        [string]$UpdaterConfigPath,
        [string]$DailyAt = "12:00"
    )

    if ([string]::IsNullOrWhiteSpace($UpdaterConfigPath) -or
        [string]::IsNullOrWhiteSpace($UpdaterPath) -or
        -not (Test-Path -LiteralPath $UpdaterConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return
    }

    try {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        $legacyTasks = @()
        foreach ($legacyName in $LegacyNames) {
            if ([string]::IsNullOrWhiteSpace($legacyName) -or
                [string]::Equals($legacyName, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $legacyTask = Get-ScheduledTask -TaskName $legacyName -ErrorAction SilentlyContinue
            if ($legacyTask) {
                $legacyTasks += $legacyTask
            }
        }

        $launcherPath = Get-RevitMcpHiddenUpdaterLauncherPath -ConfigPath $UpdaterConfigPath
        Write-RevitMcpHiddenPowerShellLauncher `
            -LauncherPath $launcherPath `
            -ScriptPath $UpdaterPath `
            -ScriptArguments @("-ConfigPath", $UpdaterConfigPath, "-NotifyUser", "-OperationMethod", "scheduled-update") `
            -WaitForExit
        foreach ($legacyLauncherPath in @(Get-RevitMcpLegacyHiddenUpdaterLauncherPaths -ConfigPath $UpdaterConfigPath)) {
            if ((-not [string]::Equals($legacyLauncherPath, $launcherPath, [System.StringComparison]::OrdinalIgnoreCase)) -and
                (Test-Path -LiteralPath $legacyLauncherPath -PathType Leaf)) {
                Remove-Item -LiteralPath $legacyLauncherPath -Force -ErrorAction Stop
                Write-Host "Removed legacy hidden updater launcher: $legacyLauncherPath"
            }
        }
        $action = New-RevitMcpHiddenUpdaterScheduledTaskAction -LauncherPath $launcherPath
        $trigger = New-RevitMcpDailyUpdateTrigger -DailyAt $DailyAt
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

        if (-not $task -and $legacyTasks.Count -gt 0) {
            $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask `
                -TaskName $Name `
                -Action $action `
                -Trigger @($trigger) `
                -Settings $settings `
                -Principal $principal `
                -Description "Checks the revAgent release target daily at $DailyAt. Revit-loaded payload updates are deferred while Revit is open." `
                -Force | Out-Null
            Write-Host "Scheduled task migrated to revAgent product name: $Name"
            $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        }
        elseif (-not $task) {
            return
        }

        $desiredExecute = Resolve-RevitMcpWScriptPath
        $desiredArgs = "//B //Nologo `"$launcherPath`""
        $currentAction = @($task.Actions | Select-Object -First 1)
        $currentArgs = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Arguments } else { "" }
        $currentExecute = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Execute } else { "" }
        $currentExecuteMatches = [string]::Equals($currentExecute, $desiredExecute, [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($currentExecute, "wscript.exe", [System.StringComparison]::OrdinalIgnoreCase)
        $actionMatches = [string]::Equals($currentArgs, $desiredArgs, [System.StringComparison]::OrdinalIgnoreCase) -and $currentExecuteMatches

        if (-not $actionMatches) {
            Set-ScheduledTask -TaskName $Name -Action $action -ErrorAction Stop | Out-Null
            Write-Host "Scheduled task action repaired for hidden background checks: $Name"
        }

        Set-ScheduledTask -TaskName $Name -Trigger $trigger -Settings $settings -ErrorAction Stop | Out-Null
        Write-Host "Scheduled task schedule repaired for daily background checks at ${DailyAt}: $Name"

        foreach ($legacyTask in $legacyTasks) {
            try {
                Unregister-ScheduledTask -TaskName $legacyTask.TaskName -Confirm:$false -ErrorAction Stop | Out-Null
                Write-Host "Removed legacy updater scheduled task: $($legacyTask.TaskName)"
            }
            catch {
                Write-Warning "Could not remove legacy updater scheduled task '$($legacyTask.TaskName)': $($_.Exception.Message)"
            }
        }
    }
    catch {
        Write-Warning "Could not repair scheduled task for hidden background checks: $($_.Exception.Message)"
    }
}

Export-ModuleMember -Function Repair-RevitMcpHiddenScheduledTaskAction, New-RevitMcpDailyUpdateTrigger
