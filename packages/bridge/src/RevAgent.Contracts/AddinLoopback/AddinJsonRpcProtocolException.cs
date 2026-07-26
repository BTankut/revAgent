using System;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class AddinJsonRpcProtocolException : Exception
    {
        public AddinJsonRpcProtocolException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; }
    }
}
