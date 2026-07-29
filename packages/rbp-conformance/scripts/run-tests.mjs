import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const vitestCli = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);
if (!existsSync(vitestCli)) {
  throw new Error(`Vitest CLI is unavailable at the canonical workspace path: ${vitestCli}`);
}

const forwardedArguments = process.argv.slice(2);
const shardCount = 5;
const expectedFiles = 60;
const expectedTests = 373;
const fullSuite = forwardedArguments.length === 0;
const invocations = forwardedArguments.length > 0
  ? [["run", ...forwardedArguments]]
  : Array.from(
      { length: shardCount },
      (_unused, index) => [
        "run",
        "--reporter=dot",
        "--reporter=./scripts/cardinality-reporter.mjs",
        `--shard=${String(index + 1)}/${String(shardCount)}`,
      ],
    );

function cardinality(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} did not produce a cardinality report`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Number.isInteger(parsed.files) ||
    parsed.files < 0 ||
    !Number.isInteger(parsed.tests) ||
    parsed.tests < 0
  ) {
    throw new Error(`${label} produced an invalid cardinality report`);
  }
  return parsed;
}

const cardinalityRoot = fullSuite
  ? mkdtempSync(join(tmpdir(), "revagent-rbp-cardinality-"))
  : null;
let exitCode = 0;
let observedFiles = 0;
let observedTests = 0;
let observedShards = 0;
const failures = [];

try {
  for (const [index, argumentsValue] of invocations.entries()) {
    const label = argumentsValue.find((value) => value.startsWith("--shard=")) ??
      "targeted";
    const cardinalityPath = cardinalityRoot === null
      ? null
      : join(cardinalityRoot, `shard-${String(index + 1)}.json`);
    console.log(`[rbp-conformance] starting ${label}`);
    const result = spawnSync(process.execPath, [vitestCli, ...argumentsValue], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: cardinalityPath === null
        ? process.env
        : { ...process.env, REVAGENT_RBP_CARDINALITY_PATH: cardinalityPath },
      stdio: "inherit",
    });
    if (result.error !== undefined || result.status !== 0) {
      console.error(`[rbp-conformance] FAIL ${label}`);
    }
    if (result.error !== undefined) {
      console.error(`[rbp-conformance] ERROR ${label}: ${result.error.message}`);
      failures.push(`${label}: spawn error`);
      exitCode ||= 1;
      continue;
    }
    if (cardinalityPath !== null) {
      try {
        const observed = cardinality(cardinalityPath, label);
        observedFiles += observed.files;
        observedTests += observed.tests;
        observedShards += 1;
      } catch (error) {
        console.error(
          `[rbp-conformance] ERROR ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failures.push(`${label}: cardinality report error`);
        exitCode ||= 1;
      }
    }
    if (result.status !== 0) {
      failures.push(`${label}: exit ${String(result.status ?? 1)}`);
      exitCode ||= result.status ?? 1;
      continue;
    }
    console.log(`[rbp-conformance] PASS ${label}`);
  }

  if (fullSuite) {
    if (
      observedFiles !== expectedFiles ||
      observedTests !== expectedTests ||
      observedShards !== shardCount
    ) {
      console.error(
        `[rbp-conformance] cardinality mismatch: expected ${String(expectedFiles)} files / ` +
        `${String(expectedTests)} tests / ${String(shardCount)} shards; observed ` +
        `${String(observedFiles)} files / ${String(observedTests)} tests / ` +
        `${String(observedShards)} shards`,
      );
      failures.push("full suite: cardinality mismatch");
      exitCode ||= 1;
    } else {
      console.log(
        `[rbp-conformance] cardinality ${String(observedFiles)} files / ` +
        `${String(observedTests)} tests / ${String(observedShards)} shards`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(`[rbp-conformance] FAIL ${failures.join("; ")}`);
  }
} finally {
  if (cardinalityRoot !== null) {
    rmSync(cardinalityRoot, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
