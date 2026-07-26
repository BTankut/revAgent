import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RevitClientConnection,
} from "../../../installer/runtime-mcp-server/build/utils/SocketClient.js";
import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  encodeJsonFrame,
} from "../../addin-loopback-fixture/dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..", "..");
const outputArgumentIndex = process.argv.indexOf("--output-directory");
if (
  outputArgumentIndex >= 0
  && (
    outputArgumentIndex + 1 >= process.argv.length
    || process.argv[outputArgumentIndex + 1].startsWith("--")
  )
) {
  throw new Error("--output-directory requires a value.");
}
const outputDirectory = outputArgumentIndex >= 0
  ? resolve(process.argv[outputArgumentIndex + 1])
  : resolve(scriptDirectory, "framing");

const referencePaths = [
  "installer/runtime-mcp-server/src/utils/SocketClient.ts",
  "installer/runtime-mcp-server/build/utils/SocketClient.js",
  "packages/addin-loopback-fixture/src/framing.ts",
  "packages/addin-loopback-fixture/dist/framing.js",
];
const referenceBlobs = Object.fromEntries(
  referencePaths.map((path) => [
    path,
    execFileSync(
      "git",
      ["-C", repositoryRoot, "hash-object", "--", path],
      { encoding: "utf8" },
    ).trim(),
  ]),
);

const request = {
  jsonrpc: "2.0",
  id: "frame-utf8",
  method: "echo",
  params: { text: "\u011f" },
};
const response = {
  jsonrpc: "2.0",
  id: "frame-response",
  result: { resultContractVersion: 2, ok: true },
};

const nodeClient = new RevitClientConnection("127.0.0.1", 1, {
  logErrors: false,
});
nodeClient.socket.destroy();
let requestFrame = null;
nodeClient.socket = {
  write(bytes) {
    if (requestFrame !== null) {
      throw new Error("Node client emitted more than one request frame.");
    }
    requestFrame = Buffer.from(bytes);
    return true;
  },
};
nodeClient.writeCommand(request, "length-prefixed");
if (requestFrame === null) {
  throw new Error("Node client did not emit a request frame.");
}

const responseFrame = encodeJsonFrame(
  response,
  MAX_RESPONSE_PAYLOAD_BYTES,
);
const coalesced = Buffer.concat([requestFrame, responseFrame]);
const provenance = {
  schemaVersion: 1,
  nodeRequestProducer: {
    sourcePath: "installer/runtime-mcp-server/src/utils/SocketClient.ts",
    sourceBlob: referenceBlobs[
      "installer/runtime-mcp-server/src/utils/SocketClient.ts"
    ],
    executablePath: "installer/runtime-mcp-server/build/utils/SocketClient.js",
    executableBlob: referenceBlobs[
      "installer/runtime-mcp-server/build/utils/SocketClient.js"
    ],
    entryPoint: "RevitClientConnection.writeCommand",
  },
  addinResponseProducer: {
    sourcePath: "packages/addin-loopback-fixture/src/framing.ts",
    sourceBlob: referenceBlobs[
      "packages/addin-loopback-fixture/src/framing.ts"
    ],
    executablePath: "packages/addin-loopback-fixture/dist/framing.js",
    executableBlob: referenceBlobs[
      "packages/addin-loopback-fixture/dist/framing.js"
    ],
    entryPoint: "encodeJsonFrame",
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "node-client-utf8-request.bin"), requestFrame),
  writeFile(resolve(outputDirectory, "addin-success-response.bin"), responseFrame),
  writeFile(resolve(outputDirectory, "coalesced-two-frames.bin"), coalesced),
  writeFile(
    resolve(outputDirectory, "reference-output.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  ),
]);

process.stdout.write(
  `${JSON.stringify({
    success: true,
    requestBytes: requestFrame.byteLength,
    responseBytes: responseFrame.byteLength,
    coalescedBytes: coalesced.byteLength,
    outputDirectory,
  })}\n`,
);
