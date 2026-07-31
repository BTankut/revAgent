using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

/// <summary>
/// P3-T8 test store: a real on-disk credential store under a unique temp
/// root, with a pass-through access control (no Windows ACLs) and a
/// caller-selected protector — the XOR fake for pure-logic tests or the
/// production machine-scoped DPAPI protector for persistence evidence.
/// </summary>
internal sealed class EnrollmentStoreFixture : IDisposable
{
    private int _seedCalls;

    private EnrollmentStoreFixture(IBridgeCredentialProtector protector)
    {
        RootPath = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-enrollment-tests-{Guid.NewGuid():N}");
        Layout = new BridgeInstallLayout(
            Path.Combine(RootPath, "install"),
            Path.Combine(RootPath, "state"));
        var accessControl = new PassThroughCredentialAccessControl();
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
                // Deterministic identity seed, exactly like the frozen
                // credential-store fixture: each byte is its index, and
                // repeated identity creations stay distinguishable.
                _seedCalls++;
                byte[] seed = Enumerable.Range(0, count)
                    .Select(value => (byte)value)
                    .ToArray();
                seed[0] = checked((byte)(seed[0] + _seedCalls - 1));
                return seed;
            });
    }

    internal string RootPath { get; }

    internal BridgeInstallLayout Layout { get; }

    internal BridgeCredentialReader Reader { get; }

    internal BridgeCredentialMutator Mutator { get; }

    internal static EnrollmentStoreFixture CreateWithXorProtector() =>
        new(new XorEnrollmentProtector());

    internal static EnrollmentStoreFixture CreateWithDpapiProtector() =>
        new(new WindowsLocalMachineCredentialProtector());

    internal void CorruptDeviceCredential() =>
        File.WriteAllBytes(
            Layout.DeviceCredentialPath,
            new byte[] { 0xBA, 0xD0, 0xC0, 0xDE });

    public void Dispose()
    {
        if (Directory.Exists(RootPath))
        {
            Directory.Delete(RootPath, recursive: true);
        }
    }
}

internal sealed class XorEnrollmentProtector : IBridgeCredentialProtector
{
    public byte[] Protect(byte[] plaintext) => Transform(plaintext);

    public byte[] Unprotect(byte[] protectedBytes) =>
        Transform(protectedBytes);

    private static byte[] Transform(byte[] source)
    {
        var result = new byte[source.Length];
        for (int index = 0; index < source.Length; index++)
        {
            result[index] = (byte)(source[index] ^ 0x5A);
        }

        return result;
    }
}

internal sealed class PassThroughCredentialAccessControl :
    IBridgeCredentialAccessControl
{
    private readonly IBridgeCredentialFileSystem _fileSystem =
        new BridgeCredentialFileSystem();

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
    }

    public void VerifyProtectedDirectory(string directoryPath)
    {
        if (_fileSystem.Classify(directoryPath) !=
            BridgePathEntryKind.Directory)
        {
            throw Failure();
        }
    }

    public void VerifyProtectedFile(string filePath)
    {
        if (_fileSystem.Classify(filePath) != BridgePathEntryKind.File)
        {
            throw Failure();
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
        VerifyProtectedFile(filePath);
        return _fileSystem.ReadBoundedFile(filePath, maximumBytes);
    }

    private static BridgeCredentialStoreException Failure() =>
        new(
            BridgeCredentialStoreErrorCode.AccessControlFailure,
            "The enrollment test store path is not in its expected shape.");
}
