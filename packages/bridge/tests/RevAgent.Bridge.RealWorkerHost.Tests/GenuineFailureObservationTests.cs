using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevAgent.Bridge.RealWorkerHost.Tests;

public sealed class GenuineFailureObservationTests
{
    private static readonly Type ObserverType = Assembly.Load("RevAgent.Bridge.RealWorkerHost").GetType(
        "RevAgent.Bridge.RealWorkerHost.GenuineFailureObservation", true)!;

    [Theory]
    [InlineData("RevAgent.Bridge.Gateway.Connection.RbpCoordinatorException", "RevAgent.Bridge.Gateway.Connection.RbpCoordinatorErrorCode", "coordinator:")]
    [InlineData("RevAgent.Bridge.Gateway.Storage.RbpJournalException", "RevAgent.Bridge.Gateway.Storage.RbpJournalErrorCode", "journal:")]
    [InlineData("RevAgent.Bridge.Gateway.Connection.RbpGatewayTransportException", "RevAgent.Bridge.Gateway.Connection.RbpGatewayFailureKind", "transport:")]
    [InlineData("RevAgent.Bridge.Gateway.Protocol.RbpFrameException", "RevAgent.Bridge.Gateway.Protocol.RbpFrameErrorCode", "frame:")]
    public void ProjectsOnlyFixedCategoryAndNumericCode(string exceptionType, string codeType, string prefix)
    {
        Exception error = MakeException(exceptionType, codeType);
        string? result = (string?)ObserverType.GetMethod("Classify", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [error]);
        Assert.Equal(prefix + "0", result);
        Assert.DoesNotContain("secret-marker", result!);
        Assert.Null(ObserverType.GetMethod("Classify", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [new InvalidOperationException("secret-marker")]));
    }

    [Fact]
    public void BoundsRowsWithExplicitTruncationAndDoesNotReenterWriter()
    {
        var rows = new List<string>();
        Exception error = MakeException("RevAgent.Bridge.Gateway.Storage.RbpJournalException",
            "RevAgent.Bridge.Gateway.Storage.RbpJournalErrorCode");
        object? observer = null;
        Action<string> write = row =>
        {
            rows.Add(row);
            Record(observer!, error);
        };
        observer = Activator.CreateInstance(ObserverType, BindingFlags.Instance | BindingFlags.NonPublic,
            null, [write], null)!;
        using ((IDisposable)observer)
        {
            for (int index = 0; index < 40; index++) Record(observer, error);
        }
        Assert.Equal(32, rows.Count);
        Assert.All(rows, row => Assert.DoesNotContain("secret-marker", row));
        using JsonDocument last = JsonDocument.Parse(rows[^1]);
        Assert.True(last.RootElement.GetProperty("truncated").GetBoolean());
        Assert.Equal("limit_reached", last.RootElement.GetProperty("classification").GetString());
    }

    [Fact]
    public void WriterFailureDoesNotEscapeOrKeepReentrancyGateClosed()
    {
        int calls = 0;
        Action<string> write = _ => { calls++; throw new IOException("secret-marker"); };
        object observer = Activator.CreateInstance(ObserverType, BindingFlags.Instance | BindingFlags.NonPublic,
            null, [write], null)!;
        using ((IDisposable)observer)
        {
            Exception error = MakeException("RevAgent.Bridge.Gateway.Storage.RbpJournalException",
                "RevAgent.Bridge.Gateway.Storage.RbpJournalErrorCode");
            Record(observer, error);
            Record(observer, error);
            Assert.Equal(2, calls);
        }
    }

    private static void Record(object observer, Exception error) =>
        ObserverType.GetMethod("Record", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(observer, [error]);

    private static Exception MakeException(string exceptionType, string codeType)
    {
        Assembly bridge = Assembly.Load("revagent-bridge");
        Type type = bridge.GetType(exceptionType, true)!;
        ConstructorInfo constructor = type.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
        object?[] args = constructor.GetParameters().Select(parameter => parameter.HasDefaultValue ? parameter.DefaultValue : null).ToArray();
        args[0] = Enum.ToObject(bridge.GetType(codeType, true)!, 0);
        args[1] = "secret-marker: path, credential, seed must never be logged";
        return (Exception)constructor.Invoke(args);
    }
}
