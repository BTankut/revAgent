#nullable enable

using System;
using System.Globalization;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts
{
    internal enum JsonIntegerReadResult
    {
        Success,
        NotInteger,
        OutsideInt64Range,
    }

    /// <summary>
    /// Applies JSON Schema integer semantics to Newtonsoft tokens. JSON numbers
    /// with a zero fractional part are integers even when their wire form uses
    /// a decimal point or exponent.
    /// </summary>
    internal static class JsonIntegerValue
    {
        private const double Int64UpperBoundExclusive = 9223372036854775808d;

        public static JsonIntegerReadResult TryReadInt64(
            JToken? token,
            out long value)
        {
            value = 0;
            if (token == null ||
                (token.Type != JTokenType.Integer &&
                 token.Type != JTokenType.Float))
            {
                return JsonIntegerReadResult.NotInteger;
            }

            if (token.Type == JTokenType.Integer)
            {
                try
                {
                    value = token.Value<long>();
                    return JsonIntegerReadResult.Success;
                }
                catch (Exception ex) when (
                    ex is OverflowException ||
                    ex is FormatException ||
                    ex is InvalidCastException)
                {
                    return JsonIntegerReadResult.OutsideInt64Range;
                }
            }

            object? rawValue = (token as JValue)?.Value;
            if (rawValue is decimal decimalValue)
            {
                if (decimal.Truncate(decimalValue) != decimalValue)
                {
                    return JsonIntegerReadResult.NotInteger;
                }

                if (decimalValue < long.MinValue || decimalValue > long.MaxValue)
                {
                    return JsonIntegerReadResult.OutsideInt64Range;
                }

                value = decimal.ToInt64(decimalValue);
                return JsonIntegerReadResult.Success;
            }

            double doubleValue;
            try
            {
                doubleValue = Convert.ToDouble(rawValue, CultureInfo.InvariantCulture);
            }
            catch (Exception ex) when (
                ex is OverflowException ||
                ex is FormatException ||
                ex is InvalidCastException)
            {
                return JsonIntegerReadResult.OutsideInt64Range;
            }

            if (double.IsNaN(doubleValue) ||
                double.IsInfinity(doubleValue) ||
                Math.Truncate(doubleValue) != doubleValue)
            {
                return JsonIntegerReadResult.NotInteger;
            }

            if (doubleValue < long.MinValue ||
                doubleValue >= Int64UpperBoundExclusive)
            {
                return JsonIntegerReadResult.OutsideInt64Range;
            }

            value = (long)doubleValue;
            return JsonIntegerReadResult.Success;
        }
    }
}
