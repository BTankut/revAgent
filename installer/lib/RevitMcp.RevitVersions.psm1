Set-StrictMode -Version Latest

# Compatibility wrapper. New code should import RevAgent.RevitVersions.psm1.
$module = Import-Module (Join-Path $PSScriptRoot "RevAgent.RevitVersions.psm1") -Force -PassThru
Export-ModuleMember -Function @($module.ExportedFunctions.Keys) -Alias @($module.ExportedAliases.Keys)
