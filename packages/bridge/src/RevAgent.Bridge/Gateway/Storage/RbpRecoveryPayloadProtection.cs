using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>Opaque v7 storage envelope for correlated omitted-payload recovery.</summary>
internal sealed class RbpProtectedRecoveryPayload
{
    private readonly byte[] _ciphertext;

    internal RbpProtectedRecoveryPayload(string protectionScheme, ReadOnlySpan<byte> ciphertext)
    {
        ArgumentException.ThrowIfNullOrEmpty(protectionScheme);
        if (ciphertext.IsEmpty)
        {
            throw new ArgumentException("Recovery ciphertext must not be empty.", nameof(ciphertext));
        }
        ProtectionScheme = protectionScheme;
        _ciphertext = ciphertext.ToArray();
    }

    internal string ProtectionScheme { get; }
    internal byte[] CopyCiphertext() => _ciphertext.ToArray();
    public override string ToString() => "[protected recovery payload]";
}

internal interface IRbpRecoveryPayloadProtector
{
    RbpProtectedRecoveryPayload Protect(ReadOnlySpan<byte> plaintext);
    byte[] Unprotect(RbpProtectedRecoveryPayload protectedPayload);
}

/// <summary>Fail-closed default: normal terminal persistence remains available.</summary>
internal sealed class UnavailableRbpRecoveryPayloadProtector : IRbpRecoveryPayloadProtector
{
    internal static readonly UnavailableRbpRecoveryPayloadProtector Instance = new();
    private UnavailableRbpRecoveryPayloadProtector() { }
    public RbpProtectedRecoveryPayload Protect(ReadOnlySpan<byte> plaintext) =>
        throw new CryptographicException("Recovery-payload protection is unavailable.");
    public byte[] Unprotect(RbpProtectedRecoveryPayload protectedPayload) =>
        throw new CryptographicException("Recovery-payload protection is unavailable.");
}

/// <summary>
/// Versioned plaintext envelope.  It binds the row identity and digest before
/// DPAPI protection so a copied ciphertext cannot become a different origin.
/// </summary>
internal static class RbpRecoveryPayloadEnvelope
{
    internal const byte Version = 7;
    internal const int MaxBytes = 32 * 1024 * 1024;
    private static readonly byte[] Domain = Encoding.ASCII.GetBytes(
        "revagent/rbp/correlated-recovery/v7");

    internal static byte[] Create(
        string rsid,
        string invocationId,
        string idempotencyKey,
        string digest,
        long createdAtMilliseconds,
        long retentionExpiresAtMilliseconds,
        ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty || bytes.Length > MaxBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(bytes));
        }
        byte[] rsidBytes = Encoding.UTF8.GetBytes(rsid);
        byte[] invocationBytes = Encoding.UTF8.GetBytes(invocationId);
        byte[] parentBytes = Encoding.UTF8.GetBytes(idempotencyKey);
        byte[] digestBytes = Encoding.ASCII.GetBytes(digest);
        checked
        {
            byte[] envelope = new byte[1 + 4 + Domain.Length + 4 + rsidBytes.Length +
                                       4 + invocationBytes.Length + 4 + parentBytes.Length +
                                       4 + digestBytes.Length + 8 + 8 + 4 + bytes.Length];
            int offset = 0;
            envelope[offset++] = Version;
            Write(envelope, ref offset, Domain);
            Write(envelope, ref offset, rsidBytes);
            Write(envelope, ref offset, invocationBytes);
            Write(envelope, ref offset, parentBytes);
            Write(envelope, ref offset, digestBytes);
            BitConverter.TryWriteBytes(envelope.AsSpan(offset, 8), createdAtMilliseconds);
            offset += 8;
            BitConverter.TryWriteBytes(envelope.AsSpan(offset, 8), retentionExpiresAtMilliseconds);
            offset += 8;
            BitConverter.TryWriteBytes(envelope.AsSpan(offset, 4), bytes.Length);
            offset += 4;
            bytes.CopyTo(envelope.AsSpan(offset));
            return envelope;
        }
    }

    internal static byte[] Read(
        string rsid,
        string invocationId,
        string idempotencyKey,
        string digest,
        long createdAtMilliseconds,
        long retentionExpiresAtMilliseconds,
        ReadOnlySpan<byte> envelope)
    {
        try
        {
            int offset = 0;
            if (envelope.Length < 49 || envelope[offset++] != Version ||
                !ReadEquals(envelope, ref offset, Domain) ||
                !ReadEquals(envelope, ref offset, Encoding.UTF8.GetBytes(rsid)) ||
                !ReadEquals(envelope, ref offset, Encoding.UTF8.GetBytes(invocationId)) ||
                !ReadEquals(envelope, ref offset, Encoding.UTF8.GetBytes(idempotencyKey)) ||
                !ReadEquals(envelope, ref offset, Encoding.ASCII.GetBytes(digest)) ||
                offset + 20 > envelope.Length ||
                BitConverter.ToInt64(envelope.Slice(offset, 8)) != createdAtMilliseconds ||
                BitConverter.ToInt64(envelope.Slice(offset + 8, 8)) != retentionExpiresAtMilliseconds)
            {
                throw new CryptographicException("Recovery envelope is invalid.");
            }
            offset += 16;
            int length = BitConverter.ToInt32(envelope.Slice(offset, 4));
            offset += 4;
            if (length <= 0 || length > MaxBytes || offset + length != envelope.Length)
            {
                throw new CryptographicException("Recovery envelope length is invalid.");
            }
            return envelope.Slice(offset, length).ToArray();
        }
        catch (ArgumentException exception)
        {
            throw new CryptographicException("Recovery envelope is invalid.", exception);
        }
    }

    private static void Write(byte[] destination, ref int offset, byte[] value)
    {
        BitConverter.TryWriteBytes(destination.AsSpan(offset, 4), value.Length);
        offset += 4;
        value.CopyTo(destination, offset);
        offset += value.Length;
    }

    private static bool ReadEquals(ReadOnlySpan<byte> source, ref int offset, byte[] expected)
    {
        if (offset + 4 > source.Length || BitConverter.ToInt32(source.Slice(offset, 4)) != expected.Length)
        {
            return false;
        }
        offset += 4;
        if (offset + expected.Length > source.Length ||
            !CryptographicOperations.FixedTimeEquals(source.Slice(offset, expected.Length), expected))
        {
            return false;
        }
        offset += expected.Length;
        return true;
    }
}
