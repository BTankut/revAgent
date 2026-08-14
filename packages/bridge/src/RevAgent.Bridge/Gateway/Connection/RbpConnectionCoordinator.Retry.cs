using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private async Task CloseCycleBoundedAsync(IRbpConnectionCycle cycle)
    {
        using var timeout = new CancellationTokenSource(
            _options.EffectiveCloseTimeout);
        Task close = cycle.CloseAsync(timeout.Token);
        try
        {
            Task completedClose = await Task.WhenAny(
                    close,
                    Task.Delay(_options.EffectiveCloseTimeout))
                .ConfigureAwait(false);
            if (ReferenceEquals(completedClose, close))
            {
                await close.ConfigureAwait(false);
            }
            else
            {
                timeout.Cancel();
                ObserveLateFault(close);
            }
        }
        catch (OperationCanceledException)
            when (timeout.IsCancellationRequested)
        {
            // Disposal below remains the final bounded transport abort path.
        }
        catch (RbpGatewayTransportException)
        {
            // A connection fault is already the reason this cycle is closing.
        }
        catch (Exception)
        {
            // Cleanup must not replace the connection/journal failure that
            // already owns retry authority.
        }

        Task dispose = cycle.DisposeAsync().AsTask();
        Task completed = await Task.WhenAny(
                dispose,
                Task.Delay(_options.EffectiveCloseTimeout))
            .ConfigureAwait(false);
        if (ReferenceEquals(completed, dispose))
        {
            try
            {
                await dispose.ConfigureAwait(false);
            }
            catch
            {
                // Disposal is a bounded finalizer for an already failed cycle.
            }
        }
        else
        {
            ObserveLateFault(dispose);
        }
    }

    private static void ObserveLateFault(Task task)
    {
        _ = task.ContinueWith(
            completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted |
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private async Task WaitForRetryAuthorityAsync(
        CancellationToken cancellationToken)
    {
        RbpRetryDecision decision = _lifecycle.LastRetryDecision ??
            throw new InvalidOperationException(
                "The connection reducer did not provide retry authority.");
        switch (decision.Action)
        {
            case RbpRetryAction.Backoff:
                int jitter = RbpReconnectBackoff
                    .FullJitterDelayMilliseconds(
                        decision.WaitAttemptIndex ??
                        throw new InvalidOperationException(
                            "Backoff is missing its attempt index."),
                        _random);
                double waitMilliseconds = Math.Max(
                    jitter,
                    decision.RetryAfterFloorMilliseconds);
                await DelayRetryAsync(
                        waitMilliseconds,
                        cancellationToken)
                    .ConfigureAwait(false);
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.RetryTimerElapsed));
                return;
            case RbpRetryAction.Pause:
                await _retryConditionSignal.WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.RetryConditionChanged));
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.Start));
                return;
            case RbpRetryAction.Stop:
                await Task.Delay(
                        Timeout.InfiniteTimeSpan,
                        cancellationToken)
                    .ConfigureAwait(false);
                return;
            default:
                throw new InvalidOperationException(
                    $"Unknown retry action '{decision.Action}'.");
        }
    }

    private FailureTransition ClassifyFailure(Exception exception)
    {
        double steady = exception switch
        {
            RbpWakeGapException wake =>
                wake.ContinuousSteadyMilliseconds,
            RbpConnectedCycleFailureException connected =>
                connected.ContinuousSteadyMilliseconds,
            _ => GetCurrentContinuousSteadyMilliseconds(),
        };
        Exception cause = exception is RbpConnectedCycleFailureException wrapped
            ? wrapped.InnerException ??
              throw new InvalidOperationException(
                  "Connected-cycle failure lost its cause.")
            : exception;

        if (cause is RbpGatewayTransportException transport)
        {
            double retryAfter = transport.RetryNotBeforeUtc is { } floor
                ? Math.Max(0, (floor - _clock.UtcNow).TotalMilliseconds)
                : 0;
            RbpOpeningFailureClass failure = transport.Kind switch
            {
                RbpGatewayFailureKind.EnrollmentRequired or
                RbpGatewayFailureKind.Authentication or
                RbpGatewayFailureKind.Authorization =>
                    RbpOpeningFailureClass.Auth,
                RbpGatewayFailureKind.Version =>
                    RbpOpeningFailureClass.Version,
                RbpGatewayFailureKind.Trust =>
                    RbpOpeningFailureClass.Trust,
                RbpGatewayFailureKind.Protocol =>
                    RbpOpeningFailureClass.Protocol,
                _ => RbpOpeningFailureClass.Environment,
            };
            return new FailureTransition(
                failure,
                steady,
                retryAfter,
                transport.Kind,
                transport.StatusCode,
                transport.CloseCode,
                transport.OpeningContext);
        }

        RbpOpeningFailureClass classified = cause switch
        {
            RbpCoordinatorException coordinator
                when coordinator.ErrorCode is
                    RbpCoordinatorErrorCode.InvalidControlPayload or
                    RbpCoordinatorErrorCode.UnexpectedControl or
                    RbpCoordinatorErrorCode.SessionAuthorityConflict or
                    RbpCoordinatorErrorCode.SequenceFault =>
                RbpOpeningFailureClass.Protocol,
            RbpJournalException journal
                when journal.ErrorCode ==
                     RbpJournalErrorCode.ProtocolConflict =>
                RbpOpeningFailureClass.Protocol,
            _ => RbpOpeningFailureClass.Environment,
        };
        return new FailureTransition(classified, steady, 0);
    }

    private void ObserveConnectionFailure(FailureTransition failure)
    {
        Func<RbpConnectionFailureObservation, ValueTask>? observer =
            _onConnectionFailureObservation;
        if (observer is null || failure.GatewayFailure is not { } gateway)
        {
            return;
        }

        RbpConnectionLifecycleState lifecycle;
        lock (_sync)
        {
            lifecycle = _lifecycle;
        }

        RbpConnectionFailureObservation? observation =
            RbpConnectionFailureObservation.TryCreate(
                gateway,
                failure.HttpStatus,
                failure.CloseCode,
                failure.OpeningContext,
                lifecycle);
        if (observation is null)
        {
            return;
        }

        try
        {
            ValueTask completion = observer(observation);
            if (!completion.IsCompletedSuccessfully)
            {
                _ = ObserveConnectionFailureCompletionAsync(completion);
            }
        }
        catch
        {
            // Observation is best-effort only. It must never release retry
            // authority, alter reducer state, or stop the worker.
        }
    }

    private static async Task ObserveConnectionFailureCompletionAsync(
        ValueTask completion)
    {
        try
        {
            await completion.ConfigureAwait(false);
        }
        catch
        {
            // Post-await observer faults are isolated exactly like synchronous
            // callback faults. The detached observer never owns retry state.
        }
    }

    private async Task DelayRetryAsync(
        double waitMilliseconds,
        CancellationToken cancellationToken)
    {
        const double maximumChunkMilliseconds = 24 * 60 * 60 * 1000d;
        double remaining = waitMilliseconds;
        while (remaining > maximumChunkMilliseconds)
        {
            await _clock.DelayAsync(
                    TimeSpan.FromMilliseconds(maximumChunkMilliseconds),
                    cancellationToken)
                .ConfigureAwait(false);
            remaining -= maximumChunkMilliseconds;
        }

        await _clock.DelayAsync(
                TimeSpan.FromMilliseconds(remaining),
                cancellationToken)
            .ConfigureAwait(false);
    }

}
