import assert from "node:assert/strict";

import { registerTools } from "../build/tools/register.js";
import {
  formatJsonContent,
  normalizeRevitExecutionResponse,
  truncateText,
} from "../build/utils/revitToolHelpers.js";

const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    if (typeof description === "object") {
      handler = schema;
      schema = description;
      description = "";
    }
    tools.set(name, { description, schema, handler });
  },
};

await registerTools(server);

const expectedTools = [
  "list_revit_instances",
  "get_revit_mcp_status",
  "send_code_to_revit",
  "send_code_to_revit_safe",
  "get_revit_session_context",
  "get_active_view_context",
  "list_open_views",
  "activate_view",
  "close_view",
  "get_ui_state",
  "find_elements",
  "open_existing_plan_for_element_level",
  "focus_elements",
  "section_box_elements",
  "create_3d_view_for_elements",
  "export_revit_view_image",
  "export_revit_coordination_image",
  "show_element_in_plan_and_3d",
  "smart_focus_elements",
  "inspect_elements",
  "inspect_parameter_schema",
];

assert.deepEqual([...tools.keys()], expectedTools);

const create3dDescription = tools.get("create_3d_view_for_elements").description;
const showPlan3dDescription = tools.get("show_element_in_plan_and_3d").description;
const coordinationDescription = tools.get("export_revit_coordination_image").description;
assert.match(create3dDescription, /LIVE_VIEW_NAVIGATION_PRIMITIVE/);
assert.match(showPlan3dDescription, /LIVE_VIEW_WORKFLOW_WRAPPER/);
assert.match(coordinationDescription, /VISUAL_ARTIFACT_EXPORT_ONLY/);
assert.match(coordinationDescription, /Do not use this as the primary tool for live view navigation/);

const chooseExpectedToolForIntent = (utterance) => {
  const text = utterance.toLocaleLowerCase("tr-TR");
  if (/(png|jpeg|jpg|export|çıktı|görsel|rapor|evidence)/.test(text)) {
    return "export_revit_coordination_image";
  }
  if (/(plan).*(3d)|(3d).*(plan)/.test(text)) {
    return "show_element_in_plan_and_3d";
  }
  if (/(3d|yakından|zoom|seç|göster|ekranda|aç)/.test(text)) {
    return "create_3d_view_for_elements";
  }
  return null;
};
assert.equal(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "create_3d_view_for_elements",
);
assert.notEqual(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "export_revit_coordination_image",
);
assert.equal(
  chooseExpectedToolForIntent("bu eleman için rapora PNG görsel çıktı al"),
  "export_revit_coordination_image",
);

const normalized = normalizeRevitExecutionResponse({
  result: JSON.stringify({ success: true, count: 2 }),
});
assert.equal(normalized.result.success, true);
assert.equal(normalized.result.count, 2);

const content = formatJsonContent({ success: true });
assert.equal(content.content[0].type, "text");
assert.match(content.content[0].text, /"success": true/);
assert.doesNotMatch(content.content[0].text, /"Success":/);

const successAliasContent = formatJsonContent({
  Success: true,
  nested: { success: false },
});
const successAliasPayload = JSON.parse(successAliasContent.content[0].text);
assert.equal(successAliasPayload.success, true);
assert.equal("Success" in successAliasPayload, false);
assert.equal(successAliasPayload.nested.success, false);
assert.equal("Success" in successAliasPayload.nested, false);

const trimmed = truncateText("abcdef", 3);
assert.equal(trimmed.truncated, true);
assert.match(trimmed.text, /truncated 3 chars/);

const safeTool = tools.get("send_code_to_revit_safe");
const rejection = await safeTool.handler({
  code: "document.Delete(new ElementId(1));",
  intent: "writeCommit",
});
const rejectionPayload = JSON.parse(rejection.content[0].text);
assert.equal(rejectionPayload.success, false);
assert.match(rejectionPayload.error, /does not support writeCommit/);

console.error("runtime MCP smoke passed");
