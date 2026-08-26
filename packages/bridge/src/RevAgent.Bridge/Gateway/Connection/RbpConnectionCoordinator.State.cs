using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private sealed record RbpResumeControl(
        JsonElement Payload,
        string? RouteAuthorityCheckpoint);
    private static RbpSessionLifecycleState AdvanceSession(
        RbpSessionLifecycleState lifecycle,
        RbpSessionEvent sessionEvent)
    {
        RbpSessionTransition transition =
            RbpConnectionReducer.TransitionSession(
                lifecycle,
                sessionEvent);
        if (transition.Kind != RbpTransitionKind.Transitioned)
        {
            throw new InvalidOperationException(
                $"Invalid RBP session transition '{sessionEvent.Type}' " +
                $"from '{lifecycle.Phase}'.");
        }

        return transition.State;
    }

    private void AdvanceConnection(RbpConnectionEvent connectionEvent)
    {
        lock (_sync)
        {
            RbpConnectionTransition transition =
                RbpConnectionReducer.TransitionConnection(
                    _lifecycle,
                    connectionEvent);
            if (transition.Kind != RbpTransitionKind.Transitioned)
            {
                throw new InvalidOperationException(
                    $"Invalid RBP connection transition " +
                    $"'{connectionEvent.Type}' from '{_lifecycle.Phase}'.");
            }

            _lifecycle = transition.State;
        }
    }

    private long NextConnectionGeneration()
    {
        lock (_sync)
        {
            if (_connectionGeneration >=
                RbpSequenceReducer.MaximumSafeSequence)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The RBP connection generation is exhausted.");
            }

            return ++_connectionGeneration;
        }
    }

    private void SetActiveContext(ConnectionCycleContext context)
    {
        lock (_sync)
        {
            if (_active is not null)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Only one Gateway connection may be active.");
            }

            _active = context;
        }
    }

    private void ClearActiveContext(ConnectionCycleContext context)
    {
        lock (_sync)
        {
            if (ReferenceEquals(_active, context))
            {
                _active = null;
            }
        }
    }

    private bool IsCurrentContext(ConnectionCycleContext context)
    {
        lock (_sync)
        {
            return ReferenceEquals(_active, context) &&
                   _connectionGeneration == context.Generation;
        }
    }

    private double GetCurrentContinuousSteadyMilliseconds()
    {
        ConnectionCycleContext? active;
        lock (_sync)
        {
            active = _active;
        }

        return active?.ContinuousSteadyMilliseconds ?? 0;
    }

    private long NextC39CausalOrdinal() => Interlocked.Increment(ref _c39CausalOrdinal);

    private void MarkRouteAuthorityCheckpoint(ConnectionCycleContext context, string rsid, string checkpoint)
    {
        lock (_sync)
        {
            _routeAuthorityCheckpoints[new RouteAuthorityCheckpointKey(context, rsid)] = checkpoint;
        }
    }

    private string? GetRouteAuthorityCheckpoint(ConnectionCycleContext context, string rsid)
    {
        lock (_sync)
        {
            return _routeAuthorityCheckpoints.TryGetValue(
                new RouteAuthorityCheckpointKey(context, rsid), out string? value)
                ? value : null;
        }
    }

    private sealed record RouteAuthorityCheckpointKey(ConnectionCycleContext Context, string Rsid);

    private void OwnedTaskStarted()
    {
        lock (_sync)
        {
            _ownedBackgroundTasks++;
        }
    }

    private void OwnedTaskCompleted()
    {
        lock (_sync)
        {
            _ownedBackgroundTasks--;
        }
    }

    // Invocation tasks are counted separately from owned tasks on purpose.
    // OwnedBackgroundTaskCount means "everything the cycle must drain before it
    // may be declared closed"; a failed drain there poisons connection
    // authority and demands a process restart. An add-in call that cannot be
    // cancelled past the dispatch boundary is not that kind of defect, so it
    // must not be able to trip it.
    private void InvocationStarted()
    {
        lock (_sync)
        {
            _activeInvocations++;
        }
    }

    private void InvocationCompleted()
    {
        lock (_sync)
        {
            _activeInvocations--;
        }
    }

    private static JsonElement JsonObject(
        params (string Name, object? Value)[] properties)
    {
        var values = new Dictionary<string, object?>(
            properties.Length,
            StringComparer.Ordinal);
        foreach ((string name, object? value) in properties)
        {
            values.Add(name, value);
        }

        return JsonSerializer.SerializeToElement(values);
    }

    private static JsonElement RequiredObject(
        JsonElement parent,
        string propertyName)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Object)
        {
            throw InvalidControl(
                $"Control payload requires object '{propertyName}'.");
        }

        return value;
    }

    private static JsonElement RequiredArray(
        JsonElement parent,
        string propertyName)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            throw InvalidControl(
                $"Control payload requires array '{propertyName}'.");
        }

        return value;
    }

    private static string RequiredString(
        JsonElement parent,
        string propertyName,
        int maximumLength)
    {
        return RequiredBoundedString(
            parent,
            propertyName,
            maximumLength,
            allowEmpty: false);
    }

    private static string RequiredBoundedString(
        JsonElement parent,
        string propertyName,
        int maximumLength,
        bool allowEmpty)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.String)
        {
            throw InvalidControl(
                $"Control payload requires string '{propertyName}'.");
        }

        string result = value.GetString() ?? string.Empty;
        if ((!allowEmpty && result.Length == 0) ||
            result.Length > maximumLength)
        {
            throw InvalidControl(
                $"Control payload string '{propertyName}' is out of bounds.");
        }

        return result;
    }

    private static bool RequiredBoolean(
        JsonElement parent,
        string propertyName)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind is not (
                JsonValueKind.True or JsonValueKind.False))
        {
            throw InvalidControl(
                $"Control payload requires boolean '{propertyName}'.");
        }

        return value.GetBoolean();
    }

    private static long RequiredSafeInteger(
        JsonElement parent,
        string propertyName,
        bool allowZero)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value))
        {
            throw InvalidControl(
                $"Control payload requires integer '{propertyName}'.");
        }

        return ReadSafeInteger(value, propertyName, allowZero);
    }

    private static long ReadSafeInteger(
        JsonElement value,
        string propertyName,
        bool allowZero)
    {
        if (value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt64(out long result) ||
            result < (allowZero ? 0 : 1) ||
            result > RbpSequenceReducer.MaximumSafeSequence)
        {
            throw InvalidControl(
                $"Control payload integer '{propertyName}' is invalid.");
        }

        return result;
    }

    private static DateTimeOffset RequiredTimestamp(
        JsonElement parent,
        string propertyName)
    {
        string value = RequiredString(parent, propertyName, 256);
        if (!Rfc3339Pattern.IsMatch(value) ||
            !DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out DateTimeOffset parsed))
        {
            throw InvalidControl(
                $"Control payload timestamp '{propertyName}' is invalid.");
        }

        return parsed;
    }

    private static RbpCoordinatorException InvalidCatalog() =>
        new(
            RbpCoordinatorErrorCode.InvalidCatalogSnapshot,
            "The local-session catalog returned an invalid or ambiguous " +
            "complete snapshot.");

    private static RbpCoordinatorException InvalidControl(string message) =>
        new(RbpCoordinatorErrorCode.InvalidControlPayload, message);

    private static void ValidateOptions(
        IRbpConnectionCycleFactory cycleFactory,
        RbpConnectionCoordinatorOptions options)
    {
        ArgumentNullException.ThrowIfNull(cycleFactory);
        ArgumentNullException.ThrowIfNull(options.Endpoint);
        ArgumentNullException.ThrowIfNull(options.HelloProfile);
        if (!options.Endpoint.IsAbsoluteUri ||
            !string.Equals(
                options.Endpoint.Scheme,
                cycleFactory.ExpectedEndpointScheme,
                StringComparison.OrdinalIgnoreCase) ||
            options.EffectiveHeartbeatAcknowledgementTimeout !=
                TimeSpan.FromSeconds(10) ||
            options.EffectiveWakeGapThreshold !=
                TimeSpan.FromMilliseconds(
                    RbpConnectionReducer
                        .HeartbeatDisconnectedAfterMilliseconds) ||
            options.EffectiveHeartbeatCompletionTimeout !=
                TimeSpan.FromMilliseconds(
                    RbpConnectionReducer
                        .HeartbeatDisconnectedAfterMilliseconds) ||
            options.EffectiveCloseTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentException(
                "Coordinator options require the selected binding endpoint " +
                "scheme and positive bounded timeouts.",
                nameof(options));
        }
    }

    private void ValidateCycleAcknowledgement(
        RbpHelloAckPayload acknowledgement)
    {
        ArgumentNullException.ThrowIfNull(acknowledgement);
        if (acknowledgement.Protocol != 1 ||
            string.IsNullOrWhiteSpace(acknowledgement.ConnectionId) ||
            acknowledgement.GrantedCapabilities is null ||
            acknowledgement.Limits is null ||
            acknowledgement.HeartbeatIntervalMilliseconds != 15_000 ||
            acknowledgement.Limits.MaximumParametersBytes <= 0 ||
            acknowledgement.Limits.MaximumParametersBytes >
                RbpProtocolLimits.MaximumInvocationParametersBytes ||
            acknowledgement.Limits.MaximumResultBytes <= 0 ||
            acknowledgement.Limits.MaximumResultBytes >
                RbpProtocolLimits.MaximumInlineResultBytes ||
            acknowledgement.Limits.MaximumPartialBytes <= 0 ||
            acknowledgement.Limits.MaximumPartialBytes >
                RbpProtocolLimits.MaximumPartialBytes ||
            acknowledgement.GrantedCapabilities.Any(capability =>
                !_options.HelloProfile.Capabilities.Contains(
                    capability,
                    StringComparer.Ordinal)))
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Protocol,
                "The connection binding returned an invalid hello_ack " +
                "authority snapshot.");
        }
    }

}
