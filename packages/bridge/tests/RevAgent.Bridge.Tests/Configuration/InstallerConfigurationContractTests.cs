using System.Diagnostics;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Configuration;

namespace RevAgent.Bridge.Tests.Configuration;

public sealed class WindowsInstallerConfigurationTheoryAttribute : TheoryAttribute
{
    public WindowsInstallerConfigurationTheoryAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Requires the Windows installer producer.";
    }
}

public sealed class InstallerConfigurationContractTests
{
    private const string CustomConfiguration = """
        { "schemaVersion": 1, "gateway": { "uri": "wss://custom.revagent.example:9443/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 4096, "retainedFileCount": 11 } }
        """;
    [WindowsInstallerConfigurationTheory]
    [InlineData(false, "gateway.revagent.example", "wss://gateway.revagent.example/bridge/v1")]
    [InlineData(true, "gateway.revagent.example", "wss://gateway.revagent.example/bridge/v1")]
    [InlineData(false, "gateway.revagent.example:8443", "wss://gateway.revagent.example:8443/bridge/v1")]
    [InlineData(true, "gateway.revagent.example:8443", "wss://gateway.revagent.example:8443/bridge/v1")]
    public async Task ActualInstallerProducerIsAcceptedByCompiledLoader(bool powerShell7, string host, string expected)
    {
        using var fixture = new ProducerFixture();
        var result = await fixture.RunAsync(powerShell7, host);
        Assert.Equal(0, result.ExitCode);
        var configuration = BridgeConfigurationLoader.Load(fixture.ConfigurationPath, new Dictionary<string, string?>());
        Assert.Equal(expected, configuration.GatewayUri.AbsoluteUri);
        Assert.Equal(8080, configuration.Addin.ScanStartPort);
        Assert.Equal(8085, configuration.Addin.ScanEndPort);
        Assert.Equal(10L * 1024 * 1024, configuration.Logging.MaxFileBytes);
        Assert.Equal(7, configuration.Logging.RetainedFileCount);
        Assert.DoesNotContain((byte)0xEF, File.ReadAllBytes(fixture.ConfigurationPath).Take(1));
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false, "")]
    [InlineData(true, "replacement.revagent.example:8443")]
    public async Task RerunPreservesCustomConfigurationBytes(bool powerShell7, string host)
    {
        using var fixture = new ProducerFixture();
        Directory.CreateDirectory(fixture.StateRoot);
        byte[] original = Encoding.UTF8.GetBytes(CustomConfiguration);
        File.WriteAllBytes(fixture.ConfigurationPath, original);
        var result = await fixture.RunAsync(powerShell7, host);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(original, File.ReadAllBytes(fixture.ConfigurationPath));
        Assert.Contains("preserved_existing", result.Output, StringComparison.Ordinal);
        var config = BridgeConfigurationLoader.Load(fixture.ConfigurationPath, new Dictionary<string, string?>());
        Assert.Equal("wss://custom.revagent.example:9443/bridge/v1", config.GatewayUri.AbsoluteUri);
        Assert.Equal(4096, config.Logging.MaxFileBytes);
        Assert.Equal(11, config.Logging.RetainedFileCount);
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false, "")]
    [InlineData(true, "")]
    [InlineData(false, "192.168.90.104")]
    [InlineData(true, "192.168.90.104:8443")]
    [InlineData(false, "::1")]
    [InlineData(true, "[::1]:8443")]
    [InlineData(false, "fe80::1%eth0")]
    [InlineData(true, "https://gateway.example")]
    [InlineData(false, "user@gateway.example")]
    [InlineData(true, "gateway.example/path")]
    [InlineData(false, "gateway.example?query")]
    [InlineData(true, "gateway.example#fragment")]
    [InlineData(false, "gateway.example:0")]
    [InlineData(true, "gateway.example:65536")]
    [InlineData(false, " gateway.example")]
    [InlineData(true, "gateway.example.")]
    public async Task InvalidFreshEndpointFailsBeforeConfigurationMutation(bool powerShell7, string host)
    {
        using var fixture = new ProducerFixture();
        var result = await fixture.RunAsync(powerShell7, host);
        Assert.NotEqual(0, result.ExitCode);
        Assert.False(Directory.Exists(fixture.StateRoot));
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false, "")]
    [InlineData(true, "")]
    [InlineData(false, "gateway.example")]
    [InlineData(true, "gateway.example:8443")]
    public async Task DryRunPlansWithoutCreatingConfiguration(bool powerShell7, string host)
    {
        using var fixture = new ProducerFixture();
        var result = await fixture.RunAsync(powerShell7, host, dryRun: true);
        Assert.Equal(0, result.ExitCode);
        Assert.False(Directory.Exists(fixture.StateRoot));
        using JsonDocument report = JsonDocument.Parse(result.Output);
        Assert.Equal("skipped_dry_run", report.RootElement.GetProperty("status").GetString());
        Assert.Equal(host.Length == 0 ? "unresolved_endpoint" : "create", report.RootElement.GetProperty("disposition").GetString());
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task ExistingMalformedInputIsPreservedAndStrictReaderStillRejectsIt(bool powerShell7, bool bom)
    {
        using var fixture = new ProducerFixture();
        Directory.CreateDirectory(fixture.StateRoot);
        byte[] original = bom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(CustomConfiguration)).ToArray()
            : Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"gatewayHostName\":\"gateway.example\",\"revitVersion\":\"2022\"}");
        File.WriteAllBytes(fixture.ConfigurationPath, original);
        Assert.Equal(0, (await fixture.RunAsync(powerShell7, "")).ExitCode);
        Assert.Equal(original, File.ReadAllBytes(fixture.ConfigurationPath));
        Assert.Throws<BridgeConfigurationException>(() => BridgeConfigurationLoader.Load(fixture.ConfigurationPath, new Dictionary<string, string?>()));
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConfigAppearingAfterPlanningWinsWithoutReplacement(bool powerShell7)
    {
        using var fixture = new ProducerFixture();
        byte[] original = Encoding.UTF8.GetBytes(CustomConfiguration);
        var result = await fixture.RunAsync(powerShell7, "gateway.example", concurrentConfiguration: original);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(original, File.ReadAllBytes(fixture.ConfigurationPath));
        Assert.Contains("preserved_existing", result.Output, StringComparison.Ordinal);
        Assert.Equal("custom.revagent.example", BridgeConfigurationLoader.Load(fixture.ConfigurationPath, new Dictionary<string, string?>()).GatewayUri.Host);
    }

    [WindowsInstallerConfigurationTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AtomicCreateOnlyNeverReplacesAnExistingConfig(bool powerShell7)
    {
        using var fixture = new ProducerFixture();
        byte[] original = Encoding.UTF8.GetBytes(CustomConfiguration);
        var result = await fixture.RunAsync(powerShell7, "gateway.example", concurrentConfiguration: original, atomicCollision: true);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal(original, File.ReadAllBytes(fixture.ConfigurationPath));
        Assert.Equal("custom.revagent.example", BridgeConfigurationLoader.Load(fixture.ConfigurationPath, new Dictionary<string, string?>()).GatewayUri.Host);
    }

    private sealed class ProducerFixture : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "revagent-installer-config-" + Guid.NewGuid().ToString("N"));
        internal string StateRoot => Path.Combine(Root, "state");
        internal string ConfigurationPath => Path.Combine(StateRoot, "bridge-config.json");

        internal async Task<(int ExitCode, string Output, string Error)> RunAsync(bool powerShell7, string host, bool dryRun = false, byte[]? concurrentConfiguration = null, bool atomicCollision = false)
        {
            Directory.CreateDirectory(Root);
            string repo = FindRepositoryRoot();
            // Execute the actual write_bridge_config command/Apply block from
            // the installer, through its real guarded mutation primitive. No
            // whole installation, key generation, SCM or DLL reflection occurs.
            string script = $$"""
                $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
                Import-Module {{Quote(Path.Combine(repo, "installer/bridge/lib/RevAgent.BridgeInstall.psm1"))}} -Force -DisableNameChecking
                $layout=[pscustomobject]@{ConfigurationPath={{Quote(ConfigurationPath)}};StateRoot={{Quote(StateRoot)}}}
                $GatewayHostName={{Quote(host)}}; $RevitVersion='2022'; $isDryRun=${{dryRun.ToString().ToLowerInvariant()}}
                $steps=[Collections.Generic.List[object]]::new(); $installSummary=[ordered]@{configurationDisposition='not_planned'}
                if(Get-Command Get-RevAgentBridgeConfigurationPlan -ErrorAction SilentlyContinue){
                    $configurationPlan=Get-RevAgentBridgeConfigurationPlan -Path $layout.ConfigurationPath -GuardRoot ([IO.Path]::GetPathRoot($layout.StateRoot)) -GatewayHostName $GatewayHostName -AllowUnresolved:$isDryRun
                    $installSummary.configurationDisposition=$configurationPlan.Disposition
                }
                $tokens=$null; $errors=$null
                $ast=[Management.Automation.Language.Parser]::ParseFile({{Quote(Path.Combine(repo, "installer/bridge/Install-RevAgentBridge.ps1"))}},[ref]$tokens,[ref]$errors)
                if($errors.Count){throw 'installer_parse_failed'}
                $commands=@($ast.FindAll({param($node)
                    $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Invoke-RevAgentBridgeGuardedMutation' -and
                    @($node.CommandElements|Where-Object{$_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.Value -eq 'write_bridge_config'}).Count -eq 1
                },$true))
                if($commands.Count -ne 1){throw 'configuration_producer_not_unique'}
                $planning=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-RevAgentBridgeConfigurationPlan'},$true))
                $mutations=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Invoke-RevAgentBridgeGuardedMutation'},$true))
                if($planning.Count -ne 1 -or $planning[0].Extent.StartOffset -ge ($mutations|Sort-Object {$_.Extent.StartOffset}|Select-Object -First 1).Extent.StartOffset){throw 'configuration_planning_must_precede_all_mutations'}
                if(-not $isDryRun){[void][IO.Directory]::CreateDirectory($layout.StateRoot)}
                {{(concurrentConfiguration is null ? "" : "[IO.File]::WriteAllBytes($layout.ConfigurationPath,[Convert]::FromBase64String(" + Quote(Convert.ToBase64String(concurrentConfiguration)) + "))")}}
                {{(atomicCollision ? "Write-RevAgentBridgeGuardedAtomicBytes -Path $layout.ConfigurationPath -GuardRoot $layout.StateRoot -Bytes ([byte[]]@(1,2,3)) -CreateOnly" : "")}}
                $step=& ([scriptblock]::Create($commands[0].Extent.Text))
                [pscustomobject]@{status=$step.status;detail=$step.detail;disposition=$installSummary.configurationDisposition}|ConvertTo-Json -Compress
                """;
            string shell = powerShell7
                ? "pwsh.exe"
                : Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!powerShell7) Assert.True(File.Exists(shell), "Required installer test shell is missing.");
            var info = new ProcessStartInfo(shell)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = repo,
            };
            foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) })
                info.ArgumentList.Add(argument);
            using var process = Process.Start(info)!;
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); }
            finally { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } }
            return (process.ExitCode, await output, await error);
        }

        private static string Quote(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

        private static string FindRepositoryRoot()
        {
            for (DirectoryInfo? directory = new(Directory.GetCurrentDirectory()); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "installer/bridge/Install-RevAgentBridge.ps1"))) return directory.FullName;
            throw new InvalidOperationException("Installer repository root not found.");
        }

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
        }
    }
}
