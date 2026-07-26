using System.Buffers;
using System.Globalization;
using System.Text.Json;

namespace RevAgent.Bridge.Bootstrap.Logging;

internal sealed class RollingJsonBridgeLog : IBridgeLog
{
    private const string FileExtension = ".jsonl";
    private readonly string _directoryPath;
    private readonly string _filePrefix;
    private readonly long _maxFileBytes;
    private readonly int _retainedFileCount;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private DateOnly? _currentDate;
    private int _currentSequence;
    private string? _currentPath;
    private bool _disposed;

    internal RollingJsonBridgeLog(
        string directoryPath,
        string filePrefix,
        long maxFileBytes,
        int retainedFileCount,
        TimeProvider? timeProvider = null)
    {
        if (string.IsNullOrWhiteSpace(directoryPath))
        {
            throw new ArgumentException(
                "A log directory path is required.",
                nameof(directoryPath));
        }

        if (!IsSafeFilePrefix(filePrefix))
        {
            throw new ArgumentException(
                "The log file prefix must be one safe file-name segment.",
                nameof(filePrefix));
        }

        if (maxFileBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxFileBytes),
                "The maximum log file size must be greater than zero.");
        }

        if (retainedFileCount <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(retainedFileCount),
                "The retained log file count must be greater than zero.");
        }

        _directoryPath = Path.GetFullPath(directoryPath);
        _filePrefix = filePrefix;
        _maxFileBytes = maxFileBytes;
        _retainedFileCount = retainedFileCount;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async ValueTask WriteAsync(
        string level,
        string eventId,
        string category,
        string message,
        Exception? exception = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(level);
        ArgumentException.ThrowIfNullOrWhiteSpace(eventId);
        ArgumentException.ThrowIfNullOrWhiteSpace(category);
        ArgumentNullException.ThrowIfNull(message);

        cancellationToken.ThrowIfCancellationRequested();
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            Directory.CreateDirectory(_directoryPath);

            var timestampUtc = _timeProvider.GetUtcNow().ToUniversalTime();
            var line = SerializeLine(
                timestampUtc,
                level,
                eventId,
                category,
                message,
                exception);
            var date = DateOnly.FromDateTime(timestampUtc.UtcDateTime);

            SelectCurrentFile(date);
            RotateForSizeIfRequired(date, line.Length);

            await using (var stream = new FileStream(
                _currentPath!,
                FileMode.Append,
                FileAccess.Write,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(line, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            ApplyRetention();
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            _disposed = true;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private void SelectCurrentFile(DateOnly date)
    {
        if (_currentDate == date && _currentPath is not null)
        {
            return;
        }

        var latest = EnumerateOwnedLogFiles()
            .Where(file => file.Date == date)
            .OrderByDescending(file => file.Sequence)
            .FirstOrDefault();

        _currentDate = date;
        _currentSequence = latest?.Sequence ?? 0;
        _currentPath = latest?.Path ?? BuildPath(date, _currentSequence);
    }

    private void RotateForSizeIfRequired(DateOnly date, int nextLineBytes)
    {
        var currentLength = File.Exists(_currentPath)
            ? new FileInfo(_currentPath!).Length
            : 0;

        if (currentLength == 0 || currentLength + nextLineBytes <= _maxFileBytes)
        {
            return;
        }

        checked
        {
            _currentSequence++;
        }

        _currentDate = date;
        _currentPath = BuildPath(date, _currentSequence);
    }

    private void ApplyRetention()
    {
        var files = EnumerateOwnedLogFiles()
            .OrderBy(file => file.Date)
            .ThenBy(file => file.Sequence)
            .ToList();

        var deleteCount = files.Count - _retainedFileCount;
        for (var index = 0; index < deleteCount; index++)
        {
            File.Delete(files[index].Path);
        }
    }

    private IEnumerable<OwnedLogFile> EnumerateOwnedLogFiles()
    {
        if (!Directory.Exists(_directoryPath))
        {
            yield break;
        }

        foreach (var path in Directory.EnumerateFiles(
            _directoryPath,
            $"{_filePrefix}-*{FileExtension}",
            SearchOption.TopDirectoryOnly))
        {
            if (TryParseOwnedLogFile(path, out var file))
            {
                yield return file;
            }
        }
    }

    private bool TryParseOwnedLogFile(string path, out OwnedLogFile file)
    {
        var name = Path.GetFileName(path);
        var prefix = $"{_filePrefix}-";
        if (!name.StartsWith(prefix, StringComparison.Ordinal) ||
            !name.EndsWith(FileExtension, StringComparison.Ordinal))
        {
            file = default!;
            return false;
        }

        var identity = name.Substring(
            prefix.Length,
            name.Length - prefix.Length - FileExtension.Length);
        var separatorIndex = identity.LastIndexOf('-');
        if (separatorIndex <= 0 ||
            separatorIndex == identity.Length - 1)
        {
            file = default!;
            return false;
        }

        var dateText = identity[..separatorIndex];
        var sequenceText = identity[(separatorIndex + 1)..];
        if (!DateOnly.TryParseExact(
                dateText,
                "yyyyMMdd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var date) ||
            !int.TryParse(
                sequenceText,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var sequence) ||
            sequence < 0)
        {
            file = default!;
            return false;
        }

        file = new OwnedLogFile(path, date, sequence);
        return true;
    }

    private string BuildPath(DateOnly date, int sequence)
    {
        var fileName = string.Create(
            CultureInfo.InvariantCulture,
            $"{_filePrefix}-{date:yyyyMMdd}-{sequence:D4}{FileExtension}");
        return Path.Combine(_directoryPath, fileName);
    }

    private static bool IsSafeFilePrefix(string? filePrefix)
    {
        if (string.IsNullOrEmpty(filePrefix) || filePrefix is "." or "..")
        {
            return false;
        }

        foreach (var character in filePrefix)
        {
            if (!char.IsAsciiLetterOrDigit(character) &&
                character is not '-' and not '_' and not '.')
            {
                return false;
            }
        }

        return true;
    }

    private static byte[] SerializeLine(
        DateTimeOffset timestampUtc,
        string level,
        string eventId,
        string category,
        string message,
        Exception? exception)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(
            buffer,
            new JsonWriterOptions
            {
                Indented = false,
                SkipValidation = false,
            }))
        {
            writer.WriteStartObject();
            writer.WriteString(
                "timestampUtc",
                timestampUtc.ToString("O", CultureInfo.InvariantCulture));
            writer.WriteString("level", level);
            writer.WriteString("eventId", eventId);
            writer.WriteString("category", category);
            writer.WriteString("message", message);

            writer.WritePropertyName("exception");
            if (exception is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                writer.WriteStartObject();
                writer.WriteString(
                    "type",
                    exception.GetType().FullName ?? exception.GetType().Name);
                writer.WriteString("message", exception.Message);
                if (exception.StackTrace is null)
                {
                    writer.WriteNull("stackTrace");
                }
                else
                {
                    writer.WriteString("stackTrace", exception.StackTrace);
                }

                writer.WriteEndObject();
            }

            writer.WriteEndObject();
            writer.Flush();
        }

        var line = new byte[buffer.WrittenCount + 1];
        buffer.WrittenSpan.CopyTo(line);
        line[^1] = (byte)'\n';
        return line;
    }

    private sealed record OwnedLogFile(
        string Path,
        DateOnly Date,
        int Sequence);
}
