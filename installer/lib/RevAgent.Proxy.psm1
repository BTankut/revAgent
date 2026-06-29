Set-StrictMode -Version Latest

function ConvertTo-RevitMcpProxyUrl {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $normalized = $Value.Trim()
    if ($normalized -match '^(https?://\S+?)\s+(\d+)$') {
        $normalized = "$($Matches[1]):$($Matches[2])"
    }
    elseif ($normalized -match '^(\S+)\s+(\d+)$') {
        $normalized = "$($Matches[1]):$($Matches[2])"
    }

    if ($normalized -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $normalized = "http://$normalized"
    }

    try {
        $uri = [System.Uri]::new($normalized)
        if ([string]::IsNullOrWhiteSpace($uri.Host)) {
            return $normalized.TrimEnd("/")
        }

        return $uri.AbsoluteUri.TrimEnd("/")
    }
    catch {
        return $normalized.TrimEnd("/")
    }
}

function ConvertTo-RevitMcpWinHttpProxyServer {
    param([string]$Value)

    $normalized = ConvertTo-RevitMcpProxyUrl -Value $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }

    try {
        $uri = [System.Uri]::new($normalized)
        if (-not [string]::IsNullOrWhiteSpace($uri.Host)) {
            return ("{0}:{1}" -f $uri.Host, $uri.Port)
        }
    }
    catch {}

    return ($normalized -replace '^[a-zA-Z][a-zA-Z0-9+.-]*://', '').TrimEnd("/")
}

$revAgentFunctionAliases = @{
    "ConvertTo-RevAgentProxyUrl" = "ConvertTo-RevitMcpProxyUrl"
    "ConvertTo-RevAgentWinHttpProxyServer" = "ConvertTo-RevitMcpWinHttpProxyServer"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function ConvertTo-RevitMcpProxyUrl, ConvertTo-RevitMcpWinHttpProxyServer
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
