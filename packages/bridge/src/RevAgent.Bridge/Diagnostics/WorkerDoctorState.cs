using System.Runtime.Versioning;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Diagnostics;

internal sealed class WorkerDoctorStateException() : Exception("diagnostic_state_invalid");

// Only explicit CLI composition uses this seam. No environment/configuration
// option can select an alternate credential root for the production worker.
internal sealed record WorkerDoctorDependencies(
    Func<IBridgeCredentialReader> CreateCanonicalReader,
    Func<WorkerCommand, WorkerDoctorState> OpenIsolatedState,
    Func<WorkerDoctorState, IBridgeCredentialReader> CreateIsolatedReader,
    Func<string, ResolvedBridgeConfiguration> LoadConfiguration,
    Func<ResolvedBridgeConfiguration, Task<BridgeDoctorReport>> RunProbes,
    Func<ResolvedBridgeConfiguration, Task<BridgeDoctorEnrollmentReport>> ReEnroll);

internal sealed record WorkerDoctorStateEnvironment(
    string TempRoot,
    string InstallRoot,
    IReadOnlyList<string> ForbiddenRoots)
{
    internal static WorkerDoctorStateEnvironment Production() => new(
        Path.TrimEndingDirectorySeparator(Path.GetTempPath()),
        AppContext.BaseDirectory,
        // Strings only: never open, enumerate or inspect these directories.
        [BridgeInstallLayout.Canonical.InstallRoot, BridgeInstallLayout.Canonical.StateRoot]);
}

/// <summary>
/// A read-only lease on a gate-owned EMPTY fixture. Existing no-follow pins
/// keep its ancestors/configuration stable. This is not a credential store
/// override: observed state, read attempts and all protection/mutation fail.
/// Production ACL/DPAPI policies are not changed or instantiated here.
/// </summary>
internal sealed class WorkerDoctorState : IDisposable
{
    private const string FixturePrefix = "revagent-bridge-service-";
    private readonly List<IDisposable> _pins = [];
    private readonly IBridgeCredentialFileSystem _fileSystem;
    private readonly BridgeInstallLayout _layout;
    private bool _disposed;

    private WorkerDoctorState(BridgeInstallLayout layout, IBridgeCredentialFileSystem fileSystem)
    {
        _layout = layout;
        _fileSystem = fileSystem;
    }

    internal DiagnosticProtector Protector { get; } = new();

    internal static string ValidateArgument(string path, Func<string, DriveType>? driveTypeResolver = null,
        Func<string, string>? volumeMappingResolver = null)
    {
        try
        {
            // Reject aliases before the shared local-volume check performs IO.
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) ||
                path.Contains('/') || path.Contains('~') || path.Contains('"') ||
                path.Any(char.IsControl))
            {
                throw new WorkerCommandLineException("diagnostic_state_path_invalid");
            }

            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full)!;
            if (!string.Equals(path, full, StringComparison.OrdinalIgnoreCase) ||
                path.Length <= root.Length || Path.EndsInDirectorySeparator(path))
            {
                throw new WorkerCommandLineException("diagnostic_state_path_invalid");
            }

            foreach (string part in path[root.Length..].Split(Path.DirectorySeparatorChar))
            {
                string deviceName = part.Split('.')[0];
                if (part.Length == 0 || part.EndsWith('.') || part.EndsWith(' ') ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                    deviceName.Equals("CON", StringComparison.OrdinalIgnoreCase) ||
                    deviceName.Equals("PRN", StringComparison.OrdinalIgnoreCase) ||
                    deviceName.Equals("AUX", StringComparison.OrdinalIgnoreCase) ||
                    deviceName.Equals("NUL", StringComparison.OrdinalIgnoreCase) ||
                    ((deviceName.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
                      deviceName.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) &&
                     deviceName.Length == 4 && char.IsAsciiDigit(deviceName[3])))
                {
                    throw new WorkerCommandLineException("diagnostic_state_path_invalid");
                }
            }

            string normalized = BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(path, driveTypeResolver);
            if (OperatingSystem.IsWindows())
            {
                string target = volumeMappingResolver?.Invoke(root[..2]) ?? ReadVolumeMapping(root[..2]);
                const string localVolume = @"\Device\HarddiskVolume";
                // SUBST roots look local to DriveInfo but are DOS-device aliases.
                // Refuse aliases instead of resolving into an alternate state tree.
                if (!target.StartsWith(localVolume, StringComparison.OrdinalIgnoreCase) ||
                    target.Length == localVolume.Length ||
                    target[localVolume.Length..].Any(c => !char.IsAsciiDigit(c)))
                {
                    throw new WorkerCommandLineException("diagnostic_state_path_invalid");
                }
            }
            return normalized;
        }
        catch
        {
            throw new WorkerCommandLineException("diagnostic_state_path_invalid");
        }
    }

    private static string ReadVolumeMapping(string drive)
    {
        var target = new StringBuilder(1024);
        if (QueryDosDevice(drive, target, target.Capacity) == 0)
        {
            throw new WorkerCommandLineException("diagnostic_state_path_invalid");
        }
        return target.ToString();
    }

    internal static void ValidateCommand(WorkerCommand command)
    {
        if (command.Kind != WorkerCommandKind.Doctor || command.ReEnroll ||
            command.ControlPipeName is not null || command.ExpectedHostProcessId is not null ||
            command.InstanceId is not null || command.EnrollmentArtifactPath is not null ||
            command.ConfigurationPath is null || command.DiagnosticStateRoot is null)
        {
            throw new WorkerCommandLineException("diagnostic_state_command_invalid");
        }
        _ = ValidateArgument(command.ConfigurationPath);
        _ = ValidateArgument(command.DiagnosticStateRoot);
    }

    internal static WorkerDoctorState Open(WorkerCommand command,
        WorkerDoctorStateEnvironment? environment = null,
        IBridgeCredentialFileSystem? fileSystem = null)
    {
        ValidateCommand(command);
        WorkerDoctorState? lease = null;
        try
        {
            if (!OperatingSystem.IsWindows()) { throw new WorkerDoctorStateException(); }
            environment ??= WorkerDoctorStateEnvironment.Production();
            string temp = ValidateArgument(environment.TempRoot);
            string config = command.ConfigurationPath!;
            string state = command.DiagnosticStateRoot!;
            string parent = Path.GetDirectoryName(config)!;
            string leaf = Path.GetFileName(parent);
            if (!string.Equals(Path.GetDirectoryName(parent), temp, StringComparison.OrdinalIgnoreCase) ||
                !leaf.StartsWith(FixturePrefix, StringComparison.Ordinal) ||
                leaf.Length != FixturePrefix.Length + 32 ||
                leaf[FixturePrefix.Length..].Any(c => !(c is >= '0' and <= '9' or >= 'a' and <= 'f')) ||
                !string.Equals(Path.GetFileName(config), "bridge-config.json", StringComparison.Ordinal) ||
                !string.Equals(state, Path.Combine(parent, "doctor-state"), StringComparison.Ordinal) ||
                string.Equals(parent, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), StringComparison.OrdinalIgnoreCase) ||
                string.Equals(parent, Environment.CurrentDirectory, StringComparison.OrdinalIgnoreCase))
            {
                throw new WorkerDoctorStateException();
            }

            foreach (string forbidden in environment.ForbiddenRoots)
            {
                string normalized = Path.TrimEndingDirectorySeparator(Path.GetFullPath(forbidden));
                if (string.Equals(temp, normalized, StringComparison.OrdinalIgnoreCase) ||
                    temp.StartsWith(normalized + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                    Overlaps(parent, normalized))
                {
                    throw new WorkerDoctorStateException();
                }
            }

            lease = new WorkerDoctorState(new BridgeInstallLayout(environment.InstallRoot, state),
                fileSystem ?? new BridgeCredentialFileSystem());
            lease._pins.Add(lease._fileSystem.PinDirectory(temp));
            lease._pins.Add(lease._fileSystem.PinDirectory(parent));
            IBridgeFilePin configPin = lease._fileSystem.PinFile(config);
            lease._pins.Add(configPin);
            // Metadata-only handles do not deny data writes/renames on Windows.
            // Hold a no-follow data-read handle, but never read through it. The
            // identity check binds the subsequent configuration load to the
            // already verified regular single-link file, without a path race.
            SafeFileHandle configDataPin = OpenConfigurationPin(config, 0x80000000,
                0x00000001, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            lease._pins.Add(configDataPin);
            if (configDataPin.IsInvalid || lease._fileSystem.GetFileIdentity(config) != configPin.Identity)
            {
                throw new WorkerDoctorStateException();
            }
            lease._pins.Add(lease._fileSystem.PinDirectory(state));
            lease._pins.Add(lease._fileSystem.PinDirectory(lease._layout.CredentialDirectory));
            VerifyOwnedPath(parent, directory: true);
            VerifyOwnedPath(config, directory: false);
            VerifyOwnedPath(state, directory: true);
            VerifyOwnedPath(lease._layout.CredentialDirectory, directory: true);
            lease.VerifyEmpty();
            return lease;
        }
        catch
        {
            lease?.Dispose();
            throw new WorkerDoctorStateException();
        }
    }

    private static bool Overlaps(string left, string right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase) ||
        left.StartsWith(right + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
        right.StartsWith(left + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    [SupportedOSPlatform("windows")]
    private static void VerifyOwnedPath(string path, bool directory)
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        FileSystemSecurity security = directory
            ? new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)
            : new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        VerifyOwnership(security, identity.User!, identity.Owner!);
    }

    [SupportedOSPlatform("windows")]
    internal static void VerifyOwnership(FileSystemSecurity security, SecurityIdentifier user, SecurityIdentifier tokenOwner)
    {
        var owner = security.GetOwner(typeof(SecurityIdentifier));
        var raw = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if ((!user.Equals(owner) && !tokenOwner.Equals(owner)) || raw.DiscretionaryAcl is null)
        {
            throw new WorkerDoctorStateException();
        }

        const FileSystemRights mutation = FileSystemRights.Write | FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions |
            FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & mutation) != 0 &&
                !sid.Equals(user) && !sid.Equals(tokenOwner) &&
                !sid.IsWellKnown(WellKnownSidType.LocalSystemSid) &&
                !sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid))
            {
                throw new WorkerDoctorStateException();
            }
        }
    }

    internal void VerifyEmpty()
    {
        try
        {
            if (_disposed) { throw new WorkerDoctorStateException(); }
            string[] entries = Directory.EnumerateFileSystemEntries(_layout.StateRoot).Take(2).ToArray();
            if (entries.Length != 1 ||
                !string.Equals(entries[0], _layout.CredentialDirectory, StringComparison.Ordinal) ||
                Directory.EnumerateFileSystemEntries(_layout.CredentialDirectory).Any() ||
                Protector.ProtectCalls != 0 || Protector.UnprotectCalls != 0)
            {
                throw new WorkerDoctorStateException();
            }
        }
        catch { throw new WorkerDoctorStateException(); }
    }

    internal IBridgeCredentialReader CreateReader()
    {
        VerifyEmpty();
        return new BridgeCredentialReader(_layout, Protector, new EmptyFixtureAccessControl(this));
    }

    public void Dispose()
    {
        _disposed = true;
        for (int index = _pins.Count - 1; index >= 0; index--) { _pins[index].Dispose(); }
        _pins.Clear();
    }

    internal sealed class DiagnosticProtector : IBridgeCredentialProtector
    {
        internal int ProtectCalls { get; private set; }
        internal int UnprotectCalls { get; private set; }
        public byte[] Protect(byte[] plaintext) { ProtectCalls++; throw new WorkerDoctorStateException(); }
        public byte[] Unprotect(byte[] protectedBytes) { UnprotectCalls++; throw new WorkerDoctorStateException(); }
    }

    // Real filesystem checks, narrowly limited to this EMPTY, pinned fixture.
    // Nothing is writable and unexpected state never becomes a benign null.
    private sealed class EmptyFixtureAccessControl(WorkerDoctorState lease) : IBridgeCredentialAccessControl
    {
        public BridgePathEntryKind ClassifyPath(string path)
        {
            lease.VerifyEmpty();
            if (!string.Equals(Path.GetDirectoryName(path), lease._layout.CredentialDirectory, StringComparison.Ordinal))
            {
                throw new WorkerDoctorStateException();
            }
            BridgePathEntryKind kind = lease._fileSystem.Classify(path);
            if (kind != BridgePathEntryKind.Missing) { throw new WorkerDoctorStateException(); }
            return kind;
        }
        public void EnsureProtectedDirectory(string path) => throw new WorkerDoctorStateException();
        public IDisposable PinProtectedDirectory(string path) => throw new WorkerDoctorStateException();
        public void VerifyNonReparsePath(string path) => _ = ClassifyPath(path);
        public void ProtectFile(string path) => throw new WorkerDoctorStateException();
        public void VerifyProtectedDirectory(string path) => throw new WorkerDoctorStateException();
        public void VerifyProtectedFile(string path) => throw new WorkerDoctorStateException();
        public BridgeFileIdentity GetProtectedFileIdentity(string path) => throw new WorkerDoctorStateException();
        public BridgeProtectedFileRead ReadProtectedFile(string path, int maximumBytes) => throw new WorkerDoctorStateException();
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenConfigurationPin(string path, uint desiredAccess,
        uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", EntryPoint = "QueryDosDeviceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDevice(string deviceName, StringBuilder targetPath, int maximumCharacters);
}
