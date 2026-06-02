import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const toolsRoot = path.join(packageRoot, "src", "tools");
const disallowedBridgeFields = new Set(["Success", "Error", "Result", "Message"]);

function listTypeScriptFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function collectDisallowedMemberAccess(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const offenders = [];

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && disallowedBridgeFields.has(node.name.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
      offenders.push({
        fileName,
        line: position.line + 1,
        column: position.character + 1,
        field: node.name.text,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenders;
}

const negativeOffenders = collectDisallowedMemberAccess(
  'const a = payload.Success; const b = payload?.Message; const c = readField(payload, "Success", "success");',
  "negative-sample.ts",
);
assert.deepEqual(
  negativeOffenders.map((offender) => offender.field),
  ["Success", "Message"],
  "Casing gate must catch PascalCase member access and ignore string-literal compatibility reads.",
);

const offenders = listTypeScriptFiles(toolsRoot).flatMap((fileName) => {
  const sourceText = fs.readFileSync(fileName, "utf8");
  return collectDisallowedMemberAccess(sourceText, fileName);
});

if (offenders.length > 0) {
  const formatted = offenders
    .map((offender) => {
      const relative = path.relative(packageRoot, offender.fileName).replaceAll(path.sep, "/");
      return `${relative}:${offender.line}:${offender.column} .${offender.field}`;
    })
    .join("\n");
  assert.fail(
    `Bridge response fields must not be read through raw PascalCase member access. ` +
      `Use readField(..., "Pascal", "camel") or normalized camelCase payloads instead.\n${formatted}`,
  );
}

console.log("casing member-access tests passed");
