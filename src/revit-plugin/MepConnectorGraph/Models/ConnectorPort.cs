using System.Collections.Generic;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorPort
    {
        public string Id { get; set; }

        public string OwnerNodeId { get; set; }

        public long? OwnerElementId { get; set; }

        public string OwnerUniqueId { get; set; }

        public int? ConnectorIndex { get; set; }

        public MepConnectorDomain Domain { get; set; } = MepConnectorDomain.Unknown;

        public Point3D Origin { get; set; }

        public Vector3D Direction { get; set; }

        public MepConnectorFlowDirection FlowDirection { get; set; } = MepConnectorFlowDirection.Unknown;

        public bool IsConnectionExpected { get; set; } = true;

        public string SystemClassification { get; set; }

        public IDictionary<string, string> Properties { get; set; } = new SortedDictionary<string, string>();
    }
}
