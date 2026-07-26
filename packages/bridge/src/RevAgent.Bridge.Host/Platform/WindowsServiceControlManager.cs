using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace RevAgent.Bridge.Host.Platform;

internal sealed class WindowsServiceControlManager : IServiceControlManager
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ScManagerCreateService = 0x0002;

    private const uint ServiceQueryConfig = 0x0001;
    private const uint ServiceChangeConfig = 0x0002;
    private const uint ServiceQueryStatus = 0x0004;
    private const uint ServiceStart = 0x0010;
    private const uint ServiceStop = 0x0020;
    private const uint Delete = 0x00010000;

    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceAutoStart = 0x00000002;
    private const uint ServiceDemandStart = 0x00000003;
    private const uint ServiceErrorNormal = 0x00000001;

    private const uint ServiceControlStop = 0x00000001;
    private const int ScStatusProcessInfo = 0;
    private const uint ServiceConfigDescription = 1;
    private const uint ServiceConfigDelayedAutoStartInfo = 3;

    private const uint ServiceStopped = 0x00000001;
    private const uint ServiceStartPending = 0x00000002;
    private const uint ServiceStopPending = 0x00000003;
    private const uint ServiceRunning = 0x00000004;

    private const int ErrorInsufficientBuffer = 122;
    private const int ErrorServiceDoesNotExist = 1060;
    private const int ErrorServiceAlreadyRunning = 1056;
    private const int ErrorServiceNotActive = 1062;

    public ValueTask<ServiceSnapshot?> QueryAsync(
        string serviceName,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureWindows();
        ValidateServiceName(serviceName);

        using SafeServiceHandle manager = OpenManager(ScManagerConnect);
        using SafeServiceHandle? service = TryOpenService(
            manager,
            serviceName,
            ServiceQueryConfig | ServiceQueryStatus);
        if (service is null)
        {
            return ValueTask.FromResult<ServiceSnapshot?>(null);
        }

        ManagedServiceConfiguration config = QueryConfiguration(service);
        string description = QueryDescription(service);
        bool delayed = QueryDelayedAutomatic(service);
        ServiceRuntimeState state = QueryRuntimeState(service);
        return ValueTask.FromResult<ServiceSnapshot?>(
            new ServiceSnapshot(
                serviceName,
                config.DisplayName,
                description,
                config.BinaryPathName,
                config.ServiceStartName,
                config.StartType == ServiceAutoStart,
                delayed,
                config.ServiceType == ServiceWin32OwnProcess,
                config.ErrorControl == ServiceErrorNormal,
                state));
    }

    public ValueTask CreateAsync(
        ServiceDefinition definition,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureWindows();
        ArgumentNullException.ThrowIfNull(definition);
        ValidateServiceName(definition.Name);
        if (!definition.OwnProcess || !definition.NormalErrorControl)
        {
            throw new ArgumentException(
                "The bridge service must be an own-process service with normal error control.",
                nameof(definition));
        }

        using SafeServiceHandle manager = OpenManager(
            ScManagerConnect | ScManagerCreateService);
        uint desiredAccess =
            ServiceQueryConfig |
            ServiceChangeConfig |
            ServiceQueryStatus |
            ServiceStart |
            ServiceStop |
            Delete;
        SafeServiceHandle service = NativeMethods.CreateServiceW(
            manager,
            definition.Name,
            definition.DisplayName,
            desiredAccess,
            ServiceWin32OwnProcess,
            definition.Automatic ? ServiceAutoStart : ServiceDemandStart,
            ServiceErrorNormal,
            definition.BinaryPathName,
            null,
            IntPtr.Zero,
            null,
            definition.AccountName,
            null);
        if (service.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            service.Dispose();
            throw new Win32Exception(error, "CreateServiceW failed.");
        }

        using (service)
        {
            try
            {
                var delayed = new SERVICE_DELAYED_AUTO_START_INFO
                {
                    fDelayedAutostart =
                        definition.Automatic && definition.DelayedAutomatic,
                };
                if (!NativeMethods.ChangeServiceConfig2W(
                    service,
                    ServiceConfigDelayedAutoStartInfo,
                    ref delayed))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "ChangeServiceConfig2W(delayed-auto-start) failed.");
                }

                var description = new SERVICE_DESCRIPTION
                {
                    lpDescription = definition.Description,
                };
                if (!NativeMethods.ChangeServiceConfig2W(
                    service,
                    ServiceConfigDescription,
                    ref description))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "ChangeServiceConfig2W(description) failed.");
                }
            }
            catch
            {
                // CreateAsync is atomic from the installer's perspective. If a
                // required post-create property cannot be applied, remove the
                // incomplete registration before surfacing the original error.
                _ = NativeMethods.DeleteService(service);
                throw;
            }
        }

        return ValueTask.CompletedTask;
    }

    public async ValueTask StartAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        EnsureWindows();
        ValidateTimeout(timeout);
        using SafeServiceHandle manager = OpenManager(ScManagerConnect);
        using SafeServiceHandle service = OpenExistingService(
            manager,
            serviceName,
            ServiceStart | ServiceQueryStatus);

        ServiceRuntimeState state = QueryRuntimeState(service);
        if (state == ServiceRuntimeState.Running)
        {
            return;
        }

        if (state != ServiceRuntimeState.StartPending &&
            !NativeMethods.StartServiceW(service, 0, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorServiceAlreadyRunning)
            {
                throw new Win32Exception(error, "StartServiceW failed.");
            }
        }

        await WaitForStateAsync(
            service,
            ServiceRuntimeState.Running,
            timeout,
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask StopAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        EnsureWindows();
        ValidateTimeout(timeout);
        using SafeServiceHandle manager = OpenManager(ScManagerConnect);
        using SafeServiceHandle? service = TryOpenService(
            manager,
            serviceName,
            ServiceStop | ServiceQueryStatus);
        if (service is null)
        {
            return;
        }

        ServiceRuntimeState state = QueryRuntimeState(service);
        if (state == ServiceRuntimeState.Stopped)
        {
            return;
        }

        if (state != ServiceRuntimeState.StopPending)
        {
            var status = new SERVICE_STATUS();
            if (!NativeMethods.ControlService(
                service,
                ServiceControlStop,
                ref status))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorServiceNotActive)
                {
                    throw new Win32Exception(error, "ControlService(STOP) failed.");
                }
            }
        }

        await WaitForStateAsync(
            service,
            ServiceRuntimeState.Stopped,
            timeout,
            cancellationToken).ConfigureAwait(false);
    }

    public ValueTask DeleteAsync(
        string serviceName,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureWindows();
        ValidateServiceName(serviceName);
        using SafeServiceHandle manager = OpenManager(ScManagerConnect);
        using SafeServiceHandle? service = TryOpenService(
            manager,
            serviceName,
            Delete | ServiceQueryStatus);
        if (service is null)
        {
            return ValueTask.CompletedTask;
        }

        if (!NativeMethods.DeleteService(service))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "DeleteService failed.");
        }

        return ValueTask.CompletedTask;
    }

    private static SafeServiceHandle OpenManager(uint access)
    {
        SafeServiceHandle manager = NativeMethods.OpenSCManagerW(
            null,
            null,
            access);
        if (manager.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            manager.Dispose();
            throw new Win32Exception(error, "OpenSCManagerW failed.");
        }

        return manager;
    }

    private static SafeServiceHandle OpenExistingService(
        SafeServiceHandle manager,
        string serviceName,
        uint access) =>
        TryOpenService(manager, serviceName, access) ??
        throw new InvalidOperationException(
            $"Windows service '{serviceName}' does not exist.");

    private static SafeServiceHandle? TryOpenService(
        SafeServiceHandle manager,
        string serviceName,
        uint access)
    {
        ValidateServiceName(serviceName);
        SafeServiceHandle service = NativeMethods.OpenServiceW(
            manager,
            serviceName,
            access);
        if (!service.IsInvalid)
        {
            return service;
        }

        int error = Marshal.GetLastWin32Error();
        service.Dispose();
        if (error == ErrorServiceDoesNotExist)
        {
            return null;
        }

        throw new Win32Exception(error, "OpenServiceW failed.");
    }

    private static ManagedServiceConfiguration QueryConfiguration(
        SafeServiceHandle service)
    {
        _ = NativeMethods.QueryServiceConfigW(
            service,
            IntPtr.Zero,
            0,
            out uint bytesNeeded);
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorInsufficientBuffer || bytesNeeded == 0)
        {
            throw new Win32Exception(error, "QueryServiceConfigW(size) failed.");
        }

        IntPtr buffer = Marshal.AllocHGlobal(checked((int)bytesNeeded));
        try
        {
            if (!NativeMethods.QueryServiceConfigW(
                service,
                buffer,
                bytesNeeded,
                out _))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "QueryServiceConfigW failed.");
            }

            QUERY_SERVICE_CONFIG config =
                Marshal.PtrToStructure<QUERY_SERVICE_CONFIG>(buffer);
            return new ManagedServiceConfiguration(
                config.dwServiceType,
                config.dwStartType,
                config.dwErrorControl,
                Marshal.PtrToStringUni(config.lpBinaryPathName) ?? string.Empty,
                Marshal.PtrToStringUni(config.lpServiceStartName) ?? string.Empty,
                Marshal.PtrToStringUni(config.lpDisplayName) ?? string.Empty);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string QueryDescription(SafeServiceHandle service)
    {
        _ = NativeMethods.QueryServiceConfig2W(
            service,
            ServiceConfigDescription,
            IntPtr.Zero,
            0,
            out uint bytesNeeded);
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorInsufficientBuffer || bytesNeeded == 0)
        {
            throw new Win32Exception(
                error,
                "QueryServiceConfig2W(description size) failed.");
        }

        IntPtr buffer = Marshal.AllocHGlobal(checked((int)bytesNeeded));
        try
        {
            if (!NativeMethods.QueryServiceConfig2W(
                service,
                ServiceConfigDescription,
                buffer,
                bytesNeeded,
                out _))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "QueryServiceConfig2W(description) failed.");
            }

            SERVICE_DESCRIPTION description =
                Marshal.PtrToStructure<SERVICE_DESCRIPTION>(buffer);
            return description.lpDescription ?? string.Empty;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool QueryDelayedAutomatic(SafeServiceHandle service)
    {
        int size = Marshal.SizeOf<SERVICE_DELAYED_AUTO_START_INFO>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!NativeMethods.QueryServiceConfig2W(
                service,
                ServiceConfigDelayedAutoStartInfo,
                buffer,
                checked((uint)size),
                out _))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "QueryServiceConfig2W(delayed-auto-start) failed.");
            }

            return Marshal.PtrToStructure<SERVICE_DELAYED_AUTO_START_INFO>(
                buffer).fDelayedAutostart;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static ServiceRuntimeState QueryRuntimeState(
        SafeServiceHandle service)
    {
        int size = Marshal.SizeOf<SERVICE_STATUS_PROCESS>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!NativeMethods.QueryServiceStatusEx(
                service,
                ScStatusProcessInfo,
                buffer,
                checked((uint)size),
                out _))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "QueryServiceStatusEx failed.");
            }

            SERVICE_STATUS_PROCESS status =
                Marshal.PtrToStructure<SERVICE_STATUS_PROCESS>(buffer);
            return status.dwCurrentState switch
            {
                ServiceStopped => ServiceRuntimeState.Stopped,
                ServiceStartPending => ServiceRuntimeState.StartPending,
                ServiceStopPending => ServiceRuntimeState.StopPending,
                ServiceRunning => ServiceRuntimeState.Running,
                _ => ServiceRuntimeState.Unknown,
            };
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static async Task WaitForStateAsync(
        SafeServiceHandle service,
        ServiceRuntimeState expected,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        long started = Environment.TickCount64;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ServiceRuntimeState current = QueryRuntimeState(service);
            if (current == expected)
            {
                return;
            }

            if (Environment.TickCount64 - started >= timeout.TotalMilliseconds)
            {
                throw new TimeoutException(
                    $"Windows service did not reach '{expected}' within " +
                    $"{timeout.TotalSeconds:0.###} seconds; current state is '{current}'.");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private static void ValidateServiceName(string serviceName)
    {
        if (string.IsNullOrWhiteSpace(serviceName) ||
            serviceName.Length > 256 ||
            serviceName.Contains('\\', StringComparison.Ordinal) ||
            serviceName.Contains('/', StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Windows service name is missing or invalid.",
                nameof(serviceName));
        }
    }

    private static void ValidateTimeout(TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Windows SCM operations are supported only on Windows.");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct QUERY_SERVICE_CONFIG
    {
        internal uint dwServiceType;
        internal uint dwStartType;
        internal uint dwErrorControl;
        internal IntPtr lpBinaryPathName;
        internal IntPtr lpLoadOrderGroup;
        internal uint dwTagId;
        internal IntPtr lpDependencies;
        internal IntPtr lpServiceStartName;
        internal IntPtr lpDisplayName;
    }

    private sealed record ManagedServiceConfiguration(
        uint ServiceType,
        uint StartType,
        uint ErrorControl,
        string BinaryPathName,
        string ServiceStartName,
        string DisplayName);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SERVICE_DESCRIPTION
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        internal string? lpDescription;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_DELAYED_AUTO_START_INFO
    {
        [MarshalAs(UnmanagedType.Bool)]
        internal bool fDelayedAutostart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_STATUS
    {
        internal uint dwServiceType;
        internal uint dwCurrentState;
        internal uint dwControlsAccepted;
        internal uint dwWin32ExitCode;
        internal uint dwServiceSpecificExitCode;
        internal uint dwCheckPoint;
        internal uint dwWaitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_STATUS_PROCESS
    {
        internal uint dwServiceType;
        internal uint dwCurrentState;
        internal uint dwControlsAccepted;
        internal uint dwWin32ExitCode;
        internal uint dwServiceSpecificExitCode;
        internal uint dwCheckPoint;
        internal uint dwWaitHint;
        internal uint dwProcessId;
        internal uint dwServiceFlags;
    }

    private sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeServiceHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle() =>
            NativeMethods.CloseServiceHandle(handle);
    }

    private static class NativeMethods
    {
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeServiceHandle OpenSCManagerW(
            string? machineName,
            string? databaseName,
            uint desiredAccess);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeServiceHandle CreateServiceW(
            SafeServiceHandle serviceManager,
            string serviceName,
            string displayName,
            uint desiredAccess,
            uint serviceType,
            uint startType,
            uint errorControl,
            string binaryPathName,
            string? loadOrderGroup,
            IntPtr tagId,
            string? dependencies,
            string serviceStartName,
            string? password);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeServiceHandle OpenServiceW(
            SafeServiceHandle serviceManager,
            string serviceName,
            uint desiredAccess);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryServiceConfigW(
            SafeServiceHandle service,
            IntPtr serviceConfig,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryServiceConfig2W(
            SafeServiceHandle service,
            uint infoLevel,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ChangeServiceConfig2W(
            SafeServiceHandle service,
            uint infoLevel,
            ref SERVICE_DELAYED_AUTO_START_INFO info);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ChangeServiceConfig2W(
            SafeServiceHandle service,
            uint infoLevel,
            ref SERVICE_DESCRIPTION info);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool StartServiceW(
            SafeServiceHandle service,
            uint argumentCount,
            IntPtr arguments);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ControlService(
            SafeServiceHandle service,
            uint control,
            ref SERVICE_STATUS status);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryServiceStatusEx(
            SafeServiceHandle service,
            int infoLevel,
            IntPtr buffer,
            uint bufferSize,
            out uint bytesNeeded);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteService(SafeServiceHandle service);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseServiceHandle(IntPtr serviceHandle);
    }
}
