import {
  createPreProductionAuditWriter,
  type PreProductionAuditAtomicArtifactWriter,
  type PreProductionAuditAtomicCommitOptions,
  type PreProductionAuditTextWriter,
} from "./preProductionAuditWriter.js";
import { derivePreProductionAuditFilePath } from "./preProductionAuditFile.js";
import type { PreProductionServingLaunch } from "./preProductionServingCli.js";

export interface PreProductionServingShutdownIo {
  readonly stderr: PreProductionAuditTextWriter;
  readonly createAuditArtifact: (
    filePath: string,
  ) => PreProductionAuditAtomicArtifactWriter;
}

function shutdownFailureLine(signal: NodeJS.Signals): string {
  return `${JSON.stringify({
    level: "fatal",
    msg: "gateway.preproduction_shutdown_failed",
    signal,
    reason: "internal_error",
  })}\n`;
}

function writeBestEffort(
  writer: PreProductionAuditTextWriter,
  value: string,
): void {
  try {
    const returned = writer.write(
      value,
      { signal: new AbortController().signal },
      () => undefined,
    );
    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch {
    // Shutdown already failed; diagnostics cannot broaden or delay the exit.
  }
}

/**
 * Drains and removes the owned enrollment artifact before taking the only
 * process-lifetime audit snapshot. A failed cleanup is never represented as a
 * complete retained-evidence export.
 */
export async function completePreProductionServingShutdown(
  launch: PreProductionServingLaunch,
  signal: NodeJS.Signals,
  io: PreProductionServingShutdownIo,
): Promise<0 | 1> {
  try {
    await launch.cleanup();
  } catch {
    writeBestEffort(io.stderr, shutdownFailureLine(signal));
    return 1;
  }

  const artifact: PreProductionAuditAtomicArtifactWriter = Object.freeze({
    async commit(
      value: string,
      options: PreProductionAuditAtomicCommitOptions,
    ): Promise<void> {
      const filePath = derivePreProductionAuditFilePath(
        launch.enrollmentOutputPath,
      );
      await io.createAuditArtifact(filePath).commit(value, options);
    },
  });
  const auditWriter = createPreProductionAuditWriter({
    exportBundle: () => launch.prepared.exportAuditSnapshot(),
    artifact,
    stderr: io.stderr,
  });
  const auditExitCode = await auditWriter.run();
  return auditExitCode === 0 ? 0 : 1;
}
