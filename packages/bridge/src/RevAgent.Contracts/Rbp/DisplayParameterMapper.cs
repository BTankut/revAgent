#nullable enable

using System;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Rbp
{
    /// <summary>
    /// Adds only the six frozen RBP/1 display values to a cloned add-in params
    /// object. Functional params remain the digest source and are never mutated.
    /// </summary>
    public static class DisplayParameterMapper
    {
        private static readonly string[] ReservedAddinKeys =
        {
            "taskName",
            "wrapperAction",
            "logicalToolName",
            "parentTaskName",
            "parentTaskId",
            "suppressTaskStatusWindow",
        };

        public static JObject Map(JObject functionalParams, RbpDisplay? display)
        {
            if (functionalParams == null)
            {
                throw new ArgumentNullException(nameof(functionalParams));
            }

            var mapped = (JObject)functionalParams.DeepClone();

            // Display/audit values are server-authored. Functional params cannot
            // smuggle or retain an older value in this namespace.
            foreach (var key in ReservedAddinKeys)
            {
                mapped.Property(key, StringComparison.Ordinal)?.Remove();
            }

            if (display == null)
            {
                return mapped;
            }

            display.Validate();

            if (display.HasTaskName)
            {
                mapped["taskName"] = display.TaskName;
            }

            if (display.HasWrapperAction)
            {
                mapped["wrapperAction"] = display.WrapperAction;
            }

            if (display.HasLogicalToolName)
            {
                mapped["logicalToolName"] = display.LogicalToolName;
            }

            if (display.HasParentTaskName)
            {
                mapped["parentTaskName"] = display.ParentTaskName == null
                    ? JValue.CreateNull()
                    : new JValue(display.ParentTaskName);
            }

            if (display.HasParentTaskId)
            {
                mapped["parentTaskId"] = display.ParentTaskId == null
                    ? JValue.CreateNull()
                    : new JValue(display.ParentTaskId);
            }

            if (display.HasSuppressTaskStatusWindow)
            {
                mapped["suppressTaskStatusWindow"] = display.SuppressTaskStatusWindow;
            }

            return mapped;
        }
    }
}
