using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

internal static class RbpJsonNumber
{
    internal static bool TryReadExactInt64(
        JsonElement value,
        out long integer)
    {
        integer = 0;
        if (value.ValueKind != JsonValueKind.Number)
        {
            return false;
        }

        ReadOnlySpan<char> raw = value.GetRawText().AsSpan();
        int index = 0;
        bool negative = false;
        if (raw.Length > 0 && raw[0] == '-')
        {
            negative = true;
            index++;
        }

        int integerStart = index;
        while (index < raw.Length && IsDigit(raw[index]))
        {
            index++;
        }

        int integerDigits = index - integerStart;
        if (integerDigits == 0)
        {
            return false;
        }

        int fractionStart = index;
        int fractionDigits = 0;
        if (index < raw.Length && raw[index] == '.')
        {
            index++;
            fractionStart = index;
            while (index < raw.Length && IsDigit(raw[index]))
            {
                index++;
            }

            fractionDigits = index - fractionStart;
            if (fractionDigits == 0)
            {
                return false;
            }
        }

        long exponent = 0;
        if (index < raw.Length &&
            (raw[index] == 'e' || raw[index] == 'E'))
        {
            index++;
            bool exponentNegative = false;
            if (index < raw.Length &&
                (raw[index] == '+' || raw[index] == '-'))
            {
                exponentNegative = raw[index] == '-';
                index++;
            }

            int exponentStart = index;
            while (index < raw.Length && IsDigit(raw[index]))
            {
                int digit = raw[index] - '0';
                exponent = exponent > 1_000_000_000
                    ? 1_000_000_001
                    : (exponent * 10) + digit;
                index++;
            }

            if (index == exponentStart)
            {
                return false;
            }

            if (exponentNegative)
            {
                exponent = -exponent;
            }
        }

        if (index != raw.Length)
        {
            return false;
        }

        int totalDigits = integerDigits + fractionDigits;
        int firstNonZero = FindFirstNonZero(
            raw,
            integerStart,
            integerDigits,
            fractionStart,
            fractionDigits);
        if (firstNonZero < 0)
        {
            integer = 0;
            return true;
        }

        long decimalPosition = AddSaturated(integerDigits, exponent);
        if (decimalPosition <= 0)
        {
            return false;
        }

        if (decimalPosition < totalDigits &&
            !AllTrailingDigitsAreZero(
                raw,
                decimalPosition,
                integerStart,
                integerDigits,
                fractionStart,
                fractionDigits))
        {
            return false;
        }

        long significantIntegerDigits = decimalPosition - firstNonZero;
        if (significantIntegerDigits is < 1 or > 19)
        {
            return false;
        }

        ulong limit = negative
            ? 9_223_372_036_854_775_808UL
            : long.MaxValue;
        ulong magnitude = 0;
        long position = firstNonZero;
        while (position < decimalPosition)
        {
            int digit = position < totalDigits
                ? DigitAt(
                    raw,
                    checked((int)position),
                    integerStart,
                    integerDigits,
                    fractionStart)
                : 0;
            if (magnitude > (limit - (uint)digit) / 10)
            {
                return false;
            }

            magnitude = (magnitude * 10) + (uint)digit;
            position++;
        }

        if (negative)
        {
            integer = magnitude == 9_223_372_036_854_775_808UL
                ? long.MinValue
                : -checked((long)magnitude);
            return true;
        }

        integer = checked((long)magnitude);
        return true;
    }

    private static bool IsDigit(char value) => value is >= '0' and <= '9';

    private static long AddSaturated(long left, long right)
    {
        if (right > 0 && left > long.MaxValue - right)
        {
            return long.MaxValue;
        }

        if (right < 0 && left < long.MinValue - right)
        {
            return long.MinValue;
        }

        return left + right;
    }

    private static int FindFirstNonZero(
        ReadOnlySpan<char> raw,
        int integerStart,
        int integerDigits,
        int fractionStart,
        int fractionDigits)
    {
        int totalDigits = integerDigits + fractionDigits;
        for (int position = 0; position < totalDigits; position++)
        {
            if (DigitAt(
                    raw,
                    position,
                    integerStart,
                    integerDigits,
                    fractionStart) != 0)
            {
                return position;
            }
        }

        return -1;
    }

    private static bool AllTrailingDigitsAreZero(
        ReadOnlySpan<char> raw,
        long start,
        int integerStart,
        int integerDigits,
        int fractionStart,
        int fractionDigits)
    {
        int totalDigits = integerDigits + fractionDigits;
        for (long position = start; position < totalDigits; position++)
        {
            if (DigitAt(
                    raw,
                    checked((int)position),
                    integerStart,
                    integerDigits,
                    fractionStart) != 0)
            {
                return false;
            }
        }

        return true;
    }

    private static int DigitAt(
        ReadOnlySpan<char> raw,
        int position,
        int integerStart,
        int integerDigits,
        int fractionStart)
    {
        char digit = position < integerDigits
            ? raw[integerStart + position]
            : raw[fractionStart + position - integerDigits];
        return digit - '0';
    }
}
