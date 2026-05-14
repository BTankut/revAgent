using System.Collections.Generic;

namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorGraphMetadata
    {
        public string Source { get; set; }

        public string ExportMode { get; set; } = "readOnly";

        public string RevitVersion { get; set; } = "2022";

        public string DocumentTitle { get; set; }

        public string ViewName { get; set; }

        public string Notes { get; set; }

        public IDictionary<string, string> Properties { get; set; } = new SortedDictionary<string, string>();
    }
}
