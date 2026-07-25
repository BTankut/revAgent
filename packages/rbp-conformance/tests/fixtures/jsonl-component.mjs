const mode = process.argv[2] ?? "good";
if (mode === "stderr-exit") {
  await new Promise((resolve) => {
    process.stderr.write(
      "fixture startup failed\nlisten EADDRINUSE: address already in use 127.0.0.1:43123",
      resolve,
    );
  });
  process.exit(1);
}
const actions = mode === "missing-action"
  ? ["shutdown"]
  : ["ping", "fail", "stall", "release", "shutdown"];
process.stdout.write(`${JSON.stringify({
  ready: true,
  component: "fixture-test",
  controlVersion: 1,
  maxControlLineBytes: 65536,
  actions,
  ...(mode === "environment"
    ? {
        environment: {
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
          NODE_PATH: process.env.NODE_PATH ?? null,
          NODE_PRESERVE_SYMLINKS: process.env.NODE_PRESERVE_SYMLINKS ?? null,
          NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? null,
          NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
          WS_NO_BUFFER_UTIL: process.env.WS_NO_BUFFER_UTIL ?? null,
          WS_NO_UTF_8_VALIDATE: process.env.WS_NO_UTF_8_VALIDATE ?? null,
          RBP_EXPLICIT_CHILD_VALUE: process.env.RBP_EXPLICIT_CHILD_VALUE ?? null,
        },
      }
    : {}),
})}\n`);

let buffer = "";
let stalledRequest;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.action === "ping") {
      process.stderr.write(`ping:${String(request.value)}\n`);
      process.stdout.write(`${JSON.stringify({ controlVersion: 1, id: request.id, ok: true, result: { echoed: request.value, observation: "raw" } })}\n`);
    } else if (request.action === "fail") {
      process.stdout.write(`${JSON.stringify({
        controlVersion: 1,
        id: request.id,
        ok: false,
        error: { code: "planned_error", message: "planned failure" },
      })}\n`);
    } else if (request.action === "stall") {
      stalledRequest = request;
    } else if (request.action === "release") {
      if (stalledRequest === undefined) {
        process.stdout.write(`${JSON.stringify({
          controlVersion: 1,
          id: request.id,
          ok: false,
          error: { code: "nothing_stalled", message: "no stalled request" },
        })}\n`);
        continue;
      }
      const stalledResponse = `${JSON.stringify({
        controlVersion: 1,
        id: stalledRequest.id,
        ok: true,
        result: { released: stalledRequest.value },
      })}\n`;
      const releaseResponse = `${JSON.stringify({
        controlVersion: 1,
        id: request.id,
        ok: true,
        result: { releasedId: stalledRequest.id },
      })}\n`;
      process.stdout.write(mode === "out-of-order" ? releaseResponse : stalledResponse);
      process.stdout.write(mode === "out-of-order" ? stalledResponse : releaseResponse);
      stalledRequest = undefined;
    } else if (request.action === "shutdown") {
      process.stdout.write(`${JSON.stringify({ controlVersion: 1, id: request.id, ok: true, result: { stopped: true } })}\n`, () => process.exit(0));
    }
  }
});
