using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RevitMcp.MepConnectorGraph.Models;
using RevitMcp.MepConnectorGraph.Serialization;
using RevitMcp.MepConnectorGraph.Units;
using RevitMcp.MepConnectorGraph.Validation;

namespace RevitMcp.MepConnectorGraph.Tests
{
    internal static class Program
    {
        private static readonly TopologyValidator Validator = new TopologyValidator();

        private static int Main(string[] args)
        {
            try
            {
                var fixtureRoot = GetArgument(args, "--fixtures");
                if (string.IsNullOrWhiteSpace(fixtureRoot))
                {
                    fixtureRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"..\..\..\..\..\..\tests\fixtures\connector-graph"));
                }

                Run("tree fixture is calculation ready", () => TreeFixtureIsCalculationReady(fixtureRoot));
                Run("loop fixture reports a cycle", () => LoopFixtureReportsCycle(fixtureRoot));
                Run("disconnected fixture reports multiple networks", () => DisconnectedFixtureReportsMultipleNetworks(fixtureRoot));
                Run("ambiguous fixture reports ambiguous direction and missing system data", () => AmbiguousFixtureReportsFindings(fixtureRoot));
                Run("serializer is deterministic", () => SerializerIsDeterministic(fixtureRoot));
                Run("validator catches invalid edge endpoint", ValidatorCatchesInvalidEndpoint);
                Run("unit conversion preserves Revit internal assumptions", UnitConversionUsesRevitInternalUnits);

                Console.WriteLine("MepConnectorGraph tests passed.");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 1;
            }
        }

        private static void TreeFixtureIsCalculationReady(string fixtureRoot)
        {
            var report = ValidateFixture(fixtureRoot, "tree.json");
            AssertEqual(3, report.Summary.NodeCount, "node count");
            AssertEqual(4, report.Summary.ConnectorCount, "connector count");
            AssertEqual(2, report.Summary.EdgeCount, "edge count");
            AssertEqual(1, report.Summary.NetworkCount, "network count");
            AssertEqual(0, report.Summary.CycleCount, "cycle count");
            AssertEqual(0, report.Summary.AmbiguousDirectionCount, "ambiguous direction count");
            AssertEqual(0, report.Summary.MissingSystemDataCount, "missing system data count");
            AssertTrue(report.Summary.IsValidForDirectionalCalculation, "tree fixture should be calculation ready");
            AssertFalse(HasFinding(report, "open_end"), "tree fixture should not have open ends");
        }

        private static void LoopFixtureReportsCycle(string fixtureRoot)
        {
            var report = ValidateFixture(fixtureRoot, "loop.json");
            AssertEqual(1, report.Summary.NetworkCount, "network count");
            AssertEqual(1, report.Summary.CycleCount, "cycle count");
            AssertTrue(HasFinding(report, "cycle_detected"), "loop fixture should report a cycle");
        }

        private static void DisconnectedFixtureReportsMultipleNetworks(string fixtureRoot)
        {
            var report = ValidateFixture(fixtureRoot, "disconnected.json");
            AssertEqual(2, report.Summary.NetworkCount, "network count");
            AssertTrue(HasFinding(report, "multiple_networks"), "disconnected fixture should report multiple networks");
            AssertTrue(HasFinding(report, "disconnected_island"), "disconnected fixture should report an island");
            AssertTrue(HasFinding(report, "open_end"), "disconnected fixture should report open connector ends");
            AssertFalse(report.Summary.IsValidForDirectionalCalculation, "multiple networks should not be globally calculation ready");
        }

        private static void AmbiguousFixtureReportsFindings(string fixtureRoot)
        {
            var report = ValidateFixture(fixtureRoot, "ambiguous.json");
            AssertEqual(1, report.Summary.AmbiguousDirectionCount, "ambiguous direction count");
            AssertEqual(1, report.Summary.MissingSystemDataCount, "missing system data count");
            AssertTrue(HasFinding(report, "direction_ambiguous"), "ambiguous fixture should report ambiguous direction");
            AssertTrue(HasFinding(report, "missing_system_data"), "ambiguous fixture should report missing system data");
            AssertFalse(report.Summary.IsValidForDirectionalCalculation, "ambiguous fixture should not be calculation ready");
        }

        private static void SerializerIsDeterministic(string fixtureRoot)
        {
            var document = LoadFixture(fixtureRoot, "tree.json");
            document.Topology = Validator.Validate(document);

            var first = ConnectorGraphJson.Serialize(document);
            var second = ConnectorGraphJson.Serialize(ConnectorGraphJson.Deserialize(first));

            AssertEqual(first, second, "serialized graph should be stable after round trip");
            AssertTrue(first.IndexOf("\"schemaVersion\"", StringComparison.Ordinal) < first.IndexOf("\"nodes\"", StringComparison.Ordinal), "schema should be written before nodes");
            AssertTrue(first.Contains("\"direction\": \"fromTo\""), "enum values should serialize as camel case strings");
        }

        private static void ValidatorCatchesInvalidEndpoint()
        {
            var document = new ConnectorGraphDocument
            {
                Nodes = new List<ConnectorGraphNode>
                {
                    new ConnectorGraphNode
                    {
                        Id = "pipe-1",
                        SystemClassification = "DomesticColdWater",
                        SystemName = "DCW-1",
                        SystemType = "Domestic Cold Water",
                        Connectors = new List<ConnectorPort>
                        {
                            new ConnectorPort
                            {
                                Id = "pipe-1.a",
                                OwnerNodeId = "pipe-1",
                                Domain = MepConnectorDomain.Piping,
                                FlowDirection = MepConnectorFlowDirection.Out
                            }
                        }
                    }
                },
                Edges = new List<ConnectorGraphEdge>
                {
                    new ConnectorGraphEdge
                    {
                        Id = "bad-edge",
                        FromConnectorId = "pipe-1.a",
                        ToConnectorId = "missing-connector",
                        Direction = MepConnectionDirection.FromTo,
                        Kind = MepConnectionKind.Physical
                    }
                }
            };

            var report = Validator.Validate(document);
            AssertTrue(HasFinding(report, "edge_endpoint_unknown"), "validator should reject edges with unknown connectors");
            AssertFalse(report.Summary.IsStructurallyValid, "invalid endpoint should make the graph structurally invalid");
        }

        private static void UnitConversionUsesRevitInternalUnits()
        {
            AssertNear(304.8, RevitInternalUnitConverter.FeetToMillimeters(1.0), 0.000001, "feet to millimeters");
            AssertNear(28.316846592, RevitInternalUnitConverter.CubicFeetPerSecondToLitersPerSecond(1.0), 0.000001, "ft3/s to L/s");
            AssertNear(0.4719474432, RevitInternalUnitConverter.CubicFeetPerMinuteToLitersPerSecond(1.0), 0.000001, "cfm to L/s");
            AssertEqual(12.35, RevitInternalUnitConverter.Round(12.345, 2), "rounding");
        }

        private static TopologyReport ValidateFixture(string fixtureRoot, string fileName)
        {
            return Validator.Validate(LoadFixture(fixtureRoot, fileName));
        }

        private static ConnectorGraphDocument LoadFixture(string fixtureRoot, string fileName)
        {
            var path = Path.Combine(fixtureRoot, fileName);
            AssertTrue(File.Exists(path), "fixture was not found: " + path);
            return ConnectorGraphJson.LoadFromFile(path);
        }

        private static bool HasFinding(TopologyReport report, string code)
        {
            return report.Findings.Any(f => string.Equals(f.Code, code, StringComparison.Ordinal));
        }

        private static void Run(string name, Action action)
        {
            action();
            Console.WriteLine("PASS " + name);
        }

        private static string GetArgument(string[] args, string name)
        {
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[i + 1];
                }
            }

            return null;
        }

        private static void AssertTrue(bool condition, string message)
        {
            if (!condition)
            {
                throw new Exception("Assertion failed: " + message);
            }
        }

        private static void AssertFalse(bool condition, string message)
        {
            AssertTrue(!condition, message);
        }

        private static void AssertEqual<T>(T expected, T actual, string message)
        {
            if (!object.Equals(expected, actual))
            {
                throw new Exception("Assertion failed: " + message + ". Expected '" + expected + "', got '" + actual + "'.");
            }
        }

        private static void AssertNear(double expected, double actual, double tolerance, string message)
        {
            if (Math.Abs(expected - actual) > tolerance)
            {
                throw new Exception("Assertion failed: " + message + ". Expected '" + expected + "', got '" + actual + "'.");
            }
        }
    }
}
