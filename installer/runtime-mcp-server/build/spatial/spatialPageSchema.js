import crypto from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getRuntimeRoot, readJsonFile } from "../utils/runtimeIdentity.js";
export const SPATIAL_EXTRACTION_PAGE_SCHEMA_IDS = {
    "0.1": "https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json",
    "0.2": "https://schemas.revagent.app/spatial/v0.2/extraction-page.schema.json",
    "0.3": "https://schemas.revagent.app/spatial/v0.3/extraction-page.schema.json",
};
export const SPATIAL_EXTRACTION_PAGE_SCHEMA_ID = SPATIAL_EXTRACTION_PAGE_SCHEMA_IDS["0.3"];
export const SPATIAL_WORK_CONTINUATION_SCHEMA_IDS = {
    "0.2": "https://schemas.revagent.app/spatial/v0.2/work-continuation.schema.json",
    "0.3": "https://schemas.revagent.app/spatial/v0.3/work-continuation.schema.json",
};
export const SPATIAL_WORK_CONTINUATION_SCHEMA_ID = SPATIAL_WORK_CONTINUATION_SCHEMA_IDS["0.3"];
const baseSchemaFileNames = [
    "element-ref.schema.json",
    "node-ref.schema.json",
    "source-revision.schema.json",
    "cursor-envelope.schema.json",
    "spatial-snapshot.schema.json",
    "extraction-page.schema.json",
];
const phase1aSchemaFileNames = [
    ...baseSchemaFileNames,
    "work-cursor-envelope.schema.json",
    "work-continuation.schema.json",
];
const phase1bSchemaFileNames = [
    "profile.schema.json",
    "spatial-properties.schema.json",
    "fingerprints.schema.json",
    "topology-coverage.schema.json",
    "spatial-snapshot.schema.json",
    "extraction-page.schema.json",
    "work-continuation.schema.json",
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
function loadValidators(schemaVersion) {
    const schemaRoot = path.join(getRuntimeRoot(), "schemas", "spatial", `v${schemaVersion}`);
    const schemaFileNames = schemaVersion === "0.3"
        ? phase1bSchemaFileNames
        : schemaVersion === "0.2"
            ? phase1aSchemaFileNames
            : baseSchemaFileNames;
    const dependencySchemas = schemaVersion === "0.3"
        ? baseSchemaFileNames.map((fileName) => {
            const schema = readJsonFile(path.join(getRuntimeRoot(), "schemas", "spatial", "v0.2", fileName));
            if (!schema) {
                throw new Error(`Missing required spatial v0.2 dependency schema: ${fileName}`);
            }
            return schema;
        })
        : [];
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
    for (const schema of [...dependencySchemas, ...schemas]) {
        ajv.addSchema(schema);
    }
    const schemaId = SPATIAL_EXTRACTION_PAGE_SCHEMA_IDS[schemaVersion];
    const extractionPageValidator = ajv.getSchema(schemaId);
    if (!extractionPageValidator) {
        throw new Error(`Spatial extraction page schema was not compiled: ${schemaId}`);
    }
    const workContinuationSchemaId = schemaVersion === "0.2" || schemaVersion === "0.3"
        ? SPATIAL_WORK_CONTINUATION_SCHEMA_IDS[schemaVersion]
        : null;
    const workContinuationValidator = workContinuationSchemaId
        ? ajv.getSchema(workContinuationSchemaId)
        : null;
    if (workContinuationSchemaId && !workContinuationValidator) {
        throw new Error(`Spatial work continuation schema was not compiled: ${workContinuationSchemaId}`);
    }
    return { extractionPageValidator, workContinuationValidator };
}
const validatorBundles = {
    "0.1": loadValidators("0.1"),
    "0.2": loadValidators("0.2"),
    "0.3": loadValidators("0.3"),
};
const extractionPageValidators = {
    "0.1": validatorBundles["0.1"].extractionPageValidator,
    "0.2": validatorBundles["0.2"].extractionPageValidator,
    "0.3": validatorBundles["0.3"].extractionPageValidator,
};
const workContinuationValidators = {
    "0.2": validatorBundles["0.2"].workContinuationValidator,
    "0.3": validatorBundles["0.3"].workContinuationValidator,
};
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
function workContinuationSemanticErrors(payload) {
    const errors = [];
    const preparation = isObject(payload.preparation) ? payload.preparation : {};
    if (payload.snapshotId !== payload.captureId) {
        errors.push("/snapshotId must equal captureId for a Phase 1a work continuation");
    }
    if (preparation.nextCursor !== payload.nextCursor) {
        errors.push("/preparation/nextCursor must equal top-level nextCursor");
    }
    if (typeof preparation.total === "number" && preparation.processed > preparation.total) {
        errors.push("/preparation/processed cannot exceed preparation.total");
    }
    return errors;
}
export function validateSpatialExtractionPageContract(payload) {
    const schemaVersion = isObject(payload) && typeof payload.schemaVersion === "string"
        ? payload.schemaVersion
        : "";
    const supportedSchemaVersion = schemaVersion === "0.1" || schemaVersion === "0.2" || schemaVersion === "0.3" ? schemaVersion : null;
    const extractionPageValidator = supportedSchemaVersion
        ? extractionPageValidators[supportedSchemaVersion]
        : null;
    if (!supportedSchemaVersion || !extractionPageValidator) {
        return {
            valid: false,
            errors: [`Unsupported spatial extraction schemaVersion: ${schemaVersion || "<missing>"}`],
            schemaId: null,
        };
    }
    const validSchema = extractionPageValidator(payload);
    const errors = formatAjvErrors(extractionPageValidator.errors);
    if (validSchema && isObject(payload)) {
        errors.push(...semanticErrors(payload));
    }
    return {
        valid: errors.length === 0,
        errors,
        schemaId: SPATIAL_EXTRACTION_PAGE_SCHEMA_IDS[supportedSchemaVersion],
    };
}
export function validateSpatialWorkContinuationContract(payload) {
    const schemaVersion = isObject(payload) && typeof payload.schemaVersion === "string"
        ? payload.schemaVersion
        : "";
    const supportedSchemaVersion = schemaVersion === "0.2" || schemaVersion === "0.3" ? schemaVersion : null;
    const workContinuationValidator = supportedSchemaVersion
        ? workContinuationValidators[supportedSchemaVersion]
        : null;
    if (!workContinuationValidator || !supportedSchemaVersion) {
        return {
            valid: false,
            errors: [`Unsupported spatial work continuation schemaVersion: ${schemaVersion || "<missing>"}`],
            schemaId: null,
        };
    }
    const validSchema = workContinuationValidator(payload);
    const errors = formatAjvErrors(workContinuationValidator.errors);
    if (validSchema && isObject(payload)) {
        errors.push(...workContinuationSemanticErrors(payload));
    }
    return {
        valid: errors.length === 0,
        errors,
        schemaId: SPATIAL_WORK_CONTINUATION_SCHEMA_IDS[supportedSchemaVersion],
    };
}
