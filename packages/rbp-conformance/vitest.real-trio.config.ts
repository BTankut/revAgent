import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/realTrioRuntime.test.ts"],
    globalSetup: "./tests/realTrioRunnerSetup.ts",
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    reporters: ["dot"],
  },
});
