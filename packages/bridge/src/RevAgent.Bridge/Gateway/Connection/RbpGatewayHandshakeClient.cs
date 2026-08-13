using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class RbpGatewayHandshake : IAsyncDisposable
{
    internal RbpGatewayHandshake(
        RbpGatewayConnection connection,
        RbpHelloAckPayload acknowledgement,
        RbpConnectionLifecycleState lifecycle)
    {
        Connection = connection;
        Acknowledgement = acknowledgement;
        Lifecycle = lifecycle;
    }

    internal RbpGatewayConnection Connection { get; }

    internal RbpHelloAckPayload Acknowledgement { get; }

    internal RbpConnectionLifecycleState Lifecycle { get; }

    public ValueTask DisposeAsync() => Connection.DisposeAsync();
}

internal sealed class RbpGatewayHandshakeClient
{
    private static readonly IReadOnlyList<int> SupportedProtocols =
        Array.AsReadOnly(new[] { 1 });

    private readonly IRbpEnrollmentStateProvider _enrollment;
    private readonly IRbpGatewayBinding _binding;
    private readonly RbpHelloFactory _helloFactory;

    internal RbpGatewayHandshakeClient(
        IRbpEnrollmentStateProvider enrollment,
        IRbpGatewayBinding binding,
        RbpHelloFactory? helloFactory = null)
    {
        _enrollment =
            enrollment ?? throw new ArgumentNullException(nameof(enrollment));
        _binding = binding ?? throw new ArgumentNullException(nameof(binding));
        _helloFactory = helloFactory ?? new RbpHelloFactory();
    }

    internal async Task<RbpGatewayHandshake> ConnectAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(profile);
        RbpEnrollmentSnapshot enrollment =
            await _enrollment.ReadAsync(cancellationToken)
                .ConfigureAwait(false);
        if (enrollment.Status != RbpEnrollmentStatus.Ready ||
            enrollment.Credential is not { } credential)
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.EnrollmentRequired,
                "The Bridge cannot open a Gateway socket until enrollment " +
                $"is ready ({enrollment.DiagnosticCode}).");
        }

        RbpConnectionLifecycleState lifecycle =
            RbpConnectionReducer.CreateConnectionLifecycle();
        lifecycle = Advance(
            lifecycle,
            new RbpConnectionEvent(RbpConnectionEventType.Start));
        RbpGatewayConnection connection = await _binding.ConnectAsync(
                new RbpGatewayConnectRequest(
                    endpoint,
                    credential,
                    SupportedProtocols),
                cancellationToken)
            .ConfigureAwait(false);
        RbpEnvelope? sentHello = null;
        try
        {
            lifecycle = Advance(
                lifecycle,
                new RbpConnectionEvent(
                    RbpConnectionEventType.TransportOpened));
            lifecycle = Advance(
                lifecycle,
                new RbpConnectionEvent(
                    RbpConnectionEventType.AuthenticationAccepted));

            RbpEnvelope hello = _helloFactory.Create(credential, profile);
            await connection.SendTextAsync(
                    RbpEnvelopeCodec.Encode(hello),
                    cancellationToken)
                .ConfigureAwait(false);
            sentHello = hello;
            byte[] frame = await connection.ReceiveTextAsync(cancellationToken)
                .ConfigureAwait(false);
            RbpEnvelope opening;
            try
            {
                opening = RbpEnvelopeCodec.Decode(frame);
            }
            catch (RbpFrameException exception)
            {
                throw new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Protocol,
                    "The Gateway returned an invalid RBP hello response.",
                    innerException: exception);
            }

            if (!string.Equals(
                    opening.Type,
                    "hello_ack",
                    StringComparison.Ordinal) ||
                opening.HelloAck is not { } acknowledgement)
            {
                throw new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Protocol,
                    "The Gateway did not return hello_ack as the first frame.");
            }

            if (acknowledgement.Protocol != 1 ||
                acknowledgement.GrantedCapabilities.Any(
                    capability =>
                        !profile.Capabilities.Contains(
                            capability,
                            StringComparer.Ordinal)))
            {
                throw new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Protocol,
                    "The Gateway hello_ack selected an unoffered protocol " +
                    "or capability.");
            }

            lifecycle = Advance(
                lifecycle,
                new RbpConnectionEvent(
                    RbpConnectionEventType.HelloAccepted,
                    SelectedProtocol: acknowledgement.Protocol,
                    GrantedCapabilities:
                        acknowledgement.GrantedCapabilities));
            return new RbpGatewayHandshake(
                connection,
                acknowledgement,
                lifecycle);
        }
        catch (Exception exception)
        {
            try
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }
            catch
            {
                // Preserve the protocol/authentication failure that caused
                // cleanup; disposal is bounded best-effort on this path.
            }

            if (exception is RbpGatewayTransportException transport &&
                sentHello is not null)
            {
                throw transport.WithOpeningContext(
                    sentHello.Id,
                    RbpOpeningBinding.Wss);
            }

            throw;
        }
    }

    private static RbpConnectionLifecycleState Advance(
        RbpConnectionLifecycleState lifecycle,
        RbpConnectionEvent connectionEvent)
    {
        RbpConnectionTransition transition =
            RbpConnectionReducer.TransitionConnection(
                lifecycle,
                connectionEvent);
        if (transition.Kind != RbpTransitionKind.Transitioned)
        {
            throw new InvalidOperationException(
                $"Invalid RBP connection transition " +
                $"'{connectionEvent.Type}' from '{lifecycle.Phase}'.");
        }

        return transition.State;
    }
}
