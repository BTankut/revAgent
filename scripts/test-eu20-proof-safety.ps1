#requires -Version 7.0
[CmdletBinding()]
param([string]$RepoRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $RepoRoot 'scripts/lib/Eu20ProofSafety.psm1') -Force
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Refused([scriptblock]$Action, [string]$Pattern) {
    $refused = $false
    try { & $Action | Out-Null } catch { $refused = $_.Exception.Message -match $Pattern }
    Assert-True $refused "Expected refusal: $Pattern"
}
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $temp ('eu20-proof-safety-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$link = Join-Path $root 'link'
try {
    $parentAcl = (Get-Acl -LiteralPath $root).Sddl
    $private = New-Eu20PrivateProofRoot -Path (Join-Path $root 'private')
    [void](Assert-Eu20PrivateProofAcl -Path $private)
    $secret = Join-Path $private 'synthetic-secret.txt'
    [IO.File]::WriteAllText($secret, 'test-only-marker')
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    foreach ($ace in (Get-Acl -LiteralPath $secret).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Assert-True ($ace.IdentityReference.Value -in $allowed) 'A generated file inherited an extra principal.'
    }
    $broad = [Security.AccessControl.DirectorySecurity]::new()
    $broad.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    $broad.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($allowed | Sort-Object -Unique)) {
        $broad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    }
    $broad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,
        [Security.AccessControl.AccessControlType]::Allow))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($private), $broad)
    Assert-Refused { Assert-Eu20PrivateProofAcl -Path $private } 'proof_acl_extra'
    Set-Eu20PrivateProofAcl -Path $private
    Assert-True ((Get-Acl -LiteralPath $root).Sddl -ceq $parentAcl) 'Ancestor ACL was changed.'
    Assert-Refused { New-Eu20PrivateProofRoot -Path $private } 'already_exists'
    $outside = Join-Path $root 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $outsideAcl = (Get-Acl -LiteralPath $outside).Sddl
    New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
    Assert-Refused { New-Eu20PrivateProofRoot -Path (Join-Path $link 'must-not-exist') } 'proof_path_link_refused'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outside 'must-not-exist'))) 'Reparse target was written.'
    Assert-True ((Get-Acl -LiteralPath $outside).Sddl -ceq $outsideAcl) 'Reparse target ACL was changed.'
    Write-Output 'Actual Windows private ACL/inheritance, broad-ACE refusal, ancestor preservation and junction refusal passed.'

    $runId = 'unit-proof-owner'
    $container = [pscustomobject]@{ Id = ('a' * 64); Name = 'revagent-eu20-b1-gateway'; Kind = 'container' }
    $network = [pscustomobject]@{ Id = ('b' * 64); Name = 'revagent-eu20-b1-private'; Kind = 'network' }
    foreach ($scenario in @('success','stop_failure','remove_failure','network_failure','inventory_failure','foreign_owner','already_absent','untracked_owned_resource')) {
        $state = @{ Present = @{}; Calls = [Collections.Generic.List[string]]::new(); Scenario = $scenario }
        $state.Present[$container.Id] = ($scenario -ne 'already_absent')
        $state.Present[$network.Id] = ($scenario -notin @('already_absent','untracked_owned_resource'))
        $fakeDocker = {
            param([string[]]$Arguments)
            $state.Calls.Add(($Arguments -join ' '))
            $code = 0; $output = @()
            if ($Arguments[1] -eq 'inspect') {
                $id = $Arguments[2]
                if (-not $state.Present[$id]) { $code=1 }
                else {
                    $name = if ($id -eq $container.Id) { '/'+$container.Name } else { $network.Name }
                    $owner = if ($state.Scenario -eq 'foreign_owner') { 'another-owner' } else { $runId }
                    $output = @("$id|$name|$owner")
                }
            }
            elseif ($Arguments[0] -eq 'stop') { if ($state.Scenario -eq 'stop_failure') { $code=1 } }
            elseif ($Arguments[0] -eq 'rm' -or ($Arguments[0] -eq 'network' -and $Arguments[1] -eq 'rm')) {
                $id = $Arguments[-1]
                if ($state.Scenario -eq 'remove_failure' -or ($state.Scenario -eq 'network_failure' -and $id -eq $network.Id)) { $code=1 }
                else { $state.Present[$id]=$false }
            }
            elseif ($Arguments[1] -eq 'ls') {
                if ($state.Scenario -eq 'inventory_failure') { $code=1 }
                else {
                    $idFilters = @($Arguments | Where-Object { $_ -like 'id=*' })
                    $id = if ($idFilters.Count -gt 0) { $idFilters[0].Substring(3) } elseif ($Arguments[0] -eq 'container') { $container.Id } else { $network.Id }
                    if ($state.Present[$id] -and ($idFilters.Count -gt 0 -or $state.Scenario -ne 'foreign_owner')) { $output=@($id.Substring(0,12)) }
                }
            }
            else { throw 'Unexpected cleanup command' }
            return [pscustomobject]@{ ExitCode=$code; Output=$output }
        }.GetNewClosure()
        [object[]]$tracked = @()
        if ($scenario -ne 'untracked_owned_resource') { $tracked = @($container) }
        $trackedNetwork = if ($scenario -eq 'untracked_owned_resource') { $null } else { $network }
        $cleanup = Invoke-Eu20OwnedDockerCleanup -Containers $tracked -Network $trackedNetwork -RunId $runId -DockerCommand $fakeDocker
        $candidate = [ordered]@{ actualImageAndCSharpRead='passed'; protectedFirstInstall='not_exercised' }
        Set-Eu20ProofOverallOutcome -Candidate $candidate -Cleanup $cleanup
        $expectedSuccess = $scenario -in @('success','already_absent')
        Assert-True ($cleanup.Success -eq $expectedSuccess) "Wrong cleanup outcome: $scenario"
        Assert-True ($candidate.actualImageAndCSharpRead -eq 'passed') 'Cleanup changed a real check outcome.'
        if ($expectedSuccess) {
            Assert-Eu20ProofCleanupComplete -Cleanup $cleanup
            Assert-True ($candidate.overallOutcome -eq 'passed' -and $cleanup.VerifiedAbsent.Count -eq 2) 'Successful cleanup did not prove both resources absent.'
        }
        else {
            Assert-True ($candidate.overallOutcome -eq 'failed') 'Failed cleanup left a passing overall outcome.'
            Assert-Refused { Assert-Eu20ProofCleanupComplete -Cleanup $cleanup } 'proof_cleanup_incomplete'
        }
        if ($scenario -eq 'foreign_owner') {
            Assert-True (@($state.Calls | Where-Object { $_ -match '^(stop|rm|network rm) ' }).Count -eq 0) 'Foreign resource was mutated.'
        }
    }
    Write-Output 'Eight Docker cleanup state-machine scenarios passed (unit simulation; not a Docker/privilege proof).'
}
finally {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'eu20-proof-safety-*') { throw 'Test cleanup path escaped its allocated root' }
    [void](Assert-Eu20ProofLocalPath -Path $resolved)
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
