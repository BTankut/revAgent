import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/globalSetup.ts",
    // The production suite uses multiple serial shards on Windows. Keep each
    // shard's reporter work bounded while preserving final failures and
    // unhandled-error reporting.
    reporters: ["dot"],
    // Vitest 3.2.7 otherwise queues one acknowledged worker RPC channel per
    // file even when file parallelism is disabled. Keep one channel per shard;
    // normal test-environment isolation remains enabled.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Production-stack suites share the host loopback namespace. Running those
    // files concurrently can make one bounded discovery scan observe another
    // test's fixture or starve a close-frame deadline.
    fileParallelism: false,
  },
});
