using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Signing;

public static class CanonicalJson
{
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    public static string Serialize(JToken? value)
    {
        var builder = new StringBuilder();
        Append(value ?? JValue.CreateNull(), builder);
        return builder.ToString();
    }

    public static byte[] SerializeUtf8(JToken? value)
    {
        return StrictUtf8.GetBytes(Serialize(value));
    }

    public static string Sha256Hex(JToken? value)
    {
        return Sha256Hex(SerializeUtf8(value));
    }

    public static string Sha256Hex(byte[] bytes)
    {
        if (bytes is null)
        {
            throw new ArgumentNullException(nameof(bytes));
        }

        using var sha256 = SHA256.Create();
        return BitConverter.ToString(sha256.ComputeHash(bytes)).Replace("-", string.Empty);
    }

    private static void Append(JToken value, StringBuilder builder)
    {
        switch (value.Type)
        {
            case JTokenType.Null:
                builder.Append("null");
                return;
            case JTokenType.Boolean:
                builder.Append(value.Value<bool>() ? "true" : "false");
                return;
            case JTokenType.Integer:
                AppendInteger((JValue)value, builder);
                return;
            case JTokenType.String:
                AppendString(value.Value<string>() ?? string.Empty, builder);
                return;
            case JTokenType.Array:
                AppendArray((JArray)value, builder);
                return;
            case JTokenType.Object:
                AppendObject((JObject)value, builder);
                return;
            case JTokenType.Float:
                throw new InvalidOperationException(
                    "Canonical JSON supports integers only; floating-point and decimal values are rejected.");
            default:
                throw new InvalidOperationException(
                    $"Unsupported token type for canonical JSON: {value.Type}.");
        }
    }

    private static void AppendInteger(JValue value, StringBuilder builder)
    {
        if (value.Value is not (
                byte
                or sbyte
                or short
                or ushort
                or int
                or uint
                or long
                or ulong))
        {
            throw new InvalidOperationException(
                $"Unsupported integer type for canonical JSON: "
                + $"{value.Value?.GetType().FullName ?? "<null>"}.");
        }

        if (value.Value is not IFormattable formattable)
        {
            throw new InvalidOperationException("Canonical JSON integer is not formattable.");
        }

        builder.Append(formattable.ToString(null, CultureInfo.InvariantCulture));
    }

    private static void AppendArray(JArray array, StringBuilder builder)
    {
        builder.Append('[');
        for (var index = 0; index < array.Count; index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }

            Append(array[index] ?? JValue.CreateNull(), builder);
        }

        builder.Append(']');
    }

    private static void AppendObject(JObject value, StringBuilder builder)
    {
        builder.Append('{');
        var properties = value.Properties().OrderBy(
            property => property.Name,
            StringComparer.Ordinal);
        var first = true;
        foreach (var property in properties)
        {
            if (!first)
            {
                builder.Append(',');
            }

            first = false;
            AppendString(property.Name, builder);
            builder.Append(':');
            Append(property.Value, builder);
        }

        builder.Append('}');
    }

    private static void AppendString(string value, StringBuilder builder)
    {
        builder.Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                default:
                    if (character < 0x20)
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(character);
                    }

                    break;
            }
        }

        builder.Append('"');
    }
}
