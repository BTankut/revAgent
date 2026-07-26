using System.Security.Cryptography;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IAtomicCredentialFileWriter
{
    BridgeAtomicWriteResult Write(string filePath, byte[] content);
}

internal sealed class AtomicCredentialFileWriter :
    IAtomicCredentialFileWriter
{
    private readonly IBridgeCredentialAccessControl _accessControl;

    internal AtomicCredentialFileWriter(
        IBridgeCredentialAccessControl accessControl)
    {
        ArgumentNullException.ThrowIfNull(accessControl);
        _accessControl = accessControl;
    }

    public BridgeAtomicWriteResult Write(string filePath, byte[] content)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        ArgumentNullException.ThrowIfNull(content);
        if (content.Length == 0)
        {
            throw new ArgumentException(
                "A protected bridge credential cannot be empty.",
                nameof(content));
        }

        string fullPath = Path.GetFullPath(filePath);
        string directoryPath =
            Path.GetDirectoryName(fullPath) ??
            throw new ArgumentException(
                "The bridge credential path must have a parent directory.",
                nameof(filePath));
        BridgePathEntryKind directoryKind =
            _accessControl.ClassifyPath(directoryPath);
        if (directoryKind == BridgePathEntryKind.Missing)
        {
            _accessControl.EnsureProtectedDirectory(directoryPath);
        }
        else if (directoryKind != BridgePathEntryKind.Directory)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential parent is not a directory.");
        }

        using IDisposable directoryPin =
            _accessControl.PinProtectedDirectory(directoryPath);
        _accessControl.VerifyNonReparsePath(fullPath);
        BridgePathEntryKind targetKind =
            _accessControl.ClassifyPath(fullPath);
        if (targetKind == BridgePathEntryKind.Directory)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential target is a directory.");
        }

        byte[]? previousContent = null;
        BridgeFileIdentity? previousIdentity = null;
        if (targetKind == BridgePathEntryKind.File)
        {
            BridgeProtectedFileRead previous =
                _accessControl.ReadProtectedFile(
                    fullPath,
                    maximumBytes: 128 * 1024);
            previousContent = previous.Content;
            previousIdentity = previous.Identity;
        }

        string temporaryPath = Path.Combine(
            directoryPath,
            "." + Path.GetFileName(fullPath) + "." +
            Guid.NewGuid().ToString("N") + ".tmp");
        string backupPath = Path.Combine(
            directoryPath,
            "." + Path.GetFileName(fullPath) + "." +
            Guid.NewGuid().ToString("N") + ".bak");
        BridgeFileIdentity? replacementIdentity = null;
        Exception? writeFailure = null;
        try
        {
            WriteTemporaryFile(temporaryPath, content);
            replacementIdentity =
                _accessControl.GetProtectedFileIdentity(temporaryPath);
            if (targetKind == BridgePathEntryKind.File)
            {
                File.Replace(
                    temporaryPath,
                    fullPath,
                    backupPath,
                    ignoreMetadataErrors: false);
            }
            else
            {
                File.Move(temporaryPath, fullPath);
            }

            try
            {
                _accessControl.ProtectFile(fullPath);
                _accessControl.VerifyProtectedFile(fullPath);
            }
            catch (Exception exception)
                when (exception is BridgeCredentialStoreException or
                      IOException or UnauthorizedAccessException)
            {
                writeFailure = exception;
            }

            if (replacementIdentity is not null &&
                TryProveExpectedFile(
                    fullPath,
                    replacementIdentity.Value,
                    content))
            {
                TryDelete(backupPath);
                Zero(previousContent);
                return BridgeAtomicWriteResult.Committed;
            }

            writeFailure ??= new InvalidDataException(
                "The protected bridge credential post-condition was not met.");
        }
        catch (Exception exception)
            when (exception is BridgeCredentialStoreException or
                  IOException or UnauthorizedAccessException)
        {
            writeFailure = exception;
        }

        try
        {
            if (replacementIdentity is not null &&
                TryProveExpectedFile(
                    fullPath,
                    replacementIdentity.Value,
                    content))
            {
                TryDelete(backupPath);
                Zero(previousContent);
                return BridgeAtomicWriteResult.Committed;
            }

            if (previousContent is not null &&
                previousIdentity is not null &&
                replacementIdentity is not null &&
                TryProveExpectedFile(
                    fullPath,
                    previousIdentity.Value,
                    previousContent) &&
                TryProveExpectedFile(
                    temporaryPath,
                    replacementIdentity.Value,
                    content))
            {
                TryDelete(temporaryPath);
                TryDelete(backupPath);
                throw AtomicFailure(
                    BridgeAtomicWriteOutcome.NotCommitted,
                    "The protected bridge credential replacement did not " +
                    "commit; the original target remained intact.",
                    writeFailure);
            }

            if (previousContent is not null &&
                previousIdentity is not null &&
                TryRestorePrevious(
                    fullPath,
                    backupPath,
                    previousContent))
            {
                TryDelete(temporaryPath);
                throw AtomicFailure(
                    BridgeAtomicWriteOutcome.NotCommitted,
                    "The protected bridge credential write was rolled back.",
                    writeFailure);
            }

            if (previousContent is null &&
                _accessControl.ClassifyPath(fullPath) ==
                BridgePathEntryKind.Missing)
            {
                TryDelete(temporaryPath);
                TryDelete(backupPath);
                throw AtomicFailure(
                    BridgeAtomicWriteOutcome.NotCommitted,
                    "The protected bridge credential was not committed.",
                    writeFailure);
            }

            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "The protected bridge credential replacement has an " +
                "indeterminate commit state and must be repaired before " +
                "another one-time enrollment token is used.",
                writeFailure);
        }
        finally
        {
            if (previousContent is not null)
            {
                CryptographicOperations.ZeroMemory(previousContent);
            }
        }
    }

    private void WriteTemporaryFile(string temporaryPath, byte[] content)
    {
        _accessControl.VerifyNonReparsePath(temporaryPath);
        using (var stream = new FileStream(
                   temporaryPath,
                   FileMode.CreateNew,
                   FileAccess.Write,
                   FileShare.None,
                   bufferSize: 16 * 1024,
                   FileOptions.WriteThrough))
        {
            stream.Write(content);
            stream.Flush(flushToDisk: true);
        }

        try
        {
            _accessControl.ProtectFile(temporaryPath);
            _accessControl.VerifyProtectedFile(temporaryPath);
        }
        catch
        {
            TryDelete(temporaryPath);
            throw;
        }
    }

    private bool TryProveExpectedFile(
        string filePath,
        BridgeFileIdentity expectedIdentity,
        byte[] expectedContent)
    {
        byte[]? actual = null;
        try
        {
            if (_accessControl.ClassifyPath(filePath) !=
                BridgePathEntryKind.File)
            {
                return false;
            }

            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    filePath,
                    expectedContent.Length);
            actual = read.Content;
            return read.Identity == expectedIdentity &&
                   actual.Length == expectedContent.Length &&
                   CryptographicOperations.FixedTimeEquals(
                       actual,
                       expectedContent);
        }
        catch (Exception exception)
            when (exception is BridgeCredentialStoreException or
                  IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            if (actual is not null)
            {
                CryptographicOperations.ZeroMemory(actual);
            }
        }
    }

    private bool TryRestorePrevious(
        string filePath,
        string backupPath,
        byte[] expectedPreviousContent)
    {
        byte[]? restored = null;
        string restorePath = backupPath + "." +
            Guid.NewGuid().ToString("N") + ".restore.tmp";
        try
        {
            if (_accessControl.ClassifyPath(backupPath) !=
                BridgePathEntryKind.File)
            {
                return false;
            }

            _accessControl.VerifyProtectedFile(backupPath);
            File.Copy(backupPath, restorePath, overwrite: false);
            _accessControl.ProtectFile(restorePath);
            _accessControl.VerifyProtectedFile(restorePath);
            BridgePathEntryKind targetKind =
                _accessControl.ClassifyPath(filePath);
            if (targetKind == BridgePathEntryKind.File)
            {
                File.Replace(
                    restorePath,
                    filePath,
                    destinationBackupFileName: null,
                    ignoreMetadataErrors: false);
            }
            else if (targetKind == BridgePathEntryKind.Missing)
            {
                File.Move(restorePath, filePath);
            }
            else
            {
                return false;
            }

            _accessControl.ProtectFile(filePath);
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    filePath,
                    expectedPreviousContent.Length);
            restored = read.Content;
            bool verified =
                restored.Length == expectedPreviousContent.Length &&
                CryptographicOperations.FixedTimeEquals(
                    restored,
                    expectedPreviousContent);
            if (verified)
            {
                TryDelete(backupPath);
            }

            return verified;
        }
        catch (Exception exception)
            when (exception is BridgeCredentialStoreException or
                  IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            if (restored is not null)
            {
                CryptographicOperations.ZeroMemory(restored);
            }
        }
    }

    private void TryDelete(string filePath)
    {
        try
        {
            if (_accessControl.ClassifyPath(filePath) ==
                BridgePathEntryKind.File)
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // Preserve the outcome of the protected write/recovery probe.
        }
    }

    private static BridgeCredentialStoreException AtomicFailure(
        BridgeAtomicWriteOutcome outcome,
        string message,
        Exception? innerException = null) =>
        new(
            BridgeCredentialStoreErrorCode.AtomicWriteFailure,
            message,
            innerException,
            outcome);

    private static void Zero(byte[]? content)
    {
        if (content is not null)
        {
            CryptographicOperations.ZeroMemory(content);
        }
    }
}
