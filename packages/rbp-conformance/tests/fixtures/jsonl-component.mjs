const mode = process.argv[2] ?? "good";
const actions = mode === "missing-action" ? ["shutdown"] : ["ping", "shutdown"];
process.stdout.write(`${JSON.stringify({
  ready: true,
  component: "fixture-test",
  controlVersion: 1,
  maxControlLineBytes: 65536,
  actions,
})}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.action === "ping") {
      process.stdout.write(`${JSON.stringify({ controlVersion: 1, id: request.id, ok: true, result: { echoed: request.value, passed: true } })}\n`);
    } else if (request.action === "shutdown") {
      process.stdout.write(`${JSON.stringify({ controlVersion: 1, id: request.id, ok: true, result: { stopped: true } })}\n`, () => process.exit(0));
    }
  }
});
