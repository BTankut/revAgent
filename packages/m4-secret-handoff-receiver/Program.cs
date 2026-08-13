using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.M4.SecretHandoffReceiver;

internal static class Program
{
    private const string ContractVersion = "revagent.m4-secret-handoff/v1";
    private const string ReceiveAction = "receive_m4_secret_handoff";
    private const string ProbeAction = "probe_m4_secret_handoff_absence";
    private const int SemanticRefusalExitCode = 78;
    private const int CleanupUncertainExitCode = 79;
    private const int MaximumPayloadBytes = 4096;
    private const int MaximumRootCharacters = 4096;
    private const uint InvalidFileAttributes = 0xffffffff;
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private static readonly byte[] FrameMagic =
        Encoding.ASCII.GetBytes("REVAGENT-M4-HANDOFF-V1\n");

    private sealed record Invocation(
        string Kind,
        string Root,
        string ExpectedSelfSha256,
        bool ProbeAbsent);

    private readonly record struct FileIdentity(
        uint VolumeSerialNumber,
        uint FileIndexHigh,
        uint FileIndexLow,
        uint NumberOfLinks,
        uint FileAttributes)
    {
        internal bool SameObject(FileIdentity other) =>
            VolumeSerialNumber == other.VolumeSerialNumber &&
            FileIndexHigh == other.FileIndexHigh &&
            FileIndexLow == other.FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    public static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            return WriteInvocationRefusal("invalid_invocation");
        }

        Invocation? invocation;
        try
        {
            invocation = ParseInvocation(args);
        }
        catch
        {
            return WriteInvocationRefusal("invalid_invocation");
        }

        try
        {
            return Execute(invocation);
        }
        catch
        {
            return WriteRefusal(
                invocation.Kind,
                invocation.ProbeAbsent,
                invocation.ProbeAbsent ? "cleanup_uncertain" : "receive_failed",
                destinationAbsent: false,
                invocation.ProbeAbsent ? CleanupUncertainExitCode : SemanticRefusalExitCode);
        }
    }

    private static Invocation ParseInvocation(IReadOnlyList<string> args)
    {
        if (args.Count is not (8 or 10))
        {
            throw new InvalidOperationException();
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Count; index += 2)
        {
            var name = args[index];
            var value = args[index + 1];
            if (name is not ("--contract" or "--kind" or "--root" or
                    "--expected-self-sha256" or "--probe-absent") ||
                !values.TryAdd(name, value))
            {
                throw new InvalidOperationException();
            }
        }

        if (!values.TryGetValue("--contract", out var contract) ||
            !string.Equals(contract, ContractVersion, StringComparison.Ordinal) ||
            !values.TryGetValue("--kind", out var kind) ||
            kind is not ("north_bearer" or "enrollment_artifact") ||
            !values.TryGetValue("--root", out var root) ||
            !values.TryGetValue("--expected-self-sha256", out var expectedSelfSha256) ||
            expectedSelfSha256.Length != 64 ||
            expectedSelfSha256.Any(static value =>
                !((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))))
        {
            throw new InvalidOperationException();
        }

        var probeAbsent = false;
        if (values.TryGetValue("--probe-absent", out var probe))
        {
            if (!string.Equals(probe, "true", StringComparison.Ordinal))
            {
                throw new InvalidOperationException();
            }
            probeAbsent = true;
        }

        return new Invocation(kind, root, expectedSelfSha256, probeAbsent);
    }

    private static int Execute(Invocation invocation)
    {
        if (!TryValidateSelfHash(invocation.ExpectedSelfSha256))
        {
            return WriteRefusal(
                invocation.Kind,
                invocation.ProbeAbsent,
                invocation.ProbeAbsent ? "cleanup_uncertain" : "receiver_identity_refused",
                destinationAbsent: false,
                invocation.ProbeAbsent ? CleanupUncertainExitCode : SemanticRefusalExitCode);
        }

        if (!TryValidateProtectedRoot(invocation.Root, out var rootIdentity))
        {
            return WriteRefusal(
                invocation.Kind,
                invocation.ProbeAbsent,
                invocation.ProbeAbsent ? "cleanup_uncertain" : "invalid_protected_root",
                destinationAbsent: false,
                invocation.ProbeAbsent ? CleanupUncertainExitCode : SemanticRefusalExitCode);
        }

        var destination = Path.Combine(
            invocation.Root,
            invocation.Kind == "north_bearer" ? "north-bearer.bin" : "enrollment.json");

        if (invocation.ProbeAbsent)
        {
            if (TryProvePathAbsent(destination) &&
                TryValidateProtectedRootUnchanged(invocation.Root, rootIdentity))
            {
                WriteJson(new
                {
                    ok = true,
                    action = ProbeAction,
                    contractVersion = ContractVersion,
                    kind = invocation.Kind,
                    destinationAbsent = true,
                });
                return 0;
            }

            return WriteRefusal(
                invocation.Kind,
                probeAbsent: true,
                "cleanup_uncertain",
                destinationAbsent: false,
                CleanupUncertainExitCode);
        }

        if (invocation.Kind == "north_bearer")
        {
            var absent = TryProvePathAbsent(destination) &&
                TryValidateProtectedRootUnchanged(invocation.Root, rootIdentity);
            if (!absent)
            {
                return WriteRefusal(
                    invocation.Kind,
                    probeAbsent: false,
                    "cleanup_uncertain",
                    destinationAbsent: false,
                    CleanupUncertainExitCode);
            }

            return WriteRefusal(
                invocation.Kind,
                probeAbsent: false,
                "client_secure_store_unavailable",
                destinationAbsent: true,
                SemanticRefusalExitCode);
        }

        if (!TryProvePathAbsent(destination))
        {
            return WriteRefusal(
                invocation.Kind,
                probeAbsent: false,
                "destination_exists",
                destinationAbsent: false,
                SemanticRefusalExitCode);
        }

        FileStream? stream = null;
        FileIdentity? ownedIdentity = null;
        var failureReason = "receive_failed";
        var cleanupUncertain = false;
        var destinationAbsentProof = false;
        var byteCount = 0;
        var retainDestination = false;
        var buffer = new byte[MaximumPayloadBytes];

        try
        {
            var security = CreateNarrowFileSecurity();
            stream = FileSystemAclExtensions.Create(
                new FileInfo(destination),
                FileMode.CreateNew,
                FileSystemRights.WriteData | FileSystemRights.ReadPermissions,
                FileShare.None,
                4096,
                FileOptions.WriteThrough,
                security);
            ownedIdentity = ReadIdentity(stream.SafeFileHandle);
            if (ownedIdentity.Value.NumberOfLinks != 1 ||
                IsReparsePoint(ownedIdentity.Value.FileAttributes))
            {
                failureReason = "destination_identity_refused";
                throw new InvalidOperationException();
            }

            using var input = Console.OpenStandardInput();
            try
            {
                ReadAndValidateMagic(input);
            }
            catch
            {
                failureReason = "invalid_frame";
                throw;
            }
            byte[] lengthBytes;
            try
            {
                lengthBytes = ReadExact(input, 4);
            }
            catch
            {
                failureReason = "invalid_frame";
                throw;
            }
            var declaredLength =
                ((uint)lengthBytes[0] << 24) |
                ((uint)lengthBytes[1] << 16) |
                ((uint)lengthBytes[2] << 8) |
                lengthBytes[3];
            Array.Clear(lengthBytes);
            if (declaredLength is < 1 or > MaximumPayloadBytes)
            {
                failureReason = "invalid_size";
                throw new InvalidOperationException();
            }

            while (byteCount < declaredLength)
            {
                var remaining = checked((int)declaredLength - byteCount);
                var read = input.Read(buffer, 0, Math.Min(buffer.Length, remaining));
                if (read <= 0)
                {
                    failureReason = "invalid_size";
                    throw new InvalidOperationException();
                }
                stream.Write(buffer, 0, read);
                byteCount += read;
                Array.Clear(buffer, 0, read);
            }

            var control = input.ReadByte();
            if (control != 1)
            {
                failureReason = "handoff_aborted";
                throw new InvalidOperationException();
            }
            if (input.ReadByte() != -1)
            {
                failureReason = "invalid_frame";
                throw new InvalidOperationException();
            }

            stream.Flush(flushToDisk: true);
            var beforeClose = ReadIdentity(stream.SafeFileHandle);
            if (!ownedIdentity.Value.SameObject(beforeClose) || beforeClose.NumberOfLinks != 1)
            {
                failureReason = "destination_changed";
                throw new InvalidOperationException();
            }
            stream.Dispose();
            stream = null;

            if (!TryReadPathIdentity(destination, out var afterClose) ||
                !ownedIdentity.Value.SameObject(afterClose) ||
                afterClose.NumberOfLinks != 1 ||
                IsReparsePoint(afterClose.FileAttributes) ||
                !TryValidateNarrowAcl(new FileInfo(destination)) ||
                !TryValidateProtectedRootUnchanged(invocation.Root, rootIdentity))
            {
                failureReason = "destination_changed";
                throw new InvalidOperationException();
            }

            WriteJson(new
            {
                ok = true,
                action = ReceiveAction,
                contractVersion = ContractVersion,
                kind = invocation.Kind,
                bytes = byteCount,
                destinationCreated = true,
                aclProtected = true,
                linkCount = 1,
            });
            retainDestination = true;
            return 0;
        }
        catch
        {
            // Every externally visible reason is selected above or remains the
            // fixed receive_failed sentinel. Exception text is never emitted.
        }
        finally
        {
            Array.Clear(buffer);
            if (stream is not null)
            {
                try
                {
                    stream.Dispose();
                }
                catch
                {
                    cleanupUncertain = true;
                }
            }

            if (ownedIdentity.HasValue && !retainDestination)
            {
                try
                {
                    if (TryProvePathAbsent(destination))
                    {
                        destinationAbsentProof = true;
                    }
                    else if (TryReadPathIdentity(destination, out var current) &&
                        ownedIdentity.Value.SameObject(current) &&
                        current.NumberOfLinks == 1 &&
                        !IsReparsePoint(current.FileAttributes))
                    {
                        File.Delete(destination);
                        destinationAbsentProof = TryProvePathAbsent(destination);
                        cleanupUncertain = !destinationAbsentProof;
                    }
                    else
                    {
                        cleanupUncertain = true;
                    }
                }
                catch
                {
                    cleanupUncertain = true;
                }
            }
        }

        if (cleanupUncertain)
        {
            return WriteRefusal(
                invocation.Kind,
                probeAbsent: false,
                "cleanup_uncertain",
                destinationAbsent: false,
                CleanupUncertainExitCode);
        }

        return WriteRefusal(
            invocation.Kind,
            probeAbsent: false,
            failureReason,
            destinationAbsentProof,
            SemanticRefusalExitCode);
    }

    private static void ReadAndValidateMagic(Stream input)
    {
        var first = ReadExact(input, 3);
        byte[] received;
        if (first.AsSpan().SequenceEqual(new byte[] { 0xef, 0xbb, 0xbf }))
        {
            received = ReadExact(input, FrameMagic.Length);
        }
        else
        {
            received = new byte[FrameMagic.Length];
            first.CopyTo(received, 0);
            var remaining = ReadExact(input, FrameMagic.Length - first.Length);
            remaining.CopyTo(received, first.Length);
            Array.Clear(remaining);
        }
        Array.Clear(first);

        var matches = received.AsSpan().SequenceEqual(FrameMagic);
        Array.Clear(received);
        if (!matches)
        {
            throw new InvalidDataException();
        }
    }

    private static byte[] ReadExact(Stream input, int length)
    {
        var result = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = input.Read(result, offset, length - offset);
            if (read <= 0)
            {
                Array.Clear(result);
                throw new EndOfStreamException();
            }
            offset += read;
        }
        return result;
    }

    private static bool TryValidateProtectedRoot(string root, out FileIdentity identity)
    {
        identity = default;
        try
        {
            if (string.IsNullOrWhiteSpace(root) ||
                root.Length > MaximumRootCharacters ||
                root.IndexOf('\0') >= 0 ||
                !Path.IsPathFullyQualified(root))
            {
                return false;
            }

            var canonical = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            var supplied = root.TrimEnd(Path.DirectorySeparatorChar);
            if (!string.Equals(canonical, supplied, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(canonical, Path.GetPathRoot(canonical)?.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
                !Directory.Exists(canonical))
            {
                return false;
            }

            for (DirectoryInfo? cursor = new(canonical); cursor is not null; cursor = cursor.Parent)
            {
                if ((cursor.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    return false;
                }
            }

            if (!TryReadPathIdentity(canonical, out identity) ||
                IsReparsePoint(identity.FileAttributes) ||
                !TryValidateNarrowAcl(new DirectoryInfo(canonical)))
            {
                return false;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryValidateProtectedRootUnchanged(string root, FileIdentity initial) =>
        TryValidateProtectedRoot(root, out var current) && initial.SameObject(current);

    private static FileSecurity CreateNarrowFileSecurity()
    {
        var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException();
        var security = new FileSecurity();
        security.SetOwner(current);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in AllowedSids(current))
        {
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
        }
        return security;
    }

    private static bool TryValidateNarrowAcl(FileSystemInfo value)
    {
        try
        {
            FileSystemSecurity security = value switch
            {
                DirectoryInfo directory => FileSystemAclExtensions.GetAccessControl(directory),
                FileInfo file => FileSystemAclExtensions.GetAccessControl(file),
                _ => throw new InvalidOperationException(),
            };
            if (!security.AreAccessRulesProtected)
            {
                return false;
            }

            var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException();
            if (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner ||
                !owner.Equals(current))
            {
                return false;
            }

            var allowed = AllowedSids(current)
                .Select(static sid => sid.Value)
                .ToHashSet(StringComparer.Ordinal);
            var currentCanWrite = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                typeof(SecurityIdentifier)))
            {
                if (rule.IsInherited ||
                    rule.AccessControlType != AccessControlType.Allow ||
                    rule.IdentityReference is not SecurityIdentifier sid ||
                    !allowed.Contains(sid.Value))
                {
                    return false;
                }
                if (sid.Equals(current) &&
                    (rule.FileSystemRights & (FileSystemRights.WriteData | FileSystemRights.CreateFiles)) != 0)
                {
                    currentCanWrite = true;
                }
            }
            return currentCanWrite;
        }
        catch
        {
            return false;
        }
    }

    private static SecurityIdentifier[] AllowedSids(SecurityIdentifier current) =>
    [
        current,
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
    ];

    private static bool TryReadPathIdentity(string path, out FileIdentity identity)
    {
        identity = default;
        using var handle = CreateFileW(
            path,
            FileReadAttributes | ReadControl,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            return false;
        }
        identity = ReadIdentity(handle);
        return true;
    }

    private static FileIdentity ReadIdentity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var information))
        {
            throw new InvalidOperationException();
        }
        return new FileIdentity(
            information.VolumeSerialNumber,
            information.FileIndexHigh,
            information.FileIndexLow,
            information.NumberOfLinks,
            information.FileAttributes);
    }

    private static bool TryProvePathAbsent(string path)
    {
        var attributes = GetFileAttributesW(path);
        if (attributes != InvalidFileAttributes)
        {
            return false;
        }
        var error = Marshal.GetLastPInvokeError();
        return error is 2 or 3;
    }

    private static bool IsReparsePoint(uint attributes) =>
        (attributes & (uint)FileAttributes.ReparsePoint) != 0;

    private static bool TryValidateSelfHash(string expected)
    {
        try
        {
            var processPath = Environment.ProcessPath;
            if (string.IsNullOrEmpty(processPath) ||
                !Path.IsPathFullyQualified(processPath) ||
                !TryReadPathIdentity(processPath, out var before) ||
                before.NumberOfLinks != 1 ||
                IsReparsePoint(before.FileAttributes))
            {
                return false;
            }

            using var stream = new FileStream(
                processPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                81920,
                FileOptions.SequentialScan);
            var opened = ReadIdentity(stream.SafeFileHandle);
            if (!before.SameObject(opened) || opened.NumberOfLinks != 1)
            {
                return false;
            }
            using var algorithm = SHA256.Create();
            var digest = algorithm.ComputeHash(stream);
            var actual = Convert.ToHexString(digest).ToLowerInvariant();
            CryptographicOperations.ZeroMemory(digest);
            var after = ReadIdentity(stream.SafeFileHandle);
            return before.SameObject(after) &&
                after.NumberOfLinks == 1 &&
                string.Equals(actual, expected, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static int WriteInvocationRefusal(string reason)
    {
        WriteJson(new
        {
            ok = false,
            action = ReceiveAction,
            contractVersion = ContractVersion,
            kind = "invalid",
            code = "m4_secret_handoff_refused",
            reason,
            destinationAbsent = false,
        });
        return SemanticRefusalExitCode;
    }

    private static int WriteRefusal(
        string kind,
        bool probeAbsent,
        string reason,
        bool destinationAbsent,
        int exitCode)
    {
        WriteJson(new
        {
            ok = false,
            action = probeAbsent ? ProbeAction : ReceiveAction,
            contractVersion = ContractVersion,
            kind,
            code = exitCode == CleanupUncertainExitCode
                ? "cleanup_uncertain"
                : "m4_secret_handoff_refused",
            reason,
            destinationAbsent,
        });
        return exitCode;
    }

    private static void WriteJson<T>(T value)
    {
        Console.Out.Write(JsonSerializer.Serialize(value));
        Console.Out.Write('\n');
        Console.Out.Flush();
    }
}
