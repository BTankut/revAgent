using System.Collections.Generic;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class FrameDecodeResult
    {
        internal FrameDecodeResult(
            IReadOnlyList<byte[]> frames,
            FrameDecodingFailure? failure)
        {
            Frames = frames;
            Failure = failure;
        }

        /// <summary>
        /// Complete frames decoded before any failure in this feed call.
        /// </summary>
        public IReadOnlyList<byte[]> Frames { get; }

        /// <summary>
        /// The permanent decoder failure, or null while the stream is healthy.
        /// </summary>
        public FrameDecodingFailure? Failure { get; }

        public bool IsFaulted => Failure != null;
    }
}
