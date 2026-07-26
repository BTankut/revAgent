using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed class WindowsTcpConnectionOwnerResolver
    : IWindowsTcpConnectionOwnerResolver
{
    private const uint ErrorInsufficientBuffer = 122;
    private const int AddressFamilyInterNetwork = 2;
    private const int TcpTableOwnerPidAll = 5;
    private const uint TcpStateEstablished = 5;

    public int ResolveOwnerProcessId(AddinConnectedPeer peer)
    {
        int bufferLength = 0;
        uint result = GetExtendedTcpTable(
            IntPtr.Zero,
            ref bufferLength,
            order: false,
            AddressFamilyInterNetwork,
            TcpTableOwnerPidAll,
            reserved: 0);
        if (result != ErrorInsufficientBuffer || bufferLength <= sizeof(uint))
        {
            throw Failure(
                "addin_listener_owner_unavailable",
                "Windows did not return a usable TCP listener table size.",
                result);
        }

        for (int attempt = 0; attempt < 3; attempt++)
        {
            IntPtr buffer = Marshal.AllocHGlobal(bufferLength);
            try
            {
                result = GetExtendedTcpTable(
                    buffer,
                    ref bufferLength,
                    order: false,
                    AddressFamilyInterNetwork,
                    TcpTableOwnerPidAll,
                    reserved: 0);
                if (result == ErrorInsufficientBuffer)
                {
                    continue;
                }

                if (result != 0)
                {
                    throw Failure(
                        "addin_listener_owner_unavailable",
                        "Windows could not enumerate TCP listener owners.",
                        result);
                }

                return FindSingleOwner(peer, buffer, bufferLength);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        throw Failure(
            "addin_listener_owner_unavailable",
            "The Windows TCP listener table changed repeatedly during attestation.");
    }

    private static int FindSingleOwner(
        AddinConnectedPeer peer,
        IntPtr buffer,
        int bufferLength)
    {
        uint rowCount = unchecked((uint)Marshal.ReadInt32(buffer));
        int rowSize = Marshal.SizeOf<MibTcpRowOwnerPid>();
        long requiredLength =
            sizeof(uint) + ((long)rowCount * rowSize);
        if (requiredLength > bufferLength)
        {
            throw Failure(
                "addin_listener_owner_unavailable",
                "The Windows TCP listener table was truncated.");
        }

        var ownerProcessIds = new HashSet<int>();
        IntPtr rowPointer = IntPtr.Add(buffer, sizeof(uint));
        for (uint index = 0; index < rowCount; index++)
        {
            MibTcpRowOwnerPid row =
                Marshal.PtrToStructure<MibTcpRowOwnerPid>(rowPointer);
            rowPointer = IntPtr.Add(rowPointer, rowSize);
            if (row.State != TcpStateEstablished ||
                ConvertPort(row.LocalPort) != peer.ServerEndPoint.Port ||
                !ConvertAddress(row.LocalAddress).Equals(
                    peer.ServerEndPoint.Address) ||
                ConvertPort(row.RemotePort) != peer.ClientEndPoint.Port ||
                !ConvertAddress(row.RemoteAddress).Equals(
                    peer.ClientEndPoint.Address))
            {
                continue;
            }

            if (row.OwningProcessId == 0 ||
                row.OwningProcessId > int.MaxValue)
            {
                throw Failure(
                    "addin_listener_owner_invalid",
                    "Windows returned an invalid TCP listener owner process id.");
            }

            ownerProcessIds.Add(checked((int)row.OwningProcessId));
        }

        if (ownerProcessIds.Count == 0)
        {
            throw Failure(
                "addin_listener_owner_not_found",
                "No Windows TCP owner matched the exact connected endpoint pair.");
        }

        if (ownerProcessIds.Count != 1)
        {
            throw Failure(
                "addin_listener_owner_ambiguous",
                "More than one Windows process owned the exact connected endpoint pair.");
        }

        return ownerProcessIds.Single();
    }

    private static int ConvertPort(uint networkOrderPort) =>
        unchecked(
            (ushort)IPAddress.NetworkToHostOrder(
                unchecked((short)(networkOrderPort & ushort.MaxValue))));

    private static IPAddress ConvertAddress(uint networkOrderAddress) =>
        new(
            new[]
            {
                unchecked((byte)networkOrderAddress),
                unchecked((byte)(networkOrderAddress >> 8)),
                unchecked((byte)(networkOrderAddress >> 16)),
                unchecked((byte)(networkOrderAddress >> 24)),
            });

    private static AddinProcessAttestationException Failure(
        string code,
        string message,
        uint? nativeError = null)
    {
        Exception? innerException = nativeError.HasValue
            ? new Win32Exception(unchecked((int)nativeError.Value))
            : null;
        return new AddinProcessAttestationException(
            code,
            message,
            innerException);
    }

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

internal sealed class WindowsProcessSnapshotProvider
    : IWindowsProcessSnapshotProvider
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint WaitFailed = 0xFFFFFFFF;

    public WindowsProcessSnapshot Capture(int processId)
    {
        IntPtr processHandle = OpenProcess(
            ProcessQueryLimitedInformation | Synchronize,
            inheritHandle: false,
            processId);
        if (processHandle == IntPtr.Zero)
        {
            throw NativeFailure(
                "revit_process_identity_unavailable",
                "Windows could not open the reported Revit process.");
        }

        try
        {
            EnsureProcessAlive(processHandle);

            if (!GetProcessTimes(
                    processHandle,
                    out FileTime creationTime,
                    out _,
                    out _,
                    out _))
            {
                throw NativeFailure(
                    "revit_process_identity_unavailable",
                    "Windows could not read the reported Revit process start time.");
            }

            long startTimeFileTimeUtc =
                ((long)creationTime.HighDateTime << 32) |
                creationTime.LowDateTime;
            if (startTimeFileTimeUtc <= 0)
            {
                throw new AddinProcessAttestationException(
                    "revit_process_identity_invalid",
                    "Windows returned an invalid Revit process start time.");
            }

            var imagePath = new StringBuilder(32768);
            uint imagePathLength = checked((uint)imagePath.Capacity);
            if (!QueryFullProcessImageName(
                    processHandle,
                    flags: 0,
                    imagePath,
                    ref imagePathLength) ||
                imagePathLength == 0)
            {
                throw NativeFailure(
                    "revit_process_image_path_unavailable",
                    "Windows could not read the reported Revit process image path.");
            }

            EnsureProcessAlive(processHandle);

            return new WindowsProcessSnapshot(
                processId,
                startTimeFileTimeUtc,
                imagePath.ToString());
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    private static void EnsureProcessAlive(IntPtr processHandle)
    {
        uint waitResult = WaitForSingleObject(
            processHandle,
            milliseconds: 0);
        if (waitResult == WaitTimeout)
        {
            return;
        }

        if (waitResult == WaitObject0)
        {
            throw new AddinProcessAttestationException(
                "revit_process_not_alive",
                "The reported Revit process has exited.");
        }

        if (waitResult == WaitFailed)
        {
            throw NativeFailure(
                "revit_process_liveness_unavailable",
                "Windows could not attest the reported Revit process liveness.");
        }

        throw new AddinProcessAttestationException(
            "revit_process_liveness_invalid",
            "Windows returned an unexpected process liveness state.");
    }

    private static AddinProcessAttestationException NativeFailure(
        string code,
        string message) =>
        new(
            code,
            message,
            new Win32Exception(Marshal.GetLastWin32Error()));

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        internal uint LowDateTime;
        internal uint HighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr processHandle,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [DllImport(
        "kernel32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        IntPtr processHandle,
        uint flags,
        StringBuilder executableName,
        ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        IntPtr processHandle,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
