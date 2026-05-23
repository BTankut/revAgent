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

Export-ModuleMember -Function Get-RevitMcpUpdateDecision
