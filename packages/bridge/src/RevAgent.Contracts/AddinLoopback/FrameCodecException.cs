using System;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class FrameCodecException : Exception
    {
        public FrameCodecException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; }
    }
}
