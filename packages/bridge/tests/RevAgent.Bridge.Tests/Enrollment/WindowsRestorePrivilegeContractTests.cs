using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class WindowsRestorePrivilegeContractTests
{
    [Fact]
    public void RestoreInterop_AllowsNullPreviousStateAndReturnLength()
    {
        Type privilegeType = typeof(WindowsBridgeRestorePrivilege);
        System.Reflection.MethodInfo? enable = privilegeType.GetMethod(
            "AdjustTokenPrivileges",
            System.Reflection.BindingFlags.Static |
            System.Reflection.BindingFlags.NonPublic);
        System.Reflection.MethodInfo? restore = privilegeType.GetMethod(
            "RestoreTokenPrivileges",
            System.Reflection.BindingFlags.Static |
            System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(enable);
        Assert.NotNull(restore);

        Type[] enableParameterTypes = enable!.GetParameters()
            .Select(parameter => parameter.ParameterType)
            .ToArray();
        Type[] restoreParameterTypes = restore!.GetParameters()
            .Select(parameter => parameter.ParameterType)
            .ToArray();

        Assert.True(enableParameterTypes[^2].IsByRef);
        Assert.True(enableParameterTypes[^1].IsByRef);
        Assert.Equal(typeof(IntPtr), restoreParameterTypes[^2]);
        Assert.Equal(typeof(IntPtr), restoreParameterTypes[^1]);
    }
}
