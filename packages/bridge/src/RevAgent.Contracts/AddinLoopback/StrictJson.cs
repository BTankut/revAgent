using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Strict JSON boundary for add-in loopback messages. Newtonsoft.Json is
    /// intentionally narrowed to RFC 8259 behavior before a token is exposed.
    /// </summary>
    public static class StrictJson
    {
        private static readonly UTF8Encoding StrictUtf8 =
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

        public static JObject ParseObject(byte[] utf8)
        {
            if (utf8 == null)
            {
                throw new ArgumentNullException(nameof(utf8));
            }

            if (utf8.Length == 0)
            {
                throw new StrictJsonException(
                    "empty_payload",
                    "A JSON frame payload cannot be empty.");
            }

            if (utf8.Length >= 3 &&
                utf8[0] == 0xef &&
                utf8[1] == 0xbb &&
                utf8[2] == 0xbf)
            {
                throw new StrictJsonException(
                    "utf8_bom_not_allowed",
                    "A JSON frame payload must not contain a UTF-8 BOM.");
            }

            string json;
            try
            {
                json = StrictUtf8.GetString(utf8);
            }
            catch (DecoderFallbackException ex)
            {
                throw new StrictJsonException(
                    "invalid_utf8",
                    "A JSON frame payload must be valid UTF-8.",
                    ex);
            }

            return ParseObject(json);
        }

        public static JObject ParseObject(string json)
        {
            if (json == null)
            {
                throw new ArgumentNullException(nameof(json));
            }

            if (json.Length == 0)
            {
                throw new StrictJsonException(
                    "empty_payload",
                    "A JSON frame payload cannot be empty.");
            }

            if (json[0] == '\ufeff')
            {
                throw new StrictJsonException(
                    "utf8_bom_not_allowed",
                    "A JSON frame payload must not contain a BOM.");
            }

            try
            {
                StrictUtf8.GetByteCount(json);
            }
            catch (EncoderFallbackException ex)
            {
                throw new StrictJsonException(
                    "invalid_utf16",
                    "The JSON text contains an unpaired UTF-16 surrogate.",
                    ex);
            }

            IReadOnlyList<string> numberLexemes =
                ValidateLexicalExtensions(json);
            ValidateTokenStream(json);

            try
            {
                JToken parsed;
                using (var stringReader = new StringReader(json))
                using (var reader = new JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = DateParseHandling.None;
                    reader.FloatParseHandling = FloatParseHandling.Double;
                    parsed = JToken.ReadFrom(reader);
                }

                var result = parsed as JObject;
                if (result == null)
                {
                    throw new StrictJsonException(
                        "root_must_be_object",
                        "An add-in loopback JSON frame must contain one object.");
                }

                AttachNumberLexemes(result, numberLexemes);
                return result;
            }
            catch (StrictJsonException)
            {
                throw;
            }
            catch (JsonException ex)
            {
                throw new StrictJsonException(
                    "invalid_json",
                    "The frame payload is not valid JSON.",
                    ex);
            }
        }

        internal static T DeepClonePreservingNumberLexemes<T>(T source)
            where T : JToken
        {
            if (source == null)
            {
                throw new ArgumentNullException(nameof(source));
            }

            var clone = (T)source.DeepClone();
            JToken[] sourceNumbers = NumericTokens(source).ToArray();
            JToken[] clonedNumbers = NumericTokens(clone).ToArray();
            if (sourceNumbers.Length != clonedNumbers.Length)
            {
                throw new InvalidOperationException(
                    "A strict JSON clone changed the numeric token sequence.");
            }

            for (int index = 0; index < sourceNumbers.Length; index++)
            {
                StrictJsonNumberLexeme? annotation =
                    sourceNumbers[index].Annotation<StrictJsonNumberLexeme>();
                if (annotation != null)
                {
                    clonedNumbers[index].AddAnnotation(annotation);
                }
            }

            return clone;
        }

        private static IReadOnlyList<string> ValidateLexicalExtensions(
            string json)
        {
            var numberLexemes = new List<string>();
            bool inString = false;
            bool escaped = false;

            for (int i = 0; i < json.Length; i++)
            {
                char current = json[i];
                if (inString)
                {
                    if (current < '\u0020')
                    {
                        throw new StrictJsonException(
                            "unescaped_control_character",
                            "JSON strings must escape characters below U+0020.");
                    }

                    if (escaped)
                    {
                        if (current == 'u')
                        {
                            if (i + 4 >= json.Length ||
                                !IsHexDigit(json[i + 1]) ||
                                !IsHexDigit(json[i + 2]) ||
                                !IsHexDigit(json[i + 3]) ||
                                !IsHexDigit(json[i + 4]))
                            {
                                throw InvalidJsonEscape();
                            }

                            i += 4;
                        }
                        else if (current != '"' &&
                                 current != '\\' &&
                                 current != '/' &&
                                 current != 'b' &&
                                 current != 'f' &&
                                 current != 'n' &&
                                 current != 'r' &&
                                 current != 't')
                        {
                            throw InvalidJsonEscape();
                        }

                        escaped = false;
                    }
                    else if (current == '\\')
                    {
                        escaped = true;
                    }
                    else if (current == '"')
                    {
                        inString = false;
                    }

                    continue;
                }

                if (current == '"')
                {
                    inString = true;
                    continue;
                }

                if (char.IsWhiteSpace(current) && !IsJsonWhitespace(current))
                {
                    throw new StrictJsonException(
                        "invalid_json_whitespace",
                        "Only space, tab, carriage return, and line feed are JSON whitespace.");
                }

                if (current == '\'')
                {
                    throw new StrictJsonException(
                        "single_quoted_string_not_allowed",
                        "Single-quoted JSON strings and property names are not allowed.");
                }

                if (current == '/' &&
                    i + 1 < json.Length &&
                    (json[i + 1] == '/' || json[i + 1] == '*'))
                {
                    throw new StrictJsonException(
                        "comments_not_allowed",
                        "JSON comments are not allowed.");
                }

                if (IsNumberStart(current))
                {
                    int numberEnd = ValidateRfc8259Number(json, i);
                    numberLexemes.Add(json.Substring(i, numberEnd - i));
                    i = numberEnd - 1;
                    continue;
                }

                if (current == ',')
                {
                    int next = i + 1;
                    while (next < json.Length && IsJsonWhitespace(json[next]))
                    {
                        next++;
                    }

                    if (next < json.Length &&
                        (json[next] == '}' || json[next] == ']'))
                    {
                        throw new StrictJsonException(
                            "trailing_comma_not_allowed",
                            "Trailing commas are not allowed.");
                    }
                }
            }

            if (escaped)
            {
                throw InvalidJsonEscape();
            }

            return numberLexemes;
        }

        private static int ValidateRfc8259Number(string json, int start)
        {
            int index = start;
            if (json[index] == '+')
            {
                throw InvalidJsonNumber();
            }

            if (json[index] == '-')
            {
                index++;
                if (index >= json.Length)
                {
                    throw InvalidJsonNumber();
                }
            }

            if (json[index] == '0')
            {
                index++;
                if (index < json.Length && IsAsciiDigit(json[index]))
                {
                    throw InvalidJsonNumber();
                }
            }
            else if (json[index] >= '1' && json[index] <= '9')
            {
                do
                {
                    index++;
                }
                while (index < json.Length && IsAsciiDigit(json[index]));
            }
            else
            {
                // A leading decimal point and signed non-number extensions
                // such as -Infinity are not part of the JSON number grammar.
                throw InvalidJsonNumber();
            }

            if (index < json.Length && json[index] == '.')
            {
                index++;
                int fractionStart = index;
                while (index < json.Length && IsAsciiDigit(json[index]))
                {
                    index++;
                }

                if (index == fractionStart)
                {
                    throw InvalidJsonNumber();
                }
            }

            if (index < json.Length &&
                (json[index] == 'e' || json[index] == 'E'))
            {
                index++;
                if (index < json.Length &&
                    (json[index] == '+' || json[index] == '-'))
                {
                    index++;
                }

                int exponentStart = index;
                while (index < json.Length && IsAsciiDigit(json[index]))
                {
                    index++;
                }

                if (index == exponentStart)
                {
                    throw InvalidJsonNumber();
                }
            }

            if (index < json.Length && !IsNumberTerminator(json[index]))
            {
                throw InvalidJsonNumber();
            }

            return index;
        }

        private static StrictJsonException InvalidJsonNumber()
        {
            return new StrictJsonException(
                "invalid_json_number",
                "JSON numbers must use the RFC 8259 number grammar.");
        }

        private static bool IsNumberStart(char value)
        {
            return value == '-' ||
                   value == '+' ||
                   value == '.' ||
                   IsAsciiDigit(value);
        }

        private static bool IsAsciiDigit(char value)
        {
            return value >= '0' && value <= '9';
        }

        private static bool IsHexDigit(char value)
        {
            return (value >= '0' && value <= '9') ||
                   (value >= 'a' && value <= 'f') ||
                   (value >= 'A' && value <= 'F');
        }

        private static StrictJsonException InvalidJsonEscape()
        {
            return new StrictJsonException(
                "invalid_json_escape",
                "JSON strings may use only the RFC 8259 escape sequences.");
        }

        private static bool IsNumberTerminator(char value)
        {
            return IsJsonWhitespace(value) ||
                   value == ',' ||
                   value == ']' ||
                   value == '}';
        }

        private static void ValidateTokenStream(string json)
        {
            var containers = new Stack<ObjectPropertySet>();
            int rootValues = 0;

            try
            {
                using (var stringReader = new StringReader(json))
                using (var reader = new JsonTextReader(stringReader))
                {
                    reader.CloseInput = false;
                    reader.DateParseHandling = DateParseHandling.None;
                    reader.FloatParseHandling = FloatParseHandling.Double;
                    reader.SupportMultipleContent = true;

                    while (reader.Read())
                    {
                        switch (reader.TokenType)
                        {
                            case JsonToken.Comment:
                                throw new StrictJsonException(
                                    "comments_not_allowed",
                                    "JSON comments are not allowed.");

                            case JsonToken.StartObject:
                                CountRootValueIfNeeded(containers, ref rootValues);
                                containers.Push(new ObjectPropertySet(isObject: true));
                                break;

                            case JsonToken.StartArray:
                                CountRootValueIfNeeded(containers, ref rootValues);
                                containers.Push(new ObjectPropertySet(isObject: false));
                                break;

                            case JsonToken.EndObject:
                                PopExpected(containers, expectedObject: true);
                                break;

                            case JsonToken.EndArray:
                                PopExpected(containers, expectedObject: false);
                                break;

                            case JsonToken.PropertyName:
                                if (reader.QuoteChar != '"')
                                {
                                    throw new StrictJsonException(
                                        "single_quoted_string_not_allowed",
                                        "Single-quoted property names are not allowed.");
                                }

                                if (containers.Count == 0 || !containers.Peek().IsObject)
                                {
                                    throw new StrictJsonException(
                                        "invalid_json",
                                        "A property name appeared outside an object.");
                                }

                                string propertyName = Convert.ToString(
                                    reader.Value,
                                    CultureInfo.InvariantCulture);
                                if (!containers.Peek().Properties.Add(propertyName))
                                {
                                    throw new StrictJsonException(
                                        "duplicate_property",
                                        "Duplicate JSON property '" + propertyName + "' is not allowed.");
                                }

                                break;

                            case JsonToken.String:
                                if (reader.QuoteChar != '"')
                                {
                                    throw new StrictJsonException(
                                        "single_quoted_string_not_allowed",
                                        "Single-quoted string values are not allowed.");
                                }

                                CountRootValueIfNeeded(containers, ref rootValues);
                                break;

                            case JsonToken.Integer:
                            case JsonToken.Boolean:
                            case JsonToken.Null:
                                CountRootValueIfNeeded(containers, ref rootValues);
                                break;

                            case JsonToken.Float:
                                double value = Convert.ToDouble(
                                    reader.Value,
                                    CultureInfo.InvariantCulture);
                                if (double.IsNaN(value) || double.IsInfinity(value))
                                {
                                    throw new StrictJsonException(
                                        "invalid_json_number",
                                        "Non-finite JSON numbers are not allowed.");
                                }

                                CountRootValueIfNeeded(containers, ref rootValues);
                                break;

                            case JsonToken.Undefined:
                            case JsonToken.StartConstructor:
                            case JsonToken.Date:
                            case JsonToken.Bytes:
                            case JsonToken.Raw:
                                throw new StrictJsonException(
                                    "invalid_json_token",
                                    "The payload contains a non-JSON token.");
                        }
                    }
                }
            }
            catch (StrictJsonException)
            {
                throw;
            }
            catch (JsonException ex)
            {
                throw new StrictJsonException(
                    "invalid_json",
                    "The frame payload is not valid JSON.",
                    ex);
            }

            if (containers.Count != 0 || rootValues == 0)
            {
                throw new StrictJsonException(
                    "invalid_json",
                    "The frame payload is incomplete JSON.");
            }

            if (rootValues != 1)
            {
                throw new StrictJsonException(
                    "trailing_content",
                    "The frame payload must contain exactly one JSON value.");
            }
        }

        private static void CountRootValueIfNeeded(
            Stack<ObjectPropertySet> containers,
            ref int rootValues)
        {
            if (containers.Count == 0)
            {
                rootValues++;
            }
        }

        private static void PopExpected(
            Stack<ObjectPropertySet> containers,
            bool expectedObject)
        {
            if (containers.Count == 0 ||
                containers.Pop().IsObject != expectedObject)
            {
                throw new StrictJsonException(
                    "invalid_json",
                    "JSON container boundaries are invalid.");
            }
        }

        private static bool IsJsonWhitespace(char value)
        {
            return value == ' ' || value == '\t' || value == '\r' || value == '\n';
        }

        private static void AttachNumberLexemes(
            JToken root,
            IReadOnlyList<string> numberLexemes)
        {
            JToken[] numericTokens = NumericTokens(root).ToArray();
            if (numericTokens.Length != numberLexemes.Count)
            {
                throw new StrictJsonException(
                    "invalid_json",
                    "The parsed numeric token sequence did not match the JSON text.");
            }

            for (int index = 0; index < numericTokens.Length; index++)
            {
                numericTokens[index].AddAnnotation(
                    new StrictJsonNumberLexeme(numberLexemes[index]));
            }
        }

        private static IEnumerable<JToken> NumericTokens(JToken root)
        {
            if (root.Type == JTokenType.Integer ||
                root.Type == JTokenType.Float)
            {
                yield return root;
            }

            if (root is not JContainer container)
            {
                yield break;
            }

            foreach (JToken token in container.Descendants())
            {
                if (token.Type == JTokenType.Integer ||
                    token.Type == JTokenType.Float)
                {
                    yield return token;
                }
            }
        }

        private sealed class ObjectPropertySet
        {
            public ObjectPropertySet(bool isObject)
            {
                IsObject = isObject;
                Properties = new HashSet<string>(StringComparer.Ordinal);
            }

            public bool IsObject { get; }

            public HashSet<string> Properties { get; }
        }
    }

    internal sealed class StrictJsonNumberLexeme
    {
        internal StrictJsonNumberLexeme(string text)
        {
            Text = text;
        }

        internal string Text { get; }
    }
}
