using System.Security.Cryptography;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IAtomicCredentialFileWriter
{
    bool HasResidue(string filePath);

    void RecoverResidue(string filePath);

    BridgeAtomicWriteResult Write(string filePath, byte[] content);
}

internal sealed class AtomicCredentialFileWriter :
    IAtomicCredentialFileWriter
{
    private const int MaximumCredentialBytes = 128 * 1024;
    private const string TemporarySuffix = ".revagent-write.tmp";
    private const string BackupSuffix = ".revagent-write.bak";
    private const string RestoreSuffix = ".revagent-restore.tmp";
    private const string IntentSuffix = ".revagent-write.intent";
    private const byte IntentVersion = 1;
    private const int IntentBytes = 66;

    private readonly IBridgeCredentialAccessControl _accessControl;

    internal AtomicCredentialFileWriter(
        IBridgeCredentialAccessControl accessControl)
    {
        ArgumentNullException.ThrowIfNull(accessControl);
        _accessControl = accessControl;
    }

    public bool HasResidue(string filePath)
    {
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(filePath);
        string temporaryPath = GetTemporaryPath(fullPath);
        string backupPath = GetBackupPath(fullPath);
        string restorePath = GetRestorePath(fullPath);
        string intentPath = GetIntentPath(fullPath);
        return IsPresentResidue(temporaryPath) ||
               IsPresentResidue(backupPath) ||
               IsPresentResidue(restorePath) ||
               IsPresentResidue(intentPath);
    }

    public void RecoverResidue(string filePath)
    {
        string fullPath;
        try
        {
            fullPath =
                BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(
                    filePath);
            BridgeAtomicWriteOutcome? recoveredOutcome =
                RecoverResidueCore(fullPath);
            if (recoveredOutcome is not null)
            {
                throw AtomicFailure(
                    BridgeAtomicWriteOutcome.NotCommitted,
                    "A prior bridge credential atomic-write residue was " +
                    "reconciled. Reload durable state before attempting a " +
                    "new write.",
                    recoveredPriorWriteOutcome: recoveredOutcome.Value);
            }
        }
        catch (BridgeCredentialStoreException exception)
            when (exception.AtomicWriteOutcome is not null)
        {
            if (exception.AtomicWriteOutcome ==
                    BridgeAtomicWriteOutcome.NotCommitted &&
                exception.RecoveredPriorWriteOutcome is not null)
            {
                throw;
            }

            throw RecoveryFailure(
                "The prior bridge credential atomic-write residue could not " +
                "be fully reconciled.",
                exception);
        }
        catch (Exception exception)
        {
            throw RecoveryFailure(
                "The bridge credential residue could not be reconciled " +
                "before a new atomic write.",
                exception);
        }
    }

    public BridgeAtomicWriteResult Write(string filePath, byte[] content)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "A protected bridge credential path is required.");
        }

        if (content is null)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "A protected bridge credential payload is required.");
        }

        if (content.Length is <= 0 or > MaximumCredentialBytes)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "A protected bridge credential must have a bounded, " +
                "non-empty payload.");
        }

        string fullPath;
        try
        {
            fullPath =
                BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(
                    filePath);
        }
        catch (Exception exception)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential path was rejected before " +
                "the atomic write began.",
                exception);
        }

        var operation = new AtomicWriteOperation(fullPath, content);
        try
        {
            return WriteCore(operation);
        }
        catch (BridgeCredentialStoreException exception)
            when (exception.AtomicWriteOutcome is not null)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw AtomicFailure(
                operation.TargetProven
                    ? BridgeAtomicWriteOutcome.Committed
                    : operation.ReplacementAttempted
                        ? BridgeAtomicWriteOutcome.Indeterminate
                        : BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential write exited without a " +
                "verified cleanup result.",
                exception);
        }
    }

    private BridgeAtomicWriteResult WriteCore(AtomicWriteOperation operation)
    {
        string directoryPath =
            Path.GetDirectoryName(operation.TargetPath) ??
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The bridge credential path must have a parent directory.");
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
            }
        }
        else if (directoryKind == BridgePathEntryKind.Missing)
        {
            _accessControl.EnsureProtectedDirectory(directoryPath);
        }
        else
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential parent is not a directory.");
        }

        using IDisposable directoryPin =
            _accessControl.PinProtectedDirectory(directoryPath);
        _accessControl.VerifyProtectedDirectory(directoryPath);
        BridgeAtomicWriteOutcome? recoveredOutcome;
        try
        {
            recoveredOutcome = RecoverResidueCore(operation.TargetPath);
        }
        catch (Exception exception)
        {
            throw RecoveryFailure(
                "The prior bridge credential atomic-write residue could not " +
                "be fully reconciled before the new write began.",
                exception);
        }

        if (recoveredOutcome is not null)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "A prior bridge credential atomic-write residue was " +
                "reconciled. Reload durable state before attempting a new " +
                "write.",
                recoveredPriorWriteOutcome: recoveredOutcome.Value);
        }
        _accessControl.VerifyNonReparsePath(operation.TargetPath);

        BridgePathEntryKind targetKind =
            _accessControl.ClassifyPath(operation.TargetPath);
        if (targetKind == BridgePathEntryKind.Directory)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential target is a directory.");
        }

        if (targetKind == BridgePathEntryKind.File)
        {
            BridgeProtectedFileRead previous =
                _accessControl.ReadProtectedFile(
                    operation.TargetPath,
                    MaximumCredentialBytes);
            operation.PreviousContent = previous.Content;
            operation.PreviousIdentity = previous.Identity;
            operation.PreviousDigest =
                SHA256.HashData(operation.PreviousContent);
        }

        try
        {
            WriteTemporaryFile(
                operation.TemporaryPath,
                operation.Content);
            operation.ReplacementIdentity =
                _accessControl.GetProtectedFileIdentity(
                    operation.TemporaryPath);
            WriteIntentFile(operation);

            operation.ReplacementAttempted = true;
            if (targetKind == BridgePathEntryKind.File)
            {
                File.Replace(
                    operation.TemporaryPath,
                    operation.TargetPath,
                    operation.BackupPath,
                    ignoreMetadataErrors: false);
            }
            else
            {
                File.Move(
                    operation.TemporaryPath,
                    operation.TargetPath);
            }

            _accessControl.ProtectFile(operation.TargetPath);
            _accessControl.VerifyProtectedFile(operation.TargetPath);
        }
        catch (Exception exception)
        {
            operation.Failure = exception;
        }

        try
        {
            return ResolveWriteOutcome(operation);
        }
        finally
        {
            Zero(operation.PreviousContent);
            operation.PreviousContent = null;
        }
    }

    private BridgeAtomicWriteResult ResolveWriteOutcome(
        AtomicWriteOperation operation)
    {
        if (operation.ReplacementIdentity is not null &&
            TryProveExpectedFile(
                operation.TargetPath,
                operation.ReplacementIdentity.Value,
                operation.Content))
        {
            operation.TargetProven = true;
            DeleteResidueStrict(
                operation.TemporaryPath,
                BridgeAtomicWriteOutcome.Committed,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.BackupPath,
                BridgeAtomicWriteOutcome.Committed);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.Committed,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.IntentPath,
                BridgeAtomicWriteOutcome.Committed,
                allowUnprotectedSidecar: true);
            return BridgeAtomicWriteResult.Committed;
        }

        if (!operation.ReplacementAttempted)
        {
            DeleteResidueStrict(
                operation.TemporaryPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.BackupPath,
                BridgeAtomicWriteOutcome.NotCommitted);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.IntentPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential failed before replacement; " +
                "the target was not committed.",
                operation.Failure);
        }

        if (operation.PreviousContent is not null &&
            operation.PreviousIdentity is not null &&
            TryProveExpectedFile(
                operation.TargetPath,
                operation.PreviousIdentity.Value,
                operation.PreviousContent))
        {
            DeleteResidueStrict(
                operation.TemporaryPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.BackupPath,
                BridgeAtomicWriteOutcome.NotCommitted);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.IntentPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential replacement did not commit; " +
                "the original target remained intact.",
                operation.Failure);
        }

        if (operation.PreviousContent is not null &&
            TryRestorePrevious(operation))
        {
            DeleteResidueStrict(
                operation.TemporaryPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.BackupPath,
                BridgeAtomicWriteOutcome.NotCommitted);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.IntentPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The protected bridge credential replacement was rolled " +
                "back to its verified previous content.",
                operation.Failure);
        }

        if (operation.PreviousContent is null &&
            IsMissing(operation.TargetPath))
        {
            DeleteResidueStrict(
                operation.TemporaryPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.BackupPath,
                BridgeAtomicWriteOutcome.NotCommitted);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                operation.IntentPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The new protected bridge credential target is absent; the " +
                "write did not commit.",
                operation.Failure);
        }

        throw AtomicFailure(
            BridgeAtomicWriteOutcome.Indeterminate,
            "The protected bridge credential replacement has an " +
            "indeterminate commit state and must be repaired before another " +
            "one-time enrollment token is used.",
            operation.Failure);
    }

    private BridgeAtomicWriteOutcome? RecoverResidueCore(string fullPath)
    {
        string directoryPath =
            Path.GetDirectoryName(fullPath) ??
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The bridge credential residue path has no parent.");
        BridgePathEntryKind directoryKind =
            _accessControl.ClassifyPath(directoryPath);
        if (directoryKind == BridgePathEntryKind.Missing)
        {
            return null;
        }

        if (directoryKind != BridgePathEntryKind.Directory)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.NotCommitted,
                "The bridge credential residue parent is not a directory.");
        }

        string temporaryPath = GetTemporaryPath(fullPath);
        string backupPath = GetBackupPath(fullPath);
        string restorePath = GetRestorePath(fullPath);
        string intentPath = GetIntentPath(fullPath);
        BridgePathEntryKind targetKind = ClassifyRegularOrMissing(fullPath);
        BridgePathEntryKind temporaryKind =
            ClassifyRegularOrMissing(temporaryPath);
        BridgePathEntryKind backupKind =
            ClassifyRegularOrMissing(backupPath);
        BridgePathEntryKind restoreKind =
            ClassifyRegularOrMissing(restorePath);
        BridgePathEntryKind intentKind =
            ClassifyRegularOrMissing(intentPath);
        if (temporaryKind == BridgePathEntryKind.Missing &&
            backupKind == BridgePathEntryKind.Missing &&
            restoreKind == BridgePathEntryKind.Missing &&
            intentKind == BridgePathEntryKind.Missing)
        {
            return null;
        }

        using IDisposable directoryPin =
            _accessControl.PinProtectedDirectory(directoryPath);
        _accessControl.VerifyProtectedDirectory(directoryPath);
        if (intentKind == BridgePathEntryKind.File)
        {
            return RecoverIntentResidue(
                fullPath,
                temporaryPath,
                backupPath,
                restorePath,
                intentPath,
                targetKind,
                temporaryKind,
                backupKind);
        }

        if (targetKind == BridgePathEntryKind.File)
        {
            _accessControl.VerifyProtectedFile(fullPath);
            BridgeAtomicWriteOutcome priorOutcome =
                BridgeAtomicWriteOutcome.NotCommitted;
            if (backupKind == BridgePathEntryKind.File)
            {
                _accessControl.VerifyProtectedFile(backupPath);
                priorOutcome = ProtectedFilesHaveEqualContent(
                    fullPath,
                    backupPath)
                        ? BridgeAtomicWriteOutcome.NotCommitted
                        : BridgeAtomicWriteOutcome.Committed;
            }

            DeleteResidueStrict(
                temporaryPath,
                priorOutcome,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                restorePath,
                priorOutcome,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(backupPath, priorOutcome);
            return priorOutcome;
        }

        if (backupKind == BridgePathEntryKind.File)
        {
            _accessControl.VerifyProtectedFile(backupPath);
            try
            {
                File.Move(backupPath, fullPath);
                _accessControl.ProtectFile(fullPath);
                _accessControl.VerifyProtectedFile(fullPath);
            }
            catch (Exception exception)
                when (IsCredentialIoFailure(exception))
            {
                if (ClassifyRegularOrMissing(fullPath) ==
                        BridgePathEntryKind.File &&
                    ClassifyRegularOrMissing(backupPath) ==
                        BridgePathEntryKind.Missing)
                {
                    throw AtomicFailure(
                        BridgeAtomicWriteOutcome.NotCommitted,
                        "The prior bridge credential backup was restored, " +
                        "but its post-condition could not be verified.",
                        exception);
                }

                throw AtomicFailure(
                    BridgeAtomicWriteOutcome.Indeterminate,
                    "The prior bridge credential backup could not be " +
                    "deterministically restored.",
                    exception);
            }

            DeleteResidueStrict(
                temporaryPath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            DeleteResidueStrict(
                restorePath,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            return BridgeAtomicWriteOutcome.NotCommitted;
        }

        DeleteResidueStrict(
            temporaryPath,
            BridgeAtomicWriteOutcome.NotCommitted,
            allowUnprotectedSidecar: true);
        DeleteResidueStrict(
            restorePath,
            BridgeAtomicWriteOutcome.NotCommitted,
            allowUnprotectedSidecar: true);
        return BridgeAtomicWriteOutcome.NotCommitted;
    }

    private BridgeAtomicWriteOutcome RecoverIntentResidue(
        string targetPath,
        string temporaryPath,
        string backupPath,
        string restorePath,
        string intentPath,
        BridgePathEntryKind targetKind,
        BridgePathEntryKind temporaryKind,
        BridgePathEntryKind backupKind)
    {
        AtomicWriteIntent intent;
        try
        {
            intent = ReadIntent(intentPath);
        }
        catch (Exception exception)
            when (IsCredentialIoFailure(exception))
        {
            if (temporaryKind == BridgePathEntryKind.File &&
                backupKind == BridgePathEntryKind.Missing)
            {
                DeleteResidueStrict(
                    temporaryPath,
                    BridgeAtomicWriteOutcome.NotCommitted,
                    allowUnprotectedSidecar: true);
                DeleteResidueStrict(
                    restorePath,
                    BridgeAtomicWriteOutcome.NotCommitted,
                    allowUnprotectedSidecar: true);
                DeleteResidueStrict(
                    intentPath,
                    BridgeAtomicWriteOutcome.NotCommitted,
                    allowUnprotectedSidecar: true);
                return BridgeAtomicWriteOutcome.NotCommitted;
            }

            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "The durable bridge credential write intent could not be " +
                "validated after replacement may have started.",
                exception);
        }

        BridgeAtomicWriteOutcome outcome;
        if (targetKind == BridgePathEntryKind.File)
        {
            byte[] targetDigest = ReadProtectedFileDigest(targetPath);
            try
            {
                if (CryptographicOperations.FixedTimeEquals(
                        targetDigest,
                        intent.ExpectedDigest))
                {
                    outcome = BridgeAtomicWriteOutcome.Committed;
                }
                else if (intent.PreviousDigest is not null &&
                         CryptographicOperations.FixedTimeEquals(
                             targetDigest,
                             intent.PreviousDigest))
                {
                    outcome = BridgeAtomicWriteOutcome.NotCommitted;
                }
                else
                {
                    throw AtomicFailure(
                        BridgeAtomicWriteOutcome.Indeterminate,
                        "The bridge credential target matches neither the " +
                        "durable intended payload nor the previous payload.");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(targetDigest);
            }
        }
        else if (!intent.TargetPreviouslyExisted)
        {
            outcome = BridgeAtomicWriteOutcome.NotCommitted;
        }
        else if (backupKind == BridgePathEntryKind.File &&
                 intent.PreviousDigest is not null)
        {
            byte[] backupDigest = ReadProtectedFileDigest(backupPath);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(
                        backupDigest,
                        intent.PreviousDigest))
                {
                    throw AtomicFailure(
                        BridgeAtomicWriteOutcome.Indeterminate,
                        "The bridge credential backup does not match the " +
                        "durable previous-payload digest.");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(backupDigest);
            }

            File.Move(backupPath, targetPath);
            _accessControl.ProtectFile(targetPath);
            _accessControl.VerifyProtectedFile(targetPath);
            outcome = BridgeAtomicWriteOutcome.NotCommitted;
        }
        else
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "The durable bridge credential intent requires a previous " +
                "target, but no verifiable target or backup remains.");
        }

        DeleteResidueStrict(
            temporaryPath,
            outcome,
            allowUnprotectedSidecar: true);
        DeleteResidueStrict(backupPath, outcome);
        DeleteResidueStrict(
            restorePath,
            outcome,
            allowUnprotectedSidecar: true);
        DeleteResidueStrict(
            intentPath,
            outcome,
            allowUnprotectedSidecar: true);
        return outcome;
    }

    private AtomicWriteIntent ReadIntent(string intentPath)
    {
        byte[]? bytes = null;
        try
        {
            _accessControl.VerifyProtectedFile(intentPath);
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    intentPath,
                    IntentBytes);
            bytes = read.Content;
            if (bytes.Length != IntentBytes ||
                bytes[0] != IntentVersion ||
                bytes[1] > 1)
            {
                throw new InvalidDataException(
                    "The durable bridge credential write intent is invalid.");
            }

            byte[] expectedDigest = bytes.AsSpan(2, 32).ToArray();
            byte[]? previousDigest = bytes[1] == 1
                ? bytes.AsSpan(34, 32).ToArray()
                : null;
            return new AtomicWriteIntent(
                bytes[1] == 1,
                expectedDigest,
                previousDigest);
        }
        finally
        {
            Zero(bytes);
        }
    }

    private byte[] ReadProtectedFileDigest(string path)
    {
        byte[]? content = null;
        try
        {
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    path,
                    MaximumCredentialBytes);
            content = read.Content;
            return SHA256.HashData(content);
        }
        catch (Exception exception)
            when (IsCredentialIoFailure(exception))
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "A durable bridge credential intent target could not be " +
                "read for digest recovery.",
                exception);
        }
        finally
        {
            Zero(content);
        }
    }

    private void WriteTemporaryFile(string temporaryPath, byte[] content)
    {
        WriteProtectedSidecar(temporaryPath, content);
    }

    private void WriteIntentFile(AtomicWriteOperation operation)
    {
        var intent = new byte[IntentBytes];
        intent[0] = IntentVersion;
        intent[1] = operation.PreviousDigest is null
            ? (byte)0
            : (byte)1;
        operation.ExpectedDigest.CopyTo(intent, 2);
        operation.PreviousDigest?.CopyTo(intent, 34);
        try
        {
            WriteProtectedSidecar(operation.IntentPath, intent);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(intent);
        }
    }

    private void WriteProtectedSidecar(string path, byte[] content)
    {
        _accessControl.VerifyNonReparsePath(path);
        try
        {
            using (var stream = new FileStream(
                       path,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       bufferSize: 16 * 1024,
                       FileOptions.WriteThrough))
            {
                stream.Write(content);
                stream.Flush(flushToDisk: true);
            }

            _accessControl.ProtectFile(path);
            _accessControl.VerifyProtectedFile(path);
        }
        catch
        {
            DeleteResidueStrict(
                path,
                BridgeAtomicWriteOutcome.NotCommitted,
                allowUnprotectedSidecar: true);
            throw;
        }
    }

    private bool TryRestorePrevious(AtomicWriteOperation operation)
    {
        if (operation.PreviousContent is null ||
            ClassifyRegularOrMissing(operation.BackupPath) !=
            BridgePathEntryKind.File)
        {
            return false;
        }

        byte[]? restored = null;
        try
        {
            _accessControl.VerifyProtectedFile(operation.BackupPath);
            DeleteResidueStrict(
                operation.RestorePath,
                BridgeAtomicWriteOutcome.Indeterminate,
                allowUnprotectedSidecar: true);
            File.Copy(
                operation.BackupPath,
                operation.RestorePath,
                overwrite: false);
            _accessControl.ProtectFile(operation.RestorePath);
            _accessControl.VerifyProtectedFile(operation.RestorePath);
            File.Replace(
                operation.RestorePath,
                operation.TargetPath,
                destinationBackupFileName: null,
                ignoreMetadataErrors: false);
            _accessControl.ProtectFile(operation.TargetPath);
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    operation.TargetPath,
                    operation.PreviousContent.Length);
            restored = read.Content;
            return restored.Length == operation.PreviousContent.Length &&
                   CryptographicOperations.FixedTimeEquals(
                       restored,
                       operation.PreviousContent);
        }
        catch (Exception exception)
            when (IsCredentialIoFailure(exception))
        {
            operation.Failure = operation.Failure is null
                ? exception
                : new AggregateException(operation.Failure, exception);
            return false;
        }
        finally
        {
            Zero(restored);
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
            when (IsCredentialIoFailure(exception))
        {
            return false;
        }
        finally
        {
            Zero(actual);
        }
    }

    private bool ProtectedFilesHaveEqualContent(
        string firstPath,
        string secondPath)
    {
        byte[]? first = null;
        byte[]? second = null;
        try
        {
            BridgeProtectedFileRead firstRead =
                _accessControl.ReadProtectedFile(
                    firstPath,
                    MaximumCredentialBytes);
            BridgeProtectedFileRead secondRead =
                _accessControl.ReadProtectedFile(
                    secondPath,
                    MaximumCredentialBytes);
            first = firstRead.Content;
            second = secondRead.Content;
            return first.Length == second.Length &&
                   CryptographicOperations.FixedTimeEquals(first, second);
        }
        catch (Exception exception)
            when (IsCredentialIoFailure(exception))
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "The bridge credential target and backup residue could not " +
                "be compared safely.",
                exception);
        }
        finally
        {
            Zero(first);
            Zero(second);
        }
    }

    private BridgePathEntryKind ClassifyRegularOrMissing(string path)
    {
        _accessControl.VerifyNonReparsePath(path);
        BridgePathEntryKind kind = _accessControl.ClassifyPath(path);
        if (kind == BridgePathEntryKind.Directory)
        {
            throw AtomicFailure(
                BridgeAtomicWriteOutcome.Indeterminate,
                "A bridge credential target or residue is unexpectedly a " +
                "directory.");
        }

        return kind;
    }

    private bool IsPresentResidue(string path)
    {
        BridgePathEntryKind kind = ClassifyRegularOrMissing(path);
        return kind == BridgePathEntryKind.File;
    }

    private bool IsMissing(string path) =>
        ClassifyRegularOrMissing(path) == BridgePathEntryKind.Missing;

    private void DeleteResidueStrict(
        string path,
        BridgeAtomicWriteOutcome outcome,
        bool allowUnprotectedSidecar = false)
    {
        try
        {
            BridgePathEntryKind kind = ClassifyRegularOrMissing(path);
            if (kind == BridgePathEntryKind.Missing)
            {
                return;
            }

            try
            {
                _accessControl.VerifyProtectedFile(path);
            }
            catch (Exception exception)
                when (allowUnprotectedSidecar &&
                      IsCredentialIoFailure(exception))
            {
                // The protected parent is pinned and ClassifyPath already
                // proved this exact deterministic sidecar is a regular,
                // single-link, no-ADS, non-reparse file. It may be residue
                // from a crash between create/flush and ACL application.
            }

            File.Delete(path);
            if (ClassifyRegularOrMissing(path) != BridgePathEntryKind.Missing)
            {
                throw new IOException(
                    "The bridge credential residue remained after deletion.");
            }
        }
        catch (BridgeCredentialStoreException exception)
            when (exception.AtomicWriteOutcome is not null)
        {
            throw;
        }
        catch (Exception exception)
            when (IsCredentialIoFailure(exception))
        {
            throw AtomicFailure(
                outcome,
                "The bridge credential target outcome was established, but " +
                "temporary or backup residue could not be removed.",
                exception);
        }
    }

    private static string GetTemporaryPath(string fullPath) =>
        fullPath + TemporarySuffix;

    private static string GetBackupPath(string fullPath) =>
        fullPath + BackupSuffix;

    private static string GetRestorePath(string fullPath) =>
        fullPath + RestoreSuffix;

    private static string GetIntentPath(string fullPath) =>
        fullPath + IntentSuffix;

    private static bool IsCredentialIoFailure(Exception exception) =>
        exception is BridgeCredentialStoreException or
        IOException or
        UnauthorizedAccessException or
        InvalidDataException or
        ArgumentException or
        NotSupportedException;

    private static BridgeCredentialStoreException AtomicFailure(
        BridgeAtomicWriteOutcome outcome,
        string message,
        Exception? innerException = null,
        BridgeAtomicWriteOutcome? recoveredPriorWriteOutcome = null) =>
        new(
            BridgeCredentialStoreErrorCode.AtomicWriteFailure,
            message,
            innerException,
            outcome,
            recoveredPriorWriteOutcome);

    private static BridgeCredentialStoreException RecoveryFailure(
        string message,
        Exception exception)
    {
        BridgeAtomicWriteOutcome recoveredPriorWriteOutcome =
            exception is BridgeCredentialStoreException storeException
                ? storeException.RecoveredPriorWriteOutcome ??
                  storeException.AtomicWriteOutcome ??
                  BridgeAtomicWriteOutcome.Indeterminate
                : BridgeAtomicWriteOutcome.Indeterminate;
        return AtomicFailure(
            BridgeAtomicWriteOutcome.NotCommitted,
            message,
            exception,
            recoveredPriorWriteOutcome);
    }

    private static void Zero(byte[]? content)
    {
        if (content is not null)
        {
            CryptographicOperations.ZeroMemory(content);
        }
    }

    private sealed record AtomicWriteIntent(
        bool TargetPreviouslyExisted,
        byte[] ExpectedDigest,
        byte[]? PreviousDigest);

    private sealed class AtomicWriteOperation
    {
        internal AtomicWriteOperation(string targetPath, byte[] content)
        {
            TargetPath = targetPath;
            Content = content;
            TemporaryPath = GetTemporaryPath(targetPath);
            BackupPath = GetBackupPath(targetPath);
            RestorePath = GetRestorePath(targetPath);
            IntentPath = GetIntentPath(targetPath);
            ExpectedDigest = SHA256.HashData(content);
        }

        internal string TargetPath { get; }

        internal string TemporaryPath { get; }

        internal string BackupPath { get; }

        internal string RestorePath { get; }

        internal string IntentPath { get; }

        internal byte[] Content { get; }

        internal byte[] ExpectedDigest { get; }

        internal byte[]? PreviousContent { get; set; }

        internal BridgeFileIdentity? PreviousIdentity { get; set; }

        internal byte[]? PreviousDigest { get; set; }

        internal BridgeFileIdentity? ReplacementIdentity { get; set; }

        internal bool ReplacementAttempted { get; set; }

        internal bool TargetProven { get; set; }

        internal Exception? Failure { get; set; }
    }
}
