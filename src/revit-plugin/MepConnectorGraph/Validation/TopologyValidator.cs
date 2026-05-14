using System;
using System.Collections.Generic;
using System.Linq;
using RevitMcp.MepConnectorGraph.Models;
using RevitMcp.MepConnectorGraph.Serialization;

namespace RevitMcp.MepConnectorGraph.Validation
{
    public sealed class TopologyValidator
    {
        public TopologyReport Validate(ConnectorGraphDocument document)
        {
            document = ConnectorGraphJson.Normalize(document);

            var report = new TopologyReport();
            var nodeById = new Dictionary<string, ConnectorGraphNode>(StringComparer.Ordinal);
            var connectorById = new Dictionary<string, ConnectorPort>(StringComparer.Ordinal);
            var connectorOwnerById = new Dictionary<string, string>(StringComparer.Ordinal);
            var edgeById = new Dictionary<string, ConnectorGraphEdge>(StringComparer.Ordinal);
            var validEdges = new List<ConnectorGraphEdge>();
            var connectorEdgeMap = new Dictionary<string, List<string>>(StringComparer.Ordinal);

            report.Summary.NodeCount = document.Nodes.Count;
            report.Summary.EdgeCount = document.Edges.Count;

            ValidateSchemaVersion(document, report);
            IndexNodes(document, report, nodeById, connectorById, connectorOwnerById);
            report.Summary.ConnectorCount = connectorById.Count;
            IndexEdges(document, report, edgeById, connectorById, connectorOwnerById, validEdges, connectorEdgeMap);

            DetectOpenEnds(connectorById, connectorEdgeMap, report);
            DetectMissingSystemData(document, report);
            DetectDirectionAmbiguity(validEdges, connectorById, report);
            BuildComponents(nodeById, validEdges, connectorOwnerById, report);

            report.Summary.WarningCount = report.Findings.Count(f => f.Severity == TopologySeverity.Warning);
            report.Summary.ErrorCount = report.Findings.Count(f => f.Severity == TopologySeverity.Error);
            report.Summary.IsStructurallyValid = report.Summary.ErrorCount == 0;
            report.Summary.IsValidForDirectionalCalculation =
                report.Summary.ErrorCount == 0 &&
                report.Summary.NodeCount > 0 &&
                report.Summary.EdgeCount > 0 &&
                report.Summary.NetworkCount == 1 &&
                report.Summary.AmbiguousDirectionCount == 0 &&
                report.Summary.MissingSystemDataCount == 0;

            return ConnectorGraphJson.Normalize(new ConnectorGraphDocument { Topology = report }).Topology;
        }

        private static void ValidateSchemaVersion(ConnectorGraphDocument document, TopologyReport report)
        {
            if (!string.Equals(document.SchemaVersion, ConnectorGraphSchema.CurrentVersion, StringComparison.Ordinal))
            {
                AddFinding(
                    report,
                    TopologySeverity.Error,
                    "schema_version_unsupported",
                    "Connector graph schema version is not supported.");
            }
        }

        private static void IndexNodes(
            ConnectorGraphDocument document,
            TopologyReport report,
            IDictionary<string, ConnectorGraphNode> nodeById,
            IDictionary<string, ConnectorPort> connectorById,
            IDictionary<string, string> connectorOwnerById)
        {
            foreach (var node in document.Nodes)
            {
                if (string.IsNullOrWhiteSpace(node.Id))
                {
                    AddFinding(report, TopologySeverity.Error, "node_id_missing", "A graph node is missing an id.");
                    continue;
                }

                if (nodeById.ContainsKey(node.Id))
                {
                    AddFinding(
                        report,
                        TopologySeverity.Error,
                        "node_id_duplicate",
                        "A graph node id appears more than once.",
                        new[] { node.Id },
                        null,
                        null);
                    continue;
                }

                nodeById.Add(node.Id, node);

                foreach (var connector in node.Connectors)
                {
                    if (string.IsNullOrWhiteSpace(connector.Id))
                    {
                        AddFinding(
                            report,
                            TopologySeverity.Error,
                            "connector_id_missing",
                            "A connector is missing an id.",
                            new[] { node.Id },
                            null,
                            null);
                        continue;
                    }

                    if (connectorById.ContainsKey(connector.Id))
                    {
                        AddFinding(
                            report,
                            TopologySeverity.Error,
                            "connector_id_duplicate",
                            "A connector id appears more than once.",
                            new[] { node.Id },
                            new[] { connector.Id },
                            null);
                        continue;
                    }

                    connectorById.Add(connector.Id, connector);
                    connectorOwnerById.Add(connector.Id, node.Id);

                    if (!string.Equals(connector.OwnerNodeId, node.Id, StringComparison.Ordinal))
                    {
                        AddFinding(
                            report,
                            TopologySeverity.Error,
                            "connector_owner_mismatch",
                            "A connector ownerNodeId does not match the containing node id.",
                            new[] { node.Id, connector.OwnerNodeId },
                            new[] { connector.Id },
                            null);
                    }
                }
            }
        }

        private static void IndexEdges(
            ConnectorGraphDocument document,
            TopologyReport report,
            IDictionary<string, ConnectorGraphEdge> edgeById,
            IDictionary<string, ConnectorPort> connectorById,
            IDictionary<string, string> connectorOwnerById,
            IList<ConnectorGraphEdge> validEdges,
            IDictionary<string, List<string>> connectorEdgeMap)
        {
            foreach (var edge in document.Edges)
            {
                if (string.IsNullOrWhiteSpace(edge.Id))
                {
                    AddFinding(report, TopologySeverity.Error, "edge_id_missing", "A graph edge is missing an id.");
                    continue;
                }

                if (edgeById.ContainsKey(edge.Id))
                {
                    AddFinding(report, TopologySeverity.Error, "edge_id_duplicate", "A graph edge id appears more than once.", null, null, new[] { edge.Id });
                    continue;
                }

                edgeById.Add(edge.Id, edge);

                var endpointsOk = true;
                endpointsOk &= ValidateEdgeEndpoint(edge, true, connectorById, connectorOwnerById, report);
                endpointsOk &= ValidateEdgeEndpoint(edge, false, connectorById, connectorOwnerById, report);

                if (!endpointsOk)
                {
                    continue;
                }

                validEdges.Add(edge);
                AddConnectorEdge(connectorEdgeMap, edge.FromConnectorId, edge.Id);
                AddConnectorEdge(connectorEdgeMap, edge.ToConnectorId, edge.Id);
            }
        }

        private static bool ValidateEdgeEndpoint(
            ConnectorGraphEdge edge,
            bool isFrom,
            IDictionary<string, ConnectorPort> connectorById,
            IDictionary<string, string> connectorOwnerById,
            TopologyReport report)
        {
            var connectorId = isFrom ? edge.FromConnectorId : edge.ToConnectorId;
            var nodeId = isFrom ? edge.FromNodeId : edge.ToNodeId;
            var endpointName = isFrom ? "from" : "to";

            if (string.IsNullOrWhiteSpace(connectorId))
            {
                AddFinding(report, TopologySeverity.Error, "edge_endpoint_missing", "A graph edge is missing a connector endpoint.", null, null, new[] { edge.Id });
                return false;
            }

            if (!connectorById.ContainsKey(connectorId))
            {
                AddFinding(
                    report,
                    TopologySeverity.Error,
                    "edge_endpoint_unknown",
                    "A graph edge references a connector id that is not present in the nodes collection.",
                    null,
                    new[] { connectorId },
                    new[] { edge.Id });
                return false;
            }

            var actualNodeId = connectorOwnerById[connectorId];
            if (!string.IsNullOrWhiteSpace(nodeId) && !string.Equals(nodeId, actualNodeId, StringComparison.Ordinal))
            {
                AddFinding(
                    report,
                    TopologySeverity.Error,
                    "edge_endpoint_owner_mismatch",
                    "A graph edge " + endpointName + " node id does not match the referenced connector owner.",
                    new[] { nodeId, actualNodeId },
                    new[] { connectorId },
                    new[] { edge.Id });
                return false;
            }

            if (isFrom)
            {
                edge.FromNodeId = actualNodeId;
            }
            else
            {
                edge.ToNodeId = actualNodeId;
            }

            return true;
        }

        private static void DetectOpenEnds(
            IDictionary<string, ConnectorPort> connectorById,
            IDictionary<string, List<string>> connectorEdgeMap,
            TopologyReport report)
        {
            foreach (var connector in connectorById.Values.OrderBy(c => c.Id, StringComparer.Ordinal))
            {
                if (!connector.IsConnectionExpected)
                {
                    continue;
                }

                if (!connectorEdgeMap.ContainsKey(connector.Id) || connectorEdgeMap[connector.Id].Count == 0)
                {
                    report.Summary.OpenEndCount++;
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "open_end",
                        "A connector has no physical graph edge.",
                        new[] { connector.OwnerNodeId },
                        new[] { connector.Id },
                        null);
                }
            }
        }

        private static void DetectMissingSystemData(ConnectorGraphDocument document, TopologyReport report)
        {
            foreach (var node in document.Nodes)
            {
                if (string.IsNullOrWhiteSpace(node.SystemClassification) &&
                    string.IsNullOrWhiteSpace(node.SystemName) &&
                    string.IsNullOrWhiteSpace(node.SystemType))
                {
                    report.Summary.MissingSystemDataCount++;
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "missing_system_data",
                        "A graph node has no system classification, name, or type.",
                        new[] { node.Id },
                        null,
                        null);
                }
            }
        }

        private static void DetectDirectionAmbiguity(
            IEnumerable<ConnectorGraphEdge> validEdges,
            IDictionary<string, ConnectorPort> connectorById,
            TopologyReport report)
        {
            foreach (var edge in validEdges.OrderBy(e => e.Id, StringComparer.Ordinal))
            {
                if (edge.Direction == MepConnectionDirection.Unknown || edge.Direction == MepConnectionDirection.Ambiguous)
                {
                    report.Summary.AmbiguousDirectionCount++;
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "direction_ambiguous",
                        "A graph edge has no reliable direction.",
                        new[] { edge.FromNodeId, edge.ToNodeId },
                        new[] { edge.FromConnectorId, edge.ToConnectorId },
                        new[] { edge.Id });
                    continue;
                }

                if (HasDirectionalConflict(edge, connectorById))
                {
                    report.Summary.AmbiguousDirectionCount++;
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "direction_conflict",
                        "A graph edge direction conflicts with connector flow direction.",
                        new[] { edge.FromNodeId, edge.ToNodeId },
                        new[] { edge.FromConnectorId, edge.ToConnectorId },
                        new[] { edge.Id });
                }
            }
        }

        private static bool HasDirectionalConflict(ConnectorGraphEdge edge, IDictionary<string, ConnectorPort> connectorById)
        {
            var from = connectorById[edge.FromConnectorId];
            var to = connectorById[edge.ToConnectorId];

            if (edge.Direction == MepConnectionDirection.FromTo)
            {
                return from.FlowDirection == MepConnectorFlowDirection.In || to.FlowDirection == MepConnectorFlowDirection.Out;
            }

            if (edge.Direction == MepConnectionDirection.ToFrom)
            {
                return to.FlowDirection == MepConnectorFlowDirection.In || from.FlowDirection == MepConnectorFlowDirection.Out;
            }

            return false;
        }

        private static void BuildComponents(
            IDictionary<string, ConnectorGraphNode> nodeById,
            IList<ConnectorGraphEdge> validEdges,
            IDictionary<string, string> connectorOwnerById,
            TopologyReport report)
        {
            var adjacency = nodeById.Keys.ToDictionary(id => id, id => new List<string>(), StringComparer.Ordinal);
            var edgeIdsByNode = nodeById.Keys.ToDictionary(id => id, id => new List<string>(), StringComparer.Ordinal);

            foreach (var edge in validEdges)
            {
                var fromNodeId = connectorOwnerById[edge.FromConnectorId];
                var toNodeId = connectorOwnerById[edge.ToConnectorId];
                edgeIdsByNode[fromNodeId].Add(edge.Id);
                if (!string.Equals(fromNodeId, toNodeId, StringComparison.Ordinal))
                {
                    adjacency[fromNodeId].Add(toNodeId);
                    adjacency[toNodeId].Add(fromNodeId);
                    edgeIdsByNode[toNodeId].Add(edge.Id);
                }
            }

            var visited = new HashSet<string>(StringComparer.Ordinal);
            var componentNumber = 0;
            foreach (var nodeId in nodeById.Keys.OrderBy(id => id, StringComparer.Ordinal))
            {
                if (visited.Contains(nodeId))
                {
                    continue;
                }

                componentNumber++;
                var nodeIds = TraverseComponent(nodeId, adjacency, visited);
                var edgeIds = nodeIds
                    .SelectMany(id => edgeIdsByNode[id])
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(id => id, StringComparer.Ordinal)
                    .ToList();

                var component = new TopologyComponent
                {
                    Id = "network-" + componentNumber.ToString("000"),
                    NodeIds = nodeIds.OrderBy(id => id, StringComparer.Ordinal).ToList(),
                    EdgeIds = edgeIds,
                    IsIsland = nodeIds.Count == 1 && edgeIds.Count == 0
                };
                report.Components.Add(component);

                var cycleCount = edgeIds.Count - nodeIds.Count + 1;
                if (cycleCount > 0)
                {
                    report.Summary.CycleCount += cycleCount;
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "cycle_detected",
                        "A connected network contains at least one cycle.",
                        component.NodeIds,
                        null,
                        component.EdgeIds);
                }

                if (component.IsIsland)
                {
                    AddFinding(
                        report,
                        TopologySeverity.Warning,
                        "disconnected_island",
                        "A graph node is disconnected from every other node.",
                        component.NodeIds,
                        null,
                        null);
                }
            }

            report.Summary.NetworkCount = report.Components.Count;
            if (report.Summary.NetworkCount > 1)
            {
                AddFinding(
                    report,
                    TopologySeverity.Warning,
                    "multiple_networks",
                    "The connector graph contains more than one disconnected network.");
            }
        }

        private static List<string> TraverseComponent(
            string startNodeId,
            IDictionary<string, List<string>> adjacency,
            ISet<string> visited)
        {
            var result = new List<string>();
            var stack = new Stack<string>();
            stack.Push(startNodeId);
            visited.Add(startNodeId);

            while (stack.Count > 0)
            {
                var current = stack.Pop();
                result.Add(current);

                foreach (var next in adjacency[current].OrderByDescending(id => id, StringComparer.Ordinal))
                {
                    if (visited.Contains(next))
                    {
                        continue;
                    }

                    visited.Add(next);
                    stack.Push(next);
                }
            }

            return result;
        }

        private static void AddConnectorEdge(IDictionary<string, List<string>> connectorEdgeMap, string connectorId, string edgeId)
        {
            List<string> edgeIds;
            if (!connectorEdgeMap.TryGetValue(connectorId, out edgeIds))
            {
                edgeIds = new List<string>();
                connectorEdgeMap.Add(connectorId, edgeIds);
            }

            edgeIds.Add(edgeId);
        }

        private static void AddFinding(
            TopologyReport report,
            TopologySeverity severity,
            string code,
            string message,
            IEnumerable<string> nodeIds = null,
            IEnumerable<string> connectorIds = null,
            IEnumerable<string> edgeIds = null)
        {
            report.Findings.Add(new TopologyFinding
            {
                Severity = severity,
                Code = code,
                Message = message,
                NodeIds = CleanIds(nodeIds),
                ConnectorIds = CleanIds(connectorIds),
                EdgeIds = CleanIds(edgeIds)
            });
        }

        private static IList<string> CleanIds(IEnumerable<string> values)
        {
            return (values ?? Enumerable.Empty<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToList();
        }
    }
}
