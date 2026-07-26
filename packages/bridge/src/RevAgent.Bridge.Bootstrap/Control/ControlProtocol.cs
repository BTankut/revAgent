using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace RevAgent.Bridge.Bootstrap.Control;

internal static class ControlProtocol
{
    internal const int Version = 1;
    internal const int HeaderBytes = sizeof(int);
    internal const int MaxFrameBytes = 64 * 1024;
    internal const string PipeNamePrefix = "revagent.bridge.control.";

    internal const string ReadyType = "ready";
    internal const string StopType = "stop";
    internal const string StoppingType = "stopping";

    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    internal static byte[] Encode(ControlMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);
        ValidateMessage(message);

        var output = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("protocol_version", message.ProtocolVersion);
            writer.WriteString("type", message.Type);
            writer.WriteString("instance_id", message.InstanceId.ToString("D"));

            switch (message)
            {
                case WorkerReady ready:
                    writer.WriteNumber("worker_pid", ready.WorkerPid);
                    writer.WriteString("worker_version", ready.WorkerVersion);
                    break;
                case StopWorker stop:
                    writer.WriteString("reason", stop.Reason);
                    writer.WriteNumber("deadline_unix_ms", stop.DeadlineUnixMs);
                    break;
                case WorkerStopping stopping:
                    writer.WriteNumber("worker_pid", stopping.WorkerPid);
                    break;
                default:
                    throw new ControlProtocolException(
                        "unsupported_control_message",
                        $"Unsupported control message type '{message.GetType().FullName}'.");
            }

            writer.WriteEndObject();
        }

        if (output.WrittenCount == 0 || output.WrittenCount > MaxFrameBytes)
        {
            throw new ControlProtocolException(
                "control_frame_size_invalid",
                $"Control payload is {output.WrittenCount} bytes; the limit is {MaxFrameBytes} bytes.");
        }

        var frame = new byte[HeaderBytes + output.WrittenCount];
        BinaryPrimitives.WriteInt32BigEndian(frame.AsSpan(0, HeaderBytes), output.WrittenCount);
        output.WrittenSpan.CopyTo(frame.AsSpan(HeaderBytes));
        return frame;
    }

    internal static ControlMessage Decode(ReadOnlySpan<byte> payload)
    {
        if (payload.IsEmpty || payload.Length > MaxFrameBytes)
        {
            throw new ControlProtocolException(
                "control_frame_size_invalid",
                $"Control payload is {payload.Length} bytes; expected 1..{MaxFrameBytes} bytes.");
        }

        try
        {
            _ = StrictUtf8.GetString(payload);
        }
        catch (DecoderFallbackException ex)
        {
            throw new ControlProtocolException(
                "control_json_invalid_utf8",
                "Control payload is not valid UTF-8.",
                ex);
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload.ToArray());
        }
        catch (JsonException ex)
        {
            throw new ControlProtocolException(
                "control_json_invalid",
                "Control payload is not one valid JSON value.",
                ex);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new ControlProtocolException(
                    "control_json_not_object",
                    "Control payload root must be an object.");
            }

            RejectDuplicateProperties(root);

            int version = ReadRequiredInt32(root, "protocol_version");
            if (version != Version)
            {
                throw new ControlProtocolException(
                    "control_protocol_version_mismatch",
                    $"Control protocol version {version} is unsupported; expected {Version}.");
            }

            string type = ReadRequiredString(root, "type", 32);
            Guid instanceId = ReadRequiredGuid(root, "instance_id");

            return type switch
            {
                ReadyType => new WorkerReady(
                    version,
                    instanceId,
                    ReadRequiredPositiveInt32(root, "worker_pid"),
                    ReadRequiredString(root, "worker_version", 128)),
                StopType => new StopWorker(
                    version,
                    instanceId,
                    ReadRequiredString(root, "reason", 64),
                    ReadRequiredPositiveInt64(root, "deadline_unix_ms")),
                StoppingType => new WorkerStopping(
                    version,
                    instanceId,
                    ReadRequiredPositiveInt32(root, "worker_pid")),
                _ => throw new ControlProtocolException(
                    "control_message_type_unknown",
                    $"Unknown control message type '{type}'."),
            };
        }
    }

    internal static int ReadFrameLength(ReadOnlySpan<byte> header)
    {
        if (header.Length != HeaderBytes)
        {
            throw new ArgumentException(
                $"Control frame header must be exactly {HeaderBytes} bytes.",
                nameof(header));
        }

        int length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length <= 0 || length > MaxFrameBytes)
        {
            throw new ControlProtocolException(
                "control_frame_size_invalid",
                $"Control frame declares {length} bytes; expected 1..{MaxFrameBytes} bytes.");
        }

        return length;
    }

    private static void RejectDuplicateProperties(JsonElement root)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (!names.Add(property.Name))
            {
                throw new ControlProtocolException(
                    "control_json_duplicate_property",
                    $"Control payload contains duplicate property '{property.Name}'.");
            }
        }
    }

    private static string ReadRequiredString(
        JsonElement root,
        string propertyName,
        int maxLength)
    {
        if (!root.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.String)
        {
            throw MissingOrInvalid(propertyName);
        }

        string? result = value.GetString();
        if (string.IsNullOrWhiteSpace(result) || result.Length > maxLength)
        {
            throw MissingOrInvalid(propertyName);
        }

        return result;
    }

    private static int ReadRequiredInt32(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt32(out int result))
        {
            throw MissingOrInvalid(propertyName);
        }

        return result;
    }

    private static int ReadRequiredPositiveInt32(JsonElement root, string propertyName)
    {
        int result = ReadRequiredInt32(root, propertyName);
        if (result <= 0)
        {
            throw MissingOrInvalid(propertyName);
        }

        return result;
    }

    private static long ReadRequiredPositiveInt64(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt64(out long result) ||
            result <= 0)
        {
            throw MissingOrInvalid(propertyName);
        }

        return result;
    }

    private static Guid ReadRequiredGuid(JsonElement root, string propertyName)
    {
        string value = ReadRequiredString(root, propertyName, 36);
        if (!Guid.TryParseExact(value, "D", out Guid result) ||
            result == Guid.Empty)
        {
            throw MissingOrInvalid(propertyName);
        }

        return result;
    }

    private static ControlProtocolException MissingOrInvalid(string propertyName) =>
        new(
            "control_property_invalid",
            $"Control property '{propertyName}' is missing or invalid.");

    private static void ValidateMessage(ControlMessage message)
    {
        if (message.ProtocolVersion != Version)
        {
            throw new ControlProtocolException(
                "control_protocol_version_mismatch",
                $"Control protocol version {message.ProtocolVersion} is unsupported; " +
                $"expected {Version}.");
        }

        if (message.InstanceId == Guid.Empty)
        {
            throw new ControlProtocolException(
                "control_instance_invalid",
                "Control instance ID must not be empty.");
        }

        switch (message)
        {
            case WorkerReady ready when
                ready.WorkerPid <= 0 ||
                string.IsNullOrWhiteSpace(ready.WorkerVersion) ||
                ready.WorkerVersion.Length > 128:
                throw new ControlProtocolException(
                    "control_ready_invalid",
                    "READY PID or worker version is invalid.");
            case StopWorker stop when
                string.IsNullOrWhiteSpace(stop.Reason) ||
                stop.Reason.Length > 64 ||
                stop.DeadlineUnixMs <= 0:
                throw new ControlProtocolException(
                    "control_stop_invalid",
                    "STOP reason or deadline is invalid.");
            case WorkerStopping stopping when stopping.WorkerPid <= 0:
                throw new ControlProtocolException(
                    "control_stopping_invalid",
                    "STOPPING PID is invalid.");
        }
    }
}

internal abstract record ControlMessage(
    int ProtocolVersion,
    Guid InstanceId,
    string Type);

internal sealed record WorkerReady(
    int ProtocolVersion,
    Guid InstanceId,
    int WorkerPid,
    string WorkerVersion)
    : ControlMessage(ProtocolVersion, InstanceId, ControlProtocol.ReadyType);

internal sealed record StopWorker(
    int ProtocolVersion,
    Guid InstanceId,
    string Reason,
    long DeadlineUnixMs)
    : ControlMessage(ProtocolVersion, InstanceId, ControlProtocol.StopType);

internal sealed record WorkerStopping(
    int ProtocolVersion,
    Guid InstanceId,
    int WorkerPid)
    : ControlMessage(ProtocolVersion, InstanceId, ControlProtocol.StoppingType);

internal sealed class ControlProtocolException : Exception
{
    internal ControlProtocolException(
        string code,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    internal string Code { get; }
}
