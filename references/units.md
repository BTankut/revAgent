# Unit Conversions

Use `UnitTypeId`. `DisplayUnitType` is removed/unreliable in the dynamic
compiler.

```csharp
double mm  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Millimeters);
double m   = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Meters);
double m3h = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.CubicMetersPerHour);
double lps = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.LitersPerSecond);
double ms  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.MetersPerSecond);
double pam = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.PascalsPerMeter);
double pa  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Pascals);

double ft = UnitUtils.ConvertToInternalUnits(200.0, UnitTypeId.Millimeters);
```
