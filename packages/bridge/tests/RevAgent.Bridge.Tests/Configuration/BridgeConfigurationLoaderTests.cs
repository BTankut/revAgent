using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Configuration;

namespace RevAgent.Bridge.Tests.Configuration;

public sealed class BridgeConfigurationLoaderTests
{
    private const string ValidConfiguration = """
        {
          "schemaVersion": 1,
          "gateway": {
            "uri": "wss://gateway.revagent.example/bridge/v1"
          },
          "addin": {
            "scanStartPort": 8080,
            "scanEndPort": 8085
          },
          "logging": {
            "maxFileBytes": 1048576,
            "retainedFileCount": 7
          }
        }
        """;

    [Fact]
    public void Load_ValidStrictConfiguration_ReturnsResolvedValuesAndFileSources()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);

        var configuration = BridgeConfigurationLoader.Load(
            file.Path,
            EmptyEnvironment());

        Assert.Equal(1, configuration.SchemaVersion);
        Assert.Equal(
            "wss://gateway.revagent.example/bridge/v1",
            configuration.GatewayUri.AbsoluteUri);
        Assert.Equal(8080, configuration.Addin.ScanStartPort);
        Assert.Equal(8085, configuration.Addin.ScanEndPort);
        Assert.Equal(1048576, configuration.Logging.MaxFileBytes);
        Assert.Equal(7, configuration.Logging.RetainedFileCount);
        Assert.All(
            configuration.SourceMetadata.Values.Values,
            source => Assert.Equal(BridgeConfigurationSourceKind.File, source.Kind));
    }

    [Fact]
    public void Load_CanonicalEnvironmentOverrides_OverrideOnlyAllowlistedValues()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            [BridgeConfigurationLoader.GatewayUriEnvironmentVariable] =
                "wss://override.revagent.example:9443/bridge/v1",
            [BridgeConfigurationLoader.AddinPortEnvironmentVariable] = "8181",
            [BridgeConfigurationLoader.LogMaxBytesEnvironmentVariable] = "2048",
            [BridgeConfigurationLoader.LogRetainedFilesEnvironmentVariable] = "3",
            ["UNRELATED_VARIABLE"] = "ignored",
        };

        var configuration = BridgeConfigurationLoader.Load(file.Path, environment);

        Assert.Equal(
            "wss://override.revagent.example:9443/bridge/v1",
            configuration.GatewayUri.AbsoluteUri);
        Assert.Equal(8181, configuration.Addin.ScanStartPort);
        Assert.Equal(8181, configuration.Addin.ScanEndPort);
        Assert.Equal(2048, configuration.Logging.MaxFileBytes);
        Assert.Equal(3, configuration.Logging.RetainedFileCount);

        AssertEnvironmentSource(
            configuration,
            "gateway.uri",
            BridgeConfigurationLoader.GatewayUriEnvironmentVariable);
        AssertEnvironmentSource(
            configuration,
            "addin.scanStartPort",
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);
        AssertEnvironmentSource(
            configuration,
            "addin.scanEndPort",
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);
        AssertEnvironmentSource(
            configuration,
            "logging.maxFileBytes",
            BridgeConfigurationLoader.LogMaxBytesEnvironmentVariable);
        AssertEnvironmentSource(
            configuration,
            "logging.retainedFileCount",
            BridgeConfigurationLoader.LogRetainedFilesEnvironmentVariable);
    }

    [Fact]
    public void Load_EnvironmentNamesUseWindowsCaseSemantics()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            ["revagent_bridge_addin_port"] = "8181",
        };

        var configuration = BridgeConfigurationLoader.Load(file.Path, environment);

        Assert.Equal(8181, configuration.Addin.ScanStartPort);
        AssertEnvironmentSource(
            configuration,
            "addin.scanStartPort",
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);
    }

    [Fact]
    public void Load_UnknownPrefixedEnvironmentVariable_FailsClosed()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            ["REVAGENT_BRIDGE_GATEWAY_URL"] =
                "wss://gateway.revagent.example/bridge/v1",
        };

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, environment));

        Assert.Equal("config_environment_unknown", exception.ErrorCode);
    }

    [Fact]
    public void Load_OnlyCanonicalAddinPortEnvironmentSource_IsAccepted()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);

        var configuration = BridgeConfigurationLoader.Load(
            file.Path,
            new Dictionary<string, string?>
            {
                [BridgeConfigurationLoader.AddinPortEnvironmentVariable] = "8181",
            });
        Assert.Equal(8181, configuration.Addin.ScanStartPort);
        Assert.Equal(8181, configuration.Addin.ScanEndPort);
        AssertEnvironmentSource(
            configuration,
            "addin.scanStartPort",
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(
                file.Path,
                new Dictionary<string, string?>
                {
                    ["REVAGENT_BRIDGE_ADDIN_PORT_TEST"] = "8181",
                }));
        Assert.Equal("config_environment_unknown", exception.ErrorCode);
    }

    [Fact]
    public void Load_EnrollmentTokenEnvironmentVariable_IsAcceptedAndContributesNoConfiguration()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            [BridgeConfigurationLoader.EnrollmentTokenEnvironmentVariable] =
                "enroll-fresh-token-0123456789abcdef0123456789abcdef",
        };

        var configuration = BridgeConfigurationLoader.Load(file.Path, environment);

        Assert.Equal(
            "wss://gateway.revagent.example/bridge/v1",
            configuration.GatewayUri.AbsoluteUri);
        Assert.All(
            configuration.SourceMetadata.Values.Values,
            source => Assert.Equal(BridgeConfigurationSourceKind.File, source.Kind));
        Assert.DoesNotContain(
            BridgeConfigurationLoader.EnrollmentTokenEnvironmentVariable,
            configuration.SourceMetadata.Values.Keys);
    }

    [Fact]
    public void Load_DuplicateEnvironmentNamesIgnoringCase_FailsClosed()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            [BridgeConfigurationLoader.AddinPortEnvironmentVariable] = "8080",
            ["revagent_bridge_addin_port"] = "8081",
        };

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, environment));

        Assert.Equal("config_environment_duplicate", exception.ErrorCode);
    }

    [Fact]
    public void Load_Utf8Bom_FailsClosedBeforeJsonParsing()
    {
        var json = Encoding.UTF8.GetBytes(ValidConfiguration);
        var bytes = new byte[Encoding.UTF8.Preamble.Length + json.Length];
        Encoding.UTF8.Preamble.CopyTo(bytes);
        json.CopyTo(bytes.AsSpan(Encoding.UTF8.Preamble.Length));
        using var file = TemporaryConfig.Create(bytes);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal("config_bom_not_allowed", exception.ErrorCode);
    }

    [Theory]
    [InlineData("""
        {
          "schemaVersion": 1,
          "schemaVersion": 1,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """)]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": {
            "uri": "wss://gateway.revagent.example/bridge/v1",
            "uri": "wss://other.revagent.example/bridge/v1"
          },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """)]
    public void Load_DuplicateJsonPropertyAtAnyDepth_FailsClosed(string json)
    {
        using var file = TemporaryConfig.Create(json);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal("config_property_duplicate", exception.ErrorCode);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 },
        }
        """)]
    [InlineData("""
        {
          // comments are not configuration
          "schemaVersion": 1,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """)]
    public void Load_MalformedOrNonStrictJson_FailsClosed(string json)
    {
        using var file = TemporaryConfig.Create(json);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal("config_json_malformed", exception.ErrorCode);
    }

    [Theory]
    [InlineData("""
        {
          "schemaVersion": 2,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """, "config_schema_version_unsupported")]
    [InlineData("""
        {
          "schemaVersion": 1,
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """, "config_property_missing")]
    [InlineData("""
        {
          "schemaVersion": "1",
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """, "config_property_type_invalid")]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": null,
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """, "config_property_type_invalid")]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": "8080", "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """, "config_property_type_invalid")]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000.5, "retainedFileCount": 2 }
        }
        """, "config_property_type_invalid")]
    public void Load_MissingUnsupportedOrWrongTypeValue_FailsClosed(
        string json,
        string expectedErrorCode)
    {
        using var file = TemporaryConfig.Create(json);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal(expectedErrorCode, exception.ErrorCode);
    }

    [Theory]
    [InlineData("""
        {
          "schemaVersion": 1,
          "extra": true,
          "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """)]
    [InlineData("""
        {
          "schemaVersion": 1,
          "gateway": {
            "uri": "wss://gateway.revagent.example/bridge/v1",
            "timeout": 4
          },
          "addin": { "scanStartPort": 8080, "scanEndPort": 8085 },
          "logging": { "maxFileBytes": 1000, "retainedFileCount": 2 }
        }
        """)]
    public void Load_UnknownJsonPropertyAtAnySchemaLevel_FailsClosed(string json)
    {
        using var file = TemporaryConfig.Create(json);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal("config_property_unknown", exception.ErrorCode);
    }

    [Theory]
    [InlineData("ws://gateway.revagent.example/bridge/v1")]
    [InlineData("https://gateway.revagent.example/bridge/v1")]
    [InlineData("wss://192.0.2.10/bridge/v1")]
    [InlineData("wss://[::1]/bridge/v1")]
    [InlineData("wss://user@gateway.revagent.example/bridge/v1")]
    [InlineData("wss://gateway.revagent.example/bridge/v1?token=x")]
    [InlineData("wss://gateway.revagent.example/bridge/v1#fragment")]
    [InlineData("wss://gateway.revagent.example/bridge/v1/")]
    [InlineData("wss://gateway.revagent.example/Bridge/v1")]
    [InlineData("wss://gateway.revagent.example/%62ridge/v1")]
    public void Load_NonCanonicalGatewayUri_FailsClosed(string gatewayUri)
    {
        using var file = TemporaryConfig.Create(
            ValidConfiguration.Replace(
                "wss://gateway.revagent.example/bridge/v1",
                gatewayUri,
                StringComparison.Ordinal));

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.StartsWith("config_gateway_uri_", exception.ErrorCode);
    }

    [Theory]
    [InlineData(0, 8085, 1000, 2, "config_addin_port_invalid")]
    [InlineData(8086, 8085, 1000, 2, "config_addin_port_range_invalid")]
    [InlineData(8000, 8100, 1000, 2, "config_addin_scan_range_invalid")]
    [InlineData(8080, 8084, 1000, 2, "config_addin_scan_range_invalid")]
    [InlineData(8181, 8181, 1000, 2, "config_addin_scan_range_invalid")]
    [InlineData(8080, 8085, 0, 2, "config_log_max_bytes_invalid")]
    [InlineData(8080, 8085, 1000, 0, "config_log_retained_files_invalid")]
    public void Load_InvalidBounds_FailsClosed(
        int scanStartPort,
        int scanEndPort,
        long maxFileBytes,
        int retainedFileCount,
        string expectedErrorCode)
    {
        var json = $$"""
            {
              "schemaVersion": 1,
              "gateway": { "uri": "wss://gateway.revagent.example/bridge/v1" },
              "addin": {
                "scanStartPort": {{scanStartPort}},
                "scanEndPort": {{scanEndPort}}
              },
              "logging": {
                "maxFileBytes": {{maxFileBytes}},
                "retainedFileCount": {{retainedFileCount}}
              }
            }
            """;
        using var file = TemporaryConfig.Create(json);

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, EmptyEnvironment()));

        Assert.Equal(expectedErrorCode, exception.ErrorCode);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("65536")]
    public void Load_OutOfRangeExplicitAddinPort_FailsClosed(string port)
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            [BridgeConfigurationLoader.AddinPortEnvironmentVariable] = port,
        };

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, environment));

        Assert.Equal("config_addin_port_invalid", exception.ErrorCode);
    }

    [Fact]
    public void Load_ExplicitPortDoesNotMaskNonCanonicalFileScanRange()
    {
        using var file = TemporaryConfig.Create(
            ValidConfiguration
                .Replace(
                    "\"scanStartPort\": 8080",
                    "\"scanStartPort\": 8181",
                    StringComparison.Ordinal)
                .Replace(
                    "\"scanEndPort\": 8085",
                    "\"scanEndPort\": 8181",
                    StringComparison.Ordinal));
        var environment = new Dictionary<string, string?>
        {
            [BridgeConfigurationLoader.AddinPortEnvironmentVariable] = "8181",
        };

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, environment));

        Assert.Equal("config_addin_scan_range_invalid", exception.ErrorCode);
    }

    [Theory]
    [InlineData("REVAGENT_BRIDGE_ADDIN_PORT", " 8080")]
    [InlineData("REVAGENT_BRIDGE_ADDIN_PORT", "+8080")]
    [InlineData("REVAGENT_BRIDGE_LOG_MAX_BYTES", "1.5")]
    [InlineData("REVAGENT_BRIDGE_LOG_RETAINED_FILES", "")]
    public void Load_InvalidEnvironmentValue_FailsClosed(
        string variableName,
        string value)
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        var environment = new Dictionary<string, string?>
        {
            [variableName] = value,
        };

        var exception = Assert.Throws<BridgeConfigurationException>(
            () => BridgeConfigurationLoader.Load(file.Path, environment));

        Assert.Equal("config_environment_value_invalid", exception.ErrorCode);
    }

    [Fact]
    public void ToRedactedReport_ContainsOnlyFileNameAndSourceNames()
    {
        using var file = TemporaryConfig.Create(ValidConfiguration);
        const string environmentValue =
            "wss://report-test.revagent.example/bridge/v1";
        var configuration = BridgeConfigurationLoader.Load(
            file.Path,
            new Dictionary<string, string?>
            {
                [BridgeConfigurationLoader.GatewayUriEnvironmentVariable] =
                    environmentValue,
            });

        var report = configuration.ToRedactedReport();
        var json = JsonSerializer.Serialize(report);

        Assert.Equal("bridge-config.json", report.ConfigurationFile);
        Assert.False(
            json.Contains(file.DirectoryPath, StringComparison.OrdinalIgnoreCase));
        Assert.Equal(
            $"environment:{BridgeConfigurationLoader.GatewayUriEnvironmentVariable}",
            report.Sources["gateway.uri"]);
        Assert.False(json.Contains("UNRELATED_VARIABLE", StringComparison.Ordinal));
    }

    private static Dictionary<string, string?> EmptyEnvironment() =>
        new(StringComparer.OrdinalIgnoreCase);

    private static void AssertEnvironmentSource(
        ResolvedBridgeConfiguration configuration,
        string field,
        string variableName)
    {
        var source = configuration.SourceMetadata.Values[field];
        Assert.Equal(BridgeConfigurationSourceKind.Environment, source.Kind);
        Assert.Equal(variableName, source.Name);
    }

    private sealed class TemporaryConfig : IDisposable
    {
        private TemporaryConfig(string directoryPath)
        {
            DirectoryPath = directoryPath;
            Path = System.IO.Path.Combine(directoryPath, "bridge-config.json");
        }

        internal string DirectoryPath { get; }

        internal string Path { get; }

        internal static TemporaryConfig Create(string json) =>
            Create(Encoding.UTF8.GetBytes(json));

        internal static TemporaryConfig Create(byte[] bytes)
        {
            var directoryPath = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"revagent-bridge-config-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(directoryPath);
            var config = new TemporaryConfig(directoryPath);
            File.WriteAllBytes(config.Path, bytes);
            return config;
        }

        public void Dispose()
        {
            if (Directory.Exists(DirectoryPath))
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
        }
    }
}
