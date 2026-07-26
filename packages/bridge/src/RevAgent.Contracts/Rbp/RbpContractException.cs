#nullable enable

using System;

namespace RevAgent.Contracts.Rbp
{
    public sealed class RbpContractException : FormatException
    {
        public RbpContractException(string message)
            : base(message)
        {
        }

        public RbpContractException(string message, Exception innerException)
            : base(message, innerException)
        {
        }
    }
}
