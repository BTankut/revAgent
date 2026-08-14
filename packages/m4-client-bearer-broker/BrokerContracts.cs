using System.Text.Json;

namespace RevAgent.M4.ClientBearerBroker;

internal static class BrokerContracts
{
    internal const string HandoffVersion = "revagent.m4-secret-handoff/v1";
    internal const string BrokerVersion = "revagent.m4-client-bearer-broker/v1";
    internal const string DestinationDisposition = "current_user_dpapi_broker_v1";
    internal const string Kind = "north_bearer";
    internal const string StoreFileName = "north-bearer.dpapi";
    internal const string UpstreamUrl = "https://m4-gateway.revagent.app/mcp";
    internal const int SemanticRefusalExitCode = 78;
    internal const int CleanupUncertainExitCode = 79;
    internal const int InvalidInvocationExitCode = 64;
}

internal sealed class BrokerRefusalException : Exception
{
    internal BrokerRefusalException(string reason)
        : base("The broker operation was refused.")
    {
        Reason = reason;
    }

    internal string Reason { get; }
}

internal static class ValueFreeOutput
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    internal static void Write(object value) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(value, Options));

    internal static int InvalidInvocation()
    {
        Write(new
        {
            ok = false,
            action = "receive_m4_secret_handoff",
            contractVersion = BrokerContracts.HandoffVersion,
            kind = "invalid",
            code = "m4_client_bearer_broker_refused",
            reason = "invalid_invocation",
            destinationAbsent = false,
        });
        return BrokerContracts.InvalidInvocationExitCode;
    }

    internal static int Refused(string action, string reason, bool destinationAbsent, bool cleanupUncertain = false)
    {
        var contractVersion = string.Equals(
            action,
            "serve_m4_client_bearer_broker",
            StringComparison.Ordinal)
            ? BrokerContracts.BrokerVersion
            : BrokerContracts.HandoffVersion;
        Write(new
        {
            ok = false,
            action,
            contractVersion,
            kind = BrokerContracts.Kind,
            code = cleanupUncertain ? "cleanup_uncertain" : "m4_client_bearer_broker_refused",
            reason = cleanupUncertain ? "cleanup_uncertain" : reason,
            destinationAbsent,
        });
        return cleanupUncertain
            ? BrokerContracts.CleanupUncertainExitCode
            : BrokerContracts.SemanticRefusalExitCode;
    }
}
