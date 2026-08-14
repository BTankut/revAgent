<#
.SYNOPSIS
    Relay one allowlisted M4 secret between two exact SSH endpoints.

.DESCRIPTION
    The coordinator never decodes secret bytes. It binds an exact immutable
    Gateway image on the source host to an exact self-hashing receiver on the
    Windows destination, uses one bounded deadline, and fails closed unless
    source cleanup is positively proved before destination commit.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("north_bearer", "enrollment_artifact")]
    [string]$Kind,

    [Parameter(Mandatory = $true)]
    [string]$SourceSelector,

    [Parameter(Mandatory = $true)]
    [string]$DestinationSelector,

    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ImageRef,

    [Parameter(Mandatory = $true)]
    [string]$ReceiverPath,

    [Parameter(Mandatory = $true)]
    [string]$ReceiverSha256,

    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,

    [Parameter(Mandatory = $true)]
    [string]$SshSha256,

    [Parameter(Mandatory = $true)]
    [string]$KnownHostsFile,

    [Parameter(Mandatory = $true)]
    [string]$SourceUidGid,

    [ValidateRange(10, 120)]
    [int]$TimeoutSeconds = 30,

    [ValidateSet("north_refusal_v1", "current_user_dpapi_broker_v1")]
    [string]$DestinationDisposition = "north_refusal_v1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot "M4SecretHandoffCoordinator.psm1") -Force

$contractVersion = "revagent.m4-secret-handoff/v1"
$action = "invoke_m4_secret_handoff"

function Stop-RevAgentInvalidInvocation {
    $line = [ordered]@{
        ok = $false
        action = $action
        contractVersion = $contractVersion
        kind = $(if ($Kind -in @("north_bearer", "enrollment_artifact")) { $Kind } else { "invalid" })
        code = "m4_secret_handoff_refused"
        reason = "invalid_invocation"
    } | ConvertTo-Json -Compress
    [Console]::Out.Write($line + "`n")
    exit 64
}

function Test-RevAgentCanonicalNonReparseFile {
    param([string]$Path)

    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or
            -not [System.IO.Path]::IsPathRooted($Path) -or
            $Path.StartsWith("\\", [System.StringComparison]::Ordinal)) {
            return $false
        }
        $full = [System.IO.Path]::GetFullPath($Path)
        if (-not [string]::Equals($full, $Path, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            return $false
        }
        $cursor = Get-Item -LiteralPath $full -Force
        while ($null -ne $cursor) {
            if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return $false
            }
            $cursor = if ($cursor -is [System.IO.FileInfo]) {
                $cursor.Directory
            }
            else {
                $cursor.Parent
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Test-RevAgentPrivateIdentityFile {
    param([string]$Path)

    if (-not (Test-RevAgentCanonicalNonReparseFile -Path $Path)) { return $false }
    try {
        $acl = Get-Acl -LiteralPath $Path
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $ownerSid = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate(
            [System.Security.Principal.SecurityIdentifier]
        )
        if ($ownerSid.Value -ne $currentSid.Value) { return $false }
        $allowed = @{}
        foreach ($sid in @(
                $currentSid,
                (New-Object System.Security.Principal.SecurityIdentifier(
                    [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
                    $null
                )),
                (New-Object System.Security.Principal.SecurityIdentifier(
                    [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
                    $null
                ))
            )) {
            $allowed[$sid.Value] = $true
        }
        foreach ($rule in $acl.GetAccessRules(
                $true,
                $true,
                [System.Security.Principal.SecurityIdentifier]
            )) {
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                -not $allowed.ContainsKey($rule.IdentityReference.Value)) {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function New-RevAgentSshStartInfo {
    param(
        [string]$SshPath,
        [string]$Selector,
        [string]$RemoteCommand,
        [bool]$RedirectInput
    )

    $normalizedKnownHosts = $KnownHostsFile.Replace("\", "/")
    $argumentVector = @(
        "-T",
        "-F", "NUL",
        "-p", "22",
        "-i", $IdentityFile,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=$normalizedKnownHosts",
        "-o", "GlobalKnownHostsFile=NUL",
        "-o", "ProxyCommand=none",
        "-o", "ProxyJump=none",
        "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
        $Selector,
        $RemoteCommand
    )
    return New-RevAgentProcessStartInfo `
        -FilePath $SshPath `
        -ArgumentVector $argumentVector `
        -RedirectInput $RedirectInput
}

try {
    $sshPath = [System.IO.Path]::GetFullPath("$env:WINDIR\System32\OpenSSH\ssh.exe")
    $posixRoot = '^/[A-Za-z0-9._/-]+$'
    $windowsPath = '^[A-Za-z]:\\[A-Za-z0-9._\\-]+$'
    $imagePattern = '^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$'
    $uidGidPattern = '^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$'
    $shaPattern = '^[a-f0-9]{64}$'

    $receiverSha256 = $ReceiverSha256.ToLowerInvariant()
    $sshSha256 = $SshSha256.ToLowerInvariant()
    if ($SourceSelector -ne "bt@192.168.90.154" -or
        $DestinationSelector -ne "ws2@192.168.90.122" -or
        $SourceRoot -notmatch $posixRoot -or
        $SourceRoot.Contains("//") -or
        $SourceRoot.Split('/') -contains ".." -or
        $DestinationRoot -notmatch $windowsPath -or
        $ReceiverPath -notmatch $windowsPath -or
        $ImageRef -notmatch $imagePattern -or
        $SourceUidGid -notmatch $uidGidPattern -or
        $receiverSha256 -notmatch $shaPattern -or
        $sshSha256 -notmatch $shaPattern -or
        $IdentityFile -notmatch $windowsPath -or
        $KnownHostsFile -notmatch $windowsPath -or
        ($DestinationDisposition -eq "current_user_dpapi_broker_v1" -and
            $Kind -ne "north_bearer") -or
        -not (Test-RevAgentCanonicalNonReparseFile -Path $sshPath) -or
        -not (Test-RevAgentPrivateIdentityFile -Path $IdentityFile) -or
        -not (Test-RevAgentPrivateIdentityFile -Path $KnownHostsFile)) {
        Stop-RevAgentInvalidInvocation
    }

    $actualSshHash = (Get-FileHash -LiteralPath $sshPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sshSignature = Get-AuthenticodeSignature -LiteralPath $sshPath
    if ($actualSshHash -ne $sshSha256 -or
        $sshSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        Stop-RevAgentInvalidInvocation
    }

    $containerRoot = "/run/revagent-m4-handoff"
    $sourceEntrypoint = "/app/packages/gateway/dist/preProductionSecretHandoffSourceMain.js"
    $sourceContainerName = "revagent-m4-handoff-" + [Guid]::NewGuid().ToString("N")
    $commonDocker = @(
        "sudo", "-n", "docker", "run",
        "--rm",
        "--restart=no",
        "--pull=never",
        "--log-driver=none",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user", $SourceUidGid
    )
    $sourceCommand = @(
        $commonDocker,
        "--name", $sourceContainerName,
        "--mount", "type=bind,src=$SourceRoot/runtime/handoff,dst=$containerRoot",
        "--env", "NODE_ENV=preproduction",
        $ImageRef,
        "node", $sourceEntrypoint,
        "--contract", $contractVersion,
        "--kind", $Kind,
        "--root", $containerRoot
    ) -join " "
    $probeContainerName = $sourceContainerName + "-probe"
    $expectedSourceProbeJson = '{"ok":true,"action":"probe_preproduction_secret_handoff_source_absence","contractVersion":"revagent.m4-secret-handoff/v1","kind":"' + $Kind + '","sourceAbsent":true}'
    $combinedSourceProbeJson = '{"ok":true,"action":"probe_preproduction_secret_handoff_source_absence","contractVersion":"revagent.m4-secret-handoff/v1","kind":"' + $Kind + '","sourceAbsent":true,"containerAbsent":true}'
    # Local ssh termination cannot prove that its remote docker child exited.
    # This script is base64-transported as one argv value. Every daemon query
    # is a standalone assignment, so a sudo/daemon error cannot masquerade as
    # an empty inventory. After removing an exact survivor, the immutable
    # image's lstat-based probe validates the dedicated root and distinguishes
    # ENOENT from symlink, access, and other stat failures. Commit is possible
    # only after both named containers are then positively absent.
    $sourceProbeScript = New-RevAgentSourceCleanupProbeScript `
        -SourceContainerName $sourceContainerName `
        -ProbeContainerName $probeContainerName `
        -SourceUidGid $SourceUidGid `
        -SourceRoot $SourceRoot `
        -ImageRef $ImageRef `
        -Kind $Kind `
        -ExpectedProbeJson $expectedSourceProbeJson `
        -CombinedProbeJson $combinedSourceProbeJson
    $sourceProbeBytes = [System.Text.Encoding]::UTF8.GetBytes($sourceProbeScript)
    try {
        $sourceProbeEncoded = [Convert]::ToBase64String($sourceProbeBytes)
    }
    finally {
        [Array]::Clear($sourceProbeBytes, 0, $sourceProbeBytes.Length)
    }
    # Base64 carries the shell program through Windows argv, ssh's remote
    # command reconstruction, and the Linux login shell without another
    # quoting layer. The decoded script contains no secret material.
    $sourceProbeCommand = "printf %s $sourceProbeEncoded | base64 -d | sh"
    $destinationArgumentVector = @(
        "cmd.exe", "/d", "/s", "/c",
        $ReceiverPath,
        "--contract", $contractVersion,
        "--kind", $Kind,
        "--root", $DestinationRoot,
        "--expected-self-sha256", $receiverSha256
    )
    if ($DestinationDisposition -eq "current_user_dpapi_broker_v1") {
        $destinationArgumentVector += @(
            "--destination-disposition", $DestinationDisposition
        )
    }
    $destinationCommand = $destinationArgumentVector -join " "
    $destinationProbeCommand = $destinationCommand + " --probe-absent true"
    $destinationCleanupStartInfo = $null
    if ($DestinationDisposition -eq "current_user_dpapi_broker_v1") {
        $destinationCleanupCommand = $destinationCommand + " --cleanup true"
        $destinationCleanupStartInfo = New-RevAgentSshStartInfo `
            -SshPath $sshPath `
            -Selector $DestinationSelector `
            -RemoteCommand $destinationCleanupCommand `
            -RedirectInput $true
    }

    $result = Invoke-RevAgentM4HandoffCore `
        -Kind $Kind `
        -SourceStartInfo (New-RevAgentSshStartInfo -SshPath $sshPath -Selector $SourceSelector -RemoteCommand $sourceCommand -RedirectInput $true) `
        -DestinationStartInfo (New-RevAgentSshStartInfo -SshPath $sshPath -Selector $DestinationSelector -RemoteCommand $destinationCommand -RedirectInput $true) `
        -SourceProbeStartInfo (New-RevAgentSshStartInfo -SshPath $sshPath -Selector $SourceSelector -RemoteCommand $sourceProbeCommand -RedirectInput $true) `
        -DestinationProbeStartInfo (New-RevAgentSshStartInfo -SshPath $sshPath -Selector $DestinationSelector -RemoteCommand $destinationProbeCommand -RedirectInput $true) `
        -TimeoutMilliseconds ($TimeoutSeconds * 1000) `
        -DestinationDisposition $DestinationDisposition `
        -DestinationCleanupStartInfo $destinationCleanupStartInfo

    [Console]::Out.Write(($result.Result | ConvertTo-Json -Compress) + "`n")
    exit $result.ExitCode
}
catch {
    Stop-RevAgentInvalidInvocation
}
