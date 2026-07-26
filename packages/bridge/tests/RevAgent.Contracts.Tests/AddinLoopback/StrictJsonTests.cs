using System.Text;
using RevAgent.Contracts.AddinLoopback;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    public sealed class StrictJsonTests
    {
        [Fact]
        public void ParsesValidNestedObject()
        {
            var value = StrictJson.ParseObject(
                Encoding.UTF8.GetBytes(
                    "{\"a\":1,\"nested\":{\"A\":true},\"items\":[null,\"x\",1.5]}"));

            Assert.Equal(1, value.Value<int>("a"));
            Assert.True(value["nested"]!.Value<bool>("A"));
        }

        [Theory]
        [InlineData("{\"a\":1,\"a\":2}", "duplicate_property")]
        [InlineData("{\"a\":{\"x\":1,\"x\":2}}", "duplicate_property")]
        [InlineData("{\"a\":1}//comment", "comments_not_allowed")]
        [InlineData("{/*comment*/\"a\":1}", "comments_not_allowed")]
        [InlineData("{'a':1}", "single_quoted_string_not_allowed")]
        [InlineData("{\"a\":'x'}", "single_quoted_string_not_allowed")]
        [InlineData("{\"a\":1,}", "trailing_comma_not_allowed")]
        [InlineData("{\"a\":[1,]}", "trailing_comma_not_allowed")]
        [InlineData("{} {}", "trailing_content")]
        public void RejectsNewtonsoftJsonExtensions(string json, string expectedCode)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal(expectedCode, error.Code);
        }

        [Theory]
        [InlineData("{\"n\":0x10}")]
        [InlineData("{\"n\":0X10}")]
        [InlineData("{\"n\":01}")]
        [InlineData("{\"n\":00}")]
        [InlineData("{\"n\":-01}")]
        [InlineData("{\"n\":.5}")]
        [InlineData("{\"n\":-.5}")]
        [InlineData("{\"n\":1.}")]
        [InlineData("{\"n\":1.e2}")]
        [InlineData("{\"n\":+1}")]
        [InlineData("{\"n\":+0.5}")]
        [InlineData("{\"n\":1e}")]
        [InlineData("{\"n\":1e+}")]
        [InlineData("{\"n\":1e-}")]
        [InlineData("{\"n\":--1}")]
        [InlineData("{\"n\":1_0}")]
        [InlineData("{\"n\":1f}")]
        public void RejectsNumbersOutsideRfc8259Grammar(string json)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal("invalid_json_number", error.Code);
        }

        [Theory]
        [InlineData("{\"n\":0}")]
        [InlineData("{\"n\":-0}")]
        [InlineData("{\"n\":123}")]
        [InlineData("{\"n\":-123}")]
        [InlineData("{\"n\":0.0}")]
        [InlineData("{\"n\":-0.25}")]
        [InlineData("{\"n\":1e2}")]
        [InlineData("{\"n\":1E+2}")]
        [InlineData("{\"n\":1e-2}")]
        [InlineData("{\"n\":-1.25E+7}")]
        public void AcceptsRfc8259NumberGrammar(string json)
        {
            var value = StrictJson.ParseObject(json);

            Assert.NotNull(value["n"]);
        }

        [Theory]
        [InlineData("{\"s\":\"\u0000\"}")]
        [InlineData("{\"s\":\"\u0001\"}")]
        [InlineData("{\"s\":\"\t\"}")]
        [InlineData("{\"s\":\"\r\"}")]
        [InlineData("{\"s\":\"\n\"}")]
        [InlineData("{\"s\":\"\u001f\"}")]
        [InlineData("{\"s\u0001\":\"value\"}")]
        public void RejectsUnescapedControlCharactersInStrings(string json)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal("unescaped_control_character", error.Code);
        }

        [Fact]
        public void AcceptsEscapedControlCharactersInStrings()
        {
            var value = StrictJson.ParseObject(
                "{\"s\":\"\\u0001\\b\\f\\n\\r\\t\"}");

            Assert.Equal("\u0001\b\f\n\r\t", value.Value<string>("s"));
        }

        [Theory]
        [InlineData("{\"s\":\"\\x41\"}")]
        [InlineData("{\"s\":\"\\v\"}")]
        [InlineData("{\"s\":\"\\0\"}")]
        [InlineData("{\"s\":\"\\a\"}")]
        [InlineData("{\"s\":\"\\U00000041\"}")]
        [InlineData("{\"s\":\"\\'\"}")]
        [InlineData("{\"s\":\"\\?\"}")]
        [InlineData("{\"s\":\"\\e\"}")]
        [InlineData("{\"s\":\"\\u123\"}")]
        [InlineData("{\"s\":\"\\u12G4\"}")]
        [InlineData("{\"s\":\"\\u{41}\"}")]
        public void RejectsNonRfc8259StringEscapes(string json)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal("invalid_json_escape", error.Code);
        }

        [Fact]
        public void AcceptsEveryRfc8259StringEscape()
        {
            var value = StrictJson.ParseObject(
                "{\"s\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\"}");

            Assert.Equal("\"\\/\b\f\n\r\tA", value.Value<string>("s"));
        }

        [Fact]
        public void DuplicateDetectionIsOrdinalAndCaseSensitive()
        {
            var value = StrictJson.ParseObject("{\"a\":1,\"A\":2}");

            Assert.Equal(1, value.Value<int>("a"));
            Assert.Equal(2, value.Value<int>("A"));
        }

        [Fact]
        public void CommentMarkersInsideStringsRemainData()
        {
            var value = StrictJson.ParseObject(
                "{\"url\":\"https://example.invalid/a/*b*/\",\"quote\":\"'\",\"number\":\"0x10 +1 .5 01\"}");

            Assert.Equal(
                "https://example.invalid/a/*b*/",
                value.Value<string>("url"));
            Assert.Equal("'", value.Value<string>("quote"));
            Assert.Equal("0x10 +1 .5 01", value.Value<string>("number"));
        }

        [Fact]
        public void RejectsUtf8Bom()
        {
            byte[] payload =
            {
                0xef, 0xbb, 0xbf,
                (byte)'{', (byte)'}'
            };

            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(payload));

            Assert.Equal("utf8_bom_not_allowed", error.Code);
        }

        [Fact]
        public void RejectsInvalidUtf8()
        {
            byte[] payload =
            {
                (byte)'{', (byte)'"', (byte)'x', (byte)'"', (byte)':',
                (byte)'"', 0xc3, 0x28, (byte)'"', (byte)'}'
            };

            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(payload));

            Assert.Equal("invalid_utf8", error.Code);
        }

        [Theory]
        [InlineData("[]")]
        [InlineData("\"value\"")]
        [InlineData("null")]
        public void AddinFrameRootMustBeObject(string json)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal("root_must_be_object", error.Code);
        }

        [Theory]
        [InlineData("{\"n\":NaN}")]
        [InlineData("{\"n\":Infinity}")]
        [InlineData("{\"n\":-Infinity}")]
        public void RejectsNonFiniteNumbers(string json)
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject(json));

            Assert.Equal("invalid_json_number", error.Code);
        }

        [Fact]
        public void RejectsNonJsonUnicodeWhitespaceOutsideStrings()
        {
            StrictJsonException error = Assert.Throws<StrictJsonException>(
                () => StrictJson.ParseObject("{\u00a0\"a\":1}"));

            Assert.Equal("invalid_json_whitespace", error.Code);
        }

        [Fact]
        public void PreservesDateLookingStringsAsStrings()
        {
            var value = StrictJson.ParseObject(
                "{\"at\":\"2026-07-26T00:00:00Z\"}");

            Assert.Equal(
                Newtonsoft.Json.Linq.JTokenType.String,
                value["at"]!.Type);
        }
    }
}
