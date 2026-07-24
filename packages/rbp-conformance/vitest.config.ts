import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/globalSetup.ts",
    // The production suite runs serially for more than an hour on Windows.
    // Keep reporter work bounded so worker task updates cannot outlive
    // Vitest's fixed RPC acknowledgement window after every slow PASS.
    reporters: ["dot"],
    // Production-stack suites share the host loopback namespace. Running those
    // files concurrently can make one bounded discovery scan observe another
    // test's fixture or starve a close-frame deadline.
    fileParallelism: false,
  },
});
