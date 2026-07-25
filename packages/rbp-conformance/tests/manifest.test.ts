import { readFileSync } from "node:fs";

import { RBP_SPEC_VERSION } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  BINDINGS,
  canonicalManifest,
  canonicalManifestIdentity,
  COMPONENT_IDS,
  EXPECTED_CASE_TITLES,
  validateCanonicalManifest,
} from "../src/index.js";

function specSection21Titles(): string[] {
  const spec = readFileSync(new URL("../../../docs/specs/O1-bridge-gateway-protocol.md", import.meta.url), "utf8");
  const section = spec.slice(spec.indexOf("## 21."), spec.indexOf("The required pilot stack", spec.indexOf("## 21.")));
  const titles: string[] = [];
  for (const line of section.split(/\r?\n/u)) {
    const numbered = /^(\d+)\. (.+)$/u.exec(line);
    if (numbered !== null) {
      titles[Number(numbered[1]) - 1] = numbered[2]!;
    } else if (/^ {4}\S/u.test(line) && titles.length > 0) {
      titles[titles.length - 1] = `${titles[titles.length - 1]} ${line.trim()}`;
    }
  }
  return titles.map((title) => title.replaceAll("`", "").replaceAll(/\s+/gu, " ").trim());
}

describe("canonical section 21 manifest", () => {
  it("binds the canonical v1.0 identity and retained artifact root", () => {
    expect(canonicalManifest.spec.version).toBe(RBP_SPEC_VERSION);
    expect(canonicalManifestIdentity.specVersion).toBe(RBP_SPEC_VERSION);
    expect(canonicalManifest.retainedEvidence.root).toBe(
      `artifacts/conformance/rbp-v1/${RBP_SPEC_VERSION}`,
    );
  });

  it("contains the exact forty normalized spec titles in stable order", () => {
    expect(canonicalManifest.cases).toHaveLength(40);
    expect(canonicalManifest.cases.map(({ id }) => id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `O1-C${String(index + 1).padStart(2, "0")}`),
    );
    expect(canonicalManifest.cases.map(({ title }) => title)).toEqual(specSection21Titles());
    expect(canonicalManifest.cases.map(({ title }) => title)).toEqual(EXPECTED_CASE_TITLES);
  });

  it("requires all T3/T4/T5 components and both bindings for every case", () => {
    for (const entry of canonicalManifest.cases) {
      expect(entry.requiredComponents).toEqual(COMPONENT_IDS);
      expect(entry.bindings).toEqual(BINDINGS);
      expect(entry.assertionCategories.length).toBeGreaterThan(0);
    }
  });

  it("owns the exact ordered assertion and sub-vector catalog instead of trusting run-declared names", () => {
    expect(Object.keys(canonicalManifest.requiredAssertions)).toEqual(canonicalManifest.cases.map(({ id }) => id));
    const assertions = Object.values(canonicalManifest.requiredAssertions).flat();
    expect(assertions).toHaveLength(167);
    expect(new Set(assertions.map(({ id }) => id)).size).toBe(167);
    expect(canonicalManifest.requiredAssertions["O1-C40"]!.map(({ subvectorId }) => subvectorId)).toEqual([
      "RAW_PATH_REJECTED",
      "LOCAL_PATH_NOT_EXPOSED",
      "TRAVERSAL_PATH_REJECTED",
      "REPARSE_PATH_REJECTED",
      "MULTIFILE_ARTIFACT_ID_MAPPING",
      "MULTIFILE_ARTIFACT_INDEX_MAPPING",
      "INDEPENDENT_ARTIFACT_CHUNK_STREAMS",
      "ARTIFACT_DESCRIPTOR_VERIFIED",
      "ARTIFACT_DIGEST_VERIFIED",
      "ARTIFACT_SIZE_VERIFIED",
      "ARTIFACT_RETRANSMISSION_IDENTITY",
      "INVALID_MEMBER_ALL_OR_NOTHING",
      "NO_NORTH_CLIENT_CLAIM",
    ]);
  });

  it("validates its strict schema and exposes a real digest", () => {
    expect(validateCanonicalManifest(canonicalManifest)).toEqual([]);
    expect(canonicalManifestIdentity.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalManifestIdentity.sha256).not.toBe("0".repeat(64));
  });

  it("rejects unknown manifest fields", () => {
    const mutation = { ...structuredClone(canonicalManifest), unexpected: true };
    expect(validateCanonicalManifest(mutation).map(({ code }) => code)).toContain("schema.additionalProperties");
  });

  it("rejects omission of a required multi-condition sub-vector", () => {
    const mutation = structuredClone(canonicalManifest);
    mutation.requiredAssertions["O1-C40"]!.pop();
    expect(validateCanonicalManifest(mutation).map(({ code }) => code)).toContain("manifest.assertion_count");
  });
});
