using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace RevAgent.Bridge.Bootstrap;

/// <summary>
/// Grants the bridge service account write access to the machine state root
/// and to the journal database it owns.
/// </summary>
/// <remarks>
/// <para>
/// The credential directory carries its own protected ACL, but the journal
/// database did not, so it inherited only the <c>%ProgramData%</c> defaults —
/// SYSTEM, Administrators, and <c>BUILTIN\Users</c>. A virtual service account
/// is not a member of <c>Users</c>, so the service could write the journal only
/// because it happened to create the file and became its owner.
/// </para>
/// <para>
/// SQLite recreates the <c>-wal</c> and <c>-shm</c> sidecars on every open. Once
/// any other principal — an administrator running <c>doctor</c> or
/// <c>run --console</c>, which is exactly what first-run enrollment asks for —
/// opened the journal, those sidecars came back owned by Administrators with no
/// service ACE, and the service could never start again: SQLite reports
/// <c>attempt to write a readonly database</c> and the host exits before it
/// connects. An inheritable ACE on the state root fixes every future sidecar,
/// and the explicit sweep repairs a machine that is already wedged.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
internal static class BridgeStateAccessControl
{
    private const string JournalFileSearchPattern = "journal.db*";

    internal static void EnsureServiceWritableState(BridgeInstallLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        SecurityIdentifier service = ResolveServiceAccount();
        _ = Directory.CreateDirectory(layout.StateRoot);
        EnsureDirectoryAce(layout.StateRoot, service);

        foreach (string journalFile in EnumerateJournalFiles(layout))
        {
            EnsureFileAce(journalFile, service);
        }
    }

    private static IEnumerable<string> EnumerateJournalFiles(
        BridgeInstallLayout layout)
    {
        string directory =
            Path.GetDirectoryName(layout.JournalPath) ?? layout.StateRoot;
        if (!Directory.Exists(directory))
        {
            return [];
        }

        try
        {
            return Directory.EnumerateFiles(
                directory,
                JournalFileSearchPattern,
                SearchOption.TopDirectoryOnly);
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static void EnsureDirectoryAce(
        string directoryPath,
        SecurityIdentifier service)
    {
        var directory = new DirectoryInfo(directoryPath);
        DirectorySecurity security =
            directory.GetAccessControl(AccessControlSections.Access);
        var desired = new FileSystemAccessRule(
            service,
            FileSystemRights.Modify,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow);
        if (HasRule(security, desired))
        {
            return;
        }

        security.AddAccessRule(desired);
        directory.SetAccessControl(security);
    }

    private static void EnsureFileAce(
        string filePath,
        SecurityIdentifier service)
    {
        var file = new FileInfo(filePath);
        FileSecurity security =
            file.GetAccessControl(AccessControlSections.Access);
        var desired = new FileSystemAccessRule(
            service,
            FileSystemRights.Modify,
            InheritanceFlags.None,
            PropagationFlags.None,
            AccessControlType.Allow);
        if (HasRule(security, desired))
        {
            return;
        }

        security.AddAccessRule(desired);
        file.SetAccessControl(security);
    }

    /// <summary>
    /// True when an existing allow rule already grants the service at least the
    /// requested rights with at least the requested inheritance, so a machine
    /// that is already correct is never rewritten.
    /// </summary>
    private static bool HasRule(
        FileSystemSecurity security,
        FileSystemAccessRule desired)
    {
        foreach (FileSystemAccessRule rule in security
                     .GetAccessRules(
                         includeExplicit: true,
                         includeInherited: true,
                         typeof(SecurityIdentifier))
                     .Cast<FileSystemAccessRule>())
        {
            if (rule.AccessControlType != AccessControlType.Allow ||
                !rule.IdentityReference.Equals(desired.IdentityReference))
            {
                continue;
            }

            if ((rule.FileSystemRights & desired.FileSystemRights) ==
                    desired.FileSystemRights &&
                (rule.InheritanceFlags & desired.InheritanceFlags) ==
                    desired.InheritanceFlags)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The service logs on as LocalSystem, whose SCM spelling is not an
    /// LSA-resolvable account name, so the well-known SID is used directly.
    /// </summary>
    private static SecurityIdentifier ResolveServiceAccount() =>
        new(WellKnownSidType.LocalSystemSid, domainSid: null);
}
