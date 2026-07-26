using RevAgent.Bridge.Bootstrap;
using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;

namespace RevAgent.Bridge.Host.Platform;

internal sealed class WindowsLifecycleEventLog : ILifecycleEventLog
{
    private const string LogName = "Application";

    private readonly string _sourceName;

    internal WindowsLifecycleEventLog(string? sourceName = null)
    {
        _sourceName = sourceName ?? BridgeInstallLayout.EventSourceName;
    }

    public bool EnsureSource()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Windows Event Log operations are supported only on Windows.");
        }

        if (EventLog.SourceExists(_sourceName))
        {
            string existingLog = EventLog.LogNameFromSourceName(
                _sourceName,
                ".");
            if (!string.Equals(existingLog, LogName, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Event source '{_sourceName}' already belongs to log '{existingLog}'.");
            }

            return false;
        }

        EventLog.CreateEventSource(
            new EventSourceCreationData(_sourceName, LogName));
        return true;
    }

    public void Write(LifecycleEvent entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Windows Event Log operations are supported only on Windows.");
        }

        string message = JsonSerializer.Serialize(
            new
            {
                timestamp_utc = entry.Timestamp.ToUniversalTime(),
                event_code = entry.Code,
                message = entry.Message,
            });
        EventLog.WriteEntry(
            _sourceName,
            message,
            ToEntryType(entry.Level),
            entry.EventId);
    }

    public void RemoveSource()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Windows Event Log operations are supported only on Windows.");
        }

        if (EventLog.SourceExists(_sourceName))
        {
            string existingLog = EventLog.LogNameFromSourceName(
                _sourceName,
                ".");
            if (!string.Equals(
                existingLog,
                LogName,
                StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Event source '{_sourceName}' belongs to log '{existingLog}', " +
                    $"not '{LogName}'.");
            }

            EventLog.DeleteEventSource(_sourceName);
        }
    }

    [SupportedOSPlatform("windows")]
    private static EventLogEntryType ToEntryType(LifecycleEventLevel level) =>
        level switch
        {
            LifecycleEventLevel.Information => EventLogEntryType.Information,
            LifecycleEventLevel.Warning => EventLogEntryType.Warning,
            LifecycleEventLevel.Error => EventLogEntryType.Error,
            _ => throw new ArgumentOutOfRangeException(nameof(level)),
        };

}
