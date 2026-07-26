using System.Globalization;
using System.Text.Json;

namespace RevAgent.Bridge.Bootstrap.Configuration;

internal static class BridgeConfigurationLoader
{
    internal const string GatewayUriEnvironmentVariable = "REVAGENT_BRIDGE_GATEWAY_URI";
    internal const string AddinPortEnvironmentVariable = "REVAGENT_BRIDGE_ADDIN_PORT";
    internal const string LogMaxBytesEnvironmentVariable = "REVAGENT_BRIDGE_LOG_MAX_BYTES";
    internal const string LogRetainedFilesEnvironmentVariable = "REVAGENT_BRIDGE_LOG_RETAINED_FILES";

    private const string EnvironmentPrefix = "REVAGENT_BRIDGE_";
    private const int SupportedSchemaVersion = 1;
    private const int MaximumConfigBytes = 1024 * 1024;
    private const int MaximumAddinScanPortCount = 64;

    private static readonly IReadOnlyDictionary<string, string> AllowedEnvironmentVariables =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [GatewayUriEnvironmentVariable] = GatewayUriEnvironmentVariable,
            [AddinPortEnvironmentVariable] = AddinPortEnvironmentVariable,
            [LogMaxBytesEnvironmentVariable] = LogMaxBytesEnvironmentVariable,
            [LogRetainedFilesEnvironmentVariable] = LogRetainedFilesEnvironmentVariable,
        };

    internal static ResolvedBridgeConfiguration Load(
        string path,
        IReadOnlyDictionary<string, string?> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);

        if (string.IsNullOrWhiteSpace(path))
        {
            throw Error("config_path_invalid", "The bridge configuration path is required.");
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (Exception exception) when (
            exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw Error(
                "config_path_invalid",
                "The bridge configuration path is invalid.",
                exception);
        }

        byte[] bytes;
        try
        {
            var fileInfo = new FileInfo(fullPath);
            if (!fileInfo.Exists)
            {
                throw Error(
                    "config_file_not_found",
                    "The bridge configuration file does not exist.");
            }

            if (fileInfo.Length > MaximumConfigBytes)
            {
                throw Error(
                    "config_file_too_large",
                    $"The bridge configuration file exceeds {MaximumConfigBytes} bytes.");
            }

            bytes = File.ReadAllBytes(fullPath);
            if (bytes.Length > MaximumConfigBytes)
            {
                throw Error(
                    "config_file_too_large",
                    $"The bridge configuration file exceeds {MaximumConfigBytes} bytes.");
            }
        }
        catch (BridgeConfigurationException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException)
        {
            throw Error(
                "config_file_unreadable",
                "The bridge configuration file could not be read.",
                exception);
        }

        if (HasByteOrderMark(bytes))
        {
            throw Error(
                "config_bom_not_allowed",
                "The bridge configuration must be UTF-8 without a byte-order mark.");
        }

        using var document = ParseDocument(bytes);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw Error(
                "config_root_invalid",
                "The bridge configuration root must be a JSON object.");
        }

        RejectDuplicateProperties(root, "$");
        RequireOnlyProperties(root, "$", "schemaVersion", "gateway", "addin", "logging");
        RequireProperties(root, "$", "schemaVersion", "gateway", "addin", "logging");

        var schemaVersion = RequireInt32(root, "schemaVersion", "$");
        if (schemaVersion != SupportedSchemaVersion)
        {
            throw Error(
                "config_schema_version_unsupported",
                $"The bridge configuration schemaVersion must be {SupportedSchemaVersion}.");
        }

        var gateway = RequireObject(root, "gateway", "$");
        RequireOnlyProperties(gateway, "$.gateway", "uri");
        RequireProperties(gateway, "$.gateway", "uri");

        var addin = RequireObject(root, "addin", "$");
        RequireOnlyProperties(addin, "$.addin", "scanStartPort", "scanEndPort");
        RequireProperties(addin, "$.addin", "scanStartPort", "scanEndPort");

        var logging = RequireObject(root, "logging", "$");
        RequireOnlyProperties(logging, "$.logging", "maxFileBytes", "retainedFileCount");
        RequireProperties(logging, "$.logging", "maxFileBytes", "retainedFileCount");

        var gatewayUriText = RequireString(gateway, "uri", "$.gateway");
        var scanStartPort = RequireInt32(addin, "scanStartPort", "$.addin");
        var scanEndPort = RequireInt32(addin, "scanEndPort", "$.addin");
        var maxFileBytes = RequireInt64(logging, "maxFileBytes", "$.logging");
        var retainedFileCount = RequireInt32(logging, "retainedFileCount", "$.logging");

        var environmentValues = ValidateAndNormalizeEnvironment(environment);
        var sources = CreateFileSources();

        if (environmentValues.TryGetValue(
            GatewayUriEnvironmentVariable,
            out var gatewayUriOverride))
        {
            gatewayUriText = RequireNonEmptyEnvironmentValue(
                GatewayUriEnvironmentVariable,
                gatewayUriOverride);
            sources["gateway.uri"] = EnvironmentSource(GatewayUriEnvironmentVariable);
        }

        if (environmentValues.TryGetValue(
            AddinPortEnvironmentVariable,
            out var addinPortOverride))
        {
            var port = ParseEnvironmentInt32(
                AddinPortEnvironmentVariable,
                addinPortOverride);
            scanStartPort = port;
            scanEndPort = port;
            sources["addin.scanStartPort"] = EnvironmentSource(AddinPortEnvironmentVariable);
            sources["addin.scanEndPort"] = EnvironmentSource(AddinPortEnvironmentVariable);
        }

        if (environmentValues.TryGetValue(
            LogMaxBytesEnvironmentVariable,
            out var maxBytesOverride))
        {
            maxFileBytes = ParseEnvironmentInt64(
                LogMaxBytesEnvironmentVariable,
                maxBytesOverride);
            sources["logging.maxFileBytes"] = EnvironmentSource(
                LogMaxBytesEnvironmentVariable);
        }

        if (environmentValues.TryGetValue(
            LogRetainedFilesEnvironmentVariable,
            out var retainedFilesOverride))
        {
            retainedFileCount = ParseEnvironmentInt32(
                LogRetainedFilesEnvironmentVariable,
                retainedFilesOverride);
            sources["logging.retainedFileCount"] = EnvironmentSource(
                LogRetainedFilesEnvironmentVariable);
        }

        var gatewayUri = ValidateGatewayUri(gatewayUriText);
        ValidateAddinPorts(scanStartPort, scanEndPort);
        ValidateLogging(maxFileBytes, retainedFileCount);

        return new ResolvedBridgeConfiguration(
            schemaVersion,
            gatewayUri,
            new BridgeAddinConfiguration(scanStartPort, scanEndPort),
            new BridgeLoggingConfiguration(maxFileBytes, retainedFileCount),
            new BridgeConfigurationSourceMetadata(fullPath, sources));
    }

    internal static ResolvedBridgeConfiguration LoadFromCurrentEnvironment(string path)
    {
        var environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(
                entry => Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? string.Empty,
                entry => Convert.ToString(entry.Value, CultureInfo.InvariantCulture),
                StringComparer.OrdinalIgnoreCase);

        return Load(path, environment);
    }

    private static Dictionary<string, BridgeConfigurationValueSource> CreateFileSources()
    {
        return new Dictionary<string, BridgeConfigurationValueSource>(StringComparer.Ordinal)
        {
            ["schemaVersion"] = FileSource(),
            ["gateway.uri"] = FileSource(),
            ["addin.scanStartPort"] = FileSource(),
            ["addin.scanEndPort"] = FileSource(),
            ["logging.maxFileBytes"] = FileSource(),
            ["logging.retainedFileCount"] = FileSource(),
        };
    }

    private static Dictionary<string, string?> ValidateAndNormalizeEnvironment(
        IReadOnlyDictionary<string, string?> environment)
    {
        var normalized = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        foreach (var pair in environment)
        {
            var name = pair.Key;
            if (name is null)
            {
                throw Error(
                    "config_environment_name_invalid",
                    "Environment variable names cannot be null.");
            }

            if (!name.StartsWith(EnvironmentPrefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!AllowedEnvironmentVariables.TryGetValue(name, out var canonicalName))
            {
                throw Error(
                    "config_environment_unknown",
                    $"Unknown bridge environment variable '{name}'.");
            }

            if (!normalized.TryAdd(canonicalName, pair.Value))
            {
                throw Error(
                    "config_environment_duplicate",
                    $"Bridge environment variable '{canonicalName}' was supplied more than once.");
            }
        }

        return normalized;
    }

    private static Uri ValidateGatewayUri(string value)
    {
        if (value.Length == 0 || value.Trim().Length != value.Length)
        {
            throw Error(
                "config_gateway_uri_invalid",
                "gateway.uri must be a non-empty absolute URI without surrounding whitespace.");
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            throw Error(
                "config_gateway_uri_invalid",
                "gateway.uri must be an absolute URI.");
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeWss, StringComparison.OrdinalIgnoreCase))
        {
            throw Error(
                "config_gateway_uri_scheme_invalid",
                "gateway.uri must use the wss scheme.");
        }

        if (uri.HostNameType != UriHostNameType.Dns ||
            Uri.CheckHostName(uri.DnsSafeHost) != UriHostNameType.Dns)
        {
            throw Error(
                "config_gateway_uri_host_invalid",
                "gateway.uri must use a DNS hostname, not an IP address.");
        }

        if (uri.DnsSafeHost.Length == 0 ||
            uri.DnsSafeHost.StartsWith(".", StringComparison.Ordinal) ||
            uri.DnsSafeHost.EndsWith(".", StringComparison.Ordinal))
        {
            throw Error(
                "config_gateway_uri_host_invalid",
                "gateway.uri must contain a valid DNS hostname.");
        }

        if (uri.UserInfo.Length != 0)
        {
            throw Error(
                "config_gateway_uri_userinfo_forbidden",
                "gateway.uri must not contain user information.");
        }

        if (uri.Query.Length != 0 || uri.Fragment.Length != 0)
        {
            throw Error(
                "config_gateway_uri_suffix_forbidden",
                "gateway.uri must not contain a query string or fragment.");
        }

        var authorityStart = value.IndexOf("://", StringComparison.Ordinal) + 3;
        var pathStart = value.IndexOf('/', authorityStart);
        var originalPath = pathStart >= 0 ? value[pathStart..] : string.Empty;
        if (!string.Equals(uri.AbsolutePath, "/bridge/v1", StringComparison.Ordinal) ||
            !string.Equals(originalPath, "/bridge/v1", StringComparison.Ordinal))
        {
            throw Error(
                "config_gateway_uri_path_invalid",
                "gateway.uri must use the exact /bridge/v1 path.");
        }

        return uri;
    }

    private static void ValidateAddinPorts(int scanStartPort, int scanEndPort)
    {
        if (scanStartPort is < 1 or > 65535 ||
            scanEndPort is < 1 or > 65535)
        {
            throw Error(
                "config_addin_port_invalid",
                "Add-in scan ports must be between 1 and 65535.");
        }

        if (scanStartPort > scanEndPort)
        {
            throw Error(
                "config_addin_port_range_invalid",
                "addin.scanStartPort must not exceed addin.scanEndPort.");
        }

        var portCount = (long)scanEndPort - scanStartPort + 1;
        if (portCount > MaximumAddinScanPortCount)
        {
            throw Error(
                "config_addin_port_range_too_large",
                $"The add-in scan range may contain at most {MaximumAddinScanPortCount} ports.");
        }
    }

    private static void ValidateLogging(long maxFileBytes, int retainedFileCount)
    {
        if (maxFileBytes <= 0)
        {
            throw Error(
                "config_log_max_bytes_invalid",
                "logging.maxFileBytes must be greater than zero.");
        }

        if (retainedFileCount <= 0)
        {
            throw Error(
                "config_log_retained_files_invalid",
                "logging.retainedFileCount must be greater than zero.");
        }
    }

    private static JsonDocument ParseDocument(byte[] bytes)
    {
        try
        {
            return JsonDocument.Parse(
                bytes,
                new JsonDocumentOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 16,
                });
        }
        catch (JsonException exception)
        {
            throw Error(
                "config_json_malformed",
                "The bridge configuration is not valid strict JSON.",
                exception);
        }
    }

    private static void RejectDuplicateProperties(JsonElement element, string path)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                {
                    var names = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var property in element.EnumerateObject())
                    {
                        if (!names.Add(property.Name))
                        {
                            throw Error(
                                "config_property_duplicate",
                                $"Duplicate property '{property.Name}' at {path}.");
                        }

                        RejectDuplicateProperties(
                            property.Value,
                            $"{path}.{property.Name}");
                    }

                    break;
                }

            case JsonValueKind.Array:
                {
                    var index = 0;
                    foreach (var item in element.EnumerateArray())
                    {
                        RejectDuplicateProperties(item, $"{path}[{index}]");
                        index++;
                    }

                    break;
                }
        }
    }

    private static void RequireOnlyProperties(
        JsonElement element,
        string path,
        params string[] allowedProperties)
    {
        var allowed = new HashSet<string>(allowedProperties, StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!allowed.Contains(property.Name))
            {
                throw Error(
                    "config_property_unknown",
                    $"Unknown property '{property.Name}' at {path}.");
            }
        }
    }

    private static void RequireProperties(
        JsonElement element,
        string path,
        params string[] requiredProperties)
    {
        foreach (var property in requiredProperties)
        {
            if (!element.TryGetProperty(property, out _))
            {
                throw Error(
                    "config_property_missing",
                    $"Required property '{property}' is missing at {path}.");
            }
        }
    }

    private static JsonElement RequireObject(
        JsonElement parent,
        string propertyName,
        string path)
    {
        var value = parent.GetProperty(propertyName);
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw Error(
                "config_property_type_invalid",
                $"{path}.{propertyName} must be an object.");
        }

        return value;
    }

    private static string RequireString(
        JsonElement parent,
        string propertyName,
        string path)
    {
        var value = parent.GetProperty(propertyName);
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Error(
                "config_property_type_invalid",
                $"{path}.{propertyName} must be a string.");
        }

        return value.GetString()!;
    }

    private static int RequireInt32(
        JsonElement parent,
        string propertyName,
        string path)
    {
        var value = parent.GetProperty(propertyName);
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var result))
        {
            throw Error(
                "config_property_type_invalid",
                $"{path}.{propertyName} must be a 32-bit integer.");
        }

        return result;
    }

    private static long RequireInt64(
        JsonElement parent,
        string propertyName,
        string path)
    {
        var value = parent.GetProperty(propertyName);
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var result))
        {
            throw Error(
                "config_property_type_invalid",
                $"{path}.{propertyName} must be a 64-bit integer.");
        }

        return result;
    }

    private static string RequireNonEmptyEnvironmentValue(
        string variableName,
        string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Trim().Length != value.Length)
        {
            throw Error(
                "config_environment_value_invalid",
                $"Environment variable '{variableName}' must be non-empty and unpadded.");
        }

        return value;
    }

    private static int ParseEnvironmentInt32(string variableName, string? value)
    {
        var text = RequireNonEmptyEnvironmentValue(variableName, value);
        if (!int.TryParse(
                text,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var result))
        {
            throw Error(
                "config_environment_value_invalid",
                $"Environment variable '{variableName}' must contain a base-10 integer.");
        }

        return result;
    }

    private static long ParseEnvironmentInt64(string variableName, string? value)
    {
        var text = RequireNonEmptyEnvironmentValue(variableName, value);
        if (!long.TryParse(
                text,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var result))
        {
            throw Error(
                "config_environment_value_invalid",
                $"Environment variable '{variableName}' must contain a base-10 integer.");
        }

        return result;
    }

    private static bool HasByteOrderMark(ReadOnlySpan<byte> bytes)
    {
        return bytes.StartsWith(new byte[] { 0xEF, 0xBB, 0xBF }) ||
            bytes.StartsWith(new byte[] { 0xFF, 0xFE }) ||
            bytes.StartsWith(new byte[] { 0xFE, 0xFF }) ||
            bytes.StartsWith(new byte[] { 0x00, 0x00, 0xFE, 0xFF }) ||
            bytes.StartsWith(new byte[] { 0xFF, 0xFE, 0x00, 0x00 });
    }

    private static BridgeConfigurationValueSource FileSource() =>
        new(BridgeConfigurationSourceKind.File, "bridge-config.json");

    private static BridgeConfigurationValueSource EnvironmentSource(string variableName) =>
        new(BridgeConfigurationSourceKind.Environment, variableName);

    private static BridgeConfigurationException Error(
        string errorCode,
        string message,
        Exception? innerException = null) =>
        new(errorCode, message, innerException);
}
