#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Frozen add-in loopback v1 <c>execute_batch</c> contract constants
    /// (O1 Appendix A.2/A.4 and
    /// packages/protocol/schemas/addin-loopback/v1/execute-batch.schema.json).
    /// The add-in advertises exactly this descriptor set for the
    /// <c>batch_atomic</c> session capability and rejects every step outside it
    /// before opening a Revit TransactionGroup.
    /// </summary>
    public static class AddinBatchContract
    {
        public const int BatchContractVersion = 1;
        public const string Method = "execute_batch";
        public const int MaxSteps = 64;
        public const int MaxInlineResultBytes = 8 * 1024 * 1024;
        public const string TransactionBoundary = "revit_transaction_group";
        public const string RollbackPolicy = "rollback_on_non_success";
        public const string ReadOnlyEffect = "read_only";
        public const string ModelTransactionEffect = "model_transaction";
        public const string OrdinaryParameterProfile = "ordinary_v1";
        public const string DeleteReviewViewParameterProfile = "delete_review_view_commit_v1";
        public const string DeleteReviewViewMethod = "delete_review_view";

        /// <summary>The exact hard v1 eligible method set, in contract order.</summary>
        public static readonly IReadOnlyList<string> BatchableMethods = new[]
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
            DeleteReviewViewMethod,
        };

        /// <summary>
        /// The exact Appendix A.4 reserved parameter-name set rejected inside
        /// ordinary v1 step params before dispatch. The rejection is
        /// case-sensitive and does not close the params object to future
        /// functional tool parameters.
        /// </summary>
        public static readonly IReadOnlyList<string> ReservedOrdinaryParameterNames = new[]
        {
            "target",
            "host",
            "port",
            "timeoutMs",
            "statusRefreshTimeoutMs",
            "refreshStatusAfterCommand",
            "responseMode",
            "transactionMode",
            "parseJsonResult",
            "taskName",
            "taskId",
            "wrapperAction",
            "logicalToolName",
            "toolName",
            "parentTaskName",
            "parentTaskId",
            "suppressTaskStatusWindow",
            "display",
            "invocation_id",
            "batch_id",
            "batch_digest",
            "params_digest",
            "mutating",
            "mutation_scope",
            "policy",
            "verification",
            "recovery_clearances",
            "timeout_ms",
            "batchContractVersion",
            "batchId",
            "batchDigest",
            "invocationId",
            "paramsDigest",
            "effect",
            "atomic",
            "rollbackPolicy",
            "maxAggregateResultBytes",
        };

        private static readonly HashSet<string> ReservedOrdinaryParameterNameSet =
            new HashSet<string>(ReservedOrdinaryParameterNames, StringComparer.Ordinal);

        private static readonly Dictionary<string, AddinBatchableCommand> DescriptorsByMethod =
            BatchableMethods
                .Select(method => string.Equals(method, DeleteReviewViewMethod, StringComparison.Ordinal)
                    ? new AddinBatchableCommand(
                        method,
                        ModelTransactionEffect,
                        "nested_transaction_required",
                        "transaction_group_rollback",
                        DeleteReviewViewParameterProfile)
                    : new AddinBatchableCommand(
                        method,
                        ReadOnlyEffect,
                        "none",
                        "discard_result_on_batch_rollback",
                        OrdinaryParameterProfile))
                .ToDictionary(descriptor => descriptor.Method, StringComparer.Ordinal);

        /// <summary>The advertised descriptors in contract order.</summary>
        public static readonly IReadOnlyList<AddinBatchableCommand> BatchableCommands =
            BatchableMethods.Select(method => DescriptorsByMethod[method]).ToArray();

        public static bool IsReservedOrdinaryParameterName(string name)
        {
            return ReservedOrdinaryParameterNameSet.Contains(name);
        }

        public static bool TryGetDescriptor(string method, out AddinBatchableCommand descriptor)
        {
            if (method != null && DescriptorsByMethod.TryGetValue(method, out AddinBatchableCommand found))
            {
                descriptor = found;
                return true;
            }

            descriptor = null!;
            return false;
        }

        /// <summary>
        /// Builds the exact Appendix A.2 <c>batch_atomic</c> capability
        /// descriptor for one probed session. The request cap MUST equal the
        /// listener's effective <c>service.framing.maxRequestPayloadBytes</c>.
        /// </summary>
        public static AddinBatchAtomicCapability CreateCapability(int maxRequestPayloadBytes)
        {
            AddinFrameLimits.ValidateAdvertisedRequestLimit(maxRequestPayloadBytes);
            return new AddinBatchAtomicCapability(MaxSteps, maxRequestPayloadBytes, BatchableCommands);
        }
    }
}
