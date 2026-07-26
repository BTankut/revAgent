using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed class AddinCall
{
    private readonly JObject _parameters;

    internal AddinCall(
        string invocationId,
        string method,
        JObject parameters,
        TimeSpan timeout,
        int maxRequestPayloadBytes = AddinFrameLimits.DefaultMaxRequestPayloadBytes)
    {
        ArgumentNullException.ThrowIfNull(invocationId);
        ArgumentNullException.ThrowIfNull(method);
        ArgumentNullException.ThrowIfNull(parameters);

        if (timeout <= TimeSpan.Zero ||
            timeout.TotalMilliseconds > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeout),
                timeout,
                "The add-in call timeout must be positive and fit a bounded timer.");
        }

        InvocationId = invocationId;
        Method = method;
        _parameters = (JObject)parameters.DeepClone();
        Timeout = timeout;
        MaxRequestPayloadBytes =
            AddinFrameLimits.ValidateAdvertisedRequestLimit(maxRequestPayloadBytes);
    }

    internal string InvocationId { get; }

    internal string Method { get; }

    internal TimeSpan Timeout { get; }

    internal int MaxRequestPayloadBytes { get; }

    internal JObject CopyParameters() => (JObject)_parameters.DeepClone();
}

internal enum AddinDispatchState
{
    NotStarted,
    MayHaveReachedAddin,
    ResponseObserved,
}

internal sealed record AddinTransportEvidence(
    AddinDispatchState DispatchState,
    int RequestPayloadBytes,
    int RequestFrameBytes,
    int BytesWrittenLowerBound,
    bool RequestFullyWritten,
    int ResponseBytesObserved)
{
    internal bool ResponseStarted => ResponseBytesObserved > 0;
}

internal sealed record AddinCallResult(
    AddinJsonRpcResponse Response,
    AddinTransportEvidence Evidence);
