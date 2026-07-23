import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Production-stack suites share the host loopback namespace. Running those
    // files concurrently can make one bounded discovery scan observe another
    // test's fixture or starve a close-frame deadline.
    fileParallelism: false,
  },
});
