namespace RevAgent.Bridge.Bootstrap.Configuration;

internal sealed class BridgeConfigurationException : Exception
{
    internal BridgeConfigurationException(
        string errorCode,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
    }

    internal string ErrorCode { get; }
}
