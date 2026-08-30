using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private enum CloseCycleDisposition
    {
        CloseQuiesced,
        Quarantined,
    }

    private sealed record CycleCloseOperation(
        IRbpConnectionCycle Cycle,
        Task CloseTask,
        long StartedTimestamp,
        CloseCycleDisposition Disposition,
        Exception? SecondaryFault = null);

    private async Task<CycleCloseOperation?> CloseCycleBoundedAsync(
        IRbpConnectionCycle cycle,
        ConnectionTeardownDeadline teardownDeadline)
    {
        if (teardownDeadline.Remaining == TimeSpan.Zero)
            return null;

        Task close = cycle.CloseAsync(teardownDeadline.Token);
        var operation = new CycleCloseOperation(
            cycle,
            close,
            System.Diagnostics.Stopwatch.GetTimestamp(),
            CloseCycleDisposition.Quarantined);
        Exception? secondaryFault = null;
        try
        {
            await close.WaitAsync(teardownDeadline.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (teardownDeadline.Token.IsCancellationRequested)
        {
            if (!close.IsCompleted)
            {
                RetainQuarantinedTeardownTask(close);
                return operation;
            }
            secondaryFault = new TimeoutException(
                "The connection close exceeded the shared teardown deadline.");
        }
        catch (Exception exception)
        {
            secondaryFault = exception;
        }

        return operation with
        {
            Disposition = secondaryFault is null
                ? CloseCycleDisposition.CloseQuiesced
                : CloseCycleDisposition.Quarantined,
            SecondaryFault = secondaryFault,
        };
    }

    private async Task<bool> DisposeCycleBoundedAsync(
        CycleCloseOperation close,
        ConnectionTeardownDeadline teardownDeadline)
    {
        if (close.Disposition != CloseCycleDisposition.CloseQuiesced ||
            !close.CloseTask.IsCompletedSuccessfully ||
            teardownDeadline.Remaining == TimeSpan.Zero)
            return false;

        Task dispose = close.Cycle.DisposeAsync().AsTask();
        try
        {
            await dispose.WaitAsync(teardownDeadline.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (teardownDeadline.Token.IsCancellationRequested)
        {
            if (!dispose.IsCompleted)
            {
                RetainQuarantinedTeardownTask(dispose);
                return false;
            }
            return false;
        }
        catch (Exception)
        {
            return false;
        }
        return true;
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
