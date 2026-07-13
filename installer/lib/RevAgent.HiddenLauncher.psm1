Set-StrictMode -Version Latest

function ConvertTo-RevitMcpVbsStringLiteral {
    param([AllowNull()][string]$Value)

    return [string]::Concat('"', ([string]$Value).Replace('"', '""'), '"')
}

function Join-RevitMcpWindowsCommandArguments {
    param([string[]]$Arguments)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            $parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            $parts.Add($value)
        }
    }

    return ($parts.ToArray() -join " ")
}

function Resolve-RevitMcpWindowsPowerShellPath {
    return (Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe")
}

function Resolve-RevitMcpWScriptPath {
    return (Join-Path ([Environment]::SystemDirectory) "wscript.exe")
}

function Write-RevitMcpHiddenPowerShellLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LauncherPath,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [switch]$WaitForExit
    )

    $launcherDir = Split-Path -Parent $LauncherPath
    if (-not [string]::IsNullOrWhiteSpace($launcherDir)) {
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    }

    $command = Join-RevitMcpWindowsCommandArguments -Arguments (@(
            (Resolve-RevitMcpWindowsPowerShellPath),
            "-STA",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $ScriptPath
        ) + $ScriptArguments)
    $waitText = if ($WaitForExit) { "True" } else { "False" }
    $line = [string]::Concat(
        "WScript.Quit CreateObject(""WScript.Shell"").Run(",
        (ConvertTo-RevitMcpVbsStringLiteral -Value $command),
        ", 0, ",
        $waitText,
        ")")

    Set-Content -LiteralPath $LauncherPath -Value $line -Encoding ASCII -NoNewline
}

function Get-RevitMcpHiddenUpdaterLauncherPath {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    return Join-Path (Split-Path -Parent $ConfigPath) "Run-revAgent-Update-Hidden.vbs"
}

function Get-RevitMcpLegacyHiddenUpdaterLauncherPaths {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    return @(
        (Join-Path (Split-Path -Parent $ConfigPath) "Run-Revit-MCP-Update-Hidden.vbs")
    )
}

function New-RevitMcpHiddenUpdaterScheduledTaskAction {
    param([Parameter(Mandatory = $true)][string]$LauncherPath)

    return New-ScheduledTaskAction -Execute (Resolve-RevitMcpWScriptPath) -Argument ("//B //Nologo `"$LauncherPath`"")
}

$revAgentFunctionAliases = @{
    "ConvertTo-RevAgentVbsStringLiteral" = "ConvertTo-RevitMcpVbsStringLiteral"
    "Get-RevAgentHiddenUpdaterLauncherPath" = "Get-RevitMcpHiddenUpdaterLauncherPath"
    "Get-RevAgentLegacyHiddenUpdaterLauncherPaths" = "Get-RevitMcpLegacyHiddenUpdaterLauncherPaths"
    "Join-RevAgentWindowsCommandArguments" = "Join-RevitMcpWindowsCommandArguments"
    "New-RevAgentHiddenUpdaterScheduledTaskAction" = "New-RevitMcpHiddenUpdaterScheduledTaskAction"
    "Resolve-RevAgentWindowsPowerShellPath" = "Resolve-RevitMcpWindowsPowerShellPath"
    "Resolve-RevAgentWScriptPath" = "Resolve-RevitMcpWScriptPath"
    "Write-RevAgentHiddenPowerShellLauncher" = "Write-RevitMcpHiddenPowerShellLauncher"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    ConvertTo-RevitMcpVbsStringLiteral, `
    Join-RevitMcpWindowsCommandArguments, `
    Resolve-RevitMcpWindowsPowerShellPath, `
    Resolve-RevitMcpWScriptPath, `
    Write-RevitMcpHiddenPowerShellLauncher, `
    Get-RevitMcpHiddenUpdaterLauncherPath, `
    Get-RevitMcpLegacyHiddenUpdaterLauncherPaths, `
    New-RevitMcpHiddenUpdaterScheduledTaskAction
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
