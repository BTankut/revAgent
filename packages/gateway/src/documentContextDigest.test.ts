import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRbpFrame } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  documentContextDigest,
  DOCUMENT_CONTEXT_DIGEST_DOMAIN,
  isDocumentContextDigest,
} from "./documentContextDigest.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bridge/tests/RevAgent.Bridge.Tests/Gateway/Connection/Fixtures/doc-context-digest.json",
);

describe("WP-12 document-context digest parity", () => {
  it("matches the shared C# RFC8785 vectors and refuses a domain mismatch", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      accepted: readonly { readonly payload: unknown; readonly canonical: string; readonly contextDigest: string; readonly wrongDomainDigest: string }[];
    };
    expect(DOCUMENT_CONTEXT_DIGEST_DOMAIN).toBe("revagent:doc-context-payload:v1\n");
    for (const vector of fixture.accepted) {
      const actual = documentContextDigest(vector.payload as never);
      expect(actual).toBe(vector.contextDigest);
      expect(actual).not.toBe(vector.wrongDomainDigest);
      expect(isDocumentContextDigest(actual)).toBe(true);
    }
  });

  it("keeps the shared C# rejection corpus outside digest admission", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      rejected: readonly { readonly name: string; readonly raw: string }[];
    };
    for (const vector of fixture.rejected) {
      if (vector.name === "duplicate-keys") {
        // The production raw-frame boundary rejects recursively before a
        // parsed last-wins object can reach documentContextDigest.
        expect(() => parseRbpFrame(Buffer.from(JSON.stringify({
          v: 1, type: "doc_context_update", id: "0197a3c2-0000-7000-8000-000000000010",
          rsid: "rs-1", seq: 1, ack: 0, ts: "2026-08-24T00:00:00.000Z",
          payload: { documents: [{ document_id: "doc-1", title: "A", path_digest: null, is_workshared: false, is_active: true }], active_document: "doc-1", active_view: null, discipline_hint: null },
        }).replace('"document_id":"doc-1"', '"document_id":"doc-1","document_id":"doc-2"'), "utf8"))).toThrow(/duplicate/i);
      } else if (vector.name === "non-finite") {
        expect(() => documentContextDigest(JSON.parse(vector.raw) as never)).toThrow(/finite/i);
      } else {
        expect(() => JSON.parse(vector.raw)).toThrow();
      }
    }
  });
});
