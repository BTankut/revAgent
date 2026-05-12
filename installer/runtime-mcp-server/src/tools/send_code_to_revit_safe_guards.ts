// @ts-nocheck
const WRITE_PATTERNS = [
    { name: "Parameter.Set", pattern: /\.Set\s*\(/i },
    { name: "Parameter.SetValueString", pattern: /\.SetValueString\s*\(/i },
    { name: "Parameter.ClearValue", pattern: /\.ClearValue\s*\(/i },
    { name: "Document.Delete", pattern: /\.\s*Delete\s*\(/i },
    { name: "ElementTransformUtils", pattern: /ElementTransformUtils/i },
    { name: "Location.Move", pattern: /\.Move\s*\(/i },
    { name: "Element.ChangeTypeId", pattern: /\.ChangeTypeId\s*\(/i },
    { name: "Connector.ConnectTo", pattern: /\.ConnectTo\s*\(/i },
    { name: "Connector.DisconnectFrom", pattern: /\.DisconnectFrom\s*\(/i },
    { name: "FamilySymbol.Activate", pattern: /\.Activate\s*\(/i },
    { name: "NewFamilyInstance", pattern: /NewFamilyInstance/i },
    { name: "Create API", pattern: /\.(Create|New[A-Z]\w*)\s*\(/ },
    { name: "View visibility/overrides", pattern: /\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i },
    { name: "Geometry join/cut", pattern: /(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i },
    { name: "Parameter binding edit", pattern: /\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i },
    { name: "Revit property assignment", pattern: /\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i },
    { name: "Manual Transaction", pattern: /new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i },
];

export function findWritePatterns(code) {
    return WRITE_PATTERNS
        .filter((entry) => entry.pattern.test(code))
        .map((entry) => entry.name);
}
