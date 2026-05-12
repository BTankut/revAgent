import assert from "node:assert/strict";
import net from "node:net";
import { RevitClientConnection } from "../build/utils/SocketClient.js";

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function withServer(handler, test) {
  const server = net.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await test(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function connectClient(port) {
  const client = new RevitClientConnection("127.0.0.1", port, { logErrors: false });
  return client;
}

async function testLengthPrefixedRequestAndResponse() {
  await withServer((socket) => {
    socket.once("data", (data) => {
      const length = data.readUInt32BE(0);
      const request = JSON.parse(data.subarray(4, 4 + length).toString("utf8"));
      assert.equal(request.method, "mcp_status");
      assert.equal(length, data.length - 4);
      socket.write(encodeFrame({
        jsonrpc: "2.0",
        id: request.id,
        result: { activeTask: null, framed: true },
      }));
    });
  }, async (port) => {
    const client = await connectClient(port);
    try {
      const result = await client.sendCommand("mcp_status", {}, { timeoutMs: 1000 });
      assert.deepEqual(result, { activeTask: null, framed: true });
    } finally {
      client.disconnect();
    }
  });
}

async function testLegacyFallback() {
  await withServer((socket) => {
    let call = 0;
    socket.on("data", (data) => {
      call++;
      if (call === 1) {
        assert.notEqual(data[0], 0x7b);
        socket.write(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" },
        }));
        return;
      }

      assert.equal(data[0], 0x7b);
      const request = JSON.parse(data.toString("utf8"));
      socket.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { activeTask: null, legacyFallback: true },
      }));
    });
  }, async (port) => {
    const client = await connectClient(port);
    try {
      const result = await client.sendCommand("mcp_status", {}, { timeoutMs: 1000 });
      assert.deepEqual(result, { activeTask: null, legacyFallback: true });
    } finally {
      client.disconnect();
    }
  });
}

async function testNullIdErrorSurfaces() {
  await withServer((socket) => {
    socket.once("data", () => {
      socket.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON" },
      }));
    });
  }, async (port) => {
    const client = await connectClient(port);
    try {
      await assert.rejects(
        () => client.sendCommand("mcp_status", {}, {
          allowLegacyFallback: false,
          framing: "legacy",
          timeoutMs: 1000,
        }),
        /Invalid JSON/
      );
    } finally {
      client.disconnect();
    }
  });
}

await testLengthPrefixedRequestAndResponse();
await testLegacyFallback();
await testNullIdErrorSurfaces();

console.log("socket client framing tests passed");
