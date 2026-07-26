using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    public sealed class AddinStatusParserTests
    {
        [Fact]
        public void ParsesFrozenPositiveFixture()
        {
            JObject scenario = LoadProtocolFixture("mcp-status.positive.json");
            JObject responseEnvelope = RequireObject(scenario, "response");

            AddinStatusSnapshot status = ParseEnvelope(responseEnvelope);

            Assert.Equal("2026.07.22.0", status.AddinVersion);
            Assert.Equal("2026", status.Revit.Version);
            Assert.Equal("2026.0.1", status.Revit.Build);
            Assert.Equal(4242, status.Revit.ProcessId);
            Assert.True(status.Service.IsRunning);
            Assert.Equal(8080, status.Service.Port);
            Assert.Equal(new[] { "127.0.0.1" }, status.Service.BoundAddresses);
            Assert.Equal(
                AddinFrameLimits.DefaultMaxRequestPayloadBytes,
                status.Service.Framing.MaxRequestPayloadBytes);
            Assert.Equal(
                new[]
                {
                    AddinStatusContract.BatchAtomicCapability,
                    AddinStatusContract.DocumentContextCachedCapability,
                },
                status.SessionCapabilities);
            Assert.Equal(32, status.BatchAtomic!.MaxSteps);
            Assert.Equal(
                new[] { "find_elements", "delete_review_view" },
                status.BatchAtomic.BatchableCommands.Select(command => command.Method));
            Assert.Equal(
                "delete_review_view_commit_v1",
                status.BatchAtomic.BatchableCommands[1].ParameterProfile);
            Assert.Equal(
                "get_document_context",
                status.DocumentContextCached!.Method);
            Assert.Null(status.ActiveTask);
            Assert.Empty(status.RecentTasks);
            Assert.Equal(0, status.RecentHistoryCount);
            Assert.Empty(status.Plan.Pending);
            Assert.Empty(status.Plan.Completed);
        }

        [Fact]
        public void AcceptsAStatusWithNoAdvertisedCapabilities()
        {
            JObject envelope = FrozenPositiveResponse();
            JObject result = RequireObject(envelope, "result");
            result["sessionCapabilities"] = new JArray();
            result["capabilityContracts"] = new JObject();

            AddinStatusSnapshot status = ParseEnvelope(envelope);

            Assert.Empty(status.SessionCapabilities);
            Assert.Null(status.BatchAtomic);
            Assert.Null(status.DocumentContextCached);
        }

        [Fact]
        public void RejectsDescriptorForAnUnadvertisedCapability()
        {
            JObject envelope = FrozenPositiveResponse();
            JObject result = RequireObject(envelope, "result");
            result["sessionCapabilities"] = new JArray(
                AddinStatusContract.BatchAtomicCapability);

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => ParseEnvelope(envelope));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        [Fact]
        public void ParsesCompleteTaskAndPlanEvidence()
        {
            JObject envelope = FrozenPositiveResponse();
            JObject result = RequireObject(envelope, "result");
            JObject task = TaskInfo();
            result["activeTask"] = task.DeepClone();
            result["recentTasks"] = new JArray(task.DeepClone());
            result["recentHistoryCount"] = 1;
            result["plan"] = new JObject
            {
                ["pending"] = new JArray("next"),
                ["completed"] = new JArray("done"),
            };

            AddinStatusSnapshot status = ParseEnvelope(envelope);

            Assert.Equal("task-1", status.ActiveTask!.Id);
            Assert.Equal("find_elements", status.ActiveTask.Method);
            Assert.Equal("completed", status.ActiveTask.State);
            Assert.Equal("length-prefixed", status.ActiveTask.Framing);
            Assert.Equal(37, status.ActiveTask.ResponseBytes);
            Assert.Single(status.RecentTasks);
            Assert.Equal(new[] { "next" }, status.Plan.Pending);
            Assert.Equal(new[] { "done" }, status.Plan.Completed);
        }

        [Fact]
        public void AcceptsSchemaCompatibleLowercaseAndLongFractionDateTimes()
        {
            JObject envelope = FrozenPositiveResponse();
            JObject result = RequireObject(envelope, "result");
            JObject task = TaskInfo();
            task["startedAtUtc"] =
                "2026-07-26t10:00:00.123456789012345678901234567890z";
            task["finishedAtUtc"] =
                "2026-07-26t10:00:01.123456789012345678901234567890z";
            result["activeTask"] = task;

            AddinStatusSnapshot status = ParseEnvelope(envelope);

            Assert.Equal(
                TimeSpan.Zero,
                status.ActiveTask!.StartedAtUtc.Offset);
            Assert.Equal(
                1,
                (status.ActiveTask.FinishedAtUtc!.Value -
                 status.ActiveTask.StartedAtUtc).TotalSeconds);
        }

        [Fact]
        public void AcceptsAndNormalizesSchemaCompatibleLeapSecond()
        {
            JObject envelope = FrozenPositiveResponse();
            JObject result = RequireObject(envelope, "result");
            JObject task = TaskInfo();
            task["startedAtUtc"] = "2026-12-31T23:59:60Z";
            task["finishedAtUtc"] = "2027-01-01T00:00:00Z";
            result["activeTask"] = task;

            AddinStatusSnapshot status = ParseEnvelope(envelope);

            Assert.Equal(
                new DateTimeOffset(
                    2027,
                    1,
                    1,
                    0,
                    0,
                    0,
                    TimeSpan.Zero),
                status.ActiveTask!.StartedAtUtc);
            Assert.Equal(
                status.ActiveTask.StartedAtUtc,
                status.ActiveTask.FinishedAtUtc);
        }

        [Fact]
        public void RejectsEveryFrozenMcpStatusNegativeVector()
        {
            JObject positiveScenario =
                LoadProtocolFixture("mcp-status.positive.json");
            JArray vectors = Assert.IsType<JArray>(
                LoadProtocolFixture("negative-vectors.json")["vectors"]
                ?? LoadProtocolFixture("negative-vectors.json"));
            var exercised = new List<string>();

            foreach (JObject vector in vectors.OfType<JObject>())
            {
                string baseName = vector.Value<string>("base")!;
                if (!baseName.StartsWith("mcpStatus.", StringComparison.Ordinal))
                {
                    continue;
                }

                JObject candidate = baseName.EndsWith(
                    ".scenario",
                    StringComparison.Ordinal)
                    ? (JObject)positiveScenario.DeepClone()
                    : (JObject)RequireObject(
                        positiveScenario,
                        "response").DeepClone();
                JObject mutation = RequireObject(vector, "mutation");
                ApplyMutation(
                    candidate,
                    mutation.Value<string>("operation")!,
                    mutation.Value<string>("path")!,
                    mutation["value"]);
                JObject envelope = baseName.EndsWith(
                    ".scenario",
                    StringComparison.Ordinal)
                    ? RequireObject(candidate, "response")
                    : candidate;

                AddinStatusContractException error =
                    Assert.Throws<AddinStatusContractException>(
                        () => ParseEnvelope(envelope));

                Assert.Contains(
                    error.Code,
                    new[]
                    {
                        "invalid_mcp_status",
                        "unsupported_addin_loopback_contract_version",
                    });
                exercised.Add(vector.Value<string>("name")!);
            }

            Assert.Equal(6, exercised.Count);
        }

        [Theory]
        [MemberData(nameof(InvalidStatusMutations))]
        public void RejectsAdditionalClosedContractViolations(
            string path,
            JToken replacement)
        {
            JObject envelope = FrozenPositiveResponse();
            ApplyMutation(envelope, "replace", path, replacement);

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => ParseEnvelope(envelope));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        [Fact]
        public void RejectsUnexpectedStatusProperty()
        {
            JObject envelope = FrozenPositiveResponse();
            RequireObject(envelope, "result")["unexpected"] = true;

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => ParseEnvelope(envelope));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        [Fact]
        public void RejectsLegacyPreAdaptationStatusShape()
        {
            var envelope = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = "legacy-status",
                ["result"] = new JObject
                {
                    ["resultContractVersion"] = 2,
                    ["service"] = new JObject
                    {
                        ["isRunning"] = true,
                        ["port"] = 8080,
                    },
                    ["activeTask"] = JValue.CreateNull(),
                    ["recentTasks"] = new JArray(),
                    ["recentHistoryCount"] = 0,
                    ["recentHistoryCapacity"] = 100,
                    ["plan"] = new JObject
                    {
                        ["pending"] = new JArray(),
                        ["completed"] = new JArray(),
                    },
                },
            };

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => ParseEnvelope(envelope));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        [Fact]
        public void RejectsJsonRpcErrorAsStatusEvidence()
        {
            const string ErrorJson =
                "{\"jsonrpc\":\"2.0\",\"id\":\"status-error\"," +
                "\"error\":{\"code\":-32603,\"message\":\"failed\"}}";
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                Encoding.UTF8.GetBytes(ErrorJson),
                "status-error");

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => AddinStatusParser.Parse(response));

            Assert.Equal("mcp_status_jsonrpc_error", error.Code);
        }

        [Fact]
        public void MathematicallyIntegralContractNumbersRemainValid()
        {
            string json = FrozenPositiveResponse().ToString(Formatting.None)
                .Replace(
                    "\"addinLoopbackContractVersion\":1",
                    "\"addinLoopbackContractVersion\":1e0")
                .Replace(
                    "\"recentHistoryCapacity\":100",
                    "\"recentHistoryCapacity\":100.0");
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                Encoding.UTF8.GetBytes(json),
                "status-probe-1");

            AddinStatusSnapshot status = AddinStatusParser.Parse(response);

            Assert.Equal(AddinStatusContract.Version, status.AddinLoopbackContractVersion);
            Assert.Equal(100, status.RecentHistoryCapacity);
        }

        [Fact]
        public void RejectsHistoryCountDifferentFromReturnedWindow()
        {
            JObject envelope = FrozenPositiveResponse();
            RequireObject(envelope, "result")["recentHistoryCount"] = 27;

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => ParseEnvelope(envelope));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        [Fact]
        public void RejectsFractionRoundedToAnIntegerByBinaryFloatingPoint()
        {
            string json = FrozenPositiveResponse().ToString(Formatting.None)
                .Replace(
                    "\"addinLoopbackContractVersion\":1",
                    "\"addinLoopbackContractVersion\":1.00000000000000001");
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                Encoding.UTF8.GetBytes(json),
                "status-probe-1");

            AddinStatusContractException error =
                Assert.Throws<AddinStatusContractException>(
                    () => AddinStatusParser.Parse(response));

            Assert.Equal("invalid_mcp_status", error.Code);
        }

        public static IEnumerable<object[]> InvalidStatusMutations()
        {
            yield return Row("/result/addinVersion", string.Empty);
            yield return Row("/result/revit/version", "26");
            yield return Row("/result/revit/processId", 0);
            yield return Row("/result/service/isRunning", false);
            yield return Row("/result/service/binding", "loopback");
            yield return Row(
                "/result/service/framing/protocol",
                "legacy_json");
            yield return Row(
                "/result/service/framing/maxResponsePayloadBytes",
                AddinFrameLimits.MaxResponsePayloadBytes - 1);
            yield return Row(
                "/result/sessionCapabilities/0",
                "unknown_capability");
            yield return Row(
                "/result/capabilityContracts/doc_context_cached_v1/pollIntervalMs",
                14999);
            yield return Row(
                "/result/capabilityContracts/batch_atomic/batchableCommands/0/parameterProfile",
                "delete_review_view_commit_v1");
            yield return Row("/result/recentHistoryCount", 1);
            yield return Row("/result/plan/pending", new JArray(string.Empty));
        }

        private static object[] Row(string path, object value) =>
            new object[] { path, JToken.FromObject(value) };

        private static AddinStatusSnapshot ParseEnvelope(JObject envelope)
        {
            string id = envelope.Value<string>("id")!;
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                Encoding.UTF8.GetBytes(envelope.ToString(Formatting.None)),
                id);
            return AddinStatusParser.Parse(response);
        }

        private static JObject FrozenPositiveResponse() =>
            (JObject)RequireObject(
                LoadProtocolFixture("mcp-status.positive.json"),
                "response").DeepClone();

        private static JObject TaskInfo() =>
            new JObject
            {
                ["id"] = "task-1",
                ["requestId"] = "request-1",
                ["method"] = "find_elements",
                ["wrapperAction"] = "find_elements",
                ["logicalToolName"] = "find_elements",
                ["taskName"] = "Find elements",
                ["parentTaskName"] = "Parent",
                ["parentTaskId"] = "parent-1",
                ["state"] = "completed",
                ["startedAtUtc"] = "2026-07-26T10:00:00.000Z",
                ["finishedAtUtc"] = "2026-07-26T10:00:00.042Z",
                ["elapsedMs"] = 42,
                ["port"] = 8080,
                ["error"] = null,
                ["framing"] = "length-prefixed",
                ["requestBytes"] = 23,
                ["receiveMs"] = 1,
                ["parseMs"] = 2,
                ["executeMs"] = 3,
                ["responseBytes"] = 37,
            };

        private static JObject LoadProtocolFixture(string name)
        {
            string path = Path.Combine(
                FindRepositoryRoot(),
                "packages",
                "protocol",
                "fixtures",
                "addin-loopback",
                "v1",
                name);
            using var textReader = File.OpenText(path);
            using var jsonReader = new JsonTextReader(textReader)
            {
                DateParseHandling = DateParseHandling.None,
                FloatParseHandling = FloatParseHandling.Decimal,
            };
            JToken token = JToken.Load(jsonReader);
            if (token is JObject objectValue)
            {
                return objectValue;
            }

            return new JObject { ["vectors"] = token };
        }

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                if (File.Exists(Path.Combine(current.FullName, "AGENTS.md")) &&
                    Directory.Exists(
                        Path.Combine(current.FullName, "packages", "protocol")))
                {
                    return current.FullName;
                }

                current = current.Parent;
            }

            throw new DirectoryNotFoundException(
                "Could not locate the revAgent repository root.");
        }

        private static JObject RequireObject(JObject parent, string propertyName) =>
            Assert.IsType<JObject>(parent[propertyName]);

        private static void ApplyMutation(
            JToken root,
            string operation,
            string pointer,
            JToken? value)
        {
            string[] segments = pointer
                .Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(segment => segment
                    .Replace("~1", "/")
                    .Replace("~0", "~"))
                .ToArray();
            if (segments.Length == 0)
            {
                throw new InvalidOperationException(
                    "Fixture mutation cannot replace the document root.");
            }

            JToken parent = root;
            for (int index = 0; index < segments.Length - 1; index++)
            {
                parent = parent is JArray array
                    ? array[int.Parse(
                        segments[index],
                        System.Globalization.CultureInfo.InvariantCulture)]
                    : parent[segments[index]]!;
            }

            string leaf = segments[segments.Length - 1];
            if (parent is JArray parentArray)
            {
                int index = int.Parse(
                    leaf,
                    System.Globalization.CultureInfo.InvariantCulture);
                if (operation == "delete")
                {
                    parentArray.RemoveAt(index);
                }
                else
                {
                    parentArray[index] = value!.DeepClone();
                }

                return;
            }

            var parentObject = Assert.IsType<JObject>(parent);
            if (operation == "delete")
            {
                Assert.True(parentObject.Remove(leaf));
            }
            else
            {
                parentObject[leaf] = value!.DeepClone();
            }
        }
    }
}
