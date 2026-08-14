using System.Net;
using Microsoft.AspNetCore.Http;

namespace RevAgent.M4.ClientBearerBroker;

internal readonly record struct TcpOwnerRow(
    uint State,
    IPEndPoint LocalEndPoint,
    IPEndPoint RemoteEndPoint,
    int ProcessId);

internal static class CallerPidSelector
{
    internal const uint Established = 5;

    internal static int Select(
        IEnumerable<TcpOwnerRow> rows,
        IPEndPoint requestRemoteEndPoint,
        IPEndPoint requestLocalEndPoint,
        int brokerProcessId)
    {
        // This deliberately resolves the client-side row. For an inbound
        // request, the process-table tuple is the reverse of the server view:
        // local=request.RemoteEndPoint, remote=request.LocalEndPoint.
        var processIds = rows
            .Where(row =>
                row.State == Established &&
                EndPointEquals(row.LocalEndPoint, requestRemoteEndPoint) &&
                EndPointEquals(row.RemoteEndPoint, requestLocalEndPoint))
            .Select(static row => row.ProcessId)
            .Distinct()
            .ToArray();
        if (processIds.Length == 0)
        {
            throw new BrokerRefusalException("caller_owner_not_found");
        }
        if (processIds.Length != 1)
        {
            throw new BrokerRefusalException("caller_owner_ambiguous");
        }
        if (processIds[0] <= 0 || processIds[0] == brokerProcessId)
        {
            throw new BrokerRefusalException("caller_owner_refused");
        }
        return processIds[0];
    }

    private static bool EndPointEquals(IPEndPoint left, IPEndPoint right) =>
        left.Port == right.Port && left.Address.Equals(right.Address);
}

internal abstract class CallerAuthorizationLease : IAsyncDisposable
{
    internal abstract CancellationToken Revocation { get; }

    internal abstract ValueTask VerifyAfterAsync(CancellationToken cancellationToken);

    public abstract ValueTask DisposeAsync();
}

internal interface ICallerAuthorizer
{
    ValueTask<CallerAuthorizationLease> AuthorizeAsync(
        HttpContext context,
        CancellationToken cancellationToken);
}

internal sealed class DelegateCallerAuthorizationLease : CallerAuthorizationLease
{
    private readonly Func<CancellationToken, ValueTask> _verify;
    private readonly CancellationToken _revocation;

    internal DelegateCallerAuthorizationLease(
        Func<CancellationToken, ValueTask>? verify = null,
        CancellationToken revocation = default)
    {
        _verify = verify ?? (_ => ValueTask.CompletedTask);
        _revocation = revocation;
    }

    internal override CancellationToken Revocation => _revocation;

    internal override ValueTask VerifyAfterAsync(CancellationToken cancellationToken) =>
        _verify(cancellationToken);

    public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal sealed class DelegateCallerAuthorizer : ICallerAuthorizer
{
    private readonly Func<HttpContext, CancellationToken, ValueTask<CallerAuthorizationLease>> _authorize;

    internal DelegateCallerAuthorizer(
        Func<HttpContext, CancellationToken, ValueTask<CallerAuthorizationLease>> authorize)
    {
        _authorize = authorize;
    }

    public ValueTask<CallerAuthorizationLease> AuthorizeAsync(
        HttpContext context,
        CancellationToken cancellationToken) =>
        _authorize(context, cancellationToken);
}
