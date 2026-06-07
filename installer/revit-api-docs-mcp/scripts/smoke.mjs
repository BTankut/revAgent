import assert from "node:assert/strict";

import { compactTypeDetailsResult } from "../build/tools/get_type_details.js";
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

const compactDetails = compactTypeDetailsResult({
  type: { name: "Wall", fullName: "Autodesk.Revit.DB.Wall" },
  metadata: { namespace: "Autodesk.Revit.DB" },
  dashboardMetadata: { source: "fixture", evidence: "preserved" },
  declaredMembers: {
    constructors: [{ name: "Wall" }],
    methods: [
      { name: "Create" },
      { name: "GetTypeId" },
      { name: "get_Parameter" },
    ],
    properties: [{ name: "WallType" }, { name: "Location" }],
    fields: [],
    events: [],
  },
  inheritedMembers: [{
    declaringType: "Autodesk.Revit.DB.Element",
    members: {
      constructors: [],
      methods: [{ name: "GetParameters" }, { name: "GetOrderedParameters" }],
      properties: [{ name: "Id" }],
      fields: [],
      events: [],
    },
  }, null, "malformed"],
}, { maxMembersPerGroup: 1 });
assert.equal(compactDetails.responseMode, "compact");
assert.equal(compactDetails.dashboardMetadata.evidence, "preserved");
assert.equal(compactDetails.declaredMembers.methods.length, 1);
assert.equal(compactDetails.declaredMemberCounts.methods, 3);
assert.equal(compactDetails.declaredOmittedMemberCounts.methods, 2);
assert.equal(compactDetails.inheritedMembers.length, 1);
assert.equal(compactDetails.inheritedMembers[0].members.methods.length, 1);
assert.match(compactDetails.fullResponseHint, /response_mode="full"/);

assert.equal(compactTypeDetailsResult(null), null);

const fullDetails = compactTypeDetailsResult({
  declaredMembers: { methods: [{ name: "A" }, { name: "B" }] },
}, { responseMode: "full", maxMembersPerGroup: 1 });
assert.equal(fullDetails.responseMode, "full");
assert.equal(fullDetails.declaredMembers.methods.length, 2);

console.error("Revit API docs MCP smoke passed");
