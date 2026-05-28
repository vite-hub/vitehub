import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@vitehub/runtime": new URL("../runtime/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
