#nullable enable

using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// A JSON-RPC-mappable rejection raised while validating an
    /// <c>execute_batch</c> request before any Revit execution. Appendix A.4:
    /// parse, shape, unsupported-method, descriptor-mismatch, and
    /// parameter-profile failures detected before the transaction group opens
    /// use a JSON-RPC error response and execute zero steps.
    /// </summary>
    public sealed class AddinBatchRequestException : Exception
    {
        public AddinBatchRequestException(int jsonRpcErrorCode, string message)
            : base(message)
        {
            JsonRpcErrorCode = jsonRpcErrorCode;
        }

        /// <summary>One of the standard v1 codes (-32600 or -32602).</summary>
        public int JsonRpcErrorCode { get; }
    }

    /// <summary>One validated <c>execute_batch</c> step (Appendix A.4).</summary>
    public sealed class AddinBatchStep
    {
        internal AddinBatchStep(
            int index,
            string invocationId,
            string method,
            JObject parameters,
            string paramsDigest,
            string effect)
        {
            Index = index;
            InvocationId = invocationId;
            Method = method;
            Parameters = parameters;
            ParamsDigest = paramsDigest;
            Effect = effect;
        }

        public int Index { get; }

        public string InvocationId { get; }

        public string Method { get; }

        public JObject Parameters { get; }

        public string ParamsDigest { get; }

        public string Effect { get; }

        public bool IsModelTransaction =>
            string.Equals(Effect, AddinBatchContract.ModelTransactionEffect, StringComparison.Ordinal);
    }

    /// <summary>A fully validated <c>execute_batch</c> request (Appendix A.4).</summary>
    public sealed class AddinBatchRequest
    {
        internal AddinBatchRequest(
            string batchId,
            string batchDigest,
            long maxAggregateResultBytes,
            IReadOnlyList<AddinBatchStep> steps)
        {
            BatchId = batchId;
            BatchDigest = batchDigest;
            MaxAggregateResultBytes = maxAggregateResultBytes;
            Steps = steps;
        }

        public string BatchId { get; }

        public string BatchDigest { get; }

        public long MaxAggregateResultBytes { get; }

        public IReadOnlyList<AddinBatchStep> Steps { get; }
    }
}
