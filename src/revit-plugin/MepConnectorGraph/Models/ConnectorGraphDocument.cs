using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorGraphDocument
    {
        [JsonProperty(Order = -20)]
        public string SchemaVersion { get; set; } = ConnectorGraphSchema.CurrentVersion;

        [JsonProperty(Order = -10)]
        public ConnectorGraphMetadata Metadata { get; set; } = new ConnectorGraphMetadata();

        [JsonProperty(Order = -5)]
        public ConnectorGraphUnits Units { get; set; } = ConnectorGraphUnits.CreateDefaultMetric();

        public IList<ConnectorGraphNode> Nodes { get; set; } = new List<ConnectorGraphNode>();

        public IList<ConnectorGraphEdge> Edges { get; set; } = new List<ConnectorGraphEdge>();

        public TopologyReport Topology { get; set; }
    }
}
