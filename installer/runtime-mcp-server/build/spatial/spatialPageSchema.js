import crypto from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getRuntimeRoot, readJsonFile } from "../utils/runtimeIdentity.js";
export const SPATIAL_EXTRACTION_PAGE_SCHEMA_ID = "https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json";
const schemaFileNames = [
    "element-ref.schema.json",
    "node-ref.schema.json",
    "source-revision.schema.json",
    "cursor-envelope.schema.json",
    "spatial-snapshot.schema.json",
    "extraction-page.schema.json",
];
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function canonicalJson(value) {
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Spatial canonical JSON rejects non-finite numbers.");
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (isObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
function semanticCanonicalJson(value) {
    if (value === null) {
        return "null";
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("Semantic spatial JSON cannot contain a non-finite number.");
        }
        const normalized = Object.is(value, -0) ? 0 : value;
        const bytes = new ArrayBuffer(8);
        const view = new DataView(bytes);
        view.setFloat64(0, normalized, false);
        return JSON.stringify(`n:${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`);
    }
    if (typeof value === "string") {
        return JSON.stringify(`s:${value}`);
    }
    if (typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(semanticCanonicalJson).join(",")}]`;
    }
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${semanticCanonicalJson(value[key])}`)
        .join(",")}}`;
}
function sha256SemanticCanonical(value) {
    return `sha256:${crypto.createHash("sha256").update(semanticCanonicalJson(value), "utf8").digest("hex")}`;
}
function loadValidator() {
    const schemaRoot = path.join(getRuntimeRoot(), "schemas", "spatial", "v0.1");
    const schemas = schemaFileNames.map((fileName) => {
        const schema = readJsonFile(path.join(schemaRoot, fileName));
        if (!schema) {
            throw new Error(`Missing required spatial schema: ${fileName}`);
        }
        return schema;
    });
    const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        strictRequired: false,
        allowUnionTypes: true,
    });
    addFormats(ajv);
    for (const schema of schemas) {
        ajv.addSchema(schema);
    }
    const validator = ajv.getSchema(SPATIAL_EXTRACTION_PAGE_SCHEMA_ID);
    if (!validator) {
        throw new Error(`Spatial extraction page schema was not compiled: ${SPATIAL_EXTRACTION_PAGE_SCHEMA_ID}`);
    }
    return validator;
}
const extractionPageValidator = loadValidator();
function formatAjvErrors(errors) {
    return (errors || []).slice(0, 100).map((error) => {
        const pathText = error.instancePath || "/";
        const detail = error.keyword === "additionalProperties" && error.params?.additionalProperty
            ? ` unexpected property ${String(error.params.additionalProperty)}`
            : "";
        return `${pathText} ${String(error.message || error.keyword)}${detail}`.trim();
    });
}
function semanticErrors(payload) {
    const errors = [];
    const page = isObject(payload.page) ? payload.page : {};
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const omissions = Array.isArray(payload.omissions) ? payload.omissions : [];
    if (payload.snapshotId !== payload.captureId) {
        errors.push("/snapshotId must equal captureId for the Phase 0 native page");
    }
    if (page.recordCount !== undefined && page.recordCount !== nodes.length) {
        errors.push("/page/recordCount must equal nodes.length");
    }
    if (page.nodeCount !== undefined && page.nodeCount !== nodes.length) {
        errors.push("/page/nodeCount must equal nodes.length");
    }
    if (page.omissionCount !== omissions.length) {
        errors.push("/page/omissionCount must equal omissions.length");
    }
    if (page.rowCount !== undefined && page.rowCount !== nodes.length + omissions.length) {
        errors.push("/page/rowCount must equal nodes.length + omissions.length");
    }
    if (page.pageHash !== page.pageSha256) {
        errors.push("/page/pageHash must equal pageSha256");
    }
    if (page.priorPageHash !== page.priorPageSha256) {
        errors.push("/page/priorPageHash must equal priorPageSha256");
    }
    if (page.nextCursor !== payload.nextCursor) {
        errors.push("/page/nextCursor must equal top-level nextCursor");
    }
    if (page.ordinal === 0 && page.priorPageHash !== null) {
        errors.push("/page/priorPageHash must be null on page 0");
    }
    if (page.ordinal > 0 && typeof page.priorPageHash !== "string") {
        errors.push("/page/priorPageHash is required after page 0");
    }
    if (payload.pageCount < page.ordinal + 1) {
        errors.push("/pageCount cannot be smaller than page.ordinal + 1");
    }
    if (isObject(payload.coverage)) {
        if (payload.coverage.pageNodeCount !== nodes.length) {
            errors.push("/coverage/pageNodeCount must equal nodes.length");
        }
        if (payload.coverage.pageOmissionCount !== omissions.length) {
            errors.push("/coverage/pageOmissionCount must equal omissions.length");
        }
        const sourceRevisions = Array.isArray(payload.sourceRevisions) ? payload.sourceRevisions : [];
        if (payload.coverage.sourceCount !== sourceRevisions.length) {
            errors.push("/coverage/sourceCount must equal sourceRevisions.length");
        }
        if (isObject(payload.effectiveSourcePolicy)
            && payload.coverage.effectiveScope !== payload.effectiveSourcePolicy.hasEffectiveExtractionPolicy) {
            errors.push("/coverage/effectiveScope must equal effectiveSourcePolicy.hasEffectiveExtractionPolicy");
        }
    }
    if (isObject(payload.effectiveSourcePolicy)) {
        const effectiveSources = Array.isArray(payload.effectiveSourcePolicy.effectiveSources)
            ? payload.effectiveSourcePolicy.effectiveSources
            : [];
        if (payload.effectiveSourcePolicy.effectiveSourceCount !== effectiveSources.length) {
            errors.push("/effectiveSourcePolicy/effectiveSourceCount must equal effectiveSources.length");
        }
    }
    const rows = Array.isArray(page.rows) ? page.rows : null;
    if (rows) {
        const rowNodes = rows.filter((row) => isObject(row) && row.node !== undefined).map((row) => row.node);
        const rowOmissions = rows.filter((row) => isObject(row) && row.omission !== undefined).map((row) => row.omission);
        if (rows.length !== nodes.length + omissions.length) {
            errors.push("/page/rows length must equal nodes.length + omissions.length");
        }
        if (canonicalJson(rowNodes) !== canonicalJson(nodes)) {
            errors.push("/page/rows node records must exactly reproduce top-level nodes");
        }
        if (canonicalJson(rowOmissions) !== canonicalJson(omissions)) {
            errors.push("/page/rows omission records must exactly reproduce top-level omissions");
        }
        const rowBytes = Buffer.byteLength(semanticCanonicalJson(rows), "utf8");
        if (page.payloadBytes !== rowBytes) {
            errors.push("/page/payloadBytes must equal UTF-8 canonical IEEE-754 page.rows bytes");
        }
        const expectedHash = sha256SemanticCanonical({
            captureId: payload.captureId,
            pageOrdinal: page.ordinal,
            priorPageHash: page.priorPageHash,
            rows,
        });
        if (page.pageHash !== expectedHash) {
            errors.push("/page/pageHash must equal the canonical extraction-row envelope hash");
        }
    }
    return errors;
}
export function validateSpatialExtractionPageContract(payload) {
    const validSchema = extractionPageValidator(payload);
    const errors = formatAjvErrors(extractionPageValidator.errors);
    if (validSchema && isObject(payload)) {
        errors.push(...semanticErrors(payload));
    }
    return {
        valid: errors.length === 0,
        errors,
        schemaId: SPATIAL_EXTRACTION_PAGE_SCHEMA_ID,
    };
}
