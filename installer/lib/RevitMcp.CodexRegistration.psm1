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

function Set-RevitMcpTomlScalar {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Section,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $keyPattern = "(?m)^(\s*)$([regex]::Escape($Key))\s*=.*$"
    if ([string]::IsNullOrWhiteSpace($Section)) {
        $firstTableMatch = [regex]::Match($Content, "(?m)^\s*\[")
        $rootContent = if ($firstTableMatch.Success) {
            $Content.Substring(0, $firstTableMatch.Index)
        }
        else {
            $Content
        }
        $tableContent = if ($firstTableMatch.Success) {
            $Content.Substring($firstTableMatch.Index)
        }
        else {
            ""
        }

        if ($rootContent -match $keyPattern) {
            return [regex]::Replace($rootContent, $keyPattern, "`$1$Key = $Value") + $tableContent
        }

        if ([string]::IsNullOrWhiteSpace($rootContent)) {
            return "$Key = $Value`r`n" + $tableContent
        }

        return $rootContent.TrimEnd() + "`r`n$Key = $Value`r`n" + $tableContent
    }

    $sectionPattern = "(?ms)^\[$([regex]::Escape($Section))\]\s*.*?(?=^\[|\z)"
    if ($Content -match $sectionPattern) {
        return [regex]::Replace($Content, $sectionPattern, [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            $block = [string]$match.Value
            if ($block -match $keyPattern) {
                return [regex]::Replace($block, $keyPattern, "`$1$Key = $Value")
            }

            return ($block.TrimEnd() + "`r`n$Key = $Value`r`n")
        })
    }

    $prefix = if ([string]::IsNullOrWhiteSpace($Content)) { "" } else { $Content.TrimEnd() + "`r`n`r`n" }
    return $prefix + "[$Section]`r`n$Key = $Value`r`n"
}

function Normalize-RevitMcpCodexServiceTier {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $content = [regex]::Replace($Content, '(?m)^(\s*service_tier\s*=\s*)"priority"\s*$', '${1}"fast"')
    return Set-RevitMcpTomlScalar -Content $content -Section "" -Key "service_tier" -Value '"fast"'
}

function Set-RevitMcpCodexMemoryConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    $configDir = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $content = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ConfigPath
    }
    else {
        ""
    }
    $original = $content

    $content = Normalize-RevitMcpCodexServiceTier -Content $content
    $content = Set-RevitMcpTomlScalar -Content $content -Section "features" -Key "memories" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "features" -Key "chronicle" -Value "false"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "disable_on_external_context" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "generate_memories" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "use_memories" -Value "true"

    if ($content -ne $original) {
        Set-Content -LiteralPath $ConfigPath -Value $content -Encoding UTF8
    }
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
    [void](Set-RevitMcpCodexMemoryConfig -ConfigPath $ConfigPath)
    return $ConfigPath
}

Export-ModuleMember -Function ConvertTo-RevitMcpTomlString, Set-RevitMcpCodexMcpServerConfig, Set-RevitMcpCodexMemoryConfig, Register-RevitMcpCodexMcpServersInConfig
