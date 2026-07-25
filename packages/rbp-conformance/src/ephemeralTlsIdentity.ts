import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface EphemeralTlsIdentity {
  readonly caCertificatePath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly caCertificateSha256: string;
  readonly serverCertificateSha256: string;
}

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.byteLength), body]);
}

function sequence(...parts: readonly Uint8Array[]): Buffer {
  return der(0x30, ...parts);
}

function oid(value: string): Buffer {
  const arcs = value.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) {
    throw new Error("invalid ephemeral certificate OID");
  }
  const bytes = [40 * (arcs[0] as number) + (arcs[1] as number)];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    for (let value = arc >>> 7; value > 0; value >>>= 7) {
      encoded.unshift(0x80 | (value & 0x7f));
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function pem(label: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function name(commonName: string): Buffer {
  return sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf8")))));
}

function extension(identifier: string, critical: boolean, value: Uint8Array): Buffer {
  return sequence(
    oid(identifier),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value),
  );
}

function subjectAlternativeName(hostname: string): Buffer {
  if (isIP(hostname) !== 4) {
    throw new Error("ephemeral conformance TLS identity requires an IPv4 literal");
  }
  return sequence(der(0x87, Buffer.from(hostname.split(".").map(Number))));
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Creates a process-private, self-signed loopback certificate and key. The
 * certificate doubles as the narrow test CA and leaf, so no persistent trust
 * store or committed private key is involved.
 */
export function createEphemeralLoopbackTlsIdentity(
  instanceRoot: string,
  hostname = "127.0.0.1",
): EphemeralTlsIdentity {
  const root = realpathSync(instanceRoot);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("TLS identity root must be a real directory");
  }
  const tlsRoot = path.join(root, "tls");
  mkdirSync(tlsRoot, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(tlsRoot, PRIVATE_DIRECTORY_MODE);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = sequence(oid("1.2.840.113549.1.1.11"), der(0x05));
  const distinguishedName = name(hostname);
  const extensions = sequence(
    extension("2.5.29.19", true, sequence(der(0x01, Buffer.from([0xff])))),
    extension("2.5.29.15", true, der(0x03, Buffer.from([0x02, 0x84]))),
    extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
    extension("2.5.29.17", false, subjectAlternativeName(hostname)),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([0x01])),
    algorithm,
    distinguishedName,
    sequence(
      der(0x17, Buffer.from("200101000000Z", "ascii")),
      der(0x17, Buffer.from("400101000000Z", "ascii")),
    ),
    distinguishedName,
    publicKey.export({ format: "der", type: "spki" }),
    der(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificateDer = sequence(
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const certificateBytes = Buffer.from(pem("CERTIFICATE", certificateDer), "utf8");
  const privateKeyBytes = Buffer.from(
    pem("PRIVATE KEY", privateKey.export({ format: "der", type: "pkcs8" })),
    "utf8",
  );
  const caCertificatePath = path.join(tlsRoot, "gateway-ca.pem");
  const certificatePath = path.join(tlsRoot, "gateway-leaf.pem");
  const privateKeyPath = path.join(tlsRoot, "gateway-key.pem");
  for (const [filePath, bytes] of [
    [caCertificatePath, certificateBytes],
    [certificatePath, certificateBytes],
    [privateKeyPath, privateKeyBytes],
  ] as const) {
    writeFileSync(filePath, bytes, { flag: "wx", mode: PRIVATE_FILE_MODE });
    chmodSync(filePath, PRIVATE_FILE_MODE);
  }
  const parsed = new X509Certificate(certificateBytes);
  if (!parsed.subjectAltName?.includes(`IP Address:${hostname}`)) {
    throw new Error("ephemeral certificate does not contain the required IP SAN");
  }
  return {
    caCertificatePath: realpathSync(caCertificatePath),
    certificatePath: realpathSync(certificatePath),
    privateKeyPath: realpathSync(privateKeyPath),
    caCertificateSha256: sha256(certificateBytes),
    serverCertificateSha256: sha256(parsed.raw),
  };
}
