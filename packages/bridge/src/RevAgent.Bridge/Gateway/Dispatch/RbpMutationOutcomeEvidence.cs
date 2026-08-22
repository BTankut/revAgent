using System.Text.Json;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Dispatch;

internal enum RbpDispatchState
{
    NotStarted,
    MayHaveReachedAddin,
    ResponseObserved,
}

internal enum RbpEffectState
{
    NotStarted,
    ReadOnly,
    RolledBack,
    Committed,
    Unknown,
}

internal enum RbpTransactionMode
{
    Auto,
    None,
    Native,
    NotApplicable,
}

/// <summary>
/// The DC-02 evidence carried from add-in dispatch through durable
/// terminalization. Transport reachability and Revit model effect are
/// deliberately independent: receiving a JSON-RPC error proves only that a
/// response was observed, never that a mutation did not commit.
/// </summary>
internal sealed record RbpMutationOutcomeEvidence(
    RbpDispatchState DispatchState,
    RbpEffectState EffectState,
    RbpTransactionMode TransactionMode,
    string EvidenceJcs)
{
    internal const string Schema = "revagent.mutation-outcome/v1";
    internal const string NativeConformance = Schema;
    internal const int MaximumEvidenceBytes = 2_048;

    internal bool KnownNotDispatched =>
        DispatchState == RbpDispatchState.NotStarted &&
        EffectState == RbpEffectState.NotStarted;

    internal bool KnownNonCommittingError =>
        EffectState is RbpEffectState.NotStarted or
            RbpEffectState.RolledBack;

    internal bool RequiresMutationHold(bool mutating, bool error) =>
        mutating &&
        error &&
        EffectState is not (RbpEffectState.NotStarted or
            RbpEffectState.RolledBack);

    internal static RbpMutationOutcomeEvidence NotDispatched(
        RbpTransactionMode transactionMode,
        string source = "bridge_pre_dispatch") =>
        Create(
            RbpDispatchState.NotStarted,
            RbpEffectState.NotStarted,
            transactionMode,
            source,
            "not_started");

    internal static RbpMutationOutcomeEvidence Uncertain(
        RbpDispatchState dispatchState,
        RbpTransactionMode transactionMode,
        string source = "bridge_transport") =>
        Create(
            dispatchState,
            RbpEffectState.Unknown,
            transactionMode,
            source,
            "unknown");

    internal static RbpMutationOutcomeEvidence NativeResponse(
        RbpEffectState effectState,
        string source = "native_command") =>
        Create(
            RbpDispatchState.ResponseObserved,
            effectState,
            RbpTransactionMode.Native,
            source,
            ToWire(effectState));

    internal static RbpMutationOutcomeEvidence FromResponse(
        AddinTransportEvidence transport,
        JToken? carrier,
        RbpTransactionMode requestedMode)
    {
        RbpDispatchState dispatchState = transport.DispatchState switch
        {
            AddinDispatchState.NotStarted => RbpDispatchState.NotStarted,
            AddinDispatchState.MayHaveReachedAddin =>
                RbpDispatchState.MayHaveReachedAddin,
            AddinDispatchState.ResponseObserved =>
                RbpDispatchState.ResponseObserved,
            _ => RbpDispatchState.MayHaveReachedAddin,
        };

        if (TryReadAddinClaim(carrier, out AddinClaim? claim) &&
            claim is not null &&
            (requestedMode == RbpTransactionMode.NotApplicable ||
             claim.TransactionMode == requestedMode))
        {
            return Create(
                dispatchState,
                claim.EffectState,
                claim.TransactionMode,
                claim.Source,
                claim.TransactionStatus);
        }

        return dispatchState == RbpDispatchState.NotStarted
            ? NotDispatched(requestedMode)
            : Uncertain(dispatchState, requestedMode);
    }

    internal static RbpMutationOutcomeEvidence ForLegacyOutcome(
        RbpAddinOutcomeKind kind,
        RbpTransactionMode transactionMode,
        bool mutating)
    {
        if (kind == RbpAddinOutcomeKind.KnownNotDispatched)
        {
            // The enum is an explicit test/channel seam. Production channel
            // construction reaches it only with the exact pair below.
            return NotDispatched(transactionMode, "legacy_explicit_seam");
        }

        if (kind is RbpAddinOutcomeKind.Completed or
            RbpAddinOutcomeKind.Guarded)
        {
            return Create(
                RbpDispatchState.ResponseObserved,
                mutating ? RbpEffectState.Unknown : RbpEffectState.ReadOnly,
                transactionMode,
                "legacy_terminal",
                mutating ? "unknown" : "read_only");
        }

        return Uncertain(
            RbpDispatchState.MayHaveReachedAddin,
            transactionMode,
            "legacy_uncertain");
    }

    internal static RbpTransactionMode ReadRequestedMode(
        string method,
        JsonElement parameters)
    {
        if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty(
                "transactionMode",
                out JsonElement transactionMode) &&
            transactionMode.ValueKind == JsonValueKind.String)
        {
            return FromWireTransactionMode(transactionMode.GetString());
        }

        return string.Equals(
                method,
                "send_code_to_revit",
                StringComparison.Ordinal)
            ? RbpTransactionMode.Auto
            : RbpTransactionMode.Native;
    }

    internal static bool HasNativeConformanceDeclaration(
        JsonElement parameters) =>
        parameters.ValueKind == JsonValueKind.Object &&
        parameters.TryGetProperty(
            "nativeOutcomeEvidenceConformance",
            out JsonElement conformance) &&
        conformance.ValueKind == JsonValueKind.String &&
        string.Equals(
            conformance.GetString(),
            NativeConformance,
            StringComparison.Ordinal);

    internal static string ToWire(RbpDispatchState value) =>
        value switch
        {
            RbpDispatchState.NotStarted => "not_started",
            RbpDispatchState.MayHaveReachedAddin =>
                "may_have_reached_addin",
            RbpDispatchState.ResponseObserved => "response_observed",
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    internal static string ToWire(RbpEffectState value) =>
        value switch
        {
            RbpEffectState.NotStarted => "not_started",
            RbpEffectState.ReadOnly => "read_only",
            RbpEffectState.RolledBack => "rolled_back",
            RbpEffectState.Committed => "committed",
            RbpEffectState.Unknown => "unknown",
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    internal static string ToWire(RbpTransactionMode value) =>
        value switch
        {
            RbpTransactionMode.Auto => "auto",
            RbpTransactionMode.None => "none",
            RbpTransactionMode.Native => "native",
            RbpTransactionMode.NotApplicable => "not_applicable",
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    private static RbpMutationOutcomeEvidence Create(
        RbpDispatchState dispatchState,
        RbpEffectState effectState,
        RbpTransactionMode transactionMode,
        string source,
        string transactionStatus)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("dispatchState", ToWire(dispatchState));
            writer.WriteString("effectState", ToWire(effectState));
            writer.WriteStartObject("evidence");
            writer.WriteString("source", BoundCode(source));
            writer.WriteString(
                "transactionStatus",
                BoundCode(transactionStatus));
            writer.WriteEndObject();
            writer.WriteString("schema", Schema);
            writer.WriteString("transactionMode", ToWire(transactionMode));
            writer.WriteEndObject();
        }

        if (buffer.Length > MaximumEvidenceBytes)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "Mutation outcome evidence exceeded its durable bound.");
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        string evidenceJcs = Rfc8785Json.Canonicalize(document.RootElement);
        return new RbpMutationOutcomeEvidence(
            dispatchState,
            effectState,
            transactionMode,
            evidenceJcs);
    }

    private static bool TryReadAddinClaim(
        JToken? carrier,
        out AddinClaim? claim)
    {
        claim = null;
        JObject? owner = carrier as JObject;
        JObject? evidence = owner?["outcomeEvidence"] as JObject;
        if (evidence is null &&
            owner?["schema"]?.Value<string>() == Schema)
        {
            evidence = owner;
        }

        if (evidence is null ||
            !HasExactProperties(
                evidence,
                "schema",
                "effectState",
                "transactionMode",
                "evidence") ||
            evidence["schema"]?.Value<string>() != Schema ||
            evidence["evidence"] is not JObject witness ||
            !HasExactProperties(witness, "source", "transactionStatus"))
        {
            return false;
        }

        string? source = witness["source"]?.Value<string>();
        string? transactionStatus =
            witness["transactionStatus"]?.Value<string>();
        if (!IsBoundedCode(source) || !IsBoundedCode(transactionStatus))
        {
            return false;
        }

        if (!TryReadEffectState(
                evidence["effectState"]?.Value<string>(),
                out RbpEffectState effectState) ||
            !TryReadTransactionMode(
                evidence["transactionMode"]?.Value<string>(),
                out RbpTransactionMode transactionMode) ||
            !string.Equals(
                transactionStatus,
                ToWire(effectState),
                StringComparison.Ordinal))
        {
            return false;
        }

        string raw = evidence.ToString(Formatting.None);
        if (System.Text.Encoding.UTF8.GetByteCount(raw) >
            MaximumEvidenceBytes)
        {
            return false;
        }

        claim = new AddinClaim(
            effectState,
            transactionMode,
            source!,
            transactionStatus!);
        return true;
    }

    private static bool HasExactProperties(
        JObject value,
        params string[] expected)
    {
        var names = new HashSet<string>(
            value.Properties().Select(property => property.Name),
            StringComparer.Ordinal);
        return names.Count == expected.Length &&
               expected.All(names.Contains);
    }

    private static RbpTransactionMode FromWireTransactionMode(string? value) =>
        TryReadTransactionMode(value, out RbpTransactionMode parsed)
            ? parsed
            : RbpTransactionMode.NotApplicable;

    private static bool TryReadTransactionMode(
        string? value,
        out RbpTransactionMode parsed)
    {
        parsed = value switch
        {
            "auto" => RbpTransactionMode.Auto,
            "none" => RbpTransactionMode.None,
            "native" => RbpTransactionMode.Native,
            "not_applicable" => RbpTransactionMode.NotApplicable,
            _ => RbpTransactionMode.NotApplicable,
        };
        return value is "auto" or "none" or "native" or "not_applicable";
    }

    private static bool TryReadEffectState(
        string? value,
        out RbpEffectState parsed)
    {
        parsed = value switch
        {
            "not_started" => RbpEffectState.NotStarted,
            "read_only" => RbpEffectState.ReadOnly,
            "rolled_back" => RbpEffectState.RolledBack,
            "committed" => RbpEffectState.Committed,
            "unknown" => RbpEffectState.Unknown,
            _ => RbpEffectState.Unknown,
        };
        return value is "not_started" or "read_only" or "rolled_back" or
            "committed" or "unknown";
    }

    private static bool IsBoundedCode(string? value)
    {
        if (value is not { Length: > 0 and <= 64 } ||
            value[0] is < 'a' or > 'z')
        {
            return false;
        }

        return value.All(character =>
            character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_');
    }

    private static string BoundCode(string value) =>
        IsBoundedCode(value) ? value : "invalid_evidence";

    private sealed record AddinClaim(
        RbpEffectState EffectState,
        RbpTransactionMode TransactionMode,
        string Source,
        string TransactionStatus);
}
