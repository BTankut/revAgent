import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function filesRecursively(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) output.push(candidate);
      else throw new Error(`Runtime build tree contains an unsupported filesystem entry: ${candidate}`);
    }
  };
  visit(root);
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

function readStableFile(filePath) {
  const before = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error(`Runtime build input changed while hashing: ${filePath}`);
  }
  return bytes;
}

export function computeRuntimeBuildTreeSha256(runtimeRoot) {
  const absoluteRuntimeRoot = fs.realpathSync.native(path.resolve(runtimeRoot));
  const root = fs.realpathSync.native(path.join(absoluteRuntimeRoot, "build"));
  const entries = filesRecursively(root).map((filePath) => {
    const bytes = readStableFile(filePath);
    return {
      path: path.relative(root, filePath).replaceAll("\\", "/"),
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  });
  for (const relativePath of ["package.json", "package-lock.json", "release/index.js"]) {
    const filePath = path.join(absoluteRuntimeRoot, relativePath);
    const bytes = readStableFile(filePath);
    entries.push({
      path: `@runtime/${relativePath}`,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (entries.length === 0) throw new Error("Runtime build tree is empty.");
  return sha256(Buffer.from(JSON.stringify(canonicalValue(entries)), "utf8"));
}
