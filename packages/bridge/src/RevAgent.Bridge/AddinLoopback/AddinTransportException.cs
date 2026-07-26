namespace RevAgent.Bridge.AddinLoopback;

internal sealed class AddinTransportException : Exception
{
    internal AddinTransportException(
        string code,
        string message,
        AddinTransportEvidence evidence,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        Evidence = evidence;
    }

    internal string Code { get; }

    internal AddinTransportEvidence Evidence { get; }
}
