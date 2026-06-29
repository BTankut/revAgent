Set-StrictMode -Version Latest

function Get-RevitMcpUpdateDecision {
    param(
        [switch]$IsFirstInstall,
        [switch]$HasReleaseManifest,
        [switch]$HasReleaseComponents,
        [int]$RevitPayloadChangeCount = 0,
        [switch]$IsRevitRunning
    )

    $requiresRevitClosed = [bool]$IsFirstInstall -or
        (-not [bool]$HasReleaseManifest) -or
        (-not [bool]$HasReleaseComponents) -or
        ($RevitPayloadChangeCount -gt 0)

    return [pscustomobject]@{
        RequiresRevitClosed = $requiresRevitClosed
        DeferForRevitClose = ([bool]$IsRevitRunning -and $requiresRevitClosed)
        SkipRevitPayloadInstall = (-not $requiresRevitClosed)
    }
}

$revAgentFunctionAliases = @{
    "Get-RevAgentUpdateDecision" = "Get-RevitMcpUpdateDecision"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function Get-RevitMcpUpdateDecision
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
