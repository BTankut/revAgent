using Autodesk.Revit.DB;
using System;
using System.Reflection;

namespace RevitMCPCommandSet.Extensions
{
    public static class RevitApiCompatibilityExtensions
    {
        private static readonly Lazy<PropertyInfo> ElementIdValueProperty =
            new Lazy<PropertyInfo>(() => typeof(ElementId).GetProperty("Value"));

        public static int GetIdValue(this ElementId id)
        {
            if (id == null)
            {
                throw new ArgumentNullException(nameof(id));
            }

            if (ElementIdValueProperty.Value != null)
            {
                try
                {
                    return (int)ElementIdValueProperty.Value.GetValue(id);
                }
                catch
                {
                }
            }

            return id.IntegerValue;
        }
    }
}
