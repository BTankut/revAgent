using System;

namespace RevAgent.Contracts
{
    /// <summary>
    /// Counts Unicode code points using the same surrogate-pair semantics as
    /// JavaScript JSON Schema validators. This keeps maxLength checks aligned
    /// across the .NET bridge and the frozen schema fixtures.
    /// </summary>
    internal static class UnicodeCodePointLength
    {
        public static int Count(string value)
        {
            if (value == null)
            {
                throw new ArgumentNullException(nameof(value));
            }

            int count = 0;
            for (int index = 0; index < value.Length; index++)
            {
                if (char.IsHighSurrogate(value[index]) &&
                    index + 1 < value.Length &&
                    char.IsLowSurrogate(value[index + 1]))
                {
                    index++;
                }

                count++;
            }

            return count;
        }
    }
}
