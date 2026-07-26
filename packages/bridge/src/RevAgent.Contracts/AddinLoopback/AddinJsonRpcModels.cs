using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class AddinJsonRpcRequest
    {
        internal AddinJsonRpcRequest(string id, string method, JObject parameters)
        {
            Id = id;
            Method = method;
            Params = parameters;
        }

        public string Id { get; }

        public string Method { get; }

        public JObject Params { get; }
    }

    public sealed class AddinJsonRpcError
    {
        internal AddinJsonRpcError(int code, string message, JToken? data)
        {
            Code = code;
            Message = message;
            Data = data;
        }

        public int Code { get; }

        public string Message { get; }

        public JToken? Data { get; }
    }

    public sealed class AddinJsonRpcResponse
    {
        internal AddinJsonRpcResponse(
            string? id,
            JObject? result,
            AddinJsonRpcError? error,
            byte[] rawPayload)
        {
            Id = id;
            Result = result;
            Error = error;
            RawPayload = rawPayload;
        }

        public string? Id { get; }

        public JObject? Result { get; }

        public AddinJsonRpcError? Error { get; }

        public byte[] RawPayload { get; }

        public bool IsSuccess => Result != null;

        public int? ResultContractVersion =>
            Result == null ? (int?)null : Result.Value<int?>("resultContractVersion");
    }
}
