import assert from "node:assert/strict";

import { registerTools } from "../build/tools/register.js";

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
  "search_api",
  "get_type_details",
  "get_member_details",
  "list_namespace",
  "resolve_api_symbols_bulk",
];

assert.deepEqual([...tools.keys()], expectedTools);

const result = await tools.get("search_api").handler({
  query: "FilteredElementCollector",
  revit_version: "2099",
  limit: 1,
});
assert.equal(result.content[0].type, "text");
assert.match(result.content[0].text, /search_api failed:/);

console.error("Revit API docs MCP smoke passed");
