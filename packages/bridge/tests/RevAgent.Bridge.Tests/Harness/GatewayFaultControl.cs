using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.Tests.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Harness;

/// <summary>Which leg of the RBP link a frame fault applies to.</summary>
internal enum GatewayFaultDirection
{
    GatewayToBridge,
    BridgeToGateway,
}

/// <summary>
/// The frozen O1 stub frame-fault actions the P3-T13 harness scripts.
/// </summary>
internal enum GatewayFrameFaultAction
{
    /// <summary>Silently discards the next matching frame.</summary>
    Drop,

    /// <summary>Delivers the next matching frame twice, byte-identically.</summary>
    Duplicate,

    /// <summary>Defers the next matching frame by a bounded timer.</summary>
    Delay,

    /// <summary>
    /// Parks the next matching frame until <c>flush_held</c> releases it: the
    /// slow-consumer primitive.
    /// </summary>
    Hold,
}

/// <summary>
/// The typed P3-T13 fault surface over the launched O1 Gateway stub's
/// <c>/__rbp_test/control</c> route.
/// </summary>
/// <remarks>
/// Every primitive the harness needs already exists on the stub, so this type
/// adds no new stub behavior — it only names the frozen control commands the
/// scenarios use (<c>disconnect</c> for a link kill, the <c>duplicate</c> and
/// <c>hold</c>/<c>flush_held</c> frame faults for redelivery and slow-consumer
/// pressure, and <c>dispatch_invoke</c>/<c>expire_pending</c> for the Section
/// 12.2 redelivery arbitration).
/// </remarks>
internal sealed class GatewayFaultControl : IDisposable
{
    private const string ControlHeader = "X-RBP-Test-Control";
    private const string ControlToken = "rbp-test-control";

    private readonly HttpClientHandler _handler;
    private readonly HttpClient _client;
    private readonly Uri _controlUri;
    private bool _disposed;

    internal GatewayFaultControl(GatewayStubProcess stub)
    {
        ArgumentNullException.ThrowIfNull(stub);
        _controlUri = stub.ControlUri;
        _handler = new HttpClientHandler
        {
            UseProxy = false,
            ServerCertificateCustomValidationCallback =
                (_, certificate, _, _) =>
                    stub.TrustsExactCertificate(certificate),
        };
        _client = new HttpClient(_handler)
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
    }

    /// <summary>Reads the stub's authoritative session/runtime snapshot.</summary>
    internal async Task<GatewayStubView> SnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            _controlUri);
        request.Headers.Add(ControlHeader, ControlToken);
        using HttpResponseMessage response = await _client
            .SendAsync(request, cancellationToken)
            .ConfigureAwait(false);
        string body = await response.Content
            .ReadAsStringAsync(cancellationToken)
            .ConfigureAwait(false);
        Require(response.IsSuccessStatusCode, "snapshot", response, body);
        return new GatewayStubView(JsonDocument.Parse(body));
    }

    /// <summary>Kills the link the way a dropped Wi-Fi association does.</summary>
    internal Task KillLinkAsync(
        string connectionId,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            new JsonObject
            {
                ["action"] = "disconnect",
                ["connection_id"] = connectionId,
            },
            cancellationToken);

    internal Task EnqueueFrameFaultAsync(
        GatewayFaultDirection direction,
        GatewayFrameFaultAction action,
        string? messageType = null,
        int remaining = 1,
        int? delayMilliseconds = null,
        CancellationToken cancellationToken = default)
    {
        var rule = new JsonObject
        {
            ["direction"] = WireDirection(direction),
            ["action"] = WireAction(action),
            ["remaining"] = remaining,
        };
        if (messageType is not null)
        {
            rule["messageType"] = messageType;
        }

        if (delayMilliseconds is { } delay)
        {
            rule["delayMs"] = delay;
        }

        return PostAsync(
            new JsonObject
            {
                ["action"] = "enqueue_frame_fault",
                ["rule"] = rule,
            },
            cancellationToken);
    }

    /// <summary>Releases every frame the slow-consumer fault parked.</summary>
    internal async Task<int> FlushHeldAsync(
        string? connectionId = null,
        CancellationToken cancellationToken = default)
    {
        var command = new JsonObject
        {
            ["action"] = "flush_held",
        };
        if (connectionId is not null)
        {
            command["connection_id"] = connectionId;
        }

        using JsonDocument result = await PostForResultAsync(
                command,
                cancellationToken)
            .ConfigureAwait(false);
        return result.RootElement.GetProperty("flushed").GetInt32();
    }

    /// <summary>Dispatches one Section 10.2 <c>invoke</c> to the bridge.</summary>
    internal Task DispatchInvokeAsync(
        string rsid,
        JsonElement invokePayload,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            new JsonObject
            {
                ["action"] = "dispatch_invoke",
                ["request"] = new JsonObject
                {
                    ["rsid"] = rsid,
                    ["payload"] = Node(invokePayload),
                },
            },
            cancellationToken);

    /// <summary>Dispatches one Section 11 <c>invoke_batch</c> to the bridge.</summary>
    internal Task DispatchBatchAsync(
        string rsid,
        JsonElement batchPayload,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            new JsonObject
            {
                ["action"] = "dispatch_batch",
                ["request"] = new JsonObject
                {
                    ["rsid"] = rsid,
                    ["payload"] = Node(batchPayload),
                },
            },
            cancellationToken);

    /// <summary>Cancels the Gateway's active invocation (Section 16).</summary>
    internal Task DispatchCancelAsync(
        string rsid,
        string invocationId,
        string reason = "user_requested",
        CancellationToken cancellationToken = default) =>
        PostAsync(
            new JsonObject
            {
                ["action"] = "dispatch_cancel",
                ["request"] = new JsonObject
                {
                    ["rsid"] = rsid,
                    ["invocationId"] = invocationId,
                    ["reason"] = reason,
                },
            },
            cancellationToken);

    /// <summary>
    /// Expires the Gateway's pending dispatch window so the same invocation may
    /// be redelivered — the Gateway half of the P-BRIDGE-3 redelivery drill.
    /// </summary>
    internal Task ExpirePendingAsync(
        string rsid,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            new JsonObject
            {
                ["action"] = "expire_pending",
                ["rsid"] = rsid,
            },
            cancellationToken);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _client.Dispose();
        _handler.Dispose();
    }

    private static JsonNode Node(JsonElement element) =>
        JsonNode.Parse(element.GetRawText()) ??
        throw new InvalidOperationException(
            "A control payload must not serialize to JSON null.");

    private static string WireDirection(GatewayFaultDirection direction) =>
        direction switch
        {
            GatewayFaultDirection.GatewayToBridge => "gateway_to_bridge",
            GatewayFaultDirection.BridgeToGateway => "bridge_to_gateway",
            _ => throw new ArgumentOutOfRangeException(nameof(direction)),
        };

    private static string WireAction(GatewayFrameFaultAction action) =>
        action switch
        {
            GatewayFrameFaultAction.Drop => "drop",
            GatewayFrameFaultAction.Duplicate => "duplicate",
            GatewayFrameFaultAction.Delay => "delay",
            GatewayFrameFaultAction.Hold => "hold",
            _ => throw new ArgumentOutOfRangeException(nameof(action)),
        };

    private static void Require(
        bool condition,
        string what,
        HttpResponseMessage response,
        string body)
    {
        if (!condition)
        {
            throw new InvalidOperationException(
                $"The Gateway stub refused the '{what}' control command: " +
                $"{(int)response.StatusCode} {body}");
        }
    }

    private async Task PostAsync(
        JsonObject command,
        CancellationToken cancellationToken)
    {
        using JsonDocument _ = await PostForResultAsync(
                command,
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<JsonDocument> PostForResultAsync(
        JsonObject command,
        CancellationToken cancellationToken)
    {
        string action = command["action"]?.GetValue<string>() ?? "unknown";
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            _controlUri);
        request.Headers.Add(ControlHeader, ControlToken);
        request.Content = new StringContent(
            command.ToJsonString(),
            Encoding.UTF8,
            "application/json");
        using HttpResponseMessage response = await _client
            .SendAsync(request, cancellationToken)
            .ConfigureAwait(false);
        string body = await response.Content
            .ReadAsStringAsync(cancellationToken)
            .ConfigureAwait(false);
        Require(response.IsSuccessStatusCode, action, response, body);
        return JsonDocument.Parse(body);
    }
}

/// <summary>
/// A read-only projection of one Gateway stub snapshot. The stub is the
/// authority for session identity, sequence state, and terminal classification,
/// so every cross-peer assertion in the harness reads it rather than inferring
/// Gateway state from the bridge.
/// </summary>
internal sealed class GatewayStubView : IDisposable
{
    private readonly JsonDocument _document;

    internal GatewayStubView(JsonDocument document)
    {
        _document = document;
    }

    internal JsonElement Root => _document.RootElement;

    /// <summary>Every transport connection the stub still holds open.</summary>
    internal IReadOnlyList<string> ConnectionIds =>
        Root.GetProperty("runtime")
            .GetProperty("connectionPhases")
            .EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

    internal int OpenConnectionCount =>
        Root.GetProperty("runtime").GetProperty("openConnections").GetInt32();

    /// <summary>Sessions the Gateway still considers registered.</summary>
    internal IReadOnlyList<string> LiveRsids =>
        Sessions()
            .Where(session => !session.Value.GetProperty("revoked").GetBoolean())
            .Select(session => session.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

    internal IReadOnlyList<string> AllRsids =>
        Sessions()
            .Select(session => session.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

    internal int HeldOutboundFrameCount =>
        Root.GetProperty("runtime").GetProperty("heldOutboundFrames").GetInt32();

    internal int HeldInboundFrameCount =>
        Root.GetProperty("runtime").GetProperty("heldInboundFrames").GetInt32();

    internal IReadOnlyList<string> ActiveMutationHoldIds =>
        Root.GetProperty("mutationHolds")
            .GetProperty("holds")
            .EnumerateArray()
            .Where(hold =>
                !string.Equals(
                    hold.GetProperty("state").GetString(),
                    "cleared",
                    StringComparison.Ordinal))
            .Select(hold => hold.GetProperty("holdId").GetString()!)
            .Order(StringComparer.Ordinal)
            .ToArray();

    internal bool HasSession(string rsid) =>
        Root.GetProperty("sessions").TryGetProperty(rsid, out _);

    internal bool HasInFlight(string rsid) =>
        Session(rsid).GetProperty("inFlight").ValueKind !=
        JsonValueKind.Null;

    internal long LastReceivedSequence(string rsid) =>
        Session(rsid).GetProperty("sequence").GetProperty("lastRxSeq")
            .GetInt64();

    internal long HighestTransmittedSequence(string rsid) =>
        Session(rsid).GetProperty("sequence").GetProperty("highestTxSeq")
            .GetInt64();

    internal long LastPeerAcknowledgement(string rsid) =>
        Session(rsid).GetProperty("sequence").GetProperty("lastPeerAck")
            .GetInt64();

    internal int OutboxCount(string rsid) =>
        Session(rsid).GetProperty("sequence").GetProperty("outbox")
            .GetArrayLength();

    /// <summary>
    /// The stub's terminal classification for one correlation id, or null when
    /// the Gateway has not accepted a terminal for it.
    /// </summary>
    internal string? TerminalClassification(string rsid, string correlationId)
    {
        JsonElement outcomes = Session(rsid).GetProperty("terminalOutcomes");
        return outcomes.TryGetProperty(correlationId, out JsonElement outcome)
            ? outcome.GetProperty("classification").GetString()
            : null;
    }

    /// <summary>
    /// The exact result payload the Gateway accepted for one correlation id.
    /// </summary>
    internal JsonElement? TerminalPayload(string rsid, string correlationId)
    {
        JsonElement outcomes = Session(rsid).GetProperty("terminalOutcomes");
        if (!outcomes.TryGetProperty(correlationId, out JsonElement outcome) ||
            outcome.GetProperty("envelope").ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return outcome.GetProperty("envelope").GetProperty("payload");
    }

    public void Dispose() => _document.Dispose();

    private IEnumerable<JsonProperty> Sessions() =>
        Root.GetProperty("sessions").EnumerateObject();

    private JsonElement Session(string rsid) =>
        Root.GetProperty("sessions").TryGetProperty(
            rsid,
            out JsonElement session)
            ? session
            : throw new InvalidOperationException(
                $"The Gateway stub holds no session '{rsid}'.");
}
