#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AGENT_EVIDENCE_ASSEMBLY_SCHEMA,
  AGENT_EVAL_TRIGGER_MARKER,
  AGENT_EVAL_CASE_MARKER,
  PUBLIC_HANDLER_INVOCATION_SCHEMA,
  assembleAgentEvalEvidence,
  buildPublicHandlerCollectorExecSource,
  canonicalJson,
  phase1bEvalCaseSha256,
  phase1bEvalCasePayload,
  requiredPhase1bAgentEvals,
  resolveExternalArtifactPath,
  validateAgentEvalEvidenceFile,
} from "../installer/runtime-mcp-server/scripts/spatial-phase1b-agent-evidence-contract.mjs";
import { computeRuntimeBuildTreeSha256 } from "../installer/runtime-mcp-server/scripts/spatial-phase1b-runtime-build-hash.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptRoot, "..");
const defaultEvalContractPath = path.join(repoRoot, "evals", "evals.json");
const defaultRuntimePackagePath = path.join(repoRoot, "installer", "runtime-mcp-server", "package.json");

function usage() {
  return `Usage:
  node scripts/spatial-phase1b-agent-evidence.mjs prepare --eval-id <id> --fixture <fixture.rvt> --database <acceptance.db> --args <request.json> --output <task-spec.json>
  node scripts/spatial-phase1b-agent-evidence.mjs assemble --manifest <assembly.json> --output <evidence.json>
  node scripts/spatial-phase1b-agent-evidence.mjs validate --evidence <evidence.json> --fixture <fixture.rvt> --database <acceptance.db> [--eval-contract <evals.json>] [--runtime-package <package.json>]

assemble manifest schema:
  ${AGENT_EVIDENCE_ASSEMBLY_SCHEMA}

All transcripts, traces, manifests, evidence, and fixture files must be absolute
local paths outside the Git repository. The assembler derives provider, model,
agent run id, turn id, agent path, final response, and completion state directly
from a completed Codex Desktop subagent JSONL turn. It never accepts pass or
actualAgentRun booleans.`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag || "<end>"}.`);
    values[flag.slice(2)] = value;
  }
  return { command, values };
}

function requireAbsoluteExternalPath(value, label, mustExist) {
  return resolveExternalArtifactPath(value, repoRoot, label, mustExist);
}

function requireRepoFile(value, fallback, label) {
  const resolved = fs.realpathSync.native(path.resolve(value || fallback));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} was not found: ${resolved}`);
  return resolved;
}

function writeJson(outputPath, value) {
  const parent = path.dirname(outputPath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Output directory does not exist: ${parent}`);
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "prepare") {
    const evalId = Number(values["eval-id"]);
    const fixturePath = requireAbsoluteExternalPath(values.fixture, "--fixture", true);
    const databasePath = requireAbsoluteExternalPath(values.database, "--database", true);
    const argsPath = requireAbsoluteExternalPath(values.args, "--args", true);
    const outputPath = requireAbsoluteExternalPath(values.output, "--output", false);
    const evalDocument = JSON.parse(fs.readFileSync(defaultEvalContractPath, "utf8").replace(/^\uFEFF/, ""));
    const evalEntry = requiredPhase1bAgentEvals(evalDocument).find((entry) => entry.id === evalId);
    if (!evalEntry) throw new Error(`Unknown required Phase 1b eval id ${values["eval-id"]}.`);
    const targetTools = evalEntry.required_tool_calls.filter((tool) => tool !== "get_revit_mcp_status");
    if (targetTools.length !== 1) throw new Error(`Eval ${evalId} must have exactly one non-status required tool.`);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8").replace(/^\uFEFF/, ""));
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("--args JSON must be an object.");
    if (targetTools[0] !== "compare_spatial_snapshots") {
      if ((args.target !== undefined && args.target !== "tcp")
        || (args.host !== undefined && !["localhost", "127.0.0.1"].includes(String(args.host).toLowerCase()))
        || (args.port !== undefined && Number(args.port) !== 8080)) {
        throw new Error("--args may target only tcp localhost/127.0.0.1 port 8080.");
      }
      args.target = "tcp";
      args.host = "127.0.0.1";
      args.port = 8080;
    }
    const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
    const fixtureFileSha256 = digest(fs.readFileSync(fixturePath));
    const databasePathSha256 = digest(Buffer.from(databasePath, "utf8"));
    const evalCaseSha256 = phase1bEvalCaseSha256(evalEntry);
    const invocationNonce = crypto.randomUUID();
    const traceRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "revAgent", "spatial", "phase1b", "agent-evidence");
    fs.mkdirSync(traceRoot, { recursive: true });
    const tracePath = path.join(fs.realpathSync.native(traceRoot), `eval-${evalId}-${invocationNonce}.json`);
    const invocation = {
      schemaVersion: PUBLIC_HANDLER_INVOCATION_SCHEMA,
      evalId,
      evalCase: phase1bEvalCasePayload(evalEntry),
      evalCaseSha256,
      fixturePath,
      fixtureFileSha256,
      databasePath,
      databasePathSha256,
      invocationNonce,
      tracePath,
      endpoint: { target: "tcp", host: "127.0.0.1", port: 8080 },
      tool: targetTools[0],
      args,
    };
    const marker = `${AGENT_EVAL_TRIGGER_MARKER}${canonicalJson({
      schemaVersion: "revagent.spatial.phase1b.agent-eval-task.v1",
      evalId,
      evalCaseSha256,
      fixtureFileSha256,
    })}`;
    const evalCaseLine = `${AGENT_EVAL_CASE_MARKER}${canonicalJson(phase1bEvalCasePayload(evalEntry))}`;
    const collectorExecSource = buildPublicHandlerCollectorExecSource(invocation, {
      repoRoot,
      nodeExecutable: process.execPath,
    });
    writeJson(outputPath, {
      schemaVersion: "revagent.spatial.phase1b.agent-eval-task-spec.v1",
      evalId,
      agentPath: `/root/phase1b_actual_eval_${evalId}`,
      evalCaseSha256,
      fixtureFileSha256,
      taskTrigger: `${marker}\n${evalCaseLine}\n${evalEntry.prompt}`,
      collectorExecSource,
      invocation,
    });
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  if (command === "assemble") {
    const manifestPath = requireAbsoluteExternalPath(values.manifest, "--manifest", true);
    const outputPath = requireAbsoluteExternalPath(values.output, "--output", false);
    writeJson(outputPath, assembleAgentEvalEvidence(manifestPath, { repoRoot }));
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  if (command === "validate") {
    const evidencePath = requireAbsoluteExternalPath(values.evidence, "--evidence", true);
    const fixturePath = requireAbsoluteExternalPath(values.fixture, "--fixture", true);
    const databasePath = requireAbsoluteExternalPath(values.database, "--database", true);
    const evalContractPath = requireRepoFile(values["eval-contract"], defaultEvalContractPath, "--eval-contract");
    const runtimePackagePath = requireRepoFile(values["runtime-package"], defaultRuntimePackagePath, "--runtime-package");
    const evalRaw = fs.readFileSync(evalContractPath, "utf8").replace(/^\uFEFF/, "");
    const evalDocument = JSON.parse(evalRaw);
    const runtimePackage = JSON.parse(fs.readFileSync(runtimePackagePath, "utf8").replace(/^\uFEFF/, ""));
    const runtimeReleasePath = path.join(path.dirname(runtimePackagePath), "release", "index.js");
    const { createHash } = await import("node:crypto");
    const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const summary = validateAgentEvalEvidenceFile(evidencePath, {
      repoRoot,
      evalDocument,
      requiredEvals: requiredPhase1bAgentEvals(evalDocument),
      evalContractSha256: digest(Buffer.from(evalRaw, "utf8")),
      fixturePath,
      databasePath,
      fixtureFileSha256: digest(fs.readFileSync(fixturePath)),
      runtimePackageVersion: String(runtimePackage.version || ""),
      runtimeReleaseSha256: digest(fs.readFileSync(runtimeReleasePath)),
      runtimeBuildTreeSha256: computeRuntimeBuildTreeSha256(path.dirname(runtimePackagePath)),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error(`Unsupported command ${command}.\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
