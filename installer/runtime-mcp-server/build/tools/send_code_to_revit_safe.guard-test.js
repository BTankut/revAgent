import assert from "node:assert/strict";
import { findWritePatterns } from "./send_code_to_revit_safe_guards.js";
const cases = [
    ["Parameter.Set", "p.Set(\"x\")"],
    ["Parameter.Set", "element.LookupParameter(\"Comments\").Set(\"x\")"],
    ["Parameter.Set", "element.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(\"x\")"],
    ["Parameter.SetValueString", "p.SetValueString(\"10\")"],
    ["Parameter.ClearValue", "p.ClearValue()"],
    ["Document.Delete", "doc.Delete(id)"],
    ["ElementTransformUtils", "ElementTransformUtils.MoveElement(document, id, vector)"],
    ["Location.Move", "element.Location.Move(vector)"],
    ["Element.ChangeTypeId", "element.ChangeTypeId(typeId)"],
    ["Connector.ConnectTo", "a.ConnectTo(b)"],
    ["Connector.DisconnectFrom", "a.DisconnectFrom(b)"],
    ["FamilySymbol.Activate", "symbol.Activate()"],
    ["NewFamilyInstance", "document.Create.NewFamilyInstance(point, symbol, view)"],
    ["Create API", "document.Create.NewDuct(connectorA, connectorB, typeId)"],
    ["View visibility/overrides", "view.SetElementOverrides(id, settings)"],
    ["Geometry join/cut", "JoinGeometryUtils.JoinGeometry(document, a, b)"],
    ["Parameter binding edit", "document.ParameterBindings.Insert(definition, binding)"],
    ["Revit property assignment", "element.Pinned = true"],
    ["Manual Transaction", "using (Transaction t = new Transaction(document, \"x\")) {}"],
    ["Manual Transaction", "TransactionGroup group = new TransactionGroup(document, \"x\")"],
    ["Manual Transaction", "SubTransaction st = new SubTransaction(document)"],
];
for (const [expected, code] of cases) {
    assert(findWritePatterns(code).includes(expected), `Expected ${expected} guard for: ${code}`);
}
assert.deepEqual(findWritePatterns("FilteredElementCollector col = new FilteredElementCollector(document); return col.ToElementIds().Count;"), []);
assert.deepEqual(findWritePatterns("string viewName = view.Name; string levelName = level.Name; return viewName + levelName;"), []);
assert.deepEqual(findWritePatterns("result.Name = view.Name; summary.Scale = view.Scale; return result;"), []);
assert(findWritePatterns("view.Name = \"Renamed view\";").includes("Revit property assignment"), "Expected Revit property assignment guard for view.Name setter");
console.log(`send_code_to_revit_safe guard tests passed (${cases.length} write cases)`);
