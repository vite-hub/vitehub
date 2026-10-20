import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-sandbox-task-provider-loader": new URL("./src/runtime/provider-loader.ts", import.meta.url).pathname,
      "#vitehub-sandbox-task-registry": new URL("./src/runtime/empty-registry.ts", import.meta.url).pathname,
      "vitehub-sandbox-task-provider-loader": new URL("./src/runtime/provider-loader.ts", import.meta.url).pathname,
      "virtual:vitehub-sandbox-task-provider-loader": new URL("./src/runtime/provider-loader.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: false,
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
