using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace RevAgent.M4.ClientBearerBroker;

internal interface ISecretProtector
{
    byte[] Protect(ReadOnlySpan<byte> plaintext);

    byte[] Unprotect(ReadOnlySpan<byte> ciphertext);
}

internal sealed class NativeCurrentUserDpapi : ISecretProtector
{
    private const uint CryptProtectUiForbidden = 0x1;
    private static readonly byte[] Entropy =
        SHA256.HashData(Encoding.ASCII.GetBytes(BrokerContracts.BrokerVersion));

    public byte[] Protect(ReadOnlySpan<byte> plaintext) =>
        Invoke(plaintext, protect: true);

    public byte[] Unprotect(ReadOnlySpan<byte> ciphertext) =>
        Invoke(ciphertext, protect: false);

    private static byte[] Invoke(ReadOnlySpan<byte> input, bool protect)
    {
        if (!OperatingSystem.IsWindows() || input.IsEmpty)
        {
            throw new BrokerRefusalException("secure_store_failed");
        }

        IntPtr inputPointer = IntPtr.Zero;
        IntPtr entropyPointer = IntPtr.Zero;
        DataBlob output = default;
        byte[]? inputCopy = null;
        try
        {
            inputPointer = Marshal.AllocHGlobal(input.Length);
            inputCopy = input.ToArray();
            Marshal.Copy(inputCopy, 0, inputPointer, input.Length);
            entropyPointer = Marshal.AllocHGlobal(Entropy.Length);
            Marshal.Copy(Entropy, 0, entropyPointer, Entropy.Length);
            var inputBlob = new DataBlob(input.Length, inputPointer);
            var entropyBlob = new DataBlob(Entropy.Length, entropyPointer);
            var success = protect
                ? CryptProtectData(
                    ref inputBlob,
                    null,
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden,
                    out output)
                : CryptUnprotectData(
                    ref inputBlob,
                    IntPtr.Zero,
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden,
                    out output);
            if (!success || output.Size is <= 0 or > 65536 || output.Data == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            }

            var result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        catch (BrokerRefusalException)
        {
            throw;
        }
        catch
        {
            throw new BrokerRefusalException("secure_store_failed");
        }
        finally
        {
            if (inputCopy is not null)
            {
                CryptographicOperations.ZeroMemory(inputCopy);
            }
            ZeroAndFree(inputPointer, input.Length, localFree: false);
            ZeroAndFree(entropyPointer, Entropy.Length, localFree: false);
            ZeroAndFree(output.Data, Math.Max(output.Size, 0), localFree: true);
        }
    }

    private static void ZeroAndFree(IntPtr pointer, int length, bool localFree)
    {
        if (pointer == IntPtr.Zero)
        {
            return;
        }

        for (var index = 0; index < length; index++)
        {
            Marshal.WriteByte(pointer, index, 0);
        }

        if (localFree)
        {
            _ = LocalFree(pointer);
        }
        else
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct DataBlob
    {
        internal DataBlob(int size, IntPtr data)
        {
            Size = size;
            Data = data;
        }

        internal readonly int Size;
        internal readonly IntPtr Data;
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string? description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        uint flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        uint flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
