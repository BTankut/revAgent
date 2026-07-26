#nullable enable

using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Rbp;
using Xunit;

namespace RevAgent.Contracts.Tests.Rbp
{
    public sealed class DisplayParameterMapperTests
    {
        [Fact]
        public void MapsExactlySixKnownFieldsWithAuthoritativeNullAndFalseValues()
        {
            var functionalParams = JObject.Parse(
                @"{
                    ""elementIds"": [11, 22],
                    ""taskName"": ""untrusted task"",
                    ""wrapperAction"": ""untrusted wrapper"",
                    ""logicalToolName"": ""untrusted logical name"",
                    ""parentTaskName"": ""untrusted parent"",
                    ""parentTaskId"": ""untrusted parent id"",
                    ""suppressTaskStatusWindow"": true
                }");
            var digestSourceBeforeMap = (JObject)functionalParams.DeepClone();

            var display = RbpDisplay.Parse(
                JObject.Parse(
                    @"{
                        ""task_name"": ""Inspect schedules"",
                        ""wrapper_action"": ""inspect_schedules"",
                        ""logical_tool_name"": ""core.schedule.inspect"",
                        ""parent_task_name"": null,
                        ""parent_task_id"": null,
                        ""suppress_task_status_window"": false,
                        ""future_display_hint"": { ""ignored"": true }
                    }"));

            var mapped = DisplayParameterMapper.Map(functionalParams, display);

            Assert.True(JToken.DeepEquals(digestSourceBeforeMap, functionalParams));
            Assert.Equal("Inspect schedules", (string?)mapped["taskName"]);
            Assert.Equal("inspect_schedules", (string?)mapped["wrapperAction"]);
            Assert.Equal("core.schedule.inspect", (string?)mapped["logicalToolName"]);
            Assert.Equal(JTokenType.Null, mapped["parentTaskName"]?.Type);
            Assert.Equal(JTokenType.Null, mapped["parentTaskId"]?.Type);
            Assert.False((bool?)mapped["suppressTaskStatusWindow"]);
            Assert.Null(mapped["future_display_hint"]);
            Assert.Null(mapped["task_name"]);
            Assert.Null(mapped["wrapper_action"]);
            Assert.Single(display.UnknownProperties);
        }

        [Fact]
        public void OmittedDisplayValuesRemainOmittedAndReservedParamsAreRemoved()
        {
            var functionalParams = JObject.Parse(
                @"{
                    ""query"": ""AHU"",
                    ""taskName"": ""untrusted"",
                    ""parentTaskName"": null,
                    ""suppressTaskStatusWindow"": true
                }");
            var display = RbpDisplay.Parse(new JObject());

            var mapped = DisplayParameterMapper.Map(functionalParams, display);

            Assert.Equal("AHU", (string?)mapped["query"]);
            Assert.Null(mapped["taskName"]);
            Assert.Null(mapped["parentTaskName"]);
            Assert.Null(mapped["suppressTaskStatusWindow"]);
            Assert.Equal("{}", JsonConvert.SerializeObject(display));
        }

        [Fact]
        public void NullDisplayStillClonesAndClearsReservedNamespace()
        {
            var functionalParams = JObject.Parse(@"{""query"":""FCU"",""parentTaskId"":""untrusted""}");

            var mapped = DisplayParameterMapper.Map(functionalParams, null);

            Assert.NotSame(functionalParams, mapped);
            Assert.Equal("FCU", (string?)mapped["query"]);
            Assert.Null(mapped["parentTaskId"]);
            Assert.Equal("untrusted", (string?)functionalParams["parentTaskId"]);
        }

        [Fact]
        public void RejectsNullForNonNullableKnownString()
        {
            var error = Assert.Throws<RbpContractException>(
                () => RbpDisplay.Parse(JObject.Parse(@"{""task_name"":null}")));

            Assert.Contains("task_name", error.Message);
        }

        [Fact]
        public void SerializesExplicitParentNullAndFalseButNotOmittedFields()
        {
            var display = RbpDisplay.Parse(
                JObject.Parse(
                    @"{
                        ""parent_task_name"": null,
                        ""suppress_task_status_window"": false
                    }"));

            var serialized = JObject.Parse(JsonConvert.SerializeObject(display));

            Assert.Equal(JTokenType.Null, serialized["parent_task_name"]?.Type);
            Assert.False((bool?)serialized["suppress_task_status_window"]);
            Assert.Null(serialized["task_name"]);
            Assert.Null(serialized["parent_task_id"]);
        }

        [Fact]
        public void CaseVariantsAreAdditiveUnknownsAndAreNeverForwarded()
        {
            var display = RbpDisplay.Parse(
                JObject.Parse(@"{""TASK_NAME"":""must stay unknown"",""task_Name"":""also unknown""}"));

            var mapped = DisplayParameterMapper.Map(new JObject(), display);

            Assert.Equal(2, display.UnknownProperties.Count);
            Assert.False(display.HasTaskName);
            Assert.Null(mapped["taskName"]);
            Assert.Null(mapped["TASK_NAME"]);
            Assert.Null(mapped["task_Name"]);
        }

        [Fact]
        public void BoundedDisplayStringsCountUnicodeCodePoints()
        {
            string acceptedTaskName = string.Concat(
                Enumerable.Repeat("\U0001F600", 4096));
            var accepted = RbpDisplay.Parse(
                new JObject
                {
                    ["task_name"] = acceptedTaskName,
                });

            Assert.Equal(acceptedTaskName, accepted.TaskName);

            string rejectedTaskName = string.Concat(
                Enumerable.Repeat("\U0001F600", 4097));
            RbpContractException error = Assert.Throws<RbpContractException>(
                () => RbpDisplay.Parse(
                    new JObject
                    {
                        ["task_name"] = rejectedTaskName,
                    }));

            Assert.Contains("bounded-string limit", error.Message, StringComparison.Ordinal);
        }
    }
}
