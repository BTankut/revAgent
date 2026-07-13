Set-StrictMode -Version Latest

function Test-RevitMcpSecureTempAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-RevitMcpSecureMachineTempPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemDirectory = [Environment]::SystemDirectory
    $windowsDirectory = [System.IO.Directory]::GetParent($systemDirectory).FullName
    $windowsTemp = [System.IO.Path]::GetFullPath((Join-Path $windowsDirectory 'Temp')).TrimEnd('\')
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $fullPath.StartsWith($windowsTemp + '\revAgent-elevated-', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    $cursor = $fullPath
    while ($cursor.StartsWith($windowsDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $cursor -PathType Container)) { return $false }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        if ([string]::Equals($cursor.TrimEnd('\'), $windowsDirectory.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }

    $acl = Get-Acl -LiteralPath $fullPath -ErrorAction Stop
    $ownerSid = try { ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$acl.Owner }
    if (-not [string]::Equals($ownerSid, 'S-1-5-32-544', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            (($rule.FileSystemRights -band $writeMask) -ne 0) -and
            $allowedSids -notcontains [string]$rule.IdentityReference.Value) {
            return $false
        }
    }
    return $true
}

function Initialize-RevitMcpSecureMachineTemp {
    [CmdletBinding()]
    param()

    if (-not (Test-RevitMcpSecureTempAdministrator)) {
        throw 'Secure machine TEMP/TMP initialization requires an elevated process.'
    }

    foreach ($existing in @($env:TEMP, $env:TMP)) {
        if (-not [string]::IsNullOrWhiteSpace($existing) -and (Test-RevitMcpSecureMachineTempPath -Path $existing)) {
            $env:TEMP = [System.IO.Path]::GetFullPath($existing)
            $env:TMP = $env:TEMP
            return [pscustomobject][ordered]@{
                path = $env:TEMP
                reused = $true
                ownsPath = $false
                previousTemp = $env:TEMP
                previousTmp = $env:TMP
                safe = $true
            }
        }
    }

    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    $windowsDirectory = [System.IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $windowsTemp = [System.IO.Path]::GetFullPath((Join-Path $windowsDirectory 'Temp'))
    $windowsTempItem = Get-Item -LiteralPath $windowsTemp -Force -ErrorAction Stop
    if (($windowsTempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Canonical Windows Temp is a reparse point: $windowsTemp"
    }
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($adminSid)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($adminSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $secureLeaf = 'revAgent-elevated-' + [Guid]::NewGuid().ToString('N')
    $securePath = Join-Path $windowsTemp $secureLeaf
    $windowsTempInfo = [System.IO.DirectoryInfo]$windowsTempItem
    $aclCreateOverload = @($windowsTempInfo.GetType().GetMethods() | Where-Object {
            $_.Name -eq 'CreateSubdirectory' -and $_.GetParameters().Count -eq 2
        } | Select-Object -First 1)
    if ($aclCreateOverload.Count -gt 0) {
        [void]$windowsTempInfo.CreateSubdirectory($secureLeaf, $acl)
    }
    else {
        [void][System.IO.FileSystemAclExtensions]::CreateDirectory($acl, $securePath)
    }
    $secureItem = Get-Item -LiteralPath $securePath -Force -ErrorAction Stop
    if (($secureItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        @(Get-ChildItem -LiteralPath $securePath -Force -ErrorAction Stop).Count -ne 0) {
        throw "Secure machine temp creation was not empty/link-safe: $securePath"
    }
    if (-not (Test-RevitMcpSecureMachineTempPath -Path $securePath)) {
        throw "Secure machine TEMP/TMP ACL verification failed: $securePath"
    }

    $env:TEMP = $securePath
    $env:TMP = $securePath
    return [pscustomobject][ordered]@{
        path = $securePath
        reused = $false
        ownsPath = $true
        previousTemp = $previousTemp
        previousTmp = $previousTmp
        safe = $true
    }
}

function Complete-RevitMcpSecureMachineTemp {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Context)

    if (-not [bool]$Context.ownsPath) { return }
    $path = [string]$Context.path
    $env:TEMP = [string]$Context.previousTemp
    $env:TMP = [string]$Context.previousTmp
    if (Test-RevitMcpSecureMachineTempPath -Path $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$aliases = @{
    'Test-RevAgentSecureTempAdministrator' = 'Test-RevitMcpSecureTempAdministrator'
    'Initialize-RevAgentSecureMachineTemp' = 'Initialize-RevitMcpSecureMachineTemp'
    'Complete-RevAgentSecureMachineTemp' = 'Complete-RevitMcpSecureMachineTemp'
    'Test-RevAgentSecureMachineTempPath' = 'Test-RevitMcpSecureMachineTempPath'
}
foreach ($entry in $aliases.GetEnumerator()) { Set-Alias -Name $entry.Key -Value $entry.Value }

Export-ModuleMember -Function Test-RevitMcpSecureTempAdministrator, Test-RevitMcpSecureMachineTempPath, Initialize-RevitMcpSecureMachineTemp, Complete-RevitMcpSecureMachineTemp -Alias @($aliases.Keys)
