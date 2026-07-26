namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeEnrollmentLock
{
    IDisposable AcquireExisting();

    IDisposable AcquireForMutation();
}

internal sealed class BridgeEnrollmentFileLock : IBridgeEnrollmentLock
{
    private readonly string _lockPath;
    private readonly IBridgeCredentialAccessControl _accessControl;

    internal BridgeEnrollmentFileLock(
        string lockPath,
        IBridgeCredentialAccessControl accessControl)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(lockPath);
        ArgumentNullException.ThrowIfNull(accessControl);
        _lockPath = Path.GetFullPath(lockPath);
        _accessControl = accessControl;
    }

    public IDisposable AcquireExisting() =>
        Acquire(createIfMissing: false);

    public IDisposable AcquireForMutation() =>
        Acquire(createIfMissing: true);

    private IDisposable Acquire(bool createIfMissing)
    {
        string directoryPath =
            Path.GetDirectoryName(_lockPath) ??
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "The enrollment lock path has no parent directory.");
        try
        {
            BridgePathEntryKind directoryKind =
                _accessControl.ClassifyPath(directoryPath);
            if (directoryKind == BridgePathEntryKind.Directory)
            {
                _accessControl.VerifyProtectedDirectory(directoryPath);
            }
            else if (directoryKind == BridgePathEntryKind.Missing &&
                     createIfMissing)
            {
                _accessControl.EnsureProtectedDirectory(directoryPath);
            }
            else
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.LockUnavailable,
                    "The bridge enrollment credential directory is " +
                    "unavailable.");
            }

            IDisposable directoryPin =
                _accessControl.PinProtectedDirectory(directoryPath);
            try
            {
                _accessControl.VerifyNonReparsePath(_lockPath);
                BridgePathEntryKind lockKind =
                    _accessControl.ClassifyPath(_lockPath);
                if (lockKind == BridgePathEntryKind.File)
                {
                    _accessControl.VerifyProtectedFile(_lockPath);
                }
                else if (lockKind == BridgePathEntryKind.Missing &&
                         createIfMissing)
                {
                    using (var initialize = new FileStream(
                               _lockPath,
                               FileMode.CreateNew,
                               FileAccess.ReadWrite,
                               FileShare.ReadWrite | FileShare.Delete,
                               bufferSize: 1,
                               FileOptions.WriteThrough))
                    {
                        initialize.Flush(flushToDisk: true);
                    }

                    _accessControl.VerifyNonReparsePath(_lockPath);
                    _accessControl.ProtectFile(_lockPath);
                    _accessControl.VerifyProtectedFile(_lockPath);
                }
                else
                {
                    throw new BridgeCredentialStoreException(
                        BridgeCredentialStoreErrorCode.LockUnavailable,
                        "The bridge enrollment credential lock is unavailable.");
                }

                var lease = new FileStream(
                    _lockPath,
                    FileMode.Open,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.WriteThrough);
                try
                {
                    _accessControl.VerifyProtectedDirectory(directoryPath);
                    _accessControl.VerifyProtectedFile(_lockPath);
                    return new EnrollmentLease(lease, directoryPin);
                }
                catch
                {
                    lease.Dispose();
                    throw;
                }
            }
            catch
            {
                directoryPin.Dispose();
                throw;
            }
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.LockUnavailable,
                "The bridge enrollment credential lock is unavailable.",
                exception);
        }
    }

    private sealed class EnrollmentLease : IDisposable
    {
        private FileStream? _stream;
        private IDisposable? _directoryPin;

        internal EnrollmentLease(
            FileStream stream,
            IDisposable directoryPin)
        {
            _stream = stream;
            _directoryPin = directoryPin;
        }

        public void Dispose()
        {
            FileStream? stream = Interlocked.Exchange(ref _stream, null);
            IDisposable? directoryPin =
                Interlocked.Exchange(ref _directoryPin, null);
            try
            {
                stream?.Dispose();
            }
            finally
            {
                directoryPin?.Dispose();
            }
        }
    }
}
