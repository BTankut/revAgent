namespace RevAgent.M4.ClientBearerBroker;

internal sealed record CallerIdentityExpectation(
    string Sid,
    string Account,
    string ImageSha256,
    string SignerThumbprint,
    string PackageFullName);

internal sealed record CallerIdentityObservation(
    string Sid,
    string Account,
    string ImageSha256,
    string SignerThumbprint,
    string PackageFamilyName,
    string PackageFullName);

internal static class CallerIdentityPolicy
{
    internal const string ExpectedPackageFamily = "OpenAI.Codex_2p2nqsd0c76g0";

    internal static void DemandExact(
        CallerIdentityExpectation expected,
        CallerIdentityObservation actual)
    {
        if (!string.Equals(actual.Sid, expected.Sid, StringComparison.Ordinal) ||
            !string.Equals(actual.Account, expected.Account, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(actual.ImageSha256, expected.ImageSha256, StringComparison.Ordinal) ||
            !string.Equals(actual.SignerThumbprint, expected.SignerThumbprint, StringComparison.Ordinal) ||
            !string.Equals(actual.PackageFamilyName, ExpectedPackageFamily, StringComparison.Ordinal) ||
            !string.Equals(actual.PackageFullName, expected.PackageFullName, StringComparison.Ordinal))
        {
            throw new BrokerRefusalException("caller_identity_refused");
        }
    }
}
