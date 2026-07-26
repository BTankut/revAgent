#nullable enable

using System;
using System.Collections.Generic;
using System.Runtime.Serialization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Rbp
{
    /// <summary>
    /// The frozen RBP/1 display side-channel. Presence flags deliberately keep
    /// omitted values distinct from explicit null/false values.
    /// </summary>
    [JsonObject(MemberSerialization.OptIn)]
    [JsonConverter(typeof(RbpDisplayConverter))]
    public sealed class RbpDisplay
    {
        private string? _taskName;
        private string? _wrapperAction;
        private string? _logicalToolName;
        private string? _parentTaskName;
        private string? _parentTaskId;
        private bool _suppressTaskStatusWindow;

        [JsonProperty("task_name")]
        public string? TaskName
        {
            get => _taskName;
            set
            {
                _taskName = value;
                HasTaskName = true;
            }
        }

        [JsonProperty("wrapper_action")]
        public string? WrapperAction
        {
            get => _wrapperAction;
            set
            {
                _wrapperAction = value;
                HasWrapperAction = true;
            }
        }

        [JsonProperty("logical_tool_name")]
        public string? LogicalToolName
        {
            get => _logicalToolName;
            set
            {
                _logicalToolName = value;
                HasLogicalToolName = true;
            }
        }

        [JsonProperty("parent_task_name")]
        public string? ParentTaskName
        {
            get => _parentTaskName;
            set
            {
                _parentTaskName = value;
                HasParentTaskName = true;
            }
        }

        [JsonProperty("parent_task_id")]
        public string? ParentTaskId
        {
            get => _parentTaskId;
            set
            {
                _parentTaskId = value;
                HasParentTaskId = true;
            }
        }

        [JsonProperty("suppress_task_status_window")]
        public bool SuppressTaskStatusWindow
        {
            get => _suppressTaskStatusWindow;
            set
            {
                _suppressTaskStatusWindow = value;
                HasSuppressTaskStatusWindow = true;
            }
        }

        [JsonIgnore]
        public bool HasTaskName { get; private set; }

        [JsonIgnore]
        public bool HasWrapperAction { get; private set; }

        [JsonIgnore]
        public bool HasLogicalToolName { get; private set; }

        [JsonIgnore]
        public bool HasParentTaskName { get; private set; }

        [JsonIgnore]
        public bool HasParentTaskId { get; private set; }

        [JsonIgnore]
        public bool HasSuppressTaskStatusWindow { get; private set; }

        [JsonIgnore]
        private IDictionary<string, JToken> AdditionalProperties { get; } =
            new Dictionary<string, JToken>(StringComparer.Ordinal);

        [JsonIgnore]
        public IReadOnlyDictionary<string, JToken> UnknownProperties =>
            (IReadOnlyDictionary<string, JToken>)AdditionalProperties;

        public bool ShouldSerializeTaskName() => HasTaskName;

        public bool ShouldSerializeWrapperAction() => HasWrapperAction;

        public bool ShouldSerializeLogicalToolName() => HasLogicalToolName;

        public bool ShouldSerializeParentTaskName() => HasParentTaskName;

        public bool ShouldSerializeParentTaskId() => HasParentTaskId;

        public bool ShouldSerializeSuppressTaskStatusWindow() => HasSuppressTaskStatusWindow;

        public static RbpDisplay Parse(JObject value)
        {
            if (value == null)
            {
                throw new ArgumentNullException(nameof(value));
            }

            var display = value.ToObject<RbpDisplay>()
                ?? throw new RbpContractException("display must be an object");
            display.Validate();
            return display;
        }

        internal void AddUnknownProperty(string name, JToken value)
        {
            AdditionalProperties[name] = value;
        }

        public void Validate()
        {
            ValidateRequiredStringWhenPresent(TaskName, HasTaskName, "display.task_name");
            ValidateRequiredStringWhenPresent(WrapperAction, HasWrapperAction, "display.wrapper_action");
            ValidateRequiredStringWhenPresent(LogicalToolName, HasLogicalToolName, "display.logical_tool_name");
            ValidateNullableBoundedString(ParentTaskName, HasParentTaskName, "display.parent_task_name");
            ValidateNullableBoundedString(ParentTaskId, HasParentTaskId, "display.parent_task_id");
        }

        [OnDeserialized]
        private void OnDeserialized(StreamingContext _)
        {
            Validate();
        }

        private static void ValidateRequiredStringWhenPresent(string? value, bool present, string path)
        {
            if (!present)
            {
                return;
            }

            if (value == null)
            {
                throw new RbpContractException(path + " must be a string when present");
            }

            ValidateLength(value, path);
        }

        private static void ValidateNullableBoundedString(string? value, bool present, string path)
        {
            if (present && value != null)
            {
                ValidateLength(value, path);
            }
        }

        private static void ValidateLength(string value, string path)
        {
            if (UnicodeCodePointLength.Count(value) > 4096)
            {
                throw new RbpContractException(path + " exceeds the RBP/1 bounded-string limit");
            }
        }
    }

    internal sealed class RbpDisplayConverter : JsonConverter
    {
        public override bool CanConvert(Type objectType) => objectType == typeof(RbpDisplay);

        public override object ReadJson(
            JsonReader reader,
            Type objectType,
            object? existingValue,
            JsonSerializer serializer)
        {
            if (reader.TokenType == JsonToken.Null)
            {
                throw new RbpContractException("display must be an object");
            }

            JObject value;
            try
            {
                value = JObject.Load(
                    reader,
                    new JsonLoadSettings
                    {
                        DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
                        CommentHandling = CommentHandling.Load,
                    });
            }
            catch (JsonException ex)
            {
                throw new RbpContractException("display must be a strict object", ex);
            }

            var display = new RbpDisplay();
            foreach (var property in value.Properties())
            {
                switch (property.Name)
                {
                    case "task_name":
                        display.TaskName = RequireString(property);
                        break;
                    case "wrapper_action":
                        display.WrapperAction = RequireString(property);
                        break;
                    case "logical_tool_name":
                        display.LogicalToolName = RequireString(property);
                        break;
                    case "parent_task_name":
                        display.ParentTaskName = RequireNullableString(property);
                        break;
                    case "parent_task_id":
                        display.ParentTaskId = RequireNullableString(property);
                        break;
                    case "suppress_task_status_window":
                        if (property.Value.Type != JTokenType.Boolean)
                        {
                            throw new RbpContractException(
                                "display.suppress_task_status_window must be a boolean");
                        }

                        display.SuppressTaskStatusWindow = property.Value.Value<bool>();
                        break;
                    default:
                        display.AddUnknownProperty(property.Name, property.Value.DeepClone());
                        break;
                }
            }

            display.Validate();
            return display;
        }

        public override void WriteJson(JsonWriter writer, object? value, JsonSerializer serializer)
        {
            if (!(value is RbpDisplay display))
            {
                writer.WriteNull();
                return;
            }

            writer.WriteStartObject();
            WriteOptionalString(writer, "task_name", display.TaskName, display.HasTaskName);
            WriteOptionalString(writer, "wrapper_action", display.WrapperAction, display.HasWrapperAction);
            WriteOptionalString(
                writer,
                "logical_tool_name",
                display.LogicalToolName,
                display.HasLogicalToolName);
            WriteOptionalString(
                writer,
                "parent_task_name",
                display.ParentTaskName,
                display.HasParentTaskName);
            WriteOptionalString(writer, "parent_task_id", display.ParentTaskId, display.HasParentTaskId);

            if (display.HasSuppressTaskStatusWindow)
            {
                writer.WritePropertyName("suppress_task_status_window");
                writer.WriteValue(display.SuppressTaskStatusWindow);
            }

            foreach (var unknown in display.UnknownProperties)
            {
                writer.WritePropertyName(unknown.Key);
                unknown.Value.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        private static string RequireString(JProperty property)
        {
            if (property.Value.Type != JTokenType.String)
            {
                throw new RbpContractException("display." + property.Name + " must be a string");
            }

            return property.Value.Value<string>()!;
        }

        private static string? RequireNullableString(JProperty property)
        {
            if (property.Value.Type == JTokenType.Null)
            {
                return null;
            }

            return RequireString(property);
        }

        private static void WriteOptionalString(
            JsonWriter writer,
            string propertyName,
            string? value,
            bool present)
        {
            if (!present)
            {
                return;
            }

            writer.WritePropertyName(propertyName);
            writer.WriteValue(value);
        }
    }
}
