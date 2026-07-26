using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeCredentialReader
{
    BridgeRuntimeCredentialState? Load();
}

internal interface IBridgeCredentialMutator
{
    BridgeMachineIdentity GetOrCreateMachineIdentity();

    BridgeAtomicWriteResult SaveDeviceCredential(
        string expectedMachineFingerprint,
        BridgeDeviceCredential deviceCredential);

    BridgeAtomicWriteResult RepairDeviceCredentialForReenrollment(
        string expectedMachineFingerprint,
        BridgeDeviceCredential deviceCredential);

    BridgeMachineIdentity ResetAllCredentials(bool confirmReset);
}

internal sealed class BridgeCredentialReader : IBridgeCredentialReader
{
    private readonly BridgeCredentialPersistence _persistence;
    private readonly IBridgeEnrollmentLock _enrollmentLock;
    private readonly object _gate = new();

    internal BridgeCredentialReader(
        BridgeInstallLayout layout,
        IBridgeCredentialProtector protector,
        IBridgeCredentialAccessControl accessControl,
        IBridgeEnrollmentLock? enrollmentLock = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(protector);
        ArgumentNullException.ThrowIfNull(accessControl);
        _persistence = new BridgeCredentialPersistence(
            layout,
            protector,
            accessControl);
        _enrollmentLock =
            enrollmentLock ??
            new BridgeEnrollmentFileLock(
                layout.EnrollmentLockPath,
                accessControl);
    }

    internal static BridgeCredentialReader CreateProduction(
        BridgeInstallLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (!OperatingSystem.IsWindows())
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.UnsupportedPlatform,
                "The production bridge credential reader requires Windows.");
        }

        var accessControl = new WindowsBridgeCredentialAccessControl();
        return new BridgeCredentialReader(
            layout,
            new WindowsLocalMachineCredentialProtector(),
            accessControl);
    }

    public BridgeRuntimeCredentialState? Load()
    {
        lock (_gate)
        {
            BridgeCredentialEntryState entries =
                _persistence.ClassifyCredentialEntries();
            if (!entries.IdentityExists && !entries.DeviceCredentialExists)
            {
                return null;
            }

            using IDisposable lease = _enrollmentLock.AcquireExisting();
            return _persistence.LoadRuntimeState();
        }
    }

}

internal sealed class BridgeCredentialMutator : IBridgeCredentialMutator
{
    private readonly BridgeCredentialPersistence _persistence;
    private readonly IBridgeEnrollmentLock _enrollmentLock;
    private readonly Func<int, byte[]> _randomBytes;
    private readonly object _gate = new();

    internal BridgeCredentialMutator(
        BridgeInstallLayout layout,
        IBridgeCredentialProtector protector,
        IBridgeCredentialAccessControl accessControl,
        IAtomicCredentialFileWriter? atomicWriter = null,
        IBridgeEnrollmentLock? enrollmentLock = null,
        Func<int, byte[]>? randomBytes = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(protector);
        ArgumentNullException.ThrowIfNull(accessControl);
        _persistence = new BridgeCredentialPersistence(
            layout,
            protector,
            accessControl,
            atomicWriter);
        _enrollmentLock =
            enrollmentLock ??
            new BridgeEnrollmentFileLock(
                layout.EnrollmentLockPath,
                accessControl);
        _randomBytes = randomBytes ?? RandomNumberGenerator.GetBytes;
    }

    internal static BridgeCredentialMutator CreateProduction(
        BridgeInstallLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (!OperatingSystem.IsWindows())
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.UnsupportedPlatform,
                "The production bridge credential mutator requires Windows.");
        }

        var accessControl = new WindowsBridgeCredentialAccessControl();
        return new BridgeCredentialMutator(
            layout,
            new WindowsLocalMachineCredentialProtector(),
            accessControl);
    }

    public BridgeMachineIdentity GetOrCreateMachineIdentity()
    {
        lock (_gate)
        {
            using IDisposable lease = _enrollmentLock.AcquireForMutation();
            BridgeCredentialEntryState entries =
                _persistence.ClassifyCredentialEntries();
            if (entries.IdentityExists)
            {
                return _persistence.ReadMachineIdentity();
            }

            if (entries.DeviceCredentialExists)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.InvalidState,
                    "A device credential exists without its durable machine " +
                    "identity. Explicit reset-both repair is required.");
            }

            return CreateAndPersistIdentity();
        }
    }

    public BridgeAtomicWriteResult SaveDeviceCredential(
        string expectedMachineFingerprint,
        BridgeDeviceCredential deviceCredential)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(
            expectedMachineFingerprint);
        ArgumentNullException.ThrowIfNull(deviceCredential);
        lock (_gate)
        {
            using IDisposable lease = _enrollmentLock.AcquireForMutation();
            using BridgeMachineIdentity identity =
                ReadRequiredIdentity(expectedMachineFingerprint);
            if (_persistence.ClassifyCredentialEntries()
                .DeviceCredentialExists)
            {
                _ = _persistence.ReadDeviceCredential(
                    identity.MachineFingerprint);
            }

            return _persistence.WriteDeviceCredential(
                identity.MachineFingerprint,
                deviceCredential);
        }
    }

    public BridgeAtomicWriteResult RepairDeviceCredentialForReenrollment(
        string expectedMachineFingerprint,
        BridgeDeviceCredential deviceCredential)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(
            expectedMachineFingerprint);
        ArgumentNullException.ThrowIfNull(deviceCredential);
        lock (_gate)
        {
            using IDisposable lease = _enrollmentLock.AcquireForMutation();
            using BridgeMachineIdentity identity =
                ReadRequiredIdentity(expectedMachineFingerprint);
            if (_persistence.ClassifyCredentialEntries()
                .DeviceCredentialExists)
            {
                try
                {
                    _ = _persistence.ReadDeviceCredential(
                        identity.MachineFingerprint);
                }
                catch (BridgeCredentialStoreException exception)
                    when (exception.ErrorCode is
                          BridgeCredentialStoreErrorCode.ReadFailure or
                          BridgeCredentialStoreErrorCode.InvalidState or
                          BridgeCredentialStoreErrorCode.ProtectionFailure)
                {
                    _persistence.QuarantineDeviceCredential();
                }
            }

            return _persistence.WriteDeviceCredential(
                identity.MachineFingerprint,
                deviceCredential);
        }
    }

    public BridgeMachineIdentity ResetAllCredentials(bool confirmReset)
    {
        if (!confirmReset)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "Resetting the durable bridge identity requires explicit " +
                "reset-both confirmation.");
        }

        lock (_gate)
        {
            using IDisposable lease = _enrollmentLock.AcquireForMutation();
            _persistence.QuarantineAllCredentialState();
            return CreateAndPersistIdentity();
        }
    }

    private BridgeMachineIdentity ReadRequiredIdentity(
        string expectedMachineFingerprint)
    {
        BridgeCredentialEntryState entries =
            _persistence.ClassifyCredentialEntries();
        if (!entries.IdentityExists)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.IdentityMissing,
                "A durable bridge machine identity must exist before a " +
                "device credential can be stored.");
        }

        BridgeMachineIdentity identity =
            _persistence.ReadMachineIdentity();
        if (string.Equals(
                identity.MachineFingerprint,
                expectedMachineFingerprint,
                StringComparison.Ordinal))
        {
            return identity;
        }

        identity.Dispose();
        throw new BridgeCredentialStoreException(
            BridgeCredentialStoreErrorCode.IdentityMismatch,
            "The device credential was issued for a different bridge " +
            "machine fingerprint.");
    }

    private BridgeMachineIdentity CreateAndPersistIdentity()
    {
        byte[] seed =
            _randomBytes(BridgeMachineFingerprintPolicy.SeedSizeBytes) ??
            throw InvalidState(
                "The machine identity random source returned null.");
        try
        {
            if (seed.Length != BridgeMachineFingerprintPolicy.SeedSizeBytes)
            {
                throw InvalidState(
                    "The machine identity random source returned an invalid " +
                    "seed length.");
            }

            var identity = new BridgeMachineIdentity(seed);
            try
            {
                _ = _persistence.WriteMachineIdentity(identity);
                return identity;
            }
            catch
            {
                identity.Dispose();
                throw;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seed);
        }
    }

    private static BridgeCredentialStoreException InvalidState(
        string message) =>
        new(BridgeCredentialStoreErrorCode.InvalidState, message);
}

internal readonly record struct BridgeCredentialEntryState(
    bool IdentityExists,
    bool DeviceCredentialExists);

internal sealed class BridgeCredentialPersistence
{
    private const int SchemaVersion = 1;
    private const int MaximumProtectedFileBytes = 128 * 1024;
    private const int MaximumPlaintextBytes = 64 * 1024;

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = false,
        MaxDepth = 16,
    };

    private readonly BridgeInstallLayout _layout;
    private readonly IBridgeCredentialProtector _protector;
    private readonly IBridgeCredentialAccessControl _accessControl;
    private readonly IAtomicCredentialFileWriter _atomicWriter;

    internal BridgeCredentialPersistence(
        BridgeInstallLayout layout,
        IBridgeCredentialProtector protector,
        IBridgeCredentialAccessControl accessControl,
        IAtomicCredentialFileWriter? atomicWriter = null)
    {
        _layout = layout;
        _protector = protector;
        _accessControl = accessControl;
        _atomicWriter =
            atomicWriter ?? new AtomicCredentialFileWriter(accessControl);
    }

    internal BridgeCredentialEntryState ClassifyCredentialEntries()
    {
        BridgePathEntryKind identity =
            _accessControl.ClassifyPath(_layout.MachineIdentityPath);
        BridgePathEntryKind credential =
            _accessControl.ClassifyPath(_layout.DeviceCredentialPath);
        if (identity == BridgePathEntryKind.Directory ||
            credential == BridgePathEntryKind.Directory)
        {
            throw InvalidState(
                "A bridge credential state path is unexpectedly a directory.");
        }

        return new BridgeCredentialEntryState(
            identity == BridgePathEntryKind.File,
            credential == BridgePathEntryKind.File);
    }

    internal BridgeRuntimeCredentialState LoadRuntimeState()
    {
        BridgeCredentialEntryState entries = ClassifyCredentialEntries();
        if (!entries.IdentityExists && !entries.DeviceCredentialExists)
        {
            throw InvalidState(
                "The bridge credential state changed while its existing " +
                "enrollment lock was acquired.");
        }

        if (!entries.IdentityExists)
        {
            throw InvalidState(
                "A device credential exists without its durable machine " +
                "identity.");
        }

        using BridgeMachineIdentity identity = ReadMachineIdentity();
        BridgeDeviceCredential? credential = entries.DeviceCredentialExists
            ? ReadDeviceCredential(identity.MachineFingerprint)
            : null;
        return new BridgeRuntimeCredentialState(
            identity.MachineFingerprint,
            credential);
    }

    internal BridgeMachineIdentity ReadMachineIdentity()
    {
        PersistedMachineIdentity persisted =
            ReadProtectedJson<PersistedMachineIdentity>(
                _layout.MachineIdentityPath,
                "machine identity");
        if (persisted.SchemaVersion != SchemaVersion ||
            !string.Equals(
                persisted.FingerprintPolicy,
                BridgeMachineFingerprintPolicy.Name,
                StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(persisted.FingerprintSeed))
        {
            throw InvalidState(
                "The protected bridge machine identity is not a supported " +
                "schema.");
        }

        byte[] seed = DecodeBase64(
            persisted.FingerprintSeed,
            "The protected bridge machine identity seed is invalid.");
        try
        {
            if (seed.Length != BridgeMachineFingerprintPolicy.SeedSizeBytes)
            {
                throw InvalidState(
                    "The protected bridge machine identity seed has an " +
                    "invalid length.");
            }

            return new BridgeMachineIdentity(seed);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seed);
        }
    }

    internal BridgeDeviceCredential ReadDeviceCredential(
        string machineFingerprint)
    {
        PersistedDeviceCredential persisted =
            ReadProtectedJson<PersistedDeviceCredential>(
                _layout.DeviceCredentialPath,
                "device credential");
        if (persisted.SchemaVersion != SchemaVersion ||
            !string.Equals(
                persisted.FingerprintPolicy,
                BridgeMachineFingerprintPolicy.Name,
                StringComparison.Ordinal) ||
            !string.Equals(
                persisted.MachineFingerprint,
                machineFingerprint,
                StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(persisted.DeviceId) ||
            string.IsNullOrWhiteSpace(persisted.DeviceToken) ||
            !DateTimeOffset.TryParseExact(
                persisted.IssuedAtUtc,
                "O",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind,
                out DateTimeOffset issuedAtUtc))
        {
            throw InvalidState(
                "The protected bridge device credential is invalid or bound " +
                "to a different machine identity.");
        }

        try
        {
            return new BridgeDeviceCredential(
                persisted.DeviceId,
                new BridgeSecretString(persisted.DeviceToken),
                issuedAtUtc);
        }
        catch (ArgumentException exception)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "The protected bridge device credential violates its local " +
                "bounds.",
                exception);
        }
    }

    internal BridgeAtomicWriteResult WriteMachineIdentity(
        BridgeMachineIdentity identity)
    {
        byte[] seed = identity.CopySeed();
        try
        {
            var persisted = new PersistedMachineIdentity
            {
                SchemaVersion = SchemaVersion,
                FingerprintPolicy = BridgeMachineFingerprintPolicy.Name,
                FingerprintSeed = Convert.ToBase64String(seed),
            };
            return WriteProtectedJson(_layout.MachineIdentityPath, persisted);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seed);
        }
    }

    internal BridgeAtomicWriteResult WriteDeviceCredential(
        string machineFingerprint,
        BridgeDeviceCredential credential)
    {
        var persisted = new PersistedDeviceCredential
        {
            SchemaVersion = SchemaVersion,
            FingerprintPolicy = BridgeMachineFingerprintPolicy.Name,
            MachineFingerprint = machineFingerprint,
            DeviceId = credential.DeviceId,
            DeviceToken = credential.DeviceToken.Reveal(),
            IssuedAtUtc = credential.IssuedAtUtc.ToString("O"),
        };
        return WriteProtectedJson(
            _layout.DeviceCredentialPath,
            persisted);
    }

    internal void QuarantineDeviceCredential()
    {
        if (ClassifyCredentialEntries().DeviceCredentialExists)
        {
            Quarantine(_layout.DeviceCredentialPath, "device");
        }
    }

    internal void QuarantineAllCredentialState()
    {
        BridgeCredentialEntryState entries = ClassifyCredentialEntries();
        if (entries.DeviceCredentialExists)
        {
            Quarantine(_layout.DeviceCredentialPath, "device");
        }

        if (entries.IdentityExists)
        {
            Quarantine(_layout.MachineIdentityPath, "identity");
        }
    }

    private void Quarantine(string sourcePath, string stateName)
    {
        string quarantinePath = sourcePath + ".quarantine-" +
            DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" +
            Guid.NewGuid().ToString("N");
        using IDisposable pin =
            _accessControl.PinProtectedDirectory(
                _layout.CredentialDirectory);
        _accessControl.VerifyProtectedFile(sourcePath);
        _accessControl.VerifyNonReparsePath(quarantinePath);
        File.Move(sourcePath, quarantinePath);
        _accessControl.ProtectFile(quarantinePath);
        _accessControl.VerifyProtectedFile(quarantinePath);
        if (_accessControl.ClassifyPath(sourcePath) !=
            BridgePathEntryKind.Missing)
        {
            throw InvalidState(
                $"The corrupt bridge {stateName} was not quarantined.");
        }
    }

    private T ReadProtectedJson<T>(string filePath, string stateName)
    {
        byte[]? protectedBytes = null;
        byte[]? plaintext = null;
        try
        {
            string directoryPath =
                Path.GetDirectoryName(filePath) ??
                throw InvalidState(
                    "The bridge credential path has no parent directory.");
            _accessControl.VerifyProtectedDirectory(directoryPath);
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    filePath,
                    MaximumProtectedFileBytes);
            protectedBytes = read.Content;
            plaintext =
                _protector.Unprotect(protectedBytes) ??
                throw InvalidState(
                    $"The bridge {stateName} protector returned null.");
            if (plaintext.Length is <= 0 or > MaximumPlaintextBytes)
            {
                throw InvalidState(
                    $"The bridge {stateName} plaintext has an invalid size.");
            }

            RejectDuplicateJsonProperties(plaintext);
            return JsonSerializer.Deserialize<T>(
                       plaintext,
                       SerializerOptions) ??
                   throw InvalidState(
                       $"The protected bridge {stateName} is empty.");
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is IOException or
                  UnauthorizedAccessException or
                  JsonException or
                  FormatException or
                  ArgumentException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.ReadFailure,
                $"The protected bridge {stateName} could not be read or " +
                "validated.",
                exception);
        }
        finally
        {
            if (protectedBytes is not null)
            {
                CryptographicOperations.ZeroMemory(protectedBytes);
            }

            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
    }

    private BridgeAtomicWriteResult WriteProtectedJson<T>(
        string filePath,
        T state)
    {
        byte[]? plaintext = null;
        byte[]? protectedBytes = null;
        try
        {
            plaintext = JsonSerializer.SerializeToUtf8Bytes(
                state,
                SerializerOptions);
            if (plaintext.Length is <= 0 or > MaximumPlaintextBytes)
            {
                throw InvalidState(
                    "The bridge credential plaintext has an invalid size.");
            }

            protectedBytes =
                _protector.Protect(plaintext) ??
                throw InvalidState(
                    "The bridge credential protector returned null.");
            if (protectedBytes.Length is <= 0 or > MaximumProtectedFileBytes)
            {
                throw InvalidState(
                    "The protected bridge credential has an invalid size.");
            }

            BridgeAtomicWriteResult result =
                _atomicWriter.Write(filePath, protectedBytes);
            if (result.Outcome != BridgeAtomicWriteOutcome.Committed)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.AtomicWriteFailure,
                    "The bridge credential writer returned a non-committed " +
                    "result without a recovery exception.",
                    atomicWriteOutcome: result.Outcome);
            }

            return result;
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is JsonException or ArgumentException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "The bridge credential state could not be serialized.",
                exception);
        }
        finally
        {
            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }

            if (protectedBytes is not null)
            {
                CryptographicOperations.ZeroMemory(protectedBytes);
            }
        }
    }

    private static void RejectDuplicateJsonProperties(
        ReadOnlySpan<byte> utf8Json)
    {
        var reader = new Utf8JsonReader(
            utf8Json,
            new JsonReaderOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16,
            });
        var objectProperties = new Stack<HashSet<string>>();
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.StartObject)
            {
                objectProperties.Push(
                    new HashSet<string>(StringComparer.Ordinal));
            }
            else if (reader.TokenType == JsonTokenType.EndObject)
            {
                if (objectProperties.Count == 0)
                {
                    throw new JsonException(
                        "The protected JSON object nesting is invalid.");
                }

                _ = objectProperties.Pop();
            }
            else if (reader.TokenType == JsonTokenType.PropertyName)
            {
                if (objectProperties.Count == 0)
                {
                    throw new JsonException(
                        "A protected JSON property is outside an object.");
                }

                string propertyName =
                    reader.GetString() ??
                    throw new JsonException(
                        "A protected JSON property name is null.");
                if (!objectProperties.Peek().Add(propertyName))
                {
                    throw new JsonException(
                        "A protected JSON object contains a duplicate " +
                        "property.");
                }
            }
        }

        if (objectProperties.Count != 0)
        {
            throw new JsonException(
                "The protected JSON object nesting is incomplete.");
        }
    }

    private static byte[] DecodeBase64(string value, string errorMessage)
    {
        try
        {
            return Convert.FromBase64String(value);
        }
        catch (FormatException exception)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                errorMessage,
                exception);
        }
    }

    private static BridgeCredentialStoreException InvalidState(
        string message) =>
        new(BridgeCredentialStoreErrorCode.InvalidState, message);

    private sealed class PersistedMachineIdentity
    {
        [JsonPropertyName("schema_version")]
        public required int SchemaVersion { get; init; }

        [JsonPropertyName("fingerprint_policy")]
        public required string FingerprintPolicy { get; init; }

        [JsonPropertyName("fingerprint_seed")]
        public required string FingerprintSeed { get; init; }
    }

    private sealed class PersistedDeviceCredential
    {
        [JsonPropertyName("schema_version")]
        public required int SchemaVersion { get; init; }

        [JsonPropertyName("fingerprint_policy")]
        public required string FingerprintPolicy { get; init; }

        [JsonPropertyName("machine_fingerprint")]
        public required string MachineFingerprint { get; init; }

        [JsonPropertyName("device_id")]
        public required string DeviceId { get; init; }

        [JsonPropertyName("device_token")]
        public required string DeviceToken { get; init; }

        [JsonPropertyName("issued_at_utc")]
        public required string IssuedAtUtc { get; init; }
    }
}
