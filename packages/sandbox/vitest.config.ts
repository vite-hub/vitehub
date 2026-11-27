import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const providerLoader = fileURLToPath(new URL("./src/task/runtime/provider-loader.ts", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-sandbox-task-provider-loader": providerLoader,
      "#vitehub-sandbox-task-registry": fileURLToPath(new URL("./src/task/runtime/empty-registry.ts", import.meta.url)),
      "vitehub-sandbox-task-provider-loader": providerLoader,
      "virtual:vitehub-sandbox-task-provider-loader": providerLoader,
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
