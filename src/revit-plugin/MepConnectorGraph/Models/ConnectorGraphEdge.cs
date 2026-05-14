using System.Collections.Generic;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorGraphEdge
    {
        public string Id { get; set; }

        public string FromNodeId { get; set; }

        public string FromConnectorId { get; set; }

        public string ToNodeId { get; set; }

        public string ToConnectorId { get; set; }

        public MepConnectionDirection Direction { get; set; } = MepConnectionDirection.Unknown;

        public MepConnectionKind Kind { get; set; } = MepConnectionKind.Physical;

        public MepConnectorDomain Domain { get; set; } = MepConnectorDomain.Unknown;

        public string SystemClassification { get; set; }

        public IDictionary<string, string> Properties { get; set; } = new SortedDictionary<string, string>();
    }
}
