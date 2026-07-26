using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using RevAgent.Contracts.AddinLoopback;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    public sealed class FrameCodecTests
    {
        [Fact]
        public void FrozenNodeClientFixtureIsByteExact()
        {
            byte[] fixture = ReadFixture("node-client-utf8-request.bin");
            const string json =
                "{\"jsonrpc\":\"2.0\",\"id\":\"frame-utf8\",\"method\":\"echo\",\"params\":{\"text\":\"ğ\"}}";

            byte[] encoded = LengthPrefixedFrameCodec.EncodeJson(
                json,
                AddinFrameLimits.DefaultMaxRequestPayloadBytes);

            Assert.Equal(fixture, encoded);
            Assert.Equal(74u, LengthPrefixedFrameCodec.ReadPayloadLength(encoded, 0));
        }

        [Fact]
        public void FrozenAddinResponseFixtureIsByteExact()
        {
            byte[] fixture = ReadFixture("addin-success-response.bin");
            const string json =
                "{\"jsonrpc\":\"2.0\",\"id\":\"frame-response\",\"result\":{\"resultContractVersion\":2,\"ok\":true}}";

            byte[] encoded = LengthPrefixedFrameCodec.EncodeJson(
                json,
                AddinFrameLimits.MaxResponsePayloadBytes);

            Assert.Equal(fixture, encoded);
            Assert.Equal(86u, LengthPrefixedFrameCodec.ReadPayloadLength(encoded, 0));
        }

        [Fact]
        public void DecoderAcceptsFrozenCoalescedFixture()
        {
            byte[] coalesced = ReadFixture("coalesced-two-frames.bin");
            var decoder = new LengthPrefixedFrameDecoder(
                AddinFrameLimits.MaxResponsePayloadBytes);

            FrameDecodeResult result = decoder.Feed(coalesced);

            Assert.False(result.IsFaulted);
            Assert.Equal(2, result.Frames.Count);
            Assert.Equal(
                "{\"jsonrpc\":\"2.0\",\"id\":\"frame-utf8\",\"method\":\"echo\",\"params\":{\"text\":\"ğ\"}}",
                Encoding.UTF8.GetString(result.Frames[0]));
            Assert.Equal(
                "{\"jsonrpc\":\"2.0\",\"id\":\"frame-response\",\"result\":{\"resultContractVersion\":2,\"ok\":true}}",
                Encoding.UTF8.GetString(result.Frames[1]));
        }

        [Fact]
        public void DecoderHandlesEveryFragmentBoundary()
        {
            byte[] first = ReadFixture("node-client-utf8-request.bin");
            byte[] second = ReadFixture("addin-success-response.bin");
            byte[] coalesced = first.Concat(second).ToArray();

            for (int split = 0; split <= coalesced.Length; split++)
            {
                var decoder = new LengthPrefixedFrameDecoder(
                    AddinFrameLimits.MaxResponsePayloadBytes);
                var decoded = new List<byte[]>();

                FrameDecodeResult left = decoder.Feed(coalesced, 0, split);
                decoded.AddRange(left.Frames);
                Assert.False(left.IsFaulted);

                FrameDecodeResult right = decoder.Feed(
                    coalesced,
                    split,
                    coalesced.Length - split);
                decoded.AddRange(right.Frames);

                Assert.False(right.IsFaulted);
                Assert.Equal(2, decoded.Count);
                Assert.Equal(first.Skip(4).ToArray(), decoded[0]);
                Assert.Equal(second.Skip(4).ToArray(), decoded[1]);
            }
        }

        [Fact]
        public void Former8192ByteReadBoundaryIsNotAFrameBoundary()
        {
            byte[] firstPayload = Enumerable.Repeat((byte)'a', 8192).ToArray();
            byte[] secondPayload = Encoding.UTF8.GetBytes("{\"second\":true}");
            byte[] wire = LengthPrefixedFrameCodec
                .EncodePayload(firstPayload, 8192)
                .Concat(LengthPrefixedFrameCodec.EncodePayload(secondPayload, 8192))
                .ToArray();
            var decoder = new LengthPrefixedFrameDecoder(8192);

            FrameDecodeResult firstRead = decoder.Feed(
                wire,
                0,
                AddinFrameLimits.SocketReadBufferBytes);
            FrameDecodeResult secondRead = decoder.Feed(
                wire,
                AddinFrameLimits.SocketReadBufferBytes,
                wire.Length - AddinFrameLimits.SocketReadBufferBytes);

            Assert.Empty(firstRead.Frames);
            Assert.False(firstRead.IsFaulted);
            Assert.Equal(2, secondRead.Frames.Count);
            Assert.Equal(firstPayload, secondRead.Frames[0]);
            Assert.Equal(secondPayload, secondRead.Frames[1]);
        }

        [Fact]
        public void ExactDefaultRequestMaximumRoundTrips()
        {
            byte[] payload = new byte[AddinFrameLimits.DefaultMaxRequestPayloadBytes];
            payload[0] = (byte)'{';
            payload[payload.Length - 1] = (byte)'}';

            byte[] encoded = LengthPrefixedFrameCodec.EncodePayload(
                payload,
                AddinFrameLimits.DefaultMaxRequestPayloadBytes);
            var decoder = new LengthPrefixedFrameDecoder(
                AddinFrameLimits.DefaultMaxRequestPayloadBytes);

            FrameDecodeResult result = decoder.Feed(encoded);

            Assert.False(result.IsFaulted);
            Assert.Single(result.Frames);
            Assert.Equal(payload, result.Frames[0]);
            Assert.Equal(
                (uint)AddinFrameLimits.DefaultMaxRequestPayloadBytes,
                LengthPrefixedFrameCodec.ReadPayloadLength(encoded, 0));
        }

        [Fact]
        public void EncoderRejectsDefaultRequestMaximumPlusOne()
        {
            byte[] payload = new byte[AddinFrameLimits.DefaultMaxRequestPayloadBytes + 1];

            FrameCodecException error = Assert.Throws<FrameCodecException>(
                () => LengthPrefixedFrameCodec.EncodePayload(
                    payload,
                    AddinFrameLimits.DefaultMaxRequestPayloadBytes));

            Assert.Equal("frame_payload_too_large", error.Code);
        }

        [Fact]
        public void CoalescedOversizePreservesEarlierFramesAndPermanentlyFaults()
        {
            byte[] valid = LengthPrefixedFrameCodec.EncodeJson(
                "{\"ok\":true}",
                64);
            byte[] oversizedHeader = { 0x00, 0x00, 0x00, 0x41 };
            byte[] wire = valid.Concat(oversizedHeader).ToArray();
            var decoder = new LengthPrefixedFrameDecoder(64);

            FrameDecodeResult result = decoder.Feed(wire);

            Assert.True(result.IsFaulted);
            Assert.Single(result.Frames);
            Assert.Equal("{\"ok\":true}", Encoding.UTF8.GetString(result.Frames[0]));
            Assert.Equal("frame_payload_too_large", result.Failure!.Code);
            Assert.Equal(65u, result.Failure.DeclaredPayloadBytes);

            FrameDecodeResult afterFault = decoder.Feed(
                LengthPrefixedFrameCodec.EncodeJson("{}", 64));
            Assert.True(afterFault.IsFaulted);
            Assert.Empty(afterFault.Frames);
            Assert.Same(result.Failure, afterFault.Failure);
        }

        [Fact]
        public void UnsignedMaximumLengthFaultsWithoutAllocatingPayload()
        {
            var decoder = new LengthPrefixedFrameDecoder(
                AddinFrameLimits.AbsoluteMaxRequestPayloadBytes);

            FrameDecodeResult result = decoder.Feed(
                new byte[] { 0xff, 0xff, 0xff, 0xff });

            Assert.True(result.IsFaulted);
            Assert.Equal(uint.MaxValue, result.Failure!.DeclaredPayloadBytes);
            Assert.Equal("frame_payload_too_large", result.Failure.Code);
        }

        [Fact]
        public void ResponseLimitIsExactly32MiBAndPlusOneFaultsFromHeader()
        {
            Assert.Equal(33554432, AddinFrameLimits.MaxResponsePayloadBytes);
            var decoder = new LengthPrefixedFrameDecoder(
                AddinFrameLimits.MaxResponsePayloadBytes);
            var header = new byte[4];
            LengthPrefixedFrameCodec.WritePayloadLength(
                header,
                0,
                (uint)AddinFrameLimits.MaxResponsePayloadBytes + 1u);

            FrameDecodeResult result = decoder.Feed(header);

            Assert.True(result.IsFaulted);
            Assert.Equal(
                (uint)AddinFrameLimits.MaxResponsePayloadBytes + 1u,
                result.Failure!.DeclaredPayloadBytes);
        }

        [Fact]
        public void EmptyFrameIsValidFramingButInvalidJson()
        {
            var decoder = new LengthPrefixedFrameDecoder(16);

            FrameDecodeResult result = decoder.Feed(
                new byte[] { 0x00, 0x00, 0x00, 0x00 });

            Assert.False(result.IsFaulted);
            Assert.Single(result.Frames);
            Assert.Empty(result.Frames[0]);
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(result.Frames[0]));
            Assert.Equal("empty_payload", error.Code);
        }

        [Fact]
        public void MultibytePayloadLengthCountsUtf8Bytes()
        {
            byte[] frame = LengthPrefixedFrameCodec.EncodeJson(
                "{\"text\":\"ğ\"}",
                1024);

            Assert.Equal(13u, LengthPrefixedFrameCodec.ReadPayloadLength(frame, 0));
            Assert.Equal(
                new byte[]
                {
                    0x00, 0x00, 0x00, 0x0d,
                    0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22,
                    0x3a, 0x22, 0xc4, 0x9f, 0x22, 0x7d
                },
                frame);
        }

        [Theory]
        [InlineData(AddinFrameLimits.MinimumRequestPayloadBytes - 1)]
        [InlineData(AddinFrameLimits.AbsoluteMaxRequestPayloadBytes + 1)]
        public void AdvertisedRequestLimitMustRemainWithinFrozenRange(int value)
        {
            Assert.Throws<ArgumentOutOfRangeException>(
                () => AddinFrameLimits.ValidateAdvertisedRequestLimit(value));
        }

        private static byte[] ReadFixture(string name)
        {
            DirectoryInfo? current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                string candidate = Path.Combine(
                    current.FullName,
                    "packages",
                    "bridge",
                    "test-fixtures",
                    "framing",
                    name);
                if (File.Exists(candidate))
                {
                    return File.ReadAllBytes(candidate);
                }

                current = current.Parent;
            }

            throw new FileNotFoundException("Could not locate framing fixture " + name + ".");
        }
    }
}
