import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "normal";
const marker = process.argv[3] ?? null;
let stopCount = 0;

process.stdout.write(`${JSON.stringify({ ready: true, component: "fixture-test" })}\n`);

process.on("message", (message) => {
  if (message?.action !== "STOP" || typeof message.nonce !== "string") return;
  stopCount += 1;
  if (mode === "missing-ack") return;
  if (mode === "wrong-then-right") {
    process.send?.({ action: "shutdown_complete", nonce: "00000000-0000-4000-8000-000000000000", status: "closed" });
    process.send?.({ action: "shutdown_complete", nonce: message.nonce, status: "not-a-status" });
  }
  process.send?.({ action: "shutdown_complete", nonce: message.nonce, status: "closed" });
});

process.on("disconnect", () => {
  if (marker !== null) writeFileSync(marker, JSON.stringify({ stopCount }), "utf8");
  process.exitCode = 0;
});
