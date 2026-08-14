namespace RevAgent.M4.ClientBearerBroker;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            return ValueFreeOutput.InvalidInvocation();
        }

        Invocation invocation;
        try
        {
            invocation = Invocation.Parse(args);
        }
        catch
        {
            return ValueFreeOutput.InvalidInvocation();
        }

        var store = new ProtectedStore();
        var action = ActionName(invocation.Action);
        try
        {
            if (!store.ValidateSelfHash(invocation.ExpectedSelfSha256))
            {
                throw new BrokerRefusalException("broker_identity_refused");
            }

            var command = new SecretHandoffCommand(store, new NativeCurrentUserDpapi());
            switch (invocation.Action)
            {
                case BrokerAction.Receive:
                    command.Receive(invocation.Root, Console.OpenStandardInput());
                    ValueFreeOutput.Write(new
                    {
                        ok = true,
                        action,
                        contractVersion = BrokerContracts.HandoffVersion,
                        kind = BrokerContracts.Kind,
                        destinationDisposition = BrokerContracts.DestinationDisposition,
                        destinationCreated = true,
                        protectionScope = "current_user_dpapi",
                        aclProtected = true,
                        linkCount = 1,
                    });
                    return 0;
                case BrokerAction.ProbeAbsent:
                    if (!store.ProbeAbsent(invocation.Root))
                    {
                        return ValueFreeOutput.Refused(action, "cleanup_uncertain", false, cleanupUncertain: true);
                    }
                    ValueFreeOutput.Write(new
                    {
                        ok = true,
                        action,
                        contractVersion = BrokerContracts.HandoffVersion,
                        kind = BrokerContracts.Kind,
                        destinationAbsent = true,
                    });
                    return 0;
                case BrokerAction.Cleanup:
                    if (!store.Cleanup(invocation.Root) || !store.ProbeAbsent(invocation.Root))
                    {
                        return ValueFreeOutput.Refused(action, "cleanup_uncertain", false, cleanupUncertain: true);
                    }
                    ValueFreeOutput.Write(new
                    {
                        ok = true,
                        action,
                        contractVersion = BrokerContracts.HandoffVersion,
                        kind = BrokerContracts.Kind,
                        destinationAbsent = true,
                    });
                    return 0;
                case BrokerAction.Serve:
                    return await BrokerHost.RunAsync(invocation, command).ConfigureAwait(false);
                default:
                    throw new BrokerRefusalException("invalid_invocation");
            }
        }
        catch (BrokerRefusalException exception)
        {
            var cleanupUncertain =
                invocation.Action is BrokerAction.ProbeAbsent or BrokerAction.Cleanup ||
                string.Equals(exception.Reason, "cleanup_uncertain", StringComparison.Ordinal);
            return ValueFreeOutput.Refused(
                action,
                exception.Reason,
                destinationAbsent: false,
                cleanupUncertain);
        }
        catch
        {
            var cleanupUncertain = invocation.Action is BrokerAction.ProbeAbsent or BrokerAction.Cleanup;
            return ValueFreeOutput.Refused(
                action,
                cleanupUncertain ? "cleanup_uncertain" : "broker_operation_failed",
                destinationAbsent: false,
                cleanupUncertain);
        }
    }

    private static string ActionName(BrokerAction action) => action switch
    {
        BrokerAction.Receive => "receive_m4_secret_handoff",
        BrokerAction.ProbeAbsent => "probe_m4_secret_handoff_absence",
        BrokerAction.Cleanup => "cleanup_m4_client_bearer_store",
        BrokerAction.Serve => "serve_m4_client_bearer_broker",
        _ => "receive_m4_secret_handoff",
    };
}
