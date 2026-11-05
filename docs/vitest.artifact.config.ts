import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/artifact.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 15_000,
    maxWorkers: 1,
  },
});
