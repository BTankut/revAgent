using System.Collections.Generic;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorGraphNode
    {
        public string Id { get; set; }

        public long? ElementId { get; set; }

        public string UniqueId { get; set; }

        public string Category { get; set; }

        public string FamilyName { get; set; }

        public string TypeName { get; set; }

        public string SystemClassification { get; set; }

        public string SystemName { get; set; }

        public string SystemType { get; set; }

        public string LevelName { get; set; }

        public double? ElevationMm { get; set; }

        public EngineeringData Engineering { get; set; } = new EngineeringData();

        public IList<ConnectorPort> Connectors { get; set; } = new List<ConnectorPort>();

        public IDictionary<string, string> Properties { get; set; } = new SortedDictionary<string, string>();
    }
}
