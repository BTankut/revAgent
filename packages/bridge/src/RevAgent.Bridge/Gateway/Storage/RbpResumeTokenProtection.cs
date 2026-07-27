namespace RevAgent.Bridge.Gateway.Storage;

internal sealed class RbpProtectedResumeToken
{
    private readonly byte[] _ciphertext;

    internal RbpProtectedResumeToken(
        string protectionScheme,
        ReadOnlySpan<byte> ciphertext)
    {
        if (string.IsNullOrWhiteSpace(protectionScheme) ||
            protectionScheme.Length > 128)
        {
            throw new ArgumentException(
                "Resume-token protection scheme must be bounded and non-empty.",
                nameof(protectionScheme));
        }

        if (ciphertext.IsEmpty)
        {
            throw new ArgumentException(
                "Protected resume-token ciphertext must not be empty.",
                nameof(ciphertext));
        }

        ProtectionScheme = protectionScheme;
        _ciphertext = ciphertext.ToArray();
    }

    internal string ProtectionScheme { get; }

    internal ReadOnlyMemory<byte> Ciphertext => _ciphertext;

    internal byte[] CopyCiphertext() => _ciphertext.ToArray();

    internal RbpProtectedResumeToken Snapshot() =>
        new(ProtectionScheme, _ciphertext);

    public override string ToString() => "[protected resume token]";
}

internal interface IRbpResumeTokenProtector
{
    RbpProtectedResumeToken Protect(string plaintextToken);

    string Unprotect(RbpProtectedResumeToken protectedToken);
}

internal sealed class RbpSecretString
{
    private readonly string _value;

    internal RbpSecretString(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException(
                "Secret value must not be empty.",
                nameof(value));
        }

        _value = value;
    }

    internal string Reveal() => _value;

    public override string ToString() => "[redacted]";
}
