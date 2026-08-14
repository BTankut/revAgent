using System.Security.Cryptography;
using System.Text;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeEnrollmentTokenTests
{
    private const string ValidToken =
        "enroll-token-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdef";

    [Fact]
    public void Parse_AcceptsOnlyBoundedVisibleAsciiShapes()
    {
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(ValidToken);

        Assert.False(token.IsConsumed);
        Assert.Throws<ArgumentNullException>(
            () => BridgeEnrollmentToken.Parse(null!));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.Parse("too-short"));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.Parse(new string('x', 4097)));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.Parse(
                "enroll token with spaces 0123456789012345678901234567"));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.Parse(
                "enroll-token-with-newline-01234567890123456789012345\n"));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.Parse(
                "enroll-token-with-unicode-0123456789012345678901234é"));
    }

    [Fact]
    public void ParseUtf8_AcceptsVisibleAsciiAndDefensivelyCopiesInput()
    {
        byte[] input = Encoding.UTF8.GetBytes(ValidToken);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.ParseUtf8(input);
        byte[] ownedStorage = GetOwnedStorage(token);

        Assert.NotSame(input, ownedStorage);
        CryptographicOperations.ZeroMemory(input);

        Assert.Equal(ValidToken, token.ConsumeForExchange());
        Assert.All(input, value => Assert.Equal(0, value));
        Assert.All(ownedStorage, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData(32)]
    [InlineData(4096)]
    public void ParseUtf8_AcceptsExactByteBounds(int byteCount)
    {
        byte[] input = Enumerable.Repeat((byte)'x', byteCount).ToArray();
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.ParseUtf8(input);

        Assert.Equal(new string('x', byteCount), token.ConsumeForExchange());
    }

    [Theory]
    [InlineData(31)]
    [InlineData(4097)]
    public void ParseUtf8_RejectsOutOfBoundsByteLengths(int byteCount)
    {
        byte[] input = Enumerable.Repeat((byte)'x', byteCount).ToArray();

        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.ParseUtf8(input));
    }

    [Theory]
    [InlineData(0x00)]
    [InlineData(0x1F)]
    [InlineData(0x20)]
    [InlineData(0x7F)]
    [InlineData(0x80)]
    [InlineData(0xC3)]
    public void ParseUtf8_RejectsControlWhitespaceAndNonAsciiBytes(
        byte invalidByte)
    {
        byte[] input = Enumerable.Repeat((byte)'x', 32).ToArray();
        input[16] = invalidByte;

        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentToken.ParseUtf8(input));
    }

    [Fact]
    public void ConsumeForExchange_IsSingleUseThenDestroyed()
    {
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(ValidToken);

        string revealed = token.ConsumeForExchange();

        Assert.Equal(ValidToken, revealed);
        Assert.True(token.IsConsumed);
        Assert.Throws<InvalidOperationException>(
            () => token.ConsumeForExchange());
    }

    [Fact]
    public void DisposedToken_RefusesConsumption()
    {
        BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(ValidToken);
        token.Dispose();

        Assert.Throws<InvalidOperationException>(
            () => token.ConsumeForExchange());
    }

    [Fact]
    public void ToString_NeverRevealsTheToken()
    {
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(ValidToken);

        Assert.Equal("[redacted]", token.ToString());
        Assert.DoesNotContain(
            ValidToken,
            token.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ParseUtf8_DisposeZeroesOnlyOwnedStorage()
    {
        byte[] input = Encoding.UTF8.GetBytes(ValidToken);
        BridgeEnrollmentToken token =
            BridgeEnrollmentToken.ParseUtf8(input);
        byte[] ownedStorage = GetOwnedStorage(token);

        token.Dispose();

        Assert.Equal(ValidToken, Encoding.UTF8.GetString(input));
        Assert.All(ownedStorage, value => Assert.Equal(0, value));
        Assert.Throws<InvalidOperationException>(
            () => token.ConsumeForExchange());
    }

    private static byte[] GetOwnedStorage(BridgeEnrollmentToken token) =>
        Assert.IsType<byte[]>(
            typeof(BridgeEnrollmentToken)
                .GetField(
                    "_utf8Value",
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.NonPublic)!
                .GetValue(token));
}
