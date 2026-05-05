import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeOfficeStandards, missingStandardsForDiscipline } from "../office-standards/defaults.js";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(toolsDir);

const officeTemplate = readJson(join(repoRoot, "docs", "revit-mep-office-standards-input-template.json"));
const criticalTemplate = readJson(join(repoRoot, "docs", "revit-mep-project-critical-data-template.json"));
const analyzeSource = readFileSync(join(toolsDir, "analyze_mep_system.js"), "utf8");

const expectedMissingStandards = [
    ...new Set([
        ...missingStandardsForDiscipline("hvac", mergeOfficeStandards()),
        ...missingStandardsForDiscipline("hydronic", mergeOfficeStandards()),
        ...missingStandardsForDiscipline("domestic_water", mergeOfficeStandards()),
        ...missingStandardsForDiscipline("sanitary", mergeOfficeStandards()),
        ...missingStandardsForDiscipline("fire", mergeOfficeStandards()),
    ]),
].sort();

assert.equal(officeTemplate.mergeTarget, "analyze_mep_system.officeStandards");
assert.deepEqual(officeTemplate.requiredMissingStandardPaths, expectedMissingStandards);
for (const path of officeTemplate.requiredMissingStandardPaths) {
    assert(hasPath(officeTemplate.officeStandards, path), `office standards template missing ${path}`);
    assert.equal(typeof officeTemplate.fieldHints[path], "string", `field hint missing for ${path}`);
}

assert.equal(criticalTemplate.mergeTarget, "analyze_mep_system arguments");
for (const key of Object.keys(criticalTemplate.analyzeMepSystemArguments)) {
    assert(analyzeSource.includes(key), `critical template argument is not exposed by analyze_mep_system: ${key}`);
    assert.notEqual(criticalTemplate.analyzeMepSystemArguments[key], null, `directly passable argument must not be null: ${key}`);
}
for (const key of Object.keys(criticalTemplate.optionalScalarArguments)) {
    assert(analyzeSource.includes(key), `optional scalar argument is not exposed by analyze_mep_system: ${key}`);
    assert.equal(criticalTemplate.optionalScalarArguments[key], null, `optional scalar placeholder should be null: ${key}`);
}
for (const key of Object.keys(criticalTemplate.requestSchemas)) {
    assert(Array.isArray(criticalTemplate.requestSchemas[key]), `request schema must be an array: ${key}`);
    assert(Array.isArray(criticalTemplate.analyzeMepSystemArguments[key]), `request schema key must be passable as an analyze argument array: ${key}`);
}
assert(Array.isArray(criticalTemplate.modelEvidenceRequired));
assert(criticalTemplate.modelEvidenceRequired.length >= 5);

console.log("handoff template tests passed");

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function findRepoRoot(startDir) {
    let current = startDir;
    while (current && current !== dirname(current)) {
        if (existsSync(join(current, "docs", "revit-mep-design-platform-full-goal.md"))) {
            return current;
        }
        current = dirname(current);
    }
    throw new Error("Unable to find repo root containing docs/revit-mep-design-platform-full-goal.md");
}

function hasPath(target, path) {
    let cursor = target;
    for (const part of path.split(".")) {
        if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
            return false;
        }
        cursor = cursor[part];
    }
    return true;
}
