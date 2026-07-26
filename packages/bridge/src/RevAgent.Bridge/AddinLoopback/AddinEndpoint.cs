using System.Net;
using System.Net.Sockets;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed class AddinEndpoint : IEquatable<AddinEndpoint>
{
    private AddinEndpoint(IPAddress address, int port)
    {
        Address = address;
        Port = port;
    }

    internal IPAddress Address { get; }

    internal int Port { get; }

    internal static AddinEndpoint Ipv4Loopback(int port) =>
        Create(IPAddress.Loopback.ToString(), port);

    internal static AddinEndpoint Create(string addressLiteral, int port)
    {
        if (port is < 1 or > 65535)
        {
            throw new AddinEndpointException(
                "invalid_addin_port",
                "The add-in TCP port must be between 1 and 65535.");
        }

        if (string.IsNullOrEmpty(addressLiteral) ||
            addressLiteral.Trim().Length != addressLiteral.Length ||
            !IPAddress.TryParse(addressLiteral, out var address) ||
            address.AddressFamily is not (
                AddressFamily.InterNetwork or AddressFamily.InterNetworkV6))
        {
            throw new AddinEndpointException(
                "non_loopback_target",
                "The add-in target must be a numeric IP loopback address.");
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (!IPAddress.IsLoopback(address))
        {
            throw new AddinEndpointException(
                "non_loopback_target",
                "The add-in target must be a numeric IP loopback address.");
        }

        return new AddinEndpoint(address, port);
    }

    public bool Equals(AddinEndpoint? other) =>
        other is not null &&
        Port == other.Port &&
        Address.Equals(other.Address);

    public override bool Equals(object? obj) =>
        obj is AddinEndpoint other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Address, Port);

    public override string ToString() =>
        Address.AddressFamily == AddressFamily.InterNetworkV6
            ? $"[{Address}]:{Port}"
            : $"{Address}:{Port}";
}

internal sealed class AddinEndpointException : Exception
{
    internal AddinEndpointException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    internal string Code { get; }
}
