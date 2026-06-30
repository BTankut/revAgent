Set-StrictMode -Version Latest

function Test-RevitMcpAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function New-RevitMcpPermissionTarget {
    param(
        [string]$Path,
        [string]$Label,
        [ValidateSet("Directory", "File")]
        [string]$Kind = "Directory",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    return [pscustomobject]@{
        Path = $Path
        Label = $Label
        Kind = $Kind
        CreateDirectory = [bool]$CreateDirectory
        Recurse = [bool]$Recurse
    }
}

function Get-RevitMcpManagedPermissionTargets {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$WorkRoot,
        [Parameter(Mandatory = $true)]
        [string]$PackageTarget,
        [Parameter(Mandatory = $true)]
        [string]$ServerTarget,
        [string]$AllUsersAddinRoot = "",
        [string]$RevitVersion = "2022",
        [switch]$IncludeExistingPayloadTrees
    )

    $targets = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(
            @{ Path = $InstallRoot; Label = "revAgent install root" },
            @{ Path = $WorkRoot; Label = "updater work root" },
            @{ Path = $PackageTarget; Label = "package target" },
            @{ Path = $ServerTarget; Label = "runtime target" },
            @{ Path = (Join-Path $InstallRoot "revit-plugin"); Label = "Revit addin payload root" },
            @{ Path = (Join-Path $InstallRoot "commands"); Label = "Revit command payload root" },
            @{ Path = (Join-Path $InstallRoot "codex"); Label = "Codex payload root" },
            @{ Path = (Join-Path $InstallRoot "state"); Label = "state root" },
            @{ Path = (Join-Path $WorkRoot "logs"); Label = "updater logs root" },
            @{ Path = (Join-Path $WorkRoot "cache"); Label = "updater cache root" },
            @{ Path = (Join-Path $WorkRoot "staging"); Label = "updater staging root" },
            @{ Path = (Join-Path $WorkRoot "reports"); Label = "updater reports root" },
            @{ Path = (Join-Path $WorkRoot "config"); Label = "updater config root" }
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -CreateDirectory))
    }

    if (-not [string]::IsNullOrWhiteSpace($AllUsersAddinRoot)) {
        $targets.Add((New-RevitMcpPermissionTarget -Path $AllUsersAddinRoot -Label "Revit $RevitVersion addin root" -CreateDirectory))
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $AllUsersAddinRoot "revAgent.addin") -Label "revAgent add-in manifest" -Kind File))
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $AllUsersAddinRoot "mcp-servers-for-revit.addin") -Label "legacy revAgent add-in manifest" -Kind File))
    }

    foreach ($fileName in @(
            "Run-revAgent-Update-Hidden.vbs",
            "last-update-report.json",
            "installed.json",
            "updater-config.json",
            "update-from-nas.ps1",
            "show-installed-version.ps1",
            "install-updater-task.ps1",
            "migrate-source-free-install.ps1",
            "Update-revAgent-Now.cmd",
            "Show-revAgent-Version.cmd",
            "auto-update-loop.ps1",
            "config\release-trusted-keys.json"
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $WorkRoot $fileName) -Label "updater file $fileName" -Kind File))
    }

    if ($IncludeExistingPayloadTrees) {
        foreach ($entry in @(
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revAgentPlugin"); Label = "existing Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revit_mcp_plugin"); Label = "legacy Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "commands\CommandSet"); Label = "existing Revit command payload" },
                @{ Path = $ServerTarget; Label = "existing runtime payload" },
                @{ Path = (Join-Path $InstallRoot "codex\skills\revAgent"); Label = "existing Codex skill payload" }
            )) {
            $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -Recurse))
        }
    }

    return $targets.ToArray()
}

function Grant-RevitMcpManagedPathAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$Label = "managed path",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    if (-not (Test-RevitMcpAdministrator)) {
        return
    }

    try {
        if ($CreateDirectory) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        elseif (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        if ([string]::IsNullOrWhiteSpace($identity)) {
            return
        }

        $grant = if ($Recurse) { "${identity}:(OI)(CI)M" } else { "${identity}:M" }
        $arguments = @($Path, "/grant", $grant, "/C")
        if ($Recurse) {
            $arguments += "/T"
        }

        Write-Host "Permission repair: $Label"
        & icacls @arguments 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not grant write access to $identity for $Label ($Path). icacls exit code: $LASTEXITCODE"
        }
    }
    catch {
        Write-Warning "Could not grant write access for $Label (${Path}): $($_.Exception.Message)"
    }
}

function Invoke-RevitMcpManagedPermissionRepair {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Targets
    )

    foreach ($target in $Targets) {
        Grant-RevitMcpManagedPathAccess `
            -Path ([string]$target.Path) `
            -Label ([string]$target.Label) `
            -CreateDirectory:([bool]$target.CreateDirectory) `
            -Recurse:([bool]$target.Recurse)
    }
}

$revAgentFunctionAliases = @{
    "Get-RevAgentManagedPermissionTargets" = "Get-RevitMcpManagedPermissionTargets"
    "Grant-RevAgentManagedPathAccess" = "Grant-RevitMcpManagedPathAccess"
    "Invoke-RevAgentManagedPermissionRepair" = "Invoke-RevitMcpManagedPermissionRepair"
    "New-RevAgentPermissionTarget" = "New-RevitMcpPermissionTarget"
    "Test-RevAgentAdministrator" = "Test-RevitMcpAdministrator"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Test-RevitMcpAdministrator, `
    New-RevitMcpPermissionTarget, `
    Get-RevitMcpManagedPermissionTargets, `
    Grant-RevitMcpManagedPathAccess, `
    Invoke-RevitMcpManagedPermissionRepair
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
