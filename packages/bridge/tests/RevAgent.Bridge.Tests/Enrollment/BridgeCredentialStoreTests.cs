using System.Security.Cryptography;
using System.Text;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeCredentialStoreTests
{
    private const string FirstDeviceToken =
        "opaque-device-token-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdef";
    private const string RotatedDeviceToken =
        "rotated-device-token-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdef";

    [Fact]
    public void MissingRuntimeStore_LoadDoesNotCreateDirectoryLockOrState()
    {
        using var fixture = CredentialFixture.Create();

        BridgeRuntimeCredentialState? state = fixture.Reader.Load();

        Assert.Null(state);
        Assert.False(Directory.Exists(fixture.Layout.CredentialDirectory));
        Assert.False(File.Exists(fixture.Layout.EnrollmentLockPath));
        Assert.False(File.Exists(fixture.Layout.MachineIdentityPath));
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
        Assert.Equal(0, fixture.RandomCalls);
    }

    [Fact]
    public void ReaderAndMutator_AreDifferentCapabilities()
    {
        Assert.False(
            typeof(IBridgeCredentialMutator)
                .IsAssignableFrom(typeof(BridgeCredentialReader)));
        Assert.False(
            typeof(IBridgeCredentialReader)
                .IsAssignableFrom(typeof(BridgeCredentialMutator)));
    }

    [Fact]
    public void ExistingStateWithoutLock_RuntimeFailsWithoutRepairingLock()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        File.Delete(fixture.Layout.EnrollmentLockPath);

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Reader.Load());

        Assert.Equal(
            BridgeCredentialStoreErrorCode.LockUnavailable,
            exception.ErrorCode);
        Assert.False(File.Exists(fixture.Layout.EnrollmentLockPath));
    }

    [Fact]
    public void GetOrCreateIdentity_IsStableAndBootstrapOwned()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity first =
            fixture.Mutator.GetOrCreateMachineIdentity();
        using BridgeMachineIdentity second =
            fixture.Mutator.GetOrCreateMachineIdentity();

        Assert.Equal(first.MachineFingerprint, second.MachineFingerprint);
        Assert.Equal(1, fixture.RandomCalls);
        Assert.True(File.Exists(fixture.Layout.EnrollmentLockPath));
        Assert.True(File.Exists(fixture.Layout.MachineIdentityPath));
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
    }

    [Fact]
    public void RuntimeRoundTrip_ReturnsFingerprintWithoutSeedCapability()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        BridgeAtomicWriteResult result =
            fixture.Mutator.SaveDeviceCredential(
                identity.MachineFingerprint,
                NewCredential(FirstDeviceToken, "device-42"));

        BridgeRuntimeCredentialState state =
            Assert.IsType<BridgeRuntimeCredentialState>(
                fixture.Reader.Load());

        Assert.Equal(BridgeAtomicWriteOutcome.Committed, result.Outcome);
        Assert.Equal(identity.MachineFingerprint, state.MachineFingerprint);
        Assert.True(state.IsEnrolled);
        Assert.Equal("device-42", state.DeviceCredential!.DeviceId);
        Assert.Equal(
            FirstDeviceToken,
            state.DeviceCredential.DeviceToken.Reveal());
        Assert.DoesNotContain(
            typeof(BridgeMachineIdentity).Name,
            state.GetType().GetProperties()
                .Select(property => property.PropertyType.Name));
    }

    [Fact]
    public void FinalAclRetryProbe_ReportsCommittedInsteadOfFalseFailure()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        fixture.AccessControl.FailNextFinalProtectPath =
            fixture.Layout.DeviceCredentialPath;

        BridgeAtomicWriteResult result =
            fixture.Mutator.SaveDeviceCredential(
                identity.MachineFingerprint,
                NewCredential(FirstDeviceToken, "device-42"));

        Assert.Equal(BridgeAtomicWriteOutcome.Committed, result.Outcome);
        Assert.True(fixture.Reader.Load()!.IsEnrolled);
    }

    [Fact]
    public void TemporaryAclFailure_IsExplicitlyNotCommitted()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        fixture.AccessControl.FailNextTemporaryProtect = true;

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(FirstDeviceToken, "device-42")));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            exception.AtomicWriteOutcome);
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
    }

    [Fact]
    public void UnprovablePostCondition_IsExplicitlyIndeterminate()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        fixture.AccessControl.FailReadsForPath =
            fixture.Layout.DeviceCredentialPath;
        fixture.AccessControl.FailReadsAfterSuccessfulCount = 2;

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));

        Assert.Equal(
            BridgeAtomicWriteOutcome.Indeterminate,
            exception.AtomicWriteOutcome);
    }

    [Fact]
    public void CorruptDeviceRepair_PreservesIdentityAndQuarantinesBlob()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        File.WriteAllBytes(
            fixture.Layout.DeviceCredentialPath,
            Encoding.UTF8.GetBytes("corrupt-device-blob"));

        BridgeAtomicWriteResult result =
            fixture.Mutator.RepairDeviceCredentialForReenrollment(
                identity.MachineFingerprint,
                NewCredential(RotatedDeviceToken, "device-42"));
        BridgeRuntimeCredentialState state = fixture.Reader.Load()!;

        Assert.Equal(BridgeAtomicWriteOutcome.Committed, result.Outcome);
        Assert.Equal(identity.MachineFingerprint, state.MachineFingerprint);
        Assert.Equal(
            RotatedDeviceToken,
            state.DeviceCredential!.DeviceToken.Reveal());
        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
    }

    [Fact]
    public void CorruptDevice_NormalSaveDoesNotSilentlyRepair()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        File.WriteAllBytes(
            fixture.Layout.DeviceCredentialPath,
            Encoding.UTF8.GetBytes("corrupt-device-blob"));

        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Mutator.SaveDeviceCredential(
                identity.MachineFingerprint,
                NewCredential(RotatedDeviceToken, "device-42")));

        Assert.Empty(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
        Assert.Equal(
            "corrupt-device-blob",
            Encoding.UTF8.GetString(
                File.ReadAllBytes(fixture.Layout.DeviceCredentialPath)));
    }

    [Fact]
    public void CorruptIdentity_RequiresExplicitResetBoth()
    {
        using var fixture = CredentialFixture.Create();
        string originalFingerprint;
        using (BridgeMachineIdentity identity =
               fixture.Mutator.GetOrCreateMachineIdentity())
        {
            originalFingerprint = identity.MachineFingerprint;
            _ = fixture.Mutator.SaveDeviceCredential(
                originalFingerprint,
                NewCredential(FirstDeviceToken, "device-42"));
        }

        File.WriteAllBytes(
            fixture.Layout.MachineIdentityPath,
            Encoding.UTF8.GetBytes("corrupt-identity"));

        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Mutator.GetOrCreateMachineIdentity());
        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Mutator.ResetAllCredentials(confirmReset: false));

        using BridgeMachineIdentity replacement =
            fixture.Mutator.ResetAllCredentials(confirmReset: true);

        Assert.NotEqual(
            originalFingerprint,
            replacement.MachineFingerprint);
        Assert.Null(fixture.Reader.Load()!.DeviceCredential);
        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "machine-identity.dpapi.quarantine-*"));
        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
    }

    [Fact]
    public void DuplicateJsonProperty_IsRejected()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        byte[] protectedBytes =
            File.ReadAllBytes(fixture.Layout.MachineIdentityPath);
        byte[] plaintext = XorCredentialProtector.Transform(protectedBytes);
        try
        {
            string json = Encoding.UTF8.GetString(plaintext);
            string duplicated = json.Replace(
                "\"schema_version\":1",
                "\"schema_version\":1,\"schema_version\":1",
                StringComparison.Ordinal);
            byte[] duplicatePlaintext = Encoding.UTF8.GetBytes(duplicated);
            try
            {
                File.WriteAllBytes(
                    fixture.Layout.MachineIdentityPath,
                    XorCredentialProtector.Transform(duplicatePlaintext));
            }
            finally
            {
                CryptographicOperations.ZeroMemory(duplicatePlaintext);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
            CryptographicOperations.ZeroMemory(plaintext);
        }

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Reader.Load());

        Assert.Equal(
            BridgeCredentialStoreErrorCode.ReadFailure,
            exception.ErrorCode);
    }

    private static BridgeDeviceCredential NewCredential(
        string token,
        string deviceId) =>
        new(
            deviceId,
            new BridgeSecretString(token),
            DateTimeOffset.Parse("2026-07-26T10:15:00Z"));

    private sealed class CredentialFixture : IDisposable
    {
        private CredentialFixture(
            string rootPath,
            byte[] seed,
            RecordingAccessControl accessControl)
        {
            RootPath = rootPath;
            Layout = new BridgeInstallLayout(
                Path.Combine(rootPath, "install"),
                Path.Combine(rootPath, "state"));
            AccessControl = accessControl;
            var protector = new XorCredentialProtector();
            Reader = new BridgeCredentialReader(
                Layout,
                protector,
                accessControl);
            Mutator = new BridgeCredentialMutator(
                Layout,
                protector,
                accessControl,
                randomBytes: count =>
                {
                    RandomCalls++;
                    Assert.Equal(seed.Length, count);
                    byte[] value = (byte[])seed.Clone();
                    value[0] = checked((byte)(value[0] + RandomCalls - 1));
                    return value;
                });
        }

        internal string RootPath { get; }

        internal BridgeInstallLayout Layout { get; }

        internal RecordingAccessControl AccessControl { get; }

        internal BridgeCredentialReader Reader { get; }

        internal BridgeCredentialMutator Mutator { get; }

        internal int RandomCalls { get; private set; }

        internal static CredentialFixture Create()
        {
            string rootPath = Path.Combine(
                Path.GetTempPath(),
                $"revagent-bridge-credential-tests-{Guid.NewGuid():N}");
            byte[] seed = Enumerable.Range(0, 32)
                .Select(value => (byte)value)
                .ToArray();
            return new CredentialFixture(
                rootPath,
                seed,
                new RecordingAccessControl());
        }

        public void Dispose()
        {
            if (Directory.Exists(RootPath))
            {
                Directory.Delete(RootPath, recursive: true);
            }
        }
    }

    private sealed class XorCredentialProtector :
        IBridgeCredentialProtector
    {
        public byte[] Protect(byte[] plaintext) => Transform(plaintext);

        public byte[] Unprotect(byte[] protectedBytes) =>
            Transform(protectedBytes);

        internal static byte[] Transform(byte[] source)
        {
            var result = new byte[source.Length];
            for (int index = 0; index < source.Length; index++)
            {
                result[index] = (byte)(source[index] ^ 0xA5);
            }

            return result;
        }
    }

    private sealed class RecordingAccessControl :
        IBridgeCredentialAccessControl
    {
        private readonly IBridgeCredentialFileSystem _fileSystem =
            new BridgeCredentialFileSystem();

        internal bool FailNextTemporaryProtect { get; set; }

        internal string? FailNextFinalProtectPath { get; set; }

        internal string? FailReadsForPath { get; set; }

        internal int FailReadsAfterSuccessfulCount { get; set; }

        private int MatchingReadCount { get; set; }

        public void EnsureProtectedDirectory(string directoryPath) =>
            _ = Directory.CreateDirectory(directoryPath);

        public BridgePathEntryKind ClassifyPath(string path) =>
            _fileSystem.Classify(path);

        public IDisposable PinProtectedDirectory(string directoryPath) =>
            _fileSystem.PinDirectory(directoryPath);

        public void VerifyNonReparsePath(string path)
        {
            BridgePathEntryKind kind = _fileSystem.Classify(path);
            if (kind == BridgePathEntryKind.Directory)
            {
                _fileSystem.PinDirectory(path).Dispose();
            }
            else if (kind == BridgePathEntryKind.File)
            {
                _fileSystem.PinFile(path).Dispose();
            }
            else
            {
                string parent = Path.GetDirectoryName(path)!;
                while (_fileSystem.Classify(parent) ==
                       BridgePathEntryKind.Missing)
                {
                    parent = Path.GetDirectoryName(parent)!;
                }

                _fileSystem.PinDirectory(parent).Dispose();
            }
        }

        public void ProtectFile(string filePath)
        {
            if (FailNextTemporaryProtect &&
                filePath.EndsWith(".tmp", StringComparison.Ordinal))
            {
                FailNextTemporaryProtect = false;
                throw AccessFailure();
            }

            if (FailNextFinalProtectPath is not null &&
                string.Equals(
                    filePath,
                    FailNextFinalProtectPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                FailNextFinalProtectPath = null;
                throw AccessFailure();
            }
        }

        public void VerifyProtectedDirectory(string directoryPath)
        {
            if (_fileSystem.Classify(directoryPath) !=
                BridgePathEntryKind.Directory)
            {
                throw AccessFailure();
            }
        }

        public void VerifyProtectedFile(string filePath)
        {
            if (_fileSystem.Classify(filePath) !=
                BridgePathEntryKind.File)
            {
                throw AccessFailure();
            }
        }

        public BridgeFileIdentity GetProtectedFileIdentity(string filePath)
        {
            VerifyProtectedFile(filePath);
            return _fileSystem.GetFileIdentity(filePath);
        }

        public BridgeProtectedFileRead ReadProtectedFile(
            string filePath,
            int maximumBytes)
        {
            if (FailReadsForPath is not null &&
                string.Equals(
                    filePath,
                    FailReadsForPath,
                    StringComparison.OrdinalIgnoreCase) &&
                ++MatchingReadCount > FailReadsAfterSuccessfulCount)
            {
                throw AccessFailure();
            }

            VerifyProtectedFile(filePath);
            return _fileSystem.ReadBoundedFile(filePath, maximumBytes);
        }

        private static BridgeCredentialStoreException AccessFailure() =>
            new(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                "Injected ACL or pinned-read failure.");
    }
}
