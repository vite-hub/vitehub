import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "virtual:vitehub-sandbox-provider-loader": new URL("./src/runtime/provider-loader.ts", import.meta.url).pathname,
      "virtual:vitehub-sandbox-registry": new URL("./src/runtime/empty-registry.ts", import.meta.url).pathname,
      "#vitehub-sandbox-provider-loader": new URL("./src/runtime/provider-loader.ts", import.meta.url).pathname,
      "#vitehub-sandbox-registry": new URL("./src/runtime/empty-registry.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: false,
  },
})
