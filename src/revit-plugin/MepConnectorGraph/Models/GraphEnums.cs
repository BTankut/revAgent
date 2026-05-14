namespace RevitMcp.MepConnectorGraph.Models
{
    public enum MepConnectorDomain
    {
        Unknown,
        Piping,
        Hvac,
        Electrical,
        CableTray,
        Conduit
    }

    public enum MepConnectorFlowDirection
    {
        Unknown,
        In,
        Out,
        Bidirectional
    }

    public enum MepConnectionDirection
    {
        Unknown,
        FromTo,
        ToFrom,
        Bidirectional,
        Ambiguous
    }

    public enum MepConnectionKind
    {
        Physical,
        Logical,
        Proximity,
        Synthetic
    }

    public enum TopologySeverity
    {
        Info,
        Warning,
        Error
    }
}
