using System;

namespace RevitMcp.MepConnectorGraph.Units
{
    public static class RevitInternalUnitConverter
    {
        public const double MillimetersPerFoot = 304.8;
        public const double LitersPerCubicFoot = 28.316846592;

        public static double FeetToMillimeters(double feet)
        {
            return feet * MillimetersPerFoot;
        }

        public static double SquareFeetToSquareMeters(double squareFeet)
        {
            return squareFeet * 0.09290304;
        }

        public static double CubicFeetToCubicMeters(double cubicFeet)
        {
            return cubicFeet * 0.028316846592;
        }

        public static double CubicFeetPerSecondToLitersPerSecond(double cubicFeetPerSecond)
        {
            return cubicFeetPerSecond * LitersPerCubicFoot;
        }

        public static double CubicFeetPerMinuteToLitersPerSecond(double cubicFeetPerMinute)
        {
            return cubicFeetPerMinute * LitersPerCubicFoot / 60.0;
        }

        public static double Round(double value, int decimals)
        {
            return Math.Round(value, decimals, MidpointRounding.AwayFromZero);
        }
    }
}
