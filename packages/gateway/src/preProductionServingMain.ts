import { writeSync } from "node:fs";

import { createPreProductionAuditFileWriter } from "./preProductionAuditFile.js";
import {
  launchPreProductionServingOwned,
  safePreProductionStartupReason,
} from "./preProductionServingCli.js";
import type { PreProductionAuditTextWriter } from "./preProductionAuditWriter.js";
import { completePreProductionServingShutdown } from "./preProductionServingShutdown.js";

function processStderrWriter(): PreProductionAuditTextWriter {
  return Object.freeze({
    write(
      value: string,
      options: { readonly signal: AbortSignal },
      callback: (error?: unknown) => void,
    ): void {
      if (options.signal.aborted) {
        callback(new Error("pre-production audit write aborted"));
        return;
      }
      try {
        writeSync(process.stderr.fd, value);
        callback();
      } catch (error: unknown) {
        callback(error);
      }
    },
  });
}

const PROCESS_SHUTDOWN_IO = Object.freeze({
  stderr: processStderrWriter(),
  createAuditArtifact: createPreProductionAuditFileWriter,
});

try {
  await launchPreProductionServingOwned(
    process.argv.slice(2),
    process.env,
    (launch) => {
      let shuttingDown = false;
      const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        void completePreProductionServingShutdown(
          launch,
          signal,
          PROCESS_SHUTDOWN_IO,
        ).then(
          (exitCode) => process.exit(exitCode),
          () => {
            process.stderr.write(
              `${JSON.stringify({
                level: "fatal",
                msg: "gateway.preproduction_shutdown_failed",
                signal,
                reason: "internal_error",
              })}\n`,
            );
            process.exit(1);
          },
        );
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("SIGUSR2", () => {
        void launch.prepared.revokeConfiguredDevice().then(
          (revoked) => {
            launch.server.app.log.info(
              {
                msg: "gateway.preproduction_device_revocation",
                state: revoked.ok ? "revoked" : "refused",
              },
              "gateway.preproduction_device_revocation",
            );
          },
          () => {
            launch.server.app.log.error(
              {
                msg: "gateway.preproduction_device_revocation",
                state: "refused",
              },
              "gateway.preproduction_device_revocation",
            );
          },
        );
      });
      launch.server.app.log.info(
        {
          msg: "gateway.preproduction_started",
          profile: "lan_test",
          mode: "preproduction",
          enrollmentArtifactCreated: true,
        },
        "gateway.preproduction_started",
      );
    },
  );
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      msg: "gateway.preproduction_start_refused",
      reason: safePreProductionStartupReason(error),
    })}\n`,
  );
  process.exit(78);
}
