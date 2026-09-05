import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";

// Build-time proof: the real entrypoint loads, packaged migrations exist, and
// an unconfigured production image refuses serving. Operational health/read
// proof requires the isolated Postgres + actual-image integration suite.
const migrations = await readdir(new URL("../migrations/", import.meta.url));
if (!migrations.includes("010_eu20_protocol_store.sql")) throw new Error("image migrations missing");
const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], {
  env: { PATH: process.env.PATH, NODE_ENV: "production", GATEWAY_BIND_HOST: "0.0.0.0", PORT: "8080", GATEWAY_PUBLIC_URL: "https://smoke.invalid" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += String(chunk); });
child.stderr.on("data", chunk => { output += String(chunk); });
const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(timer);
if (code !== 78 || !output.includes("gateway.production_startup_refused") || output.includes("gateway.startup\"")) {
  throw new Error("unconfigured production image failed to refuse serving");
}
process.stdout.write("image entrypoint refusal and migration packaging smoke passed\n");