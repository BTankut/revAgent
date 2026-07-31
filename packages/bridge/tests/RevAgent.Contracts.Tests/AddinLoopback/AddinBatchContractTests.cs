using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using RevAgent.Contracts.AddinLoopback;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    public sealed class AddinBatchContractTests
    {
        private const string BatchId = "0197a3c2-0000-7000-8000-0000000000aa";
        private const string Digest =
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        private static string InvocationId(int ordinal)
        {
            return "0197a3c2-0000-7000-8000-" + ordinal.ToString("x12");
        }

        private static JObject Step(int index, string method, JObject? parameters = null, string? effect = null)
        {
            return new JObject
            {
                ["index"] = index,
                ["invocationId"] = InvocationId(index),
                ["method"] = method,
                ["params"] = parameters ?? new JObject(),
                ["paramsDigest"] = Digest,
                ["effect"] = effect ?? (method == "delete_review_view" ? "model_transaction" : "read_only"),
            };
        }

        private static JObject DeleteReviewViewParams()
        {
            return new JObject
            {
                ["viewId"] = 4242,
                ["viewType"] = "ThreeD",
                ["mode"] = "commit",
                ["confirmDelete"] = true,
            };
        }

        private static JObject ValidParams(params JObject[] steps)
        {
            return new JObject
            {
                ["batchContractVersion"] = 1,
                ["batchId"] = BatchId,
                ["batchDigest"] = Digest,
                ["atomic"] = true,
                ["rollbackPolicy"] = "rollback_on_non_success",
                ["maxAggregateResultBytes"] = 33554432,
                ["steps"] = new JArray(steps.Cast<object>().ToArray()),
            };
        }

        private static AddinBatchRequest ParseValid(params JObject[] steps)
        {
            return AddinBatchRequestParser.Parse(BatchId, ValidParams(steps));
        }

        private static AddinBatchRequestException ExpectRejection(string requestId, JObject parameters)
        {
            return Assert.Throws<AddinBatchRequestException>(
                () => AddinBatchRequestParser.Parse(requestId, parameters));
        }

        [Fact]
        public void ParsesAValidMixedBatch()
        {
            AddinBatchRequest request = ParseValid(
                Step(0, "find_elements", new JObject { ["categoryNames"] = new JArray("Ducts") }),
                Step(1, "delete_review_view", DeleteReviewViewParams()));

            Assert.Equal(BatchId, request.BatchId);
            Assert.Equal(Digest, request.BatchDigest);
            Assert.Equal(33554432, request.MaxAggregateResultBytes);
            Assert.Equal(2, request.Steps.Count);
            Assert.Equal("find_elements", request.Steps[0].Method);
            Assert.False(request.Steps[0].IsModelTransaction);
            Assert.Equal("delete_review_view", request.Steps[1].Method);
            Assert.True(request.Steps[1].IsModelTransaction);
        }

        [Theory]
        [InlineData("send_code_to_revit")]
        [InlineData("activate_view")]
        [InlineData("close_view")]
        [InlineData("clear_selection")]
        [InlineData("focus_elements")]
        [InlineData("section_box_elements")]
        [InlineData("create_3d_view_for_elements")]
        [InlineData("open_existing_plan_for_element_level")]
        [InlineData("mcp_status")]
        [InlineData("get_document_context")]
        [InlineData("execute_batch")]
        public void RejectsEveryNonBatchableMethodBeforeExecution(string method)
        {
            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, method, null, "read_only")));

            Assert.Equal(-32602, rejection.JsonRpcErrorCode);
            Assert.Contains("not a batchable", rejection.Message);
        }

        [Theory]
        [InlineData("timeoutMs")]
        [InlineData("transactionMode")]
        [InlineData("display")]
        [InlineData("batchId")]
        [InlineData("invocation_id")]
        [InlineData("maxAggregateResultBytes")]
        public void RejectsReservedOrdinaryParameterNames(string reservedName)
        {
            JObject parameters = new JObject { [reservedName] = "x" };
            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, "get_ui_state", parameters)));

            Assert.Equal(-32602, rejection.JsonRpcErrorCode);
            Assert.Contains("reserved name", rejection.Message);
        }

        [Fact]
        public void RejectsARequestIdThatDiffersFromTheBatchId()
        {
            AddinBatchRequestException rejection = ExpectRejection(
                "0197a3c2-0000-7000-8000-0000000000bb",
                ValidParams(Step(0, "get_ui_state")));

            Assert.Equal(-32602, rejection.JsonRpcErrorCode);
        }

        [Fact]
        public void RejectsAMissingRequestId()
        {
            AddinBatchRequestException rejection = ExpectRejection(
                string.Empty,
                ValidParams(Step(0, "get_ui_state")));

            Assert.Equal(-32600, rejection.JsonRpcErrorCode);
        }

        [Fact]
        public void RejectsDuplicateInvocationIds()
        {
            JObject second = Step(1, "get_ui_state");
            second["invocationId"] = InvocationId(0);
            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, "get_ui_state"), second));

            Assert.Contains("duplicated", rejection.Message);
        }

        [Fact]
        public void RejectsNonContiguousStepIndices()
        {
            JObject second = Step(1, "get_ui_state");
            second["index"] = 2;
            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, "get_ui_state"), second));

            Assert.Contains("contiguous", rejection.Message);
        }

        [Fact]
        public void RejectsAnEffectThatDiffersFromTheDescriptor()
        {
            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, "find_elements", null, "model_transaction")));

            Assert.Contains("advertised descriptor", rejection.Message);
        }

        [Fact]
        public void RejectsUnknownTopLevelAndStepFields()
        {
            JObject parameters = ValidParams(Step(0, "get_ui_state"));
            parameters["unexpected"] = true;
            Assert.Contains("unsupported field", ExpectRejection(BatchId, parameters).Message);

            JObject step = Step(0, "get_ui_state");
            step["mutating"] = true;
            Assert.Contains(
                "unsupported field",
                ExpectRejection(BatchId, ValidParams(step)).Message);
        }

        [Fact]
        public void RejectsAMissingRequiredBatchField()
        {
            JObject parameters = ValidParams(Step(0, "get_ui_state"));
            parameters.Remove("batchDigest");
            Assert.Contains("missing required field", ExpectRejection(BatchId, parameters).Message);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(33554433)]
        public void RejectsAnOutOfRangeAggregateBudget(long budget)
        {
            JObject parameters = ValidParams(Step(0, "get_ui_state"));
            parameters["maxAggregateResultBytes"] = budget;
            Assert.Contains("maxAggregateResultBytes", ExpectRejection(BatchId, parameters).Message);
        }

        [Fact]
        public void RejectsMalformedIdsAndDigests()
        {
            JObject badBatchId = ValidParams(Step(0, "get_ui_state"));
            badBatchId["batchId"] = "not-a-uuid";
            Assert.Equal(-32602, ExpectRejection("not-a-uuid", badBatchId).JsonRpcErrorCode);

            JObject badDigest = ValidParams(Step(0, "get_ui_state"));
            badDigest["batchDigest"] = "sha256:short";
            Assert.Contains("batchDigest", ExpectRejection(BatchId, badDigest).Message);

            JObject badStepDigest = Step(0, "get_ui_state");
            badStepDigest["paramsDigest"] = "md5:nope";
            Assert.Contains(
                "paramsDigest",
                ExpectRejection(BatchId, ValidParams(badStepDigest)).Message);
        }

        [Fact]
        public void RejectsAnEmptyOrOversizedStepList()
        {
            JObject empty = ValidParams();
            Assert.Contains("through 64", ExpectRejection(BatchId, empty).Message);

            JObject[] tooMany = Enumerable.Range(0, 65)
                .Select(index => Step(index, "get_ui_state"))
                .ToArray();
            Assert.Contains("through 64", ExpectRejection(BatchId, ValidParams(tooMany)).Message);
        }

        [Fact]
        public void AcceptsTheViewNameDeleteSelector()
        {
            JObject parameters = new JObject
            {
                ["viewName"] = "revAgent Review 3D",
                ["exactName"] = true,
                ["mode"] = "commit",
                ["confirmDelete"] = true,
            };

            AddinBatchRequest request = ParseValid(Step(0, "delete_review_view", parameters));
            Assert.True(request.Steps[0].IsModelTransaction);
        }

        [Theory]
        [InlineData("dryRunMode")]
        [InlineData("missingConfirm")]
        [InlineData("bothSelectors")]
        [InlineData("nameWithoutExact")]
        [InlineData("exactWithViewId")]
        [InlineData("unsupportedField")]
        [InlineData("wrongViewType")]
        public void RejectsEveryDeleteReviewViewProfileViolation(string scenario)
        {
            JObject parameters = DeleteReviewViewParams();
            switch (scenario)
            {
                case "dryRunMode":
                    parameters["mode"] = "dryRun";
                    break;
                case "missingConfirm":
                    parameters.Remove("confirmDelete");
                    break;
                case "bothSelectors":
                    parameters["viewName"] = "x";
                    break;
                case "nameWithoutExact":
                    parameters.Remove("viewId");
                    parameters["viewName"] = "x";
                    break;
                case "exactWithViewId":
                    parameters["exactName"] = true;
                    break;
                case "unsupportedField":
                    parameters["force"] = true;
                    break;
                case "wrongViewType":
                    parameters["viewType"] = "FloorPlan";
                    break;
            }

            AddinBatchRequestException rejection = ExpectRejection(
                BatchId,
                ValidParams(Step(0, "delete_review_view", parameters)));
            Assert.Equal(-32602, rejection.JsonRpcErrorCode);
        }

        private sealed class FakeTransactionGroup : IAddinBatchTransactionGroup
        {
            public List<string> Calls { get; } = new List<string>();

            public bool FailRollback { get; set; }

            public bool FailAssimilate { get; set; }

            public void Start()
            {
                Calls.Add("start");
            }

            public void Assimilate()
            {
                Calls.Add("assimilate");
                if (FailAssimilate)
                {
                    throw new InvalidOperationException("Injected assimilate failure");
                }
            }

            public void RollBack()
            {
                Calls.Add("rollback");
                if (FailRollback)
                {
                    throw new InvalidOperationException("Injected rollback failure");
                }
            }
        }

        private static AddinBatchRequest MixedRequest()
        {
            return ParseValid(
                Step(0, "get_ui_state"),
                Step(1, "find_elements"),
                Step(2, "delete_review_view", DeleteReviewViewParams()));
        }

        private static JObject RunBatch(
            AddinBatchRequest request,
            FakeTransactionGroup group,
            Func<AddinBatchStep, AddinBatchStepOutcome> runner)
        {
            return AddinBatchExecutor.Execute(request, group, runner);
        }

        [Fact]
        public void AssimilatesOnlyAnAllSuccessBatch()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => AddinBatchStepOutcome.Completed(new JObject { ["success"] = true, ["step"] = step.Index }));

            Assert.Equal(new[] { "start", "assimilate" }, group.Calls);
            Assert.Equal("completed", (string?)envelope["status"]);
            Assert.Equal("committed", (string?)envelope["transactionState"]);
            Assert.Equal(JTokenType.Null, envelope["failedStepIndex"]!.Type);
            Assert.Equal(BatchId, (string?)envelope["batchId"]);
            Assert.Equal(Digest, (string?)envelope["batchDigest"]);
            Assert.True((bool)envelope["atomic"]!);
            Assert.Equal(2, (int)envelope["resultContractVersion"]!);
            Assert.Equal(1, (int)envelope["batchContractVersion"]!);

            JArray steps = (JArray)envelope["steps"]!;
            Assert.Equal(3, steps.Count);
            Assert.Equal("read_only", (string?)steps[0]!["effectState"]);
            Assert.Equal("read_only", (string?)steps[1]!["effectState"]);
            Assert.Equal("committed", (string?)steps[2]!["effectState"]);
            Assert.All(steps, step => Assert.Equal("completed", (string?)step["executionState"]));
            Assert.All(steps, step => Assert.NotNull(step["result"]));

            JObject rollback = (JObject)envelope["rollback"]!;
            Assert.False((bool)rollback["attempted"]!);
            Assert.Equal(JTokenType.Null, rollback["succeeded"]!.Type);
            Assert.Equal(JTokenType.Null, rollback["triggerStepIndex"]!.Type);
            Assert.Equal(JTokenType.Null, rollback["triggerState"]!.Type);

            Assert.Equal(
                new[]
                {
                    "resultContractVersion",
                    "batchContractVersion",
                    "batchId",
                    "batchDigest",
                    "atomic",
                    "status",
                    "transactionState",
                    "failedStepIndex",
                    "steps",
                    "rollback",
                },
                envelope.Properties().Select(property => property.Name));
        }

        [Fact]
        public void RollsBackTheWholeGroupOnAMidStepFailure()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => step.Index == 1
                    ? AddinBatchStepOutcome.Failed(AddinBatchStepOutcome.CommandFailureCode, "boom")
                    : AddinBatchStepOutcome.Completed(new JObject { ["success"] = true }));

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.DoesNotContain("assimilate", group.Calls);
            Assert.Equal("failed", (string?)envelope["status"]);
            Assert.Equal("rolled_back", (string?)envelope["transactionState"]);
            Assert.Equal(1, (int)envelope["failedStepIndex"]!);

            JArray steps = (JArray)envelope["steps"]!;
            Assert.Equal("completed", (string?)steps[0]!["executionState"]);
            Assert.Equal("discarded", (string?)steps[0]!["effectState"]);
            Assert.Equal("batch_rolled_back", (string?)steps[0]!["resultSuppressed"]);
            Assert.Null(steps[0]!["result"]);
            Assert.Equal("failed", (string?)steps[1]!["executionState"]);
            Assert.Equal("command_failure", (string?)steps[1]!["error"]!["code"]);
            Assert.Equal("not_started", (string?)steps[2]!["executionState"]);
            Assert.Equal("not_started", (string?)steps[2]!["effectState"]);
            Assert.Null(steps[2]!["result"]);
            Assert.Null(steps[2]!["resultSuppressed"]);

            JObject rollback = (JObject)envelope["rollback"]!;
            Assert.True((bool)rollback["attempted"]!);
            Assert.True((bool)rollback["succeeded"]!);
            Assert.Equal(1, (int)rollback["triggerStepIndex"]!);
            Assert.Equal("failed", (string?)rollback["triggerState"]);
        }

        [Fact]
        public void RollsBackOnAGuardedStepWithANormalizedReason()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => step.Index == 2
                    ? AddinBatchStepOutcome.FromCommandResult(new JObject
                    {
                        ["success"] = true,
                        ["guarded"] = true,
                        ["reason"] = "Active View Delete-Blocked!",
                    })
                    : AddinBatchStepOutcome.Completed(new JObject { ["success"] = true }));

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.Equal("guarded", (string?)envelope["status"]);
            Assert.Equal("rolled_back", (string?)envelope["transactionState"]);
            Assert.Equal(2, (int)envelope["failedStepIndex"]!);

            JToken trigger = envelope["steps"]![2]!;
            Assert.Equal("guarded", (string?)trigger["executionState"]);
            Assert.Equal("rolled_back", (string?)trigger["effectState"]);
            Assert.Equal("active_view_delete_blocked_", (string?)trigger["guardedReason"]);
            Assert.Equal("guarded", (string?)envelope["rollback"]!["triggerState"]);
        }

        [Fact]
        public void AStepRunnerExceptionBecomesARevitApiFailureAndRollsBack()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step =>
                {
                    if (step.Index == 0)
                    {
                        throw new InvalidOperationException("Revit exploded");
                    }

                    return AddinBatchStepOutcome.Completed(new JObject());
                });

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.Equal("failed", (string?)envelope["status"]);
            Assert.Equal(0, (int)envelope["failedStepIndex"]!);
            Assert.Equal("revit_api", (string?)envelope["steps"]![0]!["error"]!["code"]);
            Assert.Equal("not_started", (string?)envelope["steps"]![1]!["executionState"]);
            Assert.Equal("not_started", (string?)envelope["steps"]![2]!["executionState"]);
        }

        [Fact]
        public void ARollbackFailureIsIndeterminate()
        {
            FakeTransactionGroup group = new FakeTransactionGroup { FailRollback = true };
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => step.Index == 2
                    ? AddinBatchStepOutcome.Failed(AddinBatchStepOutcome.CommandFailureCode, "boom")
                    : AddinBatchStepOutcome.Completed(new JObject { ["success"] = true }));

            Assert.Equal("indeterminate", (string?)envelope["status"]);
            Assert.Equal("indeterminate", (string?)envelope["transactionState"]);
            Assert.Equal(2, (int)envelope["failedStepIndex"]!);

            JArray steps = (JArray)envelope["steps"]!;
            Assert.Equal("discarded", (string?)steps[0]!["effectState"]);
            Assert.Equal("batch_indeterminate", (string?)steps[0]!["resultSuppressed"]);
            Assert.Equal("indeterminate", (string?)steps[2]!["effectState"]);
            Assert.Equal("batch_indeterminate", (string?)steps[2]!["resultSuppressed"]);

            JObject rollback = (JObject)envelope["rollback"]!;
            Assert.True((bool)rollback["attempted"]!);
            Assert.False((bool)rollback["succeeded"]!);
            Assert.Equal("failed", (string?)rollback["triggerState"]);
            Assert.Equal("rollback_failure", (string?)rollback["error"]!["code"]);
            Assert.Equal("Injected rollback failure", (string?)rollback["error"]!["message"]);
        }

        [Fact]
        public void AnAssimilateFailureIsIndeterminate()
        {
            FakeTransactionGroup group = new FakeTransactionGroup { FailAssimilate = true };
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => AddinBatchStepOutcome.Completed(new JObject { ["success"] = true }));

            Assert.Equal(new[] { "start", "assimilate", "rollback" }, group.Calls);
            Assert.Equal("indeterminate", (string?)envelope["status"]);
            Assert.Equal("indeterminate", (string?)envelope["transactionState"]);
            Assert.Equal(2, (int)envelope["failedStepIndex"]!);
            Assert.Equal("indeterminate", (string?)envelope["rollback"]!["triggerState"]);
            Assert.False((bool)envelope["rollback"]!["succeeded"]!);
            Assert.Equal("rollback_failure", (string?)envelope["rollback"]!["error"]!["code"]);
            Assert.Equal(
                "batch_indeterminate",
                (string?)envelope["steps"]![0]!["resultSuppressed"]);
        }

        [Fact]
        public void AnOversizedInlineStepResultFailsClosed()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            string oversized = new string('x', AddinBatchContract.MaxInlineResultBytes + 16);
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => step.Index == 0
                    ? AddinBatchStepOutcome.Completed(new JObject { ["blob"] = oversized })
                    : AddinBatchStepOutcome.Completed(new JObject()));

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.Equal("failed", (string?)envelope["status"]);
            Assert.Equal(0, (int)envelope["failedStepIndex"]!);
            Assert.Equal("invalid_result", (string?)envelope["steps"]![0]!["error"]!["code"]);
        }

        [Fact]
        public void AnArtifactShapedStepResultFailsClosed()
        {
            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject artifact = new JObject
            {
                ["success"] = true,
                ["files"] = new JArray(new JObject { ["path"] = "C:\\private\\artifact.bin" }),
            };
            JObject envelope = RunBatch(
                MixedRequest(),
                group,
                step => AddinBatchStepOutcome.Completed(artifact));

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.Equal("failed", (string?)envelope["status"]);
            Assert.Equal("invalid_result", (string?)envelope["steps"]![0]!["error"]!["code"]);
        }

        [Fact]
        public void AnAggregateBudgetOverflowFailsTheCurrentStepWithByteEvidence()
        {
            const long budget = 100000;
            JObject parameters = ValidParams(
                Step(0, "get_ui_state"),
                Step(1, "find_elements"),
                Step(2, "get_current_view_info"));
            parameters["maxAggregateResultBytes"] = budget;
            AddinBatchRequest request = AddinBatchRequestParser.Parse(BatchId, parameters);

            FakeTransactionGroup group = new FakeTransactionGroup();
            JObject envelope = RunBatch(
                request,
                group,
                step => AddinBatchStepOutcome.Completed(new JObject
                {
                    ["payload"] = step.Index == 1 ? new string('y', 100000) : "small",
                }));

            Assert.Equal(new[] { "start", "rollback" }, group.Calls);
            Assert.Equal("failed", (string?)envelope["status"]);
            Assert.Equal("rolled_back", (string?)envelope["transactionState"]);
            Assert.Equal(1, (int)envelope["failedStepIndex"]!);

            JObject error = (JObject)envelope["steps"]![1]!["error"]!;
            Assert.Equal("response_payload_limit", (string?)error["code"]);
            Assert.Equal(budget, (long)error["maxResponsePayloadBytes"]!);
            Assert.True((long)error["tentativeResponsePayloadBytes"]! > budget);
            Assert.Equal("not_started", (string?)envelope["steps"]![2]!["executionState"]);
        }

        [Fact]
        public void TheClassifierMapsResultShapesToOutcomes()
        {
            Assert.Equal(
                AddinBatchStepExecutionState.Completed,
                AddinBatchStepOutcome.FromCommandResult(new JObject { ["success"] = true }).State);
            Assert.Equal(
                AddinBatchStepExecutionState.Completed,
                AddinBatchStepOutcome.FromCommandResult(new JArray(1, 2, 3)).State);

            AddinBatchStepOutcome guarded = AddinBatchStepOutcome.FromCommandResult(new JObject
            {
                ["success"] = false,
                ["focusBlocked"] = true,
                ["focusBlockReason"] = "needs_scope",
            });
            Assert.Equal(AddinBatchStepExecutionState.Guarded, guarded.State);
            Assert.Equal("needs_scope", guarded.GuardedReason);

            AddinBatchStepOutcome guardedState = AddinBatchStepOutcome.FromCommandResult(new JObject
            {
                ["success"] = true,
                ["state"] = "guarded",
                ["reason"] = "delete_confirmation_required",
            });
            Assert.Equal(AddinBatchStepExecutionState.Guarded, guardedState.State);
            Assert.Equal("delete_confirmation_required", guardedState.GuardedReason);

            AddinBatchStepOutcome failed = AddinBatchStepOutcome.FromCommandResult(new JObject
            {
                ["success"] = false,
                ["errorMessage"] = "delete_not_verified",
            });
            Assert.Equal(AddinBatchStepExecutionState.Failed, failed.State);
            Assert.Equal("command_failure", failed.ErrorCode);
            Assert.Equal("delete_not_verified", failed.ErrorMessage);
        }

        [Fact]
        public void TheCapabilityDescriptorMatchesTheFrozenContract()
        {
            AddinBatchAtomicCapability capability =
                AddinBatchContract.CreateCapability(AddinFrameLimits.DefaultMaxRequestPayloadBytes);

            Assert.Equal(1, capability.ContractVersion);
            Assert.Equal("execute_batch", capability.Method);
            Assert.Equal(64, capability.MaxSteps);
            Assert.Equal(AddinFrameLimits.DefaultMaxRequestPayloadBytes, capability.MaxRequestPayloadBytes);
            Assert.Equal(33554432, capability.MaxResponsePayloadBytes);
            Assert.Equal("revit_transaction_group", capability.TransactionBoundary);
            Assert.Equal("rollback_on_non_success", capability.RollbackPolicy);

            Assert.Equal(
                new[]
                {
                    "get_current_view_elements",
                    "get_current_view_info",
                    "get_selected_elements",
                    "list_open_views",
                    "get_ui_state",
                    "find_elements",
                    "inspect_levels",
                    "inspect_sheet_text",
                    "inspect_schedules",
                    "count_annotations",
                    "extract_spatial_snapshot",
                    "get_spatial_change_state",
                    "delete_review_view",
                },
                capability.BatchableCommands.Select(command => command.Method));

            AddinBatchableCommand deleteDescriptor = capability.BatchableCommands.Single(
                command => command.Method == "delete_review_view");
            Assert.Equal("model_transaction", deleteDescriptor.Effect);
            Assert.Equal("nested_transaction_required", deleteDescriptor.TransactionPolicy);
            Assert.Equal("transaction_group_rollback", deleteDescriptor.RollbackDisposition);
            Assert.Equal("delete_review_view_commit_v1", deleteDescriptor.ParameterProfile);

            Assert.All(capability.BatchableCommands, command =>
            {
                Assert.Equal("inline_only", command.ResultDelivery);
                Assert.Equal(8388608, command.MaxInlineResultBytes);
            });
            Assert.All(
                capability.BatchableCommands.Where(command => command.Method != "delete_review_view"),
                command =>
                {
                    Assert.Equal("read_only", command.Effect);
                    Assert.Equal("none", command.TransactionPolicy);
                    Assert.Equal("discard_result_on_batch_rollback", command.RollbackDisposition);
                    Assert.Equal("ordinary_v1", command.ParameterProfile);
                });

            Assert.Throws<ArgumentOutOfRangeException>(() => AddinBatchContract.CreateCapability(1000));
        }

        [Fact]
        public void TheAdvertisedCapabilitySerializesToTheA2DescriptorShape()
        {
            // The add-in status snapshot serializes with camelCase property
            // names while preserving dictionary keys; mirror those settings.
            JsonSerializer serializer = JsonSerializer.Create(new JsonSerializerSettings
            {
                ContractResolver = new DefaultContractResolver
                {
                    NamingStrategy = new CamelCaseNamingStrategy
                    {
                        ProcessDictionaryKeys = false,
                        OverrideSpecifiedNames = false,
                    },
                },
            });

            JObject json = JObject.FromObject(
                AddinBatchContract.CreateCapability(AddinFrameLimits.DefaultMaxRequestPayloadBytes),
                serializer);

            Assert.Equal(1, (int)json["contractVersion"]!);
            Assert.Equal("execute_batch", (string?)json["method"]);
            Assert.Equal(64, (int)json["maxSteps"]!);
            Assert.Equal(
                AddinFrameLimits.DefaultMaxRequestPayloadBytes,
                (int)json["maxRequestPayloadBytes"]!);
            Assert.Equal(33554432, (int)json["maxResponsePayloadBytes"]!);
            Assert.Equal("revit_transaction_group", (string?)json["transactionBoundary"]);
            Assert.Equal("rollback_on_non_success", (string?)json["rollbackPolicy"]);

            JArray descriptors = (JArray)json["batchableCommands"]!;
            Assert.Equal(13, descriptors.Count);
            JObject first = (JObject)descriptors[0]!;
            Assert.Equal(
                new[]
                {
                    "method",
                    "effect",
                    "transactionPolicy",
                    "rollbackDisposition",
                    "parameterProfile",
                    "resultDelivery",
                    "maxInlineResultBytes",
                },
                first.Properties().Select(property => property.Name));
        }
    }
}
