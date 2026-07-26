#nullable enable

using System;
using System.Collections.Generic;

namespace RevAgent.Contracts.AddinLoopback
{
    public static class AddinStatusContract
    {
        public const int Version = 1;
        public const string BatchAtomicCapability = "batch_atomic";
        public const string DocumentContextCachedCapability = "doc_context_cached_v1";
    }

    public sealed class AddinStatusSnapshot
    {
        internal AddinStatusSnapshot(
            string addinVersion,
            AddinRevitIdentity revit,
            AddinServiceStatus service,
            IReadOnlyList<string> sessionCapabilities,
            AddinBatchAtomicCapability? batchAtomic,
            AddinDocumentContextCapability? documentContextCached,
            AddinTaskStatus? activeTask,
            IReadOnlyList<AddinTaskStatus> recentTasks,
            int recentHistoryCount,
            AddinPlanStatus plan)
        {
            AddinVersion = addinVersion;
            Revit = revit;
            Service = service;
            SessionCapabilities = sessionCapabilities;
            BatchAtomic = batchAtomic;
            DocumentContextCached = documentContextCached;
            ActiveTask = activeTask;
            RecentTasks = recentTasks;
            RecentHistoryCount = recentHistoryCount;
            Plan = plan;
        }

        public int ResultContractVersion => AddinJsonRpcCodec.ResultContractVersion;

        public int AddinLoopbackContractVersion => AddinStatusContract.Version;

        public string AddinVersion { get; }

        public AddinRevitIdentity Revit { get; }

        public AddinServiceStatus Service { get; }

        public IReadOnlyList<string> SessionCapabilities { get; }

        public AddinBatchAtomicCapability? BatchAtomic { get; }

        public AddinDocumentContextCapability? DocumentContextCached { get; }

        public AddinTaskStatus? ActiveTask { get; }

        public IReadOnlyList<AddinTaskStatus> RecentTasks { get; }

        public int RecentHistoryCount { get; }

        public int RecentHistoryCapacity => 100;

        public AddinPlanStatus Plan { get; }
    }

    public sealed class AddinRevitIdentity
    {
        internal AddinRevitIdentity(string version, string build, long processId)
        {
            Version = version;
            Build = build;
            ProcessId = processId;
        }

        public string Version { get; }

        public string Build { get; }

        public long ProcessId { get; }
    }

    public sealed class AddinServiceStatus
    {
        internal AddinServiceStatus(
            int port,
            IReadOnlyList<string> boundAddresses,
            AddinFramingStatus framing)
        {
            Port = port;
            BoundAddresses = boundAddresses;
            Framing = framing;
        }

        public bool IsRunning => true;

        public int Port { get; }

        public string Binding => "loopback_only";

        public IReadOnlyList<string> BoundAddresses { get; }

        public AddinFramingStatus Framing { get; }
    }

    public sealed class AddinFramingStatus
    {
        internal AddinFramingStatus(int maxRequestPayloadBytes)
        {
            MaxRequestPayloadBytes = maxRequestPayloadBytes;
        }

        public string Protocol => "length_prefixed_jsonrpc_v1";

        public int HeaderBytes => AddinFrameLimits.HeaderBytes;

        public string ByteOrder => "big_endian";

        public string PayloadEncoding => "utf-8";

        public int MaxRequestPayloadBytes { get; }

        public int MaxResponsePayloadBytes => AddinFrameLimits.MaxResponsePayloadBytes;
    }

    public sealed class AddinBatchAtomicCapability
    {
        internal AddinBatchAtomicCapability(
            int maxSteps,
            int maxRequestPayloadBytes,
            IReadOnlyList<AddinBatchableCommand> batchableCommands)
        {
            MaxSteps = maxSteps;
            MaxRequestPayloadBytes = maxRequestPayloadBytes;
            BatchableCommands = batchableCommands;
        }

        public int ContractVersion => 1;

        public string Method => "execute_batch";

        public int MaxSteps { get; }

        public int MaxRequestPayloadBytes { get; }

        public int MaxResponsePayloadBytes => AddinFrameLimits.MaxResponsePayloadBytes;

        public string TransactionBoundary => "revit_transaction_group";

        public string RollbackPolicy => "rollback_on_non_success";

        public IReadOnlyList<AddinBatchableCommand> BatchableCommands { get; }
    }

    public sealed class AddinBatchableCommand
    {
        internal AddinBatchableCommand(
            string method,
            string effect,
            string transactionPolicy,
            string rollbackDisposition,
            string parameterProfile)
        {
            Method = method;
            Effect = effect;
            TransactionPolicy = transactionPolicy;
            RollbackDisposition = rollbackDisposition;
            ParameterProfile = parameterProfile;
        }

        public string Method { get; }

        public string Effect { get; }

        public string TransactionPolicy { get; }

        public string RollbackDisposition { get; }

        public string ParameterProfile { get; }

        public string ResultDelivery => "inline_only";

        public int MaxInlineResultBytes => 8 * 1024 * 1024;
    }

    public sealed class AddinDocumentContextCapability
    {
        internal AddinDocumentContextCapability()
        {
        }

        public int ContractVersion => 1;

        public string Method => "get_document_context";

        public string Source => "application_events_cache";

        public int PollIntervalMs => 15000;

        public bool UiThreadRoundTrip => false;
    }

    public sealed class AddinTaskStatus
    {
        internal AddinTaskStatus(
            string id,
            string requestId,
            string method,
            string? wrapperAction,
            string? logicalToolName,
            string taskName,
            string? parentTaskName,
            string? parentTaskId,
            string state,
            DateTimeOffset startedAtUtc,
            DateTimeOffset? finishedAtUtc,
            long elapsedMs,
            int port,
            string? error,
            string? framing,
            long? requestBytes,
            long? receiveMs,
            long? parseMs,
            long? executeMs,
            long? responseBytes)
        {
            Id = id;
            RequestId = requestId;
            Method = method;
            WrapperAction = wrapperAction;
            LogicalToolName = logicalToolName;
            TaskName = taskName;
            ParentTaskName = parentTaskName;
            ParentTaskId = parentTaskId;
            State = state;
            StartedAtUtc = startedAtUtc;
            FinishedAtUtc = finishedAtUtc;
            ElapsedMs = elapsedMs;
            Port = port;
            Error = error;
            Framing = framing;
            RequestBytes = requestBytes;
            ReceiveMs = receiveMs;
            ParseMs = parseMs;
            ExecuteMs = executeMs;
            ResponseBytes = responseBytes;
        }

        public string Id { get; }

        public string RequestId { get; }

        public string Method { get; }

        public string? WrapperAction { get; }

        public string? LogicalToolName { get; }

        public string TaskName { get; }

        public string? ParentTaskName { get; }

        public string? ParentTaskId { get; }

        public string State { get; }

        public DateTimeOffset StartedAtUtc { get; }

        public DateTimeOffset? FinishedAtUtc { get; }

        public long ElapsedMs { get; }

        public int Port { get; }

        public string? Error { get; }

        public string? Framing { get; }

        public long? RequestBytes { get; }

        public long? ReceiveMs { get; }

        public long? ParseMs { get; }

        public long? ExecuteMs { get; }

        public long? ResponseBytes { get; }
    }

    public sealed class AddinPlanStatus
    {
        internal AddinPlanStatus(
            IReadOnlyList<string> pending,
            IReadOnlyList<string> completed)
        {
            Pending = pending;
            Completed = completed;
        }

        public IReadOnlyList<string> Pending { get; }

        public IReadOnlyList<string> Completed { get; }
    }
}
