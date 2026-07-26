using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Tests;

public sealed class ContractSourceProvenanceTests
{
    [Fact]
    public void FrozenContractSourcesMatchPinnedGitBlobs()
    {
        var repositoryRoot = FindRepositoryRoot();
        var provenancePath = Path.Combine(
            repositoryRoot,
            "packages",
            "bridge",
            "test-fixtures",
            "provenance.json");
        var provenance = JObject.Parse(File.ReadAllText(provenancePath, Encoding.UTF8));
        var sources = Assert.IsType<JObject>(provenance["frozenSources"]);

        foreach (var property in sources.Properties())
        {
            var sourcePath = Path.Combine(
                repositoryRoot,
                property.Name.Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(sourcePath), $"Pinned source is missing: {property.Name}");

            var workingTreeText = File.ReadAllText(sourcePath, Encoding.UTF8)
                .Replace("\r\n", "\n")
                .Replace("\r", "\n");
            var actual = ComputeGitBlobId(Encoding.UTF8.GetBytes(workingTreeText));
            Assert.Equal(property.Value.Value<string>(), actual);
        }
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(current.FullName, "packages", "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate the revAgent repository root.");
    }

    private static string ComputeGitBlobId(byte[] content)
    {
        var header = Encoding.ASCII.GetBytes($"blob {content.Length}\0");
        var input = new byte[header.Length + content.Length];
        Buffer.BlockCopy(header, 0, input, 0, header.Length);
        Buffer.BlockCopy(content, 0, input, header.Length, content.Length);

        using var sha1 = SHA1.Create();
        return Convert.ToHexString(sha1.ComputeHash(input)).ToLowerInvariant();
    }
}
