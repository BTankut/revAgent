using System.Buffers;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text.Json;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeCredentialReader
{
    BridgeRuntimeCredentialState? Load();
}

internal interface IBridgeCredentialMutator
{
    BridgeMachineIdentity GetOrCreateMachineIdentity();

    BridgeMachineIdentity GetRequiredMachineIdentity();

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
    private readonly object _gate = new();

    internal BridgeCredentialReader(
        BridgeInstallLayout layout,
        IBridgeCredentialProtector protector,
        IBridgeCredentialAccessControl accessControl)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(protector);
        ArgumentNullException.ThrowIfNull(accessControl);
        _persistence = new BridgeCredentialPersistence(
            layout,
            protector,
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
            _persistence.RecoverAtomicResidue();
            BridgeCredentialEntryState entries =
                _persistence.ClassifyCredentialEntries();
            if (entries.IdentityExists)
            {
                BridgeMachineIdentity identity =
                    _persistence.ReadMachineIdentity();
                try
                {
                    _persistence.EnsureMachineFingerprint(identity);
                    return identity;
                }
                catch
                {
                    identity.Dispose();
                    throw;
                }
            }

            if (entries.FingerprintExists ||
                entries.DeviceCredentialExists)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.InvalidState,
                    "Fingerprint or device-credential state exists without " +
                    "its durable machine identity. Explicit reset-both " +
                    "repair is required.");
            }

            return CreateAndPersistIdentity();
        }
    }

    public BridgeMachineIdentity GetRequiredMachineIdentity()
    {
        lock (_gate)
        {
            BridgeCredentialEntryState initialEntries =
                _persistence.ClassifyCredentialEntries();
            if (!initialEntries.IdentityExists)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.IdentityMissing,
                    "A durable bridge machine identity must already exist " +
                    "before protected-file re-enrollment.");
            }

            if (!initialEntries.FingerprintExists)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.InvalidState,
                    "Protected-file re-enrollment requires the existing " +
                    "machine-fingerprint metadata.");
            }

            using IDisposable lease = _enrollmentLock.AcquireForMutation();
            _persistence.EnsureNoAtomicResidue();
            BridgeCredentialEntryState entries =
                _persistence.ClassifyCredentialEntries();
            if (!entries.IdentityExists || !entries.FingerprintExists)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.InvalidState,
                    "The required Bridge identity changed before " +
                    "protected-file re-enrollment.");
            }

            BridgeMachineIdentity identity =
                _persistence.ReadMachineIdentity();
            try
            {
                _persistence.VerifyRequiredMachineFingerprint(identity);
                return identity;
            }
            catch
            {
                identity.Dispose();
                throw;
            }
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
            _persistence.RecoverAtomicResidue();
            using BridgeMachineIdentity identity =
                ReadRequiredIdentity(expectedMachineFingerprint);
            if (_persistence.ClassifyCredentialEntries()
                .DeviceCredentialExists)
            {
                BridgeDeviceCredential existing =
                    _persistence.ReadDeviceCredential(
                        identity.MachineFingerprint);
                existing.Dispose();
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
            _persistence.RecoverAtomicResidue();
            using BridgeMachineIdentity identity =
                ReadRequiredIdentity(expectedMachineFingerprint);
            if (_persistence.ClassifyCredentialEntries()
                .DeviceCredentialExists)
            {
                try
                {
                    BridgeDeviceCredential existing =
                        _persistence.ReadDeviceCredential(
                            identity.MachineFingerprint);
                    existing.Dispose();
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
            _persistence.RecoverAtomicResidue();
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
        try
        {
            _persistence.EnsureMachineFingerprint(identity);
        }
        catch
        {
            identity.Dispose();
            throw;
        }

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
    bool FingerprintExists,
    bool DeviceCredentialExists);

internal sealed class BridgeCredentialPersistence
{
    private const int SchemaVersion = 1;
    private const int MaximumProtectedFileBytes = 128 * 1024;
    private const int MaximumPlaintextBytes = 64 * 1024;

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
        BridgePathEntryKind fingerprint =
            _accessControl.ClassifyPath(_layout.MachineFingerprintPath);
        BridgePathEntryKind credential =
            _accessControl.ClassifyPath(_layout.DeviceCredentialPath);
        if (identity == BridgePathEntryKind.Directory ||
            fingerprint == BridgePathEntryKind.Directory ||
            credential == BridgePathEntryKind.Directory)
        {
            throw InvalidState(
                "A bridge credential state path is unexpectedly a directory.");
        }

        return new BridgeCredentialEntryState(
            identity == BridgePathEntryKind.File,
            fingerprint == BridgePathEntryKind.File,
            credential == BridgePathEntryKind.File);
    }

    internal void RecoverAtomicResidue()
    {
        _atomicWriter.RecoverResidue(_layout.MachineIdentityPath);
        _atomicWriter.RecoverResidue(_layout.MachineFingerprintPath);
        _atomicWriter.RecoverResidue(_layout.DeviceCredentialPath);
    }

    internal void EnsureNoAtomicResidue()
    {
        if (_atomicWriter.HasResidue(_layout.MachineIdentityPath) ||
            _atomicWriter.HasResidue(_layout.MachineFingerprintPath) ||
            _atomicWriter.HasResidue(_layout.DeviceCredentialPath))
        {
            throw InvalidState(
                "The bridge credential store contains unfinished atomic " +
                "write residue. Runtime access is blocked until the " +
                "bootstrap mutator reconciles it.");
        }
    }

    internal BridgeRuntimeCredentialState? LoadRuntimeState()
    {
        EnsureNoAtomicResidue();
        BridgeCredentialEntryState entries = ClassifyCredentialEntries();
        if (!entries.IdentityExists &&
            !entries.FingerprintExists &&
            !entries.DeviceCredentialExists)
        {
            return null;
        }

        if (!entries.IdentityExists || !entries.FingerprintExists)
        {
            throw InvalidState(
                "Runtime credential state requires both the durable machine " +
                "identity and its non-secret fingerprint metadata.");
        }

        BridgeFileIdentity identityFileIdentity =
            _accessControl.GetProtectedFileIdentity(
                _layout.MachineIdentityPath);
        RuntimeMachineIdentityRead identityRead =
            ReadRuntimeMachineFingerprint();
        RuntimeDeviceCredentialRead? credentialRead =
            entries.DeviceCredentialExists
                ? ReadRuntimeDeviceCredential(identityRead.MachineFingerprint)
                : null;
        try
        {
            EnsureNoAtomicResidue();
            BridgeCredentialEntryState finalEntries =
                ClassifyCredentialEntries();
            if (entries != finalEntries ||
                _accessControl.GetProtectedFileIdentity(
                    _layout.MachineIdentityPath) !=
                identityFileIdentity ||
                _accessControl.GetProtectedFileIdentity(
                    _layout.MachineFingerprintPath) !=
                identityRead.FileIdentity ||
                (credentialRead is not null &&
                 _accessControl.GetProtectedFileIdentity(
                     _layout.DeviceCredentialPath) !=
                 credentialRead.Value.FileIdentity))
            {
                throw InvalidState(
                    "The bridge credential state changed during its " +
                    "lock-free runtime read.");
            }

            return new BridgeRuntimeCredentialState(
                identityRead.MachineFingerprint,
                credentialRead?.Credential);
        }
        catch
        {
            credentialRead?.Credential.Dispose();
            throw;
        }
    }

    internal BridgeMachineIdentity ReadMachineIdentity()
    {
        MachineIdentityPayload payload =
            ReadProtectedPayload(
                _layout.MachineIdentityPath,
                "machine identity",
                plaintext => ParseMachineIdentity(plaintext.Span),
                out _);
        return payload.Identity ??
            throw InvalidState(
                "The protected bridge machine identity seed was not " +
                "materialized for the bootstrap mutator.");
    }

    private RuntimeMachineIdentityRead ReadRuntimeMachineFingerprint()
    {
        byte[]? metadata = null;
        try
        {
            _accessControl.VerifyProtectedDirectory(
                _layout.CredentialDirectory);
            BridgeProtectedFileRead read =
                _accessControl.ReadProtectedFile(
                    _layout.MachineFingerprintPath,
                    maximumBytes: 4 * 1024);
            metadata = read.Content;
            RejectDuplicateJsonProperties(metadata);
            return new RuntimeMachineIdentityRead(
                ParseMachineFingerprintMetadata(metadata),
                read.Identity);
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
                "The protected non-secret bridge machine fingerprint " +
                "metadata could not be read.",
                exception);
        }
        finally
        {
            if (metadata is not null)
            {
                CryptographicOperations.ZeroMemory(metadata);
            }
        }
    }

    private static MachineIdentityPayload ParseMachineIdentity(
        ReadOnlySpan<byte> json)
    {
        Span<byte> encodedSeed = stackalloc byte[44];
        Span<byte> decodedSeed =
            stackalloc byte[BridgeMachineFingerprintPolicy.SeedSizeBytes];
        try
        {
            var reader = NewStrictJsonReader(json);
            RequireStartObject(
                ref reader,
                "bridge machine identity");
            int? schemaVersion = null;
            string? fingerprintPolicy = null;
            string? machineFingerprint = null;
            bool seedPresent = false;
            while (reader.Read() &&
                   reader.TokenType != JsonTokenType.EndObject)
            {
                string propertyName =
                    ReadPropertyName(
                        ref reader,
                        "bridge machine identity");
                ReadPropertyValue(
                    ref reader,
                    "bridge machine identity");
                switch (propertyName)
                {
                    case "schema_version":
                        schemaVersion = ReadInt32(
                            ref reader,
                            "bridge machine identity schema version");
                        break;
                    case "fingerprint_policy":
                        fingerprintPolicy = ReadRequiredString(
                            ref reader,
                            "fingerprint policy");
                        break;
                    case "machine_fingerprint":
                        machineFingerprint = ReadRequiredString(
                            ref reader,
                            "machine fingerprint");
                        break;
                    case "fingerprint_seed":
                        if (reader.TokenType != JsonTokenType.String ||
                            reader.ValueIsEscaped ||
                            reader.HasValueSequence ||
                            reader.ValueSpan.Length != encodedSeed.Length)
                        {
                            throw new JsonException(
                                "The bridge machine identity seed encoding " +
                                "is invalid.");
                        }

                        reader.ValueSpan.CopyTo(encodedSeed);
                        seedPresent = true;
                        break;
                    default:
                        throw new JsonException(
                            "The bridge machine identity contains an unknown " +
                            "property.");
                }
            }

            RequireEndOfObjectAndDocument(
                ref reader,
                "bridge machine identity");
            if (schemaVersion != SchemaVersion ||
                !string.Equals(
                    fingerprintPolicy,
                    BridgeMachineFingerprintPolicy.Name,
                    StringComparison.Ordinal) ||
                !seedPresent ||
                !IsCanonicalFingerprint(machineFingerprint))
            {
                throw new JsonException(
                    "The bridge machine identity schema is invalid.");
            }

            OperationStatus decodeStatus = Base64.DecodeFromUtf8(
                encodedSeed,
                decodedSeed,
                out int consumed,
                out int written);
            if (decodeStatus != OperationStatus.Done ||
                consumed != encodedSeed.Length ||
                written != decodedSeed.Length)
            {
                throw new JsonException(
                    "The bridge machine identity seed is not canonical " +
                    "base64.");
            }

            var identity = new BridgeMachineIdentity(decodedSeed);
            if (!string.Equals(
                    identity.MachineFingerprint,
                    machineFingerprint,
                    StringComparison.Ordinal))
            {
                identity.Dispose();
                throw new JsonException(
                    "The bridge machine identity fingerprint does not match " +
                    "its seed.");
            }

            return new MachineIdentityPayload(
                machineFingerprint!,
                identity);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encodedSeed);
            CryptographicOperations.ZeroMemory(decodedSeed);
        }
    }

    private static string ParseMachineFingerprintMetadata(
        ReadOnlySpan<byte> json)
    {
        var reader = NewStrictJsonReader(json);
        RequireStartObject(
            ref reader,
            "bridge machine fingerprint metadata");
        int? schemaVersion = null;
        string? fingerprintPolicy = null;
        string? machineFingerprint = null;
        while (reader.Read() &&
               reader.TokenType != JsonTokenType.EndObject)
        {
            string propertyName =
                ReadPropertyName(
                    ref reader,
                    "bridge machine fingerprint metadata");
            ReadPropertyValue(
                ref reader,
                "bridge machine fingerprint metadata");
            switch (propertyName)
            {
                case "schema_version":
                    schemaVersion = ReadInt32(
                        ref reader,
                        "bridge machine fingerprint schema version");
                    break;
                case "fingerprint_policy":
                    fingerprintPolicy = ReadRequiredString(
                        ref reader,
                        "fingerprint policy");
                    break;
                case "machine_fingerprint":
                    machineFingerprint = ReadRequiredString(
                        ref reader,
                        "machine fingerprint");
                    break;
                default:
                    throw new JsonException(
                        "The bridge machine fingerprint metadata contains " +
                        "an unknown property.");
            }
        }

        RequireEndOfObjectAndDocument(
            ref reader,
            "bridge machine fingerprint metadata");
        if (schemaVersion != SchemaVersion ||
            !string.Equals(
                fingerprintPolicy,
                BridgeMachineFingerprintPolicy.Name,
                StringComparison.Ordinal) ||
            !IsCanonicalFingerprint(machineFingerprint))
        {
            throw new JsonException(
                "The bridge machine fingerprint metadata schema is invalid.");
        }

        return machineFingerprint!;
    }

    private static string ReadRequiredString(
        ref Utf8JsonReader reader,
        string fieldName)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException(
                $"The bridge machine identity {fieldName} must be a string.");
        }

        return reader.GetString() ??
            throw new JsonException(
                $"The bridge machine identity {fieldName} is null.");
    }

    private static bool IsCanonicalFingerprint(string? value)
    {
        const string prefix = "sha256:";
        if (value is null ||
            value.Length != prefix.Length + 64 ||
            !value.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        return value.AsSpan(prefix.Length).IndexOfAnyExcept(
            "0123456789abcdef") < 0;
    }

    internal BridgeDeviceCredential ReadDeviceCredential(
        string machineFingerprint) =>
        ReadDeviceCredentialCore(machineFingerprint, out _);

    private RuntimeDeviceCredentialRead ReadRuntimeDeviceCredential(
        string machineFingerprint)
    {
        BridgeDeviceCredential credential =
            ReadDeviceCredentialCore(
                machineFingerprint,
                out BridgeFileIdentity fileIdentity);
        return new RuntimeDeviceCredentialRead(credential, fileIdentity);
    }

    private BridgeDeviceCredential ReadDeviceCredentialCore(
        string machineFingerprint,
        out BridgeFileIdentity fileIdentity)
    {
        return ReadProtectedPayload(
                _layout.DeviceCredentialPath,
                "device credential",
                plaintext => ParseDeviceCredential(
                    plaintext.Span,
                    machineFingerprint),
                out fileIdentity);
    }

    private static BridgeDeviceCredential ParseDeviceCredential(
        ReadOnlySpan<byte> json,
        string expectedMachineFingerprint)
    {
        byte[]? tokenBytes = null;
        try
        {
            var reader = NewStrictJsonReader(json);
            RequireStartObject(ref reader, "bridge device credential");
            int? schemaVersion = null;
            string? fingerprintPolicy = null;
            string? machineFingerprint = null;
            string? deviceId = null;
            string? issuedAtText = null;
            int tokenLength = 0;
            while (reader.Read() &&
                   reader.TokenType != JsonTokenType.EndObject)
            {
                string propertyName =
                    ReadPropertyName(
                        ref reader,
                        "bridge device credential");
                ReadPropertyValue(
                    ref reader,
                    "bridge device credential");
                switch (propertyName)
                {
                    case "schema_version":
                        schemaVersion = ReadInt32(
                            ref reader,
                            "bridge device credential schema version");
                        break;
                    case "fingerprint_policy":
                        fingerprintPolicy = ReadRequiredString(
                            ref reader,
                            "fingerprint policy");
                        break;
                    case "machine_fingerprint":
                        machineFingerprint = ReadRequiredString(
                            ref reader,
                            "machine fingerprint");
                        break;
                    case "device_id":
                        deviceId = ReadRequiredString(
                            ref reader,
                            "device id");
                        break;
                    case "device_token":
                        if (reader.TokenType != JsonTokenType.String ||
                            reader.HasValueSequence)
                        {
                            throw new JsonException(
                                "The bridge device token must be a bounded " +
                                "JSON string.");
                        }

                        tokenBytes = new byte[
                            Math.Max(reader.ValueSpan.Length, 1)];
                        tokenLength = reader.CopyString(tokenBytes);
                        break;
                    case "issued_at_utc":
                        issuedAtText = ReadRequiredString(
                            ref reader,
                            "issue time");
                        break;
                    default:
                        throw new JsonException(
                            "The bridge device credential contains an unknown " +
                            "property.");
                }
            }

            RequireEndOfObjectAndDocument(
                ref reader,
                "bridge device credential");
            if (schemaVersion != SchemaVersion ||
                !string.Equals(
                    fingerprintPolicy,
                    BridgeMachineFingerprintPolicy.Name,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    machineFingerprint,
                    expectedMachineFingerprint,
                    StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(deviceId) ||
                tokenBytes is null ||
                !DateTimeOffset.TryParseExact(
                    issuedAtText,
                    "O",
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out DateTimeOffset issuedAtUtc))
            {
                throw new JsonException(
                    "The bridge device credential is invalid or bound to a " +
                    "different machine identity.");
            }

            BridgeSecretString? token = null;
            try
            {
                token = new BridgeSecretString(
                    tokenBytes.AsSpan(0, tokenLength));
                var credential = new BridgeDeviceCredential(
                    deviceId,
                    token,
                    issuedAtUtc);
                token = null;
                return credential;
            }
            finally
            {
                token?.Dispose();
            }
        }
        catch (ArgumentException exception)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "The protected bridge device credential violates its local " +
                "bounds.",
                exception);
        }
        finally
        {
            if (tokenBytes is not null)
            {
                CryptographicOperations.ZeroMemory(tokenBytes);
            }
        }
    }

    internal BridgeAtomicWriteResult WriteMachineIdentity(
        BridgeMachineIdentity identity)
    {
        byte[] seed = identity.CopySeed();
        byte[]? plaintext = null;
        try
        {
            plaintext = SerializeMachineIdentity(identity, seed);
            _ = WriteProtectedPayload(
                _layout.MachineIdentityPath,
                plaintext);
            return WriteMachineFingerprint(identity.MachineFingerprint);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seed);
            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
    }

    internal void EnsureMachineFingerprint(BridgeMachineIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        BridgePathEntryKind kind =
            _accessControl.ClassifyPath(_layout.MachineFingerprintPath);
        if (kind == BridgePathEntryKind.Missing)
        {
            _ = WriteMachineFingerprint(identity.MachineFingerprint);
            return;
        }

        if (kind != BridgePathEntryKind.File)
        {
            throw InvalidState(
                "The bridge machine fingerprint metadata path is not a " +
                "regular file.");
        }

        RuntimeMachineIdentityRead metadata =
            ReadRuntimeMachineFingerprint();
        if (!string.Equals(
                metadata.MachineFingerprint,
                identity.MachineFingerprint,
                StringComparison.Ordinal))
        {
            throw InvalidState(
                "The bridge machine fingerprint metadata does not match " +
                "the durable identity seed.");
        }
    }

    internal void VerifyRequiredMachineFingerprint(
        BridgeMachineIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        if (_accessControl.ClassifyPath(_layout.MachineFingerprintPath) !=
            BridgePathEntryKind.File)
        {
            throw InvalidState(
                "The required bridge machine fingerprint metadata is " +
                "missing or not a regular file.");
        }

        RuntimeMachineIdentityRead metadata =
            ReadRuntimeMachineFingerprint();
        if (!string.Equals(
                metadata.MachineFingerprint,
                identity.MachineFingerprint,
                StringComparison.Ordinal))
        {
            throw InvalidState(
                "The bridge machine fingerprint metadata does not match " +
                "the durable identity seed.");
        }
    }

    private BridgeAtomicWriteResult WriteMachineFingerprint(
        string machineFingerprint)
    {
        byte[] metadata = SerializeMachineFingerprint(machineFingerprint);
        try
        {
            BridgeAtomicWriteResult result = _atomicWriter.Write(
                _layout.MachineFingerprintPath,
                metadata);
            if (result.Outcome != BridgeAtomicWriteOutcome.Committed)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.AtomicWriteFailure,
                    "The bridge machine fingerprint writer returned a " +
                    "non-committed result without a recovery exception.",
                    atomicWriteOutcome: result.Outcome);
            }

            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(metadata);
        }
    }

    internal BridgeAtomicWriteResult WriteDeviceCredential(
        string machineFingerprint,
        BridgeDeviceCredential credential)
    {
        byte[]? plaintext = null;
        try
        {
            plaintext = SerializeDeviceCredential(
                machineFingerprint,
                credential);
            return WriteProtectedPayload(
                _layout.DeviceCredentialPath,
                plaintext);
        }
        finally
        {
            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
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

        if (entries.FingerprintExists)
        {
            Quarantine(
                _layout.MachineFingerprintPath,
                "machine fingerprint metadata");
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

    private T ReadProtectedPayload<T>(
        string filePath,
        string stateName,
        Func<ReadOnlyMemory<byte>, T> parser,
        out BridgeFileIdentity fileIdentity)
    {
        byte[]? protectedBytes = null;
        byte[]? plaintext = null;
        fileIdentity = default;
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
            fileIdentity = read.Identity;
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
            return parser(plaintext);
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

    private BridgeAtomicWriteResult WriteProtectedPayload(
        string filePath,
        byte[] plaintext)
    {
        byte[]? protectedBytes = null;
        try
        {
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
            if (protectedBytes is not null)
            {
                CryptographicOperations.ZeroMemory(protectedBytes);
            }
        }
    }

    private static byte[] SerializeMachineIdentity(
        BridgeMachineIdentity identity,
        ReadOnlySpan<byte> seed)
    {
        Span<byte> encodedSeed = stackalloc byte[44];
        try
        {
            OperationStatus status = Base64.EncodeToUtf8(
                seed,
                encodedSeed,
                out int consumed,
                out int written);
            if (status != OperationStatus.Done ||
                consumed != seed.Length ||
                written != encodedSeed.Length)
            {
                throw InvalidState(
                    "The bridge machine identity seed could not be encoded.");
            }

            using var stream = new MemoryStream(capacity: 512);
            using (var writer = new Utf8JsonWriter(
                       stream,
                       new JsonWriterOptions
                       {
                           Indented = false,
                           SkipValidation = false,
                       }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schema_version", SchemaVersion);
                writer.WriteString(
                    "fingerprint_policy",
                    BridgeMachineFingerprintPolicy.Name);
                writer.WriteString(
                    "machine_fingerprint",
                    identity.MachineFingerprint);
                writer.WriteString("fingerprint_seed", encodedSeed);
                writer.WriteEndObject();
                writer.Flush();
            }

            return CopyAndClearStream(stream);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encodedSeed);
        }
    }

    private static byte[] SerializeMachineFingerprint(
        string machineFingerprint)
    {
        if (!IsCanonicalFingerprint(machineFingerprint))
        {
            throw InvalidState(
                "The bridge machine fingerprint is not canonical.");
        }

        using var stream = new MemoryStream(capacity: 256);
        using (var writer = new Utf8JsonWriter(
                   stream,
                   new JsonWriterOptions
                   {
                       Indented = false,
                       SkipValidation = false,
                   }))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schema_version", SchemaVersion);
            writer.WriteString(
                "fingerprint_policy",
                BridgeMachineFingerprintPolicy.Name);
            writer.WriteString(
                "machine_fingerprint",
                machineFingerprint);
            writer.WriteEndObject();
            writer.Flush();
        }

        return CopyAndClearStream(stream);
    }

    private static byte[] SerializeDeviceCredential(
        string machineFingerprint,
        BridgeDeviceCredential credential)
    {
        byte[] tokenBytes = credential.DeviceToken.CopyUtf8Bytes();
        try
        {
            using var stream = new MemoryStream(
                capacity: Math.Min(
                    tokenBytes.Length + 512,
                    MaximumPlaintextBytes));
            using (var writer = new Utf8JsonWriter(
                       stream,
                       new JsonWriterOptions
                       {
                           Indented = false,
                           SkipValidation = false,
                       }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schema_version", SchemaVersion);
                writer.WriteString(
                    "fingerprint_policy",
                    BridgeMachineFingerprintPolicy.Name);
                writer.WriteString(
                    "machine_fingerprint",
                    machineFingerprint);
                writer.WriteString("device_id", credential.DeviceId);
                writer.WriteString("device_token", tokenBytes);
                writer.WriteString(
                    "issued_at_utc",
                    credential.IssuedAtUtc.ToString("O"));
                writer.WriteEndObject();
                writer.Flush();
            }

            return CopyAndClearStream(stream);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(tokenBytes);
        }
    }

    private static byte[] CopyAndClearStream(MemoryStream stream)
    {
        int length = checked((int)stream.Length);
        byte[] backingBuffer = stream.GetBuffer();
        try
        {
            var result = new byte[length];
            backingBuffer.AsSpan(0, length).CopyTo(result);
            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(
                backingBuffer.AsSpan(0, length));
        }
    }

    private static Utf8JsonReader NewStrictJsonReader(
        ReadOnlySpan<byte> json) =>
        new(
            json,
            new JsonReaderOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16,
            });

    private static void RequireStartObject(
        ref Utf8JsonReader reader,
        string stateName)
    {
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                $"The {stateName} must be a JSON object.");
        }
    }

    private static string ReadPropertyName(
        ref Utf8JsonReader reader,
        string stateName)
    {
        if (reader.TokenType != JsonTokenType.PropertyName)
        {
            throw new JsonException(
                $"The {stateName} property is invalid.");
        }

        return reader.GetString() ??
            throw new JsonException(
                $"The {stateName} property name is null.");
    }

    private static void ReadPropertyValue(
        ref Utf8JsonReader reader,
        string stateName)
    {
        if (!reader.Read())
        {
            throw new JsonException(
                $"The {stateName} property has no value.");
        }
    }

    private static int ReadInt32(
        ref Utf8JsonReader reader,
        string fieldName)
    {
        if (reader.TokenType != JsonTokenType.Number ||
            !reader.TryGetInt32(out int value))
        {
            throw new JsonException(
                $"The {fieldName} must be a 32-bit integer.");
        }

        return value;
    }

    private static void RequireEndOfObjectAndDocument(
        ref Utf8JsonReader reader,
        string stateName)
    {
        if (reader.TokenType != JsonTokenType.EndObject ||
            reader.Read())
        {
            throw new JsonException(
                $"The {stateName} JSON document is incomplete or contains " +
                "trailing data.");
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

    private static BridgeCredentialStoreException InvalidState(
        string message) =>
        new(BridgeCredentialStoreErrorCode.InvalidState, message);

    private readonly record struct MachineIdentityPayload(
        string MachineFingerprint,
        BridgeMachineIdentity? Identity);

    private readonly record struct RuntimeMachineIdentityRead(
        string MachineFingerprint,
        BridgeFileIdentity FileIdentity);

    private readonly record struct RuntimeDeviceCredentialRead(
        BridgeDeviceCredential Credential,
        BridgeFileIdentity FileIdentity);

}
