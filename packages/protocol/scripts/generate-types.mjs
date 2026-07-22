import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(packageRoot, "schemas/rbp/v1/envelope.schema.json");
const outputPath = resolve(packageRoot, "src/generated/envelope.ts");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const source = await compile(schema, "RbpEnvelope", {
  bannerComment: "/* Generated from schemas/rbp/v1/envelope.schema.json. Do not edit directly. */",
  style: {
    singleQuote: false,
    semi: true,
    tabWidth: 2,
    trailingComma: "all",
  },
});

await writeFile(outputPath, source, "utf8");
