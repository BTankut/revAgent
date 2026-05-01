# FilteredElementCollector Recipes

Always append `.WhereElementIsNotElementType()`.

## Ducts

```csharp
// All ducts in document
new FilteredElementCollector(document)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType();

// Ducts in active view
new FilteredElementCollector(document, document.ActiveView.Id)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType();
```

## Pipes

```csharp
new FilteredElementCollector(document)
    .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
    .WhereElementIsNotElementType();
```

## Fittings and accessories

```csharp
// Duct fittings
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Duct accessories
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Pipe fittings
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_PipeFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Pipe accessories
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_PipeAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();
```

## Terminals and equipment

```csharp
// Sprinkler heads
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_Sprinklers)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Air terminals (diffusers, grilles)
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctTerminal)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Mechanical equipment (AHUs, fans, FCUs)
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();
```
