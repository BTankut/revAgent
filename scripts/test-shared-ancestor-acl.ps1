<#
.SYNOPSIS
    Test shared bootstrap ancestor ACL validation without changing filesystem ACLs.
#>

[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    if ($null -eq $caught) { throw "$Message Expected an exception." }
    if (-not ([string]$caught.Exception.Message -match $Pattern)) { throw "$Message Unexpected exception: $($caught.Exception.Message)" }
}

function New-TestDirectoryAcl {
    param([Security.AccessControl.PropagationFlags]$PropagationFlags)

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
    $inheritanceFlags = if (($PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritanceFlags,
            $PropagationFlags,
            [Security.AccessControl.AccessControlType]::Allow))
    return $acl
}

function New-ValidatorTestModule {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$ValidatorName,
        [Parameter(Mandatory = $true)][string]$LinkGuardName
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -ne 0) {
        throw "Could not parse shared ancestor validator source: $SourcePath`n$([string]::Join("`n", [string[]]@($parseErrors)))"
    }
    $validatorAst = $ast.Find({
            param($node)
            return $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $ValidatorName
        }, $true)
    if ($null -eq $validatorAst) { throw "Shared ancestor validator was not found: $ValidatorName" }

    $moduleText = @"
`$script:TestAcl = `$null
function Get-Acl {
    [CmdletBinding()]
    param([Parameter(Mandatory = `$true)][string]`$LiteralPath)
    return `$script:TestAcl
}
function Set-Acl { throw 'Shared ancestor validation must remain read-only.' }
function $LinkGuardName {
    param([Parameter(Mandatory = `$true)][string]`$Path)
    return [IO.Path]::GetFullPath(`$Path)
}
$($validatorAst.Extent.Text)
Export-ModuleMember -Function @()
"@
    return New-Module -Name ("revAgentSharedAncestorAclTest_" + [Guid]::NewGuid().ToString("N")) -ScriptBlock ([scriptblock]::Create($moduleText))
}

function Invoke-TestValidator {
    param(
        [Parameter(Mandatory = $true)][Management.Automation.PSModuleInfo]$Module,
        [Parameter(Mandatory = $true)][string]$ValidatorName,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Security.AccessControl.DirectorySecurity]$Acl
    )

    & $Module {
        param($Name, $TargetPath, $TestAcl)
        $script:TestAcl = $TestAcl
        & $Name -Path $TargetPath
    } $ValidatorName $Path $Acl
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("revagent-shared-ancestor-acl-test-" + [Guid]::NewGuid().ToString("N"))
$modules = @()
try {
    New-Item -ItemType Directory -Path $fixtureRoot -ErrorAction Stop | Out-Null

    Write-Host "Test production apply shared-root non-mutation contract"
    $refreshSourcePath = Join-Path $RepoRoot "installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1"
    $refreshTokens = $null
    $refreshParseErrors = $null
    $refreshAst = [Management.Automation.Language.Parser]::ParseFile($refreshSourcePath, [ref]$refreshTokens, [ref]$refreshParseErrors)
    if (@($refreshParseErrors).Count -ne 0) {
        throw "Could not parse bootstrap refresh source: $refreshSourcePath`n$([string]::Join("`n", [string[]]@($refreshParseErrors)))"
    }
    $applyFunctions = @($refreshAst.FindAll({
                param($node)
                return $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq "Invoke-AuthenticatedBootstrapApply"
            }, $true))
    Assert-True ($applyFunctions.Count -eq 1) "Bootstrap refresh must define exactly one authenticated production apply function."
    $applyText = [string]$applyFunctions[0].Extent.Text
    Assert-True ($applyText -notmatch '(?i)\bSet-AdminOnlyAcl\s+(?:-Path\s+)?\$dpeRoot\b') "Production apply must not mutate the shared DPE ancestor with Set-AdminOnlyAcl."
    Assert-True ($applyText -match '(?i)\bSet-AdminOnlyAcl\s+(?:-Path\s+)?\$productRoot\b') "Production apply must protect the exact revAgent product root."
    Assert-True ($applyText -match '(?i)\bSet-AdminOnlyAcl\s+(?:-Path\s+)?\$prestageRoot\b') "Production apply must protect the exact revAgent prestage root."

    $inheritOnlyAcl = New-TestDirectoryAcl -PropagationFlags ([Security.AccessControl.PropagationFlags]::InheritOnly)
    $appliedAcl = New-TestDirectoryAcl -PropagationFlags ([Security.AccessControl.PropagationFlags]::None)
    $inheritOnlyRule = @($inheritOnlyAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) | Select-Object -First 1
    Assert-True (($inheritOnlyRule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) "The safe test fixture must contain an inherit-only ACE."

    $cases = @(
        [pscustomobject]@{
            SourcePath = Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1"
            ValidatorName = "Assert-RevAgentPrestageSharedAncestorSafe"
            LinkGuardName = "Assert-RevAgentPrestagePathNoLinks"
        },
        [pscustomobject]@{
            SourcePath = Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1"
            ValidatorName = "Assert-RevAgentBootstrapSharedAncestorSafe"
            LinkGuardName = "Assert-RevAgentBootstrapLinkSafe"
        }
    )

    foreach ($case in $cases) {
        Write-Host "Test $($case.ValidatorName) inherit-only filtering"
        $module = New-ValidatorTestModule -SourcePath $case.SourcePath -ValidatorName $case.ValidatorName -LinkGuardName $case.LinkGuardName
        $modules += $module
        Invoke-TestValidator -Module $module -ValidatorName $case.ValidatorName -Path $fixtureRoot -Acl $inheritOnlyAcl | Out-Null
        Assert-ThrowsLike -Action {
            Invoke-TestValidator -Module $module -ValidatorName $case.ValidatorName -Path $fixtureRoot -Acl $appliedAcl | Out-Null
        } -Pattern "bootstrap_parent_not_protected: shared .*grants" -Message "$($case.ValidatorName) must still reject an applied dangerous non-administrator ACE."
    }
}
finally {
    foreach ($module in $modules) { Remove-Module $module -Force -ErrorAction SilentlyContinue }
    if ([IO.Directory]::Exists($fixtureRoot)) { [IO.Directory]::Delete($fixtureRoot, $true) }
}

$leakedMocks = @(Get-Command Get-Acl, Set-Acl -All | Where-Object {
        $_.CommandType -eq [Management.Automation.CommandTypes]::Function -and
        [string]$_.Source -like 'revAgentSharedAncestorAclTest_*'
    })
Assert-True ($leakedMocks.Count -eq 0) 'Shared ancestor ACL fixture leaked a filesystem ACL mock into the caller session.'

Write-Host "Shared bootstrap ancestor ACL tests passed." -ForegroundColor Green
