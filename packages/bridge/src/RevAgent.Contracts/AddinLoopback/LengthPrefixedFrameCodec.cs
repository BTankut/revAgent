using System;
using System.Text;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Encodes the existing add-in TCP framing: one unsigned, four-byte,
    /// big-endian payload length followed by that many payload bytes.
    /// </summary>
    public static class LengthPrefixedFrameCodec
    {
        private static readonly UTF8Encoding StrictUtf8 =
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

        public static byte[] EncodePayload(byte[] payload, int maxPayloadBytes)
        {
            if (payload == null)
            {
                throw new ArgumentNullException(nameof(payload));
            }

            if (maxPayloadBytes < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(maxPayloadBytes));
            }

            if (payload.Length > maxPayloadBytes)
            {
                throw new FrameCodecException(
                    "frame_payload_too_large",
                    "Frame payload is " + payload.Length +
                    " bytes; limit is " + maxPayloadBytes + " bytes.");
            }

            var frame = new byte[AddinFrameLimits.HeaderBytes + payload.Length];
            WritePayloadLength(frame, 0, (uint)payload.Length);
            Buffer.BlockCopy(
                payload,
                0,
                frame,
                AddinFrameLimits.HeaderBytes,
                payload.Length);
            return frame;
        }

        public static byte[] EncodeJson(string json, int maxPayloadBytes)
        {
            if (json == null)
            {
                throw new ArgumentNullException(nameof(json));
            }

            byte[] payload;
            try
            {
                payload = StrictUtf8.GetBytes(json);
            }
            catch (EncoderFallbackException ex)
            {
                throw new FrameCodecException(
                    "invalid_utf16",
                    "JSON contains an unpaired UTF-16 surrogate and cannot be encoded: " +
                    ex.Message);
            }

            return EncodePayload(payload, maxPayloadBytes);
        }

        public static uint ReadPayloadLength(byte[] header, int offset)
        {
            if (header == null)
            {
                throw new ArgumentNullException(nameof(header));
            }

            if (offset < 0 || offset > header.Length - AddinFrameLimits.HeaderBytes)
            {
                throw new ArgumentOutOfRangeException(nameof(offset));
            }

            return ((uint)header[offset] << 24) |
                   ((uint)header[offset + 1] << 16) |
                   ((uint)header[offset + 2] << 8) |
                   header[offset + 3];
        }

        public static void WritePayloadLength(byte[] destination, int offset, uint payloadLength)
        {
            if (destination == null)
            {
                throw new ArgumentNullException(nameof(destination));
            }

            if (offset < 0 || offset > destination.Length - AddinFrameLimits.HeaderBytes)
            {
                throw new ArgumentOutOfRangeException(nameof(offset));
            }

            destination[offset] = (byte)(payloadLength >> 24);
            destination[offset + 1] = (byte)(payloadLength >> 16);
            destination[offset + 2] = (byte)(payloadLength >> 8);
            destination[offset + 3] = (byte)payloadLength;
        }
    }
}
