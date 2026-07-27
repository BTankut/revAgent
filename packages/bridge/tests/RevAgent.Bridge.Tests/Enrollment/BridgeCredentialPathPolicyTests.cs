using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeCredentialPathPolicyTests
{
    [Fact]
    public void RelativePath_IsRejectedBeforeNormalization()
    {
        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () =>
                    BridgeCredentialPathPolicy
                        .NormalizeLocalFileSystemPath(
                            Path.Combine(
                                "credentials",
                                "device.dpapi")));

        Assert.Equal(
            BridgeCredentialStoreErrorCode.InvalidState,
            exception.ErrorCode);
    }

    [Theory]
    [InlineData(@"\\server\share\credentials\device.dpapi")]
    [InlineData(@"\\?\C:\ProgramData\revAgent\bridge\credentials\device.dpapi")]
    [InlineData(@"\\.\C:\ProgramData\revAgent\bridge\credentials\device.dpapi")]
    [InlineData(@"\??\C:\ProgramData\revAgent\bridge\credentials\device.dpapi")]
    [InlineData(@"C:\ProgramData\revAgent\bridge\credentials\device.dpapi:token")]
    public void RemoteDeviceAndAlternateStreamSyntax_IsRejected(
        string path)
    {
        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () =>
                    BridgeCredentialPathPolicy
                        .NormalizeLocalFileSystemPath(path));

        Assert.Equal(
            BridgeCredentialStoreErrorCode.InvalidState,
            exception.ErrorCode);
    }

    [Fact]
    public void MappedNetworkDrive_IsRejectedByDriveClassification()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string path = Path.Combine(
            Path.GetTempPath(),
            "revagent",
            "credentials",
            "device.dpapi");

        BridgeCredentialStoreException exception =
            Assert.Throws<BridgeCredentialStoreException>(
                () =>
                    BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(
                        path,
                        _ => DriveType.Network));

        Assert.Equal(
            BridgeCredentialStoreErrorCode.InvalidState,
            exception.ErrorCode);
    }

    [Fact]
    public void ExistingAlternateDataStream_FailsNamedStreamPostcondition()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-ads-tests-{Guid.NewGuid():N}");
        string filePath = Path.Combine(rootPath, "credential.dpapi");
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            File.WriteAllBytes(filePath, [1, 2, 3]);
            File.WriteAllText(filePath + ":hidden", "forbidden");
            var fileSystem = new BridgeCredentialFileSystem();

            Assert.Throws<InvalidDataException>(
                () => fileSystem.Classify(filePath));
        }
        finally
        {
            if (Directory.Exists(rootPath))
            {
                Directory.Delete(rootPath, recursive: true);
            }
        }
    }
}
