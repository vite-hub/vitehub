import { defineConfig } from "vitest/config"

const providerLoader = new URL("./src/task/runtime/provider-loader.ts", import.meta.url).pathname

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-sandbox-task-provider-loader": providerLoader,
      "#vitehub-sandbox-task-registry": new URL("./src/task/runtime/empty-registry.ts", import.meta.url).pathname,
      "vitehub-sandbox-task-provider-loader": providerLoader,
      "virtual:vitehub-sandbox-task-provider-loader": providerLoader,
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globals: false,
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
