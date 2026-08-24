using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevAgent.Bridge.RealWorkerHost.Tests;

public sealed class DocumentContextObservationProjectionTests
{
    private static readonly object ConsoleGate = new();
    private const string ContextDigest =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private const string PayloadHash =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string RsidHash =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Theory]
    [InlineData("snapshot", "captured")]
    [InlineData("queue", "durably_queued")]
    [InlineData("send", "sent")]
    public void PayloadBearingValidStagesProjectTheWatcherContextDigest(
        string stage,
        string outcome)
    {
        string line = InvokeProjection(CreateObservation(stage, outcome, ContextDigest));

        using JsonDocument json = JsonDocument.Parse(line);
        Assert.Equal("bridge.document_context_observation", json.RootElement.GetProperty("event").GetString());
        Assert.Equal(stage, json.RootElement.GetProperty("stage").GetString());
        Assert.Equal(outcome, json.RootElement.GetProperty("outcome").GetString());
        Assert.Equal(ContextDigest, json.RootElement.GetProperty("contextDigest").GetString());
        Assert.Matches("^[0-9a-f]{64}$", json.RootElement.GetProperty("contextDigest").GetString()!);
        Assert.Equal(PayloadHash, json.RootElement.GetProperty("payloadHash").GetString());
        Assert.Equal(RsidHash, json.RootElement.GetProperty("rsidHash").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg")]
    public void PayloadBearingObservationWithoutBareLowercaseDigestIsNotAdmitted(string? contextDigest)
    {
        string transcript = InvokeProjection(CreateObservation("send", "sent", contextDigest));

        Assert.Equal(string.Empty, transcript);
    }

    [Fact]
    public void ProjectionNeverSerializesRawPayloadOrIdentity()
    {
        string rawPayload = "CONFIDENTIAL-MEP-PAYLOAD";
        string rawRsid = "rsid-do-not-disclose";
        string rawPayloadTranscript = InvokeProjection(CreateObservation(
            "snapshot", "captured", ContextDigest, rawPayload));
        string rawIdentityTranscript = InvokeProjection(CreateObservation(
            "snapshot", "captured", ContextDigest, PayloadHash, rawRsid));

        Assert.Equal(string.Empty, rawPayloadTranscript);
        Assert.Equal(string.Empty, rawIdentityTranscript);
    }

    private static object CreateObservation(
        string stage,
        string outcome,
        string? contextDigest,
        string? payloadHash = PayloadHash,
        string rsidHash = RsidHash)
    {
        Type observation = HostAssembly.GetReferencedAssemblies()
            .Where(reference => reference.Name == "revagent-bridge")
            .Select(Assembly.Load)
            .Single()
            .GetType("RevAgent.Bridge.Gateway.Connection.RbpDocumentContextObservation", throwOnError: true)!;
        ConstructorInfo constructor = observation.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .Single(candidate => candidate.GetParameters().Length == 8);
        return constructor.Invoke(new object?[]
        {
            "revagent.rbp-document-context-observation/v1",
            "bridge.document_context_observation",
            stage,
            outcome,
            rsidHash,
            payloadHash,
            contextDigest,
            7L,
        });
    }

    private static string InvokeProjection(object observation)
    {
        Type program = HostAssembly.GetType(
            "RevAgent.Bridge.RealWorkerHost.Program", throwOnError: true)!;
        MethodInfo method = program.GetMethod(
            "ObserveDocumentContext",
            BindingFlags.Static | BindingFlags.NonPublic) ??
            throw new InvalidOperationException("RealWorkerHost document-context projection was not found.");

        lock (ConsoleGate)
        {
            TextWriter original = Console.Error;
            using var capture = new StringWriter();
            try
            {
                Console.SetError(capture);
                method.Invoke(null, new[] { observation });
            }
            finally
            {
                Console.SetError(original);
            }

            return capture.ToString().Trim();
        }
    }

    private static Assembly HostAssembly => Assembly.Load("RevAgent.Bridge.RealWorkerHost");
}
