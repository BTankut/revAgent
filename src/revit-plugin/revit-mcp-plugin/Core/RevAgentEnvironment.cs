using System;

namespace revit_mcp_plugin.Core
{
    internal static class RevAgentEnvironment
    {
        public static string Get(params string[] names)
        {
            if (names == null)
            {
                return null;
            }

            foreach (string name in names)
            {
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                string value = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return value;
                }
            }

            return null;
        }

        public static bool IsFalseLike(string value)
        {
            return string.Equals(value, "0", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "false", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "off", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "no", StringComparison.OrdinalIgnoreCase);
        }
    }
}
