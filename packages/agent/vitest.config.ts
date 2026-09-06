import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/output/**", "test/local/**"],
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
})
