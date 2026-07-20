[CmdletBinding()]
param()

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    [Console]::Error.WriteLine("revAgent bootstrap trust broker requires FullLanguage Windows PowerShell. actual=$($ExecutionContext.SessionState.LanguageMode)")
    exit 78
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$programDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$trustRoot = [IO.Path]::GetFullPath((Join-Path $programDataRoot 'DPE\revAgent\trust'))
$modulePath = [IO.Path]::GetFullPath((Join-Path $trustRoot 'RevAgent.BootstrapTrust.psm1'))
$canonicalPowerShellHome = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\WindowsPowerShell\v1.0'))
if (-not [string]::Equals([IO.Path]::GetFullPath($PSHOME).TrimEnd('\'), $canonicalPowerShellHome.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    [Console]::Error.WriteLine("revAgent bootstrap trust broker must run in canonical Windows PowerShell 5.1. actual=$PSHOME")
    exit 78
}
$env:PSModulePath = @(
    (Join-Path $canonicalPowerShellHome 'Modules'),
    (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\WindowsPowerShell\v1.0\Modules')
) -join [IO.Path]::PathSeparator

$module = $null
try {
    if (-not [IO.File]::Exists($modulePath)) { throw "Protected bootstrap trust module was not found: $modulePath" }
    $module = Microsoft.PowerShell.Core\Import-Module -Name $modulePath -Force -PassThru -ErrorAction Stop
    $command = Get-Command ("{0}\Invoke-RevAgentBootstrapTrustBrokerQueue" -f $module.Name) -ErrorAction Stop
    $result = & $command
    $result | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress | Write-Output
    exit 0
}
catch {
    [Console]::Error.WriteLine("revAgent bootstrap trust broker failed closed: $($_.Exception.Message)")
    exit 84
}
finally {
    if ($null -ne $module) { Microsoft.PowerShell.Core\Remove-Module -ModuleInfo $module -Force -ErrorAction SilentlyContinue }
}
