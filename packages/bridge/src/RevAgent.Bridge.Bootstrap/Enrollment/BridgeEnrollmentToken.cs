using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

/// <summary>
/// The single-use enrollment token handed to a fresh or re-enrolling
/// bridge. The value is opaque: it is validated only for bounded shape,
/// held zeroized, consumed exactly once for the device-token exchange, and
/// destroyed on consumption so it can never be replayed from this process.
/// </summary>
internal sealed class BridgeEnrollmentToken : IDisposable
{
    private const int MinimumLength = 32;
    private const int MaximumLength = 4096;
    private static readonly UTF8Encoding StrictUtf8 =
        new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private byte[]? _utf8Value;
    private bool _consumed;

    private BridgeEnrollmentToken(byte[] utf8Value)
    {
        _utf8Value = utf8Value;
    }

    ~BridgeEnrollmentToken()
    {
        DisposeCore();
    }

    internal bool IsConsumed => _consumed;

    /// <summary>
    /// Validates the opaque enrollment-token shape: a bounded run of
    /// visible ASCII characters. Anything else — empty, whitespace,
    /// control characters, non-ASCII, or out-of-bounds length — is
    /// refused before the token can reach a wire or a store.
    /// </summary>
    internal static BridgeEnrollmentToken Parse(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length is < MinimumLength or > MaximumLength ||
            value.Any(character => character is < '!' or > '~'))
        {
            throw new ArgumentException(
                "The enrollment token must be an opaque bounded run of " +
                $"{MinimumLength} through {MaximumLength} visible ASCII " +
                "characters.",
                nameof(value));
        }

        return new BridgeEnrollmentToken(StrictUtf8.GetBytes(value));
    }

    /// <summary>
    /// Reveals the token for its one exchange request and destroys the
    /// stored value in the same operation. A second consumption attempt
    /// fails closed instead of replaying the token.
    /// </summary>
    internal string ConsumeForExchange()
    {
        byte[] value = _utf8Value ??
            throw new InvalidOperationException(
                _consumed
                    ? "The single-use enrollment token was already consumed."
                    : "The enrollment token has been disposed.");
        try
        {
            _consumed = true;
            return StrictUtf8.GetString(value);
        }
        finally
        {
            _utf8Value = null;
            CryptographicOperations.ZeroMemory(value);
        }
    }

    public void Dispose()
    {
        DisposeCore();
        GC.SuppressFinalize(this);
    }

    public override string ToString() => "[redacted]";

    private void DisposeCore()
    {
        byte[]? value = Interlocked.Exchange(ref _utf8Value, null);
        if (value is not null)
        {
            CryptographicOperations.ZeroMemory(value);
        }
    }
}
