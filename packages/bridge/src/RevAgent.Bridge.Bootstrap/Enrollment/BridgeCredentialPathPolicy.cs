namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal static class BridgeCredentialPathPolicy
{
    private static readonly string[] DeviceNamespacePrefixes =
    [
        @"\\?\",
        @"\\.\",
        @"\??\",
        @"\\??\",
    ];

    internal static string NormalizeLocalFileSystemPath(
        string path,
        Func<string, DriveType>? driveTypeResolver = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        RejectDeviceOrUncSyntax(path);
        if (!Path.IsPathFullyQualified(path))
        {
            throw InvalidPath(
                "A bridge credential path must be fully qualified.");
        }

        string fullPath = Path.GetFullPath(path);
        RejectDeviceOrUncSyntax(fullPath);
        RejectAlternateDataStreamSyntax(fullPath);
        RejectMappedDrive(fullPath, driveTypeResolver);
        return fullPath;
    }

    private static void RejectDeviceOrUncSyntax(string path)
    {
        string normalizedSeparators = path.Replace('/', '\\');
        if (DeviceNamespacePrefixes.Any(
                prefix => normalizedSeparators.StartsWith(
                    prefix,
                    StringComparison.OrdinalIgnoreCase)))
        {
            throw InvalidPath(
                "Device-namespace bridge credential paths are forbidden.");
        }

        if (normalizedSeparators.StartsWith(
                @"\\",
                StringComparison.Ordinal))
        {
            throw InvalidPath(
                "UNC bridge credential paths are forbidden.");
        }
    }

    private static void RejectAlternateDataStreamSyntax(string fullPath)
    {
        string? root = Path.GetPathRoot(fullPath);
        if (string.IsNullOrWhiteSpace(root))
        {
            throw InvalidPath(
                "A bridge credential path must have a filesystem root.");
        }

        int allowedVolumeSeparator =
            root.Length >= 2 && root[1] == Path.VolumeSeparatorChar
                ? 1
                : -1;
        for (int index = 0; index < fullPath.Length; index++)
        {
            if (fullPath[index] == Path.VolumeSeparatorChar &&
                index != allowedVolumeSeparator)
            {
                throw InvalidPath(
                    "Alternate-data-stream bridge credential paths are " +
                    "forbidden.");
            }
        }
    }

    private static void RejectMappedDrive(
        string fullPath,
        Func<string, DriveType>? driveTypeResolver)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.GetPathRoot(fullPath) ??
            throw InvalidPath(
                "A bridge credential path must have a filesystem root.");
        try
        {
            DriveType driveType =
                driveTypeResolver?.Invoke(root) ??
                new DriveInfo(root).DriveType;
            if (driveType == DriveType.Network)
            {
                throw InvalidPath(
                    "Mapped-network-drive bridge credential paths are " +
                    "forbidden.");
            }
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is IOException or
                  UnauthorizedAccessException or
                  ArgumentException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.InvalidState,
                "The bridge credential filesystem root could not be " +
                "validated as a local volume.",
                exception);
        }
    }

    private static BridgeCredentialStoreException InvalidPath(
        string message) =>
        new(BridgeCredentialStoreErrorCode.InvalidState, message);
}
