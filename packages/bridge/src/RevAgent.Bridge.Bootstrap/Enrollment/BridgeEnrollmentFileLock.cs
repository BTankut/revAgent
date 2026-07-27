namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeEnrollmentLock
{
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
        _lockPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(lockPath);
        _accessControl = accessControl;
    }

    public IDisposable AcquireForMutation() =>
        Acquire();

    private IDisposable Acquire()
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
                try
                {
                    _accessControl.VerifyProtectedDirectory(directoryPath);
                }
                catch (BridgeCredentialStoreException exception)
                    when (exception.ErrorCode ==
                          BridgeCredentialStoreErrorCode.AccessControlFailure)
                {
                    _accessControl.EnsureProtectedDirectory(directoryPath);
                    _accessControl.VerifyProtectedDirectory(directoryPath);
                }
            }
            else if (directoryKind == BridgePathEntryKind.Missing)
            {
                _accessControl.EnsureProtectedDirectory(directoryPath);
                _accessControl.VerifyProtectedDirectory(directoryPath);
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
                    RepairAndVerifyExistingLock();
                }
                else if (lockKind == BridgePathEntryKind.Missing)
                {
                    CreateProtectedLock();
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

    private void RepairAndVerifyExistingLock()
    {
        try
        {
            _accessControl.VerifyProtectedFile(_lockPath);
        }
        catch (BridgeCredentialStoreException)
        {
            _accessControl.VerifyNonReparsePath(_lockPath);
            if (_accessControl.ClassifyPath(_lockPath) !=
                BridgePathEntryKind.File)
            {
                throw;
            }

            _accessControl.ProtectFile(_lockPath);
            _accessControl.VerifyProtectedFile(_lockPath);
        }
    }

    private void CreateProtectedLock()
    {
        try
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
        catch
        {
            TryDeleteUnprotectedBootstrapLock();
            throw;
        }
    }

    private void TryDeleteUnprotectedBootstrapLock()
    {
        try
        {
            _accessControl.VerifyNonReparsePath(_lockPath);
            if (_accessControl.ClassifyPath(_lockPath) ==
                BridgePathEntryKind.File)
            {
                File.Delete(_lockPath);
            }
        }
        catch
        {
            // A later mutation attempt repairs a regular residue in place.
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
