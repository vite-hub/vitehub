import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-workspace-assets-registry": new URL("src/runtime/empty-assets-registry.ts", import.meta.url).pathname,
      "#vitehub-workspace-registry": new URL("src/runtime/empty-registry.ts", import.meta.url).pathname,
      "@vite-hub/shell/workspace": new URL("../shell/src/workspace/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
