import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertDistinctFinalExecutionPlanFiles,
  assertFinalExecutionPlanIdentities,
  assertFinalSoakReportMode,
  assertNoPreexistingFinalEvidence,
  assertPlansShareExactCandidate,
  runFinalEvidenceAsyncCli,
  runPrepareProductionAsyncCli,
  runSoakAsyncCli,
} from "../src/cli.js";
import { canonicalManifest } from "../src/manifest.js";
import {
  assertProductionExecutionPlanCurrent,
  canonicalProductionComponentVersion,
  productionComponentLaunchConfigs,
} from "../src/productionExecutionPlan.js";
import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
} from "../src/types.js";
import {
  attachCurrentProductionToolchainProvenance,
  createPlan,
} from "./helpers.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");
let copiedCliRoot = "";

function materializeAllowedFinalPlanFiles(
  root: string,
): [string, string, string, string] {
  const planRoot = path.join(
    root,
    canonicalManifest.retainedEvidence.root,
    "plans",
    "candidate",
  );
  mkdirSync(planRoot, { recursive: true });
  return ([1, 2, 3, 4] as const).map((index) => {
    const planFile = path.join(planRoot, `plan-${String(index)}.json`);
    writeFileSync(planFile, `{"plan":${String(index)}}\n`, "utf8");
    return planFile;
  }) as [string, string, string, string];
}

function compileCurrentController(): string {
  const protocolBuild = spawnSync(process.execPath, [
    path.join(repoRoot, "node_modules/typescript/lib/tsc.js"),
    "-p",
    path.join(repoRoot, "packages/protocol/tsconfig.json"),
    "--pretty",
    "false",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    env: sanitizedProductionRuntimeEnvironment(),
    timeout: 60_000,
    windowsHide: true,
  });
  if (protocolBuild.error !== undefined) throw protocolBuild.error;
  if (protocolBuild.status !== 0) {
    throw new Error(String(protocolBuild.stderr).trim());
  }
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "node_modules/typescript/lib/tsc.js"),
    "-p",
    path.join(packageRoot, "tsconfig.json"),
    "--pretty",
    "false",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    env: sanitizedProductionRuntimeEnvironment(),
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`controller compilation failed: ${String(result.stderr).trim()}`);
  }
  return path.join(packageRoot, "dist/src/cli.js");
}

beforeAll(() => {
  const compiledCli = compileCurrentController();
  expect(existsSync(compiledCli)).toBe(true);
  copiedCliRoot = mkdtempSync(path.join(packageRoot, ".copied-cli-"));
  cpSync(path.join(packageRoot, "dist"), path.join(copiedCliRoot, "dist"), {
    recursive: true,
  });
  cpSync(
    path.join(packageRoot, "scripts"),
    path.join(copiedCliRoot, "scripts"),
    { recursive: true },
  );
  copyFileSync(
    path.join(packageRoot, "package.json"),
    path.join(copiedCliRoot, "package.json"),
  );
});

afterAll(() => {
  if (copiedCliRoot !== "") {
    rmSync(copiedCliRoot, { recursive: true, force: true });
  }
});

describe("final production CLI hardening", () => {
  it("rejects a copied compiled CLI without the trusted launcher handoff", () => {
    const copiedCli = path.join(copiedCliRoot, "dist/src/cli.js");
    const result = spawnSync(process.execPath, [
      copiedCli,
      "validate-run",
      path.join(copiedCliRoot, "missing-report.json"),
      "--plan",
      path.join(copiedCliRoot, "missing-plan.json"),
      "--repo-root",
      repoRoot,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      env: sanitizedProductionRuntimeEnvironment(),
      timeout: 30_000,
      windowsHide: true,
    });

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(
      /require the tracked external PowerShell launcher/u,
    );
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("requires an absolute exact Git handoff before canonical preparation", async () => {
    await expect(
      runPrepareProductionAsyncCli([
        "prepare-production",
        "plan.json",
        "--run-id",
        "git-path-test",
        "--sequence",
        "1",
        "--git-executable",
        "git",
      ], repoRoot),
    ).rejects.toThrow(/--git-executable requires an absolute path/u);
  });

  it("requires exactly one Git executable handoff", async () => {
    await expect(
      runPrepareProductionAsyncCli([
        "prepare-production",
        "plan.json",
        "--run-id",
        "duplicate-git-path-test",
        "--sequence",
        "1",
        "--git-executable",
        process.execPath,
        "--git-executable",
        process.execPath,
      ], repoRoot),
    ).rejects.toThrow(/--git-executable must be provided exactly once/u);
  });

  it.each(["--duration-ms", "--cycle-interval-ms"])(
    "rejects one_hour override %s before plan consumption",
    async (flag) => {
      await expect(
        runSoakAsyncCli([
          "run-soak",
          "missing-plan.json",
          "--mode",
          "one_hour",
          flag,
          "5000",
        ], repoRoot),
      ).rejects.toThrow(/one_hour soak duration and cycle cadence are fixed/u);
    },
  );

  it("requires final report mode one_hour", () => {
    expect(() => assertFinalSoakReportMode({ mode: "smoke" }))
      .toThrow(/requires a canonical one_hour/u);
    expect(() => assertFinalSoakReportMode({ mode: "one_hour" }))
      .not.toThrow();
  });

  it("requires four distinct plan realpaths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-final-plan-paths-"));
    try {
      const files = [1, 2, 3, 4].map((index) => {
        const file = path.join(root, `plan-${String(index)}.json`);
        writeFileSync(file, "{}\n", "utf8");
        return file;
      }) as [string, string, string, string];
      expect(() => assertDistinctFinalExecutionPlanFiles(files)).not.toThrow();
      expect(() =>
        assertDistinctFinalExecutionPlanFiles([
          files[0],
          files[1],
          files[2],
          files[0],
        ])).toThrow(/four distinct execution-plan file realpaths/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires sequence-1 and a distinct runId for the final soak plan", () => {
    const aggregate = [createPlan(1), createPlan(2), createPlan(3)] as [
      ReturnType<typeof createPlan>,
      ReturnType<typeof createPlan>,
      ReturnType<typeof createPlan>,
    ];
    const soak = createPlan(1);
    soak.runId = "soak-one-hour";
    expect(() => assertFinalExecutionPlanIdentities(aggregate, soak)).not.toThrow();

    soak.sequence = 2;
    expect(() => assertFinalExecutionPlanIdentities(aggregate, soak))
      .toThrow(/must use sequence 1/u);
    soak.sequence = 1;
    soak.runId = aggregate[0].runId;
    expect(() => assertFinalExecutionPlanIdentities(aggregate, soak))
      .toThrow(/must be distinct/u);

    soak.runId = "soak-one-hour";
    aggregate[1].runId = aggregate[0].runId;
    expect(() => assertFinalExecutionPlanIdentities(aggregate, soak))
      .toThrow(/four distinct execution-plan runIds/u);
  });

  it.each([
    "--report-1",
    "--aggregate",
    "--soak-report",
    "--duration-ms",
    "--cycle-interval-ms",
    "--clock",
    "--adapter",
    "--executor",
  ])("rejects caller-supplied or injectable %s input on the authoritative command", async (flag) => {
    await expect(runFinalEvidenceAsyncCli([
      "run-final-evidence",
      flag,
      "caller-controlled-value",
      "--repo-root",
      repoRoot,
    ], repoRoot)).rejects.toThrow(/Usage:/u);
  });

  it.each([
    "--plan-1",
    "--plan-2",
    "--plan-3",
    "--soak-plan",
    "--repo-root",
    "--artifact-root",
    "--expected-commit",
    "--expected-tree",
  ])("rejects duplicate authoritative CLI flag %s before evidence consumption", async (flag) => {
    await expect(runFinalEvidenceAsyncCli([
      "run-final-evidence",
      flag,
      "first-value",
      flag,
      "second-value",
    ], repoRoot)).rejects.toThrow(/must be provided at most once/u);
  });

  it.each([
    [
      "run-id directory",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "runs",
        "final-r1",
        "cases",
        "O1-C01",
      ),
    ],
    [
      "aggregate directory",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "aggregate",
      ),
    ],
    [
      "one-hour soak run-id directory",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "soak",
        "one_hour",
        "final-soak",
        "partial",
      ),
    ],
  ])("rejects any preexisting %s while allowing prepared plans", (_label, target) => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-final-preexisting-"));
    const runIds = ["final-r1", "final-r2", "final-r3"] as const;
    try {
      const planFiles = materializeAllowedFinalPlanFiles(root);
      expect(() =>
        assertNoPreexistingFinalEvidence(
          root,
          runIds,
          "final-soak",
          planFiles,
        ))
        .not.toThrow();

      mkdirSync(target(root), { recursive: true });
      expect(() =>
        assertNoPreexistingFinalEvidence(
          root,
          runIds,
          "final-soak",
          planFiles,
        ))
        .toThrow(/use a fresh evidence set/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "an old run",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "runs",
        "old-run",
        "partial.json",
      ),
    ],
    [
      "an old soak",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "soak",
        "one_hour",
        "old-soak",
        "partial.json",
      ),
    ],
    [
      "an unselected old plan",
      (root: string) => path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "plans",
        "candidate",
        "old-plan.json",
      ),
    ],
    [
      "an unrelated root file",
      (root: string) => path.join(root, "unrelated.txt"),
    ],
  ])("rejects %s anywhere in the final artifact root", (_label, target) => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-final-unexpected-"));
    const runIds = ["final-r1", "final-r2", "final-r3"] as const;
    try {
      const planFiles = materializeAllowedFinalPlanFiles(root);
      const unexpected = target(root);
      mkdirSync(path.dirname(unexpected), { recursive: true });
      writeFileSync(unexpected, "stale\n", "utf8");
      expect(() =>
        assertNoPreexistingFinalEvidence(
          root,
          runIds,
          "final-soak",
          planFiles,
        ))
        .toThrow(/use a fresh evidence set/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an empty or absent artifact root when all plans are outside it", () => {
    const base = mkdtempSync(path.join(tmpdir(), "rbp-final-external-plans-"));
    const artifactRoot = path.join(base, "evidence");
    const externalPlanRoot = path.join(base, "plans");
    const runIds = ["final-r1", "final-r2", "final-r3"] as const;
    try {
      mkdirSync(externalPlanRoot, { recursive: true });
      const planFiles = ([1, 2, 3, 4] as const).map((index) => {
        const planFile = path.join(
          externalPlanRoot,
          `plan-${String(index)}.json`,
        );
        writeFileSync(planFile, `{"plan":${String(index)}}\n`, "utf8");
        return planFile;
      }) as [string, string, string, string];
      expect(() =>
        assertNoPreexistingFinalEvidence(
          artifactRoot,
          runIds,
          "final-soak",
          planFiles,
        ))
        .not.toThrow();

      mkdirSync(artifactRoot);
      expect(() =>
        assertNoPreexistingFinalEvidence(
          artifactRoot,
          runIds,
          "final-soak",
          planFiles,
        ))
        .not.toThrow();

      writeFileSync(path.join(artifactRoot, "stale.txt"), "stale\n", "utf8");
      expect(() =>
        assertNoPreexistingFinalEvidence(
          artifactRoot,
          runIds,
          "final-soak",
          planFiles,
        ))
        .toThrow(/use a fresh evidence set/u);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a preexisting reparse output directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-final-reparse-"));
    const outside = mkdtempSync(path.join(tmpdir(), "rbp-final-reparse-target-"));
    const runIds = ["final-r1", "final-r2", "final-r3"] as const;
    try {
      const planFiles = materializeAllowedFinalPlanFiles(root);
      const runsRoot = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        "runs",
      );
      mkdirSync(runsRoot, { recursive: true });
      symlinkSync(
        outside,
        path.join(runsRoot, runIds[0]),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        assertNoPreexistingFinalEvidence(
          root,
          runIds,
          "final-soak",
          planFiles,
        ))
        .toThrow(/use a fresh evidence set/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a reparse ancestor even when it contains selected plans", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-final-plan-reparse-"));
    const outside = mkdtempSync(
      path.join(tmpdir(), "rbp-final-plan-reparse-target-"),
    );
    const runIds = ["final-r1", "final-r2", "final-r3"] as const;
    try {
      const outsidePlanRoot = path.join(outside, "candidate");
      mkdirSync(outsidePlanRoot, { recursive: true });
      const planFiles = ([1, 2, 3, 4] as const).map((index) => {
        const target = path.join(
          outsidePlanRoot,
          `plan-${String(index)}.json`,
        );
        writeFileSync(target, `{"plan":${String(index)}}\n`, "utf8");
        return path.join(
          root,
          "plans",
          "candidate",
          `plan-${String(index)}.json`,
        );
      }) as [string, string, string, string];
      symlinkSync(
        outside,
        path.join(root, "plans"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        assertNoPreexistingFinalEvidence(
          root,
          runIds,
          "final-soak",
          planFiles,
        ))
        .toThrow(/reparse entry.*fresh evidence set/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a mixed candidate across the four final plans", () => {
    const plans = [
      createPlan(1),
      createPlan(2),
      createPlan(3),
      createPlan(1),
    ];
    plans[3]!.runId = "final-soak";
    expect(() => assertPlansShareExactCandidate(plans)).not.toThrow();

    plans[3]!.source.treeSha = "f".repeat(40);
    expect(() => assertPlansShareExactCandidate(plans))
      .toThrow(/one exact candidate stack identity/u);
  });

  it("rejects a fabricated component version even when provenance echoes it", () => {
    const plan = attachCurrentProductionToolchainProvenance(createPlan());
    const configs = new Map(
      productionComponentLaunchConfigs(repoRoot, process.execPath)
        .map((config) => [config.id, config]),
    );
    for (const component of plan.components) {
      const provenance = component.expectedIdentity.buildProvenance!;
      provenance.schemaVersion = "rbp-production-build-provenance/v3";
      provenance.buildContractVersion = "rbp-production-typescript-build/v3";
      provenance.buildGeneratorDependenciesSha256 = provenance.sidecarSha256;
      const config = configs.get(component.id)!;
      component.command = structuredClone(config.command);
      component.expectedIdentity.version = config.version;
    }
    const verified = new Map<ComponentId, ComponentBuildProvenanceIdentity>(
      plan.components.map(({ id, expectedIdentity }) => [
        id,
        structuredClone(expectedIdentity.buildProvenance!),
      ]),
    );
    const resolveSource = (): typeof plan.source => structuredClone(plan.source);
    const verifyProvenance = (): typeof verified => verified;
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        repoRoot,
        resolveSource,
        verifyProvenance,
      )).not.toThrow();

    plan.components[0]!.expectedIdentity.version = "99.99.99-fabricated";
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        repoRoot,
        resolveSource,
        verifyProvenance,
      )).toThrow(/version, interface, or command/u);
    expect(
      canonicalProductionComponentVersion(repoRoot, "gateway_stub"),
    ).toBe(configs.get("gateway_stub")!.version);
  });
});
