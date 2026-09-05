using System.Runtime.ExceptionServices;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.RealWorkerHost;

/// <summary>Test-only, bounded first-chance classifications. A thrown exception
/// can be handled normally; this observation does not assert cycle failure.</summary>
internal sealed class GenuineFailureObservation : IDisposable
{
    private int _count;
    private int _writing;
    private readonly Action<string> _write;

    internal GenuineFailureObservation() : this(Console.Error.WriteLine) { }

    internal GenuineFailureObservation(Action<string> write)
    {
        _write = write;
        AppDomain.CurrentDomain.FirstChanceException += Observe;
    }

    private void Observe(object? sender, FirstChanceExceptionEventArgs args) =>
        Record(args.Exception);

    internal void Record(Exception exception)
    {
        if (Interlocked.Exchange(ref _writing, 1) != 0) return;
        try
        {
            // Admission and the cap check share one gate: a delayed caller
            // cannot use a count observed before another writer reached 32.
            if (_count >= 32) return;
            string? classification = Classify(exception);
            if (classification is null) return;
            int ordinal = Interlocked.Increment(ref _count);
            _write(JsonSerializer.Serialize(new
            {
                @event = "eu20.genuine_first_chance",
                timestamp = DateTimeOffset.UtcNow.ToString("O"),
                ordinal,
                classification = ordinal == 32 ? "limit_reached" : classification,
                truncated = ordinal == 32,
            }));
        }
        catch { /* Observation cannot alter the fixture's execution. */ }
        finally { Volatile.Write(ref _writing, 0); }
    }

    internal static string? Classify(Exception exception) => exception switch
    {
        BridgeCredentialStoreException value => "credential:" + (int)value.ErrorCode,
        RbpCoordinatorException value => "coordinator:" + (int)value.ErrorCode,
        RbpJournalException value => "journal:" + (int)value.ErrorCode,
        RbpGatewayTransportException value => "transport:" + (int)value.Kind,
        RbpFrameException value => "frame:" + (int)value.Code,
        _ => null,
    };

    public void Dispose() =>
        AppDomain.CurrentDomain.FirstChanceException -= Observe;
}
