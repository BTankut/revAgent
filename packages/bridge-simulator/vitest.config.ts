import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The bounded delivery-progress case has measured near Vitest's implicit
    // 5 s default on the shared Windows gate. Keep the package budget explicit
    // and bounded while leaving individual assertions unchanged.
    testTimeout: 10_000,
  },
});
