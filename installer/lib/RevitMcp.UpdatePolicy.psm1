Set-StrictMode -Version Latest

# Compatibility wrapper. New code should import RevAgent.UpdatePolicy.psm1.
$module = Import-Module (Join-Path $PSScriptRoot "RevAgent.UpdatePolicy.psm1") -Force -PassThru
Export-ModuleMember -Function @($module.ExportedFunctions.Keys) -Alias @($module.ExportedAliases.Keys)
