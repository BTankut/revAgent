import net from "node:net";
import readline from "node:readline";

const role = process.argv[2];

function write(value, callback) {
  process.stdout.write(`${JSON.stringify(value)}\n`, callback);
}

function controlLoop(actions, handle, shutdown) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.controlVersion !== 1 || typeof request.id !== "string" || !actions.includes(request.action)) {
        throw new Error("invalid control request");
      }
      const result = await handle(request);
      write({ controlVersion: 1, id: request.id, ok: true, result }, () => {
        if (request.action === "shutdown") {
          input.close();
          shutdown();
        }
      });
    } catch (error) {
      write({
        controlVersion: 1,
        id: typeof request?.id === "string" ? request.id : "invalid",
        ok: false,
        error: { code: "invalid_control", message: String(error) },
      });
    }
  });
}

if (role === "gateway") {
  write({
    event: "ready",
    component: "@revagent/gateway-stub",
    component_version: "0.0.0",
    control_contract_version: 1,
    protocol_versions: [1],
    control_auth_header: "X-RBP-Test-Control",
    shutdown_signals: ["SIGINT", "SIGTERM"],
    pid: process.pid,
    state_path: "parent-owned-test-state",
    ws_url: "ws://127.0.0.1:1/bridge/v1/ws",
    http_connection_url: "http://127.0.0.1:1/bridge/v1/http/connections",
    control_url: "http://127.0.0.1:1/__rbp_test/control",
  });
  const stop = () => process.exit(0);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else if (role === "bridge") {
  const actions = ["snapshot_evidence", "shutdown"];
  write({
    ready: true,
    component: "bridge-simulator",
    componentRole: "O1-T4",
    contract: "bridge-simulator-control/v1",
    controlVersion: 1,
    maxControlLineBytes: 65536,
    pid: process.pid,
    actions,
  });
  controlLoop(
    actions,
    async (request) => request.action === "shutdown"
      ? { stopped: true }
      : { complete: true, invocations: [], holds: [], durabilityEvents: [], sessions: [], sequences: [] },
    () => process.exit(0),
  );
} else if (role === "fixture") {
  const counts = new Map();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        const payload = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        const request = JSON.parse(payload.toString("utf8"));
        counts.set(request.id, (counts.get(request.id) ?? 0) + 1);
        const responsePayload = Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { success: true, resultContractVersion: 2, echoed: request.params ?? {} },
        }), "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(responsePayload.length);
        socket.write(Buffer.concat([header, responsePayload]));
      }
    });
  });
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const actions = ["snapshot_evidence", "shutdown"];
    write({
      ready: true,
      contract: "addin-loopback/v1",
      controlVersion: 1,
      maxControlLineBytes: 65536,
      actions,
      host: "127.0.0.1",
      port: address.port,
    });
    controlLoop(
      actions,
      async (request) => {
        if (request.action === "snapshot_evidence") {
          return {
            snapshotId: request.id,
            evidenceVersion: 1,
            fixtureContract: "addin-loopback/v1",
            observations: [],
            executionCounts: [...counts].map(([requestId, count]) => ({ requestId, count })),
            methodExecutionCounts: [],
            modelStateDigest: "sha256:mock",
            modelStateEntryCount: 0,
            pendingStalls: [],
            openSocketCount: sockets.size,
            crashed: false,
            complete: true,
            nextCursor: null,
          };
        }
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        return { stopped: true };
      },
      () => process.exit(0),
    );
  });
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  process.stderr.write("role must be gateway, bridge, or fixture\n");
  process.exit(2);
}
