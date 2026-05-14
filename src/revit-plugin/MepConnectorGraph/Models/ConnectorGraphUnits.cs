namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class ConnectorGraphUnits
    {
        public string Length { get; set; }

        public string Area { get; set; }

        public string Volume { get; set; }

        public string Flow { get; set; }

        public string Slope { get; set; }

        public string CoordinateSystem { get; set; }

        public static ConnectorGraphUnits CreateDefaultMetric()
        {
            return new ConnectorGraphUnits
            {
                Length = "mm",
                Area = "m2",
                Volume = "m3",
                Flow = "L/s",
                Slope = "ratio",
                CoordinateSystem = "revit-internal-origin"
            };
        }
    }
}
