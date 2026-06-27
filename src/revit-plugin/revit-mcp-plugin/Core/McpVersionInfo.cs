using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Core
{
    internal sealed class McpVersionInfo
    {
        private McpVersionInfo(
            string fullVersion,
            string shortVersion,
            string versionDisplay,
            DateTime? packagePublishedAtUtc,
            DateTime? installedAtUtc,
            string channelVersion,
            string channelDisplay,
            DateTime? channelPublishedAtUtc,
            string sourcePath,
            string channelManifestPath)
        {
            FullVersion = string.IsNullOrWhiteSpace(fullVersion) ? "development" : fullVersion;
            ShortVersion = string.IsNullOrWhiteSpace(shortVersion) ? "dev" : shortVersion;
            VersionDisplay = string.IsNullOrWhiteSpace(versionDisplay) ? FormatVersionDisplay(FullVersion) : versionDisplay;
            PackagePublishedAtUtc = packagePublishedAtUtc;
            InstalledAtUtc = installedAtUtc;
            ChannelVersion = string.IsNullOrWhiteSpace(channelVersion) ? string.Empty : channelVersion;
            ChannelDisplay = string.IsNullOrWhiteSpace(channelDisplay) ? string.Empty : channelDisplay;
            ChannelPublishedAtUtc = channelPublishedAtUtc;
            SourcePath = sourcePath;
            ChannelManifestPath = channelManifestPath;
        }

        public string FullVersion { get; private set; }

        public string ShortVersion { get; private set; }

        public string VersionDisplay { get; private set; }

        public DateTime? PackagePublishedAtUtc { get; private set; }

        public DateTime? InstalledAtUtc { get; private set; }

        public string ChannelVersion { get; private set; }

        public string ChannelDisplay { get; private set; }

        public DateTime? ChannelPublishedAtUtc { get; private set; }

        public string SourcePath { get; private set; }

        public string ChannelManifestPath { get; private set; }

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

            return new McpVersionInfo("development", "dev", "Version dev", null, null, string.Empty, string.Empty, null, null, null);
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

                DateTime? installedAtUtc = ReadUtcDate(json, "installedAtUtc") ?? ReadUtcDate(json, "publishedAtUtc");
                DateTime? packagePublishedAtUtc = ReadPackagePublishedAtUtc(path, json);
                string channelManifestPath = ResolveChannelManifestPath(path, json);
                string channelVersion = string.Empty;
                string channelDisplay = string.Empty;
                DateTime? channelPublishedAtUtc = null;
                TryReadChannelManifest(channelManifestPath, out channelVersion, out channelDisplay, out channelPublishedAtUtc);

                return new McpVersionInfo(
                    fullVersion,
                    Shorten(fullVersion),
                    FormatVersionDisplay(fullVersion),
                    packagePublishedAtUtc,
                    installedAtUtc,
                    channelVersion,
                    channelDisplay,
                    channelPublishedAtUtc,
                    path,
                    channelManifestPath);
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
                AddInstallRootCandidates(candidates, seen, Path.Combine(programData, "DPE", "revAgent"));
                AddInstallRootCandidates(candidates, seen, Path.Combine(programData, "DPE", "RevitMCP"));
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

        private static string FormatReleaseIdentifier(string version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return string.Empty;
            }

            string trimmed = version.Trim();
            Match commit = Regex.Match(trimmed, @"^(?<release>.+)-(?<commit>[0-9a-fA-F]{7,40})$");
            if (commit.Success)
            {
                return commit.Groups["release"].Value;
            }

            return trimmed.Length <= 28 ? trimmed : trimmed.Substring(0, 28);
        }

        private static string ExtractBuildIdentifier(string version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return "dev";
            }

            Match commit = Regex.Match(version.Trim(), @"-([0-9a-fA-F]{7,12})\b");
            if (commit.Success)
            {
                return commit.Groups[1].Value.ToLowerInvariant();
            }

            return string.Empty;
        }

        private static string FormatVersionDisplay(string version)
        {
            string release = FormatReleaseIdentifier(version);
            string build = ExtractBuildIdentifier(version);
            if (!string.IsNullOrWhiteSpace(build) &&
                !string.Equals(build, release, StringComparison.OrdinalIgnoreCase))
            {
                return "Version " + release + " (" + build + ")";
            }

            return "Version " + release;
        }

        private static int CompareVersionIdentity(string left, string right)
        {
            if (string.Equals(left, right, StringComparison.OrdinalIgnoreCase))
            {
                return 0;
            }

            List<long> leftParts = ParseVersionNumericParts(left);
            List<long> rightParts = ParseVersionNumericParts(right);
            if (leftParts.Count > 0 && rightParts.Count > 0)
            {
                int count = Math.Max(leftParts.Count, rightParts.Count);
                for (int i = 0; i < count; i++)
                {
                    long leftValue = i < leftParts.Count ? leftParts[i] : -1;
                    long rightValue = i < rightParts.Count ? rightParts[i] : -1;
                    if (leftValue < rightValue)
                    {
                        return -1;
                    }

                    if (leftValue > rightValue)
                    {
                        return 1;
                    }
                }
            }

            return StringComparer.OrdinalIgnoreCase.Compare(left ?? string.Empty, right ?? string.Empty);
        }

        private static List<long> ParseVersionNumericParts(string version)
        {
            List<long> parts = new List<long>();
            if (string.IsNullOrWhiteSpace(version))
            {
                return parts;
            }

            string baseVersion = version.Split('-')[0];
            string[] tokens = baseVersion.Split('.');
            foreach (string token in tokens)
            {
                long value;
                if (!long.TryParse(token, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                {
                    break;
                }

                parts.Add(value);
            }

            return parts;
        }

        public string FormatUpdateStatusLine()
        {
            if (string.IsNullOrWhiteSpace(ChannelVersion))
            {
                return string.Empty;
            }

            if (string.Equals(FullVersion, ChannelVersion, StringComparison.OrdinalIgnoreCase))
            {
                return "Up to date";
            }

            int comparison = CompareVersionIdentity(FullVersion, ChannelVersion);
            if (comparison < 0)
            {
                return "Update available " + FormatReleaseIdentifier(ChannelVersion);
            }

            if (comparison > 0)
            {
                return "Ahead of release " + FormatReleaseIdentifier(ChannelVersion);
            }

            return "Release " + FormatReleaseIdentifier(ChannelVersion);
        }

        public string FormatToolTip()
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("revAgent version: ").Append(FullVersion);

            string buildIdentifier = ExtractBuildIdentifier(FullVersion);
            if (!string.IsNullOrWhiteSpace(buildIdentifier))
            {
                builder.AppendLine();
                builder.Append("Build: ").Append(buildIdentifier);
            }

            if (PackagePublishedAtUtc.HasValue)
            {
                builder.AppendLine();
                builder.Append("Published: ").Append(FormatSortTimestamp(PackagePublishedAtUtc.Value.ToLocalTime()));
            }

            if (InstalledAtUtc.HasValue)
            {
                builder.AppendLine();
                builder.Append("Installed on this PC: ").Append(FormatSortTimestamp(InstalledAtUtc.Value.ToLocalTime()));
            }

            if (!string.IsNullOrWhiteSpace(ChannelVersion))
            {
                builder.AppendLine();
                builder.Append("Release target: ").Append(ChannelVersion);
            }

            if (ChannelPublishedAtUtc.HasValue)
            {
                builder.AppendLine();
                builder.Append("Release published: ").Append(FormatSortTimestamp(ChannelPublishedAtUtc.Value.ToLocalTime()));
            }

            return builder.ToString();
        }

        private static void TryReadChannelManifest(
            string path,
            out string channelVersion,
            out string channelDisplay,
            out DateTime? publishedAtUtc)
        {
            channelVersion = string.Empty;
            channelDisplay = string.Empty;
            publishedAtUtc = null;

            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    return;
                }

                JObject json = JObject.Parse(File.ReadAllText(path));
                channelVersion = (string)json["version"] ?? string.Empty;
                publishedAtUtc = ReadUtcDate(json, "publishedAtUtc");
                channelDisplay = FormatReleaseIdentifier(channelVersion);
            }
            catch
            {
            }
        }

        private static string ResolveChannelManifestPath(string statePath, JObject stateJson)
        {
            string fromState = (string)stateJson.SelectToken("paths.channelManifestPath");
            if (!string.IsNullOrWhiteSpace(fromState))
            {
                return ExpandPath(fromState);
            }

            string stateDir = string.IsNullOrWhiteSpace(statePath) ? null : Path.GetDirectoryName(statePath);
            string configPath = string.IsNullOrWhiteSpace(stateDir) ? null : Path.Combine(stateDir, "updater-config.json");
            try
            {
                if (!string.IsNullOrWhiteSpace(configPath) && File.Exists(configPath))
                {
                    JObject config = JObject.Parse(File.ReadAllText(configPath));
                    string fromConfig = (string)config["channelManifestPath"];
                    if (!string.IsNullOrWhiteSpace(fromConfig))
                    {
                        return ExpandPath(fromConfig);
                    }
                }
            }
            catch
            {
            }

            return null;
        }

        private static string ExpandPath(string path)
        {
            try
            {
                return Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
            }
            catch
            {
                return path;
            }
        }

        private static DateTime? ReadUtcDate(JObject json, string propertyName)
        {
            string raw = (string)json[propertyName];
            if (string.IsNullOrWhiteSpace(raw))
            {
                return null;
            }

            DateTime value;
            if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out value))
            {
                return value.ToUniversalTime();
            }

            return null;
        }

        private static DateTime? ReadPackagePublishedAtUtc(string statePath, JObject stateJson)
        {
            DateTime? direct = ReadUtcDate(stateJson, "publishedAtUtc");
            if (direct.HasValue)
            {
                return direct;
            }

            DateTime? manifestPublished = ReadPublishedAtUtcFromJsonFile((string)stateJson["manifestPath"]);
            if (manifestPublished.HasValue)
            {
                return manifestPublished;
            }

            string stateDir = string.IsNullOrWhiteSpace(statePath) ? null : Path.GetDirectoryName(statePath);
            if (!string.IsNullOrWhiteSpace(stateDir))
            {
                DateTime? packageReleaseInfo = ReadPublishedAtUtcFromJsonFile(Path.Combine(stateDir, "..", "package", "release-info.json"));
                if (packageReleaseInfo.HasValue)
                {
                    return packageReleaseInfo;
                }
            }

            return null;
        }

        private static DateTime? ReadPublishedAtUtcFromJsonFile(string path)
        {
            try
            {
                path = ExpandPath(path);
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    return null;
                }

                JObject json = JObject.Parse(File.ReadAllText(path));
                return ReadUtcDate(json, "publishedAtUtc");
            }
            catch
            {
                return null;
            }
        }

        private static DateTime? TryParseVersionDate(string version, bool requireTime)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return null;
            }

            Match match = Regex.Match(version, @"^(?<year>\d{4})\.(?<month>\d{2})\.(?<day>\d{2})(?:\.(?<time>\d{4}))?");
            if (!match.Success)
            {
                return null;
            }

            int year;
            int month;
            int day;
            if (!int.TryParse(match.Groups["year"].Value, out year) ||
                !int.TryParse(match.Groups["month"].Value, out month) ||
                !int.TryParse(match.Groups["day"].Value, out day))
            {
                return null;
            }

            int hour = 0;
            int minute = 0;
            string time = match.Groups["time"].Value;
            if (requireTime && string.IsNullOrWhiteSpace(time))
            {
                return null;
            }

            if (!string.IsNullOrWhiteSpace(time) && time.Length == 4)
            {
                int.TryParse(time.Substring(0, 2), out hour);
                int.TryParse(time.Substring(2, 2), out minute);
            }

            try
            {
                return new DateTime(year, month, day, hour, minute, 0);
            }
            catch
            {
                return null;
            }
        }

        private static string FormatSortTimestamp(DateTime value)
        {
            return value.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
        }

        private static string ExtractVersionSuffix(string version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return string.Empty;
            }

            Match commit = Regex.Match(version, @"-([0-9a-fA-F]{7,12})\b");
            if (commit.Success)
            {
                return commit.Groups[1].Value;
            }

            string shortVersion = Shorten(version);
            return string.Equals(shortVersion, version, StringComparison.OrdinalIgnoreCase)
                ? string.Empty
                : shortVersion;
        }
    }
}
