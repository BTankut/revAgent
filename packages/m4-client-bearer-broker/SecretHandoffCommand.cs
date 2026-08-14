using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace RevAgent.M4.ClientBearerBroker;

internal sealed class SecretHandoffCommand
{
    private const int MaximumPayloadBytes = 4096;
    private static readonly byte[] Magic =
        Encoding.ASCII.GetBytes("REVAGENT-M4-HANDOFF-V1\n");
    private readonly ProtectedStore _store;
    private readonly ISecretProtector _protector;

    internal SecretHandoffCommand(ProtectedStore store, ISecretProtector protector)
    {
        _store = store;
        _protector = protector;
    }

    internal void Receive(string root, Stream input)
    {
        if (!_store.ProbeAbsent(root))
        {
            throw new BrokerRefusalException("destination_exists");
        }

        var payload = ReadCommittedFrame(input);
        byte[]? protectedPayload = null;
        try
        {
            ValidateBearer(payload);
            protectedPayload = _protector.Protect(payload);
            _store.Write(root, protectedPayload);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
            if (protectedPayload is not null)
            {
                CryptographicOperations.ZeroMemory(protectedPayload);
            }
        }
    }

    internal byte[] LoadBearer(string root)
    {
        var ciphertext = _store.Read(root);
        try
        {
            var plaintext = _protector.Unprotect(ciphertext);
            try
            {
                ValidateBearer(plaintext);
                return plaintext;
            }
            catch
            {
                CryptographicOperations.ZeroMemory(plaintext);
                throw;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(ciphertext);
        }
    }

    private static byte[] ReadCommittedFrame(Stream input)
    {
        var prefix = ReadExact(input, 3);
        byte[] magic = Array.Empty<byte>();
        try
        {
            if (prefix.AsSpan().SequenceEqual(new byte[] { 0xef, 0xbb, 0xbf }))
            {
                magic = ReadExact(input, Magic.Length);
            }
            else
            {
                magic = new byte[Magic.Length];
                prefix.CopyTo(magic, 0);
                var remainder = ReadExact(input, Magic.Length - prefix.Length);
                try
                {
                    remainder.CopyTo(magic, prefix.Length);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(remainder);
                }
            }
            if (!CryptographicOperations.FixedTimeEquals(magic, Magic))
            {
                throw new BrokerRefusalException("invalid_frame");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(prefix);
            CryptographicOperations.ZeroMemory(magic);
        }

        var lengthBytes = ReadExact(input, sizeof(uint));
        int length;
        try
        {
            var declared = BinaryPrimitives.ReadUInt32BigEndian(lengthBytes);
            if (declared is < 1 or > MaximumPayloadBytes)
            {
                throw new BrokerRefusalException("invalid_size");
            }
            length = checked((int)declared);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(lengthBytes);
        }

        var payload = ReadExact(input, length);
        if (input.ReadByte() != 1)
        {
            CryptographicOperations.ZeroMemory(payload);
            throw new BrokerRefusalException("handoff_aborted");
        }
        if (input.ReadByte() != -1)
        {
            CryptographicOperations.ZeroMemory(payload);
            throw new BrokerRefusalException("invalid_frame");
        }
        return payload;
    }

    private static byte[] ReadExact(Stream input, int length)
    {
        var result = new byte[length];
        try
        {
            input.ReadExactly(result);
            return result;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(result);
            throw new BrokerRefusalException("invalid_frame");
        }
    }

    internal static void ValidateBearer(ReadOnlySpan<byte> value)
    {
        if (value.Length != 64)
        {
            throw new BrokerRefusalException("invalid_bearer");
        }
        foreach (var character in value)
        {
            if (!((character >= (byte)'A' && character <= (byte)'Z') ||
                (character >= (byte)'a' && character <= (byte)'z') ||
                (character >= (byte)'0' && character <= (byte)'9') ||
                character is (byte)'_' or (byte)'-'))
            {
                throw new BrokerRefusalException("invalid_bearer");
            }
        }
    }
}
