using Microsoft.AspNetCore.Http;
using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;

namespace RevAgent.M4.ClientBearerBroker;

internal interface ITcpOwnerTable
{
    IReadOnlyList<TcpOwnerRow> Read();
}

internal interface ICallerProcessEvidence : IDisposable
{
    int ProcessId { get; }

    bool IsExited();

    void VerifyUnchanged();
}

internal interface ICallerProcessEvidenceFactory
{
    ICallerProcessEvidence Open(int processId, CallerIdentityExpectation expectation);
}

internal sealed class NativeCallerProcessEvidenceFactory : ICallerProcessEvidenceFactory
{
    public ICallerProcessEvidence Open(
        int processId,
        CallerIdentityExpectation expectation) =>
        NativeCallerEvidence.Open(processId, expectation);
}

internal sealed class WindowsCallerAuthorizer : ICallerAuthorizer
{
    private readonly ITcpOwnerTable _ownerTable;
    private readonly int _brokerProcessId;
    private readonly CallerIdentityExpectation _expectation;
    private readonly ICallerProcessEvidenceFactory _evidenceFactory;

    internal WindowsCallerAuthorizer(CallerIdentityExpectation expectation)
        : this(
            new WindowsTcpOwnerTable(),
            new NativeCallerProcessEvidenceFactory(),
            Environment.ProcessId,
            expectation)
    {
    }

    internal WindowsCallerAuthorizer(
        ITcpOwnerTable ownerTable,
        ICallerProcessEvidenceFactory evidenceFactory,
        int brokerProcessId,
        CallerIdentityExpectation expectation)
    {
        _ownerTable = ownerTable;
        _evidenceFactory = evidenceFactory;
        _brokerProcessId = brokerProcessId;
        _expectation = expectation;
    }

    public ValueTask<CallerAuthorizationLease> AuthorizeAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (context.Connection.RemoteIpAddress is not IPAddress remoteAddress ||
            context.Connection.LocalIpAddress is not IPAddress localAddress ||
            !IPAddress.Loopback.Equals(remoteAddress) ||
            !IPAddress.Loopback.Equals(localAddress))
        {
            throw new BrokerRefusalException("caller_endpoint_refused");
        }

        var remote = new IPEndPoint(remoteAddress, context.Connection.RemotePort);
        var local = new IPEndPoint(localAddress, context.Connection.LocalPort);
        var processId = Resolve(remote, local);
        ICallerProcessEvidence? evidence = null;
        try
        {
            evidence = _evidenceFactory.Open(processId, _expectation);
            if (Resolve(remote, local) != processId)
            {
                throw new BrokerRefusalException("caller_identity_changed");
            }
            CallerAuthorizationLease lease = new NativeCallerAuthorizationLease(
                evidence,
                _ownerTable,
                remote,
                local,
                _brokerProcessId);
            evidence = null;
            return ValueTask.FromResult(lease);
        }
        finally
        {
            evidence?.Dispose();
        }
    }

    private int Resolve(IPEndPoint remote, IPEndPoint local) =>
        CallerPidSelector.Select(_ownerTable.Read(), remote, local, _brokerProcessId);
}

internal sealed class NativeCallerAuthorizationLease : CallerAuthorizationLease
{
    private readonly ICallerProcessEvidence _evidence;
    private readonly ITcpOwnerTable _ownerTable;
    private readonly IPEndPoint _remote;
    private readonly IPEndPoint _local;
    private readonly int _brokerProcessId;
    private readonly CancellationTokenSource _revoked = new();
    private readonly CancellationTokenSource _monitorStop = new();
    private readonly Task _monitor;
    private int _disposed;

    internal NativeCallerAuthorizationLease(
        ICallerProcessEvidence evidence,
        ITcpOwnerTable ownerTable,
        IPEndPoint remote,
        IPEndPoint local,
        int brokerProcessId)
    {
        _evidence = evidence;
        _ownerTable = ownerTable;
        _remote = remote;
        _local = local;
        _brokerProcessId = brokerProcessId;
        _monitor = MonitorProcessAsync();
    }

    internal override CancellationToken Revocation => _revoked.Token;

    internal override ValueTask VerifyAfterAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_evidence.IsExited() ||
            CallerPidSelector.Select(_ownerTable.Read(), _remote, _local, _brokerProcessId) != _evidence.ProcessId)
        {
            throw new BrokerRefusalException("caller_identity_changed");
        }
        _evidence.VerifyUnchanged();
        return ValueTask.CompletedTask;
    }

    public override async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        _monitorStop.Cancel();
        try
        {
            await _monitor.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        _revoked.Dispose();
        _monitorStop.Dispose();
        _evidence.Dispose();
    }

    private async Task MonitorProcessAsync()
    {
        try
        {
            while (!_monitorStop.IsCancellationRequested)
            {
                if (_evidence.IsExited())
                {
                    _revoked.Cancel();
                    return;
                }
                await Task.Delay(TimeSpan.FromMilliseconds(200), _monitorStop.Token)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (_monitorStop.IsCancellationRequested)
        {
        }
        catch
        {
            if (!_monitorStop.IsCancellationRequested)
            {
                _revoked.Cancel();
            }
        }
    }
}

internal sealed class NativeCallerEvidence : ICallerProcessEvidence
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint TokenQuery = 0x0008;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;
    private const int TokenUserClass = 1;
    private const int ErrorInsufficientBuffer = 122;
    private const string ExpectedPublisherSubject =
        "CN=\"OpenAI OpCo, LLC\", O=\"OpenAI OpCo, LLC\", L=San Francisco, S=California, C=US";

    private readonly SafeProcessHandle _process;
    private readonly FileStream _imagePin;
    private readonly long _startTime;
    private readonly string _path;
    private readonly string _sid;
    private readonly string _account;
    private readonly string _packageFamily;
    private readonly string _packageFullName;
    private readonly byte[] _imageHash;
    private readonly string _signerThumbprint;
    private readonly CallerIdentityExpectation _expectation;
    private int _disposed;

    private NativeCallerEvidence(
        int processId,
        SafeProcessHandle process,
        FileStream imagePin,
        long startTime,
        string path,
        string sid,
        string account,
        string packageFamily,
        string packageFullName,
        byte[] imageHash,
        string signerThumbprint,
        CallerIdentityExpectation expectation)
    {
        ProcessId = processId;
        _process = process;
        _imagePin = imagePin;
        _startTime = startTime;
        _path = path;
        _sid = sid;
        _account = account;
        _packageFamily = packageFamily;
        _packageFullName = packageFullName;
        _imageHash = imageHash;
        _signerThumbprint = signerThumbprint;
        _expectation = expectation;
    }

    public int ProcessId { get; }

    internal static NativeCallerEvidence Open(
        int processId,
        CallerIdentityExpectation expectation)
    {
        SafeProcessHandle? process = null;
        FileStream? imagePin = null;
        byte[]? imageHash = null;
        try
        {
            process = OpenProcess(
                ProcessQueryLimitedInformation | Synchronize,
                inheritHandle: false,
                processId);
            if (process.IsInvalid || IsExited(process))
            {
                throw new BrokerRefusalException("caller_process_refused");
            }

            var startTime = ReadStartTime(process);
            var path = ReadImagePath(process);
            var sid = ReadSid(process);
            var account = ResolveAccount(sid);
            var family = ReadPackageValue(process, GetPackageFamilyName);
            var fullName = ReadPackageValue(process, GetPackageFullName);
            if (!IsExpectedImagePath(path, fullName))
            {
                throw new BrokerRefusalException("caller_identity_refused");
            }

            imagePin = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                81920,
                FileOptions.SequentialScan);
            imageHash = SHA256.HashData(imagePin);
            imagePin.Position = 0;
            var imageSha256 = Convert.ToHexString(imageHash).ToLowerInvariant();
            var signerThumbprint = ReadVerifiedPublisherThumbprint(path);
            CallerIdentityPolicy.DemandExact(
                expectation,
                new CallerIdentityObservation(
                    sid,
                    account,
                    imageSha256,
                    signerThumbprint,
                    family,
                    fullName));

            var result = new NativeCallerEvidence(
                processId,
                process,
                imagePin,
                startTime,
                path,
                sid,
                account,
                family,
                fullName,
                imageHash,
                signerThumbprint,
                expectation);
            process = null;
            imagePin = null;
            imageHash = null;
            return result;
        }
        catch (BrokerRefusalException)
        {
            throw;
        }
        catch
        {
            throw new BrokerRefusalException("caller_attestation_failed");
        }
        finally
        {
            process?.Dispose();
            imagePin?.Dispose();
            if (imageHash is not null)
            {
                CryptographicOperations.ZeroMemory(imageHash);
            }
        }
    }

    public bool IsExited() => IsExited(_process);

    public void VerifyUnchanged()
    {
        var sid = ReadSid(_process);
        var account = ResolveAccount(sid);
        var family = ReadPackageValue(_process, GetPackageFamilyName);
        var fullName = ReadPackageValue(_process, GetPackageFullName);
        var path = ReadImagePath(_process);
        if (IsExited() || ReadStartTime(_process) != _startTime ||
            !string.Equals(path, _path, StringComparison.OrdinalIgnoreCase))
        {
            throw new BrokerRefusalException("caller_identity_changed");
        }

        _imagePin.Position = 0;
        var hash = SHA256.HashData(_imagePin);
        _imagePin.Position = 0;
        try
        {
            var imageSha256 = Convert.ToHexString(hash).ToLowerInvariant();
            var signerThumbprint = ReadVerifiedPublisherThumbprint(_path);
            CallerIdentityPolicy.DemandExact(
                _expectation,
                new CallerIdentityObservation(
                    sid,
                    account,
                    imageSha256,
                    signerThumbprint,
                    family,
                    fullName));
            if (!CryptographicOperations.FixedTimeEquals(hash, _imageHash) ||
                !string.Equals(signerThumbprint, _signerThumbprint, StringComparison.Ordinal) ||
                !string.Equals(sid, _sid, StringComparison.Ordinal) ||
                !string.Equals(account, _account, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(family, _packageFamily, StringComparison.Ordinal) ||
                !string.Equals(fullName, _packageFullName, StringComparison.Ordinal))
            {
                throw new BrokerRefusalException("caller_identity_changed");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(hash);
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        CryptographicOperations.ZeroMemory(_imageHash);
        _imagePin.Dispose();
        _process.Dispose();
    }

    private static bool IsExpectedImagePath(string path, string packageFullName)
    {
        var expected = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "WindowsApps",
            packageFullName,
            "app",
            "resources",
            "codex.exe"));
        return string.Equals(Path.GetFullPath(path), expected, StringComparison.OrdinalIgnoreCase);
    }

    private static long ReadStartTime(SafeProcessHandle process)
    {
        if (!GetProcessTimes(process, out var created, out _, out _, out _))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        return ((long)created.HighDateTime << 32) | created.LowDateTime;
    }

    private static string ReadImagePath(SafeProcessHandle process)
    {
        var buffer = new StringBuilder(32768);
        var length = checked((uint)buffer.Capacity);
        if (!QueryFullProcessImageName(process, 0, buffer, ref length) || length == 0)
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        return Path.GetFullPath(buffer.ToString());
    }

    private static string ReadSid(SafeProcessHandle process)
    {
        if (!OpenProcessToken(process, TokenQuery, out var token))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        using (token)
        {
            _ = GetTokenInformation(token, TokenUserClass, IntPtr.Zero, 0, out var needed);
            if (needed <= 0)
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            }
            var buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, TokenUserClass, buffer, needed, out _))
                {
                    throw new Win32Exception(Marshal.GetLastPInvokeError());
                }
                var user = Marshal.PtrToStructure<TokenUser>(buffer);
                return new SecurityIdentifier(user.User.Sid).Value;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    private static string ResolveAccount(string sid)
    {
        var account = new SecurityIdentifier(sid).Translate(typeof(NTAccount)) as NTAccount;
        if (account is null || string.IsNullOrWhiteSpace(account.Value))
        {
            throw new BrokerRefusalException("caller_account_refused");
        }
        return account.Value;
    }

    private delegate int PackageValueReader(SafeProcessHandle process, ref uint length, char[]? value);

    private static string ReadPackageValue(SafeProcessHandle process, PackageValueReader reader)
    {
        uint length = 0;
        var first = reader(process, ref length, null);
        if (first != ErrorInsufficientBuffer || length is 0 or > 32768)
        {
            throw new BrokerRefusalException("caller_package_refused");
        }
        var buffer = new char[length];
        if (reader(process, ref length, buffer) != 0 || length < 2)
        {
            throw new BrokerRefusalException("caller_package_refused");
        }
        return new string(buffer, 0, checked((int)length - 1));
    }

    private static string ReadVerifiedPublisherThumbprint(string path)
    {
        var fileInfo = new WinTrustFileInfo(path);
        var filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        try
        {
            Marshal.StructureToPtr(fileInfo, filePointer, fDeleteOld: false);
            var data = new WinTrustData(filePointer);
            var action = WinTrustActionGenericVerifyV2;
            if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0)
            {
                throw new BrokerRefusalException("caller_signer_refused");
            }
            using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            if (!string.Equals(certificate.Subject, ExpectedPublisherSubject, StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(certificate.Thumbprint))
            {
                throw new BrokerRefusalException("caller_signer_refused");
            }
            return certificate.Thumbprint.ToLowerInvariant();
        }
        catch (BrokerRefusalException)
        {
            throw;
        }
        catch
        {
            throw new BrokerRefusalException("caller_signer_refused");
        }
        finally
        {
            Marshal.DestroyStructure<WinTrustFileInfo>(filePointer);
            Marshal.FreeHGlobal(filePointer);
        }
    }

    private static bool IsExited(SafeProcessHandle process)
    {
        var result = WaitForSingleObject(process, 0);
        if (result == WaitTimeout)
        {
            return false;
        }
        if (result == WaitObject0)
        {
            return true;
        }
        throw new Win32Exception(Marshal.GetLastPInvokeError());
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        internal uint LowDateTime;
        internal uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenUser
    {
        internal SidAndAttributes User;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        internal WinTrustFileInfo(string path)
        {
            Size = checked((uint)Marshal.SizeOf<WinTrustFileInfo>());
            FilePath = path;
            FileHandle = IntPtr.Zero;
            KnownSubject = IntPtr.Zero;
        }

        internal uint Size;
        [MarshalAs(UnmanagedType.LPWStr)] internal string FilePath;
        internal IntPtr FileHandle;
        internal IntPtr KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal WinTrustData(IntPtr fileInfo)
        {
            Size = checked((uint)Marshal.SizeOf<WinTrustData>());
            PolicyCallbackData = IntPtr.Zero;
            SipClientData = IntPtr.Zero;
            UiChoice = 2;
            RevocationChecks = 0;
            UnionChoice = 1;
            FileInfo = fileInfo;
            StateAction = 0;
            StateData = IntPtr.Zero;
            UrlReference = IntPtr.Zero;
            ProviderFlags = 0x00001000;
            UiContext = 0;
            SignatureSettings = IntPtr.Zero;
        }

        internal uint Size;
        internal IntPtr PolicyCallbackData;
        internal IntPtr SipClientData;
        internal uint UiChoice;
        internal uint RevocationChecks;
        internal uint UnionChoice;
        internal IntPtr FileInfo;
        internal uint StateAction;
        internal IntPtr StateData;
        internal IntPtr UrlReference;
        internal uint ProviderFlags;
        internal uint UiContext;
        internal IntPtr SignatureSettings;
    }

    private static Guid WinTrustActionGenericVerifyV2 =
        new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        SafeProcessHandle process,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        SafeProcessHandle process,
        uint flags,
        StringBuilder executableName,
        ref uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        SafeProcessHandle process,
        uint desiredAccess,
        out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        SafeAccessTokenHandle token,
        int tokenInformationClass,
        IntPtr tokenInformation,
        int tokenInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(
        SafeProcessHandle process,
        ref uint packageFamilyNameLength,
        [Out] char[]? packageFamilyName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFullName(
        SafeProcessHandle process,
        ref uint packageFullNameLength,
        [Out] char[]? packageFullName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WinVerifyTrust(
        IntPtr window,
        ref Guid actionId,
        ref WinTrustData trustData);
}

internal sealed class WindowsTcpOwnerTable : ITcpOwnerTable
{
    private const uint ErrorInsufficientBuffer = 122;
    private const int AddressFamilyInterNetwork = 2;
    private const int TcpTableOwnerPidAll = 5;

    public IReadOnlyList<TcpOwnerRow> Read()
    {
        var bufferLength = 0;
        var result = GetExtendedTcpTable(
            IntPtr.Zero,
            ref bufferLength,
            order: false,
            AddressFamilyInterNetwork,
            TcpTableOwnerPidAll,
            0);
        if (result != ErrorInsufficientBuffer || bufferLength <= sizeof(uint))
        {
            throw new BrokerRefusalException("caller_owner_unavailable");
        }

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var buffer = Marshal.AllocHGlobal(bufferLength);
            try
            {
                result = GetExtendedTcpTable(
                    buffer,
                    ref bufferLength,
                    order: false,
                    AddressFamilyInterNetwork,
                    TcpTableOwnerPidAll,
                    0);
                if (result == ErrorInsufficientBuffer)
                {
                    continue;
                }
                if (result != 0)
                {
                    throw new BrokerRefusalException("caller_owner_unavailable");
                }
                return ParseRows(buffer, bufferLength);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new BrokerRefusalException("caller_owner_unavailable");
    }

    private static IReadOnlyList<TcpOwnerRow> ParseRows(IntPtr buffer, int bufferLength)
    {
        var count = unchecked((uint)Marshal.ReadInt32(buffer));
        var rowSize = Marshal.SizeOf<MibTcpRowOwnerPid>();
        if (sizeof(uint) + (long)count * rowSize > bufferLength)
        {
            throw new BrokerRefusalException("caller_owner_unavailable");
        }

        var rows = new List<TcpOwnerRow>(checked((int)count));
        var pointer = IntPtr.Add(buffer, sizeof(uint));
        for (uint index = 0; index < count; index++)
        {
            var row = Marshal.PtrToStructure<MibTcpRowOwnerPid>(pointer);
            pointer = IntPtr.Add(pointer, rowSize);
            if (row.OwningProcessId is 0 or > int.MaxValue)
            {
                continue;
            }
            rows.Add(new TcpOwnerRow(
                row.State,
                new IPEndPoint(ConvertAddress(row.LocalAddress), ConvertPort(row.LocalPort)),
                new IPEndPoint(ConvertAddress(row.RemoteAddress), ConvertPort(row.RemotePort)),
                checked((int)row.OwningProcessId)));
        }
        return rows;
    }

    private static int ConvertPort(uint value) =>
        unchecked((ushort)IPAddress.NetworkToHostOrder(unchecked((short)(value & ushort.MaxValue))));

    private static IPAddress ConvertAddress(uint value) => new(new byte[]
    {
        unchecked((byte)value),
        unchecked((byte)(value >> 8)),
        unchecked((byte)(value >> 16)),
        unchecked((byte)(value >> 24)),
    });

    [StructLayout(LayoutKind.Sequential)]
    private struct MibTcpRowOwnerPid
    {
        internal uint State;
        internal uint LocalAddress;
        internal uint LocalPort;
        internal uint RemoteAddress;
        internal uint RemotePort;
        internal uint OwningProcessId;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr tcpTable,
        ref int size,
        [MarshalAs(UnmanagedType.Bool)] bool order,
        int addressFamily,
        int tableClass,
        uint reserved);
}
