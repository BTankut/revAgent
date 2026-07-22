import {
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.byteLength), body]);
}

function sequence(...parts: readonly Uint8Array[]): Buffer {
  return der(0x30, ...parts);
}

function set(...parts: readonly Uint8Array[]): Buffer {
  return der(0x31, ...parts);
}

function integer(bytes: Uint8Array): Buffer {
  let value = Buffer.from(bytes);
  while (value.byteLength > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) {
    value = value.subarray(1);
  }
  if ((value[0]! & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value]);
  return der(0x02, value);
}

function oid(value: string): Buffer {
  const arcs = value.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) {
    throw new Error(`invalid test OID: ${value}`);
  }
  const encoded: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const bytes = [arc & 0x7f];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      bytes.unshift(0x80 | (remaining & 0x7f));
    }
    encoded.push(...bytes);
  }
  return der(0x06, Buffer.from(encoded));
}

function utf8(value: string): Buffer {
  return der(0x0c, Buffer.from(value, "utf8"));
}

function generalizedTime(value: Date): Buffer {
  const text = value.toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "")
    .replace(/\.\d{3}Z$/u, "Z");
  return der(0x18, Buffer.from(text, "ascii"));
}

function boolean(value: boolean): Buffer {
  return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function octetString(value: Uint8Array): Buffer {
  return der(0x04, value);
}

function bitString(value: Uint8Array, unusedBits = 0): Buffer {
  return der(0x03, Buffer.from([unusedBits]), value);
}

function pem(label: string, value: Uint8Array): string {
  const body = Buffer.from(value).toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function extension(identifier: string, value: Uint8Array, critical = false): Buffer {
  return sequence(
    oid(identifier),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

/**
 * Generates an ephemeral loopback certificate entirely in-process. No private
 * key fixture is retained in source or on disk, keeping the TLS test portable
 * and secret-scanner safe.
 */
export function loopbackTestCertificate(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signatureAlgorithm = sequence(
    oid("1.2.840.113549.1.1.11"),
    der(0x05),
  );
  const commonName = sequence(
    set(sequence(oid("2.5.4.3"), utf8("127.0.0.1"))),
  );
  const now = Date.now();
  const validity = sequence(
    generalizedTime(new Date(now - 60 * 60 * 1000)),
    generalizedTime(new Date(now + 24 * 60 * 60 * 1000)),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  if (serial.every((byte) => byte === 0)) serial[serial.byteLength - 1] = 1;
  const extensions = sequence(
    extension("2.5.29.19", sequence(boolean(true)), true),
    extension("2.5.29.15", bitString(Buffer.from([0x84]), 2), true),
    extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))),
    extension("2.5.29.17", sequence(der(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const subjectPublicKeyInfo = publicKey.export({ type: "spki", format: "der" });
  const tbsCertificate = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    signatureAlgorithm,
    commonName,
    validity,
    commonName,
    subjectPublicKeyInfo,
    der(0xa3, extensions),
  );
  const signature = sign("RSA-SHA256", tbsCertificate, privateKey);
  const certificate = sequence(
    tbsCertificate,
    signatureAlgorithm,
    bitString(signature),
  );
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
