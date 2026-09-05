using System.Reflection;
using Xunit;

namespace RevAgent.Bridge.RealWorkerHost.Tests;

public sealed class GenuineStateRootPreparationTests
{
    [Fact]
    public void CreatesTheDeclaredStateParentBeforeCredentialPreparation()
    {
        using var fixture = new FixtureDirectory();
        string state = Path.Combine(fixture.Root, "state");
        Assert.False(Directory.Exists(state));
        using (Prepare(state))
        {
            Assert.True(Directory.Exists(state));
            Assert.False(Directory.Exists(Path.Combine(state, "credentials")));
        }
        File.WriteAllText(Path.Combine(state, "marker"), "preserve");
        using (Prepare(state))
            Assert.Equal("preserve", File.ReadAllText(Path.Combine(state, "marker")));
    }

    [Fact]
    public void DoesNotCreateMissingAncestorsOrReplaceAnExistingFile()
    {
        using var fixture = new FixtureDirectory();
        string missingParent = Path.Combine(fixture.Root, "missing");
        Assert.ThrowsAny<IOException>(() => Prepare(Path.Combine(missingParent, "state")));
        Assert.False(Directory.Exists(missingParent));
        string occupied = Path.Combine(fixture.Root, "state-file");
        File.WriteAllText(occupied, "preserve");
        Assert.Throws<InvalidDataException>(() => Prepare(occupied));
        Assert.Equal("preserve", File.ReadAllText(occupied));
    }

    private static IDisposable Prepare(string stateRoot)
    {
        Type program = Assembly.Load("RevAgent.Bridge.RealWorkerHost").GetType(
            "RevAgent.Bridge.RealWorkerHost.Program", throwOnError: true)!;
        MethodInfo method = program.GetMethod("PrepareGenuineStateRoot",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        try { return (IDisposable)method.Invoke(null, [stateRoot])!; }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
            throw;
        }
    }

    private sealed class FixtureDirectory : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(),
            "eu20-genuine-state-" + Guid.NewGuid().ToString("N"));
        internal FixtureDirectory() => Directory.CreateDirectory(Root);
        public void Dispose() => Directory.Delete(Root, recursive: true);
    }
}
