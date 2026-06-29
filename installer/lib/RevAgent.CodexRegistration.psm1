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

function Remove-RevitMcpCodexMcpServerConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $ConfigPath
    }

    $existing = Get-Content -Raw -LiteralPath $ConfigPath
    $sectionPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\s*.*?(?=^\[|\z)"
    $updated = [regex]::Replace($existing, $sectionPattern, "")
    $updated = [regex]::Replace($updated, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"

    if ($updated -ne $existing) {
        Set-Content -LiteralPath $ConfigPath -Value $updated -Encoding UTF8
    }
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

function Set-RevitMcpManagedPowerShellProfileBlock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath,
        [Parameter(Mandatory = $true)]
        [string]$Block
    )

    $profileDir = Split-Path -Parent $ProfilePath
    if (-not [string]::IsNullOrWhiteSpace($profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ProfilePath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ProfilePath
    }
    else {
        ""
    }

    $begin = "# BEGIN revAgent UTF-8 console"
    $end = "# END revAgent UTF-8 console"
    $pattern = "(?ms)^$([regex]::Escape($begin))\r?\n.*?\r?\n$([regex]::Escape($end))\r?\n?"

    if ($existing -match $pattern) {
        $updated = [regex]::Replace($existing, $pattern, $Block + "`r`n")
    }
    else {
        $prefix = if ([string]::IsNullOrWhiteSpace($existing)) { "" } else { $existing.TrimEnd() + "`r`n`r`n" }
        $updated = $prefix + $Block + "`r`n"
    }

    if ($updated -ne $existing) {
        Set-Content -LiteralPath $ProfilePath -Value $updated -Encoding UTF8
    }

    return $ProfilePath
}

function Set-RevitMcpCurrentProcessUtf8Console {
    try {
        $revAgentUtf8Encoding = [System.Text.UTF8Encoding]::new($false)
        [Console]::InputEncoding = $revAgentUtf8Encoding
        [Console]::OutputEncoding = $revAgentUtf8Encoding
        $global:OutputEncoding = $revAgentUtf8Encoding
        $env:PYTHONUTF8 = "1"
        $env:PYTHONIOENCODING = "utf-8"
        if (Get-Command chcp.com -ErrorAction SilentlyContinue) {
            & chcp.com 65001 > $null
        }

        return [ordered]@{
            success = $true
            codePage = 65001
            error = ""
        }
    }
    catch {
        return [ordered]@{
            success = $false
            codePage = 0
            error = $_.Exception.Message
        }
    }
}

function Set-RevitMcpPowerShellUtf8ConsoleConfig {
    param(
        [string]$UserProfileRoot = "",
        [switch]$ConfigureConsoleRegistry
    )

    if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
        $UserProfileRoot = $env:USERPROFILE
    }
    if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
        return @()
    }

    $block = @(
        "# BEGIN revAgent UTF-8 console",
        'try {',
        '    $revAgentUtf8Encoding = [System.Text.UTF8Encoding]::new($false)',
        '    [Console]::InputEncoding = $revAgentUtf8Encoding',
        '    [Console]::OutputEncoding = $revAgentUtf8Encoding',
        '    $OutputEncoding = $revAgentUtf8Encoding',
        '    $env:PYTHONUTF8 = "1"',
        '    $env:PYTHONIOENCODING = "utf-8"',
        '    if (Get-Command chcp.com -ErrorAction SilentlyContinue) { & chcp.com 65001 > $null }',
        '} catch {}',
        "# END revAgent UTF-8 console"
    ) -join "`r`n"

    $documentsRoot = Join-Path $UserProfileRoot "Documents"
    $profilePaths = @(
        (Join-Path $documentsRoot "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"),
        (Join-Path $documentsRoot "PowerShell\Microsoft.PowerShell_profile.ps1")
    )

    $written = [System.Collections.Generic.List[string]]::new()
    foreach ($profilePath in $profilePaths) {
        [void]$written.Add((Set-RevitMcpManagedPowerShellProfileBlock -ProfilePath $profilePath -Block $block))
    }

    if ($ConfigureConsoleRegistry) {
        try {
            New-Item -Path "HKCU:\Console" -Force | Out-Null
            New-ItemProperty -Path "HKCU:\Console" -Name "CodePage" -Value 65001 -PropertyType DWord -Force | Out-Null
        }
        catch {
            Write-Warning "Could not set HKCU console UTF-8 code page: $($_.Exception.Message)"
        }
    }

    return @($written.ToArray())
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

    foreach ($legacyName in @("revit-mcp", "revit-api-docs")) {
        [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name $legacyName)
    }

    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revAgent" -Command $NodePath -McpArgs @($RuntimeServerPath))
    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revAgent-api-docs" -Command $NodePath -McpArgs @($DocsServerPath))
    [void](Set-RevitMcpCodexMemoryConfig -ConfigPath $ConfigPath)
    return $ConfigPath
}

Export-ModuleMember -Function ConvertTo-RevitMcpTomlString, Set-RevitMcpCodexMcpServerConfig, Remove-RevitMcpCodexMcpServerConfig, Set-RevitMcpCodexMemoryConfig, Set-RevitMcpCurrentProcessUtf8Console, Set-RevitMcpPowerShellUtf8ConsoleConfig, Register-RevitMcpCodexMcpServersInConfig
