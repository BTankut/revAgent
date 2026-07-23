import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEphemeralLoopbackTlsIdentity } from "../src/ephemeralTlsIdentity.js";

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("ephemeral loopback TLS identity", () => {
  it("creates a private IP-SAN identity with exact CA-file and leaf-DER digests", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-ephemeral-tls-"));
    try {
      const identity = createEphemeralLoopbackTlsIdentity(root);
      const caBytes = readFileSync(identity.caCertificatePath);
      const certificateBytes = readFileSync(identity.certificatePath);
      const privateKeyBytes = readFileSync(identity.privateKeyPath);
      const certificate = new X509Certificate(certificateBytes);

      expect(caBytes.equals(certificateBytes)).toBe(true);
      expect(caBytes.includes(Buffer.from("PRIVATE KEY", "ascii"))).toBe(false);
      expect(privateKeyBytes.includes(Buffer.from("PRIVATE KEY", "ascii"))).toBe(true);
      expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
      expect(identity.caCertificateSha256).toBe(sha256(caBytes));
      expect(identity.serverCertificateSha256).toBe(sha256(certificate.raw));
      expect(identity.caCertificateSha256).not.toBe(identity.serverCertificateSha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-IPv4 identity before writing certificate material", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-ephemeral-tls-invalid-"));
    try {
      expect(() => createEphemeralLoopbackTlsIdentity(root, "localhost")).toThrow(
        "requires an IPv4 literal",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
