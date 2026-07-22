const mode = process.argv[2] ?? "good";
const actions = mode === "missing-action"
  ? ["shutdown"]
  : ["ping", "fail", "stall", "release", "shutdown"];
process.stdout.write(`${JSON.stringify({
  ready: true,
  component: "fixture-test",
  controlVersion: 1,
  maxControlLineBytes: 65536,
  actions,
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
      process.stdout.write(`${JSON.stringify({ controlVersion: 1, id: request.id, ok: true, result: { echoed: request.value, passed: true } })}\n`);
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
