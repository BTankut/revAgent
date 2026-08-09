using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Keeps the artificial process-kill and WAL-recovery gate isolated inside a
/// testhost and across testhost processes sharing one Windows runner account.
/// </summary>
/// <remarks>
/// Production has one Bridge writer and one journal per host. Concurrent test
/// assemblies otherwise align several forced process deaths and recovery opens
/// on the same physical disk, which is a test-only load shape.
/// </remarks>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class RbpJournalPowerCutCollection :
    ICollectionFixture<RbpJournalPowerCutHostLeaseFixture>
{
    public const string Name = "RbpJournalPowerCut";
}

/// <summary>
/// Owns the host-wide lease for the lifetime of the power-cut collection.
/// </summary>
public sealed class RbpJournalPowerCutHostLeaseFixture : IAsyncLifetime
{
    private static readonly TimeSpan AcquireTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(100);

    private FileStream? _stream;

    public async Task InitializeAsync()
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            "revagent-rbp-journal-power-cut.lock");
        var stopwatch = Stopwatch.StartNew();
        IOException? lastFailure = null;

        while (stopwatch.Elapsed < AcquireTimeout)
        {
            FileStream? stream = null;
            try
            {
                stream = new FileStream(
                    path,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 256,
                    FileOptions.Asynchronous);
                byte[] owner = Encoding.UTF8.GetBytes(
                    Environment.ProcessId.ToString(
                        CultureInfo.InvariantCulture));
                stream.SetLength(0);
                await stream.WriteAsync(owner).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
                _stream = stream;
                return;
            }
            catch (IOException exception)
            {
                stream?.Dispose();
                lastFailure = exception;
                await Task.Delay(RetryDelay).ConfigureAwait(false);
            }
            catch
            {
                stream?.Dispose();
                throw;
            }
        }

        throw new TimeoutException(
            "Timed out acquiring the host-wide RBP journal power-cut lease.",
            lastFailure);
    }

    public async Task DisposeAsync()
    {
        if (_stream is not null)
        {
            await _stream.DisposeAsync().ConfigureAwait(false);
            _stream = null;
        }
    }
}
