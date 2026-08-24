import { defineConfig } from "vitest/config";

// Unit admission checks must not invoke the clean-tree production-suite
// bootstrap; the bootstrap intentionally rejects an in-progress writer tree.
export default defineConfig({
  test: { fileParallelism: false },
});
