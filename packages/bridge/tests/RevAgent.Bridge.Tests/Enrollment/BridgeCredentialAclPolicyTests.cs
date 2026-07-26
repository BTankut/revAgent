using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeCredentialAclPolicyTests
{
    [Fact]
    public void ProtectedAcl_ContainsOnlySystemAdministratorsAndService()
    {
        Assert.Equal(
            BridgeCredentialAclPrincipal.LocalSystem,
            BridgeCredentialAclPolicy.OwnerPrincipal);
        BridgeCredentialAclPrincipal[] expected =
        [
            BridgeCredentialAclPrincipal.LocalSystem,
            BridgeCredentialAclPrincipal.BuiltinAdministrators,
            BridgeCredentialAclPrincipal.BridgeService,
        ];

        Assert.Equal(
            expected,
            BridgeCredentialAclPolicy.DirectoryRules.Select(
                rule => rule.Principal));
        Assert.Equal(
            expected,
            BridgeCredentialAclPolicy.FileRules.Select(
                rule => rule.Principal));
        Assert.All(
            BridgeCredentialAclPolicy.DirectoryRules,
            rule => Assert.True(rule.InheritToChildren));
        Assert.All(
            BridgeCredentialAclPolicy.FileRules,
            rule => Assert.False(rule.InheritToChildren));
        Assert.Equal(
            BridgeCredentialAclRights.Modify,
            BridgeCredentialAclPolicy.DirectoryRules.Single(
                rule =>
                    rule.Principal ==
                    BridgeCredentialAclPrincipal.BridgeService).Rights);
        Assert.Equal(
            BridgeCredentialAclRights.Modify,
            BridgeCredentialAclPolicy.FileRules.Single(
                rule =>
                    rule.Principal ==
                    BridgeCredentialAclPrincipal.BridgeService).Rights);
        Assert.All(
            BridgeCredentialAclPolicy.DirectoryRules.Where(
                rule =>
                    rule.Principal !=
                    BridgeCredentialAclPrincipal.BridgeService),
            rule => Assert.Equal(
                BridgeCredentialAclRights.FullControl,
                rule.Rights));
        Assert.All(
            BridgeCredentialAclPolicy.FileRules.Where(
                rule =>
                    rule.Principal !=
                    BridgeCredentialAclPrincipal.BridgeService),
            rule => Assert.Equal(
                BridgeCredentialAclRights.FullControl,
                rule.Rights));
    }
}
