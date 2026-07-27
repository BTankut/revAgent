namespace RevAgent.Bridge.Gateway.Storage;

internal sealed class RbpJournalWriterLease : IDisposable
{
    private readonly FileStream _stream;
    private bool _disposed;

    private RbpJournalWriterLease(string leasePath, FileStream stream)
    {
        LeasePath = leasePath;
        _stream = stream;
    }

    internal string LeasePath { get; }

    internal static RbpJournalWriterLease Acquire(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        string leasePath = databasePath + ".writer.lock";

        try
        {
            var stream = new FileStream(
                leasePath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.Read,
                bufferSize: 1,
                FileOptions.None);
            return new RbpJournalWriterLease(leasePath, stream);
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.WriterLeaseUnavailable,
                "The machine-wide RBP journal writer lease is already held " +
                "or cannot be opened.",
                exception);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _stream.Dispose();
    }
}
