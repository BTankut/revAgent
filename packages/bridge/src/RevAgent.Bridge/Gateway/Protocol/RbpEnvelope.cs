using System.Collections.ObjectModel;
using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

internal enum RbpWireMessageKind
{
    Text,
    Binary,
}

internal enum RbpEnvelopeScope
{
    PreNegotiation,
    Control,
    Data,
}

internal enum RbpEnvelopeDisposition
{
    Known,
    Unsupported,
}

internal sealed record RbpEnvelope(
    int? Version,
    string Type,
    string Id,
    string Timestamp,
    JsonElement Payload,
    RbpEnvelopeScope Scope,
    string? Rsid,
    long? Sequence,
    long? Acknowledgement,
    RbpHelloPayload? Hello,
    RbpHelloAckPayload? HelloAck,
    RbpEnvelopeDisposition Disposition,
    IReadOnlyDictionary<string, JsonElement> AdditionalProperties)
{
    internal static IReadOnlyDictionary<string, JsonElement> FreezeAdditionalProperties(
        IDictionary<string, JsonElement> values)
    {
        return new ReadOnlyDictionary<string, JsonElement>(
            new Dictionary<string, JsonElement>(values, StringComparer.Ordinal));
    }
}

internal sealed record RbpDataEnvelopeSnapshot(
    string Type,
    string Id,
    string Rsid,
    long Sequence,
    JsonElement Payload,
    long? Acknowledgement = null,
    string? Timestamp = null,
    int Version = 1)
{
    internal RbpDataEnvelopeSnapshot Snapshot(
        long? acknowledgement = null,
        bool replaceAcknowledgement = false,
        string? timestamp = null,
        bool replaceTimestamp = false)
    {
        return new RbpDataEnvelopeSnapshot(
            Type,
            Id,
            Rsid,
            Sequence,
            Payload.Clone(),
            replaceAcknowledgement ? acknowledgement : Acknowledgement,
            replaceTimestamp ? timestamp : Timestamp,
            Version);
    }
}
