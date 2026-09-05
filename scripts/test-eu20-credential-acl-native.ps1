#requires -Version 5.1
<# Actual elevated Windows regression. No service, identity, token or machine
   installation. Creates only a fresh caller-selected evidence directory and
   disposable ACL fixtures beneath it; never changes an ancestor ACL. #>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($PSVersionTable.PSEdition -cne 'Desktop'){throw 'native_acl_test_requires_windows_powershell_51'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'native_acl_test_actual_administrator_required'}
$repo=Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $repo 'installer\bridge\lib\RevAgent.BridgeInstall.psm1') -Force
$root=[IO.Path]::GetFullPath($EvidenceRoot)
[void](Assert-RevAgentBridgeNoReparsePoint -Path $root -GuardRoot (Split-Path $root -Parent))
if(Test-Path -LiteralPath $root){throw 'native_acl_test_requires_fresh_root'}
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$security.SetAccessRuleProtection($true,$false)
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[void][IO.Directory]::CreateDirectory($root,$security)
$checks=[Collections.Generic.List[string]]::new();$stage='start';$passed=$false
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "native_acl_test_failed:$Name"};$checks.Add($Name)}
function ExactAcl([string]$Path){
    $a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    Check ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-18') 'SYSTEM owner'
    Check ($a.AreAccessRulesProtected -and $rules.Count -eq 2) 'protected two ACEs'
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){$r=@($rules|Where-Object{$_.IdentityReference.Value -ceq $sid});Check ($r.Count -eq 1 -and -not $r[0].IsInherited -and $r[0].AccessControlType -eq 'Allow' -and $r[0].FileSystemRights -eq 'FullControl' -and $r[0].InheritanceFlags -eq 'None' -and $r[0].PropagationFlags -eq 'None') "exact $sid allow"}
}
try{
    $stage='fresh_inherited_directory';$credentials=Join-Path $root 'credentials';[void][IO.Directory]::CreateDirectory($credentials)
    $initial=Get-Acl -LiteralPath $credentials
    Check (@($initial.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])).Count -eq 0) 'fresh directory inherited-only'
    Set-RevAgentBridgeSystemOnlyAcl -Path $credentials;ExactAcl $credentials
    $directorySddl=(Get-Acl -LiteralPath $credentials).Sddl
    $stage='directory_idempotency';Set-RevAgentBridgeSystemOnlyAcl -Path $credentials
    Check ((Get-Acl -LiteralPath $credentials).Sddl -ceq $directorySddl) 'directory idempotent'
    $stage='file_in_credential_parent';$file=Join-Path $credentials 'public-fixture.txt'
    [IO.File]::WriteAllText($file,'public ACL regression fixture')
    $fileBefore=Get-Acl -LiteralPath $file
    @{sddl=$fileBefore.Sddl;explicitRules=@($fileBefore.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights}})}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $root 'file-baseline.json') -Encoding UTF8
    Set-RevAgentBridgeSystemOnlyAcl -Path $file;ExactAcl $file
    Check ([IO.File]::ReadAllText($file) -ceq 'public ACL regression fixture') 'file remains accessible'
    $fileSddl=(Get-Acl -LiteralPath $file).Sddl;Set-RevAgentBridgeSystemOnlyAcl -Path $file
    Check ((Get-Acl -LiteralPath $file).Sddl -ceq $fileSddl) 'file idempotent'
    $stage='foreign_ace_refusal'
    foreach($deny in @($false,$true)){
        $foreign=Join-Path $root ('foreign-'+$deny);[void][IO.Directory]::CreateDirectory($foreign);$a=Get-Acl -LiteralPath $foreign
        $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read',$(if($deny){'Deny'}else{'Allow'})))
        Set-Acl -LiteralPath $foreign -AclObject $a;$before=(Get-Acl -LiteralPath $foreign).Sddl;$refused=$false
        try{Set-RevAgentBridgeSystemOnlyAcl -Path $foreign}catch{$refused=$_.Exception.Message -ceq 'bridge_credential_acl_unexpected_ace'}
        Check $refused "foreign or deny refusal $deny";Check ((Get-Acl -LiteralPath $foreign).Sddl -ceq $before) "refusal preserves DACL $deny"
        [IO.Directory]::Delete($foreign,$false)
    }
    $stage='native_error_propagation';$vanishing=Join-Path $root 'vanishing';[void][IO.Directory]::CreateDirectory($vanishing)
    # Remove only this empty owned fixture after its real preflight ACL read.
    # The producer must report the actual icacls nonzero exit, even in PS5.
    function Get-Acl {param([string]$LiteralPath,$ErrorAction);$a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop;if($LiteralPath -ceq $vanishing){[IO.Directory]::Delete($vanishing,$false)};return $a}
    $nativeFailed=$false
    try{Set-RevAgentBridgeSystemOnlyAcl -Path $vanishing}catch{$nativeFailed=$_.Exception.Message -match '^bridge_credential_icacls_failed: exit=[1-9][0-9]* operation=/grant:r$'}finally{Remove-Item Function:\Get-Acl}
    Check $nativeFailed 'real native error propagated'
    $stage='cleanup';[IO.File]::Delete($file);[IO.Directory]::Delete($credentials,$false)
    $passed=$true
}
finally{
    $outcome=[ordered]@{passed=$passed;stage=$stage;actualElevated=$true;checks=$checks.ToArray();checkCount=$checks.Count;moduleSha256=(Get-FileHash -LiteralPath (Join-Path $repo 'installer\bridge\lib\RevAgent.BridgeInstall.psm1')).Hash;fixtureCleanupComplete=$passed;failedFixturesPreserved=(-not $passed)}
    $outcome|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $root 'native-acl-result.json') -Encoding UTF8
    $outcome|ConvertTo-Json -Depth 6
}
