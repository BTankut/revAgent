using System.Net;
using System.Net.Http.Headers;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.AspNetCore.Http;
using RevAgent.M4.ClientBearerBroker;

internal static class Program
{
    private const string SyntheticBearer =
        "SYNTHETIC-HEAD-A4-MIDDLE-BROKER-X-TAIL-NOT-SECRET-0123456789ABCD";
    private static readonly string[] SyntheticFragments =
    [
        "SYNTHETIC-HEAD-A4",
        "MIDDLE-BROKER-X",
        "TAIL-NOT-SECRET",
    ];
    private const string ExpectedPackageFullName =
        "OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0";
    private const string ExpectedAccount = @"PETRUCCI\ws2";
    private static int _passed;
    private static string _currentTest = "startup";

    private static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("broker tests require Windows");
            return 1;
        }

        try
        {
            Run("invocation", TestInvocationValidation);
            Run("caller-selection", TestReverseTupleCallerSelection);
            Run("identity-policy", TestExactIdentityPolicy);
            Run("caller-authorizer", TestCallerAuthorizerOrchestration);
            Run("native-negative", TestNativeCallerRefusal);
            Run("dpapi-store", TestDpapiRoundTripAndCleanup);
            Run("protected-store-negative", TestProtectedStoreNegativeCases);
            await RunAsync("refusal", TestRefusalSendsNothingUpstreamAsync);
            await RunAsync("proxy-sse", TestProxyHeadersAndSseAsync);
            await RunAsync("delete", TestDeleteForwardingAsync);
            await RunAsync("upstream-failure", TestUpstreamFailureZeroesBearerAsync);
            await RunAsync("cancellation", TestRevocationCancelsUpstreamAsync);
            Run("no-argv-env", TestNoSecretArgvOrEnvironmentSurface);
            Console.WriteLine($"m4 client bearer broker tests passed: {_passed}");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"m4 client bearer broker test failed: {_currentTest}/{exception.GetType().Name}");
            return 1;
        }
    }

    private static void Run(string name, Action action)
    {
        _currentTest = name;
        action();
    }

    private static async Task RunAsync(string name, Func<Task> action)
    {
        _currentTest = name;
        await action();
    }

    private static void TestInvocationValidation()
    {
        var parsed = Invocation.Parse(ServeArguments(
            "http://127.0.0.1:18082/mcp",
            BrokerContracts.UpstreamUrl));
        Equal(BrokerAction.Serve, parsed.Action, "serve action");
        Equal(18082, parsed.ListenPort, "listen port");
        Equal(
            1024,
            Invocation.Parse(ServeArguments(
                "http://127.0.0.1:1024/mcp",
                BrokerContracts.UpstreamUrl)).ListenPort,
            "lowest broker port");
        ThrowsRefusal(
            () => Invocation.Parse(ServeArguments(
                "http://127.0.0.1:1023/mcp",
                BrokerContracts.UpstreamUrl)),
            "reserved port must fail closed");
        ThrowsRefusal(
            () => Invocation.Parse(ServeArguments(
                "http://localhost:18082/mcp",
                BrokerContracts.UpstreamUrl)),
            "hostname listener must fail closed");
        ThrowsRefusal(
            () => Invocation.Parse(ServeArguments(
                "http://127.0.0.1:18082/mcp",
                "https://example.invalid/mcp")),
            "alternate upstream must fail closed");
        Pass();
    }

    private static string[] ServeArguments(string listener, string upstream) =>
    [
        "--serve", "true",
        "--broker-contract", BrokerContracts.BrokerVersion,
        "--root", @"C:\broker-test",
        "--expected-self-sha256", new string('a', 64),
        "--listen-url", listener,
        "--upstream-url", upstream,
        "--expected-client-sid", "S-1-5-21-1-2-3-1001",
        "--expected-client-account", ExpectedAccount,
        "--expected-client-image-sha256", new string('b', 64),
        "--expected-client-signer-thumbprint", new string('c', 40),
        "--expected-client-package-full-name", ExpectedPackageFullName,
    ];

    private static void TestReverseTupleCallerSelection()
    {
        var client = new IPEndPoint(IPAddress.Loopback, 51000);
        var broker = new IPEndPoint(IPAddress.Loopback, 18082);
        var rows = new[]
        {
            new TcpOwnerRow(CallerPidSelector.Established, client, broker, 111),
            new TcpOwnerRow(CallerPidSelector.Established, broker, client, 222),
        };
        Equal(111, CallerPidSelector.Select(rows, client, broker, 222), "reverse client tuple");
        ThrowsRefusal(
            () => CallerPidSelector.Select(rows, broker, client, 222),
            "broker pid must be rejected");
        ThrowsRefusal(
            () => CallerPidSelector.Select(
                rows.Append(new TcpOwnerRow(CallerPidSelector.Established, client, broker, 333)),
                client,
                broker,
                222),
            "ambiguous caller must be rejected");
        Pass();
    }

    private static void TestExactIdentityPolicy()
    {
        var expected = ExactExpectation();
        var valid = new CallerIdentityObservation(
            expected.Sid,
            expected.Account,
            expected.ImageSha256,
            expected.SignerThumbprint,
            CallerIdentityPolicy.ExpectedPackageFamily,
            expected.PackageFullName);
        CallerIdentityPolicy.DemandExact(expected, valid);
        ThrowsRefusal(
            () => CallerIdentityPolicy.DemandExact(expected, valid with { Account = @"PETRUCCI\other" }),
            "wrong account refused");
        ThrowsRefusal(
            () => CallerIdentityPolicy.DemandExact(expected, valid with { ImageSha256 = new string('c', 64) }),
            "wrong image hash refused");
        ThrowsRefusal(
            () => CallerIdentityPolicy.DemandExact(expected, valid with { SignerThumbprint = new string('d', 40) }),
            "wrong signer thumbprint refused");
        ThrowsRefusal(
            () => CallerIdentityPolicy.DemandExact(expected, valid with { PackageFullName = "OpenAI.Codex_0.0.0.0_x64__2p2nqsd0c76g0" }),
            "wrong package full name refused");
        Pass();
    }

    private static void TestCallerAuthorizerOrchestration()
    {
        var expected = ExactExpectation();
        var client = new IPEndPoint(IPAddress.Loopback, 51000);
        var broker = new IPEndPoint(IPAddress.Loopback, 18082);
        var clientRow = new TcpOwnerRow(CallerPidSelector.Established, client, broker, 111);
        var serverRow = new TcpOwnerRow(CallerPidSelector.Established, broker, client, 222);
        var ownerTable = new SequenceOwnerTable(
            new[] { clientRow, serverRow },
            new[] { clientRow, serverRow },
            new[] { clientRow, serverRow });
        var evidenceFactory = new FakeEvidenceFactory();
        var authorizer = new WindowsCallerAuthorizer(ownerTable, evidenceFactory, 222, expected);
        var context = NewContext("GET");
        var lease = authorizer.AuthorizeAsync(context, CancellationToken.None)
            .AsTask().GetAwaiter().GetResult();
        Equal(1, evidenceFactory.OpenCount, "evidence handle opened once");
        Equal(111, evidenceFactory.Last!.ProcessId, "client PID opened");
        Equal(expected, evidenceFactory.LastExpectation, "exact expected profile passed");
        False(evidenceFactory.Last.Disposed, "process handle held through request");
        lease.VerifyAfterAsync(CancellationToken.None).AsTask().GetAwaiter().GetResult();
        Equal(1, evidenceFactory.Last.VerifyCount, "post-response identity verified");
        lease.DisposeAsync().AsTask().GetAwaiter().GetResult();
        True(evidenceFactory.Last.Disposed, "process evidence disposed after request");
        Equal(3, ownerTable.ReadCount, "tuple resolved before open, after open, and after response");

        AssertAuthorizerRefuses(
            new[] { serverRow },
            brokerProcessId: 222,
            "wrong tuple direction");
        AssertAuthorizerRefuses(
            new[] { new TcpOwnerRow(CallerPidSelector.Established, client, broker, 222) },
            brokerProcessId: 222,
            "broker PID");
        AssertAuthorizerRefuses(
            new[]
            {
                clientRow,
                new TcpOwnerRow(CallerPidSelector.Established, client, broker, 333),
            },
            brokerProcessId: 222,
            "ambiguous owner");

        var changedTable = new SequenceOwnerTable(
            new[] { clientRow },
            new[] { new TcpOwnerRow(CallerPidSelector.Established, client, broker, 333) });
        var changedFactory = new FakeEvidenceFactory();
        var changed = new WindowsCallerAuthorizer(changedTable, changedFactory, 222, expected);
        ThrowsRefusal(
            () => changed.AuthorizeAsync(NewContext("GET"), CancellationToken.None)
                .AsTask().GetAwaiter().GetResult(),
            "identity change between tuple reads refused");
        True(changedFactory.Last!.Disposed, "failed sandwich disposes opened evidence");

        var exitTable = new SequenceOwnerTable(
            new[] { clientRow },
            new[] { clientRow },
            new[] { clientRow });
        var exitFactory = new FakeEvidenceFactory { EvidenceExited = true };
        var exitAuthorizer = new WindowsCallerAuthorizer(exitTable, exitFactory, 222, expected);
        var exitLease = exitAuthorizer.AuthorizeAsync(NewContext("GET"), CancellationToken.None)
            .AsTask().GetAwaiter().GetResult();
        ThrowsRefusal(
            () => exitLease.VerifyAfterAsync(CancellationToken.None)
                .AsTask().GetAwaiter().GetResult(),
            "exited process refused after response");
        exitLease.DisposeAsync().AsTask().GetAwaiter().GetResult();

        var mutationTable = new SequenceOwnerTable(
            new[] { clientRow },
            new[] { clientRow },
            new[] { clientRow });
        var mutationFactory = new FakeEvidenceFactory { RefuseVerify = true };
        var mutationAuthorizer = new WindowsCallerAuthorizer(mutationTable, mutationFactory, 222, expected);
        var mutationLease = mutationAuthorizer.AuthorizeAsync(NewContext("GET"), CancellationToken.None)
            .AsTask().GetAwaiter().GetResult();
        ThrowsRefusal(
            () => mutationLease.VerifyAfterAsync(CancellationToken.None)
                .AsTask().GetAwaiter().GetResult(),
            "process identity mutation refused after response");
        mutationLease.DisposeAsync().AsTask().GetAwaiter().GetResult();
        Pass();
    }

    private static void TestNativeCallerRefusal()
    {
        NativeCallerEvidence? evidence = null;
        try
        {
            evidence = NativeCallerEvidence.Open(Environment.ProcessId, ExactExpectation());
        }
        catch (BrokerRefusalException)
        {
            Pass();
            return;
        }
        finally
        {
            evidence?.Dispose();
        }
        throw new InvalidOperationException("unpackaged test process was accepted as exact packaged Codex");
    }

    private static CallerIdentityExpectation ExactExpectation() => new(
        "S-1-5-21-1-2-3-1001",
        ExpectedAccount,
        new string('a', 64),
        new string('b', 40),
        ExpectedPackageFullName);

    private static void AssertAuthorizerRefuses(
        IReadOnlyList<TcpOwnerRow> rows,
        int brokerProcessId,
        string message)
    {
        var table = new SequenceOwnerTable(rows);
        var factory = new FakeEvidenceFactory();
        var authorizer = new WindowsCallerAuthorizer(table, factory, brokerProcessId, ExactExpectation());
        ThrowsRefusal(
            () => authorizer.AuthorizeAsync(NewContext("GET"), CancellationToken.None)
                .AsTask().GetAwaiter().GetResult(),
            message);
        Equal(0, factory.OpenCount, $"{message}: no process opened");
    }

    private static void TestDpapiRoundTripAndCleanup()
    {
        var root = Path.Combine(Path.GetTempPath(), "revagent-m4-broker-tests", Guid.NewGuid().ToString("N"));
        CreateProtectedRoot(root);
        try
        {
            var store = new ProtectedStore();
            var command = new SecretHandoffCommand(store, new NativeCurrentUserDpapi());
            using var frame = BuildFrame(SyntheticBearer);
            command.Receive(root, frame);
            var path = store.DestinationPath(root);
            True(File.Exists(path), "DPAPI store created");
            var ciphertext = File.ReadAllBytes(path);
            try
            {
                AssertNoSyntheticEvidence(
                    Encoding.ASCII.GetString(ciphertext),
                    "plaintext canary absent from store");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(ciphertext);
            }

            var loaded = command.LoadBearer(root);
            try
            {
                True(
                    CryptographicOperations.FixedTimeEquals(
                        loaded,
                        Encoding.ASCII.GetBytes(SyntheticBearer)),
                    "DPAPI round trip");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(loaded);
            }
            True(store.Cleanup(root), "cleanup succeeds");
            True(store.ProbeAbsent(root), "cleanup positively proves absence");
            Pass();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void TestProtectedStoreNegativeCases()
    {
        var baseRoot = Path.Combine(
            Path.GetTempPath(),
            "revagent-m4-broker-negative-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseRoot);
        string? directoryLink = null;
        string? fileLink = null;
        try
        {
            var store = new ProtectedStore();
            var inheritedRoot = Path.Combine(baseRoot, "inherited");
            Directory.CreateDirectory(inheritedRoot);
            False(store.ProbeAbsent(inheritedRoot), "inherited root ACL refused");

            var broadRoot = Path.Combine(baseRoot, "broad");
            CreateProtectedRoot(broadRoot);
            var broadAcl = FileSystemAclExtensions.GetAccessControl(new DirectoryInfo(broadRoot));
            broadAcl.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(broadRoot), broadAcl);
            False(store.ProbeAbsent(broadRoot), "broad root ACL refused");

            False(
                ProtectedStore.IsNarrowFileIdentity(new FileIdentity(1, 0, 1, 2, 0)),
                "hardlink identity refused");
            False(
                ProtectedStore.IsNarrowFileIdentity(new FileIdentity(
                    1,
                    0,
                    1,
                    1,
                    (uint)FileAttributes.ReparsePoint)),
                "reparse identity refused");

            var safeRoot = Path.Combine(baseRoot, "safe");
            CreateProtectedRoot(safeRoot);
            var command = new SecretHandoffCommand(store, new NativeCurrentUserDpapi());
            using (var frame = BuildFrame(SyntheticBearer))
            {
                command.Receive(safeRoot, frame);
            }
            var destination = store.DestinationPath(safeRoot);
            var hardlink = Path.Combine(safeRoot, "north-bearer-hardlink.dpapi");
            True(CreateHardLink(hardlink, destination, IntPtr.Zero), "hardlink fixture created");
            ThrowsRefusal(() => command.LoadBearer(safeRoot), "hardlink store read refused");
            False(store.Cleanup(safeRoot), "hardlink cleanup refused without deletion");
            True(File.Exists(destination), "hardlink refusal preserves unowned path");
            File.Delete(hardlink);
            True(store.Cleanup(safeRoot), "hardlink removal restores safe cleanup");

            File.WriteAllBytes(destination, new byte[] { 1, 2, 3, 4 });
            var replacementAcl = new FileSecurity();
            var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException();
            replacementAcl.SetOwner(current);
            replacementAcl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            replacementAcl.AddAccessRule(new FileSystemAccessRule(
                current,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            replacementAcl.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            FileSystemAclExtensions.SetAccessControl(new FileInfo(destination), replacementAcl);
            False(store.Cleanup(safeRoot), "non-narrow replacement cleanup refused");
            True(File.Exists(destination), "replacement refusal does not delete foreign path");
            File.Delete(destination);

            var reparseTarget = Path.Combine(baseRoot, "reparse-target");
            CreateProtectedRoot(reparseTarget);
            directoryLink = Path.Combine(baseRoot, "reparse-root");
            try
            {
                Directory.CreateSymbolicLink(directoryLink, reparseTarget);
                False(store.ProbeAbsent(directoryLink), "reparse root refused");
                Directory.Delete(directoryLink);
                directoryLink = null;

                var fileTarget = Path.Combine(baseRoot, "foreign.dpapi");
                File.WriteAllBytes(fileTarget, new byte[] { 5, 6, 7, 8 });
                fileLink = destination;
                File.CreateSymbolicLink(fileLink, fileTarget);
                False(store.Cleanup(safeRoot), "reparse destination cleanup refused");
                True(File.Exists(fileLink), "reparse refusal preserves link");
                File.Delete(fileLink);
                fileLink = null;
                File.Delete(fileTarget);
            }
            catch (UnauthorizedAccessException)
            {
                // The deterministic identity-policy assertion above remains
                // mandatory on hosts where unprivileged symlinks are disabled.
            }
            catch (PlatformNotSupportedException)
            {
            }
            Pass();
        }
        finally
        {
            if (fileLink is not null && File.Exists(fileLink))
            {
                File.Delete(fileLink);
            }
            if (directoryLink is not null && Directory.Exists(directoryLink))
            {
                Directory.Delete(directoryLink);
            }
            Directory.Delete(baseRoot, recursive: true);
        }
    }

    private static void CreateProtectedRoot(string path)
    {
        Directory.CreateDirectory(path);
        FileSystemAclExtensions.SetAccessControl(
            new DirectoryInfo(path),
            ProtectedStore.CreateNarrowDirectorySecurity());
    }

    private static async Task TestRefusalSendsNothingUpstreamAsync()
    {
        var handler = new CaptureHandler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
        var loaderCount = 0;
        var authorizer = new DelegateCallerAuthorizer((_, _) =>
            throw new BrokerRefusalException("SYNTHETIC-DO-NOT-EMIT"));
        var proxy = new BrokerProxy(new HttpMessageInvoker(handler), authorizer, () =>
        {
            loaderCount++;
            return BearerBytes();
        });
        var context = NewContext("GET");
        await proxy.HandleAsync(context);
        Equal(0, handler.CallCount, "refusal has zero upstream calls");
        Equal(0, loaderCount, "refusal does not decrypt bearer");
        Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode, "refusal status");
        var output = ReadBody(context);
        False(output.Contains("SYNTHETIC-DO-NOT-EMIT", StringComparison.Ordinal), "value-free refusal");
        AssertNoSyntheticEvidence(output, "refusal output");
        Pass();
    }

    private static async Task TestProxyHeadersAndSseAsync()
    {
        var handler = new CaptureHandler((request, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("event: message\ndata: {}\n\n", Encoding.UTF8, "text/event-stream"),
            };
            response.Headers.TryAddWithoutValidation("MCP-Session-Id", "session-1");
            response.Headers.TryAddWithoutValidation("X-Upstream-Secret", "drop-me");
            return Task.FromResult(response);
        });
        var verifyCount = 0;
        var loaderCount = 0;
        var suppliedBearer = BearerBytes();
        var authorizer = new DelegateCallerAuthorizer((_, _) =>
        {
            Interlocked.Increment(ref verifyCount);
            return ValueTask.FromResult<CallerAuthorizationLease>(
                new DelegateCallerAuthorizationLease(_ =>
                {
                    Interlocked.Increment(ref verifyCount);
                    return ValueTask.CompletedTask;
                }));
        });
        var proxy = new BrokerProxy(new HttpMessageInvoker(handler), authorizer, () =>
        {
            loaderCount++;
            return suppliedBearer;
        });
        var context = NewContext("POST");
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes("{}"));
        context.Request.Headers.Authorization = "Bearer SYNTHETIC-CLIENT-SHOULD-BE-DROPPED";
        context.Request.Headers.Cookie = "SYNTHETIC-COOKIE-SHOULD-BE-DROPPED";
        context.Request.Headers["Proxy-Authorization"] = "Basic SYNTHETIC-PROXY-SHOULD-BE-DROPPED";
        context.Request.Headers["Forwarded"] = "for=192.0.2.1";
        context.Request.Headers["MCP-Protocol-Version"] = "2025-06-18";
        context.Request.ContentType = "application/json";
        await proxy.HandleAsync(context);

        Equal(1, handler.CallCount, "one upstream call");
        Equal(1, loaderCount, "authorized request decrypts exactly once");
        Equal(BrokerContracts.UpstreamUrl, handler.RequestUri, "exact upstream");
        Equal($"Bearer {SyntheticBearer}", handler.Authorization, "sole broker bearer");
        False(handler.HeaderNames.Contains("Cookie"), "cookie stripped");
        False(handler.HeaderNames.Contains("Proxy-Authorization"), "proxy authorization stripped");
        False(handler.HeaderNames.Contains("Forwarded"), "forwarding header stripped");
        True(handler.HeaderNames.Contains("MCP-Protocol-Version"), "MCP header preserved");
        Equal(2, verifyCount, "caller verified before and after stream");
        Equal("event: message\ndata: {}\n\n", ReadBody(context), "SSE body streamed");
        True(context.Response.Headers.ContainsKey("MCP-Session-Id"), "session header preserved");
        False(context.Response.Headers.ContainsKey("X-Upstream-Secret"), "unlisted response header stripped");
        True(suppliedBearer.All(static value => value == 0), "success path zeroes loaded bearer");
        Pass();
    }

    private static async Task TestDeleteForwardingAsync()
    {
        var handler = new CaptureHandler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted)));
        var authorizer = new DelegateCallerAuthorizer((_, _) =>
            ValueTask.FromResult<CallerAuthorizationLease>(
                new DelegateCallerAuthorizationLease()));
        var suppliedBearer = BearerBytes();
        var proxy = new BrokerProxy(
            new HttpMessageInvoker(handler),
            authorizer,
            () => suppliedBearer);
        var context = NewContext("DELETE");
        await proxy.HandleAsync(context);
        Equal("DELETE", handler.Method, "DELETE forwarded");
        Equal(StatusCodes.Status202Accepted, context.Response.StatusCode, "DELETE status returned");
        True(suppliedBearer.All(static value => value == 0), "DELETE path zeroes loaded bearer");
        Pass();
    }

    private static async Task TestRevocationCancelsUpstreamAsync()
    {
        using var revoke = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var observedCancellation = false;
        var handler = new CaptureHandler(async (_, cancellationToken) =>
        {
            entered.SetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                observedCancellation = true;
                throw;
            }
            throw new InvalidOperationException();
        });
        var authorizer = new DelegateCallerAuthorizer((_, _) =>
            ValueTask.FromResult<CallerAuthorizationLease>(
                new DelegateCallerAuthorizationLease(revocation: revoke.Token)));
        var suppliedBearer = BearerBytes();
        var proxy = new BrokerProxy(
            new HttpMessageInvoker(handler),
            authorizer,
            () => suppliedBearer);
        var context = NewContext("GET");
        var task = proxy.HandleAsync(context);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        revoke.Cancel();
        await task.WaitAsync(TimeSpan.FromSeconds(5));
        True(observedCancellation, "revocation reaches upstream cancellation");
        Equal(StatusCodes.Status504GatewayTimeout, context.Response.StatusCode, "cancellation fixed response");
        True(suppliedBearer.All(static value => value == 0), "cancellation zeroes loaded bearer");
        Pass();
    }

    private static async Task TestUpstreamFailureZeroesBearerAsync()
    {
        var handler = new CaptureHandler((_, _) =>
            throw new HttpRequestException("SYNTHETIC-UPSTREAM-DETAIL"));
        var authorizer = new DelegateCallerAuthorizer((_, _) =>
            ValueTask.FromResult<CallerAuthorizationLease>(
                new DelegateCallerAuthorizationLease()));
        var suppliedBearer = BearerBytes();
        var proxy = new BrokerProxy(
            new HttpMessageInvoker(handler),
            authorizer,
            () => suppliedBearer);
        var context = NewContext("POST");
        await proxy.HandleAsync(context);
        Equal(StatusCodes.Status502BadGateway, context.Response.StatusCode, "upstream failure status");
        False(ReadBody(context).Contains("SYNTHETIC-UPSTREAM-DETAIL", StringComparison.Ordinal), "failure is value-free");
        AssertNoSyntheticEvidence(ReadBody(context), "upstream failure output");
        True(suppliedBearer.All(static value => value == 0), "failure zeroes loaded bearer");
        Pass();
    }

    private static void TestNoSecretArgvOrEnvironmentSurface()
    {
        ThrowsRefusal(() => Invocation.Parse(new[]
        {
            "--contract", BrokerContracts.HandoffVersion,
            "--kind", BrokerContracts.Kind,
            "--root", @"C:\broker-test",
            "--expected-self-sha256", new string('a', 64),
            "--destination-disposition", BrokerContracts.DestinationDisposition,
            "--bearer", SyntheticBearer,
        }), "secret argv option rejected");
        var sourceRoot = Path.Combine(
            Environment.CurrentDirectory,
            "packages",
            "m4-client-bearer-broker");
        True(Directory.Exists(sourceRoot), "broker source root located");
        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.TopDirectoryOnly))
        {
            var text = File.ReadAllText(file);
            False(text.Contains("GetEnvironmentVariable", StringComparison.Ordinal), "environment secret lookup absent");
            False(text.Contains("--bearer", StringComparison.Ordinal), "secret argv surface absent");
        }
        Pass();
    }

    private static DefaultHttpContext NewContext(string method)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = "/mcp";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Connection.RemotePort = 51000;
        context.Connection.LocalIpAddress = IPAddress.Loopback;
        context.Connection.LocalPort = 18082;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static MemoryStream BuildFrame(string bearer)
    {
        var payload = Encoding.ASCII.GetBytes(bearer);
        var stream = new MemoryStream();
        stream.Write(Encoding.ASCII.GetBytes("REVAGENT-M4-HANDOFF-V1\n"));
        stream.WriteByte(0);
        stream.WriteByte(0);
        stream.WriteByte(0);
        stream.WriteByte(checked((byte)payload.Length));
        stream.Write(payload);
        stream.WriteByte(1);
        stream.Position = 0;
        CryptographicOperations.ZeroMemory(payload);
        return stream;
    }

    private static byte[] BearerBytes() => Encoding.ASCII.GetBytes(SyntheticBearer);

    private static string ReadBody(HttpContext context)
    {
        context.Response.Body.Position = 0;
        return new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true).ReadToEnd();
    }

    private static void ThrowsRefusal(Action action, string message)
    {
        try
        {
            action();
        }
        catch (BrokerRefusalException)
        {
            return;
        }
        throw new InvalidOperationException(message);
    }

    private static void True(bool value, string message)
    {
        if (!value)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void False(bool value, string message) => True(!value, message);

    private static void AssertNoSyntheticEvidence(string value, string message)
    {
        False(value.Contains(SyntheticBearer, StringComparison.Ordinal), $"{message}: whole canary leaked");
        foreach (var fragment in SyntheticFragments)
        {
            False(value.Contains(fragment, StringComparison.Ordinal), $"{message}: distinguishing fragment leaked");
        }
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void Pass() => _passed++;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(
        string fileName,
        string existingFileName,
        IntPtr securityAttributes);

    private sealed class SequenceOwnerTable : ITcpOwnerTable
    {
        private readonly Queue<IReadOnlyList<TcpOwnerRow>> _rows;

        internal SequenceOwnerTable(params IReadOnlyList<TcpOwnerRow>[] rows)
        {
            _rows = new Queue<IReadOnlyList<TcpOwnerRow>>(rows);
        }

        internal int ReadCount { get; private set; }

        public IReadOnlyList<TcpOwnerRow> Read()
        {
            ReadCount++;
            if (_rows.Count == 0)
            {
                throw new InvalidOperationException("owner-table fixture exhausted");
            }
            return _rows.Dequeue();
        }
    }

    private sealed class FakeEvidenceFactory : ICallerProcessEvidenceFactory
    {
        internal int OpenCount { get; private set; }
        internal FakeEvidence? Last { get; private set; }
        internal CallerIdentityExpectation? LastExpectation { get; private set; }
        internal bool EvidenceExited { get; init; }
        internal bool RefuseVerify { get; init; }

        public ICallerProcessEvidence Open(
            int processId,
            CallerIdentityExpectation expectation)
        {
            OpenCount++;
            LastExpectation = expectation;
            Last = new FakeEvidence(processId, EvidenceExited, RefuseVerify);
            return Last;
        }
    }

    private sealed class FakeEvidence : ICallerProcessEvidence
    {
        private readonly bool _exited;
        private readonly bool _refuseVerify;

        internal FakeEvidence(int processId, bool exited, bool refuseVerify)
        {
            ProcessId = processId;
            _exited = exited;
            _refuseVerify = refuseVerify;
        }

        public int ProcessId { get; }
        internal int VerifyCount { get; private set; }
        internal bool Disposed { get; private set; }

        public bool IsExited() => _exited;

        public void VerifyUnchanged()
        {
            VerifyCount++;
            if (_refuseVerify)
            {
                throw new BrokerRefusalException("caller_identity_changed");
            }
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class CaptureHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _send;

        internal CaptureHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
        {
            _send = send;
        }

        internal int CallCount { get; private set; }
        internal string RequestUri { get; private set; } = string.Empty;
        internal string Method { get; private set; } = string.Empty;
        internal string Authorization { get; private set; } = string.Empty;
        internal HashSet<string> HeaderNames { get; } = new(StringComparer.OrdinalIgnoreCase);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            Method = request.Method.Method;
            RequestUri = request.RequestUri?.AbsoluteUri ?? string.Empty;
            Authorization = request.Headers.Authorization?.ToString() ?? string.Empty;
            foreach (var header in request.Headers)
            {
                HeaderNames.Add(header.Key);
            }
            if (request.Content is not null)
            {
                foreach (var header in request.Content.Headers)
                {
                    HeaderNames.Add(header.Key);
                }
            }
            return _send(request, cancellationToken);
        }
    }
}
