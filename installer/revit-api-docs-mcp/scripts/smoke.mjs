import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

function parseTextPayload(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function assertStructuredFailure(result, action, messagePattern) {
  assert.equal(result.isError, true);
  const payload = parseTextPayload(result);
  assert.equal(payload.success, false);
  assert.equal(payload.state, "failed");
  assert.equal(payload.action, action);
  assert.match(payload.error, messagePattern);
  return payload;
}

const invalidVersionResult = await tools.get("search_api").handler({
  query: "FilteredElementCollector",
  revit_version: "2099",
  limit: 1,
});
assertStructuredFailure(invalidVersionResult, "search_api", /Revit API root not found/);

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

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "revagent-api-docs-smoke-"));
const fixtureCacheDir = path.join(fixtureRoot, "cache");
const fixtureVersion = "fixture-2022";
try {
  await fs.mkdir(fixtureCacheDir, { recursive: true });
  const assemblyPath = path.join(fixtureRoot, "RevitAPI.dll");
  const xmlPath = path.join(fixtureRoot, "RevitAPI.xml");
  await fs.writeFile(assemblyPath, "fixture assembly");
  await fs.writeFile(xmlPath, "<doc />");
  const oldTimestamp = new Date(Date.now() - 10_000);
  await fs.utimes(assemblyPath, oldTimestamp, oldTimestamp);
  await fs.utimes(xmlPath, oldTimestamp, oldTimestamp);

  const declaringType = "Autodesk.Revit.DB.BuiltInParameter";
  const fields = Array.from({ length: 250 }, (_, index) => ({
    id: `F:${declaringType}.FIXTURE_FIELD_${index}`,
    kind: "field",
    name: `FIXTURE_FIELD_${index}`,
    fullName: `${declaringType}.FIXTURE_FIELD_${index}`,
    assembly: "RevitAPI",
    namespace: "Autodesk.Revit.DB",
    declaringType,
    summary: `Fixture field ${index}`,
  }));
  const indexPayload = {
    version: fixtureVersion,
    sourceRoot: fixtureRoot,
    schemaVersion: 2,
    types: [
      {
        id: `T:${declaringType}`,
        kind: "type",
        name: "BuiltInParameter",
        fullName: declaringType,
        assembly: "RevitAPI",
        namespace: "Autodesk.Revit.DB",
        isEnum: true,
        summary: "Fixture enum with enough fields to prove response bounds.",
      },
    ],
    members: fields,
  };
  await fs.writeFile(
    path.join(fixtureCacheDir, `revit-api-docs-${fixtureVersion}.json`),
    JSON.stringify(indexPayload),
  );

  process.env.REVIT_API_DOCS_ROOT = fixtureRoot;
  process.env.REVIT_API_DOCS_CACHE_DIR = fixtureCacheDir;

  const missingTypeResult = await tools.get("get_type_details").handler({
    type_name: "DefinitelyMissingType",
    revit_version: fixtureVersion,
  });
  assertStructuredFailure(missingTypeResult, "get_type_details", /No type matched/);

  const missingMemberResult = await tools.get("get_member_details").handler({
    member_name: "DefinitelyMissingMember",
    revit_version: fixtureVersion,
  });
  assertStructuredFailure(missingMemberResult, "get_member_details", /No member matched/);

  const missingNamespaceResult = await tools.get("list_namespace").handler({
    namespace: "Definitely.Missing.Namespace",
    revit_version: fixtureVersion,
  });
  assertStructuredFailure(missingNamespaceResult, "list_namespace", /Namespace not found/);

  const emptySearchResult = await tools.get("search_api").handler({
    query: "DefinitelyMissingSearchTerm",
    revit_version: fixtureVersion,
  });
  assert.equal(emptySearchResult.isError, undefined);
  const emptySearch = parseTextPayload(emptySearchResult);
  assert.equal(emptySearch.resultCount, 0);
  assert.deepEqual(emptySearch.results, []);

  const allFailedBulkResult = await tools.get("resolve_api_symbols_bulk").handler({
    revit_version: fixtureVersion,
    symbols: [
      { mode: "type", type_name: "DefinitelyMissingType" },
      { mode: "member", member_name: "DefinitelyMissingMember" },
    ],
  });
  const allFailedBulk = assertStructuredFailure(
    allFailedBulkResult,
    "resolve_api_symbols_bulk",
    /All requested Revit API symbols failed to resolve/,
  );
  assert.equal(allFailedBulk.partial, false);
  assert.equal(allFailedBulk.totalCount, 2);
  assert.equal(allFailedBulk.succeededCount, 0);
  assert.equal(allFailedBulk.failedCount, 2);
  assert.equal(allFailedBulk.results.every((entry) => entry.ok === false), true);

  const boundedBulkResult = await tools.get("resolve_api_symbols_bulk").handler({
    revit_version: fixtureVersion,
    symbols: [
      { mode: "type", type_name: declaringType, max_members_per_group: 7 },
    ],
  });
  assert.equal(boundedBulkResult.isError, undefined);
  const boundedBulk = parseTextPayload(boundedBulkResult);
  assert.equal(boundedBulk.success, true);
  assert.equal(boundedBulk.state, "completed");
  assert.equal(boundedBulk.partial, false);
  assert.equal(boundedBulk.succeededCount, 1);
  assert.equal(boundedBulk.failedCount, 0);
  const boundedType = boundedBulk.results[0].result;
  assert.equal(boundedType.responseMode, "compact");
  assert.equal(boundedType.compactResponse, true);
  assert.equal(boundedType.maxMembersPerGroup, 7);
  assert.equal(boundedType.declaredMembers.fields.length, 7);
  assert.equal(boundedType.declaredMemberCounts.fields, 250);
  assert.equal(boundedType.declaredOmittedMemberCounts.fields, 243);

  const fullBulkResult = await tools.get("resolve_api_symbols_bulk").handler({
    revit_version: fixtureVersion,
    symbols: [
      { mode: "type", type_name: declaringType, response_mode: "full" },
    ],
  });
  const fullBulk = parseTextPayload(fullBulkResult);
  assert.equal(fullBulk.success, true);
  assert.equal(fullBulk.results[0].result.responseMode, "full");
  assert.equal(fullBulk.results[0].result.declaredMembers.fields.length, 250);

  const partialBulkResult = await tools.get("resolve_api_symbols_bulk").handler({
    revit_version: fixtureVersion,
    symbols: [
      { mode: "type", type_name: declaringType },
      { mode: "namespace", namespace: "Definitely.Missing.Namespace" },
    ],
  });
  assert.equal(partialBulkResult.isError, undefined);
  const partialBulk = parseTextPayload(partialBulkResult);
  assert.equal(partialBulk.success, false);
  assert.equal(partialBulk.state, "partial");
  assert.equal(partialBulk.partial, true);
  assert.equal(partialBulk.succeededCount, 1);
  assert.equal(partialBulk.failedCount, 1);
  assert.equal(partialBulk.results[0].result.declaredMembers.fields.length, 20);
  assert.equal(partialBulk.results[0].result.declaredMemberCounts.fields, 250);
  assert.equal(partialBulk.results[1].ok, false);

  assert.throws(() => tools.get("resolve_api_symbols_bulk").schema.symbols.parse([
    { mode: "type", type_name: declaringType, max_members_per_group: 201 },
  ]));
}
finally {
  delete process.env.REVIT_API_DOCS_ROOT;
  delete process.env.REVIT_API_DOCS_CACHE_DIR;
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

console.error("Revit API docs MCP smoke passed");
