import { describe, expect, it } from "vitest";

import {
  REAL_TRIO_FIXTURE_DOCUMENT_ID,
  hasRealTrioLiveDocumentRoute,
  realTrioFixtureDocumentContextEvent,
} from "./realTrioRuntimeFixture.js";

describe("WP-12 real-trio fixture document route gate", () => {
  it("uses the exact attested fixture document identity", () => {
    expect(realTrioFixtureDocumentContextEvent()).toMatchObject({
      activeDocumentId: REAL_TRIO_FIXTURE_DOCUMENT_ID,
      activeView: { documentId: REAL_TRIO_FIXTURE_DOCUMENT_ID },
      documents: [{ documentId: REAL_TRIO_FIXTURE_DOCUMENT_ID, isActive: true }],
    });
  });

  it("refuses missing or mismatched public route evidence before north dispatch", () => {
    expect(hasRealTrioLiveDocumentRoute({ sessions: [] })).toBe(false);
    expect(hasRealTrioLiveDocumentRoute({ sessions: [{ value: {
      lifecycle: { liveDocumentRoute: { sessionDocumentId: "different-document" } },
    } }] })).toBe(false);
    expect(hasRealTrioLiveDocumentRoute({ sessions: [{ value: {
      lifecycle: { liveDocumentRoute: { sessionDocumentId: REAL_TRIO_FIXTURE_DOCUMENT_ID } },
    } }] })).toBe(true);
  });
});
