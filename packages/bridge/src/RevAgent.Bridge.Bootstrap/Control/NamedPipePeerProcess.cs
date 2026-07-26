using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace RevAgent.Bridge.Bootstrap.Control;

internal static partial class NamedPipePeerProcess
{
    internal static int GetClientProcessId(SafePipeHandle pipeHandle)
    {
        ArgumentNullException.ThrowIfNull(pipeHandle);
        if (!GetNamedPipeClientProcessId(pipeHandle, out uint processId))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "GetNamedPipeClientProcessId failed.");
        }

        return CheckedProcessId(processId);
    }

    internal static int GetServerProcessId(SafePipeHandle pipeHandle)
    {
        ArgumentNullException.ThrowIfNull(pipeHandle);
        if (!GetNamedPipeServerProcessId(pipeHandle, out uint processId))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "GetNamedPipeServerProcessId failed.");
        }

        return CheckedProcessId(processId);
    }

    private static int CheckedProcessId(uint processId)
    {
        if (processId == 0 || processId > int.MaxValue)
        {
            throw new ControlProtocolException(
                "control_peer_pid_invalid",
                $"Named-pipe peer PID {processId} is invalid.");
        }

        return (int)processId;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeClientProcessId(
        SafePipeHandle pipe,
        out uint clientProcessId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeServerProcessId(
        SafePipeHandle pipe,
        out uint serverProcessId);
}
