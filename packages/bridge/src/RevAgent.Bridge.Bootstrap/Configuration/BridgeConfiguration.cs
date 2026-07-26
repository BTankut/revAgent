using System.Collections.ObjectModel;
using System.Text.Json.Serialization;

namespace RevAgent.Bridge.Bootstrap.Configuration;

internal sealed record BridgeAddinConfiguration(
    int ScanStartPort,
    int ScanEndPort);

internal sealed record BridgeLoggingConfiguration(
    long MaxFileBytes,
    int RetainedFileCount);

internal enum BridgeConfigurationSourceKind
{
    File,
    Environment,
}

internal sealed record BridgeConfigurationValueSource(
    BridgeConfigurationSourceKind Kind,
    string Name);

internal sealed class BridgeConfigurationSourceMetadata
{
    internal BridgeConfigurationSourceMetadata(
        string configurationFilePath,
        IReadOnlyDictionary<string, BridgeConfigurationValueSource> values)
    {
        ConfigurationFilePath = configurationFilePath;
        Values = new ReadOnlyDictionary<string, BridgeConfigurationValueSource>(
            new Dictionary<string, BridgeConfigurationValueSource>(
                values,
                StringComparer.Ordinal));
    }

    internal string ConfigurationFilePath { get; }

    internal IReadOnlyDictionary<string, BridgeConfigurationValueSource> Values { get; }
}

internal sealed class ResolvedBridgeConfiguration
{
    internal ResolvedBridgeConfiguration(
        int schemaVersion,
        Uri gatewayUri,
        BridgeAddinConfiguration addin,
        BridgeLoggingConfiguration logging,
        BridgeConfigurationSourceMetadata sourceMetadata)
    {
        SchemaVersion = schemaVersion;
        GatewayUri = gatewayUri;
        Addin = addin;
        Logging = logging;
        SourceMetadata = sourceMetadata;
    }

    internal int SchemaVersion { get; }

    internal Uri GatewayUri { get; }

    internal BridgeAddinConfiguration Addin { get; }

    internal BridgeLoggingConfiguration Logging { get; }

    internal BridgeConfigurationSourceMetadata SourceMetadata { get; }

    internal RedactedBridgeConfigurationReport ToRedactedReport()
    {
        var sources = SourceMetadata.Values.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.Kind == BridgeConfigurationSourceKind.Environment
                ? $"environment:{pair.Value.Name}"
                : "file",
            StringComparer.Ordinal);

        return new RedactedBridgeConfigurationReport(
            SchemaVersion,
            GatewayUri.AbsoluteUri,
            new RedactedBridgeAddinConfigurationReport(
                Addin.ScanStartPort,
                Addin.ScanEndPort),
            new RedactedBridgeLoggingConfigurationReport(
                Logging.MaxFileBytes,
                Logging.RetainedFileCount),
            Path.GetFileName(SourceMetadata.ConfigurationFilePath),
            new ReadOnlyDictionary<string, string>(sources));
    }
}

internal sealed record RedactedBridgeConfigurationReport(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("gatewayUri")] string GatewayUri,
    [property: JsonPropertyName("addin")] RedactedBridgeAddinConfigurationReport Addin,
    [property: JsonPropertyName("logging")] RedactedBridgeLoggingConfigurationReport Logging,
    [property: JsonPropertyName("configurationFile")] string ConfigurationFile,
    [property: JsonPropertyName("sources")] IReadOnlyDictionary<string, string> Sources);

internal sealed record RedactedBridgeAddinConfigurationReport(
    [property: JsonPropertyName("scanStartPort")] int ScanStartPort,
    [property: JsonPropertyName("scanEndPort")] int ScanEndPort);

internal sealed record RedactedBridgeLoggingConfigurationReport(
    [property: JsonPropertyName("maxFileBytes")] long MaxFileBytes,
    [property: JsonPropertyName("retainedFileCount")] int RetainedFileCount);
