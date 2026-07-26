namespace RevAgent.Bridge.Gateway.Protocol;

internal static class RbpProtocolLimits
{
    internal const int MaximumWireFrameBytes = 48 * 1024 * 1024;

    internal const int MaximumInvocationParametersBytes = 4 * 1024 * 1024;

    internal const int MaximumInlineResultBytes = 32 * 1024 * 1024;

    internal const int MaximumControlFrameBytes = 64 * 1024;

    internal const int MaximumDocumentContextFrameBytes = 256 * 1024;

    internal const int MaximumPartialBytes = 1024 * 1024;

    internal const long MaximumSafeInteger = 9_007_199_254_740_991;
}
