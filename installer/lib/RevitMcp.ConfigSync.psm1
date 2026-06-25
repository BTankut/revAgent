Set-StrictMode -Version Latest

function Sync-RevitMcpUpdaterConfigDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,
        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot
    )

    if ([string]::IsNullOrWhiteSpace($SourceRoot) -or -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        return
    }

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

    # Preserve only top-level local config files. Update this helper before moving trust/license files into subdirectories.
    $preserveNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @("release-trusted-keys.json", "license-trusted-keys.json", "revagent-license.json", "revagent-license.sig.json")) {
        [void]$preserveNames.Add($name)
    }

    $sourceNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in Get-ChildItem -LiteralPath $SourceRoot -Force) {
        [void]$sourceNames.Add($item.Name)
    }

    # Mirror shipped config while preserving local trust/license material intentionally not shipped inside source-free release ZIPs.
    foreach ($item in Get-ChildItem -LiteralPath $DestinationRoot -Force -ErrorAction SilentlyContinue) {
        if ($sourceNames.Contains($item.Name) -or -not $preserveNames.Contains($item.Name)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
    }

    foreach ($item in Get-ChildItem -LiteralPath $SourceRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $DestinationRoot -Recurse -Force
    }
}

Export-ModuleMember -Function Sync-RevitMcpUpdaterConfigDirectory
