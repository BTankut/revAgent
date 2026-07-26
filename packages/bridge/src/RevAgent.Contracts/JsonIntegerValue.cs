#nullable enable

using System;
using System.Globalization;
using System.Numerics;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;

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
                doubleValue = Convert.ToDouble(
                    rawValue,
                    CultureInfo.InvariantCulture);
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

        public static JsonIntegerReadResult TryReadExactInt64(
            JToken? token,
            out long value)
        {
            value = default;
            if (token == null ||
                (token.Type != JTokenType.Integer &&
                 token.Type != JTokenType.Float))
            {
                return JsonIntegerReadResult.NotInteger;
            }

            StrictJsonNumberLexeme? annotation =
                token.Annotation<StrictJsonNumberLexeme>();
            if (annotation == null)
            {
                // Programmatically-created integer tokens are exact. A
                // programmatically-created floating token has no wire lexeme
                // and therefore cannot prove a closed-schema integer.
                return token.Type == JTokenType.Integer
                    ? TryReadInt64(token, out value)
                    : JsonIntegerReadResult.NotInteger;
            }

            return TryParseExactInt64(annotation.Text, out value);
        }

        private static JsonIntegerReadResult TryParseExactInt64(
            string lexeme,
            out long value)
        {
            value = default;
            int index = 0;
            bool negative = lexeme[index] == '-';
            if (negative)
            {
                index++;
            }

            int exponentMarker = lexeme.IndexOfAny(
                new[] { 'e', 'E' },
                index);
            int mantissaEnd = exponentMarker < 0
                ? lexeme.Length
                : exponentMarker;
            int decimalPoint = lexeme.IndexOf('.', index, mantissaEnd - index);
            int fractionalDigits = decimalPoint < 0
                ? 0
                : mantissaEnd - decimalPoint - 1;
            string digits = decimalPoint < 0
                ? lexeme.Substring(index, mantissaEnd - index)
                : lexeme.Substring(index, decimalPoint - index) +
                  lexeme.Substring(
                      decimalPoint + 1,
                      mantissaEnd - decimalPoint - 1);
            digits = digits.TrimStart('0');
            if (digits.Length == 0)
            {
                value = 0;
                return JsonIntegerReadResult.Success;
            }

            long exponent = exponentMarker < 0
                ? 0
                : ParseSaturatedExponent(
                    lexeme,
                    exponentMarker + 1);
            long scale = exponent - fractionalDigits;
            if (scale < 0)
            {
                long requiredTrailingZeros = -scale;
                if (requiredTrailingZeros > digits.Length)
                {
                    return JsonIntegerReadResult.NotInteger;
                }

                int retainedLength =
                    digits.Length - checked((int)requiredTrailingZeros);
                for (int suffixIndex = retainedLength;
                     suffixIndex < digits.Length;
                     suffixIndex++)
                {
                    if (digits[suffixIndex] != '0')
                    {
                        return JsonIntegerReadResult.NotInteger;
                    }
                }

                digits = digits.Substring(0, retainedLength).TrimStart('0');
                if (digits.Length == 0)
                {
                    value = 0;
                    return JsonIntegerReadResult.Success;
                }

                scale = 0;
            }

            if (scale > 19 ||
                digits.Length + scale > 19)
            {
                return JsonIntegerReadResult.OutsideInt64Range;
            }

            if (scale > 0)
            {
                digits += new string('0', checked((int)scale));
            }

            BigInteger exact = BigInteger.Parse(
                (negative ? "-" : string.Empty) + digits,
                NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture);
            if (exact < long.MinValue || exact > long.MaxValue)
            {
                return JsonIntegerReadResult.OutsideInt64Range;
            }

            value = (long)exact;
            return JsonIntegerReadResult.Success;
        }

        private static long ParseSaturatedExponent(
            string lexeme,
            int index)
        {
            bool negative = lexeme[index] == '-';
            if (negative || lexeme[index] == '+')
            {
                index++;
            }

            long value = 0;
            while (index < lexeme.Length)
            {
                int digit = lexeme[index] - '0';
                if (value > 1000000)
                {
                    return negative ? -1000001 : 1000001;
                }

                value = (value * 10) + digit;
                index++;
            }

            return negative ? -value : value;
        }
    }
}
