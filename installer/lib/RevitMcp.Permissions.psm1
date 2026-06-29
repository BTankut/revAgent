Set-StrictMode -Version Latest

# Compatibility wrapper. New code should import RevAgent.Permissions.psm1.
$module = Import-Module (Join-Path $PSScriptRoot "RevAgent.Permissions.psm1") -Force -PassThru
Export-ModuleMember -Function @($module.ExportedFunctions.Keys) -Alias @($module.ExportedAliases.Keys)
