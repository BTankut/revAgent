using System;
using System.Collections.Generic;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Stateful decoder for fragmented and coalesced add-in TCP reads.
    /// A bad length permanently faults this connection decoder. Frames that
    /// completed earlier in the same read remain available in the result.
    /// </summary>
    public sealed class LengthPrefixedFrameDecoder
    {
        private readonly int _maxPayloadBytes;
        private readonly byte[] _header = new byte[AddinFrameLimits.HeaderBytes];
        private int _headerCount;
        private byte[]? _payload;
        private int _payloadCount;
        private FrameDecodingFailure? _failure;

        public LengthPrefixedFrameDecoder(int maxPayloadBytes)
        {
            if (maxPayloadBytes < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(maxPayloadBytes));
            }

            _maxPayloadBytes = maxPayloadBytes;
        }

        public int MaxPayloadBytes => _maxPayloadBytes;

        public bool IsFaulted => _failure != null;

        public FrameDecodingFailure? Failure => _failure;

        public FrameDecodeResult Feed(byte[] bytes)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException(nameof(bytes));
            }

            return Feed(bytes, 0, bytes.Length);
        }

        public FrameDecodeResult Feed(byte[] bytes, int offset, int count)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException(nameof(bytes));
            }

            if (offset < 0 || count < 0 || offset > bytes.Length - count)
            {
                throw new ArgumentOutOfRangeException(
                    offset < 0 || offset > bytes.Length ? nameof(offset) : nameof(count));
            }

            var frames = new List<byte[]>();
            if (_failure != null)
            {
                return new FrameDecodeResult(frames, _failure);
            }

            int current = offset;
            int end = offset + count;
            while (current < end)
            {
                if (_payload == null)
                {
                    int headerBytes = Math.Min(
                        AddinFrameLimits.HeaderBytes - _headerCount,
                        end - current);
                    Buffer.BlockCopy(bytes, current, _header, _headerCount, headerBytes);
                    _headerCount += headerBytes;
                    current += headerBytes;

                    if (_headerCount < AddinFrameLimits.HeaderBytes)
                    {
                        continue;
                    }

                    uint declared = LengthPrefixedFrameCodec.ReadPayloadLength(_header, 0);
                    if (declared > (uint)_maxPayloadBytes)
                    {
                        Fault(declared);
                        return new FrameDecodeResult(frames, _failure);
                    }

                    _payload = new byte[(int)declared];
                    _payloadCount = 0;
                    _headerCount = 0;

                    // Framing permits an empty payload. The strict JSON layer
                    // rejects it before any JSON-RPC dispatch.
                    if (declared == 0)
                    {
                        frames.Add(_payload);
                        _payload = null;
                    }
                }

                if (_payload != null)
                {
                    int payloadBytes = Math.Min(
                        _payload.Length - _payloadCount,
                        end - current);
                    Buffer.BlockCopy(bytes, current, _payload, _payloadCount, payloadBytes);
                    _payloadCount += payloadBytes;
                    current += payloadBytes;

                    if (_payloadCount == _payload.Length)
                    {
                        frames.Add(_payload);
                        _payload = null;
                        _payloadCount = 0;
                    }
                }
            }

            return new FrameDecodeResult(frames, null);
        }

        private void Fault(uint declaredPayloadBytes)
        {
            _failure = new FrameDecodingFailure(
                "frame_payload_too_large",
                "Frame declares " + declaredPayloadBytes +
                " payload bytes; limit is " + _maxPayloadBytes + " bytes.",
                declaredPayloadBytes,
                _maxPayloadBytes);
            _headerCount = 0;
            _payload = null;
            _payloadCount = 0;
        }
    }
}
