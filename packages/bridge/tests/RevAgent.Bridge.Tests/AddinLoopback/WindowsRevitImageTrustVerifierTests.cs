using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class WindowsRevitImageTrustVerifierTests
{
    private const string SystemSid = "S-1-5-18";
    private const string StandardUserSid = "S-1-5-21-1-2-3-1001";

    [Fact]
    public void Verify_TraversesTrustedFileChainAndInvokesSignatureSeams()
    {
        (string root, string imagePath) = Paths();
        var files = new StubFileTrustInspector(root, imagePath);
        var authenticode = new RecordingAuthenticodeVerifier();
        var publisher = new StubPublisherReader("Autodesk, Inc.");
        var verifier = new WindowsRevitImageTrustVerifier(
            files,
            authenticode,
            publisher,
            () => true);

        verifier.Verify(imagePath, root);

        Assert.Equal(
            new[]
            {
                root,
                Path.Combine(root, "Autodesk"),
                Path.Combine(root, "Autodesk", "Revit 2026"),
                imagePath,
            },
            files.AclReads);
        Assert.Equal(imagePath, authenticode.ImagePath);
        Assert.Equal(imagePath, publisher.ImagePath);
    }

    [Fact]
    public void Verify_RejectsReparsePointAnywhereInTrustedChain()
    {
        (string root, string imagePath) = Paths();
        var files = new StubFileTrustInspector(root, imagePath);
        files.AttributeOverrides[
            Path.Combine(root, "Autodesk", "Revit 2026")] =
            FileAttributes.Directory | FileAttributes.ReparsePoint;
        var verifier = Verifier(files);

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => verifier.Verify(imagePath, root));

        Assert.Equal("revit_process_image_path_untrusted", error.Code);
    }

    [Fact]
    public void Verify_RejectsUntrustedOwner()
    {
        (string root, string imagePath) = Paths();
        var files = new StubFileTrustInspector(root, imagePath)
        {
            AclFactory = _ =>
                new WindowsFileAclEvidence(
                    StandardUserSid,
                    true,
                    Array.Empty<WindowsFileAccessRuleEvidence>()),
        };

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => Verifier(files).Verify(imagePath, root));

        Assert.Equal("revit_process_image_owner_untrusted", error.Code);
    }

    [Fact]
    public void Verify_RejectsNonAdministrativeWriteAcl()
    {
        (string root, string imagePath) = Paths();
        var files = new StubFileTrustInspector(root, imagePath)
        {
            AclFactory = _ =>
                new WindowsFileAclEvidence(
                    SystemSid,
                    true,
                    new[]
                    {
                        new WindowsFileAccessRuleEvidence(
                            StandardUserSid,
                            0x00000002,
                            IsAllow: true,
                            IsInheritOnly: false),
                    }),
        };

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => Verifier(files).Verify(imagePath, root));

        Assert.Equal("revit_process_image_acl_untrusted", error.Code);
    }

    [Fact]
    public void Verify_RejectsPublisherOutsideAllowlist()
    {
        (string root, string imagePath) = Paths();
        var files = new StubFileTrustInspector(root, imagePath);
        var verifier = new WindowsRevitImageTrustVerifier(
            files,
            new RecordingAuthenticodeVerifier(),
            new StubPublisherReader("Example Software LLC"),
            () => true);

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => verifier.Verify(imagePath, root));

        Assert.Equal("revit_process_image_publisher_untrusted", error.Code);
    }

    [Fact]
    public void Authenticode_UsesFrozenRevocationFlagsAndClosesProviderState()
    {
        var native = new RecordingWinTrustNative(verifyResult: 0);
        var verifier = new WindowsAuthenticodeTrustVerifier(native);

        verifier.Verify(@"C:\Program Files\Autodesk\Revit 2026\Revit.exe");

        Assert.Collection(
            native.Calls,
            verify =>
            {
                Assert.Equal(
                    WindowsAuthenticodeTrustVerifier.WinTrustStateActionVerify,
                    verify.StateAction);
                Assert.Equal(
                    WindowsAuthenticodeTrustVerifier.WinTrustUiNone,
                    verify.UiChoice);
                Assert.Equal(
                    WindowsAuthenticodeTrustVerifier.WinTrustRevokeWholeChain,
                    verify.RevocationChecks);
                Assert.Equal(
                    WindowsAuthenticodeTrustVerifier
                        .WinTrustRevocationCheckChainExcludeRoot |
                    WindowsAuthenticodeTrustVerifier
                        .WinTrustCacheOnlyUrlRetrieval,
                    verify.ProviderFlags);
                Assert.Equal(IntPtr.Zero, verify.InputStateData);
            },
            close =>
            {
                Assert.Equal(
                    WindowsAuthenticodeTrustVerifier.WinTrustStateActionClose,
                    close.StateAction);
                Assert.Equal(new IntPtr(1234), close.InputStateData);
            });
    }

    [Fact]
    public void Authenticode_ClosesProviderStateWhenVerificationFails()
    {
        var native = new RecordingWinTrustNative(
            verifyResult: unchecked((int)0x800B0100));
        var verifier = new WindowsAuthenticodeTrustVerifier(native);

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => verifier.Verify(
                    @"C:\Program Files\Autodesk\Revit 2026\Revit.exe"));

        Assert.Equal("revit_process_image_signature_untrusted", error.Code);
        Assert.Equal(2, native.Calls.Count);
        Assert.Equal(
            WindowsAuthenticodeTrustVerifier.WinTrustStateActionClose,
            native.Calls[1].StateAction);
    }

    [Fact]
    public void Authenticode_FailsClosedWhenProviderStateCannotClose()
    {
        var native = new RecordingWinTrustNative(
            verifyResult: 0,
            closeResult: unchecked((int)0x80004005));
        var verifier = new WindowsAuthenticodeTrustVerifier(native);

        AddinProcessAttestationException error =
            Assert.Throws<AddinProcessAttestationException>(
                () => verifier.Verify(
                    @"C:\Program Files\Autodesk\Revit 2026\Revit.exe"));

        Assert.Equal(
            "revit_process_image_trust_cleanup_failed",
            error.Code);
        Assert.Equal(2, native.Calls.Count);
    }

    private static WindowsRevitImageTrustVerifier Verifier(
        StubFileTrustInspector files) =>
        new(
            files,
            new RecordingAuthenticodeVerifier(),
            new StubPublisherReader("Autodesk, Inc."),
            () => true);

    private static (string Root, string ImagePath) Paths()
    {
        string root = Path.GetFullPath(
            Path.Combine(
                Path.GetTempPath(),
                "revagent-verifier-tests",
                "Program Files"));
        string imagePath = Path.Combine(
            root,
            "Autodesk",
            "Revit 2026",
            "Revit.exe");
        return (root, imagePath);
    }

    private sealed class StubFileTrustInspector
        : IWindowsFileTrustInspector
    {
        private readonly string _imagePath;

        internal StubFileTrustInspector(string root, string imagePath)
        {
            _imagePath = imagePath;
            AttributeOverrides[root] = FileAttributes.Directory;
            AttributeOverrides[Path.Combine(root, "Autodesk")] =
                FileAttributes.Directory;
            AttributeOverrides[
                Path.Combine(root, "Autodesk", "Revit 2026")] =
                FileAttributes.Directory;
            AttributeOverrides[imagePath] = FileAttributes.Normal;
        }

        internal Dictionary<string, FileAttributes> AttributeOverrides
        { get; } =
            new(StringComparer.OrdinalIgnoreCase);

        internal Func<string, WindowsFileAclEvidence> AclFactory { get; set; } =
            _ => new WindowsFileAclEvidence(
                SystemSid,
                true,
                Array.Empty<WindowsFileAccessRuleEvidence>());

        internal List<string> AclReads { get; } = new();

        public string GetFullPath(string path) => Path.GetFullPath(path);

        public bool FileExists(string path) =>
            string.Equals(path, _imagePath, StringComparison.OrdinalIgnoreCase);

        public FileAttributes GetAttributes(string path) =>
            AttributeOverrides[path];

        public WindowsFileAclEvidence ReadAcl(
            string path,
            bool isDirectory)
        {
            AclReads.Add(path);
            return AclFactory(path);
        }
    }

    private sealed class RecordingAuthenticodeVerifier
        : IWindowsAuthenticodeTrustVerifier
    {
        internal string? ImagePath { get; private set; }

        public void Verify(string imagePath)
        {
            ImagePath = imagePath;
        }
    }

    private sealed class StubPublisherReader : IWindowsPublisherReader
    {
        private readonly string _publisherName;

        internal StubPublisherReader(string publisherName)
        {
            _publisherName = publisherName;
        }

        internal string? ImagePath { get; private set; }

        public string ReadPublisherName(string imagePath)
        {
            ImagePath = imagePath;
            return _publisherName;
        }
    }

    private sealed class RecordingWinTrustNative : IWinTrustNative
    {
        private readonly int _verifyResult;
        private readonly int _closeResult;

        internal RecordingWinTrustNative(
            int verifyResult,
            int closeResult = 0)
        {
            _verifyResult = verifyResult;
            _closeResult = closeResult;
        }

        internal List<WinTrustCall> Calls { get; } = new();

        public int Invoke(
            string imagePath,
            uint uiChoice,
            uint revocationChecks,
            uint stateAction,
            uint providerFlags,
            ref IntPtr stateData)
        {
            Calls.Add(
                new WinTrustCall(
                    uiChoice,
                    revocationChecks,
                    stateAction,
                    providerFlags,
                    stateData));
            if (stateAction ==
                WindowsAuthenticodeTrustVerifier.WinTrustStateActionVerify)
            {
                stateData = new IntPtr(1234);
                return _verifyResult;
            }

            stateData = IntPtr.Zero;
            return _closeResult;
        }
    }

    private sealed record WinTrustCall(
        uint UiChoice,
        uint RevocationChecks,
        uint StateAction,
        uint ProviderFlags,
        IntPtr InputStateData);
}
