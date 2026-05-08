using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Core
{
    internal sealed class McpVersionInfo
    {
        private McpVersionInfo(string fullVersion, string shortVersion, string sourcePath)
        {
            FullVersion = string.IsNullOrWhiteSpace(fullVersion) ? "development" : fullVersion;
            ShortVersion = string.IsNullOrWhiteSpace(shortVersion) ? "dev" : shortVersion;
            SourcePath = sourcePath;
        }

        public string FullVersion { get; private set; }

        public string ShortVersion { get; private set; }

        public string SourcePath { get; private set; }

        public static McpVersionInfo Read()
        {
            foreach (string candidate in GetCandidateStateFiles())
            {
                McpVersionInfo version = TryRead(candidate);
                if (version != null)
                {
                    return version;
                }
            }

            return new McpVersionInfo("development", "dev", null);
        }

        private static McpVersionInfo TryRead(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    return null;
                }

                JObject json = JObject.Parse(File.ReadAllText(path));
                string fullVersion = (string)json["version"];
                if (string.IsNullOrWhiteSpace(fullVersion))
                {
                    return null;
                }

                return new McpVersionInfo(fullVersion, Shorten(fullVersion), path);
            }
            catch
            {
                return null;
            }
        }

        private static IEnumerable<string> GetCandidateStateFiles()
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> candidates = new List<string>();
            string explicitState = Environment.GetEnvironmentVariable("REVIT_MCP_INSTALLED_STATE");
            AddCandidate(candidates, seen, explicitState);

            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (!string.IsNullOrWhiteSpace(programData))
            {
                string installRoot = Path.Combine(programData, "DPE", "RevitMCP");
                AddInstallRootCandidates(candidates, seen, installRoot);
            }

            string assemblyPath = Assembly.GetExecutingAssembly().Location;
            string directory = string.IsNullOrWhiteSpace(assemblyPath) ? null : Path.GetDirectoryName(assemblyPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                DirectoryInfo current = new DirectoryInfo(directory);
                for (int i = 0; i < 6 && current != null; i++)
                {
                    AddInstallRootCandidates(candidates, seen, current.FullName);
                    current = current.Parent;
                }
            }

            return candidates;
        }

        private static void AddInstallRootCandidates(List<string> candidates, HashSet<string> seen, string installRoot)
        {
            if (string.IsNullOrWhiteSpace(installRoot))
            {
                return;
            }

            AddCandidate(candidates, seen, Path.Combine(installRoot, "updater", "installed.json"));
            AddCandidate(candidates, seen, Path.Combine(installRoot, "package", "release-info.json"));
        }

        private static void AddCandidate(List<string> candidates, HashSet<string> seen, string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return;
            }

            try
            {
                string fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
                if (seen.Add(fullPath))
                {
                    candidates.Add(fullPath);
                }
            }
            catch
            {
            }
        }

        private static string Shorten(string version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return "dev";
            }

            string[] parts = version.Split('.');
            if (parts.Length >= 4)
            {
                string buildPart = parts[3];
                int dashIndex = buildPart.IndexOf('-');
                if (dashIndex > 0)
                {
                    buildPart = buildPart.Substring(0, dashIndex);
                }

                if (Regex.IsMatch(buildPart, @"^\d{3,6}$"))
                {
                    return buildPart;
                }
            }

            Match match = Regex.Match(version, @"\b\d{3,6}(?=-[0-9a-fA-F]{7,}\b)");
            if (match.Success)
            {
                return match.Value;
            }

            return version.Length <= 12 ? version : version.Substring(0, 12);
        }
    }
}
