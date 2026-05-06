import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithRevitCommandGate } from "./RevitCommandGate.js";

const lockFile = path.join(os.tmpdir(), `revit-mcp-command-gate-test-${process.pid}.lock`);
process.env.REVIT_MCP_COMMAND_LOCK_FILE = lockFile;
process.env.REVIT_MCP_COMMAND_GATE_WAIT_MS = "200";
process.env.REVIT_MCP_COMMAND_LOCK_POLL_MS = "10";

try {
    fs.unlinkSync(lockFile);
}
catch {}

let active = 0;
let maxActive = 0;
const run = (command) => runWithRevitCommandGate({ command }, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active -= 1;
    return command;
});

const results = await Promise.all([run("first"), run("second"), run("third")]);
assert.deepEqual(results, ["first", "second", "third"]);
assert.equal(maxActive, 1);
assert.equal(fs.existsSync(lockFile), false);

fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, command: "blocked-command" }));
await assert.rejects(
    runWithRevitCommandGate({ command: "new-command" }, async () => "never"),
    /Revit MCP is busy running blocked-command/,
);
fs.unlinkSync(lockFile);

fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, command: "dead-command" }));
const staleResult = await runWithRevitCommandGate({ command: "stale-cleared" }, async () => "stale-cleared");
assert.equal(staleResult, "stale-cleared");
assert.equal(fs.existsSync(lockFile), false);

console.log("revit command gate tests passed");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
