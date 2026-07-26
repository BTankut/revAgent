namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class FrameDecodingFailure
    {
        internal FrameDecodingFailure(
            string code,
            string message,
            uint declaredPayloadBytes,
            int maxPayloadBytes)
        {
            Code = code;
            Message = message;
            DeclaredPayloadBytes = declaredPayloadBytes;
            MaxPayloadBytes = maxPayloadBytes;
        }

        public string Code { get; }

        public string Message { get; }

        public uint DeclaredPayloadBytes { get; }

        public int MaxPayloadBytes { get; }
    }
}
