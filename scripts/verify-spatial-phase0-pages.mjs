#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function semanticCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Semantic spatial JSON cannot contain a non-finite number.");
    const normalized = Object.is(value, -0) ? 0 : value;
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, normalized, false);
    return JSON.stringify(`n:${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`);
  }
  if (typeof value === "string") return JSON.stringify(`s:${value}`);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${semanticCanonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function compareOrderKey(left, right) {
  const fields = ["documentKey", "linkPlacementKey", "nodeKind", "stableSourceIdentity"];
  for (const field of fields) {
    const leftValue = String(left?.[field] ?? "");
    const rightValue = String(right?.[field] ?? "");
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function parseRawResponses(rawResponses, label) {
  if (!Array.isArray(rawResponses) || rawResponses.length === 0) {
    fail(`${label} raw response list must contain at least one JSON-RPC response.`);
  }
  return rawResponses.map((rawResponse, index) => {
    if (typeof rawResponse !== "string" || rawResponse.length === 0) {
      fail(`${label} raw response ${index} is not a non-empty string.`);
    }
    const envelope = JSON.parse(rawResponse);
    if (envelope?.error) fail(`${label} raw response ${index} contains a JSON-RPC error.`);
    if (!envelope?.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
      fail(`${label} raw response ${index} has no result object.`);
    }
    return envelope.result;
  });
}

function verifyCapture(pages, label) {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail(`${label} must contain at least one extraction page.`);
  }

  let priorPageHash = null;
  let priorOrderKey = null;
  let totalPayloadBytes = 0;
  let totalRows = 0;
  let totalNodes = 0;
  let totalOmissions = 0;
  let captureId = null;
  let snapshotPayloadBytes = null;
  let snapshotPageCount = null;

  pages.forEach((result, index) => {
    const page = result?.page;
    const rows = result?.rows ?? page?.rows;
    if (!page || typeof page !== "object" || Array.isArray(page)) fail(`${label} page ${index} has no page envelope.`);
    if (!Array.isArray(rows)) fail(`${label} page ${index} has no exact hashed rows array.`);
    if (page.ordinal !== index) fail(`${label} page ordinal ${page.ordinal} is not continuous at index ${index}.`);

    captureId ??= result.captureId;
    if (result.captureId !== captureId) fail(`${label} captureId changed between pages.`);
    snapshotPayloadBytes ??= integer(result.payloadBytes, `${label} snapshot payloadBytes`);
    snapshotPageCount ??= integer(result.pageCount, `${label} snapshot pageCount`);
    if (result.payloadBytes !== snapshotPayloadBytes) fail(`${label} snapshot payloadBytes changed between pages.`);
    if (result.pageCount !== snapshotPageCount) fail(`${label} snapshot pageCount changed between pages.`);

    const hashEnvelope = {
      captureId: result.captureId,
      pageOrdinal: page.ordinal,
      priorPageHash,
      rows,
    };
    const expectedHash = sha256(semanticCanonicalJson(hashEnvelope));
    if (page.pageSha256 !== expectedHash || page.pageHash !== expectedHash) {
      fail(`${label} page ${index} hash is not reproducible from the returned rows.`);
    }
    if ((page.priorPageSha256 ?? null) !== priorPageHash || (page.priorPageHash ?? null) !== priorPageHash) {
      fail(`${label} page ${index} prior-page hash is inconsistent.`);
    }

    const pagePayloadBytes = Buffer.byteLength(semanticCanonicalJson(rows), "utf8");
    if (integer(page.payloadBytes, `${label} page ${index} payloadBytes`) !== pagePayloadBytes) {
      fail(`${label} page ${index} payloadBytes does not measure the exact canonical IEEE-754 rows array.`);
    }
    if (integer(page.rowCount, `${label} page ${index} rowCount`) !== rows.length) {
      fail(`${label} page ${index} rowCount does not match rows.length.`);
    }

    const nodes = rows.filter((row) => Object.hasOwn(row, "node")).map((row) => row.node);
    const omissions = rows.filter((row) => Object.hasOwn(row, "omission")).map((row) => row.omission);
    if (nodes.length + omissions.length !== rows.length) fail(`${label} page ${index} contains a row without exactly one node/omission payload.`);
    if (integer(page.nodeCount, `${label} page ${index} nodeCount`) !== nodes.length) fail(`${label} page ${index} nodeCount mismatch.`);
    if (integer(page.omissionCount, `${label} page ${index} omissionCount`) !== omissions.length) fail(`${label} page ${index} omissionCount mismatch.`);
    if (canonicalJson(result.nodes) !== canonicalJson(nodes)) fail(`${label} page ${index} nodes do not match its hashed rows.`);
    if (canonicalJson(result.omissions) !== canonicalJson(omissions)) fail(`${label} page ${index} omissions do not match its hashed rows.`);

    for (const [rowIndex, row] of rows.entries()) {
      const requiredOrderFields = ["documentKey", "linkPlacementKey", "nodeKind", "stableSourceIdentity"];
      if (!row?.orderKey || requiredOrderFields.some((field) => typeof row.orderKey[field] !== "string" || row.orderKey[field].length === 0)) {
        fail(`${label} page ${index} row ${rowIndex} has an invalid orderKey.`);
      }
      if (priorOrderKey && compareOrderKey(priorOrderKey, row.orderKey) >= 0) {
        fail(`${label} rows are not globally strictly ordered at page ${index}, row ${rowIndex}.`);
      }
      priorOrderKey = row.orderKey;
    }

    const hasMore = page.hasMore === true;
    const nextCursor = result.nextCursor ?? page.nextCursor ?? null;
    if (hasMore && (typeof nextCursor !== "string" || nextCursor.length === 0)) fail(`${label} page ${index} omitted its continuation cursor.`);
    if (!hasMore && nextCursor !== null && nextCursor !== "") fail(`${label} final page returned a continuation cursor.`);

    totalPayloadBytes += pagePayloadBytes;
    totalRows += rows.length;
    totalNodes += nodes.length;
    totalOmissions += omissions.length;
    priorPageHash = expectedHash;
  });

  if (snapshotPageCount !== pages.length) fail(`${label} snapshot pageCount does not match the returned page chain.`);
  if (snapshotPayloadBytes !== totalPayloadBytes) fail(`${label} snapshot payloadBytes does not equal the sum of canonical IEEE-754 page rows.`);

  return {
    pageCount: pages.length,
    rowCount: totalRows,
    nodeCount: totalNodes,
    omissionCount: totalOmissions,
    payloadBytes: totalPayloadBytes,
    terminalPageHash: priorPageHash,
  };
}

const inputPath = process.argv[2];
if (!inputPath) fail("Usage: verify-spatial-phase0-pages.mjs <local-raw-audit.json>");
const resolvedPath = path.resolve(inputPath);
const audit = JSON.parse(fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, ""));
const firstPages = Array.isArray(audit.firstCaptureRawResponses)
  ? parseRawResponses(audit.firstCaptureRawResponses, "firstCapture")
  : audit.firstCapture;
const secondPages = Array.isArray(audit.secondCaptureRawResponses)
  ? parseRawResponses(audit.secondCaptureRawResponses, "secondCapture")
  : audit.secondCapture;
const first = verifyCapture(firstPages, "firstCapture");
const second = verifyCapture(secondPages, "secondCapture");

process.stdout.write(`${JSON.stringify({ success: true, first, second })}\n`);
