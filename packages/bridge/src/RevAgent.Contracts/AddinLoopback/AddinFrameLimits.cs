using System;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Frozen add-in loopback v1 framing limits. Limits count only the UTF-8
    /// JSON payload and exclude the four-byte length prefix.
    /// </summary>
    public static class AddinFrameLimits
    {
        public const int HeaderBytes = 4;
        public const int SocketReadBufferBytes = 8192;
        public const int MinimumRequestPayloadBytes = 1 * 1024 * 1024;
        public const int DefaultMaxRequestPayloadBytes = 16 * 1024 * 1024;
        public const int AbsoluteMaxRequestPayloadBytes = 128 * 1024 * 1024;
        public const int MaxResponsePayloadBytes = 32 * 1024 * 1024;

        public static int ValidateAdvertisedRequestLimit(int value)
        {
            if (value < MinimumRequestPayloadBytes ||
                value > AbsoluteMaxRequestPayloadBytes)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(value),
                    value,
                    "The add-in request payload limit must be between 1 MiB and 128 MiB.");
            }

            return value;
        }
    }
}
