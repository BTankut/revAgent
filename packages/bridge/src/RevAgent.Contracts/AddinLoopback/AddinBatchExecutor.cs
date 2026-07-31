#nullable enable

using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// The one atomic transaction boundary an <c>execute_batch</c> dispatch
    /// runs under. The add-in implements this over one Revit
    /// <c>TransactionGroup</c>; tests implement it over a deterministic fake so
    /// the assimilate-on-success / rollback-on-non-success state machine is
    /// provable without Revit.
    /// </summary>
    public interface IAddinBatchTransactionGroup
    {
        void Start();

        void Assimilate();

        void RollBack();
    }

    /// <summary>
    /// Executes a validated <c>execute_batch</c> request as ONE transaction
    /// group per Appendix A.4: steps run in input order, the first non-success
    /// rolls the whole group back with a <c>not_started</c> suffix, per-step
    /// inline-only and aggregate byte budgets are enforced before
    /// <c>Assimilate()</c>, and only an all-success envelope at or below the
    /// cap may assimilate.
    /// </summary>
    public static class AddinBatchExecutor
    {
        private const string RollbackFailureCode = "rollback_failure";

        public static JObject Execute(
            AddinBatchRequest request,
            IAddinBatchTransactionGroup transactionGroup,
            Func<AddinBatchStep, AddinBatchStepOutcome> stepRunner)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            if (transactionGroup == null)
            {
                throw new ArgumentNullException(nameof(transactionGroup));
            }

            if (stepRunner == null)
            {
                throw new ArgumentNullException(nameof(stepRunner));
            }

            List<AddinBatchStepOutcome> outcomes = new List<AddinBatchStepOutcome>(request.Steps.Count);
            transactionGroup.Start();
            int triggerIndex = -1;

            foreach (AddinBatchStep step in request.Steps)
            {
                AddinBatchStepOutcome outcome;
                try
                {
                    outcome = stepRunner(step) ?? AddinBatchStepOutcome.Failed(
                        AddinBatchStepOutcome.InvalidResultCode,
                        "Batch step runner returned no outcome");
                }
                catch (Exception exception)
                {
                    outcome = AddinBatchStepOutcome.Failed(
                        AddinBatchStepOutcome.RevitApiCode,
                        exception.Message);
                }

                if (outcome.State == AddinBatchStepExecutionState.Completed)
                {
                    outcome = EnforceInlineOnlyResult(outcome);
                }

                outcomes.Add(outcome);
                if (outcome.State != AddinBatchStepExecutionState.Completed)
                {
                    triggerIndex = step.Index;
                    break;
                }

                long tentativeBytes = CountResponsePayloadBytes(
                    request.BatchId,
                    BuildCompletedEnvelope(request, outcomes));
                if (tentativeBytes > request.MaxAggregateResultBytes)
                {
                    outcomes[outcomes.Count - 1] = AddinBatchStepOutcome.ResponsePayloadLimit(
                        request.MaxAggregateResultBytes,
                        tentativeBytes);
                    triggerIndex = step.Index;
                    break;
                }
            }

            if (triggerIndex < 0)
            {
                JObject completedEnvelope = BuildCompletedEnvelope(request, outcomes);
                try
                {
                    transactionGroup.Assimilate();
                }
                catch (Exception exception)
                {
                    TryRollBackAfterFailedAssimilate(transactionGroup);
                    return BuildIndeterminateEnvelope(
                        request,
                        outcomes,
                        request.Steps.Count - 1,
                        "indeterminate",
                        exception.Message);
                }

                return completedEnvelope;
            }

            AddinBatchStepOutcome trigger = outcomes[outcomes.Count - 1];
            string triggerState = trigger.State == AddinBatchStepExecutionState.Guarded ? "guarded" : "failed";
            try
            {
                transactionGroup.RollBack();
            }
            catch (Exception exception)
            {
                return BuildIndeterminateEnvelope(request, outcomes, triggerIndex, triggerState, exception.Message);
            }

            return BuildRolledBackEnvelope(request, outcomes, triggerIndex, triggerState);
        }

        private static void TryRollBackAfterFailedAssimilate(IAddinBatchTransactionGroup transactionGroup)
        {
            try
            {
                transactionGroup.RollBack();
            }
            catch
            {
                // The batch is already indeterminate; the rollback attempt is
                // best-effort containment and its own failure adds no new state.
            }
        }

        private static AddinBatchStepOutcome EnforceInlineOnlyResult(AddinBatchStepOutcome outcome)
        {
            JToken result = outcome.Result ?? JValue.CreateNull();
            if (HasDeclaredArtifactShape(result))
            {
                return AddinBatchStepOutcome.Failed(
                    AddinBatchStepOutcome.InvalidResultCode,
                    "Batch inline-only command returned artifact-shaped data");
            }

            long inlineBytes = CountCanonicalBytes(result);
            if (inlineBytes > AddinBatchContract.MaxInlineResultBytes)
            {
                return AddinBatchStepOutcome.Failed(
                    AddinBatchStepOutcome.InvalidResultCode,
                    "Batch inline-only command result exceeds " +
                    AddinBatchContract.MaxInlineResultBytes + " bytes");
            }

            return outcome;
        }

        private static bool HasDeclaredArtifactShape(JToken result)
        {
            if (!(result is JObject obj) || !(obj["files"] is JArray files) || files.Count == 0)
            {
                return false;
            }

            foreach (JToken entry in files)
            {
                if (entry is JObject file &&
                    (IsString(file["path"]) || IsString(file["fileName"]) || IsString(file["contentBase64"])))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsString(JToken? token)
        {
            return token != null && token.Type == JTokenType.String;
        }

        private static JObject BuildCompletedEnvelope(
            AddinBatchRequest request,
            IReadOnlyList<AddinBatchStepOutcome> outcomes)
        {
            JArray steps = new JArray();
            for (int index = 0; index < outcomes.Count; index++)
            {
                AddinBatchStep step = request.Steps[index];
                steps.Add(new JObject
                {
                    ["index"] = step.Index,
                    ["invocationId"] = step.InvocationId,
                    ["method"] = step.Method,
                    ["executionState"] = "completed",
                    ["effectState"] = step.IsModelTransaction ? "committed" : "read_only",
                    ["result"] = outcomes[index].Result ?? JValue.CreateNull(),
                });
            }

            AppendNotStartedSuffix(request, steps, outcomes.Count);
            return BuildEnvelope(
                request,
                "completed",
                "committed",
                null,
                steps,
                new JObject
                {
                    ["attempted"] = false,
                    ["succeeded"] = JValue.CreateNull(),
                    ["triggerStepIndex"] = JValue.CreateNull(),
                    ["triggerState"] = JValue.CreateNull(),
                });
        }

        private static JObject BuildRolledBackEnvelope(
            AddinBatchRequest request,
            IReadOnlyList<AddinBatchStepOutcome> outcomes,
            int triggerIndex,
            string triggerState)
        {
            JArray steps = new JArray();
            for (int index = 0; index < outcomes.Count; index++)
            {
                steps.Add(BuildSuppressedStep(request.Steps[index], outcomes[index], "batch_rolled_back"));
            }

            AppendNotStartedSuffix(request, steps, outcomes.Count);
            return BuildEnvelope(
                request,
                triggerState,
                "rolled_back",
                triggerIndex,
                steps,
                new JObject
                {
                    ["attempted"] = true,
                    ["succeeded"] = true,
                    ["triggerStepIndex"] = triggerIndex,
                    ["triggerState"] = triggerState,
                });
        }

        private static JObject BuildIndeterminateEnvelope(
            AddinBatchRequest request,
            IReadOnlyList<AddinBatchStepOutcome> outcomes,
            int triggerIndex,
            string triggerState,
            string? rollbackErrorMessage)
        {
            JArray steps = new JArray();
            for (int index = 0; index < outcomes.Count; index++)
            {
                steps.Add(BuildSuppressedStep(request.Steps[index], outcomes[index], "batch_indeterminate"));
            }

            AppendNotStartedSuffix(request, steps, outcomes.Count);
            return BuildEnvelope(
                request,
                "indeterminate",
                "indeterminate",
                triggerIndex,
                steps,
                new JObject
                {
                    ["attempted"] = true,
                    ["succeeded"] = false,
                    ["triggerStepIndex"] = triggerIndex,
                    ["triggerState"] = triggerState,
                    ["error"] = new JObject
                    {
                        ["code"] = RollbackFailureCode,
                        ["message"] = AddinBatchStepOutcome.BoundMessage(rollbackErrorMessage),
                    },
                });
        }

        private static JObject BuildSuppressedStep(
            AddinBatchStep step,
            AddinBatchStepOutcome outcome,
            string suppression)
        {
            bool indeterminate = string.Equals(suppression, "batch_indeterminate", StringComparison.Ordinal);
            string effectState = step.IsModelTransaction
                ? (indeterminate ? "indeterminate" : "rolled_back")
                : "discarded";
            JObject entry = new JObject
            {
                ["index"] = step.Index,
                ["invocationId"] = step.InvocationId,
                ["method"] = step.Method,
                ["executionState"] = ExecutionStateToken(outcome.State),
                ["effectState"] = effectState,
            };

            if (outcome.State == AddinBatchStepExecutionState.Guarded)
            {
                entry["guardedReason"] = outcome.GuardedReason ?? "guarded";
            }
            else if (outcome.State == AddinBatchStepExecutionState.Failed)
            {
                JObject error = new JObject
                {
                    ["code"] = outcome.ErrorCode ?? AddinBatchStepOutcome.CommandFailureCode,
                    ["message"] = AddinBatchStepOutcome.BoundMessage(outcome.ErrorMessage),
                };
                if (string.Equals(
                    outcome.ErrorCode,
                    AddinBatchStepOutcome.ResponsePayloadLimitCode,
                    StringComparison.Ordinal))
                {
                    error["maxResponsePayloadBytes"] = outcome.MaxResponsePayloadBytes;
                    error["tentativeResponsePayloadBytes"] = outcome.TentativeResponsePayloadBytes;
                }

                entry["error"] = error;
            }

            entry["resultSuppressed"] = suppression;
            return entry;
        }

        private static string ExecutionStateToken(AddinBatchStepExecutionState state)
        {
            switch (state)
            {
                case AddinBatchStepExecutionState.Completed:
                    return "completed";
                case AddinBatchStepExecutionState.Guarded:
                    return "guarded";
                default:
                    return "failed";
            }
        }

        private static void AppendNotStartedSuffix(AddinBatchRequest request, JArray steps, int executedCount)
        {
            for (int index = executedCount; index < request.Steps.Count; index++)
            {
                AddinBatchStep step = request.Steps[index];
                steps.Add(new JObject
                {
                    ["index"] = step.Index,
                    ["invocationId"] = step.InvocationId,
                    ["method"] = step.Method,
                    ["executionState"] = "not_started",
                    ["effectState"] = "not_started",
                });
            }
        }

        private static JObject BuildEnvelope(
            AddinBatchRequest request,
            string status,
            string transactionState,
            int? failedStepIndex,
            JArray steps,
            JObject rollback)
        {
            return new JObject
            {
                ["resultContractVersion"] = AddinJsonRpcCodec.ResultContractVersion,
                ["batchContractVersion"] = AddinBatchContract.BatchContractVersion,
                ["batchId"] = request.BatchId,
                ["batchDigest"] = request.BatchDigest,
                ["atomic"] = true,
                ["status"] = status,
                ["transactionState"] = transactionState,
                ["failedStepIndex"] = failedStepIndex.HasValue
                    ? new JValue(failedStepIndex.Value)
                    : JValue.CreateNull(),
                ["steps"] = steps,
                ["rollback"] = rollback,
            };
        }

        /// <summary>
        /// Counts the BOM-free UTF-8 bytes of the complete JSON-RPC success
        /// payload that would carry this result envelope on the wire.
        /// </summary>
        public static long CountResponsePayloadBytes(string batchId, JObject resultEnvelope)
        {
            JObject payload = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = batchId,
                ["result"] = resultEnvelope,
            };
            return CountCanonicalBytes(payload);
        }

        private static long CountCanonicalBytes(JToken token)
        {
            string json = token.ToString(Formatting.None);
            return Encoding.UTF8.GetByteCount(json);
        }
    }
}
