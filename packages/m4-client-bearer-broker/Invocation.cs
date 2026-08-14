using System.Net;
using System.Security.Principal;

namespace RevAgent.M4.ClientBearerBroker;

internal enum BrokerAction
{
    Receive,
    ProbeAbsent,
    Cleanup,
    Serve,
}

internal sealed record Invocation(
    BrokerAction Action,
    string Root,
    string ExpectedSelfSha256,
    int ListenPort,
    string ExpectedClientSid,
    string ExpectedClientAccount,
    string ExpectedClientImageSha256,
    string ExpectedClientSignerThumbprint,
    string ExpectedClientPackageFullName)
{
    internal static Invocation Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args.Count % 2 != 0)
        {
            throw new BrokerRefusalException("invalid_invocation");
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Count; index += 2)
        {
            var name = args[index];
            var value = args[index + 1];
            if (name is not ("--contract" or "--kind" or "--root" or
                    "--expected-self-sha256" or "--destination-disposition" or
                    "--probe-absent" or "--cleanup" or "--serve" or
                    "--broker-contract" or "--listen-url" or "--upstream-url" or
                    "--expected-client-sid" or "--expected-client-account" or
                    "--expected-client-image-sha256" or
                    "--expected-client-signer-thumbprint" or
                    "--expected-client-package-full-name") ||
                !values.TryAdd(name, value))
            {
                throw new BrokerRefusalException("invalid_invocation");
            }
        }

        Require(values, "--root", out var root);
        Require(values, "--expected-self-sha256", out var selfSha256);
        if (!IsLowerSha256(selfSha256))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }

        var serve = IsTrue(values, "--serve");
        var probe = IsTrue(values, "--probe-absent");
        var cleanup = IsTrue(values, "--cleanup");
        if ((serve ? 1 : 0) + (probe ? 1 : 0) + (cleanup ? 1 : 0) > 1)
        {
            throw new BrokerRefusalException("invalid_invocation");
        }

        if (serve)
        {
            RequireExact(values, "--broker-contract", BrokerContracts.BrokerVersion);
            RequireExact(values, "--upstream-url", BrokerContracts.UpstreamUrl);
            Require(values, "--listen-url", out var listenUrl);
            Require(values, "--expected-client-sid", out var sid);
            ValidateSid(sid);
            Require(values, "--expected-client-account", out var account);
            ValidateAccount(account);
            Require(values, "--expected-client-image-sha256", out var imageSha256);
            if (!IsLowerSha256(imageSha256))
            {
                throw new BrokerRefusalException("invalid_invocation");
            }
            Require(values, "--expected-client-signer-thumbprint", out var signerThumbprint);
            if (!IsHex(signerThumbprint, 40))
            {
                throw new BrokerRefusalException("invalid_invocation");
            }
            signerThumbprint = signerThumbprint.ToLowerInvariant();
            Require(values, "--expected-client-package-full-name", out var packageFullName);
            ValidatePackageFullName(packageFullName);
            var port = ParseListenPort(listenUrl);
            RequireExactKeySet(values,
            [
                "--serve", "--broker-contract", "--root", "--expected-self-sha256",
                "--listen-url", "--upstream-url", "--expected-client-sid",
                "--expected-client-account", "--expected-client-image-sha256",
                "--expected-client-signer-thumbprint", "--expected-client-package-full-name",
            ]);
            return new Invocation(
                BrokerAction.Serve,
                root,
                selfSha256,
                port,
                sid,
                account,
                imageSha256,
                signerThumbprint,
                packageFullName);
        }

        RequireExact(values, "--contract", BrokerContracts.HandoffVersion);
        RequireExact(values, "--kind", BrokerContracts.Kind);
        RequireExact(values, "--destination-disposition", BrokerContracts.DestinationDisposition);
        if (probe)
        {
            RequireExactKeySet(values,
            [
                "--contract", "--kind", "--root", "--expected-self-sha256",
                "--destination-disposition", "--probe-absent",
            ]);
            return NonServe(BrokerAction.ProbeAbsent, root, selfSha256);
        }
        if (cleanup)
        {
            RequireExactKeySet(values,
            [
                "--contract", "--kind", "--root", "--expected-self-sha256",
                "--destination-disposition", "--cleanup",
            ]);
            return NonServe(BrokerAction.Cleanup, root, selfSha256);
        }

        RequireExactKeySet(values,
        [
            "--contract", "--kind", "--root", "--expected-self-sha256",
            "--destination-disposition",
        ]);
        return NonServe(BrokerAction.Receive, root, selfSha256);
    }

    private static Invocation NonServe(BrokerAction action, string root, string selfSha256) =>
        new(action, root, selfSha256, 0, string.Empty, string.Empty, string.Empty, string.Empty, string.Empty);

    private static void Require(
        IReadOnlyDictionary<string, string> values,
        string key,
        out string value)
    {
        if (!values.TryGetValue(key, out value!) || string.IsNullOrWhiteSpace(value))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }

    private static void RequireExact(
        IReadOnlyDictionary<string, string> values,
        string key,
        string expected)
    {
        Require(values, key, out var value);
        if (!string.Equals(value, expected, StringComparison.Ordinal))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }

    private static bool IsTrue(IReadOnlyDictionary<string, string> values, string key)
    {
        if (!values.TryGetValue(key, out var value))
        {
            return false;
        }
        if (!string.Equals(value, "true", StringComparison.Ordinal))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
        return true;
    }

    private static void RequireExactKeySet(
        IReadOnlyDictionary<string, string> values,
        IReadOnlyCollection<string> keys)
    {
        if (values.Count != keys.Count || keys.Any(key => !values.ContainsKey(key)))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }

    private static bool IsLowerSha256(string value) =>
        value.Length == 64 && value.All(character =>
            (character >= '0' && character <= '9') ||
            (character >= 'a' && character <= 'f'));

    private static bool IsHex(string value, int expectedLength) =>
        value.Length == expectedLength && value.All(character =>
            (character >= '0' && character <= '9') ||
            (character >= 'a' && character <= 'f') ||
            (character >= 'A' && character <= 'F'));

    private static int ParseListenPort(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal) ||
            !string.Equals(uri.Host, IPAddress.Loopback.ToString(), StringComparison.Ordinal) ||
            uri.Port is < 1024 or > 65535 ||
            !string.Equals(uri.AbsolutePath, "/mcp", StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.Equals(value, $"http://127.0.0.1:{uri.Port}/mcp", StringComparison.Ordinal))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
        return uri.Port;
    }

    private static void ValidateSid(string value)
    {
        try
        {
            var sid = new SecurityIdentifier(value);
            if (!string.Equals(sid.Value, value, StringComparison.Ordinal) || sid.AccountDomainSid is null)
            {
                throw new BrokerRefusalException("invalid_invocation");
            }
        }
        catch (BrokerRefusalException)
        {
            throw;
        }
        catch
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }

    private static void ValidateAccount(string value)
    {
        var separator = value.IndexOf('\\');
        if (value.Length is < 3 or > 256 || separator <= 0 ||
            separator != value.LastIndexOf('\\') || separator == value.Length - 1 ||
            value.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character)))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }

    private static void ValidatePackageFullName(string value)
    {
        if (value.Length is < 20 or > 256 ||
            !value.StartsWith("OpenAI.Codex_", StringComparison.Ordinal) ||
            !(value.EndsWith("_x64__2p2nqsd0c76g0", StringComparison.Ordinal) ||
              value.EndsWith("_arm64__2p2nqsd0c76g0", StringComparison.Ordinal)) ||
            value.Any(static character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')))
        {
            throw new BrokerRefusalException("invalid_invocation");
        }
    }
}
