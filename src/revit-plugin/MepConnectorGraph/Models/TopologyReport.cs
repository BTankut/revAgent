using System.Collections.Generic;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class TopologyReport
    {
        public TopologySummary Summary { get; set; } = new TopologySummary();

        public IList<TopologyComponent> Components { get; set; } = new List<TopologyComponent>();

        public IList<TopologyFinding> Findings { get; set; } = new List<TopologyFinding>();
    }

    public sealed class TopologySummary
    {
        public int NodeCount { get; set; }

        public int ConnectorCount { get; set; }

        public int EdgeCount { get; set; }

        public int NetworkCount { get; set; }

        public int OpenEndCount { get; set; }

        public int CycleCount { get; set; }

        public int AmbiguousDirectionCount { get; set; }

        public int MissingSystemDataCount { get; set; }

        public int WarningCount { get; set; }

        public int ErrorCount { get; set; }

        public bool IsStructurallyValid { get; set; }

        public bool IsValidForDirectionalCalculation { get; set; }
    }

    public sealed class TopologyComponent
    {
        public string Id { get; set; }

        public IList<string> NodeIds { get; set; } = new List<string>();

        public IList<string> EdgeIds { get; set; } = new List<string>();

        public bool IsIsland { get; set; }
    }

    public sealed class TopologyFinding
    {
        public TopologySeverity Severity { get; set; }

        public string Code { get; set; }

        public string Message { get; set; }

        public IList<string> NodeIds { get; set; } = new List<string>();

        public IList<string> ConnectorIds { get; set; } = new List<string>();

        public IList<string> EdgeIds { get; set; } = new List<string>();
    }
}
