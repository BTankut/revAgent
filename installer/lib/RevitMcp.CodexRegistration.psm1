Set-StrictMode -Version Latest

function ConvertTo-RevitMcpTomlString {
    param([string]$Value)

    return '"' + ([string]$Value).Replace('\', '\\').Replace('"', '\"') + '"'
}

function Set-RevitMcpCodexMcpServerConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$McpArgs = @()
    )

    $configDir = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ConfigPath
    }
    else {
        ""
    }

    $sectionPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\s*.*?(?=^\[|\z)"
    $argsToml = "[" + (($McpArgs | ForEach-Object { ConvertTo-RevitMcpTomlString -Value $_ }) -join ", ") + "]"
    $section = @(
        "[mcp_servers.$Name]",
        "command = $(ConvertTo-RevitMcpTomlString -Value $Command)",
        "args = $argsToml",
        ""
    ) -join "`r`n"

    if ($existing -match $sectionPattern) {
        $updated = [regex]::Replace($existing, $sectionPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $section })
    }
    else {
        $prefix = if ([string]::IsNullOrWhiteSpace($existing)) { "" } else { $existing.TrimEnd() + "`r`n`r`n" }
        $updated = $prefix + $section
    }

    Set-Content -LiteralPath $ConfigPath -Value $updated -Encoding UTF8
    return $ConfigPath
}

function Register-RevitMcpCodexMcpServersInConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$NodePath,
        [Parameter(Mandatory = $true)]
        [string]$RuntimeServerPath,
        [Parameter(Mandatory = $true)]
        [string]$DocsServerPath
    )

    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revit-mcp" -Command $NodePath -McpArgs @($RuntimeServerPath))
    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revit-api-docs" -Command $NodePath -McpArgs @($DocsServerPath))
    return $ConfigPath
}

Export-ModuleMember -Function ConvertTo-RevitMcpTomlString, Set-RevitMcpCodexMcpServerConfig, Register-RevitMcpCodexMcpServersInConfig
