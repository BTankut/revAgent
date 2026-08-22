using System;

namespace RevAgentCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// Pure, directly testable reduction of observed Revit transaction status
    /// into the DC-02 effect taxonomy. Absence or contradiction is unknown;
    /// no exception text is treated as commit or rollback evidence.
    /// </summary>
    public static class ExecutionOutcomeDecision
    {
        public static string ResolveFailure(
            string observedStatus,
            string rollbackStatus)
        {
            if (string.Equals(
                    observedStatus,
                    "Committed",
                    StringComparison.Ordinal))
            {
                return "committed";
            }

            if (string.Equals(
                    observedStatus,
                    "RolledBack",
                    StringComparison.Ordinal) ||
                string.Equals(
                    rollbackStatus,
                    "RolledBack",
                    StringComparison.Ordinal))
            {
                return "rolled_back";
            }

            return "unknown";
        }
    }
}
