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
}
