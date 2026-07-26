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
        Assert.False(File.Exists(fixture.Layout.MachineFingerprintPath));
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
    public void ExistingStateWithoutLock_RuntimeReadsWithoutRepairingLock()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        File.Delete(fixture.Layout.EnrollmentLockPath);

        BridgeRuntimeCredentialState state =
            Assert.IsType<BridgeRuntimeCredentialState>(
                fixture.Reader.Load());

        Assert.Equal(identity.MachineFingerprint, state.MachineFingerprint);
        Assert.False(File.Exists(fixture.Layout.EnrollmentLockPath));
    }

    [Fact]
    public void LockAclFailure_CleansBootstrapResidueAndAllowsRetry()
    {
        using var fixture = CredentialFixture.Create();
        fixture.AccessControl.FailNextFinalProtectPath =
            fixture.Layout.EnrollmentLockPath;
        fixture.AccessControl.FailNextProtectLeavesUnprotected = true;

        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Mutator.GetOrCreateMachineIdentity());

        Assert.False(File.Exists(fixture.Layout.EnrollmentLockPath));
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();

        Assert.True(File.Exists(fixture.Layout.EnrollmentLockPath));
        Assert.True(File.Exists(fixture.Layout.MachineIdentityPath));
    }

    [Fact]
    public void ExistingUnprotectedLock_IsRepairedUnderProtectedParent()
    {
        using var fixture = CredentialFixture.Create();
        _ = Directory.CreateDirectory(fixture.Layout.CredentialDirectory);
        File.WriteAllBytes(fixture.Layout.EnrollmentLockPath, []);
        fixture.AccessControl.MarkUnprotected(
            fixture.Layout.EnrollmentLockPath);

        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();

        fixture.AccessControl.VerifyProtectedFile(
            fixture.Layout.EnrollmentLockPath);
        Assert.True(File.Exists(fixture.Layout.MachineIdentityPath));
    }

    [Fact]
    public void ExistingUnprotectedCredentialDirectory_IsRepairedByMutator()
    {
        using var fixture = CredentialFixture.Create();
        _ = Directory.CreateDirectory(fixture.Layout.CredentialDirectory);
        fixture.AccessControl.MarkDirectoryUnprotected(
            fixture.Layout.CredentialDirectory);

        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();

        fixture.AccessControl.VerifyProtectedDirectory(
            fixture.Layout.CredentialDirectory);
        Assert.True(File.Exists(fixture.Layout.MachineIdentityPath));
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
        Assert.True(File.Exists(fixture.Layout.MachineFingerprintPath));
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
    }

    [Fact]
    public void MissingFingerprintMetadata_IsRepairedOnlyByBootstrapMutator()
    {
        using var fixture = CredentialFixture.Create();
        string expectedFingerprint;
        using (BridgeMachineIdentity identity =
               fixture.Mutator.GetOrCreateMachineIdentity())
        {
            expectedFingerprint = identity.MachineFingerprint;
        }

        File.Delete(fixture.Layout.MachineFingerprintPath);

        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Reader.Load());
        Assert.False(File.Exists(fixture.Layout.MachineFingerprintPath));

        using BridgeMachineIdentity repaired =
            fixture.Mutator.GetOrCreateMachineIdentity();

        Assert.Equal(expectedFingerprint, repaired.MachineFingerprint);
        Assert.True(File.Exists(fixture.Layout.MachineFingerprintPath));
        Assert.Equal(
            expectedFingerprint,
            fixture.Reader.Load()!.MachineFingerprint);
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
    public void RuntimeReader_DoesNotUseEnrollmentLockOrMutationCapability()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        File.Delete(fixture.Layout.EnrollmentLockPath);
        fixture.AccessControl.ResetMutationCounts();

        BridgeRuntimeCredentialState state = fixture.Reader.Load()!;

        Assert.True(state.IsEnrolled);
        Assert.Equal(0, fixture.AccessControl.EnsureProtectedDirectoryCalls);
        Assert.Equal(0, fixture.AccessControl.ProtectFileCalls);
        Assert.False(File.Exists(fixture.Layout.EnrollmentLockPath));
        Assert.DoesNotContain(
            typeof(BridgeCredentialReader)
                .GetFields(
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.NonPublic),
            field => field.FieldType == typeof(IBridgeEnrollmentLock));
    }

    [Fact]
    public void RuntimeReader_DoesNotDecodeOrMaterializeIdentitySeed()
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
            int valueStart = json.IndexOf(
                "\"fingerprint_seed\":\"",
                StringComparison.Ordinal);
            Assert.True(valueStart >= 0);
            valueStart += "\"fingerprint_seed\":\"".Length;
            string invalidSeed = new('!', 44);
            string modified =
                json[..valueStart] +
                invalidSeed +
                json[(valueStart + 44)..];
            byte[] modifiedPlaintext = Encoding.UTF8.GetBytes(modified);
            try
            {
                File.WriteAllBytes(
                    fixture.Layout.MachineIdentityPath,
                    XorCredentialProtector.Transform(modifiedPlaintext));
            }
            finally
            {
                CryptographicOperations.ZeroMemory(modifiedPlaintext);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
            CryptographicOperations.ZeroMemory(plaintext);
        }

        fixture.Protector.ResetCounts();
        BridgeRuntimeCredentialState state = fixture.Reader.Load()!;
        Assert.Equal(0, fixture.Protector.UnprotectCalls);
        BridgeCredentialStoreException mutationException =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.GetOrCreateMachineIdentity());

        Assert.Equal(identity.MachineFingerprint, state.MachineFingerprint);
        Assert.Equal(
            BridgeCredentialStoreErrorCode.ReadFailure,
            mutationException.ErrorCode);
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
    public void FreshTargetIndeterminate_PersistsIntentAcrossRestart()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        fixture.AccessControl.FailReadsForPath =
            fixture.Layout.DeviceCredentialPath;
        fixture.AccessControl.FailReadsAfterSuccessfulCount = 0;

        BridgeCredentialStoreException indeterminate =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(FirstDeviceToken, "device-42")));
        string intentPath =
            fixture.Layout.DeviceCredentialPath +
            ".revagent-write.intent";

        Assert.Equal(
            BridgeAtomicWriteOutcome.Indeterminate,
            indeterminate.AtomicWriteOutcome);
        Assert.True(File.Exists(intentPath));
        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Reader.Load());

        fixture.AccessControl.FailReadsForPath = null;
        var restartedMutator = new BridgeCredentialMutator(
            fixture.Layout,
            fixture.Protector,
            fixture.AccessControl,
            randomBytes: RandomNumberGenerator.GetBytes);
        BridgeCredentialStoreException recovered =
            Assert.Throws<BridgeCredentialStoreException>(
                () => restartedMutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recovered.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            recovered.RecoveredPriorWriteOutcome);
        Assert.False(File.Exists(intentPath));
        Assert.Equal(
            FirstDeviceToken,
            fixture.Reader.Load()!.DeviceCredential!.DeviceToken.Reveal());
    }

    [Fact]
    public void PreflightFailure_IsExplicitlyNotCommitted()
    {
        using var fixture = CredentialFixture.Create();
        var writer = new AtomicCredentialFileWriter(fixture.AccessControl);
        fixture.AccessControl.FailNextClassifyPath =
            fixture.Layout.CredentialDirectory;

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => writer.Write(
                    fixture.Layout.DeviceCredentialPath,
                    [1, 2, 3]));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            exception.AtomicWriteOutcome);
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
    }

    [Fact]
    public void InvalidAtomicPayload_IsExplicitlyNotCommitted()
    {
        using var fixture = CredentialFixture.Create();
        var writer = new AtomicCredentialFileWriter(fixture.AccessControl);

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => writer.Write(
                    fixture.Layout.DeviceCredentialPath,
                    []));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            exception.AtomicWriteOutcome);
    }

    [Fact]
    public void ExistingTargetIdentityProbeFailure_IsNotCommitted()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        byte[] before =
            File.ReadAllBytes(fixture.Layout.MachineIdentityPath);
        fixture.AccessControl.FailReadsForPath =
            fixture.Layout.MachineIdentityPath;
        fixture.AccessControl.FailReadsAfterSuccessfulCount = 0;
        var writer = new AtomicCredentialFileWriter(fixture.AccessControl);

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => writer.Write(
                    fixture.Layout.MachineIdentityPath,
                    [9, 8, 7]));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            exception.AtomicWriteOutcome);
        Assert.Equal(
            before,
            File.ReadAllBytes(fixture.Layout.MachineIdentityPath));
    }

    [Fact]
    public void CommittedBackupCleanupFailure_IsSurfacedAndRecoverable()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        string backupPath =
            fixture.Layout.DeviceCredentialPath +
            ".revagent-write.bak";
        fixture.AccessControl.FailNextVerifyProtectedPath = backupPath;

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));

        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            exception.AtomicWriteOutcome);
        Assert.True(File.Exists(backupPath));
        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Reader.Load());

        BridgeCredentialStoreException recoveredCommit =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));
        BridgeAtomicWriteResult retry =
            fixture.Mutator.SaveDeviceCredential(
                identity.MachineFingerprint,
                NewCredential(RotatedDeviceToken, "device-42"));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveredCommit.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            recoveredCommit.RecoveredPriorWriteOutcome);
        Assert.Equal(BridgeAtomicWriteOutcome.Committed, retry.Outcome);
        Assert.False(File.Exists(backupPath));
        Assert.Equal(
            RotatedDeviceToken,
            fixture.Reader.Load()!.DeviceCredential!.DeviceToken.Reveal());
    }

    [Fact]
    public void RepeatedPriorCleanupFailure_DoesNotBecomeCurrentCommitOutcome()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            NewCredential(FirstDeviceToken, "device-42"));
        string backupPath =
            fixture.Layout.DeviceCredentialPath +
            ".revagent-write.bak";
        fixture.AccessControl.FailNextVerifyProtectedPath = backupPath;
        BridgeCredentialStoreException committed =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));
        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            committed.AtomicWriteOutcome);

        fixture.AccessControl.FailNextVerifyProtectedPath = backupPath;
        BridgeCredentialStoreException recoveryFailure =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveryFailure.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            recoveryFailure.RecoveredPriorWriteOutcome);
        Assert.True(File.Exists(backupPath));

        BridgeCredentialStoreException recovered =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.SaveDeviceCredential(
                    identity.MachineFingerprint,
                    NewCredential(RotatedDeviceToken, "device-42")));
        using BridgeRuntimeCredentialState state = fixture.Reader.Load()!;

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recovered.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.Committed,
            recovered.RecoveredPriorWriteOutcome);
        Assert.False(File.Exists(backupPath));
        Assert.Equal(
            RotatedDeviceToken,
            state.DeviceCredential!.DeviceToken.Reveal());
    }

    [Fact]
    public void RuntimeReader_RejectsResidueWithoutCleaningIt()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        string temporaryPath =
            fixture.Layout.MachineIdentityPath +
            ".revagent-write.tmp";
        File.Copy(fixture.Layout.MachineIdentityPath, temporaryPath);
        fixture.AccessControl.MarkUnprotected(temporaryPath);
        fixture.AccessControl.ResetMutationCounts();

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Reader.Load());

        Assert.Equal(
            BridgeCredentialStoreErrorCode.InvalidState,
            exception.ErrorCode);
        Assert.True(File.Exists(temporaryPath));
        Assert.Equal(0, fixture.AccessControl.ProtectFileCalls);

        BridgeCredentialStoreException recoveredResidue =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.GetOrCreateMachineIdentity());
        using BridgeMachineIdentity recovered =
            fixture.Mutator.GetOrCreateMachineIdentity();

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveredResidue.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveredResidue.RecoveredPriorWriteOutcome);
        Assert.Equal(
            identity.MachineFingerprint,
            recovered.MachineFingerprint);
        Assert.False(File.Exists(temporaryPath));
    }

    [Fact]
    public void BootstrapMutator_RestoresMissingTargetFromBackupResidue()
    {
        using var fixture = CredentialFixture.Create();
        string expectedFingerprint;
        using (BridgeMachineIdentity identity =
               fixture.Mutator.GetOrCreateMachineIdentity())
        {
            expectedFingerprint = identity.MachineFingerprint;
        }

        string backupPath =
            fixture.Layout.MachineIdentityPath +
            ".revagent-write.bak";
        File.Move(fixture.Layout.MachineIdentityPath, backupPath);

        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Reader.Load());

        BridgeCredentialStoreException recoveredResidue =
            Assert.Throws<BridgeCredentialStoreException>(
                () => fixture.Mutator.GetOrCreateMachineIdentity());
        using BridgeMachineIdentity recovered =
            fixture.Mutator.GetOrCreateMachineIdentity();

        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveredResidue.AtomicWriteOutcome);
        Assert.Equal(
            BridgeAtomicWriteOutcome.NotCommitted,
            recoveredResidue.RecoveredPriorWriteOutcome);
        Assert.Equal(
            expectedFingerprint,
            recovered.MachineFingerprint);
        Assert.True(File.Exists(fixture.Layout.MachineIdentityPath));
        Assert.False(File.Exists(backupPath));
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
                "machine-fingerprint.json.quarantine-*"));
        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
    }

    [Fact]
    public void DuplicateFingerprintMetadataProperty_IsRejected()
    {
        using var fixture = CredentialFixture.Create();
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        byte[] metadata =
            File.ReadAllBytes(fixture.Layout.MachineFingerprintPath);
        try
        {
            string json = Encoding.UTF8.GetString(metadata);
            string duplicated = json.Replace(
                "\"schema_version\":1",
                "\"schema_version\":1,\"schema_version\":1",
                StringComparison.Ordinal);
            byte[] duplicateMetadata = Encoding.UTF8.GetBytes(duplicated);
            try
            {
                File.WriteAllBytes(
                    fixture.Layout.MachineFingerprintPath,
                    duplicateMetadata);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(duplicateMetadata);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(metadata);
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
            Protector = new XorCredentialProtector();
            Reader = new BridgeCredentialReader(
                Layout,
                Protector,
                accessControl);
            Mutator = new BridgeCredentialMutator(
                Layout,
                Protector,
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

        internal XorCredentialProtector Protector { get; }

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
        internal int ProtectCalls { get; private set; }

        internal int UnprotectCalls { get; private set; }

        public byte[] Protect(byte[] plaintext)
        {
            ProtectCalls++;
            return Transform(plaintext);
        }

        public byte[] Unprotect(byte[] protectedBytes)
        {
            UnprotectCalls++;
            return Transform(protectedBytes);
        }

        internal void ResetCounts()
        {
            ProtectCalls = 0;
            UnprotectCalls = 0;
        }

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
        private readonly HashSet<string> _unprotectedPaths =
            new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _unprotectedDirectories =
            new(StringComparer.OrdinalIgnoreCase);

        internal bool FailNextTemporaryProtect { get; set; }

        internal string? FailNextFinalProtectPath { get; set; }

        internal bool FailNextProtectLeavesUnprotected { get; set; }

        internal string? FailReadsForPath { get; set; }

        internal int FailReadsAfterSuccessfulCount { get; set; }

        internal string? FailNextClassifyPath { get; set; }

        internal string? FailNextVerifyProtectedPath { get; set; }

        internal int EnsureProtectedDirectoryCalls { get; private set; }

        internal int ProtectFileCalls { get; private set; }

        private int MatchingReadCount { get; set; }

        public void EnsureProtectedDirectory(string directoryPath)
        {
            EnsureProtectedDirectoryCalls++;
            _ = Directory.CreateDirectory(directoryPath);
            _ = _unprotectedDirectories.Remove(directoryPath);
        }

        public BridgePathEntryKind ClassifyPath(string path)
        {
            if (FailNextClassifyPath is not null &&
                string.Equals(
                    path,
                    FailNextClassifyPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                FailNextClassifyPath = null;
                throw AccessFailure();
            }

            return _fileSystem.Classify(path);
        }

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
            ProtectFileCalls++;
            if (FailNextTemporaryProtect &&
                filePath.EndsWith(".tmp", StringComparison.Ordinal))
            {
                FailNextTemporaryProtect = false;
                _ = _unprotectedPaths.Add(filePath);
                throw AccessFailure();
            }

            if (FailNextFinalProtectPath is not null &&
                string.Equals(
                    filePath,
                    FailNextFinalProtectPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                FailNextFinalProtectPath = null;
                if (FailNextProtectLeavesUnprotected)
                {
                    FailNextProtectLeavesUnprotected = false;
                    _ = _unprotectedPaths.Add(filePath);
                }

                throw AccessFailure();
            }

            _ = _unprotectedPaths.Remove(filePath);
        }

        public void VerifyProtectedDirectory(string directoryPath)
        {
            if (_unprotectedDirectories.Contains(directoryPath))
            {
                throw AccessFailure();
            }

            if (_fileSystem.Classify(directoryPath) !=
                BridgePathEntryKind.Directory)
            {
                throw AccessFailure();
            }
        }

        public void VerifyProtectedFile(string filePath)
        {
            if (FailNextVerifyProtectedPath is not null &&
                string.Equals(
                    filePath,
                    FailNextVerifyProtectedPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                FailNextVerifyProtectedPath = null;
                throw AccessFailure();
            }

            if (_unprotectedPaths.Contains(filePath))
            {
                throw AccessFailure();
            }

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

        internal void ResetMutationCounts()
        {
            EnsureProtectedDirectoryCalls = 0;
            ProtectFileCalls = 0;
        }

        internal void MarkUnprotected(string path) =>
            _ = _unprotectedPaths.Add(path);

        internal void MarkDirectoryUnprotected(string path) =>
            _ = _unprotectedDirectories.Add(path);
    }
}
