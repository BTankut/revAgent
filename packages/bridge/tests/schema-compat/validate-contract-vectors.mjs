import { readFile } from "node:fs/promises";

import { LoopbackContractValidator } from "../../../addin-loopback-fixture/dist/index.js";
import { parseRbpFrame } from "../../../protocol/dist/src/index.js";

const vectorUrl = new URL(
  "../../test-fixtures/mapping/contract-vectors.json",
  import.meta.url,
);
const vectors = JSON.parse(await readFile(vectorUrl, "utf8"));
if (vectors.schemaVersion !== 1) {
  throw new Error("Unsupported bridge contract-vector schema.");
}

const encoder = new TextEncoder();
const validator = new LoopbackContractValidator(16 * 1024 * 1024);
const validatedRbpNames = [];
const validatedAddinNames = [];
const rejectedRbpNames = [];

parseRbpFrame(encoder.encode(JSON.stringify(vectors.display.rbpEnvelope)));
validatedRbpNames.push("display");
parseRbpFrame(encoder.encode(JSON.stringify(vectors.displayOmitted.rbpEnvelope)));
validatedRbpNames.push("display-omitted");

for (const vector of vectors.documentContexts) {
  validator.validateResponse(
    "get_document_context",
    vector.addinResponse.id,
    vector.addinResponse,
  );
  parseRbpFrame(encoder.encode(JSON.stringify(vector.rbpEnvelope)));
  validatedAddinNames.push(vector.name);
  validatedRbpNames.push(vector.name);
}

for (const vector of vectors.negativeAddinResponses) {
  let rejected = false;
  try {
    validator.validateResponse(
      "get_document_context",
      vector.response.id,
      vector.response,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Negative add-in vector was accepted: ${vector.name}`);
  }
}

for (const vector of vectors.negativeRbpEnvelopes) {
  let rejected = false;
  try {
    parseRbpFrame(encoder.encode(JSON.stringify(vector.envelope)));
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Negative RBP envelope was accepted: ${vector.name}`);
  }
  rejectedRbpNames.push(vector.name);
}

const frozenEnvelopesUrl = new URL(
  "../../../protocol/conformance/fixtures/envelopes.json",
  import.meta.url,
);
const frozenEnvelopes = JSON.parse(await readFile(frozenEnvelopesUrl, "utf8"));
if (!frozenEnvelopes.negative.some(
  (vector) => vector.name === "batch_step_rejects_display",
)) {
  throw new Error("Frozen batch_step_rejects_display vector is missing.");
}

process.stdout.write(`${JSON.stringify({
  success: true,
  validatedRbpNames,
  validatedAddinNames,
  rejectedRbpNames,
  rejectedAddinNames: vectors.negativeAddinResponses.map((vector) => vector.name),
  batchStepRejectsDisplayPinned: true,
})}\n`);
