namespace RevitMcp.MepConnectorGraph.Models
{
    public sealed class EngineeringData
    {
        public double? LengthMm { get; set; }

        public double? DiameterMm { get; set; }

        public double? WidthMm { get; set; }

        public double? HeightMm { get; set; }

        public double? Slope { get; set; }

        public double? FlowLps { get; set; }

        public double? FixtureUnits { get; set; }

        public string Material { get; set; }

        public string Insulation { get; set; }
    }
}
