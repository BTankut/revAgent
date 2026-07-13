<#
.SYNOPSIS
    Retired unsigned NAS channel promotion entrypoint.

.DESCRIPTION
    This compatibility entrypoint is intentionally fail-closed. Signed channel
    promotion is owned exclusively by the handle-bound signed publisher.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [ValidateSet("stable")]
    [string]$Channel = "stable"
)

$ErrorActionPreference = "Stop"

throw 'Unsigned direct channel promotion is disabled. Build a signed local staging root, then publish it only through scripts\publish-signed-source-free-release-to-nas.ps1 so signature, sequence, CAS, and handle-bound transport guards are enforced.'
