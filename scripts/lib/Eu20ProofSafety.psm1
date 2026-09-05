Set-StrictMode -Version Latest

function Assert-Eu20ProofLocalPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissingLeaf)
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw 'proof_path_must_be_absolute_local'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = [IO.Path]::GetPathRoot($full)
    $parts = $full.Substring($cursor.Length).Split([char[]]@('\','/'), [StringSplitOptions]::RemoveEmptyEntries)
    for ($index = 0; $index -lt $parts.Length; $index++) {
        $cursor = Join-Path $cursor $parts[$index]
        try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
        catch {
            if ($AllowMissingLeaf -and $index -eq $parts.Length - 1 -and $_.CategoryInfo.Category -eq 'ObjectNotFound') { return $full }
            throw 'proof_path_component_unavailable'
        }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq 'HardLink') {
            throw 'proof_path_link_refused'
        }
        if ($index -lt $parts.Length - 1 -and -not $item.PSIsContainer) { throw 'proof_path_parent_not_directory' }
    }
    return $full
}

function Get-Eu20ProofPrincipals {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $owner = $identity.User } finally { $identity.Dispose() }
    $principals = @($owner,
        [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null),
        [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null))
    return [pscustomobject]@{ Owner = $owner; Principals = @($principals | Sort-Object -Property Value -Unique) }
}

function Assert-Eu20PrivateProofAcl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $full = Assert-Eu20ProofLocalPath -Path $Path
    $expected = Get-Eu20ProofPrincipals
    $acl = Get-Acl -LiteralPath $full -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $expected.Owner.Value) {
        throw 'proof_acl_owner_or_inheritance_refused'
    }
    $actual = @{}
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -notin $expected.Principals.Value -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'proof_acl_extra_or_incomplete_access' }
        $actual[$rule.IdentityReference.Value] = $true
    }
    if ($actual.Count -ne $expected.Principals.Count) { throw 'proof_acl_required_principal_missing' }
    return $full
}

function Set-Eu20PrivateProofAcl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $full = Assert-Eu20ProofLocalPath -Path $Path
    $item = Get-Item -LiteralPath $full -Force
    $expected = Get-Eu20ProofPrincipals
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($expected.Owner)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in $expected.Principals) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,
            [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    # Persist only the owner/DACL sections changed above. Set-Acl can request
    # SACL privileges while replacing an existing descriptor in PowerShell.
    if ($item.PSIsContainer) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($full), $acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($full), $acl) }
    [void](Assert-Eu20PrivateProofAcl -Path $full)
}

function New-Eu20PrivateProofRoot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $full = Assert-Eu20ProofLocalPath -Path $Path -AllowMissingLeaf
    if (Test-Path -LiteralPath $full) { throw 'proof_root_already_exists' }
    New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
    # No secret is generated or written until actual ACL readback succeeds.
    Set-Eu20PrivateProofAcl -Path $full
    return $full
}

function Invoke-Eu20DockerCommand {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Invoke-Eu20OwnedDockerCleanup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Containers,
        [AllowNull()][object]$Network,
        [Parameter(Mandatory)][string]$RunId,
        [scriptblock]$DockerCommand = { param([string[]]$Arguments) Invoke-Eu20DockerCommand -Arguments $Arguments }
    )
    $errors = [Collections.Generic.List[string]]::new()
    $verifiedAbsent = [Collections.Generic.List[string]]::new()
    $call = {
        param([string[]]$Arguments)
        try { return & $DockerCommand $Arguments }
        catch { return [pscustomobject]@{ ExitCode = 255; Output = @() } }
    }
    $resources = @($Containers)
    [array]::Reverse($resources)
    if ($null -ne $Network) { $resources += $Network }
    foreach ($resource in $resources) {
        $id = [string]$resource.Id
        $name = [string]$resource.Name
        $kind = [string]$resource.Kind
        if ($id -notmatch '^[0-9a-f]{64}$' -or $name -notmatch '^revagent-eu20-b1-(pg|issuer|gateway|private)$' -or $kind -notin @('container','network')) {
            $errors.Add('invalid_owned_resource_record'); continue
        }
        $format = if ($kind -eq 'container') { '{{.Id}}|{{.Name}}|{{index .Config.Labels "revagent.proof_run"}}' } else { '{{.Id}}|{{.Name}}|{{index .Labels "revagent.proof_run"}}' }
        $inspection = & $call @($kind, 'inspect', $id, '--format', $format)
        if ($inspection.ExitCode -eq 0) {
            $parts = ($inspection.Output -join '').Split('|')
            if ($parts.Length -ne 3 -or $parts[0] -cne $id -or $parts[1].TrimStart('/') -cne $name -or $parts[2] -cne $RunId) {
                $errors.Add("ownership_mismatch:$name"); continue
            }
            if ($kind -eq 'container') {
                $stopped = & $call @('stop', '--timeout', '20', $id)
                if ($stopped.ExitCode -ne 0) { $errors.Add("container_stop_failed:$name") }
                $removed = & $call @('rm', '-v', $id)
            }
            else { $removed = & $call @('network', 'rm', $id) }
            if ($removed.ExitCode -ne 0) { $errors.Add("${kind}_remove_failed:$name") }
        }
        # An inspect error is not absence. Require a successful inventory query.
        $query = if ($kind -eq 'container') { @('container','ls','-a','--filter',"id=$id",'--format','{{.ID}}') } else { @('network','ls','--filter',"id=$id",'--format','{{.ID}}') }
        $remaining = & $call $query
        if ($remaining.ExitCode -ne 0) { $errors.Add("${kind}_absence_unproven:$name") }
        elseif (-not [string]::IsNullOrWhiteSpace(($remaining.Output -join ''))) { $errors.Add("${kind}_still_present:$name") }
        else { $verifiedAbsent.Add($id) }
    }
    # Also detect a resource created before a failed Docker create/start call
    # returned its id. Such a resource is not guessed at or deleted by name.
    foreach ($kind in @('container','network')) {
        $query = @($kind,'ls')
        if ($kind -eq 'container') { $query += '-a' }
        $query += @('--filter',"label=revagent.proof_run=$RunId",'--format','{{.ID}}')
        $owned = & $call $query
        if ($owned.ExitCode -ne 0) { $errors.Add("owned_${kind}_inventory_unproven") }
        elseif (-not [string]::IsNullOrWhiteSpace(($owned.Output -join ''))) { $errors.Add("owned_${kind}_resources_remain") }
    }
    return [pscustomobject]@{ Success = ($errors.Count -eq 0); Errors = $errors.ToArray(); VerifiedAbsent = $verifiedAbsent.ToArray() }
}

function Set-Eu20ProofOverallOutcome {
    param([Parameter(Mandatory)][Collections.IDictionary]$Candidate, [Parameter(Mandatory)][object]$Cleanup)
    $Candidate.cleanup = $Cleanup
    $Candidate.overallOutcome = if ($Candidate.actualImageAndCSharpRead -eq 'passed' -and $Cleanup.Success) { 'passed' } else { 'failed' }
}

function Assert-Eu20ProofCleanupComplete {
    param([Parameter(Mandatory)][object]$Cleanup)
    if (-not $Cleanup.Success) { throw 'proof_cleanup_incomplete: real check outcomes are retained, but the overall run failed' }
}

Export-ModuleMember -Function Assert-Eu20ProofLocalPath, Assert-Eu20PrivateProofAcl, Set-Eu20PrivateProofAcl, New-Eu20PrivateProofRoot, Invoke-Eu20DockerCommand, Invoke-Eu20OwnedDockerCleanup, Set-Eu20ProofOverallOutcome, Assert-Eu20ProofCleanupComplete
