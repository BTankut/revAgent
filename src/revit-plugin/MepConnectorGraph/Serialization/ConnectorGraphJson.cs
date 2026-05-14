using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Serialization;
using RevitMcp.MepConnectorGraph.Models;

namespace RevitMcp.MepConnectorGraph.Serialization
{
    public static class ConnectorGraphJson
    {
        private static readonly JsonSerializerSettings Settings = CreateSettings();

        public static ConnectorGraphDocument Deserialize(string json)
        {
            var document = JsonConvert.DeserializeObject<ConnectorGraphDocument>(json, Settings);
            return Normalize(document);
        }

        public static ConnectorGraphDocument LoadFromFile(string path)
        {
            return Deserialize(File.ReadAllText(path));
        }

        public static string Serialize(ConnectorGraphDocument document)
        {
            return JsonConvert.SerializeObject(Normalize(document), Formatting.Indented, Settings) + "\r\n";
        }

        public static void SaveToFile(ConnectorGraphDocument document, string path)
        {
            File.WriteAllText(path, Serialize(document));
        }

        public static ConnectorGraphDocument Normalize(ConnectorGraphDocument document)
        {
            if (document == null)
            {
                return new ConnectorGraphDocument();
            }

            if (string.IsNullOrWhiteSpace(document.SchemaVersion))
            {
                document.SchemaVersion = ConnectorGraphSchema.CurrentVersion;
            }

            document.Metadata = document.Metadata ?? new ConnectorGraphMetadata();
            document.Metadata.Properties = SortDictionary(document.Metadata.Properties);
            document.Units = document.Units ?? ConnectorGraphUnits.CreateDefaultMetric();
            document.Nodes = document.Nodes ?? new List<ConnectorGraphNode>();
            document.Edges = document.Edges ?? new List<ConnectorGraphEdge>();

            document.Nodes = document.Nodes
                .Where(n => n != null)
                .OrderBy(n => n.Id ?? string.Empty, System.StringComparer.Ordinal)
                .ToList();

            foreach (var node in document.Nodes)
            {
                node.Engineering = node.Engineering ?? new EngineeringData();
                node.Properties = SortDictionary(node.Properties);
                node.Connectors = (node.Connectors ?? new List<ConnectorPort>())
                    .Where(c => c != null)
                    .OrderBy(c => c.Id ?? string.Empty, System.StringComparer.Ordinal)
                    .ToList();

                foreach (var connector in node.Connectors)
                {
                    if (string.IsNullOrWhiteSpace(connector.OwnerNodeId))
                    {
                        connector.OwnerNodeId = node.Id;
                    }

                    if (!connector.OwnerElementId.HasValue)
                    {
                        connector.OwnerElementId = node.ElementId;
                    }

                    if (string.IsNullOrWhiteSpace(connector.OwnerUniqueId))
                    {
                        connector.OwnerUniqueId = node.UniqueId;
                    }

                    connector.Properties = SortDictionary(connector.Properties);
                }
            }

            document.Edges = document.Edges
                .Where(e => e != null)
                .OrderBy(e => e.Id ?? string.Empty, System.StringComparer.Ordinal)
                .ToList();

            foreach (var edge in document.Edges)
            {
                edge.Properties = SortDictionary(edge.Properties);
            }

            if (document.Topology != null)
            {
                document.Topology.Components = (document.Topology.Components ?? new List<TopologyComponent>())
                    .Where(c => c != null)
                    .OrderBy(c => c.Id ?? string.Empty, System.StringComparer.Ordinal)
                    .ToList();

                foreach (var component in document.Topology.Components)
                {
                    component.NodeIds = SortStrings(component.NodeIds);
                    component.EdgeIds = SortStrings(component.EdgeIds);
                }

                document.Topology.Findings = (document.Topology.Findings ?? new List<TopologyFinding>())
                    .Where(f => f != null)
                    .OrderByDescending(f => f.Severity)
                    .ThenBy(f => f.Code ?? string.Empty, System.StringComparer.Ordinal)
                    .ThenBy(f => FirstOrEmpty(f.NodeIds), System.StringComparer.Ordinal)
                    .ThenBy(f => FirstOrEmpty(f.ConnectorIds), System.StringComparer.Ordinal)
                    .ThenBy(f => FirstOrEmpty(f.EdgeIds), System.StringComparer.Ordinal)
                    .ToList();

                foreach (var finding in document.Topology.Findings)
                {
                    finding.NodeIds = SortStrings(finding.NodeIds);
                    finding.ConnectorIds = SortStrings(finding.ConnectorIds);
                    finding.EdgeIds = SortStrings(finding.EdgeIds);
                }
            }

            return document;
        }

        private static JsonSerializerSettings CreateSettings()
        {
            var settings = new JsonSerializerSettings
            {
                ContractResolver = new CamelCasePropertyNamesContractResolver(),
                NullValueHandling = NullValueHandling.Ignore,
                MissingMemberHandling = MissingMemberHandling.Ignore
            };
            settings.Converters.Add(new StringEnumConverter(new CamelCaseNamingStrategy()));
            return settings;
        }

        private static IDictionary<string, string> SortDictionary(IDictionary<string, string> source)
        {
            var sorted = new SortedDictionary<string, string>(System.StringComparer.Ordinal);
            if (source == null)
            {
                return sorted;
            }

            foreach (var item in source)
            {
                if (item.Key != null)
                {
                    sorted[item.Key] = item.Value;
                }
            }

            return sorted;
        }

        private static IList<string> SortStrings(IList<string> source)
        {
            return (source ?? new List<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(System.StringComparer.Ordinal)
                .OrderBy(value => value, System.StringComparer.Ordinal)
                .ToList();
        }

        private static string FirstOrEmpty(IList<string> values)
        {
            return values == null || values.Count == 0 ? string.Empty : values[0] ?? string.Empty;
        }
    }
}
