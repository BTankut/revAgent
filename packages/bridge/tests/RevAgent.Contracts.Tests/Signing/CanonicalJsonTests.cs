using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Signing;

namespace RevAgent.Contracts.Tests.Signing;

public sealed class CanonicalJsonTests
{
    [Fact]
    public void SerializesIntegerOnlyJsonWithOrdinalKeysAndExactEscapes()
    {
        var value = new JObject
        {
            ["z"] = new JArray(1, true, JValue.CreateNull()),
            ["a"] = "line\n\t\b\f\r\"\\\u001f\u2028ğ",
            ["A"] = new JObject(),
        };

        Assert.Equal(
            "{\"A\":{},\"a\":\"line\\n\\t\\b\\f\\r\\\"\\\\\\u001f\u2028ğ\",\"z\":[1,true,null]}",
            CanonicalJson.Serialize(value));
    }

    [Fact]
    public void RejectsFloatingPointAndDecimalTokens()
    {
        Assert.Throws<InvalidOperationException>(
            () => CanonicalJson.Serialize(new JValue(1.25)));
        Assert.Throws<InvalidOperationException>(
            () => CanonicalJson.Serialize(new JValue(1.25m)));
    }

    [Fact]
    public void RejectsNonOracleIntegerAndUndefinedTokens()
    {
        var largerThanInt64 = JToken.Parse("9223372036854775808");

        Assert.Equal(JTokenType.Integer, largerThanInt64.Type);
        Assert.Throws<InvalidOperationException>(
            () => CanonicalJson.Serialize(largerThanInt64));
        Assert.Throws<InvalidOperationException>(
            () => CanonicalJson.Serialize(JValue.CreateUndefined()));
    }

    [Fact]
    public void AcceptsEveryFrozenOracleIntegerWidth()
    {
        var values = new object[]
        {
            byte.MaxValue,
            sbyte.MinValue,
            short.MinValue,
            ushort.MaxValue,
            int.MinValue,
            uint.MaxValue,
            long.MinValue,
            ulong.MaxValue,
        };

        foreach (var value in values)
        {
            var token = new JValue(value);
            Assert.Equal(
                Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
                CanonicalJson.Serialize(token));
        }
    }

    [Fact]
    public void ProducesUppercaseSha256()
    {
        Assert.Equal(
            "44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAaff8A"
                .ToUpperInvariant(),
            CanonicalJson.Sha256Hex(new JObject()));
    }
}
