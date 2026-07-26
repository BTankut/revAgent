using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevAgent.Bridge.Gateway.Protocol;

internal sealed record RbpSchemaFailure(string Path, string Message);

internal static class RbpFrozenSchemaValidator
{
    private const string ResourcePrefix =
        "RevAgent.Bridge.ProtocolSchemas.";
    private static readonly FrozenSchemaSet Schemas = new();

    internal static RbpSchemaFailure? ValidateEnvelope(JsonElement envelope)
    {
        var evaluator = new FrozenJsonSchemaEvaluator(Schemas);
        return evaluator.Validate(
            envelope,
            Schemas.Envelope.RootElement,
            Schemas.Envelope.Name,
            "/");
    }

    internal static IReadOnlyDictionary<string, string> SchemaDigests =>
        Schemas.Digests;

    private sealed class FrozenSchemaSet
    {
        private readonly IReadOnlyDictionary<string, FrozenSchemaDocument>
            _documents;

        internal FrozenSchemaSet()
        {
            var documents =
                new Dictionary<string, FrozenSchemaDocument>(
                    StringComparer.Ordinal)
                {
                    ["common.schema.json"] =
                        Load("common.schema.json"),
                    ["envelope.schema.json"] =
                        Load("envelope.schema.json"),
                    ["payloads.schema.json"] =
                        Load("payloads.schema.json"),
                };
            _documents = documents;
            Envelope = documents["envelope.schema.json"];
            Digests = documents.ToDictionary(
                item => item.Key,
                item => item.Value.Sha256,
                StringComparer.Ordinal);
        }

        internal FrozenSchemaDocument Envelope { get; }

        internal IReadOnlyDictionary<string, string> Digests { get; }

        internal (
            JsonElement Schema,
            string DocumentName) Resolve(
            string currentDocument,
            string reference)
        {
            int fragmentIndex = reference.IndexOf('#');
            string documentName = fragmentIndex < 0
                ? reference
                : reference[..fragmentIndex];
            string fragment = fragmentIndex < 0
                ? string.Empty
                : reference[(fragmentIndex + 1)..];
            if (documentName.Length == 0)
            {
                documentName = currentDocument;
            }

            if (!_documents.TryGetValue(
                    documentName,
                    out FrozenSchemaDocument? document))
            {
                throw new InvalidOperationException(
                    $"Unknown embedded RBP schema '{documentName}'.");
            }

            JsonElement schema = document.RootElement;
            if (fragment.Length == 0)
            {
                return (schema, documentName);
            }

            if (fragment[0] != '/')
            {
                throw new InvalidOperationException(
                    $"Unsupported RBP schema fragment '#{fragment}'.");
            }

            foreach (string encodedToken in fragment[1..].Split('/'))
            {
                string token = encodedToken
                    .Replace("~1", "/", StringComparison.Ordinal)
                    .Replace("~0", "~", StringComparison.Ordinal);
                if (schema.ValueKind != JsonValueKind.Object ||
                    !schema.TryGetProperty(token, out schema))
                {
                    throw new InvalidOperationException(
                        $"Unresolved RBP schema reference '{reference}'.");
                }
            }

            return (schema, documentName);
        }

        private static FrozenSchemaDocument Load(string name)
        {
            Assembly assembly = typeof(RbpFrozenSchemaValidator).Assembly;
            string resourceName = ResourcePrefix + name;
            using Stream stream =
                assembly.GetManifestResourceStream(resourceName) ??
                throw new InvalidOperationException(
                    $"Missing embedded RBP schema '{resourceName}'.");
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            byte[] bytes = memory.ToArray();
            return new FrozenSchemaDocument(
                name,
                bytes,
                JsonDocument.Parse(bytes));
        }
    }

    private sealed class FrozenSchemaDocument
    {
        internal FrozenSchemaDocument(
            string name,
            byte[] bytes,
            JsonDocument document)
        {
            Name = name;
            Document = document;
            Sha256 = Convert.ToHexString(SHA256.HashData(bytes))
                .ToLowerInvariant();
        }

        private JsonDocument Document { get; }

        internal string Name { get; }

        internal JsonElement RootElement => Document.RootElement;

        internal string Sha256 { get; }
    }

    private sealed class FrozenJsonSchemaEvaluator
    {
        private const int MaximumSchemaDepth = 256;
        private static readonly Regex Rfc3339Pattern = new(
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:" +
            "[0-9]{2}(?:\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})\\z",
            RegexOptions.CultureInvariant |
            RegexOptions.NonBacktracking);
        private readonly FrozenSchemaSet _schemas;

        internal FrozenJsonSchemaEvaluator(FrozenSchemaSet schemas)
        {
            _schemas = schemas;
        }

        internal RbpSchemaFailure? Validate(
            JsonElement instance,
            JsonElement schema,
            string documentName,
            string path,
            int depth = 0)
        {
            if (depth > MaximumSchemaDepth)
            {
                return Failure(path, "schema nesting exceeded its bound");
            }

            if (schema.ValueKind == JsonValueKind.True)
            {
                return null;
            }

            if (schema.ValueKind == JsonValueKind.False)
            {
                return Failure(path, "the frozen schema rejects this value");
            }

            if (schema.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException(
                    "An embedded RBP schema node is not an object.");
            }

            if (schema.TryGetProperty("$ref", out JsonElement reference))
            {
                (JsonElement target, string targetDocument) =
                    _schemas.Resolve(
                        documentName,
                        reference.GetString() ??
                        throw new InvalidOperationException(
                            "An RBP schema reference is null."));
                RbpSchemaFailure? referenced = Validate(
                    instance,
                    target,
                    targetDocument,
                    path,
                    depth + 1);
                if (referenced is not null)
                {
                    return referenced;
                }
            }

            RbpSchemaFailure? composition = ValidateComposition(
                instance,
                schema,
                documentName,
                path,
                depth);
            if (composition is not null)
            {
                return composition;
            }

            if (schema.TryGetProperty("type", out JsonElement type) &&
                !MatchesType(instance, type))
            {
                return Failure(path, "value has the wrong JSON type");
            }

            if (schema.TryGetProperty("const", out JsonElement constant) &&
                !JsonEquals(instance, constant))
            {
                return Failure(path, "value does not match the frozen constant");
            }

            if (schema.TryGetProperty("enum", out JsonElement enumeration) &&
                !enumeration.EnumerateArray()
                    .Any(candidate => JsonEquals(instance, candidate)))
            {
                return Failure(path, "value is outside the frozen enum");
            }

            return instance.ValueKind switch
            {
                JsonValueKind.Object => ValidateObject(
                    instance,
                    schema,
                    documentName,
                    path,
                    depth),
                JsonValueKind.Array => ValidateArray(
                    instance,
                    schema,
                    documentName,
                    path,
                    depth),
                JsonValueKind.String => ValidateString(
                    instance,
                    schema,
                    path),
                JsonValueKind.Number => ValidateNumber(
                    instance,
                    schema,
                    path),
                _ => null,
            };
        }

        private RbpSchemaFailure? ValidateComposition(
            JsonElement instance,
            JsonElement schema,
            string documentName,
            string path,
            int depth)
        {
            if (schema.TryGetProperty("allOf", out JsonElement allOf))
            {
                foreach (JsonElement candidate in allOf.EnumerateArray())
                {
                    RbpSchemaFailure? failure = Validate(
                        instance,
                        candidate,
                        documentName,
                        path,
                        depth + 1);
                    if (failure is not null)
                    {
                        return failure;
                    }
                }
            }

            if (schema.TryGetProperty("anyOf", out JsonElement anyOf))
            {
                bool matched = anyOf.EnumerateArray().Any(
                    candidate => Validate(
                        instance,
                        candidate,
                        documentName,
                        path,
                        depth + 1) is null);
                if (!matched)
                {
                    return Failure(
                        path,
                        "value matches no allowed frozen alternative");
                }
            }

            if (schema.TryGetProperty("oneOf", out JsonElement oneOf))
            {
                var failures = new List<RbpSchemaFailure>();
                int matches = 0;
                foreach (JsonElement candidate in oneOf.EnumerateArray())
                {
                    RbpSchemaFailure? failure = Validate(
                        instance,
                        candidate,
                        documentName,
                        path,
                        depth + 1);
                    if (failure is null)
                    {
                        matches++;
                    }
                    else
                    {
                        failures.Add(failure);
                    }
                }

                if (matches != 1)
                {
                    if (matches == 0 && failures.Count > 0)
                    {
                        return failures
                            .OrderByDescending(
                                failure => failure.Path.Count(
                                    character => character == '/'))
                            .ThenByDescending(
                                failure => failure.Path.Length)
                            .First();
                    }

                    return Failure(
                        path,
                        "value does not match exactly one frozen alternative");
                }
            }

            if (schema.TryGetProperty("not", out JsonElement negated) &&
                Validate(
                    instance,
                    negated,
                    documentName,
                    path,
                    depth + 1) is null)
            {
                return Failure(path, "value matches a forbidden frozen shape");
            }

            if (schema.TryGetProperty("if", out JsonElement condition))
            {
                bool conditionMatches = Validate(
                    instance,
                    condition,
                    documentName,
                    path,
                    depth + 1) is null;
                string branchName = conditionMatches ? "then" : "else";
                if (schema.TryGetProperty(
                        branchName,
                        out JsonElement branch))
                {
                    RbpSchemaFailure? failure = Validate(
                        instance,
                        branch,
                        documentName,
                        path,
                        depth + 1);
                    if (failure is not null)
                    {
                        return failure;
                    }
                }
            }

            return null;
        }

        private RbpSchemaFailure? ValidateObject(
            JsonElement instance,
            JsonElement schema,
            string documentName,
            string path,
            int depth)
        {
            if (schema.TryGetProperty("required", out JsonElement required))
            {
                foreach (JsonElement item in required.EnumerateArray())
                {
                    string name = item.GetString() ??
                                  throw new InvalidOperationException(
                                      "An RBP schema required name is null.");
                    if (!instance.TryGetProperty(name, out _))
                    {
                        return Failure(
                            ChildPath(path, name),
                            "required property is missing");
                    }
                }
            }

            JsonElement properties = default;
            bool hasProperties =
                schema.TryGetProperty("properties", out properties);
            if (hasProperties)
            {
                foreach (JsonProperty property in properties.EnumerateObject())
                {
                    if (!instance.TryGetProperty(
                            property.Name,
                            out JsonElement value))
                    {
                        continue;
                    }

                    RbpSchemaFailure? failure = Validate(
                        value,
                        property.Value,
                        documentName,
                        ChildPath(path, property.Name),
                        depth + 1);
                    if (failure is not null)
                    {
                        return failure;
                    }
                }
            }

            if (schema.TryGetProperty(
                    "additionalProperties",
                    out JsonElement additional) &&
                additional.ValueKind == JsonValueKind.False)
            {
                foreach (JsonProperty property in instance.EnumerateObject())
                {
                    if (!hasProperties ||
                        !properties.TryGetProperty(property.Name, out _))
                    {
                        return Failure(
                            ChildPath(path, property.Name),
                            "additional property is forbidden");
                    }
                }
            }

            return null;
        }

        private RbpSchemaFailure? ValidateArray(
            JsonElement instance,
            JsonElement schema,
            string documentName,
            string path,
            int depth)
        {
            int count = instance.GetArrayLength();
            if (schema.TryGetProperty("minItems", out JsonElement minimum) &&
                count < minimum.GetInt32())
            {
                return Failure(path, "array is shorter than the frozen minimum");
            }

            if (schema.TryGetProperty("maxItems", out JsonElement maximum) &&
                count > maximum.GetInt32())
            {
                return Failure(path, "array exceeds the frozen maximum");
            }

            if (schema.TryGetProperty("items", out JsonElement itemSchema))
            {
                int index = 0;
                foreach (JsonElement item in instance.EnumerateArray())
                {
                    RbpSchemaFailure? failure = Validate(
                        item,
                        itemSchema,
                        documentName,
                        ChildPath(path, index.ToString(
                            CultureInfo.InvariantCulture)),
                        depth + 1);
                    if (failure is not null)
                    {
                        return failure;
                    }

                    index++;
                }
            }

            if (schema.TryGetProperty(
                    "uniqueItems",
                    out JsonElement unique) &&
                unique.ValueKind == JsonValueKind.True)
            {
                JsonElement[] values = instance.EnumerateArray().ToArray();
                for (int left = 0; left < values.Length; left++)
                {
                    for (int right = left + 1;
                         right < values.Length;
                         right++)
                    {
                        if (JsonEquals(values[left], values[right]))
                        {
                            return Failure(
                                ChildPath(
                                    path,
                                    right.ToString(
                                        CultureInfo.InvariantCulture)),
                                "array values must be unique");
                        }
                    }
                }
            }

            if (schema.TryGetProperty("contains", out JsonElement contains))
            {
                int matches = instance.EnumerateArray().Count(
                    item => Validate(
                        item,
                        contains,
                        documentName,
                        path,
                        depth + 1) is null);
                int minimumMatches =
                    schema.TryGetProperty(
                        "minContains",
                        out JsonElement minContains)
                        ? minContains.GetInt32()
                        : 1;
                int maximumMatches =
                    schema.TryGetProperty(
                        "maxContains",
                        out JsonElement maxContains)
                        ? maxContains.GetInt32()
                        : int.MaxValue;
                if (matches < minimumMatches || matches > maximumMatches)
                {
                    return Failure(
                        path,
                        "array contains-count is outside the frozen bounds");
                }
            }

            return null;
        }

        private static RbpSchemaFailure? ValidateString(
            JsonElement instance,
            JsonElement schema,
            string path)
        {
            string value = instance.GetString() ?? string.Empty;
            int length = value.EnumerateRunes().Count();
            if (schema.TryGetProperty("minLength", out JsonElement minimum) &&
                length < minimum.GetInt32())
            {
                return Failure(path, "string is shorter than the frozen minimum");
            }

            if (schema.TryGetProperty("maxLength", out JsonElement maximum) &&
                length > maximum.GetInt32())
            {
                return Failure(path, "string exceeds the frozen maximum");
            }

            if (schema.TryGetProperty("pattern", out JsonElement pattern))
            {
                string expression = pattern.GetString() ??
                                    throw new InvalidOperationException(
                                        "An RBP schema pattern is null.");
                if (expression.EndsWith('$') &&
                    !expression.EndsWith("\\$", StringComparison.Ordinal))
                {
                    expression = expression[..^1] + "\\z";
                }

                if (!Regex.IsMatch(
                        value,
                        expression,
                        RegexOptions.CultureInvariant |
                        RegexOptions.NonBacktracking,
                        TimeSpan.FromSeconds(1)))
                {
                    return Failure(
                        path,
                        "string does not match the frozen pattern");
                }
            }

            if (schema.TryGetProperty("format", out JsonElement format) &&
                string.Equals(
                    format.GetString(),
                    "date-time",
                    StringComparison.Ordinal) &&
                (!Rfc3339Pattern.IsMatch(value) ||
                 !DateTimeOffset.TryParse(
                     value,
                     CultureInfo.InvariantCulture,
                     DateTimeStyles.RoundtripKind,
                     out _)))
            {
                return Failure(path, "string is not an RFC 3339 date-time");
            }

            return null;
        }

        private static RbpSchemaFailure? ValidateNumber(
            JsonElement instance,
            JsonElement schema,
            string path)
        {
            bool requiresInteger =
                schema.TryGetProperty("type", out JsonElement type) &&
                TypeIncludes(type, "integer");
            if (requiresInteger &&
                !RbpJsonNumber.TryReadExactInt64(instance, out long integer))
            {
                return Failure(path, "number is not an exact 64-bit integer");
            }

            if (!RbpJsonNumber.TryReadExactInt64(
                    instance,
                    out long exactInteger))
            {
                return null;
            }

            if (schema.TryGetProperty("minimum", out JsonElement minimum) &&
                exactInteger < minimum.GetInt64())
            {
                return Failure(path, "integer is below the frozen minimum");
            }

            if (schema.TryGetProperty("maximum", out JsonElement maximum) &&
                exactInteger > maximum.GetInt64())
            {
                return Failure(path, "integer exceeds the frozen maximum");
            }

            return null;
        }

        private static bool MatchesType(
            JsonElement instance,
            JsonElement schemaType)
        {
            if (schemaType.ValueKind == JsonValueKind.String)
            {
                return MatchesTypeName(
                    instance,
                    schemaType.GetString() ?? string.Empty);
            }

            if (schemaType.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException(
                    "An RBP schema type is neither a string nor an array.");
            }

            return schemaType.EnumerateArray().Any(
                candidate => MatchesTypeName(
                    instance,
                    candidate.GetString() ?? string.Empty));
        }

        private static bool MatchesTypeName(
            JsonElement instance,
            string type)
        {
            return type switch
            {
                "object" => instance.ValueKind == JsonValueKind.Object,
                "array" => instance.ValueKind == JsonValueKind.Array,
                "string" => instance.ValueKind == JsonValueKind.String,
                "integer" =>
                    RbpJsonNumber.TryReadExactInt64(instance, out _),
                "number" => instance.ValueKind == JsonValueKind.Number,
                "boolean" => instance.ValueKind is
                    JsonValueKind.True or JsonValueKind.False,
                "null" => instance.ValueKind == JsonValueKind.Null,
                _ => throw new InvalidOperationException(
                    $"Unsupported frozen RBP schema type '{type}'."),
            };
        }

        private static bool TypeIncludes(
            JsonElement schemaType,
            string expected)
        {
            return schemaType.ValueKind == JsonValueKind.String
                ? string.Equals(
                    schemaType.GetString(),
                    expected,
                    StringComparison.Ordinal)
                : schemaType.EnumerateArray().Any(
                    item => string.Equals(
                        item.GetString(),
                        expected,
                        StringComparison.Ordinal));
        }

        private static bool JsonEquals(
            JsonElement left,
            JsonElement right)
        {
            if (left.ValueKind == JsonValueKind.Number &&
                right.ValueKind == JsonValueKind.Number)
            {
                if (RbpJsonNumber.TryReadExactInt64(left, out long leftInt) &&
                    RbpJsonNumber.TryReadExactInt64(right, out long rightInt))
                {
                    return leftInt == rightInt;
                }

                return decimal.TryParse(
                           left.GetRawText(),
                           NumberStyles.Float,
                           CultureInfo.InvariantCulture,
                           out decimal leftDecimal) &&
                       decimal.TryParse(
                           right.GetRawText(),
                           NumberStyles.Float,
                           CultureInfo.InvariantCulture,
                           out decimal rightDecimal) &&
                       leftDecimal == rightDecimal;
            }

            if (left.ValueKind != right.ValueKind)
            {
                return false;
            }

            return left.ValueKind switch
            {
                JsonValueKind.Object => ObjectsEqual(left, right),
                JsonValueKind.Array => ArraysEqual(left, right),
                JsonValueKind.String => string.Equals(
                    left.GetString(),
                    right.GetString(),
                    StringComparison.Ordinal),
                JsonValueKind.True or JsonValueKind.False => left.GetBoolean() ==
                                                             right.GetBoolean(),
                JsonValueKind.Null => true,
                _ => string.Equals(
                    left.GetRawText(),
                    right.GetRawText(),
                    StringComparison.Ordinal),
            };
        }

        private static bool ObjectsEqual(
            JsonElement left,
            JsonElement right)
        {
            JsonProperty[] leftProperties =
                left.EnumerateObject().ToArray();
            JsonProperty[] rightProperties =
                right.EnumerateObject().ToArray();
            if (leftProperties.Length != rightProperties.Length)
            {
                return false;
            }

            foreach (JsonProperty property in leftProperties)
            {
                if (!right.TryGetProperty(
                        property.Name,
                        out JsonElement other) ||
                    !JsonEquals(property.Value, other))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool ArraysEqual(
            JsonElement left,
            JsonElement right)
        {
            JsonElement[] leftItems = left.EnumerateArray().ToArray();
            JsonElement[] rightItems = right.EnumerateArray().ToArray();
            return leftItems.Length == rightItems.Length &&
                   leftItems.Zip(
                           rightItems,
                           (first, second) => JsonEquals(first, second))
                       .All(equal => equal);
        }

        private static RbpSchemaFailure Failure(
            string path,
            string message) =>
            new(path, message);

        private static string ChildPath(string parent, string name)
        {
            string escaped = name
                .Replace("~", "~0", StringComparison.Ordinal)
                .Replace("/", "~1", StringComparison.Ordinal);
            return parent == "/"
                ? "/" + escaped
                : parent + "/" + escaped;
        }
    }
}
