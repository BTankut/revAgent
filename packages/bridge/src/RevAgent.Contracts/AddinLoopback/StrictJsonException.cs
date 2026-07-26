using System;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class StrictJsonException : Exception
    {
        public StrictJsonException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public StrictJsonException(string code, string message, Exception innerException)
            : base(message, innerException)
        {
            Code = code;
        }

        public string Code { get; }
    }
}
